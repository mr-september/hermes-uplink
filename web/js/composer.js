import {foregroundStream, state} from "./state.js";
import {send, stop} from "./stream.js";
import {$, safeRole, store, str} from "./util.js";

// The composer: the message box, its per-session drafts, and the ring button (send / stop, with context usage).

const FINE_POINTER = window.matchMedia("(pointer: fine)").matches;

/* ---------- drafts ---------- */
// A draft survives reloads and failed sends; its turn id goes with it so a resend is recognisable as the same turn.
function draftKey(sessId){ return "hermes-uplink-draft-" + (sessId || "global"); }
function draftTurnKey(sessId){ return "hermes-uplink-turn-" + (sessId || "global"); }
// turnId: a value stores it, "" clears it, undefined leaves it as it is.
export function saveDraft(sessId, val, turnId){
  if(val && val.trim()){
    store.set(draftKey(sessId), val);
    if(turnId) store.set(draftTurnKey(sessId), turnId);
    else if(turnId === "") store.remove(draftTurnKey(sessId));
  }else{
    store.remove(draftKey(sessId));
    store.remove(draftTurnKey(sessId));
  }
}
export function loadDraft(sessId){ return store.get(draftKey(sessId)) || ""; }
export function loadDraftTurnId(sessId){ return store.get(draftTurnKey(sessId)) || ""; }
// Drop the draft once history shows it was committed as the session's latest user message.
export function reconcileDraftWithMessages(sessId, msgs){
  if(!sessId || !Array.isArray(msgs)) return;
  const draft = loadDraft(sessId).trim();
  const lastUser = msgs.slice().reverse().find(m=> safeRole(m.role) === "user");
  if(!draft || !lastUser || str(lastUser.content).trim() !== draft) return;
  saveDraft(sessId, "");
  const input = $("input");
  if(state.activeId === sessId && input.value.trim() === draft){
    input.value = "";
    updateRingState();
  }
}

/* ---------- ring: context usage around the send / stop button ---------- */
export function num(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
export function applyContextFrom(obj){
  if(!obj || typeof obj !== "object") return;
  const used = num(obj.context_used ?? obj.contextTokens ?? obj.tokens_used ?? obj.used_tokens);
  const limit = num(obj.context_window ?? obj.contextWindow ?? obj.max_tokens ?? obj.context_limit);
  if(!(limit > 0)) return;
  const ring = $("ring");
  const pct = Math.max(0, Math.min(100, Math.round(used / limit * 100)));
  ring.style.setProperty("--pct", pct + "%");
  ring.style.setProperty("--ringFill", pct < 70 ? "var(--green)" : pct < 90 ? "var(--accent)" : "var(--red)");
  ring.title = `Context: ${used} / ${limit} tokens (${pct}%)`;
}
export function updateRingState(){
  const ring = $("ring");
  const busy = !!foregroundStream();
  $("ringIcon").innerHTML = busy ? "&#9632;" : "&#9654;";   // ■ stop / ▶ send
  ring.classList.toggle("busy", busy);
  ring.setAttribute("aria-label", busy ? "Stop" : "Send");
  ring.disabled = !busy && !$("input").value.trim();
}

export function initComposer(){
  const input = $("input");
  // Coarse pointer: Enter inserts a newline (Ctrl+Enter or the send button sends), so don't advertise Enter-to-send.
  if(!FINE_POINTER) input.placeholder = "Message the agent…";
  $("ring").onclick = ()=>{ if(foregroundStream()) stop(); else send(); };
  input.addEventListener("keydown", e=>{
    if(e.key === "Enter" && (e.ctrlKey || (FINE_POINTER && !e.shiftKey))){
      e.preventDefault();   // Ctrl+Enter always sends; with a physical keyboard Enter sends and Shift+Enter is a newline
      send();
    }else if(e.key === "Escape"){
      e.target.blur();      // dismisses the on-screen keyboard
    }
  });
  input.addEventListener("input", ()=>{
    saveDraft(state.activeId, input.value, "");
    updateRingState();
  });
}
