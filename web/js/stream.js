import {api, clientCapabilities, loadGatewayCaps, sessionUrl} from "./api.js";
import {CLARIFY_STALE_MS, findClarifyCard, probePendingClarify, renderClarifyCard, settleClarifyCard, submitClarifyResponse} from "./clarify.js";
import {applyContextFrom, loadDraftTurnId, reconcileDraftWithMessages, saveDraft, updateRingState} from "./composer.js";
import {setStatus} from "./connection.js";
import {extractModelTags, setCleanBody} from "./markdown.js";
import {fetchHistory, historyMessages, loadSessions, markRead, newSession, sessionTitleOf, setAttention, updateAttentionUi} from "./sessions.js";
import {attention, foregroundStream, localThread, state, streams} from "./state.js";
import {addMsg, addToolCard, atBottom, maybeAutoscroll, updateToolCard} from "./thread.js";
import {$, generateUUID, parseJson, showToast} from "./util.js";

// Turns: POST /api/sessions/{id}/chat/stream and the SSE frames it returns. Each stream S (see state.js) owns its
// assistant bubble and the text being streamed into the bubble's current body node (S.body / S.raw).

const renderTimers = new WeakMap();

function activeBody(S){
  if(!S.body){
    S.body = document.createElement("div");
    S.body.className = "body";
    S.bubble.appendChild(S.body);
    S.raw = "";
  }
  return S.body;
}
// Markdown is re-rendered at most every 80 ms while text streams in (closeBody cancels a pending render).
function scheduleRender(S){
  const body = S.body;
  if(renderTimers.has(body)) return;
  renderTimers.set(body, setTimeout(()=>{
    renderTimers.delete(body);
    const parsed = extractModelTags(S.raw);
    if(parsed.cleanText) setCleanBody(body, parsed.cleanText);
    else if(parsed.activeThought) body.innerHTML = "<span class=\"tool-running\">Thinking…</span>";
  }, 80));
}
// Render the current body now and start a new one for whatever follows (a tool card, a note, the end of the turn).
function closeBody(S){
  const body = S.body;
  if(body){
    clearTimeout(renderTimers.get(body));
    renderTimers.delete(body);
    const parsed = extractModelTags(S.raw);
    if(parsed.cleanText) setCleanBody(body, parsed.cleanText);
  }
  S.body = null;
  S.raw = "";
}
function appendStreamText(S, piece, fg){
  if(!piece) return;
  activeBody(S);
  S.raw += piece;
  S.gotText = true;
  scheduleRender(S);
  if(fg) maybeAutoscroll();
}

// Plain-text note at the end of a turn ("[stopped]", "[error] ..."). A separate node: never overwrite the rendered reply.
function addStreamNote(S, text){
  closeBody(S);
  const n = document.createElement("div");
  n.className = "body stream-note";
  n.textContent = text;
  const stick = S.bubble.isConnected && atBottom();
  S.bubble.appendChild(n);
  if(stick){ const t = $("thread"); t.scrollTop = t.scrollHeight; }
}

// Put text that never reached the server back in the composer (if it is empty and showing that session).
function restoreToComposer(sid, text){
  const input = $("input");
  if(input && !input.value && state.activeId === sid){
    input.value = text;
    updateRingState();
  }
}

// After a turn ends in the session being viewed: refresh context / model / read state / session list, but leave the
// thread alone (it already shows exactly what the user watched arrive, including cards and "[stopped]").
async function syncAfterTurn(id){
  try{
    const data = await fetchHistory(id);
    if(state.activeId === id){
      applyContextFrom(data);
      reconcileDraftWithMessages(id, historyMessages(data));
      markRead(id, "completion");
    }
  }catch{
    if(state.activeId === id) setStatus("bad");
  }
  if(state.activeId === id) await loadSessions();
}

