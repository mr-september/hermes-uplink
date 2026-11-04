import {updateRingState} from "./composer.js";
import {extractModelTags, setBody} from "./markdown.js";
import {openSession} from "./sessions.js";
import {foregroundStream, localThread, sessionRenderCache, state} from "./state.js";
import {streamTurn} from "./stream.js";
import {$, parseJson, safeRole, str} from "./util.js";

// The thread: message bubbles, tool and thought cards, history rendering, and the actions on the user's messages.

export function atBottom(){
  const t = $("thread");
  return t.scrollHeight - t.scrollTop - t.clientHeight < 48;
}
// Follow new content only when the reader is already at the bottom.
export function maybeAutoscroll(){
  if(atBottom()){ const t = $("thread"); t.scrollTop = t.scrollHeight; }
}

/* ---------- user message actions (edit / restore / rerun) ---------- */
function buildMsgActions(){
  const wrap = document.createElement("div");
  wrap.className = "msgActions";
  for(const [act, glyph, title] of [["edit", "✎", "Edit"], ["restore", "↩", "Restore to input"], ["rerun", "↻", "Rerun"]]){
    const b = document.createElement("button");
    b.textContent = glyph;
    b.title = title;
    b.dataset.act = act;
    wrap.appendChild(b);
  }
  return wrap;
}
export function handleMsgAction(act, text, bubble){
  if(act === "restore"){
    const input = $("input");
    input.value = text; input.focus(); updateRingState();
  }else if(act === "rerun"){
    if(state.activeId && !foregroundStream()) streamTurn(text, state.activeId);
  }else if(act === "edit"){
    if(state.activeId) inlineEdit(bubble, text);
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

    streamTurn(v, state.activeId);
  };
  cancel.onclick = ()=>{ openSession(state.activeId, $("activeTitle").textContent); };
}

/* ---------- rendering ---------- */
export function addMsg(role, text){
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
export function renderThread(msgs){
  if(state.activeId){
    sessionRenderCache.set(state.activeId, Array.isArray(msgs) ? msgs.slice() : []);
    state.renderedSessionId = state.activeId;
    localThread.delete(state.activeId);     // rebuilt from history: nothing stream-built is left on screen
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
export function addToolCard(name, cid, state, input, out, bubble){
  // Tool cards belong to the turn that produced them: append to that
  // bubble (staying inside its message flow), falling back to the thread
  // only when no bubble is known.
  const t = bubble || $("thread");
  const c = buildToolCard(name, state, input, out, cid);
  if(state === "run") c.open = true;
  t.appendChild(c);
  if(t.isConnected) t.scrollTop = t.scrollHeight;
}
export function updateToolCard(cid, state, out, bubble, name){
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

function formatPayload(x){
  if(x == null || x === "") return "";
  if(typeof x === "object"){
    try{ return JSON.stringify(x, null, 2); }catch{ return String(x); }
  }
  if(typeof x === "string"){
    const trimmed = x.trim();
    if((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))){
      const parsed = parseJson(trimmed);
      if(parsed !== null) return JSON.stringify(parsed, null, 2);
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
