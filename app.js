// ============================================================
//  FORECAST MARKETS — app.js
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, push, onValue, runTransaction, serverTimestamp, update, get
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyD-gPi5JT8tDeXoflknm0U9Dir7642Zk8U",
  authDomain: "live-market-3e6b6.firebaseapp.com",
  databaseURL: "https://live-market-3e6b6-default-rtdb.firebaseio.com",
  projectId: "live-market-3e6b6",
  storageBucket: "live-market-3e6b6.firebasestorage.app",
  messagingSenderId: "255916811056",
  appId: "1:255916811056:web:3462750ee45ccad644def5",
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ─── STATE ───────────────────────────────────────────────────
let user = { id: null, name: null, balance: 1000 };
let activeBet = { marketId: null, optionIndex: 0, amount: 10, step: 10 };
let allMarkets = {};
let marketCurrentProbs = {};  // { marketId: number[] }
let marketHistories = {};     // { marketId: number[][] }

// ─── SPARKLINE COLORS (one per option) ───────────────────────
const OPTION_COLORS = ["#00a86b", "#5b7cfa", "#f59e0b", "#e879f9", "#e53935"];

// ─── NICKNAME SETUP ──────────────────────────────────────────
function initUser() {
  const stored = localStorage.getItem("forecast_user");
  if (stored) {
    user = JSON.parse(stored);
    onUserReady();
  } else {
    document.getElementById("nickname-overlay").classList.remove("hidden");
    document.getElementById("nickname-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitNickname();
    });
    document.getElementById("nickname-submit").addEventListener("click", submitNickname);
  }
}

async function submitNickname() {
  const name = document.getElementById("nickname-input").value.trim();
  if (!name) return;

  const btn = document.getElementById("nickname-submit");
  btn.disabled = true;
  btn.textContent = "Checking...";

  // Check for duplicate name in Firebase
  const snap = await get(ref(db, "users"));
  const existing = snap.val() || {};
  const taken = Object.values(existing).some(u => u.name?.toLowerCase() === name.toLowerCase());

  if (taken) {
    const err = document.getElementById("nickname-error");
    err.textContent = "That name is taken. Pick another.";
    err.classList.remove("hidden");
    btn.disabled = false;
    btn.textContent = "Enter Markets";
    return;
  }

  user = { id: crypto.randomUUID(), name, balance: 1000 };
  localStorage.setItem("forecast_user", JSON.stringify(user));
  document.getElementById("nickname-overlay").classList.add("hidden");
  onUserReady();
  btn.disabled = false;
  btn.textContent = "Enter Markets";
}

function onUserReady() {
  document.getElementById("user-name-display").textContent = user.name;
  updateBalanceDisplay();
  registerUserInFirebase();
  subscribeToMarkets();
  subscribeToActivity();
  subscribeToMarketProbs();
  subscribeToMarketHistories();
  subscribeToConfig();
}

function registerUserInFirebase() {
  update(ref(db, `users/${user.id}`), {
    name: user.name,
    balance: user.balance,
    lastSeen: Date.now(),
  });
}

// ─── UI HELPERS ──────────────────────────────────────────────
function updateBalanceDisplay() {
  const el = document.getElementById("user-balance");
  el.textContent = `$${user.balance.toLocaleString()}`;
  el.style.color = user.balance < 0 ? "var(--no)" : "";
}

function showToast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function getInitials(name) {
  return name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
}

