import {api, postJson, sessionUrl} from "./api.js";
import {syncActiveClarify} from "./clarify.js";
import {applyContextFrom, loadDraft, num, reconcileDraftWithMessages, updateRingState} from "./composer.js";
import {setStatus, showAuth} from "./connection.js";
import {closeSidebarFlyout} from "./layout.js";
import {setSessionModel} from "./models.js";
import {attention, cfg, foregroundStream, localThread, sessionRenderCache, state, streams} from "./state.js";
import {addMsg, renderThread} from "./thread.js";
import {$, badgeElement, messageElement, relTime, showError, showLoading, showToast} from "./util.js";

// Sessions: the list (with unread and needs-attention markers), opening and creating sessions, history, refresh.

/* ---------- manual / on-focus refresh ----------
   There is deliberately no background poller (battery). The app refreshes when the user clicks Refresh or returns
   to the tab / window; with the shared session store, edge devices converge as soon as the user looks. */
let refreshing = false;
export function historyMessages(data){ return data.data || data.messages || (Array.isArray(data) ? data : []); }
// `manual` is truthy for the Refresh button (it passes its click event); focus / visibility / online call it bare.
export async function refresh(manual){
  if(refreshing) return;
  // A live stream owns the thread, and a finished turn's cards / "[stopped]" are content history cannot reproduce:
  // only the list is refreshed then (the Refresh button still rebuilds the latter).
  if(!state.activeId || foregroundStream() || (!manual && localThread.has(state.activeId))){
    await loadSessions();
    return;
  }
  refreshing = true;
  const id = state.activeId;
  const btn = $("refreshBtn");
  btn.classList.add("busy-dim");
  try{
    await loadSessions();
    const data = await fetchHistory(id);
    if(state.activeId !== id) return;
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

/* ---------- unread state (shared read watermark; see docs/session-status.md) ---------- */
// Backend: sessions rows carry `unread` (activity newer than the shared last_read_at); PATCH {unread:false} stamps it.
// A just-written local value outranks a list page for UNREAD_WRITE_GUARD_MS (mirrors Electron's write guard) so a stale
// page cannot flip a just-read session back to unread. Absent `unread` (older backend) renders nothing.
const UNREAD_WRITE_GUARD_MS = 10000;
const READ_MARK_MIN_INTERVAL_MS = 10000;
const unreadGuard = new Map();   // id -> {value:boolean, at:ms}
const lastReadMark = new Map();  // id -> ms of last write (rate limit for passive triggers)
export let lastSessionRows = [];
function effectiveUnread(s){
  const g = unreadGuard.get(s.id);
  if(g && Date.now() - g.at < UNREAD_WRITE_GUARD_MS) return g.value;
  return s.unread === true;
}
function updateDrawerDot(){
  const btn = $("menuBtn");
  if(!btn) return;
  const has = lastSessionRows.some(s=> s.id !== state.activeId && effectiveUnread(s)) || Array.from(attention.keys()).some(id=> id !== state.activeId);
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
export async function markRead(id, reason){
  if(!id || document.visibilityState !== "visible") return;
  const passive = reason !== "open" && reason !== "completion";
  const now = Date.now();
  if(passive && (foregroundStream() || now - (lastReadMark.get(id) || 0) < READ_MARK_MIN_INTERVAL_MS)) return;
  lastReadMark.set(id, now);
  unreadGuard.set(id, {value: false, at: now});
  clearRowUnread(id);
  updateDrawerDot();
  try{
    const r = await postJson(sessionUrl(id), {unread: false}, "PATCH");
    if(!r.ok) throw new Error("HTTP " + r.status);
  }catch{
    unreadGuard.delete(id); lastReadMark.delete(id);   // write failed: do not pretend it was read
  }
}

/* ---------- sessions ---------- */
export async function loadSessions(){
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

export function renderSessions(sessions){
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
    div.className = "sess" + (s.id===state.activeId?" active":"");
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
  if(!state.activeId){ chip.classList.add("hidden"); return; }
  chip.classList.remove("hidden");
  idEl.textContent = state.activeId.length > 8 ? state.activeId.slice(-7) : state.activeId;
  chip.title = "Copy session ID: " + state.activeId;
  chip.setAttribute("aria-label", "Copy session ID " + state.activeId);
}
export function copyActiveId(){
  if(!state.activeId) return;
  const ok = ()=>{ flashCopied(); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(state.activeId).then(ok).catch(()=>fallbackCopy(state.activeId, ok));
  } else { fallbackCopy(state.activeId, ok); }
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

// Leaving a session that owns a stream (running, or finished while we were away): move its thread nodes into the
// stream's detached holder so frames keep landing in them and nothing is lost when the user comes back.
function parkThread(sid){
  const S = streams.get(sid);
  if(!S || state.renderedSessionId !== sid) return;
  const t = $("thread");
  S.holder.dataset.parked = "1";
  S.holder.replaceChildren(...Array.from(t.childNodes));
  t.replaceChildren();
  state.renderedSessionId = null;
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
export function updateAttentionUi(){
  document.querySelectorAll(".sess").forEach(x=> decorateAttention(x, x.dataset.sid));
  updateDrawerDot();
}
export function setAttention(sid, kind){
  if(!sid || sid === state.activeId) return;
  if(attention.get(sid) === "question" && kind !== "question") return;
  attention.set(sid, kind);
  updateAttentionUi();
}
function clearAttention(sid){
  if(attention.delete(sid)) updateAttentionUi();
}
export function sessionTitleOf(sid){
  const row = Array.from(document.querySelectorAll(".sess")).find(x=> x.dataset.sid === sid);
  const t = row && row.querySelector(".t");
  return (t && t.textContent) || sid;
}

// Session detail (context usage, model); null when unavailable, since it only decorates the history.
async function fetchSessionDetail(id){
  try{
    const r = await api(sessionUrl(id));
    if(!r.ok) return null;
    const detail = await r.json();
    return detail.session || detail;
  }catch{ return null; }
}

// History + context + model for a session, merged into one object (does not touch the thread).
export async function fetchHistory(id){
  const r = await api(sessionUrl(id, "/messages"));
  if(!r.ok) throw new Error("HTTP " + r.status);
  const data = await r.json();
  const detail = await fetchSessionDetail(id);
  if(detail && state.activeId === id){
    const used = num(detail.context_used ?? detail.contextTokens);
    const limit = num(detail.context_limit ?? detail.context_window ?? detail.contextWindow ?? detail.max_tokens);
    if(limit > 0 && used > 0){ data.context_used = used; data.context_limit = limit; }
    setSessionModel(detail.model, detail.provider);
  }
  return data;
}

export async function openSession(id, title){
  // Leaving a session does NOT stop its turn: the stream keeps running, writing into its own thread nodes, and the
  // user finds the result (and any question it raised) when coming back. Only Stop / pagehide end a stream.
  const prevId = state.activeId;
  if(prevId && prevId !== id) parkThread(prevId);
  closeSidebarFlyout();
  state.activeId = id;
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
  const isSessionSwitch = state.renderedSessionId !== id;
  if(isSessionSwitch){
    state.renderedSessionId = id;
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
    if(state.activeId === id){
      if(!keepThread){
        renderThread(msgs);
        reconcileDraftWithMessages(id, msgs);
      }
      markRead(id, "open");   // only after history loaded successfully
    }
  }catch(e){
    if(state.activeId === id){
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
  if(state.activeId !== id) return;
  document.querySelectorAll(".sess").forEach(x=>x.classList.toggle("active", x.dataset.sid === id));
  await loadSessions();
}

export async function newSession(){
  try{
    const payload = {};
    if(cfg.defaultModel){
      payload.model = cfg.defaultModel;
      if(cfg.defaultProvider) payload.provider = cfg.defaultProvider;
    }
    const r = await postJson("/api/sessions", payload);
    if(!r.ok) throw new Error("HTTP " + r.status);
    const s = await r.json();
    const id = s.id || (s.session && s.session.id);
    if(!id) throw new Error("no id in response");
    setSessionModel(cfg.defaultModel, cfg.defaultProvider);
    await loadSessions();
    await openSession(id, "New chat");
  }catch(e){ showToast("New chat failed: " + e.message, "error"); }
}
