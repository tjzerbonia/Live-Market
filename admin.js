// ============================================================
//  FORECAST MARKETS — admin.js
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, push, onValue, update, remove, get
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

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

const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);
// Sign in anonymously immediately so all Firebase writes pass auth rules
signInAnonymously(auth).catch(e => console.warn("Admin Firebase auth:", e));

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
  subscribeToTradeLog();
  subscribeToSbMarkets();
  document.getElementById("export-csv-btn").addEventListener("click", exportTradeLog);

  document.getElementById("clear-trades-btn").addEventListener("click", async () => {
    if (!confirm("Clear all recent trades from the activity feed? This cannot be undone.")) return;
    const updates = {};
    Object.keys(allMarkets).forEach(id => {
      updates[`markets/${id}/volume`] = 0;
    });
    await Promise.all([
      remove(ref(db, "bets")),
      remove(ref(db, "market_history")),
      update(ref(db), updates),
    ]);
    showToast("All trades cleared and volumes reset.");
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

// Wire prob-sum listener on the initial static option rows in the HTML
document.querySelectorAll("#options-list .opt-prob, #options-list .opt-name").forEach(inp => {
  inp.addEventListener("input", updateProbSum);
});
updateProbSum();

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

// ─── FIREBASE SUBSCRIPTION ────────────────────────────────────
function subscribeToMarkets() {
  onValue(ref(db, "markets"), (snap) => {
    allMarkets = snap.val() || {};
    renderMarketList();
  });
}

// ─── CSV IMPORT ───────────────────────────────────────────────
// NOTE: CSV format: Title, Category, Close Date (YYYY-MM-DD), Close Time (HH:MM),
//       Option 1, Prob 1 (%), Option 2, Prob 2 (%), ..., Option 5, Prob 5 (%)

function parseCSVRow(row) {
  const cols = [];
  let cur = "", inQ = false;
  for (let ci = 0; ci < row.length; ci++) {
    const ch = row[ci];
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ""; }
    else { cur += ch; }
  }
  cols.push(cur.trim());
  return cols;
}

function parseCSVMarkets(text) {
  const lines = text.split(/\r?\n/);
  const parsed = [], skipped = [];
  lines.slice(1).filter(l => l.trim()).forEach((row, ri) => {
    const cols = parseCSVRow(row);
    const title = (cols[0] || "").replace(/^"|"$/g, "").trim();
    if (!title) return;
    const category = (cols[1] || "General").replace(/^"|"$/g, "").trim();
    const dateVal  = (cols[2] || "").replace(/^"|"$/g, "").trim();
    const timeVal  = (cols[3] || "00:00").replace(/^"|"$/g, "").trim();
    const closeDate = dateVal ? `${dateVal}T${timeVal || "00:00"}` : null;
    const options = [], baseProbs = [];
    for (let oi = 0; oi < 5; oi++) {
      const name = (cols[4 + oi * 2] || "").replace(/^"|"$/g, "").trim();
      const prob = parseFloat((cols[5 + oi * 2] || "").replace(/^"|"$/g, "")) || 0;
      if (name && prob > 0) { options.push(name); baseProbs.push(prob); }
    }
    if (options.length < 2) { skipped.push({ title, reason: "fewer than 2 options" }); return; }
    const sum = baseProbs.reduce((s, p) => s + p, 0);
    if (Math.abs(sum - 100) > 5) { skipped.push({ title, reason: `probs sum to ${Math.round(sum)}%` }); return; }
    parsed.push({ title, category, options, baseProbs, closeDate });
  });
  return { parsed, skipped };
}

window.importCSV = function() {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".csv,text/csv";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);
  fileInput.click();
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) { fileInput.remove(); return; }
    const text = await file.text();
    fileInput.remove();

    // Split rows by type: sportsbook rows vs prediction market rows
    const lines = text.split(/\r?\n/);
    const headerLine = lines[0];
    const dataLines  = lines.slice(1).filter(l => l.trim());

    const sbRows    = dataLines.filter(l => parseCSVRow(l)[0]?.toLowerCase() === "sportsbook");
    const pmRows    = dataLines.filter(l => parseCSVRow(l)[0]?.toLowerCase() !== "sportsbook");

    // Rebuild PM CSV with header so parseCSVMarkets can skip it
    const pmText = [headerLine, ...pmRows].join("\n");
    const { parsed, skipped } = parseCSVMarkets(pmText);

    // Parse sportsbook rows
    const sbParsed = [], sbSkipped = [];
    sbRows.forEach(row => {
      const cols = parseCSVRow(row);
      // sportsbook,Category,Title,Subtype,SideA_Label,SideA_Spread,SideA_Odds,SideB_Label,SideB_Spread,SideB_Odds,Line,OverOdds,UnderOdds
      const category = (cols[1] || "General").trim();
      const title    = (cols[2] || "").trim();
      const subtype  = (cols[3] || "moneyline").trim().toLowerCase();
      if (!title) return;

      const market = { type: "sportsbook", title, category, subtype, status: "open", volume: 0, createdAt: Date.now() };

      if (subtype === "total") {
        const line      = parseFloat(cols[10]) || 0;
        const overOdds  = parseInt(cols[11]) || -110;
        const underOdds = parseInt(cols[12]) || -110;
        market.line = line; market.overOdds = overOdds; market.underOdds = underOdds;
      } else {
        const sideALabel  = (cols[4] || "Side A").trim();
        const sideASpread = (cols[5] || "").trim();
        const sideAOdds   = parseInt(cols[6]) || -110;
        const sideBLabel  = (cols[7] || "Side B").trim();
        const sideBSpread = (cols[8] || "").trim();
        const sideBOdds   = parseInt(cols[9]) || -110;
        market.sideA = { label: sideALabel, odds: sideAOdds };
        market.sideB = { label: sideBLabel, odds: sideBOdds };
        if (subtype === "spread") {
          market.sideA.spread = sideASpread;
          market.sideB.spread = sideBSpread;
        }
      }
      sbParsed.push(market);
    });

    showCSVPreview(parsed, skipped, sbParsed, sbSkipped);
  });
};

