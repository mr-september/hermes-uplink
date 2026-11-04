// Small helpers with no application state: DOM lookup, storage, parsing, formatting, toasts.
export const $ = (id) => document.getElementById(id);
// localStorage can throw (private browsing, blocked site data); persistence is best-effort throughout.
export const store = {
  get(key){ try{ return localStorage.getItem(key); }catch{ return null; } },
  set(key, value){ try{ localStorage.setItem(key, value); }catch{} },
  remove(key){ try{ localStorage.removeItem(key); }catch{} },
};
// JSON.parse that returns null instead of throwing.
export function parseJson(text){
  try{ return JSON.parse(text); }catch{ return null; }
}

export function generateUUID(){
  if(typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"){
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c){
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export function showToast(text, type="info"){
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

export function str(x){
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

export function escapeHtml(value){
  return String(value==null?"" : value).replace(/[&<>\"']/g, char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
}
export function relTime(ts){
  if(!ts) return "";
  const value = typeof ts === "string" ? Date.parse(ts)/1000 : Number(ts);
  if(!Number.isFinite(value)) return "";
  const d=Date.now()/1000 - value;
  if(d<60) return "just now";
  if(d<3600) return Math.floor(d/60)+"m ago";
  if(d<86400) return Math.floor(d/3600)+"h ago";
  return Math.floor(d/86400)+"d ago";
}
export function safeRole(value){
  const role = String(value||"system").toLowerCase();
  return ["assistant","user","tool","system"].includes(role) ? role : "system";
}
export function messageElement(text){
  const el=document.createElement("div");
  el.className="note";
  el.textContent=String(text);
  return el;
}
export function showLoading(el){ el.replaceChildren(messageElement("Loading…")); }
export function showError(el, text){
  const error=messageElement(text);
  error.classList.add("err");
  el.replaceChildren(error);
}
export function badgeElement(text, extraClass){
  const badge=document.createElement("span");
  badge.className="badge"+(extraClass?" "+extraClass:"");
  badge.textContent=String(text);
  return badge;
}
