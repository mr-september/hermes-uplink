const $ = (id) => document.getElementById(id);
const LS_KEY = "hermes-uplink-cfg";
let cfg = loadCfg();
let activeId = null;
let streaming = false;
let streamingSessionId = null;   // which session owns the active stream
let currentAbort = null;
const sessionRenderCache = new Map();
let currentRenderedSessionId = null;
// Per-session stream state: sid -> {sid, abort, runId, lastFrameAt, running, holder, bubble, userBubble, intercepted}.
// `streaming`, `streamingSessionId`, `currentAbort`, `activeRunId` and `lastFrameAt` are the foreground view of this map
// (see syncForeground). A stream whose session the user has left keeps writing into its own detached thread nodes
// (S.holder), which are put back on screen on return. A finished entry is kept only while its holder is parked.
const streams = new Map();
// Sessions that need the user: sid -> "question" (a clarify card is waiting) | "reply" (the turn finished while away).
const attention = new Map();
// Sessions whose thread holds stream-built content (clarify/tool cards, "[stopped]") that a history rebuild would drop.
// A passive refresh leaves such a thread alone; opening the session or the Refresh button rebuilds it.
const localThread = new Set();
const FINE_POINTER = window.matchMedia("(pointer: fine)").matches;
// Coarse pointer: Enter inserts a newline (Ctrl+Enter or the send button sends), so don't advertise Enter-to-send.
if(!FINE_POINTER) $("input").placeholder = "Message the agent…";

/* ---------- Sidebar Pinning & Layout Engine ---------- */
const PIN_STORAGE_KEY = "hermes-uplink-sidebar-pinned";
const PIN_MEDIA_QUERY = "(min-width: 1024px), (min-width: 768px) and (orientation: landscape)";
const pinMatcher = window.matchMedia(PIN_MEDIA_QUERY);

function canPinSidebar(){
  return pinMatcher.matches;
}

function isSidebarPinnedPref(){
  try{
    const stored = localStorage.getItem(PIN_STORAGE_KEY);
    if(stored !== null) return stored === "true";
  }catch(e){}
  return window.innerWidth >= 1024;
}

function isSidebarPinnedEffective(){
  return canPinSidebar() && isSidebarPinnedPref();
}

function applySidebarState(pinned, openFlyout = false){
  const effective = canPinSidebar() && pinned;
  document.body.classList.toggle("sidebar-pinned", effective);
  const pinBtn = $("pinSidebarBtn");
  if(pinBtn){
    pinBtn.setAttribute("aria-pressed", effective ? "true" : "false");
    pinBtn.title = effective ? "Unpin sidebar" : "Pin sidebar";
  }
  const s = $("sidebar");
  if(effective){
    if(s) s.classList.remove("open");
    toggleScrim(false);
  } else if(openFlyout){
    if(s) s.classList.add("open");
    toggleScrim(true);
  }
}

function toggleSidebarPin(){
  if(!canPinSidebar()) return;
  const current = document.body.classList.contains("sidebar-pinned");
  const next = !current;
  try{ localStorage.setItem(PIN_STORAGE_KEY, String(next)); }catch(e){}
  applySidebarState(next, !next);
}

// Initial synchronous execution to prevent CLS
applySidebarState(isSidebarPinnedPref(), false);

