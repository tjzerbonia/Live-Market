// ============================================================
//  FORECAST MARKETS — app.js
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, push, onValue, runTransaction, serverTimestamp, update, get, remove
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
let usersMap = {};            // { userId: { name, avatar, ... } }
let marketFilter = "open";     // "all" | "open" | "resolved"
let categoryFilter = "all";  // "all" | <category string>
let allReactions = {};        // { betKey: { emojiKey: { userId: true } } }

// ─── SPARKLINE COLORS (one per option) ───────────────────────
const OPTION_COLORS = ["#00a86b", "#5b7cfa", "#f59e0b", "#e879f9", "#e53935"];

// ─── NICKNAME SETUP ──────────────────────────────────────────
// Resize an image file to a square thumbnail and return base64 JPEG
function resizeImage(file, size = 64) {
  return new Promise((resolve) => {
    const img    = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d");
        // Cover-crop: center the image
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

let pendingAvatar = null; // base64 string set before submit

async function initUser() {
  const stored = localStorage.getItem("forecast_user");
  if (stored) {
    user = JSON.parse(stored);
    // Verify the user hasn't been deleted by admin before setting up any subscriptions.
    // Doing this first prevents race conditions where subscribeToConfig() would
    // re-create the deleted user node before the existence check could catch it.
    const snap = await get(ref(db, `users/${user.id}`));
    if (!snap.exists()) {
      localStorage.removeItem("forecast_user");
      user = { id: null, name: null, balance: 1000 };
      showNicknameModal();
      return;
    }
    onUserReady();
  } else {
    showNicknameModal();
  }
}

function showNicknameModal() {
  document.getElementById("nickname-overlay").classList.remove("hidden");
  document.getElementById("nickname-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitNickname();
  });
  document.getElementById("nickname-submit").addEventListener("click", submitNickname);
  document.getElementById("avatar-file-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingAvatar = await resizeImage(file, 64);
    const preview = document.getElementById("avatar-preview");
    preview.style.backgroundImage = `url(${pendingAvatar})`;
    preview.classList.add("has-image");
  });
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

  user = { id: crypto.randomUUID(), name, balance: 1000, avatar: pendingAvatar || null };
  localStorage.setItem("forecast_user", JSON.stringify(user));
  document.getElementById("nickname-overlay").classList.add("hidden");
  onUserReady();
  btn.disabled = false;
  btn.textContent = "Enter Markets";
}

function onUserReady() {
  document.getElementById("user-name-display").textContent = user.name;
  const avatarEl = document.getElementById("user-avatar");
  if (user.avatar) {
    avatarEl.style.backgroundImage = `url(${user.avatar})`;
    avatarEl.classList.add("has-image");
  } else {
    avatarEl.textContent = getInitials(user.name);
  }
  updateBalanceDisplay();
  registerUserInFirebase();
  subscribeToMarkets();
  subscribeToActivity();
  subscribeToUsers();
  subscribeToMarketProbs();
  subscribeToMarketHistories();
  subscribeToConfig();
  subscribeToUserBalance();
  subscribeToReactions();

  // Auto-close markets whose closeDate has passed (runs every 60s)
  setInterval(() => {
    if (!user.id) return;
    const now = new Date();
    Object.entries(allMarkets).forEach(([id, m]) => {
      if (m.status === "open" && m.closeDate && new Date(m.closeDate) <= now) {
        update(ref(db, `markets/${id}`), { status: "closed", closedAt: Date.now() });
      }
    });
  }, 60000);

  document.getElementById("avatar-update-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const resized = await resizeImage(file, 64);
    const preview = document.getElementById("avatar-modal-preview");
    preview.style.backgroundImage = `url(${resized})`;
    preview.classList.add("has-image");
    preview.dataset.pending = resized;
    document.getElementById("avatar-modal-save").disabled = false;
    e.target.value = "";
  });

  document.getElementById("avatar-modal-save").addEventListener("click", () => {
    const preview = document.getElementById("avatar-modal-preview");
    const newAvatar = preview.dataset.pending;
    if (!newAvatar) return;
    user.avatar = newAvatar;
    localStorage.setItem("forecast_user", JSON.stringify(user));
    const el = document.getElementById("user-avatar");
    el.style.backgroundImage = `url(${newAvatar})`;
    el.textContent = "";
    el.classList.add("has-image");
    update(ref(db, `users/${user.id}`), { avatar: newAvatar });
    showToast("Photo updated!");
    closeAvatarModal();
  });
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
  const updates = { name: user.name, balance: user.balance, lastSeen: Date.now() };
  if (user.avatar) updates.avatar = user.avatar;
  update(ref(db, `users/${user.id}`), updates);
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

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Insider trading guard — any 2-option market
// Title words: exact match only
// Option labels: exact match OR option is a prefix of the username token (e.g. "Nick" → "NickMoney")
function isInsiderBlocked(marketTitle, userName, options) {
  if (options.length !== 2 || !userName) return false;
  const titleTokens = new Set(
    marketTitle.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean)
  );
  const optionTokens = options
    .join(" ").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(t => t.length >= 2);
  const nameTokens = userName.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(t => t.length >= 2);
  return nameTokens.length > 0 && nameTokens.some(nt =>
    titleTokens.has(nt) ||
    optionTokens.some(ot => ot === nt || (ot.length >= 3 && nt.startsWith(ot)))
  );
}

