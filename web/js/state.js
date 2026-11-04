import {parseJson, store} from "./util.js";

// Application state shared across modules. Values that several modules reassign live on `state`; module-private
// state stays in its module.
const LS_KEY = "hermes-uplink-cfg";
export const cfg = loadCfg();   // persisted preferences: {defaultModel, defaultProvider}
export const state = {
  activeId: null,              // the session on screen
  renderedSessionId: null,     // the session whose nodes are in #thread (null while they are parked)
  activeClarifyId: null,       // the visible thread's pending clarify, which the composer answers or skips
  lastClarifyProbeAt: 0,
  probeClarifyAfterTurn: false,
  sessionModel: null,          // model/provider of the session on screen (null: the default applies)
  sessionProvider: null,
};
export const sessionRenderCache = new Map();
// Per-session streams: sid -> S = {sid, abort, runId, lastFrameAt, running, holder, bubble, userBubble, intercepted,
// body, raw, gotText, gotTools}. A stream whose session the user has left keeps writing into its own detached thread
// nodes (S.holder), which are put back on screen on return. A finished entry is kept only while its holder is parked.
export const streams = new Map();
// Sessions that need the user: sid -> "question" (a clarify card is waiting) | "reply" (the turn finished while away).
export const attention = new Map();
// Sessions whose thread holds stream-built content (clarify/tool cards, "[stopped]") that a history rebuild would drop.
// A passive refresh leaves such a thread alone; opening the session or the Refresh button rebuilds it.
export const localThread = new Set();

// The running stream of the session on screen, or null.
export function foregroundStream(){
  const S = streams.get(state.activeId);
  return S && S.running ? S : null;
}

function loadCfg(){
  const value = parseJson(store.get(LS_KEY));
  if(!value || typeof value !== "object") return {};
  if("key" in value || "url" in value){    // direct mode was removed: purge any stored API key
    delete value.key; delete value.url;
    store.set(LS_KEY, JSON.stringify(value));
  }
  return value;
}
export function saveCfg(){ store.set(LS_KEY, JSON.stringify(cfg)); }