function generateUUID(){
  if(typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"){
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c){
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function draftKey(sessId){ return "hermes-uplink-draft-" + (sessId || "global"); }
function draftTurnKey(sessId){ return "hermes-uplink-turn-" + (sessId || "global"); }
function saveDraft(sessId, val, turnId){
  try{
    if(val && val.trim()){
      localStorage.setItem(draftKey(sessId), val);
      if(turnId) localStorage.setItem(draftTurnKey(sessId), turnId);
      else if(turnId === "") localStorage.removeItem(draftTurnKey(sessId));
    }else{
      localStorage.removeItem(draftKey(sessId));
      localStorage.removeItem(draftTurnKey(sessId));
    }
  }catch(e){}
}
function loadDraft(sessId){
  try{ return localStorage.getItem(draftKey(sessId)) || ""; }catch(e){ return ""; }
}
function loadDraftTurnId(sessId){
  try{ return localStorage.getItem(draftTurnKey(sessId)) || ""; }catch(e){ return ""; }
}
function reconcileDraftWithMessages(sessId, msgs){
  if(!sessId || !Array.isArray(msgs) || msgs.length === 0) return;
  const draft = loadDraft(sessId).trim();
  if(!draft) return;
  for(let i = msgs.length - 1; i >= 0; i--){
    const m = msgs[i];
    if(safeRole(m.role) === "user"){
      const userText = str(m.content).trim();
      if(userText && userText === draft){
        saveDraft(sessId, "");
        if(activeId === sessId){
          const inputEl = $("input");
          if(inputEl && inputEl.value.trim() === draft){
            inputEl.value = "";
            updateRingState();
          }
        }
      }
      break;
    }
  }
}

function showOfflineBanner(show, msg){
  const b = $("offlineBanner");
  if(!b) return;
  if(show){
    if(msg) $("offlineBannerText").textContent = msg;
    b.classList.remove("hidden");
  }else{
    b.classList.add("hidden");
  }
}

function loadCfg(){
  try{
    const value = JSON.parse(localStorage.getItem(LS_KEY));
    if(!value || typeof value !== "object") return {};
    if("key" in value || "url" in value){    // direct mode was removed: purge any stored API key
      delete value.key; delete value.url;
      try{ localStorage.setItem(LS_KEY, JSON.stringify(value)); }catch{}
    }
    return value;
  }catch{ return {} }
}
function saveCfg(){
  try{ localStorage.setItem(LS_KEY, JSON.stringify(cfg)); }catch{}
}
async function api(path, opts={}){
  return fetch(path, Object.assign({}, opts, {credentials:"same-origin"}));
}

/* ---------- auth gate ---------- */
function showAuth(message){
  const modal = $("authModal");
  $("authDiag").textContent = message || "";
  modal.classList.remove("hidden");
  $("authInput").focus();
}
function showToast(text, type="info"){
  const container = $("toastContainer");
  if(!container) return;
  const toast = document.createElement("div");
  toast.className = "toast" + (type ? " " + type : "");
  toast.textContent = String(text);
  container.appendChild(toast);
  requestAnimationFrame(()=>{ toast.classList.add("show"); });
  setTimeout(()=>{
    toast.classList.remove("show");
    setTimeout(()=>{ toast.remove(); }, 250);
  }, 3500);
}

async function ensureAuth(){
  try{
    const r = await api("/api/sessions?limit=1");
    showOfflineBanner(false);
    if(r.status !== 401) return true;
  }catch(e){
    setStatus("bad");
    showOfflineBanner(true, "⚠️ Offline — Cannot reach Uplink proxy. Reconnecting…");
    scheduleProbe();
    return false;
  }
  showAuth("Enter the passphrase shown on your desktop launcher.");
  return false;
}
async function submitAuth(){
  const v = $("authInput").value.trim();
  if(!v){ $("authDiag").textContent = "Enter the passphrase."; return; }
  const button = $("authSubmit");
  button.disabled = true;
  try{
    const r = await fetch("/__auth", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({passphrase:v}),
      credentials:"same-origin"
    });
    if(r.status===204){
      $("authInput").value = "";
      $("authModal").classList.add("hidden");
      showOfflineBanner(false);
      boot();
    }else if(r.status===429){
      $("authDiag").textContent = "Too many attempts. Wait briefly and try again.";
    }else if(r.status===401){
      $("authDiag").textContent = "Incorrect passphrase.";
    }else{
      $("authDiag").textContent = "Authentication service unavailable.";
    }
  }catch(e){
    $("authDiag").textContent = "Cannot reach the Uplink proxy.";
  }finally{
    button.disabled = false;
  }
}
$("authSubmit").onclick = submitAuth;
$("authInput").addEventListener("keydown", e=>{ if(e.key==="Enter") submitAuth(); });
async function logout(){
  try{ await fetch("/__logout", {method:"POST", credentials:"same-origin"}); }catch{}
  window.location.reload();
}

/* ---------- status dot + silent retry ---------- */
let retryTimer = null;
function setStatus(state){
  const d = $("statusDot");
  d.className = "dot " + (state==="ok"?"done":state==="bad"?"run":"");
  d.title = state==="ok" ? "Connected" : state==="bad" ? "Reconnecting…" : "Connecting…";
  d.setAttribute("aria-label", "Connection: " + d.title);
}
async function probe(){
  try{
    const r = await api("/health");
    const ok = r.ok;
    setStatus(ok ? "ok" : "bad");
    if(ok){
      showOfflineBanner(false);
      clearTimeout(retryTimer);
    } else {
      scheduleProbe();
    }
  }catch{
    setStatus("bad");
    scheduleProbe();
  }
}
function scheduleProbe(){
  clearTimeout(retryTimer);
  retryTimer = setTimeout(probe, 8000);
}

/* ---------- context ring ---------- */
function num(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
function setContext(used, limit){
  const ring = $("ring");
  if(!(limit > 0)){
    ring.style.setProperty("--pct", "0%");
    ring.style.setProperty("--ringFill", "var(--muted)");
    ring.title = "Context usage: unknown";
    return;
  }
  const pct = Math.max(0, Math.min(100, Math.round(used / limit * 100)));
  const fill = pct < 70 ? "var(--green)" : pct < 90 ? "var(--accent)" : "var(--red)";
  ring.style.setProperty("--pct", pct + "%");
  ring.style.setProperty("--ringFill", fill);
  ring.title = `Context: ${used} / ${limit} tokens (${pct}%)`;
}
function applyContextFrom(obj){
  if(!obj || typeof obj !== "object") return;
  const used = num(obj.context_used ?? obj.contextTokens ?? obj.tokens_used ?? obj.used_tokens);
  const limit = num(obj.context_window ?? obj.contextWindow ?? obj.max_tokens ?? obj.context_limit);
  if(limit > 0) setContext(used, limit);
}

/* ---------- ring (send/stop) state ---------- */
function updateRingState(){
  const ring = $("ring");
  const icon = $("ringIcon");
  if(streaming){
    icon.innerHTML = "&#9632;";            // ■ stop
    ring.classList.add("busy");
    ring.setAttribute("aria-label", "Stop");
    ring.disabled = false;
  }else{
    icon.innerHTML = "&#9654;";            // ▶ send
    ring.classList.remove("busy");
    ring.setAttribute("aria-label", "Send");
    ring.disabled = !$("input").value.trim();
  }
}


/* ---------- clarify interactive card support ---------- */
let activeClarifyId = null;
let activeRunId = null;          // run_id stamped on the active stream's frames (for POST /v1/runs/{id}/stop)
let lastFrameAt = 0;             // last real (non-comment) SSE frame, for the pending-clarify watchdog
let lastClarifyProbeAt = 0;
let probeClarifyAfterTurn = false;
const CLARIFY_STALE_MS = 45000;

function findClarifyCard(root, cid){
  return (root || document).querySelector(`.clarify-card[data-cid="${CSS.escape(String(cid))}"]`);
}

// Absolute deadline (ms epoch) from the server's created_at (epoch seconds) + timeout_seconds.
// No timeout from the server -> null (no countdown rather than a false "auto-resolves").
function clarifyDeadline(payload){
  const timeoutSec = Number(payload.timeout_seconds);
  if(!(timeoutSec > 0)) return null;
  const now = Date.now();
  let created = Number(payload.created_at);
  if(created > 0){
    if(created < 1e11) created *= 1000;            // seconds -> ms
    if(created > now) created = now;               // device clock behind the server: never show more than the full timeout
  } else {
    created = now;                                 // no created_at: count from render time
  }
  return created + timeoutSec * 1000;
}

function stripRecommended(text){
  if(typeof text !== "string") return text;
  return text.replace(/\s*\(Recommended\)\s*$/i, "").trim();
}

function renderClarifyCard(payload, bubble, opts){
  const target = bubble || $("thread");
  const cid = payload.clarify_id;
  // A card for a session the user is not looking at must not become the composer's pending clarify.
  const background = !!(opts && opts.background);
  if(!background) activeClarifyId = cid;

  const existing = findClarifyCard(target, cid);
  if(existing) return existing;

  const card = document.createElement("div");
  card.className = "clarify-card pending";
  card.dataset.cid = cid;
  card.dataset.sid = (bubble && bubble._stream && bubble._stream.sid) || activeId || "";

  const isBatch = Array.isArray(payload.questions) && payload.questions.length > 0;
  const deadline = clarifyDeadline(payload);

  // Header: Question
  const hdr = document.createElement("div");
  hdr.className = "clarify-hdr";

  const qTitle = document.createElement("div");
  qTitle.className = "clarify-q";
  qTitle.textContent = isBatch ? `The agent has ${payload.questions.length} question${payload.questions.length === 1 ? "" : "s"} for you`
                               : (payload.question || "Clarifying Question");
  hdr.appendChild(qTitle);

  card.appendChild(hdr);

  // Live countdown, only when the server reported a timeout. A single-question card stays answerable until
  // the server's clarify.settled frame retires it; a batch turns into a read-only summary at zero.
  card._stopTimer = ()=>{};
  const meta = (isBatch || deadline !== null) ? mountClarifyMeta(card, deadline, isBatch ? ()=>expireClarifyBatch(card) : null) : null;

  if(isBatch) buildClarifyBatch(card, payload, meta);
  else buildClarifySingle(card, payload);

  target.appendChild(card);
  card.dataset.mounted = "1";
  if(card.isConnected) maybeAutoscroll();
  if(card._afterMount) card._afterMount();
  return card;
}

function isRecommended(text){ return /\(recommended\)\s*$/i.test(text); }

// Lettered single-choice button shared by single and batch cards.
function choiceButton(choiceText, idx){
  const bare = stripRecommended(choiceText);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "clarify-choice-btn";
  const kbd = document.createElement("span");
  kbd.className = "clarify-kbd";
  kbd.textContent = String.fromCharCode(65 + idx);
  const lbl = document.createElement("span");
  lbl.textContent = bare;
  btn.append(kbd, lbl);
  if(isRecommended(choiceText)){
    const rec = document.createElement("span");
    rec.className = "clarify-rec";
    rec.textContent = "(Recommended)";
    btn.appendChild(rec);
  }
  return {btn, bare};
}

function choiceCheckRow(choiceText){
  const row = document.createElement("label");
  row.className = "clarify-check-row";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  const lbl = document.createElement("span");
  lbl.textContent = choiceText;
  row.append(cb, lbl);
  return {row, cb, bare: stripRecommended(choiceText)};
}

function otherTextarea(placeholder, rows){
  const ta = document.createElement("textarea");
  ta.className = "clarify-other-input";
  ta.placeholder = placeholder;
  ta.rows = rows;
  return ta;
}

// Stored answers are strings; pretty-print JSON arrays ("a, b") and JSON objects, optionally {answers:{...}}.
function formatClarifyAnswer(value){
  let text = String(value);
  if(text.startsWith("[") || text.startsWith("{")){
    try{
      let parsed = JSON.parse(text);
      if(parsed && typeof parsed === "object" && parsed.answers && typeof parsed.answers === "object") parsed = parsed.answers;
      if(Array.isArray(parsed)) text = parsed.join(", ");
      else if(parsed && typeof parsed === "object") text = Object.entries(parsed).map(([k, v])=>`${k}: ${v}`).join("; ");
    }catch{}
  }
  return text;
}

// Settled-card note for a clarify.settled outcome from the server.
function outcomeNote(outcome, batch){
  if(outcome === "submitted") return "Answered elsewhere";
  if(outcome === "timed_out") return batch ? "Timed out. The agent received the answers saved before then." : "Timed out (the agent was told it timed out)";
  if(outcome === "cancelled") return "Cancelled";
  return "Closed (answered elsewhere or expired)";
}

function buildClarifySingle(card, payload){
  const cid = card.dataset.cid;
  const isMulti = Boolean(payload.multi_select);
  const rawChoices = (payload.choices || []).map(String);
  const hasChoices = rawChoices.length > 0;
  const choices = document.createElement("div");
  choices.className = "clarify-choices";
  let selected = null;
  const multi = new Set();
  const other = otherTextarea(hasChoices ? "Other (type custom answer)..." : "Type your response here...", hasChoices ? 1 : 2);
  const clearSelection = ()=> choices.querySelectorAll(".clarify-choice-btn").forEach(x=>x.classList.remove("selected"));

  rawChoices.forEach((text, idx)=>{
    if(isMulti){
      const {row, cb, bare} = choiceCheckRow(text);
      cb.onchange = ()=>{ if(cb.checked) multi.add(bare); else multi.delete(bare); };
      choices.appendChild(row);
    } else {
      const {btn, bare} = choiceButton(text, idx);
      btn.onclick = ()=>{
        clearSelection();
        btn.classList.add("selected");
        selected = bare;
        other.value = "";
      };
      choices.appendChild(btn);
    }
  });
  if(hasChoices && !isMulti){
    other.onfocus = ()=>{ clearSelection(); selected = null; };
  }
  other.onkeydown = (e)=>{
    if(e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const ans = other.value.trim();
    if(ans){
      card._stopTimer();
      submitClarifyResponse(cid, ans, card);
    }
  };
  const otherWrap = document.createElement("div");
  otherWrap.className = "clarify-other-wrap";
  otherWrap.appendChild(other);
  choices.appendChild(otherWrap);

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "clarify-skip-btn";
  skipBtn.textContent = "Skip";
  skipBtn.onclick = ()=>{
    card._stopTimer();
    submitClarifyResponse(cid, "", card);
  };
  const subBtn = document.createElement("button");
  subBtn.type = "button";
  subBtn.className = "clarify-submit-btn";
  subBtn.textContent = "Submit";
  subBtn.onclick = ()=>{
    card._stopTimer();
    const typed = other.value.trim();
    let answer;
    if(isMulti){
      const list = Array.from(multi);
      if(typed) list.push(typed);
      answer = JSON.stringify(list);
    } else {
      answer = typed || selected || "";
    }
    submitClarifyResponse(cid, answer, card);
  };
  const actions = document.createElement("div");
  actions.className = "clarify-actions";
  actions.append(skipBtn, subBtn);
  card.append(choices, actions);
}

// A card is live while it is in the page or parked in a background stream's holder (see parkThread).
function cardAlive(card){ return !!card && (card.isConnected || !!card.closest("[data-parked]")); }
// The session a card belongs to (stamped at render time): a card answered or locked after the user switched
// sessions must still go to its own session.
function cardSid(card){ return (card && card.dataset && card.dataset.sid) || activeId; }
// Status line shared by single and batch cards: aria-live="polite", with the per-second countdown hidden from
// screen readers (aria-hidden) and announced only at 60/30/10 s and at expiry through a visually hidden twin.
function mountClarifyMeta(card, deadline, onExpire){
  const meta = document.createElement("div");
  meta.className = "clarify-meta";
  meta.setAttribute("aria-live", "polite");
  let timerInterval = null;
  card._stopTimer = ()=>{ if(timerInterval){ clearInterval(timerInterval); timerInterval = null; } };
  if(deadline !== null){
    const timerEl = document.createElement("div");
    timerEl.className = "clarify-timer";
    timerEl.setAttribute("aria-hidden", "true");
    const sr = document.createElement("span");
    sr.className = "sr-only";
    let lastMark = -1;
    const updateTimerText = ()=>{
      if(!cardAlive(card) && card.dataset.mounted){ card._stopTimer(); return; }
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const mark = remaining <= 0 ? 0 : remaining <= 10 ? 10 : remaining <= 30 ? 30 : remaining <= 60 ? 60 : -1;
      if(mark !== lastMark){
        lastMark = mark;
        if(mark === 0) sr.textContent = "This request has expired.";
        else if(mark > 0) sr.textContent = `About ${mark} seconds left to answer.`;
      }
      if(remaining <= 0){
        timerEl.textContent = onExpire ? "Time is up" : "Request expired (the agent was told it timed out)";
        card._stopTimer();
        if(onExpire) setTimeout(onExpire, 0);
      } else {
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        timerEl.textContent = `Expires in ${m}:${s < 10 ? '0' : ''}${s}`;
      }
    };
    updateTimerText();
    if(deadline > Date.now()) timerInterval = setInterval(updateTimerText, 1000);
    meta.append(timerEl, sr);
  }
  card.appendChild(meta);
  return meta;
}

/* ---- batch card: all questions stacked, any order, each locked server-side as it is answered ---- */
// payload.batch === true  -> POST /clarify/lock per question, final POST /clarify/respond {answers:{qid:string|null}}.
// questions without batch:true (older gateway) -> same UI, no locking, one respond {answer: JSON {answers}}.
function buildClarifyBatch(card, payload, meta){
  const cid = card.dataset.cid;
  const proto = payload.batch === true;
  const qs = payload.questions.map((q, i)=>({
    qid: String((q && q.qid != null) ? q.qid : "q" + i),
    question: String((q && q.question != null) ? q.question : ""),
    choices: (q && Array.isArray(q.choices)) ? q.choices.map(String) : [],
    multi: Boolean(q && q.multi_select),
  }));
  const confirmed = {};                       // qid -> answer string|null the server is known to hold
  const locked = (payload.locked && typeof payload.locked === "object") ? payload.locked : {};
  const S = {};                               // qid -> {single, multi:Set, text, skipped}
  const U = {};                               // qid -> DOM refs
  const L = {};                               // qid -> lock bookkeeping
  const uid = "cq" + Math.random().toString(36).slice(2, 8);
  let submitting = false, closed = false;

  const valueOf = (q)=>{
    const st = S[q.qid];
    if(st.skipped) return null;
    const text = st.text.trim();
    if(q.multi){
      const list = q.choices.map(stripRecommended).filter(c=>st.multi.has(c));
      if(text) list.push(text);
      return list.length ? JSON.stringify(list) : null;
    }
    return text || st.single || null;
  };
  const answersMap = ()=>{ const o = {}; qs.forEach(q=>{ o[q.qid] = valueOf(q); }); return o; };
  card._batch = {questions: qs, answers: answersMap, confirmed, proto, get submitting(){ return submitting; }};

  const list = document.createElement("div");
  list.className = "clarify-batch-list";
  const statusEl = document.createElement("span");
  statusEl.className = "clarify-status";
  meta.appendChild(statusEl);

  const submitBtn = document.createElement("button");
  const updateStatus = ()=>{
    let ans = 0, skp = 0, saving = false, bad = false;
    qs.forEach(q=>{
      const v = valueOf(q);
      if(S[q.qid].skipped) skp++; else if(v !== null) ans++;
      if(L[q.qid].timer || L[q.qid].inflight) saving = true;
      if(L[q.qid].err) bad = true;
    });
    let t = `${ans} of ${qs.length} answered` + (skp ? `, ${skp} skipped` : "");
    if(proto){ t += saving ? " · saving…" : bad ? " · not saved yet (sent on submit)" : (ans || skp) ? " · saved" : ""; }
    statusEl.textContent = t;
    submitBtn.disabled = submitting || (ans + skp === 0);
  };
  const setSaved = (q, kind)=>{
    const el = U[q.qid].saved;
    el.classList.toggle("err", kind === "err");
    el.textContent = kind === "saving" ? "Saving…" : kind === "saved" ? "Saved" : kind === "err" ? "Not saved yet (sent on submit)" : "";
  };

  // Lock bookkeeping: one request in flight per question; edits made meanwhile re-lock afterwards (last write wins).
  const sendLock = async (q)=>{
    const ls = L[q.qid];
    if(ls.timer){ clearTimeout(ls.timer); ls.timer = null; }
    if(!proto || closed || submitting) return;
    if(ls.inflight){ ls.dirty = true; return; }
    ls.inflight = true; ls.dirty = false;
    const val = valueOf(q);
    setSaved(q, "saving"); updateStatus();
    try{
      const res = await api("/api/sessions/" + encodeURIComponent(cardSid(card)) + "/clarify/lock", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({clarify_id: cid, qid: q.qid, answer: val})
      });
      if(res.status === 409){ closed = true; if(activeClarifyId === cid) activeClarifyId = null; settleClarifyCard(cid, "", card, "expired"); return; }
      if(!res.ok) throw new Error("Status " + res.status);
      const j = await res.json().catch(()=>null);
      if(j && j.locked && typeof j.locked === "object") Object.assign(confirmed, j.locked); else confirmed[q.qid] = val;   // server's view is authoritative
      ls.err = false;
      setSaved(q, ls.dirty ? "saving" : "saved");
    }catch(e){
      ls.err = true; setSaved(q, "err");       // non-fatal: the final submit carries every answer anyway
    }finally{
      ls.inflight = false;
      if(ls.dirty && !closed && !submitting) sendLock(q); else if(!closed) updateStatus();
    }
  };
  const scheduleLock = (q, delay)=>{
    if(!proto) return;
    const ls = L[q.qid];
    if(ls.timer) clearTimeout(ls.timer);
    setSaved(q, "saving");
    ls.timer = setTimeout(()=>sendLock(q), delay);
  };

  const refresh = (q)=>{
    const st = S[q.qid], ui = U[q.qid];
    ui.btns.forEach(b=>{ const on = !st.skipped && st.single === b.bare; b.el.classList.toggle("selected", on); b.el.setAttribute("aria-pressed", on ? "true" : "false"); });
    ui.checks.forEach(c=>{ c.el.checked = !st.skipped && st.multi.has(c.bare); });
    ui.skip.textContent = st.skipped ? "Undo skip" : "Skip";
    ui.skip.setAttribute("aria-pressed", st.skipped ? "true" : "false");
    ui.sec.classList.toggle("skipped", st.skipped);
    ui.sec.classList.toggle("answered", !st.skipped && valueOf(q) !== null);
    updateStatus();
  };

  qs.forEach((q, i)=>{
    S[q.qid] = {single: null, multi: new Set(), text: "", skipped: false};
    L[q.qid] = {timer: null, inflight: false, dirty: false, err: false};
    const st = S[q.qid];
    const ui = U[q.qid] = {btns: [], checks: []};

    // Pre-fill from what the server already holds (card recovered through /pending)
    if(Object.prototype.hasOwnProperty.call(locked, q.qid)){
      const lv = locked[q.qid];
      confirmed[q.qid] = lv == null ? null : String(lv);
      if(lv == null) st.skipped = true;
      else {
        const bares = q.choices.map(stripRecommended);
        if(q.multi){
          let arr = null;
          try{ const p = JSON.parse(String(lv)); if(Array.isArray(p)) arr = p.map(String); }catch{}
          const rest = [];
          (arr || [String(lv)]).forEach(v=>{ if(bares.includes(v)) st.multi.add(v); else rest.push(v); });
          st.text = rest.join(", ");
        } else if(bares.includes(String(lv))) st.single = String(lv);
        else st.text = String(lv);
      }
    }

    const sec = document.createElement("div");
    sec.className = "clarify-qcard";
    sec.dataset.qid = q.qid;
    sec.setAttribute("role", "group");
    sec.tabIndex = -1;
    const titleId = `${uid}-${i}`;
    sec.setAttribute("aria-labelledby", titleId);
    ui.sec = sec;

    const head = document.createElement("div");
    head.className = "clarify-qhead";
    const title = document.createElement("div");
    title.className = "clarify-qtitle";
    title.id = titleId;
    title.textContent = `${i + 1}. ${q.question}`;
    head.appendChild(title);
    sec.appendChild(head);

    const ch = document.createElement("div");
    ch.className = "clarify-choices";
    q.choices.forEach((choiceText, idx)=>{
      if(!q.multi){
        const {btn, bare} = choiceButton(choiceText, idx);
        btn.onclick = ()=>{
          st.skipped = false;
          if(st.single === bare){ st.single = null; }         // tap again to clear
          else { st.single = bare; st.text = ""; ui.other.value = ""; }
          refresh(q); scheduleLock(q, 0);
        };
        ui.btns.push({el: btn, bare});
        ch.appendChild(btn);
      } else {
        const {row, cb, bare} = choiceCheckRow(choiceText);
        cb.onchange = ()=>{
          st.skipped = false;
          if(cb.checked) st.multi.add(bare); else st.multi.delete(bare);
          refresh(q); scheduleLock(q, 0);
        };
        ui.checks.push({el: cb, bare});
        ch.appendChild(row);
      }
    });
    if(q.choices.length) sec.appendChild(ch);

    const other = otherTextarea(q.choices.length ? "Other (type your own answer)" : "Type your answer", 1);
    other.setAttribute("aria-label", q.choices.length ? `Other answer for question ${i + 1}` : `Answer for question ${i + 1}`);
    other.value = st.text;
    other.oninput = ()=>{
      st.text = other.value;
      if(st.text.trim()){ st.skipped = false; if(!q.multi) st.single = null; }
      refresh(q); scheduleLock(q, 700);
    };
    other.onblur = ()=>{ if(L[q.qid].timer) sendLock(q); };
    ui.other = other;
    sec.appendChild(other);

    const foot = document.createElement("div");
    foot.className = "clarify-qfoot";
    const saved = document.createElement("span");
    saved.className = "clarify-saved";
    ui.saved = saved;
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "clarify-skip-btn";
    skip.onclick = ()=>{
      st.skipped = !st.skipped;
      if(st.skipped){ st.single = null; st.multi.clear(); st.text = ""; other.value = ""; }
      refresh(q); scheduleLock(q, 0);
    };
    ui.skip = skip;
    foot.append(saved, skip);
    sec.appendChild(foot);
    list.appendChild(sec);
  });

  const bar = document.createElement("div");
  bar.className = "clarify-batch-bar";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "clarify-skip-btn clarify-cancel-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = ()=>submitClarifyBatch(card, "cancel");
  submitBtn.type = "button";
  submitBtn.className = "clarify-submit-btn";
  submitBtn.textContent = "Submit answers";
  submitBtn.onclick = ()=>submitClarifyBatch(card, "submit");
  bar.append(cancelBtn, submitBtn);
  card.append(list, bar);

  card._batch.setSubmitting = (v)=>{
    submitting = v;
    qs.forEach(q=>{ const ls = L[q.qid]; if(v && ls.timer){ clearTimeout(ls.timer); ls.timer = null; } });
    submitBtn.textContent = v ? "Submitting…" : "Submit answers";
    cancelBtn.disabled = v;
    updateStatus();
  };
  card._batch.close = ()=>{ closed = true; qs.forEach(q=>{ if(L[q.qid].timer) clearTimeout(L[q.qid].timer); }); };
  qs.forEach(refresh);
  // Focus the first unanswered question (a section, not an input, so no on-screen keyboard pops up) unless the
  // user is typing in the composer.
  card._afterMount = ()=>{
    const ae = document.activeElement;
    if(ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT") && ae.value) return;
    const first = qs.find(q=>valueOf(q) === null && !S[q.qid].skipped) || qs[0];
    try{ U[first.qid].sec.focus(); }catch{}
  };
}

function expireClarifyBatch(card){
  if(!card || !cardAlive(card) || !card.classList.contains("pending")) return;
  if(card._batch && card._batch.submitting) return;
  if(activeClarifyId === card.dataset.cid) activeClarifyId = null;
  settleClarifyCard(card.dataset.cid, "", card, "timeout");
}

async function submitClarifyBatch(card, mode){
  const B = card._batch, cid = card.dataset.cid;
  if(!B || B.submitting) return;
  B.setSubmitting(true);
  card.classList.add("submitting");
  let body;
  if(B.proto) body = mode === "cancel" ? {clarify_id: cid, outcome: "cancelled"} : {clarify_id: cid, answers: B.answers()};
  else body = {clarify_id: cid, answer: mode === "cancel" ? "" : JSON.stringify({answers: B.answers()})};
  try{
    card._stopTimer();
    const res = await api("/api/sessions/" + encodeURIComponent(cardSid(card)) + "/clarify/respond", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)
    });
    if(res.status === 409 || res.status === 404){ settleClarifyCard(cid, "", card, "expired"); return; }
    if(!res.ok){
      const err = await res.json().catch(()=>({}));
      throw new Error(err.error?.message || "Status " + res.status);
    }
    settleClarifyCard(cid, "", card, mode === "cancel" ? "cancelled" : "submitted");
  }catch(e){
    B.setSubmitting(false);
    card.classList.remove("submitting");
    showToast("Could not submit answers: " + e.message, "error");
  }finally{
    if(activeClarifyId === cid && !card.classList.contains("submitting")) activeClarifyId = null;
  }
}

// Empty a card and give it the settled frame and its question title.
function startSettledCard(card, className, fallbackTitle){
  const title = card.querySelector(".clarify-q")?.textContent || fallbackTitle;
  card.className = className;
  card.replaceChildren();
  const hdr = document.createElement("div");
  hdr.className = "clarify-hdr";
  const qEl = document.createElement("div");
  qEl.className = "clarify-q";
  qEl.textContent = title;
  hdr.appendChild(qEl);
  card.appendChild(hdr);
}

// Read-only summary of a batch: the final answers after submit, otherwise what the server holds (locked).
function settleClarifyBatch(card, state, info){
  const B = card._batch;
  if(B.close) B.close();
  startSettledCard(card, "clarify-card clarify-batch settled", "Questions");

  const live = document.createElement("div");
  live.className = "clarify-answer";
  live.setAttribute("aria-live", "polite");
  const note = document.createElement("span");
  note.className = "clarify-ans-skipped";
  let rows = B.confirmed, showRows = true;
  if(state === "submitted"){ note.textContent = "Answers sent"; rows = B.answers(); }
  else if(state === "cancelled"){ note.textContent = "Cancelled (no answers sent)"; showRows = false; }
  else if(state === "timeout") note.textContent = B.proto ? "Time ran out. The agent received the answers saved before then." : "Time ran out (the agent was told it timed out)";
  else if(state === "expired") note.textContent = "Already answered or expired" + (B.proto ? ". Showing the answers that were saved." : "");
  else note.textContent = outcomeNote(info && info.outcome, true);
  live.appendChild(note);
  card.appendChild(live);
  if(showRows){
    B.questions.forEach((q, i)=>{
      const row = document.createElement("div");
      row.className = "clarify-sum-row";
      const qe = document.createElement("div");
      qe.className = "clarify-sum-q";
      qe.textContent = `${i + 1}. ${q.question}`;
      const ae = document.createElement("div");
      const v = rows[q.qid];
      if(v == null || !String(v).trim()){
        ae.className = "clarify-sum-a clarify-ans-skipped";
        ae.textContent = (state === "submitted" || Object.prototype.hasOwnProperty.call(rows, q.qid)) ? "Skipped" : "No answer";
      } else {
        ae.className = "clarify-sum-a";
        ae.textContent = formatClarifyAnswer(v);
      }
      row.append(qe, ae);
      card.appendChild(row);
    });
  }
}

/* ---------- gateway capabilities (feature gate for client_capabilities) ---------- */
// GET /v1/capabilities is fetched in the background; chatting never waits for it. Until it answers (or if it
// fails or lacks the flags) both capabilities are assumed supported, so old and new gateways both work.
let gatewayCaps = null, gatewayCapsRequested = false, gatewayCapsRetryAt = 0;
async function loadGatewayCaps(){
  if(gatewayCapsRequested || Date.now() < gatewayCapsRetryAt) return;
  gatewayCapsRequested = true;
  const ctrl = new AbortController();
  const to = setTimeout(()=>ctrl.abort(), 4000);
  try{
    const r = await api("/v1/capabilities", {signal: ctrl.signal});
    if(!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    gatewayCaps = (d && typeof d === "object") ? d : null;
  }catch{
    gatewayCaps = null; gatewayCapsRequested = false; gatewayCapsRetryAt = Date.now() + 60000;
  }finally{ clearTimeout(to); }
}
function clientCapabilities(){
  const d = gatewayCaps;
  if(!d) return ["clarify", "clarify_batch"];
  const f = (d.features && typeof d.features === "object") ? d.features : {};
  const ep = (d.endpoints && typeof d.endpoints === "object") ? d.endpoints : null;
  // clarify_batch implies clarify; a gateway that advertises clarify without the lock endpoint has no batch.
  const clarify = f.clarify_batch === true || (f.clarify !== false && (f.clarify === true || !ep || !!ep.session_clarify_respond));
  if(!clarify) return [];
  const batch = f.clarify_batch === true || (f.clarify_batch !== false && !(f.clarify === true && !(ep && ep.session_clarify_lock)));
  return batch ? ["clarify", "clarify_batch"] : ["clarify"];
}

async function submitClarifyResponse(clarifyId, answer, cardEl){
  if(cardEl) cardEl.classList.add("submitting");
  try{
    const res = await api("/api/sessions/" + encodeURIComponent(cardSid(cardEl)) + "/clarify/respond", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({clarify_id: clarifyId, answer: answer})
    });
    if(!res.ok){
      const err = await res.json().catch(()=>({}));
      if(res.status === 409 || res.status === 404){
        // Already answered elsewhere, or the request expired (the model got "timed_out"): do NOT
        // present the user's answer as accepted.
        settleClarifyCard(clarifyId, "", cardEl, "expired");
        return;
      }
      throw new Error(err.error?.message || "Status " + res.status);
    }
    settleClarifyCard(clarifyId, answer, cardEl);
  }catch(e){
    if(cardEl) cardEl.classList.remove("submitting");
    showToast("Could not submit clarify response: " + e.message, "error");
  }finally{
    if(activeClarifyId === clarifyId) activeClarifyId = null;
  }
}

// state: "answered" (default) | "expired" (409 / timed out) | "closed" (clarify.settled from the server).
function settleClarifyCard(clarifyId, answerText, targetOrBubble, state, info){
  const cid = clarifyId || "";
  const root = targetOrBubble || $("thread");
  let card = null;
  if(root.matches && root.matches(".clarify-card")) card = root;
  else if(state === "closed") card = findClarifyCard(root, cid);   // never settle an unrelated card
  else card = findClarifyCard(root, cid) || root.querySelector(".clarify-card.pending");
  if(!card) return;
  // A server-side settle must not overwrite a card the user already answered.
  if(state === "closed" && !card.classList.contains("pending") && !card.classList.contains("submitting")) return;
  // Our own submit is in flight: its response settles the card, not the server's echo of it.
  if(state === "closed" && card._batch && card._batch.submitting) return;
  if(card._stopTimer) card._stopTimer();
  if(card._batch){ settleClarifyBatch(card, state || "answered", info); return; }

  startSettledCard(card, "clarify-card settled", "Clarifying Question");

  const ansRow = document.createElement("div");
  ansRow.className = "clarify-answer";

  if(state === "expired" || state === "closed"){
    const note = document.createElement("span");
    note.className = "clarify-ans-skipped";
    note.textContent = state === "expired" ? "Already answered or expired" : outcomeNote(info && info.outcome, false);
    ansRow.appendChild(note);
    card.appendChild(ansRow);
    return;
  }

  const text = answerText ? stripRecommended(formatClarifyAnswer(answerText).trim()) : "";

  if(text){
    const badge = document.createElement("span");
    badge.className = "clarify-ans-badge";
    badge.textContent = "Answer";
    const val = document.createElement("span");
    val.textContent = text;
    ansRow.append(badge, " ", val);
  } else {
    const skipped = document.createElement("span");
    skipped.className = "clarify-ans-skipped";
    skipped.textContent = "Skipped (agent decided)";
    ansRow.appendChild(skipped);
  }
  card.appendChild(ansRow);
}

// Scoped keyboard hotkey listener for clarify
window.addEventListener("keydown", (e)=>{
  if(e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
  const activeEl = document.activeElement;
  if(activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" || activeEl.isContentEditable)) return;
  const activeCard = document.querySelector(".clarify-card.pending");
  if(!activeCard || activeCard.classList.contains("clarify-batch") || activeCard._batch) return;   // batch cards: tap/click only

  const choices = activeCard.querySelectorAll(".clarify-choice-btn");
  if(!choices.length) return;

  const k = e.key.toLowerCase();
  const idx = /^[1-9]$/.test(k) ? Number(k) - 1 : /^[a-z]$/.test(k) ? k.charCodeAt(0) - 97 : -1;
  if(idx >= 0){
    if(idx < choices.length){
      e.preventDefault();
      choices[idx].click();
    }
    return;
  }
  if(e.key === "Enter"){
    const subBtn = activeCard.querySelector(".clarify-submit-btn");
    if(subBtn && !subBtn.disabled){
      e.preventDefault();
      subBtn.click();
    }
  }
});

// Mobile Reconnection / Active Focus Probe
// While a stream is live and delivering frames the card arrives on it; once it has been silent for
// CLARIFY_STALE_MS (lost frame, dropped connection, mobile suspend) probe the server instead.
async function probePendingClarify(){
  if(!activeId) return;
  if(streaming && Date.now() - lastFrameAt < CLARIFY_STALE_MS) return;
  lastClarifyProbeAt = Date.now();
  try{
    const r = await api("/api/sessions/" + encodeURIComponent(activeId) + "/clarify/pending");
    if(r.ok){
      const data = await r.json();
      if(data.pending && data.clarify){
        const existing = findClarifyCard(document, data.clarify.clarify_id);
        if(!existing){
          const bubbles = $("thread").querySelectorAll(".msg.assistant");
          const bubble = bubbles[bubbles.length - 1] || $("thread");
          renderClarifyCard(data.clarify, bubble);
        }
      }
    }
  }catch{}
}
/* ---------- model & provider selection ---------- */
const MODEL_CACHE_KEY = "hermes-uplink-model-options";
let modelOptions = null;
let currentSessionModel = null;
let currentSessionProvider = null;

function loadCachedModelOptions(){
  try{
    const raw = localStorage.getItem(MODEL_CACHE_KEY);
    if(raw){
      modelOptions = JSON.parse(raw);
    }
  }catch(e){}
}

async function fetchModelOptions(force = false){
  try{
    const chip = $("modelChip");
    if(!modelOptions && chip) chip.classList.add("loading");
    const r = await api("/api/model/options");
    if(chip) chip.classList.remove("loading");
    if(!r.ok) return;
    const data = await r.json();
    if(data && typeof data === "object"){
      modelOptions = data;
      try{ localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify(data)); }catch(e){}
      updateModelChip(currentSessionModel, currentSessionProvider);
      const modal = $("modelModal");
      if(modal && !modal.classList.contains("hidden")){
        const searchVal = $("modelSearchInput").value || "";
        renderModelList(searchVal);
      }
    }
  }catch(e){
    const chip = $("modelChip");
    if(chip) chip.classList.remove("loading");
  }
}

function formatModelName(modelStr){
  if(!modelStr) return "";
  const parts = String(modelStr).split("/");
  return parts[parts.length - 1];
}
// Allow the narrow (two-line) chip to wrap at meaningful boundaries only: after - _ . : in the name.
function softWrapModelName(name){
  return String(name).replace(/([-_.:])(?=[^-_.:])/g, "$1\u200b");
}

function updateModelChip(modelName, providerName){
  const chip = $("modelChip");
  const textEl = $("modelChipText");
  const provEl = $("modelChipProv");
  if(!chip || !textEl) return;
  const activeModel = modelName || cfg.defaultModel || (modelOptions && modelOptions.model);
  const activeProv = providerName || cfg.defaultProvider || (modelOptions && modelOptions.provider);
  if(activeModel){
    textEl.textContent = softWrapModelName(formatModelName(activeModel));
    chip.title = "Active Model: " + activeModel + (activeProv ? " (" + activeProv + ")" : "") + (modelName ? "" : " [Default]") + "\nClick to switch";
    if(provEl) provEl.textContent = (activeProv || "") + (modelName ? "" : (activeProv ? " · default" : "default"));
    chip.setAttribute("aria-label", "Model " + activeModel + (activeProv ? ", provider " + activeProv : "") + (modelName ? "" : ", default") + ". Opens model picker");
  } else {
    textEl.textContent = "Model";
    chip.title = "Select Model / Provider";
    if(provEl) provEl.textContent = "";
    chip.setAttribute("aria-label", "Select model and provider");
  }
}

function openModelModal(){
  const modal = $("modelModal");
  if(!modal) return;
  $("modelDiag").textContent = "";
  const search = $("modelSearchInput");
  search.value = "";
  $("modelSetDefault").checked = Boolean(cfg.defaultModel);
  $("modelCustomWrap").classList.add("hidden");
  modal.classList.remove("hidden");
  search.focus();
  renderModelList("");
  fetchModelOptions(true);
}

function closeModelModal(){
  const modal = $("modelModal");
  if(modal) modal.classList.add("hidden");
}

function renderModelList(filterText = ""){
  const container = $("modelListContainer");
  if(!container) return;
  container.replaceChildren();

  const q = String(filterText || "").trim().toLowerCase();
  const currentActive = currentSessionModel || cfg.defaultModel || (modelOptions && modelOptions.model) || "";

  let exactMatchFound = false;
  const providers = (modelOptions && Array.isArray(modelOptions.providers)) ? modelOptions.providers : [];

  if(q){
    for(const p of providers){
      for(const m of (p.models || [])){
        if(String(m).toLowerCase() === q || String(m).toLowerCase().endsWith("/" + q)){
          exactMatchFound = true;
          break;
        }
      }
      if(exactMatchFound) break;
    }
  }

  if(q && !exactMatchFound){
    const customCard = document.createElement("div");
    customCard.className = "model-custom-item";
    const left = document.createElement("span");
    left.textContent = "⚡ Use custom model: \"" + filterText + "\"";
    const right = document.createElement("span");
    right.className = "model-custom-action";
    right.textContent = "Select →";
    customCard.append(left, right);
    customCard.onclick = ()=>{
      const isSetDef = $("modelSetDefault").checked;
      applyModel(filterText.trim(), "", isSetDef);
    };
    container.appendChild(customCard);
  }

  if(!providers.length){
    if(!q){
      container.appendChild(messageElement("Loading or no providers reported. Use manual custom model below."));
    }
    return;
  }

  let totalRendered = 0;

  for(const p of providers){
    const pName = String(p.name || p.slug || "Provider");
    const pSlug = String(p.slug || "");
    const allModels = Array.isArray(p.models) ? p.models : [];

    const matchedModels = allModels.filter(m => {
      if(!q) return true;
      const mStr = String(m).toLowerCase();
      return mStr.includes(q) || pName.toLowerCase().includes(q) || pSlug.toLowerCase().includes(q);
    });

    if(!matchedModels.length) continue;
    totalRendered += matchedModels.length;

    const group = document.createElement("div");
    group.className = "model-provider-group";

    const hdr = document.createElement("div");
    hdr.className = "model-provider-hdr";
    const hdrTitle = document.createElement("span");
    hdrTitle.textContent = pName;
    const hdrBadge = document.createElement("span");
    hdrBadge.className = "model-provider-badge";
    hdrBadge.textContent = matchedModels.length + " models";
    hdr.append(hdrTitle, hdrBadge);

    const itemsContainer = document.createElement("div");
    itemsContainer.className = "model-items";

    hdr.onclick = ()=>{
      group.classList.toggle("collapsed");
    };

    for(const m of matchedModels){
      const mStr = String(m);
      const item = document.createElement("div");
      const isItemActive = Boolean(currentActive && (currentActive === mStr || currentActive === pSlug + "/" + mStr));
      item.className = "model-item" + (isItemActive ? " active" : "");

      const nameEl = document.createElement("span");
      nameEl.className = "model-item-name";
      nameEl.textContent = mStr;

      const metaEl = document.createElement("div");
      metaEl.className = "model-item-meta";

      const pricing = p.pricing && p.pricing[mStr];
      if(pricing){
        const priceBadge = document.createElement("span");
        if(pricing.free || mStr.endsWith(":free")){
          priceBadge.className = "model-price-badge free";
          priceBadge.textContent = "free";
        } else if(pricing.input && pricing.output){
          priceBadge.className = "model-price-badge";
          priceBadge.textContent = pricing.input + "/" + pricing.output;
        }
        if(priceBadge.textContent) metaEl.appendChild(priceBadge);
      } else if(mStr.endsWith(":free")){
        const priceBadge = document.createElement("span");
        priceBadge.className = "model-price-badge free";
        priceBadge.textContent = "free";
        metaEl.appendChild(priceBadge);
      }

      if(isItemActive){
        const check = document.createElement("span");
        check.className = "model-active-check";
        check.textContent = "✓";
        metaEl.appendChild(check);
      }

      item.append(nameEl, metaEl);
      item.onclick = ()=>{
        const isSetDef = $("modelSetDefault").checked;
        applyModel(mStr, pSlug, isSetDef);
      };
      itemsContainer.appendChild(item);
    }

    group.append(hdr, itemsContainer);
    container.appendChild(group);
  }

  if(totalRendered === 0 && !exactMatchFound){
    container.appendChild(messageElement("No matching models found."));
  }
}

async function applyModel(model, provider, setDefault = false){
  const diag = $("modelDiag");
  if(diag) diag.textContent = "Applying model…";
  try{
    if(activeId){
      const res = await api("/api/sessions/" + encodeURIComponent(activeId) + "/model", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({model: model, provider: provider || ""})
      });
      if(!res.ok){
        const err = await res.json().catch(()=>({}));
        throw new Error(err.error?.message || "HTTP " + res.status);
      }
      currentSessionModel = model;
      currentSessionProvider = provider || null;
    }
    if(setDefault || !activeId){
      cfg.defaultModel = model;
      cfg.defaultProvider = provider || "";
      saveCfg();
    }
    updateModelChip(currentSessionModel || model, currentSessionProvider || provider);
    closeModelModal();
  }catch(e){
    if(diag) diag.textContent = "Failed to switch model: " + (e.message || e);
    else showToast("Failed to switch model: " + (e.message || e), "error");
  }
}

/* ---------- boot ---------- */
let booted = false;
function boot(){
  if(booted) return;
  booted = true;
  probe();
  loadGatewayCaps();
  loadSessions();
  updateRingState();
  loadSkills();
  loadTools();
  loadCachedModelOptions();
  fetchModelOptions();
  updateModelChip(currentSessionModel, currentSessionProvider);
}

/* ---------- manual / on-focus refresh ----------
   We deliberately do NOT run a background poller (battery). Instead we refresh
   whenever the user (a) clicks the refresh button, or (b) returns to this tab /
   focuses the window. With the shared session store, this makes both edge devices
   converge within a second of you actually looking at the app — which matches the
   "switch devices a few times a day" pattern. */
let refreshing = false;
function historyMessages(data){ return data.data || data.messages || (Array.isArray(data) ? data : []); }
// `manual` is truthy for the Refresh button (it passes its click event); focus / visibility / online call it bare.
async function refresh(manual){
  if(refreshing) return;
  if(streaming && streamingSessionId === activeId){
    await loadSessions();
    return;
  }
  if(!activeId) { await loadSessions(); return; }
  // The thread shows a finished turn's cards / "[stopped]" that history cannot reproduce: a passive refresh keeps it.
  if(!manual && localThread.has(activeId)){
    await loadSessions();
    return;
  }
  refreshing = true;
  const id = activeId;
  const btn = $("refreshBtn");
  btn.classList.add("busy-dim");
  try{
    await loadSessions();
    const data = await fetchHistory(id);
    if(activeId !== id) return;
    applyContextFrom(data);
    const msgs = historyMessages(data);
    renderThread(msgs);
    reconcileDraftWithMessages(id, msgs);
    markRead(id, "refresh");   // visible + freshly loaded; rate limited
  }catch(e){
    setStatus("bad");
  }finally{
    btn.classList.remove("busy-dim");
    refreshing = false;
  }
}
document.addEventListener("visibilitychange", ()=>{ if(!document.hidden){ refresh(); probePendingClarify(); } });
window.addEventListener("focus", ()=>{ refresh(); probePendingClarify(); });

/* ---------- unread state (shared read watermark; see docs/mobile-edge-ux-and-session-status-spec.md) ---------- */
// Backend: sessions rows carry `unread` (activity newer than the shared last_read_at); PATCH {unread:false} stamps it.
// A just-written local value outranks a list page for UNREAD_WRITE_GUARD_MS (mirrors Electron's write guard) so a stale
// page cannot flip a just-read session back to unread. Absent `unread` (older backend) renders nothing.
const UNREAD_WRITE_GUARD_MS = 10000;
const READ_MARK_MIN_INTERVAL_MS = 10000;
const unreadGuard = new Map();   // id -> {value:boolean, at:ms}
const lastReadMark = new Map();  // id -> ms of last write (rate limit for passive triggers)
let lastSessionRows = [];
function effectiveUnread(s){
  const g = unreadGuard.get(s.id);
  if(g && Date.now() - g.at < UNREAD_WRITE_GUARD_MS) return g.value;
  return s.unread === true;
}
function updateDrawerDot(){
  const btn = $("menuBtn");
  if(!btn) return;
  const has = lastSessionRows.some(s=> s.id !== activeId && effectiveUnread(s)) || Array.from(attention.keys()).some(id=> id !== activeId);
  btn.classList.toggle("has-attn", has);
  btn.setAttribute("aria-label", has ? "Sessions — another session has unread messages" : "Sessions");
}
function clearRowUnread(id){
  document.querySelectorAll(".sess").forEach(x=>{
    if(x.dataset.sid !== id) return;
    x.classList.remove("unread");
    const b = x.querySelector(".badge.unread"); if(b) b.remove();
  });
}
// reason: "open"/"completion" always write (user-visible acknowledgement); passive triggers are rate limited.
async function markRead(id, reason){
  if(!id || document.visibilityState !== "visible") return;
  const passive = reason !== "open" && reason !== "completion";
  const now = Date.now();
  if(passive && (streaming || now - (lastReadMark.get(id) || 0) < READ_MARK_MIN_INTERVAL_MS)) return;
  lastReadMark.set(id, now);
  unreadGuard.set(id, {value:false, at:now});
  clearRowUnread(id); updateDrawerDot();
  try{
    const r = await api("/api/sessions/"+encodeURIComponent(id), {
      method:"PATCH", headers:{"Content-Type":"application/json"}, body: JSON.stringify({unread:false})
    });
    if(!r.ok) throw new Error("HTTP "+r.status);
  }catch(e){
    unreadGuard.delete(id); lastReadMark.delete(id);   // write failed: do not pretend it was read
  }
}

/* ---------- sessions ---------- */
async function loadSessions(){
  const el = $("sessionList");
  const hasExisting = el.querySelector(".sess");
  if(!hasExisting) showLoading(el);
  try{
    const r = await api("/api/sessions?limit=200&include_children=true");
    if(r.status === 401){ showAuth("Your browser session expired. Enter the passphrase again."); return; }
    if(!r.ok) throw new Error("HTTP "+r.status);
    const data = await r.json();
    const sessions = Array.isArray(data) ? data : (data.sessions||data.data||[]);
    renderSessions(sessions);
  }catch(e){
    if(!hasExisting) showError(el, "Failed to load sessions: "+(e.message||e));
    else setStatus("bad");
  }
}

function renderSessions(sessions){
  // Internal delegate children are not ordinary conversations; the API marks them (is_internal_child).
  sessions = sessions.filter(s=> !(s && s.is_internal_child === true));
  lastSessionRows = sessions;
  updateDrawerDot();
  const el = $("sessionList");
  const q = ($("searchInput").value||"").toLowerCase();
  el.replaceChildren();
  if(!sessions.length){ el.appendChild(messageElement("No sessions.")); return; }
  const sorted = sessions.slice().sort((a,b)=> (b.updated_at||b.last_active||0)-(a.updated_at||a.last_active||0));
  for(const s of sorted){
    const title = String(s.title || s.preview || s.id || "(untitled)");
    const source = String(s.source || "cli");
    if(q && !title.toLowerCase().includes(q) && !source.toLowerCase().includes(q)) continue;
    const div = document.createElement("div");
    div.className = "sess" + (s.id===activeId?" active":"");
    div.dataset.sid = s.id;
    const titleNode = document.createElement("div");
    titleNode.className = "t";
    titleNode.textContent = title;
    const meta = document.createElement("div");
    meta.className = "m";
    if(effectiveUnread(s)){
      div.classList.add("unread");
      meta.appendChild(badgeElement("unread", "unread"));
    }
    meta.appendChild(badgeElement(source));
    const count = document.createElement("span");
    count.textContent = String(s.message_count || 0) + " msgs";
    meta.appendChild(count);
    const updated = document.createElement("span");
    updated.textContent = relTime(s.updated_at || s.last_active);
    meta.appendChild(updated);
    div.append(titleNode, meta);
    decorateAttention(div, s.id);
    div.onclick = ()=> openSession(s.id, title);
    el.appendChild(div);
  }
}

// ---- session ID copy chip ----
function updateIdChip(){
  const chip = $("idChip");
  if(!chip) return;
  const idEl = chip.querySelector(".idchip-id");
  if(!activeId){ chip.classList.add("hidden"); return; }
  chip.classList.remove("hidden");
  idEl.textContent = activeId.length > 8 ? activeId.slice(-7) : activeId;
  chip.title = "Copy session ID: " + activeId;
  chip.setAttribute("aria-label", "Copy session ID " + activeId);
}
function copyActiveId(){
  if(!activeId) return;
  const ok = ()=>{ flashCopied(); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(activeId).then(ok).catch(()=>fallbackCopy(activeId, ok));
  } else { fallbackCopy(activeId, ok); }
}
function fallbackCopy(text, cb){
  try{
    const ta = document.createElement("textarea");
    ta.className = "copy-ta"; ta.value = text;
    document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); document.body.removeChild(ta); cb();
  }catch(e){ /* clipboard unavailable */ }
}
function flashCopied(){
  const chip = $("idChip");
  if(!chip) return;
  const idEl = chip.querySelector(".idchip-id");
  const prev = idEl.textContent;
  chip.classList.add("copied"); idEl.textContent = "✓";
  setTimeout(()=>{ chip.classList.remove("copied"); idEl.textContent = prev; }, 1200);
}
$("idChip").addEventListener("click", copyActiveId);