function showCSVPreview(parsed, skipped, sbParsed = [], sbSkipped = []) {
  // Remove existing preview if any
  document.getElementById("csv-preview-modal")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "csv-preview-modal";
  overlay.className = "csv-preview-overlay";

  const totalReady = parsed.length + sbParsed.length;
  const totalSkipped = skipped.length + sbSkipped.length;

  const okRows = parsed.map(m => `
    <div class="csv-preview-row ok">
      <span class="csv-preview-title">${m.title}</span>
      <span class="csv-preview-meta">${m.category} · ${m.options.join(", ")} · ${m.closeDate ? "Closes " + m.closeDate.split("T")[0] : "No close date"}</span>
    </div>`).join("");

  const sbOkRows = sbParsed.map(m => `
    <div class="csv-preview-row ok">
      <span class="csv-preview-title">[SB] ${m.title}</span>
      <span class="csv-preview-meta">${m.category} · ${m.subtype}</span>
    </div>`).join("");

  const skipRows = [...skipped, ...sbSkipped].map(s => `
    <div class="csv-preview-row skip">
      <span class="csv-preview-title">⚠ ${s.title}</span>
      <span class="csv-preview-meta">${s.reason}</span>
    </div>`).join("");

  overlay.innerHTML = `
    <div class="csv-preview-panel">
      <div class="csv-preview-header">
        <h3>Import Preview</h3>
        <button class="modal-close" id="csv-close-btn">&#x2715;</button>
      </div>
      <div class="csv-preview-summary">
        <strong>${totalReady}</strong> market${totalReady !== 1 ? "s" : ""} ready to import
        ${totalSkipped ? `· <span style="color:#f59e0b">${totalSkipped} skipped</span>` : ""}
      </div>
      <div class="csv-preview-list">
        ${okRows}
        ${sbOkRows}
        ${skipRows}
      </div>
      <div class="csv-preview-actions">
        <button class="admin-action-btn" id="csv-cancel-btn">Cancel</button>
        <button class="admin-action-btn resolve" id="csv-confirm-btn" ${totalReady === 0 ? "disabled" : ""}>
          Import ${totalReady} Market${totalReady !== 1 ? "s" : ""}
        </button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  overlay.querySelector("#csv-close-btn").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#csv-cancel-btn").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#csv-confirm-btn").addEventListener("click", async () => {
    const btn = overlay.querySelector("#csv-confirm-btn");
    btn.disabled = true;
    btn.textContent = "Importing...";

    const pmImports = parsed.map(m => push(ref(db, "markets"), {
      ...m, status: "open", volume: 0, createdAt: Date.now(),
    }));
    const sbImports = sbParsed.map(m => push(ref(db, "sb_markets"), {
      ...m, status: "open", volume: 0, createdAt: Date.now(),
    }));

    await Promise.all([...pmImports, ...sbImports]);
    overlay.remove();
    showToast(`Imported ${totalReady} market${totalReady !== 1 ? "s" : ""} (${parsed.length} prediction, ${sbParsed.length} sportsbook).`);
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
    // Show open AND draft markets in the open tab
    entries = entries.filter(([, m]) => m.status === "open" || m.status === "draft");
  } else if (currentFilter === "closed") {
    entries = entries.filter(([, m]) => m.status === "closed" || m.status === "resolved");
  } else if (currentFilter === "archived") {
    entries = entries.filter(([, m]) => m.status === "archived");
  } else {
    // "all" — exclude archived so they don't clutter the main view
    entries = entries.filter(([, m]) => m.status !== "archived");
  }
  entries.sort((a, b) => {
    const ao = a[1].order != null ? a[1].order : (a[1].createdAt ?? 0);
    const bo = b[1].order != null ? b[1].order : (b[1].createdAt ?? 0);
    return ao - bo;
  });

  if (entries.length === 0) {
    container.innerHTML = `<div class="list-empty">No ${currentFilter} markets.</div>`;
    return;
  }

  container.innerHTML = entries.map(([id, m]) => {
    const isOpen     = m.status === "open";
    const isDraft    = m.status === "draft";
    const isResolved = m.status === "resolved";
    const isArchived = m.status === "archived";
    const isInteractive = isOpen || isDraft;
    const options = m.options || ["YES", "NO"];
    const statusLabel = isDraft ? "Draft" : isOpen ? "Open" : isResolved ? "Resolved" : isArchived ? "Archived" : "Closed";
    const statusClass = isDraft ? "draft" : isOpen ? "open" : isResolved ? "resolved" : isArchived ? "archived" : "closed";
    return `
      <div class="admin-market-row ${isInteractive ? "draggable-row" : "closed"}" data-id="${id}" ${isInteractive ? 'draggable="true"' : ""}>
        ${isInteractive ? `<div class="drag-handle" title="Drag to reorder">⠿</div>` : ""}
        <div>
          <div class="admin-market-meta">
            <span class="admin-market-category">${m.category || "General"}</span>
            <span class="market-status-pill ${statusClass}">${statusLabel}</span>
            ${isDraft && m.publishAt ? `<span class="resolved-winner-pill">Publishes ${formatCloseDate(new Date(m.publishAt).toISOString())}</span>` : ""}
            ${isResolved || isArchived ? `<span class="resolved-winner-pill">Winner: ${m.resolvedOption}</span>` : ""}
          </div>
          <div class="admin-market-title">${m.title}</div>
          <div class="admin-market-stats">
            ${options.length > 2
              ? `${options.length} options`
              : options.join(" / ")}
            · Vol: $${(m.volume || 0).toLocaleString()}
            ${m.closeDate ? `· Closes ${formatCloseDate(m.closeDate)}` : ""}
          </div>
        </div>
        <div class="admin-market-actions">
          ${isArchived
            ? `<button class="admin-action-btn reopen" onclick="setStatus('${id}','resolved')">Unarchive</button>`
            : !isInteractive
              ? `<button class="admin-action-btn archive" onclick="archiveMarket('${id}')">Archive</button>`
              : `<button class="admin-action-btn edit" onclick="startEdit('${id}')">Edit</button>`
          }
          ${isInteractive
            ? `<button class="admin-action-btn close-market" onclick="setStatus('${id}','closed')">Close</button>`
            : !isResolved && !isArchived
              ? `<button class="admin-action-btn reopen" onclick="setStatus('${id}','open')">Reopen</button>
                 <button class="admin-action-btn resolve" onclick="showResolveOptions('${id}')">Resolve</button>`
              : ""
          }
          <button class="admin-action-btn delete" onclick="deleteMarket('${id}')">Delete</button>
        </div>
      </div>`;
  }).join("");

  initDragSort(container, entries);
}

function initDragSort(container, entries) {
  let dragId = null;

  container.querySelectorAll(".draggable-row").forEach(row => {
    row.addEventListener("dragstart", (e) => {
      dragId = row.dataset.id;
      row.classList.add("drag-ghost");
      e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("drag-ghost");
      container.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (row.dataset.id === dragId) return;
      container.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
      row.classList.add("drag-over");
    });
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      const targetId = row.dataset.id;
      if (!dragId || dragId === targetId) return;
      row.classList.remove("drag-over");

      // Build current open order from DOM
      const openRows = [...container.querySelectorAll(".draggable-row")];
      const ids = openRows.map(r => r.dataset.id);
      const fromIdx = ids.indexOf(dragId);
      const toIdx   = ids.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return;

      ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, dragId);

      const updates = {};
      ids.forEach((id, i) => { updates[`markets/${id}/order`] = i * 10; });
      await update(ref(db), updates);
    });
  });
}


window.archiveMarket = async function(id) {
  await update(ref(db, `markets/${id}`), { status: "archived", archivedAt: Date.now() });
  showToast("Market archived — hidden from players.");
};

// ─── CREATE / EDIT ────────────────────────────────────────────
window.saveMarket = async function() {
  const id       = document.getElementById("edit-market-id").value.trim();
  const title    = document.getElementById("f-title").value.trim();
  const category = document.getElementById("f-category").value.trim();
  const dateVal = document.getElementById("f-closedate").value;
  const timeVal = document.getElementById("f-closetime").value;
  const closeDate = dateVal ? `${dateVal}T${timeVal || "00:00"}` : null;

  // Scheduled publish date
  const pubDateVal = document.getElementById("f-publishdate").value;
  const pubTimeVal = document.getElementById("f-publishtime").value;
  const publishAt = pubDateVal ? new Date(`${pubDateVal}T${pubTimeVal || "00:00"}`).getTime() : null;

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

  // If a future publish date is set, save as draft; otherwise open
  const status = (publishAt && publishAt > Date.now()) ? "draft" : "open";
  const data = {
    title, category: category || "General", options, baseProbs,
    closeDate: closeDate || null,
    status,
    ...(publishAt ? { publishAt } : {}),
  };

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
  showToast(id ? "Market updated." : (status === "draft" ? "Market saved as draft." : "Market created."));
};

window.startEdit = function(id) {
  const m = allMarkets[id];
  if (!m) return;

  document.getElementById("edit-market-id").value = id;
  document.getElementById("f-title").value = m.title;
  document.getElementById("f-category").value = m.category || "";
  const [cdDate, cdTime] = (m.closeDate || "").split("T");
  document.getElementById("f-closedate").value = cdDate || "";
  document.getElementById("f-closetime").value = cdTime || "";

  // Populate publish date if market is a draft
  if (m.publishAt) {
    const pubDate = new Date(m.publishAt);
    const yyyy = pubDate.getFullYear();
    const mm   = String(pubDate.getMonth() + 1).padStart(2, "0");
    const dd   = String(pubDate.getDate()).padStart(2, "0");
    const hh   = String(pubDate.getHours()).padStart(2, "0");
    const min  = String(pubDate.getMinutes()).padStart(2, "0");
    document.getElementById("f-publishdate").value = `${yyyy}-${mm}-${dd}`;
    document.getElementById("f-publishtime").value = `${hh}:${min}`;
  } else {
    document.getElementById("f-publishdate").value = "";
    document.getElementById("f-publishtime").value = "";
  }

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
  document.getElementById("f-closetime").value = "";
  document.getElementById("f-publishdate").value = "";
  document.getElementById("f-publishtime").value = "";

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
          <button class="player-trades-btn" data-uid="${id}">Trades</button>
          <button class="player-adjust-btn" data-uid="${id}">Adjust</button>
          <button class="player-merge-btn" data-uid="${id}">Merge</button>
          <button class="player-reset-btn" data-uid="${id}">Reset</button>
          <button class="player-delete-btn" data-uid="${id}">Delete</button>
        </div>`;
    }).join("");

    // Attach events after render to avoid onclick escaping issues
    container.querySelectorAll(".player-trades-btn").forEach(btn => {
      btn.addEventListener("click", () => showPlayerTrades(btn.dataset.uid));
    });
    container.querySelectorAll(".player-adjust-btn").forEach(btn => {
      btn.addEventListener("click", () => showAdjustPicker(btn.dataset.uid));
    });
    container.querySelectorAll(".player-merge-btn").forEach(btn => {
      btn.addEventListener("click", () => showMergePicker(btn.dataset.uid));
    });
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

