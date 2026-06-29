// ============================================================
//  SPORTSBOOK — sportsbook.js
//  Reuses the Firebase app already initialized by app.js.
// ============================================================
// Firebase rules note: /sb_markets, /sb_bets, and /parlays
// need ".write": true in your Firebase Realtime Database rules.

import { getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, onValue, push, update, get, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const db = getDatabase(getApp());

// ─── STATE ────────────────────────────────────────────────────
let allSbMarkets = {};
let parlayLegs   = [];   // [{ marketId, marketTitle, side, odds, subtype, sideLabel }]
let sbFilter     = "open"; // "open" | "closed" | "all"

// ─── ODDS HELPERS ─────────────────────────────────────────────
function americanToDecimal(odds) {
  if (odds < 0) return 1 + (100 / Math.abs(odds));
  return 1 + (odds / 100);
}

function fmtOdds(odds) {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function oddsClass(odds) {
  if (odds < 0) return "negative";
  if (odds > 0) return "positive";
  return "even";
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── USER HELPERS ─────────────────────────────────────────────
function getCurrentUser() {
  // Prefer window.user set by app.js; fall back to localStorage
  if (window.user && window.user.id) return window.user;
  try {
    const stored = localStorage.getItem("forecast_user");
    return stored ? JSON.parse(stored) : null;
  } catch (_) { return null; }
}

function showSbToast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─── FILTER ───────────────────────────────────────────────────
window.setSbFilter = function(filter) {
  sbFilter = filter;
  document.querySelectorAll("[data-sbfilter]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.sbfilter === filter);
  });
  renderSbMarkets();
};

// ─── RENDER MARKETS ───────────────────────────────────────────
window.renderSbMarkets = function() {
  const grid = document.getElementById("sb-markets-grid");
  if (!grid) return;

  let entries = Object.entries(allSbMarkets);

  if (sbFilter === "open") {
    entries = entries.filter(([, m]) => m.status === "open");
  } else if (sbFilter === "closed") {
    entries = entries.filter(([, m]) => m.status === "closed");
  }

  // Open first, then by createdAt desc
  entries.sort((a, b) => {
    const statusOrder = { open: 0, closed: 1 };
    const sd = (statusOrder[a[1].status] ?? 1) - (statusOrder[b[1].status] ?? 1);
    if (sd !== 0) return sd;
    return (b[1].createdAt || 0) - (a[1].createdAt || 0);
  });

  if (entries.length === 0) {
    grid.innerHTML = `<div style="color:var(--text-dim);font-size:.875rem;padding:2rem 0;">No sportsbook markets yet.</div>`;
    return;
  }

  grid.innerHTML = entries.map(([id, m]) => buildSbCard(id, m)).join("");
};

function buildSbCard(id, m) {
  const isOpen     = m.status === "open";
  const isResolved = m.status === "resolved";
  const subtype    = m.subtype || "moneyline";
  const statusLabel = isOpen ? "Open" : isResolved ? "Resolved" : "Closed";
  const statusBadge = `<span class="sb-status-badge ${isOpen ? "open" : isResolved ? "resolved" : "closed"}">${statusLabel}</span>`;
  const winnerBadge = isResolved && m.resolvedLabel
    ? `<span class="sb-winner-badge">Winner: ${escHtml(m.resolvedLabel)}</span>`
    : "";
  const disabledAttr = isOpen ? "" : "disabled";

  // Determine which side is in the parlay (for visual feedback)
  const addedLeg  = parlayLegs.find(l => l.marketId === id);
  const addedSide = addedLeg ? addedLeg.side : null;

  // Helper: parlay button for a given side key + short label
  function parlayBtn(side, shortLabel) {
    if (!isOpen) return "";
    const isAdded  = addedSide === side;
    const disabled = isAdded || (addedSide && addedSide !== side) ? "disabled" : "";
    const label    = isAdded ? "Added" : `+ ${shortLabel}`;
    return `<button class="sb-parlay-btn${isAdded ? " added" : ""}" onclick="addToParlay('${id}','${side}')" ${disabled}>${label}</button>`;
  }

  let sidesHtml = "";
  let parlayBtnHtml = "";

  if (subtype === "total") {
    const line      = m.line ?? "";
    const overOdds  = m.overOdds  ?? -110;
    const underOdds = m.underOdds ?? -110;

    sidesHtml = `
      <button class="sb-side-btn${addedSide === "over" ? " selected" : ""}" onclick="sbOpenBet('${id}','over')" ${disabledAttr}>
        <span class="sb-side-label">Over</span>
        <span class="sb-side-spread">${escHtml(String(line))}</span>
        <span class="sb-side-odds ${oddsClass(overOdds)}">${fmtOdds(overOdds)}</span>
      </button>
      <button class="sb-side-btn${addedSide === "under" ? " selected" : ""}" onclick="sbOpenBet('${id}','under')" ${disabledAttr}>
        <span class="sb-side-label">Under</span>
        <span class="sb-side-spread">${escHtml(String(line))}</span>
        <span class="sb-side-odds ${oddsClass(underOdds)}">${fmtOdds(underOdds)}</span>
      </button>`;
    parlayBtnHtml = `<div class="sb-parlay-pair">
      ${parlayBtn("over", "Over")}
      ${parlayBtn("under", "Under")}
    </div>`;
  } else {
    // moneyline or spread
    const sideA  = m.sideA || {};
    const sideB  = m.sideB || {};
    const oddsA  = sideA.odds ?? -110;
    const oddsB  = sideB.odds ?? -110;
    const labelA = sideA.label || "Side A";
    const labelB = sideB.label || "Side B";
    // Truncate label for the parlay button so it fits
    const shortA = labelA.split(" ")[0];
    const shortB = labelB.split(" ")[0];

    sidesHtml = `
      <button class="sb-side-btn${addedSide === "A" ? " selected" : ""}" onclick="sbOpenBet('${id}','A')" ${disabledAttr}>
        <span class="sb-side-label">${escHtml(labelA)}</span>
        <span class="sb-side-spread">${subtype === "spread" && sideA.spread ? escHtml(String(sideA.spread)) : ""}</span>
        <span class="sb-side-odds ${oddsClass(oddsA)}">${fmtOdds(oddsA)}</span>
      </button>
      <button class="sb-side-btn${addedSide === "B" ? " selected" : ""}" onclick="sbOpenBet('${id}','B')" ${disabledAttr}>
        <span class="sb-side-label">${escHtml(labelB)}</span>
        <span class="sb-side-spread">${subtype === "spread" && sideB.spread ? escHtml(String(sideB.spread)) : ""}</span>
        <span class="sb-side-odds ${oddsClass(oddsB)}">${fmtOdds(oddsB)}</span>
      </button>`;
    parlayBtnHtml = `<div class="sb-parlay-pair">
      ${parlayBtn("A", shortA)}
      ${parlayBtn("B", shortB)}
    </div>`;
  }

  return `
    <div class="sb-card${isOpen ? "" : " closed"}">
      <div class="sb-card-header">
        <span class="sb-category">${escHtml(m.category || "General")}</span>
        ${statusBadge}
      </div>
      <div class="sb-card-title">${escHtml(m.title || "")}</div>
      ${winnerBadge}
      <div class="sb-sides">
        ${sidesHtml}
      </div>
      <div class="sb-card-footer">
        <span class="sb-vol">Vol: $${(m.volume || 0).toLocaleString()}</span>
        ${parlayBtnHtml}
      </div>
    </div>`;
}

// ─── SINGLE BET MODAL ─────────────────────────────────────────
let activeSbBet = { marketId: null, side: null, odds: 0 };

window.sbOpenBet = function(marketId, side) {
  const user = getCurrentUser();
  if (!user || !user.id) { showSbToast("Please set your name first."); return; }

  const m = allSbMarkets[marketId];
  if (!m || m.status !== "open") return;

  activeSbBet.marketId = marketId;
  activeSbBet.side = side;

  let sideLabel = side;
  let odds = -110;
  const subtype = m.subtype || "moneyline";

  if (subtype === "total") {
    if (side === "over") {
      sideLabel = `Over ${m.line ?? ""}`;
      odds = m.overOdds ?? -110;
    } else {
      sideLabel = `Under ${m.line ?? ""}`;
      odds = m.underOdds ?? -110;
    }
  } else {
    if (side === "A") {
      sideLabel = m.sideA?.label || "Side A";
      odds = m.sideA?.odds ?? -110;
    } else {
      sideLabel = m.sideB?.label || "Side B";
      odds = m.sideB?.odds ?? -110;
    }
  }
  activeSbBet.odds = odds;

  // Populate modal
  document.getElementById("sb-bet-category").textContent  = m.category || "";
  document.getElementById("sb-bet-title").textContent     = m.title || "";
  document.getElementById("sb-bet-side-label").textContent = sideLabel;
  document.getElementById("sb-bet-odds-display").textContent = fmtOdds(odds);
  document.getElementById("sb-bet-amount").value = "";
  document.getElementById("sb-payout-display").innerHTML = "Enter an amount to see payout";

  document.getElementById("sb-bet-overlay").classList.remove("hidden");
  document.getElementById("sb-bet-amount").focus();
};

window.closeSbBetModal = function() {
  document.getElementById("sb-bet-overlay").classList.add("hidden");
  activeSbBet = { marketId: null, side: null, odds: 0 };
};

function updateSbPayoutDisplay() {
  const amt  = parseFloat(document.getElementById("sb-bet-amount").value) || 0;
  const el   = document.getElementById("sb-payout-display");
  if (amt <= 0) { el.innerHTML = "Enter an amount to see payout"; return; }
  const payout = (amt * americanToDecimal(activeSbBet.odds)).toFixed(2);
  const profit = (payout - amt).toFixed(2);
  el.innerHTML = `Win <strong>$${parseFloat(payout).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</strong> · Profit +$${parseFloat(profit).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}`;
}

window.placeSbBet = async function() {
  const user = getCurrentUser();
  if (!user || !user.id) return;
  if (!activeSbBet.marketId) return;

  const amtRaw = parseFloat(document.getElementById("sb-bet-amount").value);
  if (!amtRaw || amtRaw < 1) { document.getElementById("sb-bet-amount").focus(); return; }
  const amount = Math.floor(amtRaw);

  const m = allSbMarkets[activeSbBet.marketId];
  if (!m) return;

  // Read current balance from Firebase
  const balSnap = await get(ref(db, `users/${user.id}/balance`));
  const currentBalance = balSnap.val() ?? user.balance ?? 1000;

  const max = currentBalance + 1000;
  if (amount > max) { showSbToast(`Max bet is $${max.toLocaleString()}`); return; }

  const btn = document.getElementById("sb-place-bet-btn");
  btn.disabled = true;
  btn.textContent = "Placing...";

  const payout = Math.round(amount * americanToDecimal(activeSbBet.odds));
  const sideLabel = document.getElementById("sb-bet-side-label").textContent;
  const subtype   = m.subtype || "moneyline";

  const newBalance = currentBalance - amount;
  await update(ref(db, `users/${user.id}`), { balance: newBalance });

  // Update localStorage balance
  try {
    const stored = localStorage.getItem("forecast_user");
    if (stored) {
      const u = JSON.parse(stored);
      u.balance = newBalance;
      localStorage.setItem("forecast_user", JSON.stringify(u));
    }
  } catch (_) {}

  // Push sb_bet
  await push(ref(db, "sb_bets"), {
    userId:      user.id,
    userName:    user.name,
    marketId:    activeSbBet.marketId,
    marketTitle: m.title,
    subtype,
    side:        activeSbBet.side,
    sideLabel,
    odds:        activeSbBet.odds,
    amount,
    payout,
    isParlay:    false,
    timestamp:   serverTimestamp(),
  });

  // Update volume on sb_market
  await update(ref(db, `sb_markets/${activeSbBet.marketId}`), {
    volume: (m.volume || 0) + amount,
  });

  // Push to shared /bets activity feed
  await push(ref(db, "bets"), {
    userId:      user.id,
    userName:    user.name,
    marketId:    activeSbBet.marketId,
    marketTitle: m.title,
    option:      sideLabel,
    sbSide:      activeSbBet.side,
    amount,
    payout,
    timestamp:   serverTimestamp(),
    sbBet:       true,
  });

  // Refresh balance display in app.js if available
  if (typeof window.user !== "undefined" && window.user) {
    window.user.balance = newBalance;
  }
  const balEl = document.getElementById("user-balance");
  if (balEl) balEl.textContent = `$${newBalance.toLocaleString()}`;

  closeSbBetModal();
  showSbToast(`Bet placed: ${sideLabel} · $${amount.toLocaleString()} to win $${payout.toLocaleString()}`);

  btn.disabled = false;
  btn.textContent = "Place Bet";
};

// ─── PARLAY ───────────────────────────────────────────────────
window.addToParlay = function(marketId, side) {
  const user = getCurrentUser();
  if (!user || !user.id) { showSbToast("Please set your name first."); return; }

  const m = allSbMarkets[marketId];
  if (!m || m.status !== "open") return;

  // One leg per market
  if (parlayLegs.find(l => l.marketId === marketId)) {
    showSbToast("Already added this market to your parlay. Remove it first.");
    return;
  }

  if (parlayLegs.length >= 8) {
    showSbToast("Max 8 legs in a parlay.");
    return;
  }

  const subtype = m.subtype || "moneyline";
  let sideLabel = side;
  let odds = -110;

  if (subtype === "total") {
    if (side === "over") { sideLabel = `Over ${m.line ?? ""}`; odds = m.overOdds ?? -110; }
    else                 { sideLabel = `Under ${m.line ?? ""}`; odds = m.underOdds ?? -110; }
  } else {
    if (side === "A") { sideLabel = m.sideA?.label || "Side A"; odds = m.sideA?.odds ?? -110; }
    else              { sideLabel = m.sideB?.label || "Side B"; odds = m.sideB?.odds ?? -110; }
  }

  parlayLegs.push({ marketId, marketTitle: m.title, side, sideLabel, odds, subtype });
  showSbToast(`Added to parlay: ${sideLabel}`);
  renderSbMarkets();
  renderParlaySlip();
};

window.removeParlayLeg = function(idx) {
  parlayLegs.splice(idx, 1);
  renderSbMarkets();
  renderParlaySlip();
};

window.clearParlay = function() {
  parlayLegs = [];
  renderSbMarkets();
  renderParlaySlip();
};

window.toggleParlaySlip = function() {
  const slip = document.getElementById("parlay-slip");
  if (!slip) return;
  slip.classList.toggle("collapsed");
};

function calcParlayMultiplier() {
  return parlayLegs.reduce((prod, leg) => prod * americanToDecimal(leg.odds), 1);
}

function renderParlaySlip() {
  const slip = document.getElementById("parlay-slip");
  if (!slip) return;

  const count = parlayLegs.length;
  document.getElementById("parlay-count").textContent = count;

  if (count === 0) {
    slip.classList.remove("visible");
    return;
  }
  slip.classList.add("visible");

  // Legs list
  const legsList = document.getElementById("parlay-legs-list");
  legsList.innerHTML = parlayLegs.map((leg, i) => `
    <div class="parlay-leg-row">
      <div class="parlay-leg-info">
        <div class="parlay-leg-title">${escHtml((leg.marketTitle || "").slice(0, 50))}</div>
        <div class="parlay-leg-side">${escHtml(leg.sideLabel)}</div>
      </div>
      <div class="parlay-leg-odds">${fmtOdds(leg.odds)}</div>
      <button class="parlay-remove-btn" onclick="removeParlayLeg(${i})" title="Remove">&#x2715;</button>
    </div>`).join("");

  // Combined odds display in tab
  const multiplier = calcParlayMultiplier();
  const tabOdds = document.getElementById("parlay-slip-odds-display");
  if (tabOdds) tabOdds.textContent = `${multiplier.toFixed(2)}x`;

  // Live payout update
  updateParlayPayout();
}

function updateParlayPayout() {
  const stakeEl = document.getElementById("parlay-stake");
  const payEl   = document.getElementById("parlay-payout-display");
  if (!stakeEl || !payEl) return;

  const stake = parseFloat(stakeEl.value) || 0;
  const mult  = calcParlayMultiplier();

  if (stake <= 0 || parlayLegs.length === 0) {
    payEl.innerHTML = "Enter stake to see potential payout";
    return;
  }

  const payout = (stake * mult).toFixed(2);
  const profit = (payout - stake).toFixed(2);
  payEl.innerHTML = `<strong>$${parseFloat(payout).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong> payout · +$${parseFloat(profit).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} profit · ${mult.toFixed(2)}x`;
}

window.placeParlayBet = async function() {
  const user = getCurrentUser();
  if (!user || !user.id) { showSbToast("Please log in first."); return; }

  if (parlayLegs.length < 2) { showSbToast("A parlay needs at least 2 legs."); return; }

  const stakeEl = document.getElementById("parlay-stake");
  const stake   = parseFloat(stakeEl.value);
  if (!stake || stake < 1) { stakeEl.focus(); showSbToast("Enter a stake amount."); return; }
  const amount = Math.floor(stake);

  // Read balance
  const balSnap = await get(ref(db, `users/${user.id}/balance`));
  const currentBalance = balSnap.val() ?? user.balance ?? 1000;

  const max = currentBalance + 1000;
  if (amount > max) { showSbToast(`Max bet is $${max.toLocaleString()}`); return; }

  const btn = document.getElementById("parlay-place-btn");
  btn.disabled = true;
  btn.textContent = "Placing...";

  const multiplier = calcParlayMultiplier();
  const payout     = Math.round(amount * multiplier);
  const newBalance = currentBalance - amount;

  await update(ref(db, `users/${user.id}`), { balance: newBalance });

  // Update localStorage
  try {
    const stored = localStorage.getItem("forecast_user");
    if (stored) {
      const u = JSON.parse(stored);
      u.balance = newBalance;
      localStorage.setItem("forecast_user", JSON.stringify(u));
    }
  } catch (_) {}

  // Push parlay record (save key so we can link it from /bets)
  const parlayRef = await push(ref(db, "parlays"), {
    userId:             user.id,
    userName:           user.name,
    legs:               parlayLegs.map(l => ({
      marketId:    l.marketId,
      marketTitle: l.marketTitle,
      side:        l.side,
      sideLabel:   l.sideLabel,
      odds:        l.odds,
    })),
    amount,
    combinedMultiplier: multiplier,
    payout,
    timestamp: serverTimestamp(),
  });

  // Push activity feed summary (with parlayId for history lookup)
  const legSummary = parlayLegs.map(l => l.sideLabel).join(", ");
  await push(ref(db, "bets"), {
    userId:      user.id,
    userName:    user.name,
    marketId:    "parlay",
    marketTitle: `Parlay (${parlayLegs.length} legs): ${legSummary.slice(0, 60)}`,
    option:      `${parlayLegs.length}-leg parlay`,
    parlayId:    parlayRef.key,
    amount,
    payout,
    timestamp:   serverTimestamp(),
    isParlay:    true,
  });

  // Refresh balance display
  if (typeof window.user !== "undefined" && window.user) {
    window.user.balance = newBalance;
  }
  const balEl = document.getElementById("user-balance");
  if (balEl) balEl.textContent = `$${newBalance.toLocaleString()}`;

  const legCount = parlayLegs.length; // capture before clear
  clearParlay();
  showSbToast(`${legCount}-leg parlay placed! $${amount} to win $${payout.toLocaleString()}`);
  btn.disabled = false;
  btn.textContent = "Place Parlay";
};

// ─── SUBSCRIBE ────────────────────────────────────────────────
function subscribeToSbMarkets() {
  onValue(ref(db, "sb_markets"), (snap) => {
    allSbMarkets = snap.val() || {};
    window.renderSbMarkets();
  });
}

// ─── INJECT PARLAY SLIP HTML ──────────────────────────────────
function injectParlaySlip() {
  if (document.getElementById("parlay-slip")) return; // already injected

  const slip = document.createElement("div");
  slip.id = "parlay-slip";
  slip.className = "parlay-slip collapsed";
  slip.innerHTML = `
    <div class="parlay-slip-tab" onclick="toggleParlaySlip()">
      <span>Parlay (<span id="parlay-count">0</span>)</span>
      <span class="parlay-slip-odds" id="parlay-slip-odds-display"></span>
    </div>
    <div class="parlay-slip-body">
      <div id="parlay-legs-list"></div>
      <div class="parlay-stake-row">
        <input type="number" id="parlay-stake" placeholder="Stake ($)" min="1" oninput="updateParlayPayout()" />
        <div class="parlay-payout-display" id="parlay-payout-display">Enter stake to see potential payout</div>
      </div>
      <div class="parlay-min-note">Min 2 legs · Max 8 legs</div>
      <div class="parlay-btn-row">
        <button id="parlay-place-btn" onclick="placeParlayBet()">Place Parlay</button>
        <button id="parlay-clear-btn" onclick="clearParlay()">Clear</button>
      </div>
    </div>`;
  document.body.appendChild(slip);
}

// ─── INJECT BET MODAL HTML ────────────────────────────────────
function injectSbBetModal() {
  if (document.getElementById("sb-bet-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "sb-bet-overlay";
  overlay.className = "sb-bet-overlay hidden";
  overlay.innerHTML = `
    <div class="sb-bet-modal">
      <button class="modal-close" onclick="closeSbBetModal()">&#x2715;</button>
      <div class="sb-modal-category" id="sb-bet-category"></div>
      <div class="sb-modal-title" id="sb-bet-title"></div>
      <div class="sb-modal-side-row">
        <span class="sb-modal-side-label" id="sb-bet-side-label"></span>
        <span class="sb-modal-odds" id="sb-bet-odds-display"></span>
      </div>
      <div class="sb-modal-amount-wrap">
        <span class="sb-modal-dollar">$</span>
        <input type="number" id="sb-bet-amount" placeholder="Enter amount" min="1"
          oninput="updateSbPayoutDisplay()" autocomplete="off" />
      </div>
      <div class="sb-payout-display" id="sb-payout-display">Enter an amount to see payout</div>
      <button id="sb-place-bet-btn" onclick="placeSbBet()">Place Bet</button>
    </div>`;

  // Close on backdrop click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeSbBetModal();
  });

  document.body.appendChild(overlay);
}

// ─── EXPOSE window functions ──────────────────────────────────
window.updateSbPayoutDisplay = updateSbPayoutDisplay;
window.updateParlayPayout    = updateParlayPayout;

// ─── INIT ─────────────────────────────────────────────────────
injectSbBetModal();
injectParlaySlip();
subscribeToSbMarkets();