// Point the foreground globals at the stream of session `id` (or at "no stream").
function syncForeground(id){
  const S = streams.get(id);
  const live = !!(S && S.running);
  streaming = live;
  streamingSessionId = live ? id : null;
  currentAbort = live ? S.abort : null;
  activeRunId = live ? S.runId : null;
  if(live) lastFrameAt = S.lastFrameAt;
}
// The composer's pending clarify is whichever card in the visible thread still waits for an answer.
function syncActiveClarify(){
  const c = $("thread").querySelector(".clarify-card.pending, .clarify-card.submitting");
  activeClarifyId = c ? (c.dataset.cid || null) : null;
}
// Leaving a session that owns a stream (running, or finished while we were away): move its thread nodes into the
// stream's detached holder so frames keep landing in them and nothing is lost when the user comes back.
function parkThread(sid){
  const S = streams.get(sid);
  if(!S || currentRenderedSessionId !== sid) return;
  const t = $("thread");
  S.lastFrameAt = lastFrameAt;
  S.holder.dataset.parked = "1";
  S.holder.replaceChildren(...Array.from(t.childNodes));
  t.replaceChildren();
  currentRenderedSessionId = null;
}
// Session list badges / drawer dot for sessions that need the user.
function decorateAttention(row, sid){
  const kind = attention.get(sid);
  let b = row.querySelector(".badge.attn");
  if(!kind){ if(b) b.remove(); row.classList.remove("attn"); return; }
  if(!b){ b = badgeElement("", "attn"); const m = row.querySelector(".m"); if(m) m.prepend(b); }
  b.textContent = kind === "question" ? "question waiting" : "new reply";
  row.classList.add("attn");
}
function updateAttentionUi(){
  document.querySelectorAll(".sess").forEach(x=> decorateAttention(x, x.dataset.sid));
  updateDrawerDot();
}
function setAttention(sid, kind){
  if(!sid || sid === activeId) return;
  if(attention.get(sid) === "question" && kind !== "question") return;
  attention.set(sid, kind);
  updateAttentionUi();
}
function clearAttention(sid){
  if(attention.delete(sid)) updateAttentionUi();
}
function sessionTitleOf(sid){
  const row = Array.from(document.querySelectorAll(".sess")).find(x=> x.dataset.sid === sid);
  const t = row && row.querySelector(".t");
  return (t && t.textContent) || sid;
}

