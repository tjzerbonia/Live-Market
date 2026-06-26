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
  subscribeToUserBalance();
}

async function registerUserInFirebase() {
  // Read Firebase balance first — never overwrite with a stale local value
  const snap = await get(ref(db, `users/${user.id}/balance`));
  const fbBalance = snap.val();
  if (fbBalance != null && fbBalance > user.balance) {
    user.balance = fbBalance;
    localStorage.setItem("forecast_user", JSON.stringify(user));
    updateBalanceDisplay();
  }
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

function seedHistory(marketId, baseProbs, currentProbs) {
  let seed = 0;
  for (let i = 0; i < marketId.length; i++) seed += marketId.charCodeAt(i) * (i + 1);
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  };

  const total = baseProbs.reduce((s, p) => s + p, 0);
  const normalize = arr => {
    const s = arr.reduce((a, v) => a + v, 0);
    return arr.map(v => (v / s) * total);
  };

  // Starting state — offset from base so there's somewhere to travel
  let state = normalize(baseProbs.map(p => Math.max(2, p + (rand() - 0.5) * 22)));

  const NUM_ANCHORS = 7;
  const anchors = [{ t: 0, s: [...state] }];

  for (let a = 1; a < NUM_ANCHORS; a++) {
    const prevT = anchors[a - 1].t;
    const gap   = 0.08 + rand() * 0.12;
    const t     = Math.min(prevT + gap, 0.88);

    if (rand() < 0.35) {
      const mover = Math.floor(rand() * baseProbs.length);
      const dir   = rand() > 0.45 ? 1 : -1;
      const mag   = (rand() * 10 + 12) * dir;
      const next  = state.map((v, i) => i === mover ? Math.max(2, v + mag) : v);
      state = normalize(next);
    } else {
      // Quiet drift — toward currentProbs so the narrative ends in the right place
      state = normalize(state.map((v, i) => v + (currentProbs[i] - v) * rand() * 0.07));
    }

    anchors.push({ t, s: [...state] });
  }

  // Final anchor is always the actual current probability — the whole trailing
  // curve converges here so there's no sudden snap at the endpoint.
  anchors.push({ t: 1.0, s: normalize(currentProbs) });

  // ── Expand anchors → 60-point history ─────────────────────────
  // Between consecutive anchors interpolate with ease-in-out.
  // No per-step noise — the motion lives at the anchor level.
  const POINTS = 60;
  const history = [];

  for (let i = 0; i < POINTS; i++) {
    const t = i / (POINTS - 1);

    // Find the surrounding anchor pair
    let lo = anchors[0], hi = anchors[anchors.length - 1];
    for (let a = 0; a < anchors.length - 1; a++) {
      if (t >= anchors[a].t && t <= anchors[a + 1].t) {
        lo = anchors[a]; hi = anchors[a + 1]; break;
      }
    }

    const span   = hi.t - lo.t || 1;
    const localT = (t - lo.t) / span;
    // Ease-in-out: fast in middle, slower at plateau edges
    const ease   = localT < 0.5 ? 2 * localT * localT : -1 + (4 - 2 * localT) * localT;

    history.push(normalize(lo.s.map((v, oi) => v + (hi.s[oi] - v) * ease)));
  }

  return history;
}

// Expand sparse real bet snapshots into smooth sub-steps.
// No artificial amplification — the bet weight formula already makes
// large bets move the market visibly.
function expandRealData(real, base) {
  if (!real || real.length < 2) return null;
  const total = base.reduce((s, p) => s + p, 0);
  const normalize = arr => {
    const s = arr.reduce((a, v) => a + v, 0);
    return arr.map(v => (v / s) * total);
  };

  const SUB = 8;
  const expanded = [];

  for (let i = 0; i < real.length - 1; i++) {
    const from = real[i], to = real[i + 1];
    for (let s = 0; s < SUB; s++) {
      const t    = s / SUB;
      // Fast initial reaction, then settle — mimics real market microstructure
      const ease = t < 0.4 ? (t / 0.4) * (t / 0.4) : 1 - Math.pow(1 - (t - 0.4) / 0.6, 2) * 0.1;
      expanded.push(normalize(from.map((v, oi) => v + (to[oi] - v) * ease)));
    }
  }
  expanded.push([...real[real.length - 1]]);
  return expanded;
}