function showMergePicker(keepId) {
  const existing = document.getElementById(`merge-picker-${keepId}`);
  if (existing) { existing.remove(); return; }

  const keepPlayer = allPlayers[keepId];
  const others = Object.entries(allPlayers).filter(([id]) => id !== keepId);

  const picker = document.createElement("div");
  picker.id = `merge-picker-${keepId}`;
  picker.className = "balance-adjust-picker";
  picker.innerHTML = `
    <span class="adjust-picker-label">Merge another account INTO <strong>${keepPlayer?.name || "this player"}</strong></span>
    <select class="merge-select">
      <option value="">— Select account to absorb —</option>
      ${others.map(([id, p]) => `<option value="${id}">${p.name || "Unknown"} ($${(p.balance ?? 1000).toLocaleString()})</option>`).join("")}
    </select>
    <div class="merge-hint">Their balance and bets will move to ${keepPlayer?.name || "this player"}. Their account is then deleted.</div>
    <div style="display:flex;gap:0.5rem;margin-top:0.25rem">
      <button class="admin-action-btn resolve merge-confirm-btn" disabled>Merge</button>
      <button class="admin-action-btn merge-cancel-btn">Cancel</button>
    </div>`;

  const row = document.querySelector(`.admin-player-row[data-uid="${keepId}"]`);
  if (row) row.after(picker);

  const select = picker.querySelector(".merge-select");
  const confirmBtn = picker.querySelector(".merge-confirm-btn");
  select.addEventListener("change", () => {
    confirmBtn.disabled = !select.value;
  });
  picker.querySelector(".merge-cancel-btn").addEventListener("click", () => picker.remove());
  confirmBtn.addEventListener("click", () => mergeUsers(keepId, select.value, picker));
}