// History + context + model for a session, merged into one object (does not touch the thread).
async function fetchHistory(id){
  const r = await api("/api/sessions/"+encodeURIComponent(id)+"/messages");
  if(!r.ok) throw new Error("HTTP "+r.status);
  const data = await r.json();
  try {
    const detailRes = await api("/api/sessions/"+encodeURIComponent(id));
    if(detailRes.ok && activeId === id){
      const detail = await detailRes.json();
      const sessObj = detail.session || detail;
      const used = num(sessObj.context_used ?? sessObj.contextTokens);
      const limit = num(sessObj.context_limit ?? sessObj.context_window ?? sessObj.contextWindow ?? sessObj.max_tokens);
      const occ = (typeof sessObj.occupancy_pct === "number") ? sessObj.occupancy_pct : null;
      if(limit > 0 && used > 0) { data.context_used = used; data.context_limit = limit; if(occ != null) data.occupancy_pct = occ; }
      currentSessionModel = sessObj.model || null;
      currentSessionProvider = sessObj.provider || null;
      updateModelChip(currentSessionModel, currentSessionProvider);
    }
  }catch(e){}
  return data;
}

async function openSession(id, title){
  // Leaving a session does NOT stop its turn: the stream keeps running, writing into its own thread nodes, and the
  // user finds the result (and any question it raised) when coming back. Only Stop / pagehide end a stream.
  const prevId = activeId;
  if(prevId && prevId !== id) parkThread(prevId);
  if(prevId) { const ps = streams.get(prevId); if(ps) ps.lastFrameAt = lastFrameAt; }
  if(!isSidebarPinnedEffective()){
    const s = $("sidebar");
    if(s) s.classList.remove("open");
    toggleScrim(false);
  }
  activeId = id;
  syncForeground(id);
  clearAttention(id);
  updateIdChip();
  updateDrawerDot();
  $("activeTitle").textContent = title || id;
  document.querySelectorAll(".sess").forEach(x=>x.classList.toggle("active", x.dataset.sid === id));
  const inputEl = $("input");
  if(inputEl){
    inputEl.value = loadDraft(id);
    updateRingState();
  }
  const S = streams.get(id);
  let keepThread = false;      // the thread on screen is the live one: do not rebuild it from history
  const isSessionSwitch = currentRenderedSessionId !== id;
  if(isSessionSwitch){
    currentRenderedSessionId = id;
    const t = $("thread");
    const cached = sessionRenderCache.get(id);
    if(S && S.holder.childNodes.length){
      // Back to a session whose stream ran (or is running) while we were away: put its nodes back as they are.
      t.replaceChildren(...Array.from(S.holder.childNodes));
      S.holder.removeAttribute("data-parked");
      keepThread = true;
      localThread.add(id);
      t.scrollTop = t.scrollHeight;
      if(!S.running) streams.delete(id);
    } else if(cached && cached.length > 0){
      renderThread(cached);
    } else {
      t.replaceChildren();
    }
  } else if(S && S.running){
    keepThread = true;         // re-opening the session whose stream is live: rebuilding would orphan its bubble
  }
  syncActiveClarify();
  try{
    const data = await fetchHistory(id);
    applyContextFrom(data);
    const msgs = historyMessages(data);
    if(activeId === id){
      if(!keepThread){
        renderThread(msgs);
        reconcileDraftWithMessages(id, msgs);
      }
      markRead(id, "open");   // only after history loaded successfully
    }
  }catch(e){
    if(activeId === id){
      setStatus("bad");
      showToast("Could not load history: " + (e.message || e), "error");
      const t = $("thread");
      // NON-DESTRUCTIVE HISTORY INVARIANT: Do not clear thread on network failure.
      // If DOM is unpopulated, restore strictly from this session's cached render if available.
      if(!t.hasChildNodes()){
        const cached = sessionRenderCache.get(id);
        if(cached && cached.length > 0){
          renderThread(cached);
        } else {
          addMsg("system", "Could not load history: " + (e.message || e));
        }
      }
    }
  }
  if(activeId !== id) return;
  document.querySelectorAll(".sess").forEach(x=>x.classList.toggle("active", x.dataset.sid === id));
  await loadSessions();
}

