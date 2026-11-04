import {api, failureMessage, postJson, sessionUrl} from "./api.js";
import {cfg, saveCfg, state} from "./state.js";
import {$, messageElement, parseJson, showToast, store} from "./util.js";

// The model chip and picker: the session's model/provider, the gateway's provider catalogue, the default for new chats.
const MODEL_CACHE_KEY = "hermes-uplink-model-options";
let modelOptions = null;   // GET /api/model/options, cached across reloads

export function loadCachedModelOptions(){
  const cached = parseJson(store.get(MODEL_CACHE_KEY));
  if(cached && typeof cached === "object") modelOptions = cached;
}

export async function fetchModelOptions(){
  const chip = $("modelChip");
  if(!modelOptions) chip.classList.add("loading");
  try{
    const r = await api("/api/model/options");
    if(!r.ok) return;
    const data = await r.json();
    if(!data || typeof data !== "object") return;
    modelOptions = data;
    store.set(MODEL_CACHE_KEY, JSON.stringify(data));
    updateModelChip(state.sessionModel, state.sessionProvider);
    if(!$("modelModal").classList.contains("hidden")) renderModelList($("modelSearchInput").value || "");
  }catch{
    /* the cached catalogue (if any) stays in use */
  }finally{
    chip.classList.remove("loading");
  }
}

// The session on screen uses this model/provider (null: the default applies).
export function setSessionModel(model, provider){
  state.sessionModel = model || null;
  state.sessionProvider = provider || null;
  updateModelChip(state.sessionModel, state.sessionProvider);
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

export function updateModelChip(modelName, providerName){
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
  fetchModelOptions();
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
  const currentActive = state.sessionModel || cfg.defaultModel || (modelOptions && modelOptions.model) || "";

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
    if(state.activeId){
      const res = await postJson(sessionUrl(state.activeId, "/model"), {model, provider: provider || ""});
      if(!res.ok) throw new Error(await failureMessage(res));
      state.sessionModel = model;
      state.sessionProvider = provider || null;
    }
    if(setDefault || !state.activeId){
      cfg.defaultModel = model;
      cfg.defaultProvider = provider || "";
      saveCfg();
    }
    updateModelChip(state.sessionModel || model, state.sessionProvider || provider);
    closeModelModal();
  }catch(e){
    if(diag) diag.textContent = "Failed to switch model: " + (e.message || e);
    else showToast("Failed to switch model: " + (e.message || e), "error");
  }
}

export function initModelPicker(){
  const search = $("modelSearchInput");
  $("modelChip").onclick = openModelModal;
  $("modelModalClose").onclick = closeModelModal;
  $("modelModal").addEventListener("click", e=>{ if(e.target === e.currentTarget) closeModelModal(); });
  search.addEventListener("input", ()=> renderModelList(search.value));
  search.addEventListener("keydown", (e)=>{
    if(e.key === "Escape") closeModelModal();
    // Enter takes the custom-model entry when one is offered, else the first match.
    else if(e.key === "Enter" && search.value.trim()) document.querySelector(".model-custom-item, .model-item")?.click();
  });
  $("modelCustomToggle").onclick = ()=>{
    const wrap = $("modelCustomWrap");
    wrap.classList.toggle("hidden");
    if(!wrap.classList.contains("hidden")) $("customModelInput").focus();
  };
  const applyCustom = ()=>{
    const model = $("customModelInput").value.trim();
    if(!model){ $("modelDiag").textContent = "Please enter a model name."; return; }
    applyModel(model, $("customProviderInput").value.trim(), $("modelSetDefault").checked);
  };
  $("customModelApplyBtn").onclick = applyCustom;
  for(const id of ["customModelInput", "customProviderInput"]){
    $(id).addEventListener("keydown", e=>{ if(e.key === "Enter") applyCustom(); });
  }
}