// The client generates the turn id and sends it as Idempotency-Key, X-Client-Turn-ID and client_turn_id; a resend of
// the same draft reuses it (see composer.js), so a gateway that deduplicates turns can recognise a retry.
export async function streamTurn(text, sessionId, opts={}){
  if(streams.get(sessionId)?.running) return;
  const turnId = opts.turnId || generateUUID();
  const S = {sid: sessionId, abort: new AbortController(), runId: null, lastFrameAt: Date.now(), running: true,
             holder: document.createElement("div"), bubble: null, userBubble: addMsg("user", text), intercepted: false,
             body: null, raw: "", gotText: false, gotTools: false};
  streams.set(sessionId, S);
  state.lastClarifyProbeAt = 0;
  updateRingState();
  loadGatewayCaps();                          // background; this turn uses whatever is known right now
  const reqBody = {input: text, client_turn_id: turnId};
  const caps = clientCapabilities();
  if(caps.length) reqBody.client_capabilities = caps;
  const watchdog = setInterval(()=>{
    const now = Date.now();
    if(foregroundStream() === S && now - S.lastFrameAt >= CLARIFY_STALE_MS && now - state.lastClarifyProbeAt >= CLARIFY_STALE_MS) probePendingClarify();
  }, 5000);
  S.bubble = addMsg("assistant", "");
  S.bubble.dataset.sid = sessionId;
  try{
    const r = await api(sessionUrl(sessionId, "/chat/stream"), {
      method: "POST",
      headers: {"Content-Type": "application/json", "Idempotency-Key": turnId, "X-Client-Turn-ID": turnId},
      body: JSON.stringify(reqBody),
      signal: S.abort.signal,
    });
    if(!r.ok){
      const errText = await r.text().catch(()=> "");
      throw new Error("HTTP " + r.status + (errText ? " " + errText : ""));
    }
    // Stream established: the draft is now the server's to keep.
    saveDraft(sessionId, "");
    saveDraft(null, "");
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      buf += dec.decode(value, {stream: true});
      let separator;
      while((separator = /\r?\n\r?\n/.exec(buf)) !== null){
        const frame = buf.slice(0, separator.index);
        buf = buf.slice(separator.index + separator[0].length);
        handleFrame(S, frame);
      }
    }
    if(buf.trim()) handleFrame(S, buf);
  }catch(e){
    // The stream failed before delivery: keep the text as a draft (with its turn id) and offer it again.
    saveDraft(sessionId, text, turnId);
    restoreToComposer(sessionId, text);
    addStreamNote(S, e && e.name === "AbortError" ? "[stopped]" : "[error] " + (e && e.message ? e.message : e));
  }finally{
    clearInterval(watchdog);
    S.running = false;
    closeBody(S);
    // An assistant bubble that ended up empty (no text, no tool, no card: e.g. the gateway took the text as a clarify
    // answer) is dropped, as is the user bubble of a turn the gateway refused to start.
    if(S.bubble.children.length <= 1) S.bubble.remove();
    if(S.intercepted) S.userBubble.remove();
    if(S.sid === state.activeId){
      // Finished in the session being viewed: keep what is on screen.
      streams.delete(sessionId);
      if($("thread").childElementCount) localThread.add(sessionId);
      updateRingState();
      await syncAfterTurn(sessionId);
      if(state.probeClarifyAfterTurn){
        state.probeClarifyAfterTurn = false;
        restoreToComposer(sessionId, text);   // the text was not sent: give it back
        probePendingClarify();
      }
    }else{
      // Finished while the user was elsewhere: its thread stays parked in S.holder until they return.
      setAttention(sessionId, S.holder.querySelector(".clarify-card.pending") ? "question" : "reply");
      loadSessions();
    }
  }
}

export async function send(){
  const ta = $("input");
  const text = ta.value.trim();
  if(!text) return;
  if(foregroundStream() && !state.activeClarifyId) return;
  if(state.activeClarifyId){
    const prevCid = state.activeClarifyId;
    const prevCard = findClarifyCard($("thread"), prevCid);
    if(prevCard && prevCard._batch && prevCard.classList.contains("pending")){
      // A batch is never answered by typed text (the gateway does not take it as an answer either): point at the card.
      showToast("Answer or cancel the questions first. Your message is kept.");
      const target = prevCard.querySelector(".clarify-qcard:not(.answered):not(.skipped)") || prevCard.querySelector(".clarify-qcard");
      if(target) target.focus();
      return;
    }
    // Typing in the composer while a single question is pending = skip it (the agent decides).
    state.activeClarifyId = null;
    await submitClarifyResponse(prevCid, "", prevCard);
    if(foregroundStream()){
      // The turn is still running server-side and its stream is still being read: do not abort it.
      // The typed text stays in the box; it can be sent once this turn finishes.
      showToast("Question skipped. Your message is kept; send it when the agent finishes.");
      return;
    }
  }
  if(!state.activeId) await newSession();
  if(!state.activeId) return;
  let turnId = loadDraftTurnId(state.activeId);
  if(!turnId){
    turnId = generateUUID();
    saveDraft(state.activeId, text, turnId);
  }
  ta.value = "";
  updateRingState();
  await streamTurn(text, state.activeId, {turnId});
}

// Aborting the fetch alone leaves the run going server-side: ask the server to stop it too (best effort).
function postRunStop(runId, keepalive){
  if(runId) api("/v1/runs/" + encodeURIComponent(runId) + "/stop", {method: "POST", keepalive: !!keepalive}).catch(()=>{});
}
export function stop(){
  const S = foregroundStream();
  if(!S) return;
  postRunStop(S.runId, false);
  S.abort.abort();
}
// Page is going away: end every live stream (including those of sessions the user is not viewing).
export function stopAll(){
  for(const S of streams.values()){
    if(!S.running) continue;
    postRunStop(S.runId, true);
    S.abort.abort();
  }
}