async function newSession(){
  try{
    const payload = {};
    if(cfg.defaultModel){
      payload.model = cfg.defaultModel;
      if(cfg.defaultProvider) payload.provider = cfg.defaultProvider;
    }
    const r = await api("/api/sessions", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
    if(!r.ok) throw new Error("HTTP "+r.status);
    const s = await r.json();
    const id = s.id || (s.session&&s.session.id);
    if(!id) throw new Error("no id in response");
    currentSessionModel = cfg.defaultModel || null;
    currentSessionProvider = cfg.defaultProvider || null;
    updateModelChip(currentSessionModel, currentSessionProvider);
    await loadSessions();
    await openSession(id, "New chat");
  }catch(e){ showToast("New chat failed: " + e.message, "error"); }
}

/* ---------- chat / streaming ---------- */
function atBottom(){
  const t = $("thread");
  return t.scrollHeight - t.scrollTop - t.clientHeight < 48;
}
function maybeAutoscroll(){
  if(atBottom()){ const t = $("thread"); t.scrollTop = t.scrollHeight; }
}
const renderTimers = new WeakMap();
function getOrCreateActiveBody(bubble){
  if(!bubble._curBody){
    const b = document.createElement("div");
    b.className = "body";
    bubble.appendChild(b);
    bubble._curBody = b;
    bubble._curRaw = "";
  }
  return bubble._curBody;
}
function scheduleRenderBody(bodyEl, rawText){
  if(renderTimers.has(bodyEl)) return;
  const id = setTimeout(()=>{
    renderTimers.delete(bodyEl);
    const parsed = extractModelTags(rawText);
    if(parsed.cleanText){
      setCleanBody(bodyEl, parsed.cleanText);
    } else if(parsed.activeThought){
      bodyEl.innerHTML = "<span class=\"tool-running\">Thinking…</span>";
    }
  }, 80);
  renderTimers.set(bodyEl, id);
}
function flushRender(bubble){
  if(bubble._curBody && bubble._curRaw !== undefined){
    const id = renderTimers.get(bubble._curBody);
    if(id){ clearTimeout(id); renderTimers.delete(bubble._curBody); }
    const parsed = extractModelTags(bubble._curRaw);
    if(parsed.cleanText) setCleanBody(bubble._curBody, parsed.cleanText);
  }
}

// Plain-text note at the end of a bubble ("[stopped]", "[error] ..."). A separate node: never overwrite the rendered reply.
function addBubbleNote(bubble, text){
  const n = document.createElement("div");
  n.className = "body stream-note";
  n.textContent = text;
  const stick = bubble.isConnected && atBottom();
  bubble.appendChild(n);
  bubble._curBody = null; bubble._curRaw = "";
  if(stick){ const t = $("thread"); t.scrollTop = t.scrollHeight; }
}

// After a turn ends in the session being viewed: refresh context / model / read state / session list, but leave the
// thread alone (it already shows exactly what the user watched arrive, including cards and "[stopped]").
async function syncAfterTurn(id){
  try{
    const data = await fetchHistory(id);
    if(activeId === id){
      applyContextFrom(data);
      const msgs = historyMessages(data);
      reconcileDraftWithMessages(id, msgs);
      markRead(id, "completion");
    }
  }catch(e){
    if(activeId === id) setStatus("bad");
  }
  if(activeId === id) await loadSessions();
}

async function streamTurn(text, sessionId, opts={}){
  if(streaming) return;
  const prevS = streams.get(sessionId);
  if(prevS && prevS.running) return;
  const addUser = opts.addUser !== false;
  // NOTE (Idempotency Contract): Client generates turnId forwarded via Idempotency-Key / X-Client-Turn-ID / client_turn_id.
  // Transport plumbing is live; upstream deduplication state machine is pending in api_server.py.
  const turnId = opts.turnId || generateUUID();
  const userBubble = addUser ? addMsg("user", text) : null;
  const abortCtrl = new AbortController();
  const S = {sid: sessionId, abort: abortCtrl, runId: null, lastFrameAt: Date.now(), running: true,
             holder: document.createElement("div"), bubble: null, userBubble, intercepted: false};
  streams.set(sessionId, S);
  currentAbort = abortCtrl;
  streaming = true; streamingSessionId = sessionId; updateRingState();
  activeRunId = null; lastFrameAt = S.lastFrameAt; lastClarifyProbeAt = 0;
  loadGatewayCaps();                          // background; this turn uses whatever is known right now
  const reqBody = {input:text, client_turn_id: turnId};
  const caps = clientCapabilities();
  if(caps.length) reqBody.client_capabilities = caps;
  const watchdog = setInterval(()=>{
    const now = Date.now();
    if(S.running && S.sid === activeId && streaming && now - lastFrameAt >= CLARIFY_STALE_MS && now - lastClarifyProbeAt >= CLARIFY_STALE_MS) probePendingClarify();
  }, 5000);
  const bubble = addMsg("assistant", "");
  bubble.dataset.sid = sessionId;
  bubble._stream = S;
  S.bubble = bubble;
  bubble._curBody = null;
  bubble._curRaw = "";
  try{
    const r = await api("/api/sessions/"+encodeURIComponent(sessionId)+"/chat/stream", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Idempotency-Key": turnId,
        "X-Client-Turn-ID": turnId
      },
      body: JSON.stringify(reqBody),
      signal: abortCtrl.signal
    });
    if(!r.ok){
      const errText = await r.text().catch(()=> "");
      throw new Error("HTTP "+r.status+(errText ? " "+errText : ""));
    }
    // Stream established: safely clear draft from storage
    saveDraft(sessionId, "");
    saveDraft(null, "");
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while(true){
      const {done,value} = await reader.read();
      if(done) break;
      buf += dec.decode(value, {stream:true});
      let separator;
      while((separator = /\r?\n\r?\n/.exec(buf)) !== null){
        const frame = buf.slice(0, separator.index);
        buf = buf.slice(separator.index + separator[0].length);
        handleFrame(frame, bubble);
      }
    }
    if(buf.trim()) handleFrame(buf, bubble);
  }catch(e){
    // If stream failed before delivery, preserve draft in storage and restore to input if empty
    saveDraft(sessionId, text, turnId);
    const inputEl = $("input");
    if(inputEl && !inputEl.value && activeId === sessionId){
      inputEl.value = text;
      updateRingState();
    }
    if(e && e.name === "AbortError") addBubbleNote(bubble, "[stopped]");
    else addBubbleNote(bubble, "[error] " + (e && e.message ? e.message : e));
  }finally{
    clearInterval(watchdog);
    S.running = false;
    flushRender(bubble);
    // An assistant bubble that ended up empty (no text, no tool, no card: e.g. the gateway took the text as a clarify
    // answer) is dropped, as is the user bubble of a turn the gateway refused to start.
    if(bubble.children.length <= 1) bubble.remove();
    if(S.intercepted && userBubble) userBubble.remove();
    if(S.sid === activeId){
      // Finished in the session being viewed: keep what is on screen.
      streams.delete(sessionId);
      streaming = false; streamingSessionId = null; currentAbort = null; activeRunId = null;
      if($("thread").childElementCount) localThread.add(sessionId);
      updateRingState();
      await syncAfterTurn(sessionId);
      if(probeClarifyAfterTurn){
        probeClarifyAfterTurn = false;
        const inp = $("input");
        if(inp && !inp.value && activeId === sessionId){ inp.value = text; updateRingState(); }   // the text was not sent: give it back
        probePendingClarify();
      }
    }else{
      // Finished while the user was elsewhere: its thread stays parked in S.holder until they return.
      if(S.holder.querySelector(".clarify-card.pending")) setAttention(sessionId, "question");
      else setAttention(sessionId, "reply");
      loadSessions();
    }
  }
}

