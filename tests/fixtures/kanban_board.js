// Assertions for the read-only Kanban board view, run by tests/test_client_kanban.py inside a real
// Chromium over the real web/js modules. The page's fetch is replaced by a scripted stub before any module
// loads (window.__calls / window.__get are set by the fixture HTML). main.js is deliberately NOT imported:
// the fixture drives initKanban itself, in a controlled capabilities order. The result is written to
// <pre id="test-result"> for the driver to parse from the dumped DOM.
import {loadGatewayCaps} from "/js/api.js";
import {initKanban, kanbanSupported, renderBoard, taskRollup} from "/js/kanban.js";
import {$} from "/js/util.js";

const results = [];
const check = (name, cond) => { results.push([name, Boolean(cond)]); }
const tick = () => new Promise((resolve)=> setTimeout(resolve, 0));
async function flush(rounds = 20){ for(let i = 0; i < rounds; i++) await tick(); }
const calledWith = (frag) => window.__calls.some((c)=> c.path.includes(frag));
const card = (id) => document.querySelector(`.kb-card[data-tid="${id}"]`);

const BOARD = {
  object: "hermes.kanban.board", board: "home",
  column_order: ["triage", "todo", "running", "blocked", "review", "done"],
  columns: {
    triage: [{id: 1, title: "GOAL: Ship v1", assignee: "bot", priority: "high", age: "2h",
              progress: null, parents_progress: {done: 1, total: 3}}],
    todo: [{id: 2, title: "Plain task", priority: 1,
            progress: {done: 2, total: 5}, parents_progress: {done: 9, total: 9}}],
    running: [{id: 3, title: "goal: lowercase marker", progress: null, parents_progress: null}],
    blocked: [{id: 4, title: "No rollup", progress: null, parents_progress: null, age: "3d"}],
    review: [],
    done: [{id: 5, title: "GOAL: done thing", progress: {done: 4, total: 4}, parents_progress: null}],
  },
  latest_event_id: 42, truncated: true,
};

async function main(){
  // 1. Gating: no flag, no endpoints -> no affordance anywhere and no kanban request.
  window.__get["/v1/capabilities"] = {body: {features: {}, endpoints: {}}};
  await initKanban();
  check("entry hidden without kanban_read", $("kanbanBtn").classList.contains("hidden") && !kanbanSupported());
  check("more-menu item hidden without kanban_read", $("moreKanban").classList.contains("hidden"));
  check("no kanban request when unsupported", !calledWith("/api/kanban"));

  // Flag without every endpoint key is still unsupported (compatibility rule).
  window.__get["/v1/capabilities"] = {body: {features: {kanban_read: true}, endpoints: {kanban_boards: true}}};
  await loadGatewayCaps(true); await initKanban();
  check("partial endpoint advertisement stays hidden", !kanbanSupported());

  // 2. Full advertisement -> entry visible; clicking fetches boards, then the board with an explicit slug.
  window.__get["/v1/capabilities"] = {body: {features: {kanban_read: true},
    endpoints: {kanban_boards: true, kanban_board: true, kanban_task: true}}};
  await loadGatewayCaps(true); await initKanban();
  check("entry shown with flag and endpoints", !$("kanbanBtn").classList.contains("hidden") && kanbanSupported());
  window.__get["/api/kanban/boards"] = {body: {boards: [{slug: "home", name: "Home", archived: false}]}};
  window.__get["/api/kanban/board?"] = {body: BOARD};
  window.__get["/api/kanban/tasks/"] = {body: {object: "hermes.kanban.task", board: "home",
    task: {id: 1, title: "GOAL: Ship v1", body: "the body text", status: "triage", assignee: "bot", comment_count: 3},
    links: {parents: [9], children: [2]}}};
  $("kanbanBtn").click();
  await flush();
  check("board opens", !document.querySelector(".kanban-view").classList.contains("hidden"));
  check("boards listed first", calledWith("/api/kanban/boards"));
  check("board requested with explicit slug", calledWith("/api/kanban/board?board=home"));
  const cols = document.querySelectorAll(".kanban-col");
  check("columns render in column_order", cols.length === 6
        && cols[0].querySelector(".n").textContent === "triage"
        && cols[4].querySelector(".n").textContent === "review");
  check("columns carry counts", cols[0].querySelector(".c").textContent === "1"
        && cols[4].querySelector(".c").textContent === "0");
  check("cards show assignee and age", card(1).textContent.includes("bot") && card(4).textContent.includes("3d"));
  check("truncated renders a newest-500 note",
        document.querySelector(".kanban-note").textContent.includes("newest 500"));

  // 3. GOAL rule: marker on "GOAL:" (any case); rollup is progress ?? parents_progress, null-safe.
  check("goal marker on uppercase prefix", card(1).classList.contains("kb-goal") && card(1).querySelector(".kb-goal-badge"));
  check("goal marker on lowercase prefix", card(3).classList.contains("kb-goal"));
  check("parents_progress rolls up when progress is null", card(1).querySelector(".kb-roll").textContent === "1/3");
  check("progress preferred over parents_progress", card(2).querySelector(".kb-roll").textContent === "2/5");
  check("null rollups render nothing", !card(3).querySelector(".kb-roll") && !card(4).querySelector(".kb-roll"));
  check("priority accent applies", card(1).classList.contains("kb-prio-high"));
  check("rollup rule direct", taskRollup({progress: {done: 1, total: 2}, parents_progress: {done: 0, total: 9}}) === "1/2"
        && taskRollup({progress: null, parents_progress: {done: 0, total: 0}}) === "0/0"
        && taskRollup({progress: null, parents_progress: null}) === null
        && taskRollup({}) === null);

  // 4. Detail drawer: body, comment count, links resolved from the board where possible; Escape closes it.
  card(1).click();
  await flush();
  const detail = document.querySelector(".kanban-detail");
  check("task detail requested with slug", calledWith("/api/kanban/tasks/1?board=home"));
  check("drawer shows body and comments",
        !detail.classList.contains("hidden") && detail.textContent.includes("the body text") && detail.textContent.includes("3 comments"));
  check("child link resolves to its board title", detail.textContent.includes("Plain task"));
  check("unknown parent link shows the id", detail.querySelector(".kb-link").textContent === "9");
  window.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}));
  check("Escape closes the drawer", detail.classList.contains("hidden"));

  // 5. Re-render: truncated=false removes the note; a newer latest_event_id flashes the updated marker.
  renderBoard(Object.assign({}, BOARD, {truncated: false, latest_event_id: 43}));
  check("truncated=false removes the note", document.querySelector(".kanban-note").textContent === "");
  check("changed latest_event_id flashes updated", !document.querySelector(".kanban-updated").classList.contains("hidden"));
}

function report(extra){
  const pre = document.createElement("pre");
  pre.id = "test-result";
  const failed = results.filter(([, ok])=> !ok).map(([name])=> name);
  pre.textContent = "TESTRESULT " + JSON.stringify(
    Object.assign({total: results.length, failed}, extra || {}));
  document.body.appendChild(pre);
}

let done = false;
setTimeout(()=>{ if(!done) report({error: "timeout"}); }, 5000);
main().then(()=>{ done = true; report(); })
        .catch((e)=>{ done = true; report({error: String(e && e.stack || e)}); });