function buildDisplayHistory(marketId, market) {
  const base    = toArray(market.baseProbs) || [50, 50];
  const current = getCurrentProbs(marketId, market);
  const total   = base.reduce((s, p) => s + p, 0);
  const normalize = arr => {
    const s = arr.reduce((a, v) => a + v, 0);
    return arr.map(v => (v / s) * total);
  };

  const seed = seedHistory(marketId, base, current);
  const real = marketHistories[marketId];
  const expanded = expandRealData(real, base);

  if (!expanded) return seed;

  // Seed covers the "history before bets" — real data covers the live portion.
  // The seed already ends at currentProbs; real data also ends at currentProbs
  // (from the last recorded bet snapshot), so the join is seamless.
  const seedSlice = seed.slice(0, Math.ceil(seed.length * 0.72));
  const history = [...seedSlice, ...expanded];

  // Pin the very last point to current in case of any float drift
  history[history.length - 1] = normalize(current);
  return history;
}

// Catmull-Rom spline — smooth continuous curves with natural tangents
function catmullRomPath(pts, tension = 0.35) {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) * tension;
    const cp1y = p1[1] + (p2[1] - p0[1]) * tension;
    const cp2x = p2[0] - (p3[0] - p1[0]) * tension;
    const cp2y = p2[1] - (p3[1] - p1[1]) * tension;
    d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

// Unique counter so each chart gets its own clipPath id (avoids global id conflicts)
let _chartSeq = 0;

function buildChart(history, options, W, H, PAD, strokeW, dotR, showAll, thinFactor) {
  const isBinary = options.length === 2 && options[0] === 'YES' && options[1] === 'NO';
  const n = showAll ? Math.min(options.length, OPTION_COLORS.length)
                    : (isBinary ? 1 : Math.min(options.length, OPTION_COLORS.length));

  if (!history || history.length < 2) {
    return { n, svg: `<line x1="0" y1="${H/2}" x2="${W}" y2="${H/2}" stroke="#e5e7eb" stroke-width="1.5"/>` };
  }

  const pts_src = thinFactor > 1
    ? history.filter((_, i) => i % thinFactor === 0 || i === history.length - 1)
    : history;

  const allVals = pts_src.flatMap(snap => snap.slice(0, n));
  const rawMin = Math.min(...allVals), rawMax = Math.max(...allVals);
  const mid = (rawMin + rawMax) / 2;

  // Scale tightly to the actual data — 6pt padding on each side.
  // Clamp + clipPath prevents any spline from escaping the frame.
  const dataHalf = (rawMax - rawMin) / 2;
  const halfSpan = Math.max(6, dataHalf + 6);
  const minP  = Math.max(0,   mid - halfSpan);
  const maxP  = Math.min(100, mid + halfSpan);
  const range = maxP - minP || 1;

  const toXY = (snap, i, oi) => {
    const x    = PAD + (i / (pts_src.length - 1)) * (W - 2 * PAD);
    const rawY = H - PAD - ((snap[oi] - minP) / range) * (H - 2 * PAD);
    const y    = Math.max(PAD, Math.min(H - PAD, rawY));
    return [parseFloat(x.toFixed(1)), parseFloat(y.toFixed(1))];
  };

  const clipId = `c${++_chartSeq}`;
  let svg = `<defs><clipPath id="${clipId}"><rect x="${PAD}" y="${PAD}" width="${W - 2*PAD}" height="${H - 2*PAD}"/></clipPath></defs>`;

  for (let oi = n - 1; oi >= 0; oi--) {
    const color = OPTION_COLORS[oi];
    const pts   = pts_src.map((snap, i) => toXY(snap, i, oi));
    svg += `<path d="${catmullRomPath(pts)}" fill="none" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#${clipId})"/>`;
  }

  // Endpoint dots — drawn outside clipPath so rings are never cropped
  for (let oi = 0; oi < n; oi++) {
    const color = OPTION_COLORS[oi];
    const [ex, ey] = toXY(pts_src[pts_src.length - 1], pts_src.length - 1, oi);
    const ringR    = dotR * 2.5;
    const delayMs  = oi * 400;
    // Outer pulsing ring uses CSS class; inner dot is solid
    svg += `<circle class="chart-dot-ring" cx="${ex}" cy="${ey}" r="${ringR}" fill="${color}" style="transform-origin:${ex}px ${ey}px;animation-delay:${delayMs}ms"/>`;
    svg += `<circle cx="${ex}" cy="${ey}" r="${dotR}" fill="${color}" stroke="#fff" stroke-width="1.5"/>`;
  }
  return { n, svg };
}

