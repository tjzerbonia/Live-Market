// ============================================================
//  FORECAST MARKETS — admin.js
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, push, onValue, update, remove, set, get
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const ADMIN_PASSWORD = "forecast2025";
const MAX_OPTIONS = 5;

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

let allMarkets = {};
let allPlayers = {};
let currentFilter = "open";
const SESSION_KEY = "forecast_admin_auth";

// ─── AUTH ─────────────────────────────────────────────────────
function checkSession() {
  return sessionStorage.getItem(SESSION_KEY) === "1";
}

function showAdmin() {
  document.getElementById("auth-overlay").classList.add("hidden");
  document.getElementById("admin-ui").classList.remove("hidden");
  subscribeToMarkets();
  subscribeToPlayers();

  document.getElementById("clear-trades-btn").addEventListener("click", async () => {
    if (!confirm("Clear all recent trades from the activity feed? This cannot be undone.")) return;
    await remove(ref(db, "bets"));
    showToast("All trades cleared.");
  });

  document.getElementById("reset-all-btn").addEventListener("click", async () => {
    if (!confirm("Reset ALL player balances to $1,000?")) return;
    const resetTime = Date.now();
    const updates = { "config/balance_reset_at": resetTime };
    Object.keys(allPlayers).forEach(id => {
      updates[`users/${id}/balance`] = 1000;
    });
    await update(ref(db), updates);
    showToast("All balances reset to $1,000.");
  });
}

document.addEventListener("DOMContentLoaded", () => {

if (checkSession()) {
  showAdmin();
} else {
  const pwInput = document.getElementById("password-input");
  const pwBtn   = document.getElementById("password-submit");
  const pwError = document.getElementById("auth-error");

  pwInput.addEventListener("keydown", (e) => { if (e.key === "Enter") attemptLogin(); });
  pwBtn.addEventListener("click", attemptLogin);

  function attemptLogin() {
    if (pwInput.value === ADMIN_PASSWORD) {
      sessionStorage.setItem(SESSION_KEY, "1");
      pwError.classList.add("hidden");
      showAdmin();
    } else {
      pwError.classList.remove("hidden");
      pwInput.value = "";
      pwInput.focus();
    }
  }
}

document.getElementById("logout-btn").addEventListener("click", () => {
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
});

}); // end DOMContentLoaded

// ─── OPTION MANAGEMENT ────────────────────────────────────────
window.addOption = function() {
  const list = document.getElementById("options-list");
  const rows = list.querySelectorAll(".option-row");
  if (rows.length >= MAX_OPTIONS) return;

  const idx = rows.length;
  const div = document.createElement("div");
  div.className = "option-row";
  div.dataset.index = idx;
  div.innerHTML = `
    <input type="text" class="opt-name" placeholder="Option ${idx + 1}" maxlength="40" />
    <input type="number" class="opt-prob" placeholder="%" min="1" max="98" value="0" />
    <button class="option-remove-btn" onclick="removeOption(this)">Remove</button>
  `;
  div.querySelectorAll("input").forEach(inp => inp.addEventListener("input", updateProbSum));
  list.appendChild(div);
  updateAddBtn();
  updateProbSum();
};

window.removeOption = function(btn) {
  const list = document.getElementById("options-list");
  if (list.querySelectorAll(".option-row").length <= 2) return;
  btn.closest(".option-row").remove();
  updateAddBtn();
  updateProbSum();
};

function updateAddBtn() {
  const count = document.getElementById("options-list").querySelectorAll(".option-row").length;
  document.getElementById("option-add-btn").disabled = count >= MAX_OPTIONS;
}

function updateProbSum() {
  const sum = Array.from(document.querySelectorAll(".opt-prob"))
    .reduce((s, el) => s + (parseFloat(el.value) || 0), 0);
  const el = document.getElementById("prob-sum-display");
  el.textContent = `Sum: ${Math.round(sum)}%`;
  el.classList.toggle("invalid", Math.abs(sum - 100) > 1);
}

// Wire up initial inputs
document.querySelectorAll(".opt-prob, .opt-name").forEach(inp => {
  inp.addEventListener("input", updateProbSum);
});

