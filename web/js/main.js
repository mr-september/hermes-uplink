import {loadGatewayCaps} from "./api.js";
import {initClarifyHotkeys, probePendingClarify} from "./clarify.js";
import {initComposer, loadDraft, updateRingState} from "./composer.js";
import {ensureAuth, logout, openSettings, probe, runDiag, setStatus, showAuth, showOfflineBanner, submitAuth} from "./connection.js";
import {initLayout, loadSkills, loadTools} from "./layout.js";
import {fetchModelOptions, initModelPicker, loadCachedModelOptions, updateModelChip} from "./models.js";
import {copyActiveId, lastSessionRows, loadSessions, newSession, refresh, renderSessions} from "./sessions.js";
import {state} from "./state.js";
import {stopAll} from "./stream.js";
import {handleMsgAction} from "./thread.js";
import {$, showToast} from "./util.js";

// Entry point: wires the page's controls, then shows the passphrase gate or boots the app.

let booted = false;
export function boot(){
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
  updateModelChip(state.sessionModel, state.sessionProvider);
}

async function reconnect(){
  if(await ensureAuth()) boot();
}

initLayout();
initComposer();
initModelPicker();
initClarifyHotkeys();

$("authSubmit").onclick = submitAuth;
$("authInput").addEventListener("keydown", e=>{ if(e.key === "Enter") submitAuth(); });
$("newBtn").onclick = newSession;
$("refreshBtn").onclick = refresh;
$("idChip").addEventListener("click", copyActiveId);
$("searchInput").addEventListener("input", ()=> renderSessions(lastSessionRows));
$("infoBtn").onclick = openSettings;
$("settingsBtn").onclick = openSettings;
$("settingsClose").onclick = ()=> $("settingsModal").classList.add("hidden");
$("settingsModal").addEventListener("click", e=>{ if(e.target === e.currentTarget) $("settingsModal").classList.add("hidden"); });
$("diagBtn").onclick = runDiag;
$("logoutBtn").onclick = logout;
$("offlineRetryBtn").onclick = ()=>{
  showToast("Reconnecting…", "info");
  const input = $("input");
  if(!input.value){
    input.value = loadDraft(state.activeId) || loadDraft(null);
    updateRingState();
  }
  reconnect();
};
// Message actions on user bubbles (hover buttons on desktop, always shown on touch).
$("thread").addEventListener("click", e=>{
  const b = e.target.closest(".msgActions button");
  if(!b) return;
  const bubble = b.closest(".msg");
  handleMsgAction(b.dataset.act, bubble.dataset.text, bubble);
});

// Coming back to the page refreshes it (there is no background polling) and recovers a question that may be waiting.
document.addEventListener("visibilitychange", ()=>{ if(!document.hidden){ refresh(); probePendingClarify(); } });
window.addEventListener("focus", ()=>{ refresh(); probePendingClarify(); });
window.addEventListener("online", ()=>{
  showOfflineBanner(false);
  if(!booted){ reconnect(); return; }
  probe();
  refresh();
  probePendingClarify();
});
window.addEventListener("offline", ()=>{
  setStatus("bad");
  showOfflineBanner(true, "⚠️ Offline — Internet connection lost");
});
window.addEventListener("pagehide", stopAll);

if("serviceWorker" in navigator){
  window.addEventListener("load", ()=>{
    navigator.serviceWorker.register("sw.js").catch(()=> console.warn("service worker unavailable"));
  });
}

reconnect().catch(()=> showAuth("The application could not initialize. Start the proxy and try again."));