async function send(){
  const ta = $("input");
  const text = ta.value.trim();
  if(!text) return;
  if(streaming && !activeClarifyId) return;
  if(activeClarifyId){
    const prevCid = activeClarifyId;
    const prevCard = findClarifyCard($("thread"), prevCid);
    if(prevCard && prevCard._batch && prevCard.classList.contains("pending")){
      // A batch is never answered by typed text (the gateway does not take it as an answer either): point at the card.
      showToast("Answer or cancel the questions first. Your message is kept.");
      try{ (prevCard.querySelector(".clarify-qcard:not(.answered):not(.skipped)") || prevCard.querySelector(".clarify-qcard")).focus(); }catch{}
      return;
    }
    // Typing in the composer while a single question is pending = skip it (the agent decides).
    activeClarifyId = null;
    await submitClarifyResponse(prevCid, "", prevCard);
    if(streaming){
      // The turn is still running server-side and its stream is still being read: do not abort it.
      // The typed text stays in the box; it can be sent once this turn finishes.
      showToast("Question skipped. Your message is kept; send it when the agent finishes.");
      return;
    }
  }
  if(!activeId){ await newSession(); }
  if(!activeId) return;
  let turnId = loadDraftTurnId(activeId);
  if(!turnId){
    turnId = generateUUID();
    saveDraft(activeId, text, turnId);
  }
  ta.value = "";
  updateRingState();
  await streamTurn(text, activeId, {addUser:true, turnId: turnId});
}

// Best effort: ask the server to stop the run too (aborting the fetch alone leaves it running).
function postRunStop(rid, keepalive){
  if(!rid) return;
  try{
    api("/v1/runs/"+encodeURIComponent(rid)+"/stop", {method:"POST", keepalive: !!keepalive}).catch(()=>{});
  }catch(e){}
}
function stopRun(keepalive){ postRunStop(activeRunId, !!keepalive); }
function stop(keepalive){
  stopRun(keepalive === true);
  if(currentAbort) currentAbort.abort();
}
// Page is going away: end every live stream (including those of sessions the user is not viewing).
function stopAll(keepalive){
  for(const S of streams.values()){
    if(!S.running) continue;
    postRunStop(S.runId, keepalive);
    try{ S.abort.abort(); }catch(e){}
  }
}

// Real wire format of /api/sessions/{id}/chat/stream (gateway/platforms/api_server.py, _handle_session_chat_stream):
//   assistant.delta   {message_id, delta}
//   tool.started | tool.completed | tool.failed   {message_id, tool_name, preview, args}   (no call id on this route)
//   tool.progress     {message_id, tool_name ("_thinking" for reasoning), delta}
//   assistant.commentary {message_id, text, already_streamed}
//   assistant.completed  {message_id, content, ...}     run.completed | run.failed | run.cancelled | error {message} | done
//   clarify / clarify.settled / clarify.intercept
// Every frame also carries session_id, run_id, seq, ts. The older field names (text, name, call_id, output) stay as
// fallbacks for gateways that emit them.
function frameText(obj, data){
  if(!obj) return data;
  const v = obj.delta != null ? obj.delta : obj.text;
  return v == null ? null : (typeof v === "string" ? v : String(v));
}
function appendStreamText(bubble, piece, fg){
  if(!piece) return;
  const body = getOrCreateActiveBody(bubble);
  bubble._curRaw = (bubble._curRaw || "") + piece;
  bubble._gotText = true;
  scheduleRenderBody(body, bubble._curRaw);
  if(fg) maybeAutoscroll();
}

function handleFrame(frame, bubble){
  if(frame.startsWith(":")) return;
  // Frames belong to the stream that owns `bubble`. When the user is looking at another session the frame is still
  // applied, to that stream's own (detached) nodes: nothing is dropped and nothing leaks into the visible thread.
  const S = bubble && bubble._stream;
  const fg = !S || S.sid === activeId;
  if(S) S.lastFrameAt = Date.now();
  if(fg) lastFrameAt = Date.now();
  const root = (S && !fg) ? S.holder : $("thread");
  let event="message", data="";
  for(const line of frame.split(/\r?\n/)){
    if(line.startsWith("event:")) event = line.slice(6).trim();
    else if(line.startsWith("data:")){
      let value = line.slice(5);
      if(value.startsWith(" ")) value = value.slice(1);
      data += (data ? "\n" : "") + value;
    }
  }
  let obj=null; try{ obj = JSON.parse(data) }catch{}
  if(obj && typeof obj.run_id === "string" && obj.run_id){
    if(S) S.runId = obj.run_id;
    if(fg) activeRunId = obj.run_id;
  }
  if(event==="assistant.delta"){
    appendStreamText(bubble, frameText(obj, data), fg);
  }else if(event==="assistant.commentary"){
    // Mid-turn commentary not already delivered as deltas.
    if(obj && typeof obj.text === "string" && obj.text.trim() && !obj.already_streamed){
      appendStreamText(bubble, obj.text + "\n\n", fg);
    }
  }else if(event==="assistant.completed"){
    // Safety net: a turn whose text never arrived as deltas (e.g. a non-streaming provider) still shows its reply.
    if(obj && typeof obj.content === "string" && obj.content && !bubble._gotText){
      appendStreamText(bubble, obj.content, fg);
    }
  }else if(event==="error"){
    addBubbleNote(bubble, "[error] " + ((obj && obj.message) || data || "stream error"));
  }else if(event==="tool.started"){
    if(bubble && bubble._curBody && bubble._curRaw){
      flushRender(bubble);
    }
    if(bubble){
      bubble._curBody = null;
      bubble._curRaw = "";
    }
    const name = (obj&&(obj.tool_name||obj.name))||"tool";
    const input = (obj && (obj.args || obj.parameters || obj.arguments || obj.input)) || "";
    addToolCard(name, obj&&(obj.tool_call_id||obj.call_id), "run", input, "", bubble);
  }else if(event==="tool.completed"){
    const cid = obj&&(obj.tool_call_id||obj.call_id);
    const out = obj ? (obj.output!=null ? obj.output : (obj.preview!=null ? obj.preview : (obj.result!=null ? obj.result : ""))) : "";
    updateToolCard(cid, "done", typeof out==="string"?out:JSON.stringify(out,null,2), bubble, obj&&(obj.tool_name||obj.name));
  }else if(event==="tool.failed"){
    const cid = obj&&(obj.tool_call_id||obj.call_id);
    const out = obj ? (obj.preview!=null ? obj.preview : (obj.error!=null ? obj.error : (obj.output!=null ? obj.output : ""))) : "";
    updateToolCard(cid, "failed", typeof out==="string"?out:JSON.stringify(out,null,2), bubble, obj&&(obj.tool_name||obj.name));
  }else if(event==="clarify"){
    if(obj){
      renderClarifyCard(obj, bubble, {background: !fg});
      if(!fg){
        setAttention(S.sid, "question");
        showToast("A question is waiting in “" + sessionTitleOf(S.sid) + "”.");
      }
    }
  }else if(event==="clarify.settled"){
    // Answered (here, Telegram, desktop) or expired server-side: retire the card and stop its timer.
    const scid = obj && obj.clarify_id;
    if(scid){
      if(fg && activeClarifyId === scid) activeClarifyId = null;
      settleClarifyCard(scid, "", root, "closed", {outcome: obj.outcome});
      if(!fg && S && attention.get(S.sid) === "question" && !S.holder.querySelector(".clarify-card.pending")){
        attention.set(S.sid, "reply");
        updateAttentionUi();
      }
    }
  }else if(event==="clarify.intercept"){
    // The gateway started no turn because a question is waiting: give the text back and show the card (recover it if missing).
    showToast((obj && obj.message) || "A question is waiting for your answer.");
    if(S) S.intercepted = true;
    probeClarifyAfterTurn = true;           // the turn ends right away: drop its bubbles and restore the card afterwards
  }
  // fallback: if no structured events, but data is plain text
  if(event==="message" && data && !obj){
    const body = getOrCreateActiveBody(bubble);
    body.textContent += data;
  }
}