function timeAgo(ts) {
  if (!ts) return "just now";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ─── CHART ENGINE ─────────────────────────────────────────────

// Seed: 6 narrative "chapters" interpolated cleanly — no per-step noise
function seedHistory(marketId, baseProbs) {
  let seed = 0;
  for (let i = 0; i < marketId.length; i++) seed += marketId.charCodeAt(i);
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  };

  const total = baseProbs.reduce((s, p) => s + p, 0);
  const normalize = (arr) => {
    const s = arr.reduce((a, v) => a + v, 0);
    return arr.map(v => (v / s) * total);
  };

  // Build 6 anchor points — each one is a clear "event" shift
  const ANCHORS = 6;
  const anchors = [];

  // Start offset from base
  let cur = normalize(baseProbs.map(p => Math.max(2, p + (rand() - 0.5) * 30)));
  anchors.push(cur);

  for (let a = 1; a < ANCHORS; a++) {
    const t = a / (ANCHORS - 1); // 0→1 progression toward base
    // Each anchor shifts one "winner" option meaningfully
    const winner = Math.floor(rand() * baseProbs.length);
    const shift = (rand() * 12 + 6) * (rand() > 0.45 ? 1 : -1);
    let next = cur.map((p, i) => {
      const gravity = (baseProbs[i] - p) * (0.15 + t * 0.25);
      return Math.max(1, p + gravity + (i === winner ? shift : -shift / (baseProbs.length - 1)));
    });
    cur = normalize(next);
    anchors.push(cur);
  }
  // Final anchor is exactly the base
  anchors.push([...baseProbs]);

  // Interpolate each anchor pair with 4 steps → clean straight runs
  const STEPS_PER = 4;
  const history = [];
  for (let a = 0; a < anchors.length - 1; a++) {
    for (let s = 0; s < STEPS_PER; s++) {
      const t = s / STEPS_PER;
      history.push(anchors[a].map((v, i) => v + (anchors[a + 1][i] - v) * t));
    }
  }
  history.push([...baseProbs]);
  return history;
}

// Merge seed backdrop with sparse real bet data, amplify for visual impact
function buildDisplayHistory(marketId, market) {
  const base   = market.baseProbs || [50, 50];
  const seed   = seedHistory(marketId, base);
  const real   = marketHistories[marketId];

  if (!real || real.length < 2) return seed;

  // Use seed for first ~70% of the chart, real for the rest
  const seedSlice = seed.slice(0, Math.ceil(seed.length * 0.70));

  // Amplify real data: each real point is nudged away from the previous
  // so tiny bet changes look like meaningful market moves
  const amplified = [real[0]];
  for (let i = 1; i < real.length; i++) {
    const prev = amplified[i - 1];
    const raw  = real[i];
    const amp  = raw.map((v, oi) => {
      const delta = v - prev[oi];
      // Amplify delta by 3x but cap at 8 points per step
      return prev[oi] + Math.max(-8, Math.min(8, delta * 3));
    });
    // Keep sum constant
    const total = base.reduce((s, p) => s + p, 0);
    const s     = amp.reduce((a, v) => a + v, 0);
    amplified.push(amp.map(v => Math.max(1, (v / s) * total)));
  }

  // Smooth the real tail with a 3-point rolling average
  const smoothed = amplified.map((snap, i) => {
    if (i === 0 || i === amplified.length - 1) return snap;
    return snap.map((v, oi) =>
      (amplified[i - 1][oi] + v + amplified[i + 1][oi]) / 3
    );
  });

  return [...seedSlice, ...smoothed];
}

// Step-line SVG path
function stepPath(pts) {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` H ${pts[i][0]} V ${pts[i][1]}`;
  }
  return d;
}

