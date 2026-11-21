import {api, capabilities, loadGatewayCaps} from "./api.js";
import {$, badgeElement, messageElement, relTime, showError, showLoading, str} from "./util.js";

// Kanban board: a read-only view of the gateway's kanban tasks (no write actions in v1). The routes are a fork
// extension; stock gateways do not serve them. Protocol: docs/kanban-protocol.md. The entry appears only when
// capabilities advertise the feature — an absent flag is "unsupported", never an empty board.

let view = null, barSel = null, updatedEl = null, noteEl = null, columnsEl = null, detailEl = null;
let currentBoard = null, tasksById = new Map(), latestEventId = null, loading = false, updatedTimer = null;

// features.kanban_read must be true and all three endpoint keys advertised; absent ⇒ unsupported (unlike clarify,
// nothing is assumed until capabilities answer, because the entry must not exist on a gateway without the routes).
export function kanbanSupported(){
  const d = capabilities();
  if(!d || typeof d !== "object") return false;
  const f = (d.features && typeof d.features === "object") ? d.features : {};
  const ep = (d.endpoints && typeof d.endpoints === "object") ? d.endpoints : null;
  return f.kanban_read === true && !!ep && !!ep.kanban_boards && !!ep.kanban_board && !!ep.kanban_task;
}

function el(tag, className, text){
  const x = document.createElement(tag);
  if(className) x.className = className;
  if(text != null) x.textContent = String(text);
  return x;
}

export async function initKanban(){
  ensureView();
  $("kanbanBtn").onclick = openBoard;   // the More menu proxies this button, like the other header buttons
  await loadGatewayCaps();
  applyGate();
}
function applyGate(){
  const sup = kanbanSupported();
  $("kanbanBtn")?.classList.toggle("hidden", !sup);
  $("moreKanban")?.classList.toggle("hidden", !sup);
  return sup;
}

function ensureView(){
  if(view) return;
  view = el("div", "kanban-view hidden");
  view.id = "kanbanView";
  view.setAttribute("role", "dialog");
  view.setAttribute("aria-label", "Kanban board");
  const bar = el("div", "kanban-bar");
  bar.appendChild(el("div", "kanban-title", "Kanban"));
  barSel = el("select", "kanban-boards hidden");
  barSel.setAttribute("aria-label", "Board");
  barSel.onchange = ()=>{ currentBoard = barSel.value; loadBoard(); };
  updatedEl = el("span", "kanban-updated hidden", "updated");
  const close = el("button", "toolbtn", "✕");
  close.type = "button";
  close.title = "Close board";
  close.setAttribute("aria-label", "Close board");
  close.onclick = closeBoard;
  bar.append(barSel, updatedEl, close);
  noteEl = el("div", "kanban-note");
  columnsEl = el("div", "kanban-columns");
  detailEl = el("aside", "kanban-detail hidden");
  detailEl.setAttribute("aria-label", "Task detail");
  view.append(bar, noteEl, columnsEl, detailEl);
  document.body.appendChild(view);
  window.addEventListener("keydown", (e)=>{
    if(e.key !== "Escape" || view.classList.contains("hidden")) return;
    if(!detailEl.classList.contains("hidden")) closeDetail();
    else closeBoard();
  });
}

function openBoard(){
  if(!applyGate()) return;
  view.classList.remove("hidden");
  loadBoard();
}
function closeBoard(){
  view.classList.add("hidden");
  closeDetail();
}
// Coming back to the page refetches an open board, like the clarify pending probe; there is no background poller.
export function refreshKanban(){
  if(view && !view.classList.contains("hidden") && kanbanSupported()) loadBoard();
}

async function loadBoard(){
  if(loading) return;
  loading = true;
  if(!tasksById.size) showLoading(columnsEl);
  try{
    if(!currentBoard) await loadBoards();
    const r = await api("/api/kanban/board?board=" + encodeURIComponent(currentBoard));
    if(!r.ok) throw new Error("HTTP " + r.status);
    renderBoard(await r.json());
  }catch(e){
    currentBoard = null;   // retry board discovery on the next attempt
    showError(columnsEl, "Failed to load the board: " + (e.message || e));
  }finally{
    loading = false;
  }
}

