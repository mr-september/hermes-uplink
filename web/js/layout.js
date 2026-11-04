import {api} from "./api.js";
import {state} from "./state.js";
import {$, messageElement, showError, showLoading, showToast, store} from "./util.js";

// Panels and menus: the session sidebar (pinned or a flyout), the skills/toolsets panel, the narrow-header More menu.

const PIN_STORAGE_KEY = "hermes-uplink-sidebar-pinned";
// Wide enough to pin the sidebar beside the thread.
const pinMatcher = window.matchMedia("(min-width: 1024px), (min-width: 768px) and (orientation: landscape)");
const narrowMatcher = window.matchMedia("(max-width:1023px)");

function isSidebarPinnedPref(){
  const stored = store.get(PIN_STORAGE_KEY);
  return stored !== null ? stored === "true" : window.innerWidth >= 1024;
}
function isSidebarPinnedEffective(){
  return pinMatcher.matches && isSidebarPinnedPref();
}
function applySidebarState(pinned, openFlyout = false){
  const effective = pinMatcher.matches && pinned;
  document.body.classList.toggle("sidebar-pinned", effective);
  const pinBtn = $("pinSidebarBtn");
  pinBtn.setAttribute("aria-pressed", effective ? "true" : "false");
  pinBtn.title = effective ? "Unpin sidebar" : "Pin sidebar";
  if(effective) setFlyout($("sidebar"), false);
  else if(openFlyout) setFlyout($("sidebar"), true);
}
function toggleSidebarPin(){
  if(!pinMatcher.matches) return;
  const next = !document.body.classList.contains("sidebar-pinned");
  store.set(PIN_STORAGE_KEY, String(next));
  applySidebarState(next, !next);
}

// A flyout panel (the sidebar, or the skills panel on narrow screens) over the scrim.
function setFlyout(panel, open){
  panel.classList.toggle("open", open);
  $("scrim").classList.toggle("hidden", !open);
}
// Opening a session closes the sidebar unless it is pinned.
export function closeSidebarFlyout(){
  if(!isSidebarPinnedEffective()) setFlyout($("sidebar"), false);
}

/* ---------- skills / toolsets ---------- */
async function loadCardList(elId, path, label, buildCard){
  const el = $(elId);
  const hasExisting = el.querySelector(".card");
  if(!hasExisting) showLoading(el);
  try{
    const r = await api(path);
    if(!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    const arr = Array.isArray(d) ? d : (d.data || []);
    el.replaceChildren(...arr.map(buildCard));
    if(!arr.length) el.appendChild(messageElement("None reported."));
  }catch{ if(!hasExisting) showError(el, "Failed to load " + label + "."); }
}
function textDiv(className, text){
  const d = document.createElement("div");
  d.className = className;
  d.textContent = text;
  return d;
}
function infoCard(...children){
  const c = document.createElement("div");
  c.className = "card";
  c.append(...children);
  return c;
}
export function loadSkills(){
  return loadCardList("skillsList", "/v1/skills", "skills", s=>
    infoCard(textDiv("n", String(s.name || s.id || "?")), textDiv("d", String(s.description || ""))));
}
export function loadTools(){
  return loadCardList("toolsList", "/v1/toolsets", "toolsets", t=>{
    const enabled = t.enabled != null ? " · " + (t.enabled ? "enabled" : "disabled") : "";
    const c = infoCard(textDiv("n", String(t.name || t.label || "?")), textDiv("d", String(t.description || "") + enabled));
    const tools = (t.tools || []).map(String).join(", ");
    if(tools) c.appendChild(textDiv("tools", tools));
    return c;
  });
}
function selectTab(showSkills){
  $("tabSkills").classList.toggle("on", showSkills);
  $("tabTools").classList.toggle("on", !showSkills);
  $("skillsList").classList.toggle("hidden", !showSkills);
  $("toolsList").classList.toggle("hidden", showSkills);
}
// Narrow screens: the panel is a flyout. Wide screens: it is the third column, collapsed or not.
function toggleRightPanel(){
  const r = $("right");
  if(narrowMatcher.matches) setFlyout(r, !r.classList.contains("open"));
  else r.classList.toggle("collapsed");
  if(!r.classList.contains("collapsed")){ loadSkills(); loadTools(); }   // fresh on every open
}

/* ---------- More menu (narrow header): proxies the header buttons it hides ---------- */
function initMoreMenu(){
  const btn = $("moreBtn"), menu = $("moreMenu");
  const items = ()=> Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(b=> !b.disabled);
  const isOpen = ()=> !menu.classList.contains("hidden");
  function close(returnFocus){
    if(!isOpen()) return;
    menu.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
    if(returnFocus) btn.focus();
  }
  function open(){
    $("moreCopyId").disabled = !state.activeId;   // idChip is hidden until a session is active
    menu.classList.remove("hidden");
    btn.setAttribute("aria-expanded", "true");
    items()[0]?.focus();
  }
  btn.addEventListener("click", ()=> isOpen() ? close(true) : open());
  menu.addEventListener("click", (e)=>{
    const item = e.target.closest("[data-target]");
    if(!item || item.disabled) return;
    close(false);
    $(item.dataset.target)?.click();
    if(item.dataset.target === "idChip") showToast("Session ID copied", "success");
  });
  menu.addEventListener("keydown", (e)=>{
    const list = items(), i = list.indexOf(document.activeElement);
    if(e.key === "ArrowDown"){ e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if(e.key === "ArrowUp"){ e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if(e.key === "Escape"){ e.preventDefault(); e.stopPropagation(); close(true); }
    else if(e.key === "Tab"){ close(false); }
  });
  document.addEventListener("pointerdown", (e)=>{ if(isOpen() && !$("moreWrap").contains(e.target)) close(false); });
  window.addEventListener("resize", ()=> close(false));
}

export function initLayout(){
  applySidebarState(isSidebarPinnedPref(), false);
  pinMatcher.addEventListener("change", ()=> applySidebarState(isSidebarPinnedPref(), false));
  $("pinSidebarBtn").onclick = toggleSidebarPin;
  $("menuBtn").onclick = ()=> setFlyout($("sidebar"), !$("sidebar").classList.contains("open"));
  $("rightBtn").onclick = toggleRightPanel;
  $("scrim").onclick = ()=>{
    $("right").classList.remove("open");
    setFlyout($("sidebar"), false);
  };
  $("tabSkills").onclick = ()=> selectTab(true);
  $("tabTools").onclick = ()=> selectTab(false);
  window.addEventListener("keydown", (e)=>{
    if(e.key === "Escape" && !isSidebarPinnedEffective() && $("sidebar").classList.contains("open")) setFlyout($("sidebar"), false);
  });
  initMoreMenu();
}