// Core chart SVG builder — enforces minimum visual range so lines never go flat
function buildChart(history, options, W, H, PAD, strokeW, dotR, showAll) {
  const isBinary = options.length === 2 && options[0] === 'YES' && options[1] === 'NO';
  const n = showAll ? Math.min(options.length, OPTION_COLORS.length)
                    : (isBinary ? 1 : Math.min(options.length, OPTION_COLORS.length));

  if (!history || history.length < 2) {
    return { n, svg: `<line x1="0" y1="${H/2}" x2="${W}" y2="${H/2}" stroke="#e5e7eb" stroke-width="1.5"/>` };
  }

  const allVals = history.flatMap(snap => snap.slice(0, n));
  const rawMin = Math.min(...allVals), rawMax = Math.max(...allVals);

  // Enforce minimum 20% visual range so chart never looks flat
  const midpoint  = (rawMin + rawMax) / 2;
  const halfRange = Math.max(12, (rawMax - rawMin) / 2 + 4);
  const minP = Math.max(0,   midpoint - halfRange);
  const maxP = Math.min(100, midpoint + halfRange);
  const range = maxP - minP || 1;

  const toXY = (snap, i, oi) => {
    const x = PAD + (i / (history.length - 1)) * (W - 2 * PAD);
    const prob = snap[oi] ?? 0;
    const y = H - PAD - ((prob - minP) / range) * (H - 2 * PAD);
    return [parseFloat(x.toFixed(1)), parseFloat(y.toFixed(1))];
  };

  let svg = '';
  // Draw lines back-to-front so primary line is on top
  for (let oi = n - 1; oi >= 0; oi--) {
    const color = OPTION_COLORS[oi];
    const pts   = history.map((snap, i) => toXY(snap, i, oi));
    svg += `<path d="${stepPath(pts)}" fill="none" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="square"/>`;
  }
  // Endpoint dots on top of all lines
  for (let oi = 0; oi < n; oi++) {
    const color = OPTION_COLORS[oi];
    const last  = toXY(history[history.length - 1], history.length - 1, oi);
    svg += `<circle cx="${last[0]}" cy="${last[1]}" r="${dotR}" fill="${color}" stroke="#fff" stroke-width="1.5"/>`;
  }
  return { n, svg };
}

function renderSparkline(history, options, probs) {
  const W = 260, H = 95, PAD = 5;
  const { n, svg } = buildChart(history, options, W, H, PAD, 2, 4, false);

  const legend = options.slice(0, n).map((opt, i) => {
    const p = Math.round(probs[i] || 0);
    return `<div class="market-chart-legend-row">
      <div class="legend-dot" style="background:${OPTION_COLORS[i]}"></div>
      <span class="legend-label">${opt}</span>
      <span class="legend-prob">${p}%</span>
    </div>`;
  }).join('');

  return `<div class="market-chart-legend">${legend}</div>
    <div class="market-sparkline"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${svg}</svg></div>`;
}

// ─── CONFIG (balance reset signals) ──────────────────────────
function subscribeToConfig() {
  const handleReset = (resetAt) => {
    if (!resetAt || resetAt <= (user.lastResetAt || 0)) return;
    user.balance = 1000;
    user.lastResetAt = resetAt;
    localStorage.setItem("forecast_user", JSON.stringify(user));
    updateBalanceDisplay();
    update(ref(db, `users/${user.id}`), { balance: 1000 });
    showToast("Your balance has been reset to $1,000.");
  };

  // Global reset
  onValue(ref(db, "config/balance_reset_at"), (snap) => handleReset(snap.val()));
  // Per-user reset
  onValue(ref(db, `config/user_resets/${user.id}`), (snap) => handleReset(snap.val()));
}

// ─── FIREBASE SUBSCRIPTIONS ──────────────────────────────────
function subscribeToMarkets() {
  onValue(ref(db, "markets"), (snap) => {
    const data = snap.val() || {};
    allMarkets = {};
    for (const [id, m] of Object.entries(data)) {
      if (m.status !== "closed") allMarkets[id] = m;
    }
    renderMarkets();
  });
}

function subscribeToMarketProbs() {
  onValue(ref(db, "market_probs"), (snap) => {
    marketCurrentProbs = snap.val() || {};
    renderMarkets();
  });
}

function subscribeToMarketHistories() {
  onValue(ref(db, "market_history"), (snap) => {
    const data = snap.val() || {};
    marketHistories = {};
    for (const [marketId, entries] of Object.entries(data)) {
      marketHistories[marketId] = Object.values(entries)
        .sort((a, b) => (a.t || 0) - (b.t || 0))
        .map(e => e.probs);
    }
    renderMarkets();
  });
}