async function loadBoards(){
  const r = await api("/api/kanban/boards");
  if(!r.ok) throw new Error("HTTP " + r.status);
  const d = await r.json();
  const boards = Array.isArray(d && d.boards) ? d.boards.filter(b=> b && b.slug) : [];
  if(!boards.length) throw new Error("no boards reported");
  // The slug is always passed explicitly: the server's default pointer can surprise. A switcher appears only
  // when more than one board exists; the choice is kept for the session.
  currentBoard = (boards.find(b=> b.slug === currentBoard) || boards.find(b=> b.archived !== true) || boards[0]).slug;
  if(boards.length > 1){
    barSel.replaceChildren(...boards.map(b=>{
      const o = el("option", null, (b.name || b.slug) + (b.archived ? " (archived)" : ""));
      o.value = b.slug;
      return o;
    }));
    barSel.value = currentBoard;
    barSel.classList.remove("hidden");
  }
}

export function renderBoard(data){
  const columns = (data && data.columns && typeof data.columns === "object") ? data.columns : {};
  const order = Array.isArray(data && data.column_order) ? data.column_order : Object.keys(columns);
  tasksById = new Map();
  for(const status of order){
    for(const t of (Array.isArray(columns[status]) ? columns[status] : [])){
      if(t && t.id != null) tasksById.set(String(t.id), Object.assign({status}, t));
    }
  }
  columnsEl.replaceChildren();
  noteEl.replaceChildren();
  if(data && data.truncated === true) noteEl.appendChild(messageElement("Showing newest 500 tasks."));
  for(const status of order){
    const tasks = Array.isArray(columns[status]) ? columns[status] : [];
    const col = el("div", "kanban-col");
    const hdr = el("div", "kanban-col-hdr");
    hdr.append(el("span", "n", status), el("span", "c", String(tasks.length)));
    col.appendChild(hdr);
    const body = el("div", "kanban-col-body");
    for(const t of tasks) body.appendChild(cardElement(t));
    col.appendChild(body);
    columnsEl.appendChild(col);
  }
  const ev = Number(data && data.latest_event_id);
  if(Number.isFinite(ev)){
    if(latestEventId !== null && ev !== latestEventId) flashUpdated();
    latestEventId = ev;
  }
}

// A focus refresh that brought newer events says so quietly; it never interrupts what the user is reading.
function flashUpdated(){
  updatedEl.classList.remove("hidden");
  clearTimeout(updatedTimer);
  updatedTimer = setTimeout(()=>{ updatedEl.classList.add("hidden"); }, 2500);
}

// GOAL card: a title starting with "GOAL:" (case-insensitive) carries a marker; its rollup is progress
// ?? parents_progress — the same rule as the desktop client, and applied to every card that has one. Null-safe.
export function taskRollup(t){
  const p = (t && typeof t.progress === "object" && t.progress !== null) ? t.progress
          : (t && typeof t.parents_progress === "object" && t.parents_progress !== null) ? t.parents_progress : null;
  if(!p || !Number.isFinite(Number(p.done)) || !Number.isFinite(Number(p.total))) return null;
  return Number(p.done) + "/" + Number(p.total);
}
function isGoal(t){ return /^\s*goal:/i.test(String((t && t.title) || "")); }
// Priority accent: a display decision (see docs/kanban-protocol.md); unrecognized values get no accent.
function priorityClass(t){
  const p = (t && t.priority != null) ? String(t.priority).toLowerCase() : "";
  if(["urgent", "critical", "high", "p0", "p1"].includes(p)) return "kb-prio-high";
  if(["medium", "mid", "normal", "p2"].includes(p)) return "kb-prio-mid";
  if(["low", "p3"].includes(p)) return "kb-prio-low";
  if(/^\d+$/.test(p)) return Number(p) >= 3 ? "kb-prio-high" : (Number(p) === 2 ? "kb-prio-mid" : "kb-prio-low");
  return "";
}