async function mergeUsers(keepId, absorbId, picker) {
  const keepPlayer   = allPlayers[keepId];
  const absorbPlayer = allPlayers[absorbId];
  if (!keepPlayer || !absorbPlayer) return;
  if (!confirm(`Merge "${absorbPlayer.name}" INTO "${keepPlayer.name}"?\n\nThis combines balances, re-attributes all bets, and deletes "${absorbPlayer.name}". Cannot be undone.`)) return;

  const confirmBtn = picker.querySelector(".merge-confirm-btn");
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Merging...";

  // 1. Re-attribute all bets from absorbId to keepId
  const betsSnap = await get(ref(db, "bets"));
  const allBets  = betsSnap.val() || {};
  const betUpdates = {};
  Object.entries(allBets).forEach(([betKey, b]) => {
    if (b.userId === absorbId) {
      betUpdates[`bets/${betKey}/userId`]   = keepId;
      betUpdates[`bets/${betKey}/userName`] = keepPlayer.name;
    }
  });

  // 2. Combine balances
  const newBalance = (keepPlayer.balance ?? 1000) + (absorbPlayer.balance ?? 1000) - 1000;
  betUpdates[`users/${keepId}/balance`] = newBalance;

  // 3. Re-attribute reactions
  const reactionsSnap = await get(ref(db, "reactions"));
  const allReactionsData = reactionsSnap.val() || {};
  Object.entries(allReactionsData).forEach(([betKey, emojis]) => {
    Object.entries(emojis).forEach(([emojiKey, users]) => {
      if (users[absorbId]) {
        betUpdates[`reactions/${betKey}/${emojiKey}/${keepId}`]   = true;
        betUpdates[`reactions/${betKey}/${emojiKey}/${absorbId}`] = null;
      }
    });
  });

  await update(ref(db), betUpdates);
  await remove(ref(db, `users/${absorbId}`));
  await remove(ref(db, `config/user_resets/${absorbId}`));

  picker.remove();
  showToast(`Merged "${absorbPlayer.name}" into "${keepPlayer.name}". New balance: $${newBalance.toLocaleString()}.`);
}

function formatCloseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  if (isNaN(d)) return str;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function timeAgo(ts) {
  if (!ts) return "never";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

async function showPlayerTrades(userId) {
  const existing = document.getElementById(`trades-panel-${userId}`);
  if (existing) { existing.remove(); return; }

  const panel = document.createElement("div");
  panel.id = `trades-panel-${userId}`;
  panel.className = "player-trades-panel";
  panel.innerHTML = `<div class="player-trades-loading">Loading...</div>`;

  const row = document.querySelector(`.admin-player-row[data-uid="${userId}"]`);
  if (row) row.after(panel);

  const snap = await get(ref(db, "bets"));
  const allBets = snap.val() || {};

  const bets = Object.entries(allBets)
    .filter(([, b]) => b.userId === userId && b.marketId)
    .sort(([, a], [, b]) => (b.timestamp || 0) - (a.timestamp || 0));

  if (bets.length === 0) {
    panel.innerHTML = `<div class="player-trades-loading">No trades yet.</div>`;
    return;
  }

  panel.innerHTML = "";
  bets.forEach(([betKey, b]) => {
    const market = allMarkets[b.marketId];
    const isResolved = market?.status === "resolved";
    const won = isResolved && Number(market.resolvedOptionIndex) === Number(b.optionIndex);
    const lost = isResolved && !won;
    const isVoid = !!b.invalidated;
    const statusClass = isVoid ? "trade-status-void" : won ? "trade-status-won" : lost ? "trade-status-lost" : "trade-status-open";
    const statusText  = isVoid ? "Void" : won ? "Won" : lost ? "Lost" : "Open";
    const title = (b.marketTitle || "Unknown").slice(0, 35);

    const tradeEl = document.createElement("div");
    tradeEl.className = "player-trade-row";
    tradeEl.innerHTML = `
      <span class="player-trade-status ${statusClass}">${statusText}</span>
      <span class="player-trade-title">${title}</span>
      <span class="player-trade-option">${b.option || ""}</span>
      <span class="player-trade-amt">$${(b.amount || 0).toLocaleString()}</span>
      ${!isVoid ? `<button class="trade-invalidate-btn" data-key="${betKey}" data-amt="${b.amount || 0}" data-uid="${userId}">Void</button>` : ""}
    `;
    panel.appendChild(tradeEl);
  });

  panel.querySelectorAll(".trade-invalidate-btn").forEach(btn => {
    btn.addEventListener("click", () => invalidateBet(btn.dataset.key, btn.dataset.uid, Number(btn.dataset.amt)));
  });
}

function showAdjustPicker(userId) {
  // Toggle off if already open
  const existing = document.getElementById(`adjust-picker-${userId}`);
  if (existing) { existing.remove(); return; }

  const picker = document.createElement("div");
  picker.id = `adjust-picker-${userId}`;
  picker.className = "balance-adjust-picker";
  picker.innerHTML = `
    <span class="adjust-picker-label">Adjust balance</span>
    <div class="adjust-input-wrap">
      <span class="adjust-input-dollar">$</span>
      <input type="number" class="adjust-amount-input" placeholder="Amount" min="1" />
    </div>
    <button class="adjust-add-btn">+ Add</button>
    <button class="adjust-sub-btn">− Subtract</button>
    <button class="adjust-cancel-btn">Cancel</button>
    <div class="adjust-log-row">
      <label class="adjust-log-label">
        <input type="checkbox" class="adjust-log-check" />
        Show in player history
      </label>
      <input type="text" class="adjust-note-input hidden" placeholder="Reason (e.g. weekly bonus)" maxlength="80" />
    </div>
  `;

  const row = document.querySelector(`.admin-player-row[data-uid="${userId}"]`);
  const userName = row?.dataset.name || "Unknown";
  if (row) row.after(picker);

  const amtInput  = picker.querySelector(".adjust-amount-input");
  const logCheck  = picker.querySelector(".adjust-log-check");
  const noteInput = picker.querySelector(".adjust-note-input");

  logCheck.addEventListener("change", () => {
    noteInput.classList.toggle("hidden", !logCheck.checked);
    if (logCheck.checked) noteInput.focus();
  });

  picker.querySelector(".adjust-cancel-btn").addEventListener("click", () => picker.remove());

  picker.querySelector(".adjust-add-btn").addEventListener("click", () => {
    const amt = parseInt(amtInput.value, 10);
    if (!amt || amt < 1) { amtInput.focus(); return; }
    adjustBalance(userId, amt, userName, logCheck.checked, noteInput.value.trim());
    picker.remove();
  });

  picker.querySelector(".adjust-sub-btn").addEventListener("click", () => {
    const amt = parseInt(amtInput.value, 10);
    if (!amt || amt < 1) { amtInput.focus(); return; }
    adjustBalance(userId, -amt, userName, logCheck.checked, noteInput.value.trim());
    picker.remove();
  });

  amtInput.focus();
}

async function adjustBalance(userId, delta, userName, log, note) {
  const snap = await get(ref(db, `users/${userId}/balance`));
  const current = snap.val() ?? 1000;
  const next = current + delta;
  await update(ref(db, `users/${userId}`), { balance: next });

  if (log) {
    await push(ref(db, "bets"), {
      userId,
      userName,
      type: "admin_adjustment",
      delta,
      note: note || (delta > 0 ? "Admin credit" : "Admin deduction"),
      amount: Math.abs(delta),
      timestamp: Date.now(),
    });
  }

  const sign = delta > 0 ? "+" : "−";
  showToast(`Balance ${sign}$${Math.abs(delta).toLocaleString()} → $${next.toLocaleString()}${log ? " · logged" : ""}`);
}

window.resetUser = async function(userId) {
  await update(ref(db), {
    [`config/user_resets/${userId}`]: Date.now(),
    [`users/${userId}/balance`]: 1000,
  });
  showToast("Balance reset to $1,000.");
};

window.deleteUser = async function(userId, name) {
  if (!confirm(`Delete player "${name}"? They will be prompted to pick a new name on next load.`)) return;
  await remove(ref(db, `users/${userId}`));
  await remove(ref(db, `config/user_resets/${userId}`));
  showToast(`${name} deleted.`);
};


async function invalidateBet(betKey, userId, amount) {
  if (!confirm(`Void this bet? The player loses $${amount.toLocaleString()} with no refund.`)) return;
  await update(ref(db, `bets/${betKey}`), { invalidated: true, invalidatedAt: Date.now() });
  // Deduct amount from balance since they'd otherwise keep it on resolution
  const balSnap = await get(ref(db, `users/${userId}/balance`));
  const cur = balSnap.val() ?? 1000;
  await update(ref(db, `users/${userId}`), { balance: cur - amount });
  showToast(`Bet voided. $${amount.toLocaleString()} deducted.`);
  // Refresh the panel
  const panel = document.getElementById(`trades-panel-${userId}`);
  if (panel) panel.remove();
  showPlayerTrades(userId);
}

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

  // Tally payouts per user — skip invalidated bets
  const payouts = {};
  Object.values(allBets).forEach(bet => {
    if (bet.marketId !== id) return;
    if (bet.invalidated) return;
    if (Number(bet.optionIndex) !== winningIndex) return;
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
  const updates = { status };
  if (status === "closed") updates.closedAt = Date.now();
  await update(ref(db, `markets/${id}`), updates);
  showToast(status === "open" ? "Market reopened." : "Market closed.");
};

window.deleteMarket = async function(id) {
  const m = allMarkets[id];
  if (!m) return;
  if (!confirm(`Delete "${m.title}"? This cannot be undone.`)) return;
  await remove(ref(db, `markets/${id}`));
  showToast("Market deleted.");
};

// ─── EXPORT CSV ──────────────────────────────────────────────
function exportTradeLog() {
  const snap_ref = ref(db, "bets");
  get(snap_ref).then(snap => {
    const data = snap.val() || {};
    const rows = Object.values(data)
      .filter(b => b.marketId && !b.invalidated)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    if (rows.length === 0) { showToast("No trades to export."); return; }

    const headers = ["Player", "Market", "Option", "Amount", "Payout", "Status", "Time"];
    const csvRows = [headers.join(",")];

    rows.forEach(b => {
      const market = allMarkets[b.marketId];
      const isResolved = market?.status === "resolved";
      const won  = isResolved && Number(market.resolvedOptionIndex) === Number(b.optionIndex);
      const lost = isResolved && !won;
      const status = won ? "Won" : lost ? "Lost" : "Open";
      const time = b.timestamp ? new Date(b.timestamp).toLocaleString("en-US") : "";
      const escape = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
      csvRows.push([
        escape(b.userName),
        escape(b.marketTitle),
        escape(b.option),
        b.amount || 0,
        b.payout || 0,
        status,
        escape(time),
      ].join(","));
    });

    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `trade-log-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${rows.length} trades.`);
  });
}

// ─── TRADE LOG ───────────────────────────────────────────────
function subscribeToTradeLog() {
  onValue(ref(db, "bets"), (snap) => {
    const data = snap.val() || {};
    const el = document.getElementById("admin-trade-log");
    if (!el) return;

    const bets = Object.entries(data)
      .filter(([, b]) => b.marketId && !b.invalidated)
      .sort(([, a], [, b]) => (b.timestamp || 0) - (a.timestamp || 0));

    if (bets.length === 0) {
      el.innerHTML = `<div class="list-empty">No trades yet.</div>`;
      return;
    }

    el.innerHTML = bets.map(([betKey, b]) => {
      const market = allMarkets[b.marketId];
      const isResolved = market?.status === "resolved";
      const won  = isResolved && Number(market.resolvedOptionIndex) === Number(b.optionIndex);
      const lost = isResolved && !won;
      const statusClass = won ? "trade-status-won" : lost ? "trade-status-lost" : "trade-status-open";
      const statusText  = won ? "Won" : lost ? "Lost" : "Open";
      return `
        <div class="player-trade-row" style="padding:0.5rem 0;border-bottom:1px solid var(--border)">
          <span class="player-trade-status ${statusClass}">${statusText}</span>
          <span class="player-trade-title" style="flex:1">${b.userName || "?"}</span>
          <span class="player-trade-option" style="flex:2;color:var(--text)">${(b.marketTitle || "").slice(0, 35)}</span>
          <span class="player-trade-option">${b.option || ""}</span>
          <span class="player-trade-amt">$${(b.amount || 0).toLocaleString()}</span>
          <span class="player-seen">${timeAgo(b.timestamp)}</span>
          <button class="trade-invalidate-btn" data-key="${betKey}" data-amt="${b.amount || 0}" data-uid="${b.userId || ""}">Void</button>
        </div>`;
    }).join("");

    el.querySelectorAll(".trade-invalidate-btn").forEach(btn => {
      btn.addEventListener("click", () => invalidateBet(btn.dataset.key, btn.dataset.uid, Number(btn.dataset.amt)));
    });
  });
}

// ─── TOAST ────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ============================================================
//  SPORTSBOOK ADMIN — CRUD
//  NOTE: Firebase rules must allow write on /sb_markets, /sb_bets, /parlays
// ============================================================

let allSbMarkets = {};
let sbAdminFilter = "open";

// ─── SUBSCRIBE ────────────────────────────────────────────────
function subscribeToSbMarkets() {
  onValue(ref(db, "sb_markets"), (snap) => {
    allSbMarkets = snap.val() || {};
    renderSbMarketList();
  });
}

// ─── SUBTYPE TOGGLE ───────────────────────────────────────────
window.onSbSubtypeChange = function() {
  const subtype = document.getElementById("sb-subtype").value;
  const sidesFields = document.getElementById("sb-sides-fields");
  const totalFields = document.getElementById("sb-total-fields");
  const spreadGroups = document.querySelectorAll("#sb-sideA-spread-group, #sb-sideB-spread-group");

  if (subtype === "total") {
    sidesFields.style.display = "none";
    totalFields.style.display = "";
  } else {
    sidesFields.style.display = "";
    totalFields.style.display = "none";
    spreadGroups.forEach(el => {
      el.style.display = subtype === "spread" ? "" : "none";
    });
  }
};

// Initialize on page load (hide spread fields by default for moneyline)
document.addEventListener("DOMContentLoaded", () => {
  // Only run if sportsbook form exists (i.e., admin is authenticated already or will be)
  const subtypeEl = document.getElementById("sb-subtype");
  if (subtypeEl) {
    onSbSubtypeChange();
  }
});

// ─── SAVE SPORTSBOOK MARKET ───────────────────────────────────
window.saveSbMarket = async function() {
  const subtype  = document.getElementById("sb-subtype").value;
  const category = (document.getElementById("sb-category").value || "General").trim();
  const title    = document.getElementById("sb-title").value.trim();

  if (!title) { alert("Title is required."); return; }

  const data = {
    title, category, subtype,
    status: "open", volume: 0, createdAt: Date.now(),
  };

  if (subtype === "total") {
    const line      = parseFloat(document.getElementById("sb-line").value);
    const overOdds  = parseInt(document.getElementById("sb-over-odds").value);
    const underOdds = parseInt(document.getElementById("sb-under-odds").value);
    if (isNaN(line) || isNaN(overOdds) || isNaN(underOdds)) {
      alert("Please fill in the total line, over odds, and under odds."); return;
    }
    data.line = line; data.overOdds = overOdds; data.underOdds = underOdds;
  } else {
    const sideALabel  = document.getElementById("sb-sideA-label").value.trim();
    const sideBLabel  = document.getElementById("sb-sideB-label").value.trim();
    const sideAOdds   = parseInt(document.getElementById("sb-sideA-odds").value);
    const sideBOdds   = parseInt(document.getElementById("sb-sideB-odds").value);
    if (!sideALabel || !sideBLabel) { alert("Side A and Side B labels are required."); return; }
    if (isNaN(sideAOdds) || isNaN(sideBOdds)) { alert("Side odds are required (e.g. -110)."); return; }

    data.sideA = { label: sideALabel, odds: sideAOdds };
    data.sideB = { label: sideBLabel, odds: sideBOdds };
    if (subtype === "spread") {
      data.sideA.spread = document.getElementById("sb-sideA-spread").value.trim();
      data.sideB.spread = document.getElementById("sb-sideB-spread").value.trim();
    }
  }

  const btn = document.getElementById("sb-save-btn");
  btn.disabled = true; btn.textContent = "Saving...";

  await push(ref(db, "sb_markets"), data);

  // Reset form
  document.getElementById("sb-title").value = "";
  document.getElementById("sb-category").value = "";
  document.getElementById("sb-sideA-label").value = "";
  document.getElementById("sb-sideA-spread").value = "";
  document.getElementById("sb-sideA-odds").value = "";
  document.getElementById("sb-sideB-label").value = "";
  document.getElementById("sb-sideB-spread").value = "";
  document.getElementById("sb-sideB-odds").value = "";
  document.getElementById("sb-line").value = "";
  document.getElementById("sb-over-odds").value = "";
  document.getElementById("sb-under-odds").value = "";

  btn.disabled = false; btn.textContent = "Create Sportsbook Market";
  showToast("Sportsbook market created.");
};

// ─── FILTER ───────────────────────────────────────────────────
window.filterSbMarkets = function(filter, btn) {
  sbAdminFilter = filter;
  if (btn) {
    btn.closest(".status-tabs")?.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  }
  renderSbMarketList();
};

// ─── RENDER LIST ──────────────────────────────────────────────
function renderSbMarketList() {
  const container = document.getElementById("admin-sb-market-list");
  if (!container) return;

  let entries = Object.entries(allSbMarkets);
  if (sbAdminFilter === "open")   entries = entries.filter(([, m]) => m.status === "open");
  if (sbAdminFilter === "closed") entries = entries.filter(([, m]) => m.status === "closed" || m.status === "resolved");

  entries.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  if (entries.length === 0) {
    container.innerHTML = `<div class="list-empty">No ${sbAdminFilter} sportsbook markets.</div>`;
    return;
  }

  container.innerHTML = entries.map(([id, m]) => {
    const isOpen     = m.status === "open";
    const isResolved = m.status === "resolved";
    const statusClass = isOpen ? "open" : isResolved ? "resolved" : "closed";
    const statusLabel = isOpen ? "Open" : isResolved ? "Resolved" : "Closed";

    let sidesInfo = "";
    if (m.subtype === "total") {
      sidesInfo = `Over/Under ${m.line ?? ""} · Over: ${m.overOdds > 0 ? "+" : ""}${m.overOdds} · Under: ${m.underOdds > 0 ? "+" : ""}${m.underOdds}`;
    } else {
      const spreadA = m.sideA?.spread ? ` ${m.sideA.spread}` : "";
      const spreadB = m.sideB?.spread ? ` ${m.sideB.spread}` : "";
      sidesInfo = `${m.sideA?.label || "A"}${spreadA} (${m.sideA?.odds > 0 ? "+" : ""}${m.sideA?.odds}) vs ${m.sideB?.label || "B"}${spreadB} (${m.sideB?.odds > 0 ? "+" : ""}${m.sideB?.odds})`;
    }

    return `
      <div class="admin-market-row${isOpen ? "" : " closed"}" data-sb-id="${id}">
        <div>
          <div class="admin-market-meta">
            <span class="admin-market-category">${m.category || "General"}</span>
            <span class="market-status-pill ${statusClass}">${statusLabel}</span>
            <span style="font-size:0.65rem;color:var(--text-dim);font-weight:600;text-transform:uppercase">${m.subtype || "moneyline"}</span>
            ${isResolved ? `<span class="resolved-winner-pill">Winner: ${m.resolvedLabel || m.resolvedSide || ""}</span>` : ""}
          </div>
          <div class="admin-market-title">${m.title || ""}</div>
          <div class="admin-market-stats">${sidesInfo} · Vol: $${(m.volume || 0).toLocaleString()}</div>
        </div>
        <div class="admin-market-actions">
          ${isResolved
            ? ""
            : isOpen
              ? `<button class="admin-action-btn close-market" onclick="setSbMarketStatus('${id}','closed')">Close</button>
                 <button class="admin-action-btn resolve" onclick="showSbResolveOptions('${id}')">Resolve</button>`
              : `<button class="admin-action-btn reopen" onclick="setSbMarketStatus('${id}','open')">Reopen</button>
                 <button class="admin-action-btn resolve" onclick="showSbResolveOptions('${id}')">Resolve</button>`
          }
          <button class="admin-action-btn delete" onclick="deleteSbMarket('${id}')">Delete</button>
        </div>
      </div>`;
  }).join("");
}

// ─── STATUS / DELETE ──────────────────────────────────────────
window.setSbMarketStatus = async function(id, status) {
  await update(ref(db, `sb_markets/${id}`), { status });
  showToast(status === "open" ? "Sportsbook market reopened." : "Sportsbook market closed.");
};

// ─── RESOLVE SPORTSBOOK ───────────────────────────────────────
window.showSbResolveOptions = function(id) {
  const existing = document.getElementById(`sb-resolve-picker-${id}`);
  if (existing) { existing.remove(); return; }

  const m = allSbMarkets[id];
  if (!m) return;

  let sides;
  if (m.subtype === "total") {
    sides = [
      { label: `Over ${m.line ?? ""}`, key: "over" },
      { label: `Under ${m.line ?? ""}`, key: "under" },
    ];
  } else {
    sides = [
      { label: m.sideA?.label || "Side A", key: "A" },
      { label: m.sideB?.label || "Side B", key: "B" },
    ];
  }

  const picker = document.createElement("div");
  picker.id = `sb-resolve-picker-${id}`;
  picker.className = "resolve-picker";
  picker.innerHTML = `
    <div class="resolve-picker-label">Which side won?</div>
    <div class="resolve-picker-options">
      ${sides.map(s => `<button class="resolve-option-btn">${s.label}</button>`).join("")}
    </div>
    <button class="resolve-cancel-btn" onclick="document.getElementById('sb-resolve-picker-${id}').remove()">Cancel</button>
  `;
  const btns = picker.querySelectorAll(".resolve-option-btn");
  sides.forEach((s, i) => {
    btns[i].addEventListener("click", () => resolveSbMarket(id, s.key, s.label));
  });

  const row = document.querySelector(`.admin-market-row[data-sb-id="${id}"]`);
  if (row) row.after(picker);
};

window.resolveSbMarket = async function(id, winningSideKey, winningSideLabel) {
  const m = allSbMarkets[id];
  if (!m) return;

  if (!confirm(`Resolve "${m.title}"\n\nWinner: "${winningSideLabel}"\n\nThis will pay out all winning bets. Cannot be undone.`)) return;

  const picker = document.getElementById(`sb-resolve-picker-${id}`);
  if (picker) picker.remove();

  const updates = {};

  // Mark market resolved
  updates[`sb_markets/${id}/status`]        = "resolved";
  updates[`sb_markets/${id}/resolvedSide`]  = winningSideKey;
  updates[`sb_markets/${id}/resolvedLabel`] = winningSideLabel;
  updates[`sb_markets/${id}/resolvedAt`]    = Date.now();

  // Tally individual sb_bet payouts
  const sbBetsSnap = await get(ref(db, "sb_bets"));
  const allSbBets  = sbBetsSnap.val() || {};
  const payouts = {};
  Object.values(allSbBets).forEach(bet => {
    if (bet.marketId !== id) return;
    if (bet.invalidated) return;
    if (bet.side !== winningSideKey) return;
    payouts[bet.userId] = (payouts[bet.userId] || 0) + (bet.payout || 0);
  });

  // Handle parlays — void losers, pay out fully-settled winners
  const parlaysSnap    = await get(ref(db, "parlays"));
  const allParlays     = parlaysSnap.val() || {};
  const sbMktSnap      = await get(ref(db, "sb_markets"));
  const latestSbMkts   = sbMktSnap.val() || {};
  // Apply the pending resolution so all-legs checks reflect the new state
  latestSbMkts[id] = { ...latestSbMkts[id], status: "resolved", resolvedSide: winningSideKey };

  Object.entries(allParlays).forEach(([parlayKey, parlay]) => {
    if (parlay.voided || parlay.paid) return;
    const legs = parlay.legs || [];
    const leg  = legs.find(l => l.marketId === id);
    if (!leg) return;

    if (leg.side !== winningSideKey) {
      // Wrong pick — void the entire parlay
      updates[`parlays/${parlayKey}/voided`] = true;
      return;
    }

    // Correct pick — check if every leg's market is now resolved and won
    const allWon = legs.every(l => {
      const mkt = latestSbMkts[l.marketId];
      return mkt && mkt.status === "resolved" && mkt.resolvedSide === l.side;
    });

    if (allWon) {
      payouts[parlay.userId] = (payouts[parlay.userId] || 0) + (parlay.payout || 0);
      updates[`parlays/${parlayKey}/paid`]   = true;
      updates[`parlays/${parlayKey}/paidAt`] = Date.now();
    }
  });

  // Credit winner balances
  for (const [userId, payout] of Object.entries(payouts)) {
    const balSnap = await get(ref(db, `users/${userId}/balance`));
    const cur     = balSnap.val() ?? 1000;
    updates[`users/${userId}/balance`] = cur + payout;
  }

  await update(ref(db), updates);

  const count = Object.keys(payouts).length;
  const total = Object.values(payouts).reduce((s, p) => s + p, 0);
  showToast(`Resolved: "${winningSideLabel}" wins. $${total.toLocaleString()} paid to ${count} player(s).`);
};

window.deleteSbMarket = async function(id) {
  const m = allSbMarkets[id];
  if (!m) return;
  if (!confirm(`Delete sportsbook market "${m.title}"? This cannot be undone.`)) return;
  await remove(ref(db, `sb_markets/${id}`));
  showToast("Sportsbook market deleted.");
};