// ─── MARKET RENDERING ────────────────────────────────────────
function getCurrentProbs(marketId, market) {
  const stored = marketCurrentProbs[marketId];
  if (Array.isArray(stored) && stored.length > 0) return stored;
  return market.baseProbs || [50, 50];
}

function getHistory(marketId, market) {
  return buildDisplayHistory(marketId, market);
}

function renderMarkets() {
  const grid = document.getElementById("markets-grid");
  const entries = Object.entries(allMarkets);

  if (entries.length === 0) {
    grid.innerHTML = `<div style="color:var(--text-dim);font-size:.875rem;padding:2rem 0;">No open markets yet.</div>`;
    return;
  }

  grid.innerHTML = entries.map(([id, m]) => {
    const probs  = getCurrentProbs(id, m);
    const history = getHistory(id, m);
    const options = m.options || ["YES", "NO"];
    const isBinary = options.length === 2 && options[0] === "YES" && options[1] === "NO";

    const chartHTML = renderSparkline(history, options, probs);

    const footerBtns = isBinary
      ? `<div class="market-bet-btns" onclick="event.stopPropagation()">
          <button class="bet-btn yes" onclick="openBetModal('${id}',0)">YES ${Math.round(probs[0])}¢</button>
          <button class="bet-btn no"  onclick="openBetModal('${id}',1)">NO ${Math.round(probs[1])}¢</button>
        </div>`
      : `<div class="market-bet-btns" onclick="event.stopPropagation()">
          <button class="bet-btn trade" onclick="openBetModal('${id}',0)">Trade</button>
        </div>`;

    return `
      <div class="market-card" onclick="openBetModal('${id}',0)">
        <div class="market-category">${m.category || "General"}</div>
        <div class="market-title">${m.title}</div>
        ${chartHTML}
        <div class="market-footer">
          <div class="market-vol">Vol: $${(m.volume || 0).toLocaleString()}</div>
          ${footerBtns}
        </div>
      </div>`;
  }).join("");
}