function renderSparkline(history, options, probs) {
  const W = 260, H = 95, PAD = 5;
  // Card: every 4th point → ~15 anchors, smooth card curve
  const { n, svg } = buildChart(history, options, W, H, PAD, 2.2, 4, false, 4);

  const legend = options.slice(0, n).map((opt, i) => {
    const p = probs[i] || 0;
    return `<div class="market-chart-legend-row">
      <div class="legend-dot" style="background:${OPTION_COLORS[i]}"></div>
      <span class="legend-label">${opt}</span>
      <span class="legend-prob${p < 5 ? ' longshot' : ''}">${fmtProb(p)}</span>
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

// Listen for admin-credited balance increases (bet payouts)
function subscribeToUserBalance() {
  onValue(ref(db, `users/${user.id}/balance`), (snap) => {
    const fbBalance = snap.val();
    if (fbBalance == null) return;
    if (fbBalance > user.balance) {
      const gained = Math.round(fbBalance - user.balance);
      user.balance = fbBalance;
      localStorage.setItem("forecast_user", JSON.stringify(user));
      updateBalanceDisplay();
      if (gained > 0) showToast(`+$${gained.toLocaleString()} payout credited!`);
    }
  });
}

// ─── FIREBASE SUBSCRIPTIONS ──────────────────────────────────
function subscribeToMarkets() {
  onValue(ref(db, "markets"), (snap) => {
    allMarkets = snap.val() || {};
    renderMarkets();
  });
}

function subscribeToMarketProbs() {
  onValue(ref(db, "market_probs"), (snap) => {
    marketCurrentProbs = snap.val() || {};
    renderMarkets();
    // Refresh modal % live if it's currently open for a market
    if (activeBet.marketId &&
        !document.getElementById("bet-overlay").classList.contains("hidden")) {
      updateBetModal();
    }
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
function toArray(val) {
  if (!val) return null;
  if (Array.isArray(val)) return val;
  // Firebase sometimes returns {0: x, 1: y, ...} instead of [x, y, ...]
  if (typeof val === 'object') {
    const keys = Object.keys(val).map(Number).sort((a, b) => a - b);
    if (keys.length > 0) return keys.map(k => val[k]);
  }
  return null;
}

function getCurrentProbs(marketId, market) {
  const stored = toArray(marketCurrentProbs[marketId]);
  if (stored && stored.length > 0) return stored;
  return toArray(market.baseProbs) || [50, 50];
}

function getHistory(marketId, market) {
  return buildDisplayHistory(marketId, market);
}

function renderMarkets() {
  const grid = document.getElementById("markets-grid");
  const entries = Object.entries(allMarkets).sort((a, b) => {
    // Open markets first, then closed, then resolved
    const order = { open: 0, closed: 1, resolved: 2 };
    return (order[a[1].status] ?? 1) - (order[b[1].status] ?? 1);
  });

  if (entries.length === 0) {
    grid.innerHTML = `<div style="color:var(--text-dim);font-size:.875rem;padding:2rem 0;">No markets yet.</div>`;
    return;
  }

  grid.innerHTML = entries.map(([id, m]) => {
    const isOpen     = m.status === "open";
    const isResolved = m.status === "resolved";
    const isClosed   = !isOpen;

    const probs   = getCurrentProbs(id, m);
    const history = getHistory(id, m);
    const options = m.options || ["YES", "NO"];
    const isBinary = options.length === 2 && options[0] === "YES" && options[1] === "NO";

    const chartHTML = renderSparkline(history, options, probs);

    // Status badge shown on non-open markets
    const statusBadge = isClosed
      ? `<div class="market-status-badge ${isResolved ? "resolved" : "closed"}">
          ${isResolved ? `Resolved: ${m.resolvedOption}` : "Closed"}
        </div>`
      : "";

    const footerBtns = isOpen
      ? (isBinary
          ? `<div class="market-bet-btns" onclick="event.stopPropagation()">
              <button class="bet-btn yes" onclick="openBetModal('${id}',0)">YES ${Math.round(probs[0])}¢</button>
              <button class="bet-btn no"  onclick="openBetModal('${id}',1)">NO ${Math.round(probs[1])}¢</button>
            </div>`
          : `<div class="market-bet-btns" onclick="event.stopPropagation()">
              <button class="bet-btn trade" onclick="openBetModal('${id}',0)">Trade</button>
            </div>`)
      : `<div class="market-bet-btns"></div>`;

    return `
      <div class="market-card ${isClosed ? "market-card-closed" : ""}" ${isOpen ? `onclick="openBetModal('${id}',0)"` : ""}>
        <div class="market-card-header">
          <div class="market-category">${m.category || "General"}</div>
          ${statusBadge}
        </div>
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
  // Modal: every 5th point → ~12 control points, clean readable curves
  const { n, svg } = buildChart(history, options, W, H, PAD, 2.5, 6, true, 5);

  // Legend: colored dot + name + %
  const legend = options.slice(0, n).map((opt, i) => {
    const p = probs[i] || 0;
    return `<div class="market-chart-legend-row">
      <div class="legend-dot" style="background:${OPTION_COLORS[i]}"></div>
      <span class="legend-label">${opt}</span>
      <span class="legend-prob${p < 5 ? ' longshot' : ''}">${fmtProb(p)}</span>
    </div>`;
  }).join('');

  // Options breakdown table
  const isBinary = options.length === 2 && options[0] === 'YES' && options[1] === 'NO';
  const table = options.slice(0, n).map((opt, i) => {
    const p    = probs[i] || 0;
    const noP  = 100 - Math.round(p);
    const dim  = p < 5 ? ' longshot' : '';
    return `<div class="modal-option-row${dim}">
      <div class="modal-option-dot" style="background:${OPTION_COLORS[i]}"></div>
      <div class="modal-option-name">${opt}</div>
      <div class="modal-option-pills">
        ${isBinary
          ? `<span class="modal-pill yes">${fmtProb(p)}</span><span class="modal-pill no">${fmtProb(noP)}</span>`
          : `<span class="modal-pill yes">${fmtProb(p)}</span>`}
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

function fmtProb(p) {
  if (p < 1) return "<1%";
  if (p > 99) return ">99%";
  return `${Math.round(p)}%`;
}

function updateBetModal() {
  const market = allMarkets[activeBet.marketId];
  if (!market) return;

  const probs   = getCurrentProbs(activeBet.marketId, market);
  const options = market.options || ["YES", "NO"];

  document.getElementById("bet-options-row").innerHTML = options.slice(0, 5).map((opt, i) => {
    const p      = probs[i] || 0;
    const active = i === activeBet.optionIndex ? " active" : "";
    const dim    = p < 5 ? " longshot" : "";
    return `<button class="bet-option-btn${active}${dim}" onclick="selectOption(${i})">
      ${opt}<br><span class="bet-option-prob">${fmtProb(p)}</span>
    </button>`;
  }).join("");

  const rawProb    = Math.max(0.5, probs[activeBet.optionIndex] || 50);
  const optionLabel = options[activeBet.optionIndex] || "Option";
  const payout      = Math.round(activeBet.amount / (rawProb / 100));
  const profit      = payout - activeBet.amount;

  document.getElementById("bet-summary").innerHTML =
    `<span class="bet-summary-text">Bet <strong>$${activeBet.amount}</strong> on <strong>${optionLabel}</strong> · win <strong>$${payout}</strong></span>` +
    `<span class="bet-summary-profit">+$${profit} profit</span>`;
}

window.selectOption = function(i) {
  activeBet.optionIndex = i;
  updateBetModal();
};

function applyAmount(amount) {
  const maxBet = user.balance + 1000;
  activeBet.amount = Math.max(1, Math.min(maxBet, amount));
  document.getElementById("bet-amount-input").value = activeBet.amount;
  updateBetModal();
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
    updateBetModal();
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

  // Nudge probabilities — scales meaningfully with bet size
  // $100 ≈ 3pts, $300 ≈ 7pts, $500 ≈ 10pts, $1000 ≈ 15pts (capped)
  await runTransaction(ref(db, `market_probs/${activeBet.marketId}`), (cur) => {
    const curArr = toArray(cur);
    let p = (curArr && curArr.length === options.length) ? [...curArr] : [...probs];
    const weight = Math.min(activeBet.amount / 55, 15);
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
