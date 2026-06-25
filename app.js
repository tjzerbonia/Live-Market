// ============================================================
//  FORECAST MARKETS — app.js
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, push, onValue, runTransaction, serverTimestamp, update
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
let activeBet = { marketId: null, optionIndex: 0, amount: 10 };
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

function submitNickname() {
  const name = document.getElementById("nickname-input").value.trim();
  if (!name) return;
  user = { id: crypto.randomUUID(), name, balance: 1000 };
  localStorage.setItem("forecast_user", JSON.stringify(user));
  document.getElementById("nickname-overlay").classList.add("hidden");
  onUserReady();
}

function onUserReady() {
  document.getElementById("user-name-display").textContent = user.name;
  updateBalanceDisplay();
  subscribeToMarkets();
  subscribeToActivity();
  subscribeToMarketProbs();
  subscribeToMarketHistories();
}

// ─── UI HELPERS ──────────────────────────────────────────────
function updateBalanceDisplay() {
  document.getElementById("user-balance").textContent = `$${user.balance.toLocaleString()}`;
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

// ─── SPARKLINE ───────────────────────────────────────────────
// Deterministic synthetic history seeded from market ID
function seedHistory(marketId, baseProbs) {
  let seed = 0;
  for (let i = 0; i < marketId.length; i++) seed += marketId.charCodeAt(i);
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  };

  const history = [];
  let probs = [...baseProbs];
  for (let step = 0; step < 16; step++) {
    const total = probs.reduce((s, p) => s + p, 0);
    probs = probs.map(p => Math.max(1, p + (rand() - 0.5) * 4));
    const newTotal = probs.reduce((s, p) => s + p, 0);
    probs = probs.map(p => (p / newTotal) * total);
    history.push([...probs]);
  }
  // Final point near base
  history.push([...baseProbs]);
  return history;
}

// Step-line path (flat → jump style, like a real prediction market chart)
function stepPath(pts) {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [, y0] = pts[i - 1];
    // Horizontal to new x at old y, then vertical to new y
    d += ` H ${x1} V ${y1}`;
  }
  return d;
}

function renderSparkline(history, options, probs) {
  const W = 200, H = 90, PAD = 4;
  const optionCount = options.length;

  // Binary: only draw YES line; multi-option: draw all
  const isBinary = optionCount === 2 && options[0] === 'YES' && options[1] === 'NO';
  const n = isBinary ? 1 : Math.min(optionCount, OPTION_COLORS.length);

  // Legend HTML above the chart
  const legend = options.slice(0, n).map((opt, i) => {
    const p = Math.round(probs[i] || 0);
    return `<div class="market-chart-legend-row">
      <div class="legend-dot" style="background:${OPTION_COLORS[i]}"></div>
      <div class="legend-label">${opt}</div>
      <div class="legend-prob">${p}%</div>
    </div>`;
  }).join('');

  if (!history || history.length < 2) {
    return `<div class="market-chart-legend">${legend}</div>
      <div class="market-sparkline"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#e5e7eb" stroke-width="1.5"/>
      </svg></div>`;
  }

  // Y range zoomed to actual data
  const allVals = history.flatMap(snap =>
    Array.isArray(snap) ? snap.slice(0, n) : [snap]
  );
  const minP = Math.max(0,   Math.min(...allVals) - 5);
  const maxP = Math.min(100, Math.max(...allVals) + 5);
  const range = maxP - minP || 1;

  const toXY = (snap, i, oi) => {
    const x = PAD + (i / (history.length - 1)) * (W - 2 * PAD);
    const prob = Array.isArray(snap) ? (snap[oi] ?? 0) : snap;
    const y = H - PAD - ((prob - minP) / range) * (H - 2 * PAD);
    return [parseFloat(x.toFixed(1)), parseFloat(y.toFixed(1))];
  };

  const paths = [];
  for (let oi = 0; oi < n; oi++) {
    const color = OPTION_COLORS[oi];
    const pts = history.map((snap, i) => toXY(snap, i, oi));
    const d = stepPath(pts);
    const [ex, ey] = pts[pts.length - 1];
    paths.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="square"/>`,
      // Endpoint dot
      `<circle cx="${ex}" cy="${ey}" r="3" fill="${color}"/>`,
    );
  }

  return `<div class="market-chart-legend">${legend}</div>
    <div class="market-sparkline"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${paths.join("")}</svg></div>`;
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
  const hist = marketHistories[marketId];
  if (hist && hist.length >= 2) return hist;
  return seedHistory(marketId, market.baseProbs || [50, 50]);
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

// ─── BET MODAL ───────────────────────────────────────────────
window.openBetModal = function(marketId, optionIndex = 0) {
  if (!user.id) return;
  const market = allMarkets[marketId];
  if (!market) return;

  activeBet.marketId = marketId;
  activeBet.optionIndex = optionIndex;
  activeBet.amount = 10;

  document.getElementById("bet-modal-market-title").textContent = market.title;
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
  document.getElementById("bet-amount-display").textContent = `$${activeBet.amount}`;
  document.getElementById("payout-amount").textContent = `$${payout}`;
}

window.selectOption = function(i) {
  activeBet.optionIndex = i;
  updateBetModal();
};

window.adjustAmount = function(delta) {
  activeBet.amount = Math.max(1, Math.min(user.balance, activeBet.amount + delta));
  updateBetModal();
};

window.setAmount = function(amount) {
  activeBet.amount = Math.min(user.balance, amount);
  updateBetModal();
};

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
  const btn = document.getElementById("submit-bet-btn");
  btn.disabled = true;
  btn.textContent = "Placing...";

  const market      = allMarkets[activeBet.marketId];
  const probs       = getCurrentProbs(activeBet.marketId, market);
  const options     = market.options || ["YES", "NO"];
  const optionProb  = probs[activeBet.optionIndex] || 50;
  const optionLabel = options[activeBet.optionIndex];
  const payout      = Math.round(activeBet.amount / (optionProb / 100));

  user.balance = Math.max(0, user.balance - activeBet.amount);
  localStorage.setItem("forecast_user", JSON.stringify(user));
  updateBalanceDisplay();

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
    document.getElementById("activity-feed").innerHTML = bets.slice(0, 20).map(bet => `
      <div class="activity-item">
        <div class="activity-avatar">${getInitials(bet.userName || "?")}</div>
        <div class="activity-text">
          <strong>${bet.userName || "Anonymous"}</strong>
          bet on <strong>${(bet.marketTitle || "a market").slice(0, 45)}${(bet.marketTitle?.length || 0) > 45 ? "…" : ""}</strong>
        </div>
        <div class="activity-side">${bet.option || bet.side || "YES"}</div>
        <div class="activity-amount">$${bet.amount}</div>
        <div class="activity-time">${timeAgo(bet.timestamp)}</div>
      </div>`).join("");
  });
}

// ─── INIT ─────────────────────────────────────────────────────
initUser();