function timeAgo(ts) {
  if (!ts) return "just now";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ─── CHART ENGINE ─────────────────────────────────────────────
// Shared normalizer — scales arr so its sum equals total
function makeNormalize(total) {
  return arr => {
    const s = arr.reduce((a, v) => a + v, 0);
    return arr.map(v => (v / s) * total);
  };
}

function seedHistory(marketId, baseProbs, currentProbs) {
  let seed = 0;
  for (let i = 0; i < marketId.length; i++) seed += marketId.charCodeAt(i) * (i + 1);
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  };

  const total = baseProbs.reduce((s, p) => s + p, 0);
  const normalize = makeNormalize(total);

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
  const normalize = makeNormalize(total);

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
  const normalize = makeNormalize(total);

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

function buildChart(history, options, W, H, PAD, strokeW, dotR, showAll, thinFactor, fixedScale = false, resolvedIndex = -1) {
  const isBinary = options.length === 2 && options[0] === 'YES' && options[1] === 'NO';
  const n = showAll ? Math.min(options.length, OPTION_COLORS.length)
                    : (isBinary ? 1 : Math.min(options.length, OPTION_COLORS.length));

  const isResolved = resolvedIndex >= 0;

  if (!history || history.length < 2) {
    return { n, svg: `<line x1="0" y1="${H/2}" x2="${W}" y2="${H/2}" stroke="#e5e7eb" stroke-width="1.5"/>` };
  }

  // For resolved markets append a final snap driving winner to 100, losers to 0
  const baseHistory = isResolved
    ? [...history, options.slice(0, n).map((_, oi) => oi === resolvedIndex ? 100 : 0)]
    : history;

  const pts_src = thinFactor > 1
    ? baseHistory.filter((_, i) => i % thinFactor === 0 || i === baseHistory.length - 1)
    : baseHistory;

  let minP, maxP;
  if (fixedScale) {
    minP = 0; maxP = 100;
  } else {
    const allVals = pts_src.flatMap(snap => snap.slice(0, n));
    const rawMin = Math.min(...allVals), rawMax = Math.max(...allVals);
    const mid = (rawMin + rawMax) / 2;
    const dataHalf = (rawMax - rawMin) / 2;
    const halfSpan = Math.max(6, dataHalf + 6);
    minP = Math.max(0,   mid - halfSpan);
    maxP = Math.min(100, mid + halfSpan);
  }
  const range = maxP - minP || 1;

  const toXY = (snap, i, oi) => {
    const x    = PAD + (i / (pts_src.length - 1)) * (W - 2 * PAD);
    const rawY = H - PAD - ((snap[oi] - minP) / range) * (H - 2 * PAD);
    const y    = Math.max(PAD, Math.min(H - PAD, rawY));
    return [parseFloat(x.toFixed(1)), parseFloat(y.toFixed(1))];
  };

  const clipId = `c${++_chartSeq}`;
  let svg = `<defs><clipPath id="${clipId}"><rect x="${PAD}" y="${PAD}" width="${W - 2*PAD}" height="${H - 2*PAD}"/></clipPath></defs>`;

  // 50% reference line — only when using fixed 0-100% scale
  if (fixedScale) {
    const y50 = H - PAD - ((50 - minP) / range) * (H - 2 * PAD);
    svg += `<line x1="${PAD}" y1="${y50.toFixed(1)}" x2="${W - PAD}" y2="${y50.toFixed(1)}" stroke="#9ca3af" stroke-width="1.5" stroke-dasharray="5,3"/>`;
    svg += `<text x="${PAD + 2}" y="${(y50 - 4).toFixed(1)}" font-size="10" fill="#6b7280" font-family="system-ui,sans-serif" font-weight="600">50%</text>`;
  }

  for (let oi = n - 1; oi >= 0; oi--) {
    const color = OPTION_COLORS[oi];
    const pts   = pts_src.map((snap, i) => toXY(snap, i, oi));
    svg += `<path d="${catmullRomPath(pts)}" fill="none" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#${clipId})"/>`;
  }

  // Endpoint dots — drawn outside clipPath so rings are never cropped
  for (let oi = 0; oi < n; oi++) {
    const color   = OPTION_COLORS[oi];
    const [ex, ey] = toXY(pts_src[pts_src.length - 1], pts_src.length - 1, oi);

    if (isResolved) {
      const won = oi === resolvedIndex;
      const r   = dotR * 1.6;
      const icon = won ? "✓" : "✕";
      const fs   = r * 1.05;
      // Same size/color dot as live, just slightly larger to fit the icon
      svg += `<circle cx="${ex}" cy="${ey}" r="${r}" fill="${color}" stroke="#fff" stroke-width="1.5"/>`;
      // White icon overlaid — ✓ green dot, ✕ same color dot so icon is the differentiator
      svg += `<text x="${ex}" y="${(ey + fs * 0.36).toFixed(1)}" text-anchor="middle" font-size="${fs.toFixed(1)}" fill="#fff" font-family="system-ui,sans-serif" font-weight="700">${icon}</text>`;
    } else {
      const ringR   = dotR * 2.5;
      const delayMs = oi * 400;
      svg += `<circle class="chart-dot-ring" cx="${ex}" cy="${ey}" r="${ringR}" fill="${color}" style="transform-origin:${ex}px ${ey}px;animation-delay:${delayMs}ms"/>`;
      svg += `<circle cx="${ex}" cy="${ey}" r="${dotR}" fill="${color}" stroke="#fff" stroke-width="1.5"/>`;
    }
  }
  return { n, svg };
}

function renderSparkline(history, options, probs, resolvedIndex = -1) {
  const W = 260, H = 95, PAD = 5;
  // Card: fixed 0-100% scale so visual position reflects actual probability
  const { n, svg } = buildChart(history, options, W, H, PAD, 2.2, 4, false, 4, true, resolvedIndex);

  // Show top 2 by probability so all cards have a consistent legend height
  const allOpts = options.slice(0, n).map((opt, i) => ({ opt, i, p: probs[i] || 0 }));
  const top2    = [...allOpts].sort((a, b) => b.p - a.p).slice(0, 2);
  const extra   = n > 2 ? n - 2 : 0;

  const legend = top2.map(({ opt, i, p }) =>
    `<div class="market-chart-legend-row">
      <div class="legend-dot" style="background:${OPTION_COLORS[i]}"></div>
      <span class="legend-label">${opt}</span>
      <span class="legend-prob${p < 5 ? ' longshot' : ''}">${fmtProb(p)}</span>
    </div>`
  ).join('') + (extra ? `<div class="legend-more">+${extra} more</div>` : '');

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
function subscribeToUsers() {
  onValue(ref(db, "users"), (snap) => {
    usersMap = snap.val() || {};
    renderActivityFeed();
    renderLeaderboard();
  });
}

function subscribeToMarkets() {
  onValue(ref(db, "markets"), (snap) => {
    allMarkets = snap.val() || {};
    scheduleRenderMarkets();
  });
}

function subscribeToMarketProbs() {
  onValue(ref(db, "market_probs"), (snap) => {
    marketCurrentProbs = snap.val() || {};
    scheduleRenderMarkets();
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
    scheduleRenderMarkets();
  });
}

// Coalesce rapid simultaneous Firebase updates into a single render
let _renderTimer = null;
function scheduleRenderMarkets() {
  clearTimeout(_renderTimer);
  _renderTimer = setTimeout(renderMarkets, 30);
}

// ─── PAGE TABS ───────────────────────────────────────────────
window.setPageTab = function(tab) {
  document.getElementById("tab-markets").style.display    = tab === "markets"     ? "" : "none";
  document.getElementById("tab-leaderboard").style.display = tab === "leaderboard" ? "" : "none";
  document.querySelectorAll(".page-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
};

// ─── MARKET FILTER ───────────────────────────────────────────
window.setMarketFilter = function(filter) {
  marketFilter = filter;
  document.querySelectorAll(".market-filter-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.filter === filter);
  });
  renderMarkets();
};

window.setCategoryFilter = function(cat) {
  categoryFilter = cat;
  document.querySelectorAll(".category-filter-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.cat === cat);
  });
  renderMarkets();
};

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

function renderMarkets() {
  const grid = document.getElementById("markets-grid");
  let entries = Object.entries(allMarkets).filter(([, m]) => m.status !== "archived");

  // Build and show/hide category filter row
  const allCats = [...new Set(Object.values(allMarkets).filter(m => m.status !== "archived").map(m => m.category || "General"))];
  const catRow = document.getElementById("category-filter-row");
  if (catRow) {
    if (allCats.length >= 2) {
      catRow.style.display = "";
      catRow.innerHTML = [`<button class="market-filter-btn category-filter-btn${categoryFilter === "all" ? " active" : ""}" data-cat="all" onclick="setCategoryFilter('all')">All Categories</button>`]
        .concat(allCats.map(cat =>
          `<button class="market-filter-btn category-filter-btn${categoryFilter === cat ? " active" : ""}" data-cat="${escHtml(cat)}" onclick="setCategoryFilter('${escHtml(cat).replace(/'/g, "\\'")}')">` +
          `${escHtml(cat)}</button>`
        )).join("");
    } else {
      catRow.style.display = "none";
    }
  }

  if (marketFilter === "open") {
    entries = entries.filter(([, m]) => m.status === "open");
  } else if (marketFilter === "resolved") {
    entries = entries.filter(([, m]) => m.status === "resolved");
  }

  // Category filter
  if (categoryFilter !== "all") {
    entries = entries.filter(([, m]) => (m.category || "General") === categoryFilter);
  }

  entries = entries.sort((a, b) => {
    const statusOrder = { open: 0, closed: 1, resolved: 2 };
    const statusDiff = (statusOrder[a[1].status] ?? 1) - (statusOrder[b[1].status] ?? 1);
    if (statusDiff !== 0) return statusDiff;
    // Open markets: sort by admin-defined order field
    if (a[1].status === "open") {
      const ao = a[1].order != null ? a[1].order : (a[1].createdAt ?? 0);
      const bo = b[1].order != null ? b[1].order : (b[1].createdAt ?? 0);
      return ao - bo;
    }
    // Within closed/resolved groups: most recent first
    const tsA = a[1].resolvedAt || a[1].closedAt || a[1].createdAt || 0;
    const tsB = b[1].resolvedAt || b[1].closedAt || b[1].createdAt || 0;
    return tsB - tsA;
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
    const history = buildDisplayHistory(id, m);
    const options = m.options || ["YES", "NO"];
    const isBinary = options.length === 2 && options[0] === "YES" && options[1] === "NO";

    const resolvedIdx = isResolved && m.resolvedOptionIndex != null ? Number(m.resolvedOptionIndex) : -1;
    const chartHTML = renderSparkline(history, options, probs, resolvedIdx);

    const statusBadge = isClosed && !isResolved
      ? `<div class="market-status-badge closed">Closed</div>`
      : "";

    const blocked = isOpen && user.id && isInsiderBlocked(m.title, user.name, options);

    const footerBtns = isOpen
      ? (blocked
          ? `<div class="market-bet-btns" onclick="event.stopPropagation()">
              <div class="bet-restricted-badge">Insider restricted</div>
            </div>`
          : (isBinary
              ? `<div class="market-bet-btns" onclick="event.stopPropagation()">
                  <button class="bet-btn yes" onclick="openBetModal('${id}',0)">YES ${Math.round(probs[0])}¢</button>
                  <button class="bet-btn no"  onclick="openBetModal('${id}',1)">NO ${Math.round(probs[1])}¢</button>
                </div>`
              : `<div class="market-bet-btns" onclick="event.stopPropagation()">
                  <button class="bet-btn trade" onclick="openBetModal('${id}',0)">Trade</button>
                </div>`))
      : `<div class="market-bet-btns"></div>`;

    return `
      <div class="market-card ${isClosed ? "market-card-closed" : ""}" onclick="openBetModal('${id}',0)">
        <div class="market-card-header">
          <div class="market-category">${m.category || "General"}</div>
          ${statusBadge}
        </div>
        <div class="market-title">${m.title}</div>
        ${isResolved ? `
        <div class="market-winner-banner">
          <span class="market-winner-label">Winner</span>
          <span class="market-winner-name">${m.resolvedOption}</span>
        </div>` : ""}
        ${chartHTML}
        <div class="market-footer">
          <div class="market-vol">
            Vol: $${(m.volume || 0).toLocaleString()}
            ${isOpen && m.closeDate ? `<span class="market-close-time">· Closes ${fmtCloseDate(m.closeDate)}</span>` : ""}
          </div>
          ${footerBtns}
        </div>
      </div>`;
  }).join("");
}

// ─── MODAL CHART ─────────────────────────────────────────────
function renderModalChart(history, options, probs, resolvedIndex = -1) {
  const W = 500, H = 220, PAD = 8;
  // Modal: fixed 0-100% scale so visual position reflects actual probability
  const { n, svg } = buildChart(history, options, W, H, PAD, 2.5, 6, true, 5, true, resolvedIndex);

  // Legend: colored dot + name + %
  const legend = options.slice(0, n).map((opt, i) => {
    const p = probs[i] || 0;
    return `<div class="market-chart-legend-row">
      <div class="legend-dot" style="background:${OPTION_COLORS[i]}"></div>
      <span class="legend-label">${opt}</span>
      <span class="legend-prob${p < 5 ? ' longshot' : ''}">${fmtProb(p)}</span>
    </div>`;
  }).join('');

  const isBinary = options.length === 2 && options[0] === 'YES' && options[1] === 'NO';

  // For binary markets: simple pill table
  // For multi-option: horizontal bar chart per option
  let breakdown = '';
  if (isBinary) {
    breakdown = `<div class="modal-options-table">${options.slice(0, n).map((opt, i) => {
      const p   = probs[i] || 0;
      const noP = 100 - Math.round(p);
      return `<div class="modal-option-row${p < 5 ? ' longshot' : ''}">
        <div class="modal-option-dot" style="background:${OPTION_COLORS[i]}"></div>
        <div class="modal-option-name">${opt}</div>
        <div class="modal-option-pills">
          <span class="modal-pill yes">${fmtProb(p)}</span>
          <span class="modal-pill no">${fmtProb(noP)}</span>
        </div>
      </div>`;
    }).join('')}</div>`;
  } else {
    // Horizontal bar chart — sorted by probability descending
    const sorted = options.slice(0, n)
      .map((opt, i) => ({ opt, i, p: probs[i] || 0 }))
      .sort((a, b) => b.p - a.p);
    const maxP = Math.max(...sorted.map(s => s.p), 1);

    breakdown = `<div class="modal-bar-chart">${sorted.map(({ opt, i, p }) => {
      const barW   = Math.round((p / maxP) * 100);
      const dim    = p < 5 ? ' longshot' : '';
      return `<div class="modal-bar-row${dim}">
        <div class="modal-bar-name">${opt}</div>
        <div class="modal-bar-track">
          <div class="modal-bar-fill" style="width:${barW}%;background:${OPTION_COLORS[i]}"></div>
        </div>
        <div class="modal-bar-pct" style="color:${OPTION_COLORS[i]}">${fmtProb(p)}</div>
      </div>`;
    }).join('')}</div>`;
  }

  return `
    <div class="market-chart-legend">${legend}</div>
    <div class="modal-chart-svg"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${svg}</svg></div>
    ${breakdown}
    <div class="modal-trade-divider"></div>`;
}

// ─── BET MODAL ───────────────────────────────────────────────
window.openBetModal = function(marketId, optionIndex = 0) {
  if (!user.id) return;
  const market = allMarkets[marketId];
  if (!market) return;

  activeBet.marketId    = marketId;
  activeBet.optionIndex = optionIndex;
  activeBet.amount      = 0;

  const isOpen  = market.status === "open";
  const options = market.options || ["YES", "NO"];
  const probs   = getCurrentProbs(marketId, market);
  const history = buildDisplayHistory(marketId, market);

  document.getElementById("bet-modal-category").textContent = market.category || "";
  document.getElementById("bet-modal-market-title").textContent = market.title;
  const closeDateEl = document.getElementById("bet-modal-close-date");
  if (closeDateEl) {
    const fmt = isOpen && market.closeDate ? `Closes ${fmtCloseDate(market.closeDate)}` : "";
    closeDateEl.textContent = fmt;
    closeDateEl.style.display = fmt ? "" : "none";
  }
  const resolvedIdx = market.status === "resolved" && market.resolvedOptionIndex != null ? Number(market.resolvedOptionIndex) : -1;
  document.getElementById("modal-chart-area").innerHTML = renderModalChart(history, options, probs, resolvedIdx);

  // Winner banner
  const bannerEl = document.getElementById("modal-winner-banner");
  if (bannerEl) {
    if (market.status === "resolved" && market.resolvedOption) {
      bannerEl.className = "modal-winner-banner";
      bannerEl.innerHTML =
        `<div class="modal-winner-label">Winner</div><div class="modal-winner-name">${market.resolvedOption}</div>`;
    } else {
      bannerEl.className = "hidden";
      bannerEl.innerHTML = "";
    }
  }

  // Reset input field and hint
  const inputEl = document.getElementById("bet-amount-input");
  const hintEl  = document.getElementById("bet-input-hint");
  if (inputEl) { inputEl.value = ""; }
  if (hintEl)  { hintEl.textContent = ""; hintEl.className = "bet-input-hint"; }

  document.getElementById("bet-overlay").classList.remove("hidden");
  updateBetModal();

  // Apply insider block AFTER updateBetModal so the restricted message isn't overwritten
  const blocked       = isOpen && isInsiderBlocked(market.title, user.name, options);
  const tradeControls = document.getElementById("bet-amount-row");
  const submitBtn     = document.getElementById("submit-bet-btn");
  const summaryEl     = document.getElementById("bet-summary");
  const optionsRowEl  = document.getElementById("bet-options-row");
  if (tradeControls) tradeControls.style.display = (isOpen && !blocked) ? "" : "none";
  if (submitBtn)     submitBtn.style.display     = (isOpen && !blocked) ? "" : "none";
  // Keep options row visible when blocked so avatars still show — just make buttons non-interactive
  if (optionsRowEl)  optionsRowEl.style.display  = isOpen ? "" : "none";
  if (optionsRowEl)  optionsRowEl.style.pointerEvents = blocked ? "none" : "";
  if (optionsRowEl)  optionsRowEl.style.opacity       = blocked ? "0.6" : "";
  if (summaryEl && blocked) {
    summaryEl.innerHTML = `<span class="bet-summary-text bet-summary-closed">You're named in this market — trading restricted.</span>`;
  }
};

function fmtCloseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  if (isNaN(d)) return null;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtProb(p) {
  if (p < 1) return "<1%";
  if (p > 99) return ">99%";
  return `${Math.round(p)}%`;
}

// Returns avatar src for an option label — matches against usersMap by name, falls back to profile_default.jpg
function getAvatarForOption(optLabel) {
  const match = Object.values(usersMap).find(
    u => u.name && u.name.toLowerCase() === optLabel.toLowerCase()
  );
  return (match && match.avatar) ? match.avatar : "profile_default.jpg";
}

// Rebuilds option buttons — called once on open and on option switch
function updateBetOptions() {
  const market = allMarkets[activeBet.marketId];
  if (!market) return;
  const probs   = getCurrentProbs(activeBet.marketId, market);
  const options = market.options || ["YES", "NO"];
  const isOpen  = market.status === "open";
  const isHeadToHead = options.length === 2 && !(options[0] === "YES" && options[1] === "NO");

  document.getElementById("bet-options-row").innerHTML = options.slice(0, 5).map((opt, i) => {
    const p      = probs[i] || 0;
    const active = i === activeBet.optionIndex ? " active" : "";
    const dim    = p < 5 ? " longshot" : "";
    const avatar = isHeadToHead
      ? `<div class="bet-option-avatar" style="background-image:url(${getAvatarForOption(opt)})"></div>`
      : "";
    return `<button class="bet-option-btn${active}${dim}${isHeadToHead ? " h2h" : ""}" ${isOpen ? `onclick="selectOption(${i})"` : "disabled"}>
      ${avatar}${opt}<br><span class="bet-option-prob">${fmtProb(p)}</span>
    </button>`;
  }).join("");
}

// Only updates the summary line — called on every amount or option change
function updateBetSummary() {
  const market = allMarkets[activeBet.marketId];
  if (!market) return;
  const probs      = getCurrentProbs(activeBet.marketId, market);
  const options    = market.options || ["YES", "NO"];
  const isOpen     = market.status === "open";
  const summaryEl  = document.getElementById("bet-summary");
  if (!summaryEl) return;

  if (!isOpen) {
    const isResolved = market.status === "resolved";
    summaryEl.innerHTML = isResolved
      ? `<span class="bet-summary-text"><strong>${market.resolvedOption}</strong> won this market</span>`
      : `<span class="bet-summary-text bet-summary-closed">Market closed — no new trades</span>`;
    return;
  }

  const rawProb     = Math.max(0.5, probs[activeBet.optionIndex] || 50);
  const optionLabel = options[activeBet.optionIndex] || "Option";

  if (!activeBet.amount || activeBet.amount < 1) {
    summaryEl.innerHTML = `<span class="bet-summary-text bet-summary-empty">Enter an amount to see your payout</span>`;
    return;
  }

  const payout = Math.round(activeBet.amount / (rawProb / 100));
  const profit = payout - activeBet.amount;

  summaryEl.innerHTML =
    `<span class="bet-summary-text">Bet <strong>$${activeBet.amount.toLocaleString()}</strong> on <strong>${optionLabel}</strong> · win <strong>$${payout.toLocaleString()}</strong></span>` +
    `<span class="bet-summary-profit">+$${profit.toLocaleString()}</span>`;
}

function updateBetModal() {
  updateBetOptions();
  updateBetSummary();
}

window.selectOption = function(i) {
  activeBet.optionIndex = i;
  updateBetOptions();
  updateBetSummary();
};

document.getElementById("bet-amount-input").addEventListener("input", (e) => {
  const n    = parseInt(e.target.value, 10);
  const hint = document.getElementById("bet-input-hint");
  const max  = user.balance + 1000;

  if (!n || n < 1) {
    activeBet.amount = 0;
    hint.textContent = "";
    updateBetSummary();
    return;
  }

  if (n > max) {
    activeBet.amount = max;
    e.target.value   = max;
    hint.textContent = `Sorry, you've hit your limit — you can only go 1,000 Schmeckles in the hole.`;
    hint.className   = "bet-input-hint warn";
  } else if (n > user.balance) {
    activeBet.amount = n;
    const deficit = n - user.balance;
    hint.textContent = `Bold — you'd be $${deficit} in the hole on this one.`;
    hint.className   = "bet-input-hint warn";
  } else {
    activeBet.amount = n;
    hint.textContent = "";
    hint.className   = "bet-input-hint";
  }
  updateBetSummary();
});

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
  const inputVal = parseInt(document.getElementById("bet-amount-input").value, 10);
  if (!isNaN(inputVal) && inputVal >= 1) activeBet.amount = inputVal;
  if (!activeBet.amount || activeBet.amount < 1) {
    document.getElementById("bet-amount-input").focus();
    return;
  }

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
let cachedActivityBets = [];

const REACTION_EMOJIS = [
  { key: "fire",    emoji: "🔥" },
  { key: "eyes",    emoji: "👀" },
  { key: "hundred", emoji: "💯" },
];

function renderActivityFeed() {
  if (!cachedActivityBets.length) return;
  const feed = document.getElementById("activity-feed");
  feed.innerHTML = cachedActivityBets.slice(0, 10).map(({ key, bet }, i) => {
    const label = bet.option || bet.side || "YES";
    const isNo  = label.toUpperCase() === "NO";
    const opacity = i <= 6 ? 1 : Math.max(0.1, 1 - (i - 6) * 0.3);
    const betUserAvatar = usersMap[bet.userId]?.avatar;
    const avatarEl = betUserAvatar
      ? `<div class="activity-avatar has-image" style="background-image:url(${betUserAvatar})"></div>`
      : `<div class="activity-avatar">${getInitials(bet.userName || "?")}</div>`;
    const safeName  = escHtml(bet.userName || "Anonymous");
    const safeTitle = escHtml((bet.marketTitle || "a market").slice(0, 45));
    const safeLabel = escHtml(label);

    const reactionBtns = REACTION_EMOJIS.map(({ key: rkey, emoji }) => {
      const emojiReactions = (allReactions[key] && allReactions[key][rkey]) || {};
      const count   = Object.keys(emojiReactions).length;
      const reacted = user.id && !!emojiReactions[user.id];
      return `<button class="reaction-btn${reacted ? " reacted" : ""}" onclick="event.stopPropagation();toggleReaction('${key}','${rkey}')">${emoji}${count > 0 ? `<span class="reaction-count">${count}</span>` : ""}</button>`;
    }).join("");
    const hasAnyReaction = REACTION_EMOJIS.some(({ key: rkey }) =>
      Object.keys((allReactions[key]?.[rkey]) || {}).length > 0
    );
    const reactionRow = `<div class="activity-reactions${hasAnyReaction ? " has-reactions" : ""}">${reactionBtns}</div>`;

    return `
    <div class="activity-item" style="opacity:${opacity}">
      ${avatarEl}
      <div class="activity-text">
        <strong>${safeName}</strong>
        bet on <strong>${safeTitle}${(bet.marketTitle?.length || 0) > 45 ? "…" : ""}</strong>
      </div>
      <div class="activity-side${isNo ? " no" : ""}">${safeLabel}</div>
      <div class="activity-amount">$${bet.amount}</div>
      <div class="activity-time">${timeAgo(bet.timestamp)}</div>
      ${reactionRow}
    </div>`;
  }).join("");

}

function subscribeToActivity() {
  onValue(ref(db, "bets"), (snap) => {
    const data = snap.val();
    if (!data) return;
    cachedActivityBets = Object.entries(data)
      .filter(([, b]) => b.marketId)
      .sort(([, a], [, b]) => (b.timestamp || 0) - (a.timestamp || 0))
      .map(([key, bet]) => ({ key, bet }));
    renderActivityFeed();
  });
}

// ─── AVATAR MODAL ────────────────────────────────────────────
window.openAvatarModal = function() {
  const preview = document.getElementById("avatar-modal-preview");
  // Seed preview with current avatar if one exists
  if (user.avatar) {
    preview.style.backgroundImage = `url(${user.avatar})`;
    preview.classList.add("has-image");
  } else {
    preview.style.backgroundImage = "";
    preview.classList.remove("has-image");
    preview.textContent = getInitials(user.name);
  }
  delete preview.dataset.pending;
  document.getElementById("avatar-modal-save").disabled = true;
  document.getElementById("avatar-modal-overlay").classList.remove("hidden");
};

window.closeAvatarModal = function() {
  document.getElementById("avatar-modal-overlay").classList.add("hidden");
};

// ─── TRADE HISTORY ───────────────────────────────────────────
window.openHistory = function() {
  document.getElementById("history-overlay").classList.remove("hidden");
  renderHistory();
};

window.closeHistory = function() {
  document.getElementById("history-overlay").classList.add("hidden");
};

async function renderHistory() {
  const listEl     = document.getElementById("history-list");
  const subtitleEl = document.getElementById("history-subtitle");
  listEl.innerHTML = `<div class="history-empty">Loading...</div>`;

  const snap   = await get(ref(db, "bets"));
  const allBets = snap.val() || {};

  const myBets = Object.values(allBets)
    .filter(b => b.userId === user.id)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  if (myBets.length === 0) {
    listEl.innerHTML = `<div class="history-empty">No trades yet.</div>`;
    subtitleEl.textContent = "";
    return;
  }

  let totalWon = 0, totalLost = 0;

  const rows = myBets.map(bet => {
    // Admin adjustment entry
    if (bet.type === "admin_adjustment") {
      const isCredit = bet.delta > 0;
      const cashflow = isCredit
        ? `<span class="history-cf-win">+$${Math.abs(bet.delta).toLocaleString()}</span>`
        : `<span class="history-cf-loss">-$${Math.abs(bet.delta).toLocaleString()}</span>`;
      return `
        <div class="history-row">
          <div class="history-row-main">
            <span class="history-status-pill history-status-admin">Admin</span>
            <div class="history-row-info">
              <div class="history-row-title">${escHtml(bet.note || "Balance adjustment")}</div>
              <div class="history-row-detail">${timeAgo(bet.timestamp)}</div>
            </div>
          </div>
          <div class="history-cf">${cashflow}</div>
        </div>`;
    }

    const market     = allMarkets[bet.marketId];
    const isResolved = market && market.status === "resolved";
    const won        = isResolved && Number(market.resolvedOptionIndex) === Number(bet.optionIndex);
    const lost       = isResolved && !won;
    const pending    = !isResolved;
    const isVoid     = !!bet.invalidated;

    let statusClass, statusText, cashflow;
    if (isVoid) {
      totalLost += bet.amount;
      statusClass = "history-status-void";
      statusText  = "Voided";
      cashflow    = `<span class="history-cf-loss">-$${bet.amount.toLocaleString()}</span>`;
    } else if (pending) {
      statusClass = "history-status-pending";
      statusText  = "Open";
      cashflow    = `<span class="history-cf-neutral">-$${bet.amount.toLocaleString()}</span>`;
    } else if (won) {
      totalWon += bet.payout;
      statusClass = "history-status-won";
      statusText  = "Won";
      cashflow    = `<span class="history-cf-win">+$${bet.payout.toLocaleString()}</span>`;
    } else {
      totalLost += bet.amount;
      statusClass = "history-status-lost";
      statusText  = "Lost";
      cashflow    = `<span class="history-cf-loss">-$${bet.amount.toLocaleString()}</span>`;
    }

    const title  = escHtml((bet.marketTitle || "Unknown market").slice(0, 50));
    const amount = (bet.amount ?? 0).toLocaleString();
    const payout = (bet.payout ?? 0).toLocaleString();
    return `
      <div class="history-row">
        <div class="history-row-main">
          <span class="history-status-pill ${statusClass}">${statusText}</span>
          <div class="history-row-info">
            <div class="history-row-title">${title}</div>
            <div class="history-row-detail">${escHtml(bet.option)} · $${amount} bet · $${payout} to win · ${timeAgo(bet.timestamp)}</div>
          </div>
        </div>
        <div class="history-cf">${cashflow}</div>
      </div>`;
  }).join("");

  const net = totalWon - totalLost;
  subtitleEl.innerHTML = `${myBets.length} trades · Net: <strong style="color:${net >= 0 ? 'var(--yes)' : 'var(--no)'}">${net >= 0 ? '+' : ''}$${net.toLocaleString()}</strong>`;
  listEl.innerHTML = rows;
}

// ─── LEADERBOARD ─────────────────────────────────────────────
function renderLeaderboard() {
  const listEl = document.getElementById("leaderboard-list");
  if (!listEl) return;
  const entries = Object.entries(usersMap)
    .sort((a, b) => (b[1].balance ?? 0) - (a[1].balance ?? 0))
    .slice(0, 20);
  if (entries.length === 0) {
    listEl.innerHTML = `<div class="history-empty">No players yet.</div>`;
    return;
  }
  listEl.innerHTML = entries.map(([uid, u], i) => {
    const isMe = uid === user.id;
    const avatarEl = u.avatar
      ? `<div class="leaderboard-avatar has-image" style="background-image:url(${u.avatar})"></div>`
      : `<div class="leaderboard-avatar">${getInitials(u.name || "?")}</div>`;
    const bal = (u.balance ?? 0).toLocaleString();
    return `
      <div class="leaderboard-row${isMe ? " is-me" : ""}">
        <div class="leaderboard-rank">${i + 1}</div>
        ${avatarEl}
        <div class="leaderboard-name">${escHtml(u.name || "Unknown")}${isMe ? " (you)" : ""}</div>
        <div class="leaderboard-balance">$${bal}</div>
      </div>`;
  }).join("");
}


// ─── REACTIONS ────────────────────────────────────────────────
function subscribeToReactions() {
  onValue(ref(db, "reactions"), (snap) => {
    allReactions = snap.val() || {};
    renderActivityFeed();
  });
}

window.toggleReaction = async function(betKey, emoji) {
  if (!user.id) return;
  try {
    const path = ref(db, `reactions/${betKey}/${emoji}/${user.id}`);
    const snap = await get(path);
    if (snap.exists()) {
      await remove(path);
    } else {
      await update(ref(db, `reactions/${betKey}/${emoji}`), { [user.id]: true });
    }
  } catch (err) {
    console.error("toggleReaction failed:", err);
  }
};


// ─── INIT ─────────────────────────────────────────────────────
initUser();