// ─── FIREBASE SUBSCRIPTION ────────────────────────────────────
function subscribeToMarkets() {
  onValue(ref(db, "markets"), (snap) => {
    allMarkets = snap.val() || {};
    renderMarketList();
  });
}

// ─── FILTER ───────────────────────────────────────────────────
window.filterMarkets = function(filter) {
  currentFilter = filter;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  event.target.classList.add("active");
  renderMarketList();
};

// ─── RENDER LIST ──────────────────────────────────────────────
function renderMarketList() {
  const container = document.getElementById("admin-market-list");
  let entries = Object.entries(allMarkets);

  if (currentFilter === "open") {
    entries = entries.filter(([, m]) => m.status === "open");
  } else if (currentFilter === "closed") {
    entries = entries.filter(([, m]) => m.status === "closed" || m.status === "resolved");
  }
  entries.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  if (entries.length === 0) {
    container.innerHTML = `<div class="list-empty">No ${currentFilter === "all" ? "" : currentFilter + " "}markets.</div>`;
    return;
  }

  container.innerHTML = entries.map(([id, m]) => {
    const isOpen     = m.status === "open";
    const isResolved = m.status === "resolved";
    const options = m.options || ["YES", "NO"];
    const statusLabel = isOpen ? "Open" : isResolved ? "Resolved" : "Closed";
    const statusClass = isOpen ? "open" : isResolved ? "resolved" : "closed";
    return `
      <div class="admin-market-row ${isOpen ? "" : "closed"}" data-id="${id}">
        <div>
          <div class="admin-market-meta">
            <span class="admin-market-category">${m.category || "General"}</span>
            <span class="market-status-pill ${statusClass}">${statusLabel}</span>
            ${isResolved ? `<span class="resolved-winner-pill">Winner: ${m.resolvedOption}</span>` : ""}
          </div>
          <div class="admin-market-title">${m.title}</div>
          <div class="admin-market-stats">
            ${options.join(" / ")}
            · Vol: $${(m.volume || 0).toLocaleString()}
            ${m.closeDate ? `· Closes ${m.closeDate}` : ""}
          </div>
        </div>
        <div class="admin-market-actions">
          ${!isResolved ? `<button class="admin-action-btn edit" onclick="startEdit('${id}')">Edit</button>` : ""}
          ${isOpen
            ? `<button class="admin-action-btn close-market" onclick="setStatus('${id}','closed')">Close</button>`
            : !isResolved
              ? `<button class="admin-action-btn reopen" onclick="setStatus('${id}','open')">Reopen</button>
                 <button class="admin-action-btn resolve" onclick="showResolveOptions('${id}')">Resolve</button>`
              : ""
          }
          <button class="admin-action-btn delete" onclick="deleteMarket('${id}')">Delete</button>
        </div>
      </div>`;
  }).join("");
}

// ─── CREATE / EDIT ────────────────────────────────────────────
window.saveMarket = async function() {
  const id       = document.getElementById("edit-market-id").value.trim();
  const title    = document.getElementById("f-title").value.trim();
  const category = document.getElementById("f-category").value.trim();
  const closeDate = document.getElementById("f-closedate").value;

  const options = [], baseProbs = [];
  document.querySelectorAll(".option-row").forEach(row => {
    const name = row.querySelector(".opt-name").value.trim();
    const prob = parseFloat(row.querySelector(".opt-prob").value) || 0;
    if (name) { options.push(name); baseProbs.push(prob); }
  });

  if (!title) { alert("Title is required."); return; }
  if (options.length < 2) { alert("At least 2 options are required."); return; }
  const sum = baseProbs.reduce((s, p) => s + p, 0);
  if (Math.abs(sum - 100) > 1) {
    alert(`Probabilities must sum to 100% (currently ${sum.toFixed(1)}%).`);
    return;
  }

  const btn = document.getElementById("save-market-btn");
  btn.disabled = true;
  btn.textContent = "Saving...";

  const data = { title, category: category || "General", options, baseProbs, closeDate: closeDate || null, status: "open" };

  if (id) {
    const existing = allMarkets[id] || {};
    await update(ref(db, `markets/${id}`), {
      ...data,
      volume: existing.volume || 0,
      createdAt: existing.createdAt || Date.now(),
    });
  } else {
    await push(ref(db, "markets"), { ...data, volume: 0, createdAt: Date.now() });
  }

  resetForm();
  btn.disabled = false;
  btn.textContent = id ? "Save Changes" : "Create Market";
  showToast(id ? "Market updated." : "Market created.");
};

