import {api, postJson} from "./api.js";
import {boot} from "./main.js";
import {$} from "./util.js";

// Reachability and the passphrase gate: offline banner, status dot, login/logout, the Connection dialog's test.

export function showOfflineBanner(show, msg){
  if(show && msg) $("offlineBannerText").textContent = msg;
  $("offlineBanner").classList.toggle("hidden", !show);
}

export function showAuth(message){
  $("authDiag").textContent = message || "";
  $("authModal").classList.remove("hidden");
  $("authInput").focus();
}

// True when the proxy is reachable and this browser is signed in; otherwise shows the offline banner or the gate.
export async function ensureAuth(){
  try{
    const r = await api("/api/sessions?limit=1");
    showOfflineBanner(false);
    if(r.status !== 401) return true;
  }catch{
    setStatus("bad");
    showOfflineBanner(true, "⚠️ Offline — Cannot reach Uplink proxy. Reconnecting…");
    scheduleProbe();
    return false;
  }
  showAuth("Enter the passphrase shown on your desktop launcher.");
  return false;
}

export async function submitAuth(){
  const passphrase = $("authInput").value.trim();
  const diag = $("authDiag");
  if(!passphrase){ diag.textContent = "Enter the passphrase."; return; }
  const button = $("authSubmit");
  button.disabled = true;
  try{
    const r = await postJson("/__auth", {passphrase});
    if(r.status === 204){
      $("authInput").value = "";
      $("authModal").classList.add("hidden");
      showOfflineBanner(false);
      boot();
    }else{
      diag.textContent = r.status === 429 ? "Too many attempts. Wait briefly and try again."
                       : r.status === 401 ? "Incorrect passphrase." : "Authentication service unavailable.";
    }
  }catch{
    diag.textContent = "Cannot reach the Uplink proxy.";
  }finally{
    button.disabled = false;
  }
}

export async function logout(){
  // Best effort: reload either way; the login gate shows if the session survived.
  try{ await api("/__logout", {method: "POST"}); }catch{}
  window.location.reload();
}

/* ---------- status dot + silent retry ---------- */
let retryTimer = null;
export function setStatus(status){
  const d = $("statusDot");
  d.className = "dot " + (status === "ok" ? "done" : status === "bad" ? "run" : "");
  d.title = status === "ok" ? "Connected" : status === "bad" ? "Reconnecting…" : "Connecting…";
  d.setAttribute("aria-label", "Connection: " + d.title);
}
export async function probe(){
  try{
    const r = await api("/health");
    setStatus(r.ok ? "ok" : "bad");
    if(!r.ok){ scheduleProbe(); return; }
    showOfflineBanner(false);
    clearTimeout(retryTimer);
  }catch{
    setStatus("bad");
    scheduleProbe();
  }
}
function scheduleProbe(){
  clearTimeout(retryTimer);
  retryTimer = setTimeout(probe, 8000);
}

/* ---------- Connection dialog: test ---------- */
export async function runDiag(){
  const out = $("diag");
  out.textContent = "Testing…";
  const lines = [];
  try{
    const r = await api("/health");
    lines.push("GET /health → " + r.status + (r.ok ? " (ok)" : ""));
  }catch(e){ lines.push("GET /health → " + e.message); }
  try{
    const r = await api("/v1/capabilities");
    if(!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    lines.push("GET /v1/capabilities → " + r.status);
    if(d.features){
      const on = Object.entries(d.features).filter(([, v])=> v).map(([k])=> k).join(", ");
      lines.push("features: " + (on || "(none advertised)"));
    }
  }catch(e){ lines.push("GET /v1/capabilities → " + e.message); }
  try{
    const r = await api("/api/sessions?limit=1");
    lines.push("GET /api/sessions → " + r.status);
  }catch(e){ lines.push("GET /api/sessions → " + e.message); }
  out.textContent = lines.join("\n");
}
export function openSettings(){
  $("settingsModal").classList.remove("hidden");
  runDiag();
}