function cardElement(t){
  const goal = isGoal(t);
  const prio = priorityClass(t);
  const card = el("button", "kb-card" + (goal ? " kb-goal" : "") + (prio ? " " + prio : ""));
  card.type = "button";
  card.dataset.tid = String(t.id);
  const title = el("div", "kb-t");
  if(goal) title.appendChild(el("span", "kb-goal-badge", "goal"));
  title.appendChild(document.createTextNode(String(t.title || "(untitled)")));
  const meta = el("div", "kb-m");
  if(t.assignee) meta.appendChild(el("span", "kb-assignee", String(t.assignee)));
  const roll = taskRollup(t);
  if(roll) meta.appendChild(el("span", "kb-roll", roll));
  const age = t.age ? String(t.age) : relTime(t.created_at);
  if(age) meta.appendChild(el("span", "kb-age", age));
  card.append(title, meta);
  card.onclick = ()=> openTask(String(t.id));
  return card;
}

/* ---------- detail drawer ---------- */
function closeDetail(){ detailEl.classList.add("hidden"); detailEl.replaceChildren(); }

async function openTask(taskId){
  showLoading(detailEl);
  detailEl.classList.remove("hidden");
  let task = tasksById.get(taskId) || null, links = {}, failed = false;
  try{
    const r = await api("/api/kanban/tasks/" + encodeURIComponent(taskId)
                        + "?board=" + encodeURIComponent(currentBoard || ""));
    if(!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    if(d && d.task) task = Object.assign({}, tasksById.get(taskId), d.task);
    if(d && d.links && typeof d.links === "object") links = d.links;
  }catch{
    failed = true;   // the board's own row is enough to show the card; the links simply stay unknown
  }
  renderDetail(task, links, failed);
}

// A linked id resolves to its title when the loaded board holds the task; otherwise the id stands.
function taskLabel(id){
  const t = tasksById.get(String(id));
  return (t && t.title) ? String(t.title) : String(id);
}

function renderDetail(task, links, failed){
  detailEl.replaceChildren();
  const hdr = el("div", "kb-detail-hdr");
  const title = el("div", "kb-detail-title");
  if(task && isGoal(task)) title.appendChild(el("span", "kb-goal-badge", "goal"));
  title.appendChild(document.createTextNode((task && task.title) || "Task"));
  const x = el("button", "modal-close-btn toolbtn", "✕");
  x.type = "button";
  x.title = "Close detail";
  x.setAttribute("aria-label", "Close detail");
  x.onclick = closeDetail;
  hdr.append(title, x);
  detailEl.appendChild(hdr);
  if(!task){
    detailEl.appendChild(messageElement(failed ? "Could not load the task." : "This task is not on the loaded board."));
    return;
  }
  const meta = el("div", "kb-detail-meta");
  if(task.status) meta.appendChild(badgeElement(String(task.status)));
  if(task.assignee) meta.appendChild(badgeElement(String(task.assignee)));
  if(task.priority != null) meta.appendChild(badgeElement(String(task.priority)));
  const roll = taskRollup(task);
  if(roll) meta.appendChild(badgeElement(roll, "attn"));
  const age = task.age ? String(task.age) : relTime(task.created_at);
  if(age) meta.appendChild(el("span", null, age));
  const cc = Number(task.comment_count);
  if(Number.isFinite(cc)) meta.appendChild(el("span", null, cc + (cc === 1 ? " comment" : " comments")));
  detailEl.appendChild(meta);
  if(failed) detailEl.appendChild(el("div", "kb-detail-note", "Links may be incomplete: the task detail could not be loaded."));
  const body = str(task.body);
  if(body){
    const b = el("div", "kb-detail-body");
    b.textContent = body;
    detailEl.appendChild(b);
  }
  detailEl.appendChild(linkSection("Parents", links.parents));
  detailEl.appendChild(linkSection("Children", links.children));
}

function linkSection(label, ids){
  const wrap = el("div", "kb-detail-links");
  wrap.appendChild(el("div", "kb-links-h", label));
  const list = Array.isArray(ids) ? ids : [];
  if(!list.length){ wrap.appendChild(el("div", "kb-links-none", "none")); return wrap; }
  for(const id of list) wrap.appendChild(el("div", "kb-link", taskLabel(id)));
  return wrap;
}