/* ---------- user message actions (edit / restore / rerun) ---------- */
function buildMsgActions(){
  const wrap = document.createElement("div");
  wrap.className = "msgActions";
  const edit = document.createElement("button"); edit.textContent = "✎"; edit.title = "Edit"; edit.dataset.act = "edit";
  const restore = document.createElement("button"); restore.textContent = "↩"; restore.title = "Restore to input"; restore.dataset.act = "restore";
  const rerun = document.createElement("button"); rerun.textContent = "↻"; rerun.title = "Rerun"; rerun.dataset.act = "rerun";
  wrap.append(edit, restore, rerun);
  return wrap;
}
function handleMsgAction(act, text, bubble){
  if(act === "restore"){
    const input = $("input");
    input.value = text; input.focus(); updateRingState();
  }else if(act === "rerun"){
    if(activeId && !streaming) streamTurn(text, activeId, {addUser:true});
  }else if(act === "edit"){
    if(activeId) inlineEdit(bubble, text);
  }
}
function inlineEdit(bubble, text){
  const ta = document.createElement("textarea");
  ta.className = "editArea";
  ta.value = text;
  const bar = document.createElement("div");
  bar.className = "editBar";
  const save = document.createElement("button"); save.className = "primary"; save.textContent = "Save";
  const cancel = document.createElement("button"); cancel.textContent = "Cancel";
  bar.append(save, cancel);
  bubble.replaceChildren(ta, bar);
  ta.focus();
  save.onclick = ()=>{
    const v = ta.value.trim();
    if(!v) return;

    bubble.replaceChildren(roleLabel("you"), bodyDiv(text));
    bubble.dataset.text = text;
    bubble.appendChild(buildMsgActions());
    bubble.classList.add("busy-dim");
    bubble.title = "Edited (original preserved in backend context)";

    streamTurn(v, activeId, {addUser:true});
  };
  cancel.onclick = ()=>{ openSession(activeId, $("activeTitle").textContent); };
}

/* ---------- rendering ---------- */
function addMsg(role, text){
  const t = $("thread");
  const safe = safeRole(role);
  const d = msgShell(safe, safe === "user" ? "you" : safe);
  if(text || safe !== "assistant") d.appendChild(bodyDiv(text));
  if(safe === "user"){
    d.dataset.text = text;
    d.appendChild(buildMsgActions());
  }
  t.appendChild(d); t.scrollTop = t.scrollHeight;
  return d;
}
function renderThread(msgs){
  if(activeId){
    sessionRenderCache.set(activeId, Array.isArray(msgs) ? msgs.slice() : []);
    currentRenderedSessionId = activeId;
    localThread.delete(activeId);     // rebuilt from history: nothing stream-built is left on screen
  }
  const t = $("thread");
  t.replaceChildren();

  const toolResultsById = new Map();
  const consumedToolIndices = new Set();
  (msgs || []).forEach((m, idx)=>{
    if(safeRole(m.role) === "tool"){
      const cid = m.tool_call_id || m.call_id || m.id;
      if(cid) toolResultsById.set(String(cid), {msg: m, idx: idx});
    }
  });

  for(let i = 0; i < (msgs || []).length; i++){
    const m = msgs[i];
    const role = safeRole(m.role);

    if(role === "tool"){
      if(consumedToolIndices.has(i)) continue;
      t.appendChild(buildToolCard(m.tool_name || m.name || "tool", "done", "", str(m.content), ""));
      continue;
    }

    if(role === "user"){
      const text = str(m.content);
      const c = msgShell("user", "you");
      c.appendChild(bodyDiv(text));
      c.dataset.text = text;
      c.appendChild(buildMsgActions());
      t.appendChild(c);
      continue;
    }

    if(role === "assistant"){
      const c = msgShell("assistant", "assistant");
      const parsed = extractModelTags(str(m.content));

      parsed.thoughts.forEach(th=>{
        c.appendChild(createThoughtCard(th, false));
      });

      if(parsed.cleanText) c.appendChild(bodyDiv(parsed.cleanText));

      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      toolCalls.forEach(tc=>{
        const name = tc.function?.name || tc.name || "tool";
        const input = tc.function?.arguments || tc.arguments || tc.parameters || tc.input || "";
        const cid = tc.id || tc.call_id || "";
        let out = "";
        if(cid && toolResultsById.has(String(cid))){
          const match = toolResultsById.get(String(cid));
          consumedToolIndices.add(match.idx);
          out = str(match.msg.content);
        }
        c.appendChild(buildToolCard(name, "done", input, out, cid));
      });

      parsed.toolCalls.forEach(tc=>{
        const name = tc.name || "tool";
        const input = tc.arguments || tc.parameters || tc.input || tc.raw || "";
        c.appendChild(buildToolCard(name, "done", input, "", ""));
      });

      if(c.children.length > 1){
        t.appendChild(c);
      }
      continue;
    }

    const c = msgShell(role, role);
    c.appendChild(bodyDiv(str(m.content)));
    t.appendChild(c);
  }
  t.scrollTop = t.scrollHeight;
}
function roleLabel(text){
  const l = document.createElement("div");
  l.className = "role";
  l.textContent = text;
  return l;
}
function msgShell(role, label){
  const c = document.createElement("div");
  c.className = "msg " + role;
  c.appendChild(roleLabel(label));
  return c;
}
function bodyDiv(text){
  const b = document.createElement("div");
  b.className = "body";
  setBody(b, text);
  return b;
}
function buildToolCard(name, state, input, out, cid){
  const c = document.createElement("details");
  c.className = "msg tool";
  c.dataset.cid = cid || "";
  c.dataset.tname = String(name || "tool");
  c._toolInput = input || "";
  c.appendChild(toolHeader(name, state));
  const b = document.createElement("div");
  b.className = "body";
  renderToolBody(b, input, out);
  c.append(b, createCollapseBtn(c));
  return c;
}
function addToolCard(name, cid, state, input, out, bubble){
  // Tool cards belong to the turn that produced them: append to that
  // bubble (staying inside its message flow), falling back to the thread
  // only when no bubble is known.
  const t = bubble || $("thread");
  const c = buildToolCard(name, state, input, out, cid);
  if(state === "run") c.open = true;
  t.appendChild(c);
  if(t.isConnected) t.scrollTop = t.scrollHeight;
}
function updateToolCard(cid, state, out, bubble, name){
  // Always scoped to this turn's bubble: never touch a tool card belonging to another session's view.
  const scope = bubble || document;
  let target = null;
  if(cid){
    target = Array.from(scope.querySelectorAll(".msg.tool")).find(x=> x.dataset.cid === String(cid)) || null;
  }
  if(!target){
    // The real /chat/stream frames carry no call id: pair a completion with the oldest still-running card of the same
    // tool (cards are added in start order), else the oldest running card, else the last card.
    const cards = Array.from(scope.querySelectorAll(".msg.tool"));
    const running = cards.filter(x=> { const d = x.querySelector(".dot"); return d && d.classList.contains("run"); });
    target = (name && running.find(x=> x.dataset.tname === String(name))) || running[0] || cards[cards.length - 1] || null;
  }
  if(target){
    target.querySelector(".dot").className="dot "+(state==="done"?"done":state==="failed"?"failed":"run");
    const body = target.querySelector(".body");
    const input = target._toolInput || "";
    renderToolBody(body, input, out);
    if(state === "done") target.open = false;
  }
}

/* ---------- skills / toolsets ---------- */
async function loadCardList(elId, path, label, buildCard){
  const el = $(elId);
  const hasExisting = el.querySelector(".card");
  if(!hasExisting) showLoading(el);
  try{
    const r = await api(path);
    if(!r.ok) throw new Error("HTTP "+r.status);
    const d = await r.json();
    const arr = Array.isArray(d) ? d : (d.data||[]);
    el.replaceChildren(...arr.map(buildCard));
    if(!arr.length) el.appendChild(messageElement("None reported."));
  }catch(e){ if(!hasExisting) showError(el, "Failed to load "+label+"."); }
}
function textDiv(className, text){
  const d = document.createElement("div");
  d.className = className;
  d.textContent = text;
  return d;
}
function loadSkills(){
  return loadCardList("skillsList", "/v1/skills", "skills", s=>{
    const c = document.createElement("div");
    c.className = "card";
    c.append(textDiv("n", String(s.name||s.id||"?")), textDiv("d", String(s.description||"")));
    return c;
  });
}
function loadTools(){
  return loadCardList("toolsList", "/v1/toolsets", "toolsets", t=>{
    const c = document.createElement("div");
    c.className = "card";
    const state = t.enabled != null ? " · " + (t.enabled ? "enabled" : "disabled") : "";
    c.append(textDiv("n", String(t.name||t.label||"?")), textDiv("d", String(t.description||"") + state));
    const tools = (t.tools||[]).map(String).join(", ");
    if(tools) c.appendChild(textDiv("tools", tools));
    return c;
  });
}

/* ---------- diagnostics ---------- */
async function runDiag(){
  const out=$("diag"); out.textContent="Testing…";
  let lines=[];
  try{ const r=await api("/health"); lines.push("GET /health → "+r.status+(r.ok?" (ok)":"")); }catch(e){ lines.push("GET /health → "+e.message); }
  try{ const r=await api("/v1/capabilities"); if(!r.ok) throw new Error("HTTP "+r.status); const d=await r.json();
    lines.push("GET /v1/capabilities → "+r.status);
    if(d.features){ const on=Object.entries(d.features).filter(([k,v])=>v).map(([k])=>k).join(", ");
      lines.push("features: "+(on||"(none advertised)")); }
  }catch(e){ lines.push("GET /v1/capabilities → "+e.message); }
  try{ const r=await api("/api/sessions?limit=1"); lines.push("GET /api/sessions → "+r.status); }catch(e){ lines.push("GET /api/sessions → "+e.message); }
  out.textContent = lines.join("\n");
}

