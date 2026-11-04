// Requests to the proxy (same origin; the session cookie authenticates them).
export function api(path, opts={}){
  return fetch(path, {...opts, credentials: "same-origin"});
}
export function sessionUrl(id, suffix=""){
  return "/api/sessions/" + encodeURIComponent(id) + suffix;
}
// POST a JSON body.
export function postJson(path, body, method="POST"){
  return api(path, {method, headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
}
// The message of a failed response: the gateway's {error:{message}} when it sent one, else the status.
export async function failureMessage(res){
  const err = await res.json().catch(()=> ({}));
  return err?.error?.message || "HTTP " + res.status;
}

/* ---------- gateway capabilities (feature gate for client_capabilities) ---------- */
// GET /v1/capabilities is fetched in the background; chatting never waits for it. Until it answers (or if it
// fails or lacks the flags) both capabilities are assumed supported, so old and new gateways both work.
let gatewayCaps = null, gatewayCapsRequested = false, gatewayCapsRetryAt = 0;
export async function loadGatewayCaps(){
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
export function clientCapabilities(){
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