// ─── MODAL CHART ─────────────────────────────────────────────
function renderModalChart(history, options, probs) {
  const W = 500, H = 220, PAD = 8;
  const { n, svg } = buildChart(history, options, W, H, PAD, 2.5, 6, true);

  // Legend: colored dot + name + bold %
  const legend = options.slice(0, n).map((opt, i) => {
    const p = Math.round(probs[i] || 0);
    return `<div class="market-chart-legend-row">
      <div class="legend-dot" style="background:${OPTION_COLORS[i]}"></div>
      <span class="legend-label">${opt}</span>
      <span class="legend-prob">${p}%</span>
    </div>`;
  }).join('');

  // Options breakdown table: each option row with YES% pill + NO% pill
  const isBinary = options.length === 2 && options[0] === 'YES' && options[1] === 'NO';
  const table = options.slice(0, n).map((opt, i) => {
    const yesP = Math.round(probs[i] || 0);
    const noP  = 100 - yesP;
    return `<div class="modal-option-row">
      <div class="modal-option-dot" style="background:${OPTION_COLORS[i]}"></div>
      <div class="modal-option-name">${opt}</div>
      <div class="modal-option-pills">
        <span class="modal-pill yes">${yesP}%</span>
        <span class="modal-pill no">${noP}%</span>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="market-chart-legend">${legend}</div>
    <div class="modal-chart-svg"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${svg}</svg></div>
    <div class="modal-options-table">${table}</div>
    <div class="modal-trade-divider"></div>`;
}

// ─── BET MODAL ───────────────────────────────────────────────
window.openBetModal = function(marketId, optionIndex = 0) {
  if (!user.id) return;
  const market = allMarkets[marketId];
  if (!market) return;

  activeBet.marketId = marketId;
  activeBet.optionIndex = optionIndex;
  activeBet.amount = 10;

  const options = market.options || ["YES", "NO"];
  const probs   = getCurrentProbs(marketId, market);
  const history = getHistory(marketId, market);

  document.getElementById("bet-modal-category").textContent = market.category || "";
  document.getElementById("bet-modal-market-title").textContent = market.title;
  document.getElementById("modal-chart-area").innerHTML = renderModalChart(history, options, probs);
  document.getElementById("bet-overlay").classList.remove("hidden");
  updateBetModal();
};

function updateBetModal() {
  const market = allMarkets[activeBet.marketId];
  if (!market) return;

  const probs   = getCurrentProbs(activeBet.marketId, market);
  const options = market.options || ["YES", "NO"];

  document.getElementById("bet-options-row").innerHTML = options.slice(0, 5).map((opt, i) => {
    const p = Math.round(probs[i] || 0);
    const active = i === activeBet.optionIndex ? " active" : "";
    return `<button class="bet-option-btn${active}" onclick="selectOption(${i})">
      ${opt}<br><span style="font-size:.72rem;font-weight:400">${p}%</span>
    </button>`;
  }).join("");

  const optionProb  = probs[activeBet.optionIndex] || 50;
  const optionLabel = options[activeBet.optionIndex] || "Option";
  const payout = Math.round(activeBet.amount / (optionProb / 100));

  document.getElementById("bet-odds-display").textContent =
    `${optionLabel} · ${Math.round(optionProb)}¢ per share`;
  document.getElementById("payout-amount").textContent = `$${payout}`;
}

window.selectOption = function(i) {
  activeBet.optionIndex = i;
  updateBetModal();
};

function applyAmount(amount) {
  const maxBet = user.balance + 1000;
  activeBet.amount = Math.max(1, Math.min(maxBet, amount));
  document.getElementById("bet-amount-input").value = activeBet.amount;
  updatePayout();
}

function updatePayout() {
  const market = allMarkets[activeBet.marketId];
  if (!market) return;
  const probs = getCurrentProbs(activeBet.marketId, market);
  const optionProb = probs[activeBet.optionIndex] || 50;
  const payout = Math.round(activeBet.amount / (optionProb / 100));
  document.getElementById("payout-amount").textContent = `$${payout}`;
}

// Wire up +/- buttons
document.getElementById("amount-dec").addEventListener("click", () => {
  applyAmount(activeBet.amount - activeBet.step);
});
document.getElementById("amount-inc").addEventListener("click", () => {
  applyAmount(activeBet.amount + activeBet.step);
});

// Wire up quick amount buttons
document.getElementById("quick-amounts").addEventListener("click", (e) => {
  const amt = parseInt(e.target.dataset.amt, 10);
  if (!isNaN(amt)) applyAmount(amt);
});

// Wire up step buttons
document.querySelector(".step-btns").addEventListener("click", (e) => {
  const s = parseInt(e.target.dataset.step, 10);
  if (isNaN(s)) return;
  activeBet.step = s;
  document.querySelectorAll(".step-btns button").forEach(b => {
    b.classList.toggle("active", parseInt(b.dataset.step, 10) === s);
  });
});

// Direct input
document.getElementById("bet-amount-input").addEventListener("input", (e) => {
  const n = parseInt(e.target.value, 10);
  if (!isNaN(n) && n >= 1) {
    const maxBet = user.balance + 1000;
    activeBet.amount = Math.min(maxBet, n);
    updatePayout();
  }
});

window.onAmountInput = function() {}; // no-op, handled above

document.getElementById("bet-close").addEventListener("click", () => {
  document.getElementById("bet-overlay").classList.add("hidden");
});
document.getElementById("bet-overlay").addEventListener("click", (e) => {
  if (e.target === document.getElementById("bet-overlay"))
    document.getElementById("bet-overlay").classList.add("hidden");
});

// ─── SUBMIT BET ──────────────────────────────────────────────
window.submitBet = async function() {
  if (!user.id) return;
  // Sync amount from input field in case user typed directly
  const inputVal = parseInt(document.getElementById("bet-amount-input").value, 10);
  if (!isNaN(inputVal) && inputVal >= 1) activeBet.amount = inputVal;

  const btn = document.getElementById("submit-bet-btn");
  btn.disabled = true;
  btn.textContent = "Placing...";

  const market      = allMarkets[activeBet.marketId];
  const probs       = getCurrentProbs(activeBet.marketId, market);
  const options     = market.options || ["YES", "NO"];
  const optionProb  = probs[activeBet.optionIndex] || 50;
  const optionLabel = options[activeBet.optionIndex];
  const payout      = Math.round(activeBet.amount / (optionProb / 100));

  user.balance = Math.max(-1000, user.balance - activeBet.amount);
  localStorage.setItem("forecast_user", JSON.stringify(user));
  updateBalanceDisplay();
  update(ref(db, `users/${user.id}`), { balance: user.balance, lastSeen: Date.now() });

  // Update volume
  await update(ref(db, `markets/${activeBet.marketId}`), {
    volume: (market.volume || 0) + activeBet.amount,
  });

  // Push bet record
  await push(ref(db, "bets"), {
    userId: user.id,
    userName: user.name,
    marketId: activeBet.marketId,
    marketTitle: market.title,
    option: optionLabel,
    optionIndex: activeBet.optionIndex,
    amount: activeBet.amount,
    payout,
    timestamp: serverTimestamp(),
  });

  // Nudge probabilities
  await runTransaction(ref(db, `market_probs/${activeBet.marketId}`), (cur) => {
    let p = Array.isArray(cur) && cur.length === options.length ? [...cur] : [...probs];
    const weight = Math.min(activeBet.amount / 200, 2);
    const spread = weight / Math.max(p.length - 1, 1);
    p = p.map((v, i) =>
      i === activeBet.optionIndex ? v + weight : Math.max(1, v - spread)
    );
    const sum = p.reduce((s, v) => s + v, 0);
    const origSum = probs.reduce((s, v) => s + v, 0);
    return p.map(v => Math.max(1, Math.min(97, (v / sum) * origSum)));
  });

  // Record history snapshot for sparkline
  await push(ref(db, `market_history/${activeBet.marketId}`), {
    t: Date.now(),
    probs: [...(marketCurrentProbs[activeBet.marketId] || probs)],
  });

  document.getElementById("bet-overlay").classList.add("hidden");
  showToast(`Trade placed: ${optionLabel} on "${market.title.slice(0, 40)}"`);
  btn.disabled = false;
  btn.textContent = "Place Trade";
};

// ─── ACTIVITY FEED ───────────────────────────────────────────
function subscribeToActivity() {
  onValue(ref(db, "bets"), (snap) => {
    const data = snap.val();
    if (!data) return;
    const bets = Object.values(data).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    document.getElementById("activity-feed").innerHTML = bets.slice(0, 10).map((bet, i) => {
      const label = bet.option || bet.side || "YES";
      const isNo  = label.toUpperCase() === "NO";
      // Fade out the last 3 items
      const opacity = i <= 6 ? 1 : Math.max(0.1, 1 - (i - 6) * 0.3);
      return `
      <div class="activity-item" style="opacity:${opacity}">
        <div class="activity-avatar">${getInitials(bet.userName || "?")}</div>
        <div class="activity-text">
          <strong>${bet.userName || "Anonymous"}</strong>
          bet on <strong>${(bet.marketTitle || "a market").slice(0, 45)}${(bet.marketTitle?.length || 0) > 45 ? "…" : ""}</strong>
        </div>
        <div class="activity-side${isNo ? " no" : ""}">${label}</div>
        <div class="activity-amount">$${bet.amount}</div>
        <div class="activity-time">${timeAgo(bet.timestamp)}</div>
      </div>`;
    }).join("");
  });
}

// ─── INIT ─────────────────────────────────────────────────────
initUser();