/* ---------- event wiring ---------- */
function str(x){
  if(x==null) return "";
  if(typeof x==="string") return x;
  if(Array.isArray(x)) return x.map(str).join("\n");
  if(typeof x==="object"){
    if(x.text) return str(x.text);
    if(x.content) return str(x.content);
    try{ return JSON.stringify(x,null,2); }catch{ return "[unrenderable value]"; }
  }
  return String(x);
}
function formatPayload(x){
  if(x == null || x === "") return "";
  if(typeof x === "object"){
    try{ return JSON.stringify(x, null, 2); }catch{ return String(x); }
  }
  if(typeof x === "string"){
    const trimmed = x.trim();
    if((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))){
      try{ return JSON.stringify(JSON.parse(trimmed), null, 2); }catch{}
    }
    return x;
  }
  return String(x);
}
function toolSection(label, text){
  const sec = document.createElement("div");
  sec.className = "tool-sec";
  const h = document.createElement("div");
  h.className = "tool-sec-h";
  h.textContent = label;
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = text;
  pre.appendChild(code);
  sec.append(h, pre);
  return sec;
}
function renderToolBody(bodyEl, input, output){
  bodyEl.replaceChildren();
  const inStr = formatPayload(input);
  const outStr = formatPayload(output);
  if(inStr) bodyEl.appendChild(toolSection("Parameters", inStr));
  if(outStr) bodyEl.appendChild(toolSection("Result", outStr));
  if(!inStr && !outStr){
    const span = document.createElement("span");
    span.className = "tool-running";
    span.textContent = "Running…";
    bodyEl.appendChild(span);
  }
}
function createThoughtCard(thoughtText, open){
  const card = document.createElement("details");
  card.className = "msg thought";
  if(open) card.open = true;

  const hdr = document.createElement("summary");
  hdr.className = "hdr";
  const dot = document.createElement("span");
  dot.className = "dot done";
  const label = document.createElement("span");
  label.textContent = "Thought";
  hdr.append(dot, label);
  card.appendChild(hdr);

  const b = document.createElement("div");
  b.className = "body";
  b.textContent = thoughtText;
  card.appendChild(b);
  card.appendChild(createCollapseBtn(card));
  return card;
}
function splitCodeFences(text){
  if(!text) return [];
  const regex = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  while((match = regex.exec(text)) !== null){
    if(match.index > lastIndex){
      parts.push({type: "text", content: text.slice(lastIndex, match.index)});
    }
    parts.push({type: "code", content: match[0]});
    lastIndex = regex.lastIndex;
  }
  if(lastIndex < text.length){
    parts.push({type: "text", content: text.slice(lastIndex)});
  }
  return parts;
}
function extractModelTags(text){
  if(!text) return {thoughts: [], toolCalls: [], activeThought: "", cleanText: ""};
  const parts = splitCodeFences(String(text));
  const thoughts = [];
  const toolCalls = [];
  let activeThought = "";

  const cleanParts = parts.map((part, pIdx)=>{
    if(part.type === "code") return part.content;
    let clean = part.content;

    clean = clean.replace(/<(?:thought|reasoning)>([\s\S]*?)<\/(?:thought|reasoning)>/gi, (match, inner)=>{
      if(inner.trim()) thoughts.push(inner.trim());
      return "";
    });

    if(pIdx === parts.length - 1){
      const openThoughtMatch = clean.match(/<(?:thought|reasoning)>([\s\S]*)$/i);
      if(openThoughtMatch){
        activeThought = openThoughtMatch[1].trim();
        clean = clean.slice(0, openThoughtMatch.index);
      }
    }

    clean = clean.replace(/<tool_call>([\s\S]*?)<\/tool_call>/gi, (match, inner)=>{
      const trimmed = inner.trim();
      if(trimmed){
        try{ toolCalls.push(JSON.parse(trimmed)); }
        catch{ toolCalls.push({raw: trimmed}); }
      }
      return "";
    });

    if(pIdx === parts.length - 1){
      const openToolMatch = clean.match(/<tool_call>([\s\S]*)$/i);
      if(openToolMatch){
        clean = clean.slice(0, openToolMatch.index);
      }
    }

    return clean;
  });

  return {thoughts, toolCalls, activeThought, cleanText: cleanParts.join("").trim()};
}
function escapeHtml(value){
  return String(value==null?"" : value).replace(/[&<>\"']/g, char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
}
function relTime(ts){
  if(!ts) return "";
  const value = typeof ts === "string" ? Date.parse(ts)/1000 : Number(ts);
  if(!Number.isFinite(value)) return "";
  const d=Date.now()/1000 - value;
  if(d<60) return "just now";
  if(d<3600) return Math.floor(d/60)+"m ago";
  if(d<86400) return Math.floor(d/3600)+"h ago";
  return Math.floor(d/86400)+"d ago";
}
function safeRole(value){
  const role = String(value||"system").toLowerCase();
  return ["assistant","user","tool","system"].includes(role) ? role : "system";
}
function messageElement(text){
  const el=document.createElement("div");
  el.className="note";
  el.textContent=String(text);
  return el;
}
function showLoading(el){ el.replaceChildren(messageElement("Loading…")); }
function showError(el, text){
  const error=messageElement(text);
  error.classList.add("err");
  el.replaceChildren(error);
}
function badgeElement(text, extraClass){
  const badge=document.createElement("span");
  badge.className="badge"+(extraClass?" "+extraClass:"");
  badge.textContent=String(text);
  return badge;
}
function toolHeader(name, state){
  const header=document.createElement("summary");
  header.className="hdr";
  const dot=document.createElement("span");
  dot.className="dot "+(state==="done"?"done":state==="failed"?"failed":"run");
  header.appendChild(dot);
  const label=document.createElement("span");
  label.textContent=String(name||"tool");
  header.appendChild(label);
  return header;
}
function createCollapseBtn(detailsEl){
  const btn = document.createElement("button");
  btn.className = "tool-collapse-btn";
  btn.textContent = "Collapse ▲";
  btn.onclick = (e) => {
    e.preventDefault();
    detailsEl.open = false;
    detailsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  return btn;
}

/* ---------- markdown + Hermes-aware rendering ---------- */
// Hermes wraps meta/context content in bracketed headers, e.g.
//   [CONTEXT COMPACTION — REFERENCE ONLY] ...   [PRIOR CONTEXT — ...]   [SYSTEM ...]
// Render those as de-emphasized "system note" callouts; render the rest as markdown.
const SYSNOTE_RE = /^\[([A-Z][A-Z0-9 _\-–—]+)(?:[ —–]+(.*?))?\]/;
function splitSysNotes(text){
  const lines = text.split("\n");
  const out = []; let i = 0;
  while(i < lines.length){
    const m = lines[i].match(SYSNOTE_RE);
    if(m && lines[i].startsWith("[")){
      const label = m[1]; const sub = m[2]||"";
      const after = lines[i].slice(m[0].length).replace(/^\s*/, "");
      const bodyLines = []; if(after) bodyLines.push(after); let j = i+1;
      while(j < lines.length){
        const ln = lines[j];
        if(ln.trim()===""){
          let k=j+1; while(k<lines.length && lines[k].trim()==="") k++;
          if(k<lines.length && lines[k].match(SYSNOTE_RE) && lines[k].startsWith("[")) break;
          bodyLines.push(ln); j++; continue;
        }
        if(ln.match(SYSNOTE_RE) && ln.startsWith("[")) break;
        bodyLines.push(ln); j++;
      }
      out.push({type:"note", label, sub, body: bodyLines.join("\n").trim()});
      i = j;
    } else {
      const md = [];
      while(i < lines.length){
        const ln = lines[i];
        if(ln.match(SYSNOTE_RE) && ln.startsWith("[")) break;
        md.push(ln); i++;
      }
      if(md.join("\n").trim()) out.push({type:"md", text: md.join("\n")});
    }
  }
  return out;
}
function renderMarkdown(text){
  if(text==null) return "";
  const blocks = splitSysNotes(String(text));
  let html = "";
  for(const b of blocks){
    if(b.type==="note"){
      const body = b.body ? marked.parse(b.body, {breaks:true, gfm:true}) : "";
      const head = escapeHtml((b.label||"note") + (b.sub? " — "+b.sub : ""));
      html += "<div class='sysnote'><div class='sysnote-h'>"+head+"</div>"+(body?"<div class='sysnote-b'>"+body+"</div>":"")+"</div>";
    }else{
      html += marked.parse(b.text, {breaks:true, gfm:true});
    }
  }
  return html;
}
function safeHref(value){
  const raw=String(value||"").trim();
  if(!raw) return null;
  try{
    const url=new URL(raw, document.baseURI);
    if(["http:","https:","mailto:"].includes(url.protocol)) return url.href;
  }catch{}
  return null;
}
function secureHtml(html){
  return String(html||"").replace(/<a\s+([^>]*?)href=(["'])(.*?)\2([^>]*)>/gi, (match, before, quote, url, after) => {
    const safe = safeHref(url);
    if(!safe) return `<a ${before} ${after}>`;
    return `<a ${before}href="${safe}" rel="noreferrer noopener"${after}>`;
  });
}
function setBody(el, text){ setCleanBody(el, extractModelTags(text).cleanText); }
// `cleanText` has already had thought/tool_call tags removed (see extractModelTags).
function setCleanBody(el, cleanText){
  const parts = splitCodeFences(cleanText);
  const safeParts = parts.map(part => {
    if(part.type === "code") return part.content;
    return part.content.replace(/<(?=[a-zA-Z\/!\?])/gi, "&lt;");
  });
  el.innerHTML = secureHtml(renderMarkdown(safeParts.join("")));
}

/* ---------- helpers ---------- */
$("ring").onclick = ()=>{ if(streaming) stop(); else send(); };
$("input").addEventListener("keydown", e=>{
  if(e.key === "Enter" && e.ctrlKey){
    e.preventDefault(); send();            // Ctrl+Enter always sends
  }else if(e.key === "Enter"){
    // Mobile (coarse pointer): Enter = newline. Physical keyboard: Enter sends, Shift+Enter newline.
    if(FINE_POINTER && !e.shiftKey){ e.preventDefault(); send(); }
  }else if(e.key === "Escape"){
    e.target.blur();                        // Escape dismisses the keyboard
  }
});
$("input").addEventListener("input", ()=>{
  saveDraft(activeId, $("input").value, "");
  updateRingState();
});
$("newBtn").onclick = newSession;
$("refreshBtn").onclick = refresh;
$("searchInput").addEventListener("input", ()=> renderSessions(lastSessionRows));
$("rightBtn").onclick = ()=>{
  const r=$("right");
  if(window.matchMedia("(max-width:1023px)").matches){
    r.classList.toggle("open"); toggleScrim(r.classList.contains("open"));
  }else{
    r.classList.toggle("collapsed");
  }
  // Load whenever the panel is visible. On desktop the rail is the always-on
  // 3-column panel toggled via .collapsed (never .open), so the old .open-only
  // guard left it empty there. Reload on every open for freshness.
  if(!r.classList.contains("collapsed")){ loadSkills(); loadTools(); }
};
$("menuBtn").onclick = ()=>{
  const s=$("sidebar"); s.classList.toggle("open"); toggleScrim(s.classList.contains("open"));
};
/* ---- More menu (narrow header) ---- */
(function(){
  const btn = $("moreBtn"), menu = $("moreMenu");
  if(!btn || !menu) return;
  const items = ()=> Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(b=>!b.disabled);
  function close(returnFocus){
    if(menu.classList.contains("hidden")) return;
    menu.classList.add("hidden"); btn.setAttribute("aria-expanded", "false");
    if(returnFocus) btn.focus();
  }
  function open(){
    const copy = $("moreCopyId");
    copy.disabled = !activeId;   // idChip is hidden until a session is active
    menu.classList.remove("hidden"); btn.setAttribute("aria-expanded", "true");
    const first = items()[0]; if(first) first.focus();
  }
  btn.addEventListener("click", ()=>{ menu.classList.contains("hidden") ? open() : close(true); });
  menu.addEventListener("click", (e)=>{
    const item = e.target.closest("[data-target]"); if(!item || item.disabled) return;
    const target = $(item.dataset.target);
    close(false);
    if(!target) return;
    target.click();
    if(item.dataset.target === "idChip") showToast("Session ID copied", "success");
  });
  menu.addEventListener("keydown", (e)=>{
    const list = items(), i = list.indexOf(document.activeElement);
    if(e.key === "ArrowDown"){ e.preventDefault(); list[(i+1) % list.length].focus(); }
    else if(e.key === "ArrowUp"){ e.preventDefault(); list[(i-1+list.length) % list.length].focus(); }
    else if(e.key === "Escape"){ e.preventDefault(); e.stopPropagation(); close(true); }
    else if(e.key === "Tab"){ close(false); }
  });
  document.addEventListener("pointerdown", (e)=>{ if(!menu.classList.contains("hidden") && !$("moreWrap").contains(e.target)) close(false); });
  window.addEventListener("resize", ()=> close(false));
})();
$("scrim").onclick = ()=>{
  $("sidebar").classList.remove("open");
  $("right").classList.remove("open");
  toggleScrim(false);
};
function toggleScrim(on){ $("scrim").classList.toggle("hidden", !on); }
function selectTab(showSkills){
  $("tabSkills").classList.toggle("on", showSkills);
  $("tabTools").classList.toggle("on", !showSkills);
  $("skillsList").classList.toggle("hidden", !showSkills);
  $("toolsList").classList.toggle("hidden", showSkills);
}
$("tabSkills").onclick = ()=> selectTab(true);
$("tabTools").onclick = ()=> selectTab(false);
function openSettings(){
  $("settingsModal").classList.remove("hidden");
  runDiag();
}
$("infoBtn").onclick = openSettings;
$("pinSidebarBtn").onclick = toggleSidebarPin;
pinMatcher.addEventListener("change", ()=>{ applySidebarState(isSidebarPinnedPref(), false); });
window.addEventListener("keydown", (e)=>{
  if(e.key === "Escape" && !isSidebarPinnedEffective()){
    const s = $("sidebar");
    if(s && s.classList.contains("open")){
      s.classList.remove("open");
      toggleScrim(false);
    }
  }
});
$("settingsBtn").onclick = openSettings;
$("settingsClose").onclick = ()=> $("settingsModal").classList.add("hidden");
$("diagBtn").onclick = runDiag;
$("logoutBtn").onclick = logout;
$("modelChip").onclick = openModelModal;
$("modelModalClose").onclick = closeModelModal;
$("modelSearchInput").addEventListener("input", (e)=> renderModelList(e.target.value));
$("modelSearchInput").addEventListener("keydown", (e)=>{
  if(e.key === "Escape"){
    closeModelModal();
  } else if(e.key === "Enter"){
    const q = e.target.value.trim();
    if(!q) return;
    const firstCustom = document.querySelector(".model-custom-item");
    const firstItem = document.querySelector(".model-item");
    if(firstCustom){
      firstCustom.click();
    } else if(firstItem){
      firstItem.click();
    }
  }
});
$("modelCustomToggle").onclick = ()=>{
  const wrap = $("modelCustomWrap");
  wrap.classList.toggle("hidden");
  if(!wrap.classList.contains("hidden")){
    $("customModelInput").focus();
  }
};
$("customModelInput").addEventListener("keydown", e=>{ if(e.key === "Enter") $("customModelApplyBtn").click(); });
$("customProviderInput").addEventListener("keydown", e=>{ if(e.key === "Enter") $("customModelApplyBtn").click(); });
$("modelModal").addEventListener("click", e=>{ if(e.target === e.currentTarget) closeModelModal(); });
$("settingsModal").addEventListener("click", e=>{ if(e.target === e.currentTarget) $("settingsModal").classList.add("hidden"); });
$("customModelApplyBtn").onclick = ()=>{
  const prov = $("customProviderInput").value.trim();
  const mod = $("customModelInput").value.trim();
  if(!mod){
    $("modelDiag").textContent = "Please enter a model name.";
    return;
  }
  const isSetDef = $("modelSetDefault").checked;
  applyModel(mod, prov, isSetDef);
};
$("offlineRetryBtn").onclick = async ()=>{
  showToast("Reconnecting…", "info");
  const inputEl = $("input");
  if(inputEl && !inputEl.value){
    inputEl.value = loadDraft(activeId) || loadDraft(null);
    updateRingState();
  }
  const authed = await ensureAuth();
  if(authed) boot();
};

window.addEventListener("online", async () => {
  showOfflineBanner(false);
  if(!booted){
    const authed = await ensureAuth();
    if(authed) boot();
  } else {
    probe();
    refresh();
    probePendingClarify();
  }
});
window.addEventListener("offline", () => {
  setStatus("bad");
  showOfflineBanner(true, "⚠️ Offline — Internet connection lost");
});
window.addEventListener("pagehide", () => {
  try { stopAll(true); } catch {}
});

/* message-action delegation (desktop hover buttons + mobile layout) */
$("thread").addEventListener("click", e=>{
  const b = e.target.closest(".msgActions button");
  if(b){
    const bubble = b.closest(".msg");
    handleMsgAction(b.dataset.act, bubble.dataset.text, bubble);
  }
});

/* ---------- service worker (PWA) ---------- */
if("serviceWorker" in navigator){
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(()=>console.warn("service worker unavailable"));
  });
}

/* ---------- boot with auth gate ---------- */
(async function(){
  try{
    const ok = await ensureAuth();
    if(ok) boot();
  }catch{
    showAuth("The application could not initialize. Start the proxy and try again.");
  }
})();