window.startEdit = function(id) {
  const m = allMarkets[id];
  if (!m) return;

  document.getElementById("edit-market-id").value = id;
  document.getElementById("f-title").value = m.title;
  document.getElementById("f-category").value = m.category || "";
  document.getElementById("f-closedate").value = m.closeDate || "";

  const options   = m.options   || ["YES", "NO"];
  const baseProbs = m.baseProbs || [50, 50];
  const list = document.getElementById("options-list");
  list.innerHTML = "";

  options.forEach((opt, i) => {
    const div = document.createElement("div");
    div.className = "option-row";
    div.dataset.index = i;
    div.innerHTML = `
      <input type="text" class="opt-name" value="${opt}" maxlength="40" />
      <input type="number" class="opt-prob" min="1" max="98" value="${baseProbs[i] || 0}" />
      ${options.length > 2 ? `<button class="option-remove-btn" onclick="removeOption(this)">Remove</button>` : `<span></span>`}
    `;
    div.querySelectorAll("input").forEach(inp => inp.addEventListener("input", updateProbSum));
    list.appendChild(div);
  });

  updateAddBtn();
  updateProbSum();
  document.getElementById("form-heading").textContent = "Edit Market";
  document.getElementById("save-market-btn").textContent = "Save Changes";
  document.getElementById("cancel-edit-btn").classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
};

window.cancelEdit = function() { resetForm(); };

function resetForm() {
  document.getElementById("edit-market-id").value = "";
  document.getElementById("f-title").value = "";
  document.getElementById("f-category").value = "";
  document.getElementById("f-closedate").value = "";

  document.getElementById("options-list").innerHTML = `
    <div class="option-row" data-index="0">
      <input type="text" class="opt-name" placeholder="Option name" value="YES" maxlength="40" />
      <input type="number" class="opt-prob" placeholder="%" min="1" max="98" value="50" />
      <span></span>
    </div>
    <div class="option-row" data-index="1">
      <input type="text" class="opt-name" placeholder="Option name" value="NO" maxlength="40" />
      <input type="number" class="opt-prob" placeholder="%" min="1" max="98" value="50" />
      <span></span>
    </div>`;
  document.getElementById("options-list").querySelectorAll("input").forEach(inp => {
    inp.addEventListener("input", updateProbSum);
  });

  document.getElementById("form-heading").textContent = "New Market";
  document.getElementById("save-market-btn").textContent = "Create Market";
  document.getElementById("cancel-edit-btn").classList.add("hidden");
  updateAddBtn();
  updateProbSum();
}

// ─── PLAYERS ──────────────────────────────────────────────────
function subscribeToPlayers() {
  onValue(ref(db, "users"), (snap) => {
    const data = snap.val() || {};
    allPlayers = data;
    const container = document.getElementById("admin-player-list");
    const players = Object.entries(data).sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0));

    if (players.length === 0) {
      container.innerHTML = `<div class="list-empty">No players yet.</div>`;
      return;
    }

    container.innerHTML = players.map(([id, p]) => {
      const bal = p.balance ?? 1000;
      const balClass = bal < 0 ? "negative" : "positive";
      const seen = p.lastSeen ? timeAgo(p.lastSeen) : "never";
      return `
        <div class="admin-player-row" data-uid="${id}" data-name="${(p.name||"Unknown").replace(/"/g,"&quot;")}">
          <div class="player-name">${p.name || "Unknown"}</div>
          <div class="player-balance ${balClass}">$${bal.toLocaleString()}</div>
          <div class="player-seen">active ${seen}</div>
          <button class="player-reset-btn" data-uid="${id}">Reset</button>
          <button class="player-delete-btn" data-uid="${id}">Delete</button>
        </div>`;
    }).join("");

    // Attach events after render to avoid onclick escaping issues
    container.querySelectorAll(".player-reset-btn").forEach(btn => {
      btn.addEventListener("click", () => resetUser(btn.dataset.uid));
    });
    container.querySelectorAll(".player-delete-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".admin-player-row");
        deleteUser(btn.dataset.uid, row.dataset.name);
      });
    });
  });
}