// Real wire format of /api/sessions/{id}/chat/stream (gateway/platforms/api_server.py, _handle_session_chat_stream):
//   assistant.delta   {message_id, delta}
//   tool.started | tool.completed | tool.failed   {message_id, tool_name, preview, args}   (no call id on this route)
//   tool.progress     {message_id, tool_name ("_thinking" for reasoning), delta}
//   assistant.commentary {message_id, text, already_streamed}
//   assistant.completed  {message_id, content, ...}     run.completed | run.failed | run.cancelled | error {message} | done
//   clarify / clarify.settled / clarify.intercept
// Every frame also carries session_id, run_id, seq, ts. The older field names (text, name, call_id, output) stay as
// fallbacks for gateways that emit them; uplink.native emits the same frames for turns through the Hermes CLI.
function frameText(obj, data){
  if(!obj) return data;
  const v = obj.delta != null ? obj.delta : obj.text;
  return v == null ? null : String(v);
}
function toolOutput(obj, keys){
  const key = keys.find(k=> obj && obj[k] != null);
  const out = key ? obj[key] : "";
  return typeof out === "string" ? out : JSON.stringify(out, null, 2);
}

function handleFrame(S, frame){
  if(frame.startsWith(":")) return;
  // When the user is looking at another session the frame is still applied, to this stream's own (detached) nodes:
  // nothing is dropped and nothing leaks into the visible thread.
  const fg = S.sid === state.activeId;
  const bubble = S.bubble;
  S.lastFrameAt = Date.now();
  let event = "message", data = "";
  for(const line of frame.split(/\r?\n/)){
    if(line.startsWith("event:")) event = line.slice(6).trim();
    else if(line.startsWith("data:")){
      let value = line.slice(5);
      if(value.startsWith(" ")) value = value.slice(1);
      data += (data ? "\n" : "") + value;
    }
  }
  const obj = parseJson(data);
  if(obj && typeof obj.run_id === "string" && obj.run_id) S.runId = obj.run_id;
  if(event === "assistant.delta"){
    appendStreamText(S, frameText(obj, data), fg);
  }else if(event === "assistant.commentary"){
    // Mid-turn commentary not already delivered as deltas.
    if(obj && typeof obj.text === "string" && obj.text.trim() && !obj.already_streamed) appendStreamText(S, obj.text + "\n\n", fg);
  }else if(event === "assistant.completed"){
    // Safety net: a turn whose text never arrived as deltas (e.g. a non-streaming provider) still shows its reply.
    if(obj && typeof obj.content === "string" && obj.content && !S.gotText) appendStreamText(S, obj.content, fg);
  }else if(event === "error"){
    addStreamNote(S, "[error] " + ((obj && obj.message) || data || "stream error"));
    // A stream that produced nothing before failing (e.g. a gateway refusal at admission) left no server-side copy of
    // the user's text, and the draft was cleared when the stream opened. Put it back: the draft reconciler drops it
    // automatically if the message was in fact committed.
    const utext = S.userBubble.dataset.text;
    if(!S.gotText && !S.gotTools && utext){
      saveDraft(S.sid, utext, "");
      restoreToComposer(S.sid, utext);
    }
  }else if(event === "tool.started"){
    S.gotTools = true;
    closeBody(S);
    const name = (obj && (obj.tool_name || obj.name)) || "tool";
    const input = (obj && (obj.args || obj.parameters || obj.arguments || obj.input)) || "";
    addToolCard(name, obj && (obj.tool_call_id || obj.call_id), "run", input, "", bubble);
  }else if(event === "tool.completed" || event === "tool.failed"){
    const failed = event === "tool.failed";
    const out = toolOutput(obj, failed ? ["preview", "error", "output"] : ["output", "preview", "result"]);
    updateToolCard(obj && (obj.tool_call_id || obj.call_id), failed ? "failed" : "done", out, bubble, obj && (obj.tool_name || obj.name));
  }else if(event === "clarify"){
    if(obj){
      renderClarifyCard(obj, bubble, {background: !fg, sid: S.sid});
      if(!fg){
        setAttention(S.sid, "question");
        showToast("A question is waiting in “" + sessionTitleOf(S.sid) + "”.");
      }
    }
  }else if(event === "clarify.settled"){
    // Answered (here, Telegram, desktop) or expired server-side: retire the card and stop its timer.
    const scid = obj && obj.clarify_id;
    if(scid){
      if(fg && state.activeClarifyId === scid) state.activeClarifyId = null;
      settleClarifyCard(scid, "", fg ? $("thread") : S.holder, "closed", {outcome: obj.outcome});
      if(!fg && attention.get(S.sid) === "question" && !S.holder.querySelector(".clarify-card.pending")){
        attention.set(S.sid, "reply");
        updateAttentionUi();
      }
    }
  }else if(event === "clarify.intercept"){
    // The gateway started no turn because a question is waiting: give the text back and show the card (recover it if missing).
    showToast((obj && obj.message) || "A question is waiting for your answer.");
    S.intercepted = true;
    state.probeClarifyAfterTurn = true;   // the turn ends right away: drop its bubbles and restore the card afterwards
  }else if(event === "message" && data && !obj){
    activeBody(S).textContent += data;   // a gateway that streams plain text without events
  }
}