function timeAgo(ts) {
  if (!ts) return "never";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

window.resetUser = async function(userId) {
  await Promise.all([
    set(ref(db, `config/user_resets/${userId}`), Date.now()),
    update(ref(db, `users/${userId}`), { balance: 1000 }),
  ]);
  showToast("Balance reset to $1,000.");
};

window.deleteUser = async function(userId, name) {
  if (!confirm(`Delete player "${name}"? They will be prompted to pick a new name on next load.`)) return;
  await remove(ref(db, `users/${userId}`));
  await remove(ref(db, `config/user_resets/${userId}`));
  showToast(`${name} deleted.`);
};


// ─── RESOLVE ──────────────────────────────────────────────────
window.showResolveOptions = function(id) {
  // Toggle picker off if already open
  const existing = document.getElementById(`resolve-picker-${id}`);
  if (existing) { existing.remove(); return; }

  const m = allMarkets[id];
  if (!m) return;
  const options = m.options || ["YES", "NO"];

  const picker = document.createElement("div");
  picker.id = `resolve-picker-${id}`;
  picker.className = "resolve-picker";
  picker.innerHTML = `
    <div class="resolve-picker-label">Which option won?</div>
    <div class="resolve-picker-options">
      ${options.map((opt, i) => `<button class="resolve-option-btn" data-id="${id}" data-idx="${i}">${opt}</button>`).join("")}
    </div>
    <button class="resolve-cancel-btn" onclick="document.getElementById('resolve-picker-${id}').remove()">Cancel</button>
  `;
  picker.querySelectorAll(".resolve-option-btn").forEach(btn => {
    btn.addEventListener("click", () => resolveMarket(btn.dataset.id, parseInt(btn.dataset.idx, 10)));
  });

  // Insert picker after the market row
  const row = document.querySelector(`.admin-market-row[data-id="${id}"]`);
  if (row) row.after(picker);
};

window.resolveMarket = async function(id, winningIndex) {
  const m = allMarkets[id];
  if (!m) return;
  const options = m.options || ["YES", "NO"];
  const winner  = options[winningIndex];

  if (!confirm(`Resolve "${m.title}"\n\nWinner: "${winner}"\n\nThis will pay out all winning bets. Cannot be undone.`)) return;

  const picker = document.getElementById(`resolve-picker-${id}`);
  if (picker) picker.remove();

  // Read all bets
  const betsSnap = await get(ref(db, "bets"));
  const allBets  = betsSnap.val() || {};

  // Tally payouts per user
  const payouts = {};
  Object.values(allBets).forEach(bet => {
    if (bet.marketId !== id) return;
    if (bet.optionIndex !== winningIndex) return;
    payouts[bet.userId] = (payouts[bet.userId] || 0) + (bet.payout || 0);
  });

  const updates = {};

  // Credit each winner's balance in Firebase
  for (const [userId, payout] of Object.entries(payouts)) {
    const balSnap = await get(ref(db, `users/${userId}/balance`));
    const cur     = balSnap.val() ?? 1000;
    updates[`users/${userId}/balance`] = cur + payout;
  }

  // Mark market resolved
  updates[`markets/${id}/status`]              = "resolved";
  updates[`markets/${id}/resolvedOption`]      = winner;
  updates[`markets/${id}/resolvedOptionIndex`] = winningIndex;
  updates[`markets/${id}/resolvedAt`]          = Date.now();

  await update(ref(db), updates);

  const count = Object.keys(payouts).length;
  const total = Object.values(payouts).reduce((s, p) => s + p, 0);
  showToast(`Resolved: "${winner}" wins. $${total.toLocaleString()} paid to ${count} player(s).`);
};

// ─── STATUS / DELETE ──────────────────────────────────────────
window.setStatus = async function(id, status) {
  await update(ref(db, `markets/${id}`), { status });
  showToast(status === "open" ? "Market reopened." : "Market closed.");
};

window.deleteMarket = async function(id) {
  const m = allMarkets[id];
  if (!m) return;
  if (!confirm(`Delete "${m.title}"? This cannot be undone.`)) return;
  await remove(ref(db, `markets/${id}`));
  showToast("Market deleted.");
};

// ─── TOAST ────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
