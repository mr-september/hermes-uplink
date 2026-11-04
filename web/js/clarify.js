import {api, failureMessage, postJson, sessionUrl} from "./api.js";
import {foregroundStream, state} from "./state.js";
import {maybeAutoscroll} from "./thread.js";
import {$, parseJson, showToast} from "./util.js";

// Clarify cards: the agent's questions, answered in the thread (single question, multi-select, or a batch whose
// answers are locked server-side as they are given). Protocol: docs/clarify-protocol.md.

// A live stream silent for this long may have lost its clarify frame: the watchdog asks the server instead.
export const CLARIFY_STALE_MS = 45000;

export function findClarifyCard(root, cid){
  return (root || document).querySelector(`.clarify-card[data-cid="${CSS.escape(String(cid))}"]`);
}

// Absolute deadline (ms epoch) from the server's created_at (epoch seconds) + timeout_seconds.
// No timeout from the server -> null (no countdown rather than a false "auto-resolves").
function clarifyDeadline(payload){
  const timeoutSec = Number(payload.timeout_seconds);
  if(!(timeoutSec > 0)) return null;
  const now = Date.now();
  let created = Number(payload.created_at);
  if(created > 0){
    if(created < 1e11) created *= 1000;            // seconds -> ms
    if(created > now) created = now;               // device clock behind the server: never show more than the full timeout
  } else {
    created = now;                                 // no created_at: count from render time
  }
  return created + timeoutSec * 1000;
}

function stripRecommended(text){
  if(typeof text !== "string") return text;
  return text.replace(/\s*\(Recommended\)\s*$/i, "").trim();
}

// opts.background: the card's session is not on screen, so it must not become the composer's pending clarify.
// opts.sid: the card's session (default: the one on screen).
export function renderClarifyCard(payload, bubble, opts = {}){
  const target = bubble || $("thread");
  const cid = payload.clarify_id;
  if(!opts.background) state.activeClarifyId = cid;

  const existing = findClarifyCard(target, cid);
  if(existing) return existing;

  const card = document.createElement("div");
  card.className = "clarify-card pending";
  card.dataset.cid = cid;
  card.dataset.sid = opts.sid || state.activeId || "";

  const isBatch = Array.isArray(payload.questions) && payload.questions.length > 0;
  const deadline = clarifyDeadline(payload);

  // Header: Question
  const hdr = document.createElement("div");
  hdr.className = "clarify-hdr";

  const qTitle = document.createElement("div");
  qTitle.className = "clarify-q";
  qTitle.textContent = isBatch ? `The agent has ${payload.questions.length} question${payload.questions.length === 1 ? "" : "s"} for you`
                               : (payload.question || "Clarifying Question");
  hdr.appendChild(qTitle);

  card.appendChild(hdr);

  // Live countdown, only when the server reported a timeout. A single-question card stays answerable until
  // the server's clarify.settled frame retires it; a batch turns into a read-only summary at zero.
  card._stopTimer = ()=>{};
  const meta = (isBatch || deadline !== null) ? mountClarifyMeta(card, deadline, isBatch ? ()=>expireClarifyBatch(card) : null) : null;

  if(isBatch) buildClarifyBatch(card, payload, meta);
  else buildClarifySingle(card, payload);

  target.appendChild(card);
  card.dataset.mounted = "1";
  if(card.isConnected) maybeAutoscroll();
  if(card._afterMount) card._afterMount();
  return card;
}

function isRecommended(text){ return /\(recommended\)\s*$/i.test(text); }

// Lettered single-choice button shared by single and batch cards.
function choiceButton(choiceText, idx){
  const bare = stripRecommended(choiceText);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "clarify-choice-btn";
  const kbd = document.createElement("span");
  kbd.className = "clarify-kbd";
  kbd.textContent = String.fromCharCode(65 + idx);
  const lbl = document.createElement("span");
  lbl.textContent = bare;
  btn.append(kbd, lbl);
  if(isRecommended(choiceText)){
    const rec = document.createElement("span");
    rec.className = "clarify-rec";
    rec.textContent = "(Recommended)";
    btn.appendChild(rec);
  }
  return {btn, bare};
}

function choiceCheckRow(choiceText){
  const row = document.createElement("label");
  row.className = "clarify-check-row";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  const lbl = document.createElement("span");
  lbl.textContent = choiceText;
  row.append(cb, lbl);
  return {row, cb, bare: stripRecommended(choiceText)};
}

function otherTextarea(placeholder, rows){
  const ta = document.createElement("textarea");
  ta.className = "clarify-other-input";
  ta.placeholder = placeholder;
  ta.rows = rows;
  return ta;
}

// Stored answers are strings; pretty-print JSON arrays ("a, b") and JSON objects, optionally {answers:{...}}.
function formatClarifyAnswer(value){
  let text = String(value);
  if(text.startsWith("[") || text.startsWith("{")){
    let parsed = parseJson(text);
    if(parsed && typeof parsed === "object" && parsed.answers && typeof parsed.answers === "object") parsed = parsed.answers;
    if(Array.isArray(parsed)) text = parsed.join(", ");
    else if(parsed && typeof parsed === "object") text = Object.entries(parsed).map(([k, v])=>`${k}: ${v}`).join("; ");
  }
  return text;
}

// Settled-card note for a clarify.settled outcome from the server.
function outcomeNote(outcome, batch){
  if(outcome === "submitted") return "Answered elsewhere";
  if(outcome === "timed_out") return batch ? "Timed out. The agent received the answers saved before then." : "Timed out (the agent was told it timed out)";
  if(outcome === "cancelled") return "Cancelled";
  return "Closed (answered elsewhere or expired)";
}

function buildClarifySingle(card, payload){
  const cid = card.dataset.cid;
  const isMulti = Boolean(payload.multi_select);
  const rawChoices = (payload.choices || []).map(String);
  const hasChoices = rawChoices.length > 0;
  const choices = document.createElement("div");
  choices.className = "clarify-choices";
  let selected = null;
  const multi = new Set();
  const other = otherTextarea(hasChoices ? "Other (type custom answer)..." : "Type your response here...", hasChoices ? 1 : 2);
  const clearSelection = ()=> choices.querySelectorAll(".clarify-choice-btn").forEach(x=>x.classList.remove("selected"));

  rawChoices.forEach((text, idx)=>{
    if(isMulti){
      const {row, cb, bare} = choiceCheckRow(text);
      cb.onchange = ()=>{ if(cb.checked) multi.add(bare); else multi.delete(bare); };
      choices.appendChild(row);
    } else {
      const {btn, bare} = choiceButton(text, idx);
      btn.onclick = ()=>{
        clearSelection();
        btn.classList.add("selected");
        selected = bare;
        other.value = "";
      };
      choices.appendChild(btn);
    }
  });
  if(hasChoices && !isMulti){
    other.onfocus = ()=>{ clearSelection(); selected = null; };
  }
  other.onkeydown = (e)=>{
    if(e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const ans = other.value.trim();
    if(ans){
      card._stopTimer();
      submitClarifyResponse(cid, ans, card);
    }
  };
  const otherWrap = document.createElement("div");
  otherWrap.className = "clarify-other-wrap";
  otherWrap.appendChild(other);
  choices.appendChild(otherWrap);

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "clarify-skip-btn";
  skipBtn.textContent = "Skip";
  skipBtn.onclick = ()=>{
    card._stopTimer();
    submitClarifyResponse(cid, "", card);
  };
  const subBtn = document.createElement("button");
  subBtn.type = "button";
  subBtn.className = "clarify-submit-btn";
  subBtn.textContent = "Submit";
  subBtn.onclick = ()=>{
    card._stopTimer();
    const typed = other.value.trim();
    let answer;
    if(isMulti){
      const list = Array.from(multi);
      if(typed) list.push(typed);
      answer = JSON.stringify(list);
    } else {
      answer = typed || selected || "";
    }
    submitClarifyResponse(cid, answer, card);
  };
  const actions = document.createElement("div");
  actions.className = "clarify-actions";
  actions.append(skipBtn, subBtn);
  card.append(choices, actions);
}

// A card is live while it is in the page or parked in a background stream's holder (see parkThread).
function cardAlive(card){ return !!card && (card.isConnected || !!card.closest("[data-parked]")); }
// The session a card belongs to (stamped at render time): a card answered or locked after the user switched
// sessions must still go to its own session.
function cardSid(card){ return (card && card.dataset && card.dataset.sid) || state.activeId; }
// Status line shared by single and batch cards: aria-live="polite", with the per-second countdown hidden from
// screen readers (aria-hidden) and announced only at 60/30/10 s and at expiry through a visually hidden twin.
function mountClarifyMeta(card, deadline, onExpire){
  const meta = document.createElement("div");
  meta.className = "clarify-meta";
  meta.setAttribute("aria-live", "polite");
  let timerInterval = null;
  card._stopTimer = ()=>{ if(timerInterval){ clearInterval(timerInterval); timerInterval = null; } };
  if(deadline !== null){
    const timerEl = document.createElement("div");
    timerEl.className = "clarify-timer";
    timerEl.setAttribute("aria-hidden", "true");
    const sr = document.createElement("span");
    sr.className = "sr-only";
    let lastMark = -1;
    const updateTimerText = ()=>{
      if(!cardAlive(card) && card.dataset.mounted){ card._stopTimer(); return; }
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const mark = remaining <= 0 ? 0 : remaining <= 10 ? 10 : remaining <= 30 ? 30 : remaining <= 60 ? 60 : -1;
      if(mark !== lastMark){
        lastMark = mark;
        if(mark === 0) sr.textContent = "This request has expired.";
        else if(mark > 0) sr.textContent = `About ${mark} seconds left to answer.`;
      }
      if(remaining <= 0){
        timerEl.textContent = onExpire ? "Time is up" : "Request expired (the agent was told it timed out)";
        card._stopTimer();
        if(onExpire) setTimeout(onExpire, 0);
      } else {
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        timerEl.textContent = `Expires in ${m}:${s < 10 ? '0' : ''}${s}`;
      }
    };
    updateTimerText();
    if(deadline > Date.now()) timerInterval = setInterval(updateTimerText, 1000);
    meta.append(timerEl, sr);
  }
  card.appendChild(meta);
  return meta;
}

/* ---- batch card: all questions stacked, any order, each locked server-side as it is answered ---- */
// payload.batch === true  -> POST /clarify/lock per question, final POST /clarify/respond {answers:{qid:string|null}}.
// questions without batch:true (older gateway) -> same UI, no locking, one respond {answer: JSON {answers}}.
function buildClarifyBatch(card, payload, meta){
  const cid = card.dataset.cid;
  const proto = payload.batch === true;
  const qs = payload.questions.map((q, i)=>({
    qid: String((q && q.qid != null) ? q.qid : "q" + i),
    question: String((q && q.question != null) ? q.question : ""),
    choices: (q && Array.isArray(q.choices)) ? q.choices.map(String) : [],
    multi: Boolean(q && q.multi_select),
  }));
  const confirmed = {};                       // qid -> answer string|null the server is known to hold
  const locked = (payload.locked && typeof payload.locked === "object") ? payload.locked : {};
  const S = {};                               // qid -> {single, multi:Set, text, skipped}
  const U = {};                               // qid -> DOM refs
  const L = {};                               // qid -> lock bookkeeping
  const uid = "cq" + Math.random().toString(36).slice(2, 8);
  let submitting = false, closed = false;

  const valueOf = (q)=>{
    const st = S[q.qid];
    if(st.skipped) return null;
    const text = st.text.trim();
    if(q.multi){
      const list = q.choices.map(stripRecommended).filter(c=>st.multi.has(c));
      if(text) list.push(text);
      return list.length ? JSON.stringify(list) : null;
    }
    return text || st.single || null;
  };
  const answersMap = ()=>{ const o = {}; qs.forEach(q=>{ o[q.qid] = valueOf(q); }); return o; };
  card._batch = {questions: qs, answers: answersMap, confirmed, proto, get submitting(){ return submitting; }};

  const list = document.createElement("div");
  list.className = "clarify-batch-list";
  const statusEl = document.createElement("span");
  statusEl.className = "clarify-status";
  meta.appendChild(statusEl);

  const submitBtn = document.createElement("button");
  const updateStatus = ()=>{
    let ans = 0, skp = 0, saving = false, bad = false;
    qs.forEach(q=>{
      const v = valueOf(q);
      if(S[q.qid].skipped) skp++; else if(v !== null) ans++;
      if(L[q.qid].timer || L[q.qid].inflight) saving = true;
      if(L[q.qid].err) bad = true;
    });
    let t = `${ans} of ${qs.length} answered` + (skp ? `, ${skp} skipped` : "");
    if(proto){ t += saving ? " · saving…" : bad ? " · not saved yet (sent on submit)" : (ans || skp) ? " · saved" : ""; }
    statusEl.textContent = t;
    submitBtn.disabled = submitting || (ans + skp === 0);
  };
  const setSaved = (q, kind)=>{
    const el = U[q.qid].saved;
    el.classList.toggle("err", kind === "err");
    el.textContent = kind === "saving" ? "Saving…" : kind === "saved" ? "Saved" : kind === "err" ? "Not saved yet (sent on submit)" : "";
  };

  // Lock bookkeeping: one request in flight per question; edits made meanwhile re-lock afterwards (last write wins).
  const sendLock = async (q)=>{
    const ls = L[q.qid];
    if(ls.timer){ clearTimeout(ls.timer); ls.timer = null; }
    if(!proto || closed || submitting) return;
    if(ls.inflight){ ls.dirty = true; return; }
    ls.inflight = true; ls.dirty = false;
    const val = valueOf(q);
    setSaved(q, "saving"); updateStatus();
    try{
      const res = await postJson(sessionUrl(cardSid(card), "/clarify/lock"), {clarify_id: cid, qid: q.qid, answer: val});
      if(res.status === 409){ closed = true; if(state.activeClarifyId === cid) state.activeClarifyId = null; settleClarifyCard(cid, "", card, "expired"); return; }
      if(!res.ok) throw new Error("Status " + res.status);
      const j = await res.json().catch(()=>null);
      if(j && j.locked && typeof j.locked === "object") Object.assign(confirmed, j.locked); else confirmed[q.qid] = val;   // server's view is authoritative
      ls.err = false;
      setSaved(q, ls.dirty ? "saving" : "saved");
    }catch(e){
      ls.err = true; setSaved(q, "err");       // non-fatal: the final submit carries every answer anyway
    }finally{
      ls.inflight = false;
      if(ls.dirty && !closed && !submitting) sendLock(q); else if(!closed) updateStatus();
    }
  };
  const scheduleLock = (q, delay)=>{
    if(!proto) return;
    const ls = L[q.qid];
    if(ls.timer) clearTimeout(ls.timer);
    setSaved(q, "saving");
    ls.timer = setTimeout(()=>sendLock(q), delay);
  };

  const repaint = (q)=>{
    const st = S[q.qid], ui = U[q.qid];
    ui.btns.forEach(b=>{ const on = !st.skipped && st.single === b.bare; b.el.classList.toggle("selected", on); b.el.setAttribute("aria-pressed", on ? "true" : "false"); });
    ui.checks.forEach(c=>{ c.el.checked = !st.skipped && st.multi.has(c.bare); });
    ui.skip.textContent = st.skipped ? "Undo skip" : "Skip";
    ui.skip.setAttribute("aria-pressed", st.skipped ? "true" : "false");
    ui.sec.classList.toggle("skipped", st.skipped);
    ui.sec.classList.toggle("answered", !st.skipped && valueOf(q) !== null);
    updateStatus();
  };

  qs.forEach((q, i)=>{
    S[q.qid] = {single: null, multi: new Set(), text: "", skipped: false};
    L[q.qid] = {timer: null, inflight: false, dirty: false, err: false};
    const st = S[q.qid];
    const ui = U[q.qid] = {btns: [], checks: []};

    // Pre-fill from what the server already holds (card recovered through /pending)
    if(Object.prototype.hasOwnProperty.call(locked, q.qid)){
      const lv = locked[q.qid];
      confirmed[q.qid] = lv == null ? null : String(lv);
      if(lv == null) st.skipped = true;
      else {
        const bares = q.choices.map(stripRecommended);
        if(q.multi){
          const p = parseJson(String(lv));
          const arr = Array.isArray(p) ? p.map(String) : null;
          const rest = [];
          (arr || [String(lv)]).forEach(v=>{ if(bares.includes(v)) st.multi.add(v); else rest.push(v); });
          st.text = rest.join(", ");
        } else if(bares.includes(String(lv))) st.single = String(lv);
        else st.text = String(lv);
      }
    }

    const sec = document.createElement("div");
    sec.className = "clarify-qcard";
    sec.dataset.qid = q.qid;
    sec.setAttribute("role", "group");
    sec.tabIndex = -1;
    const titleId = `${uid}-${i}`;
    sec.setAttribute("aria-labelledby", titleId);
    ui.sec = sec;

    const head = document.createElement("div");
    head.className = "clarify-qhead";
    const title = document.createElement("div");
    title.className = "clarify-qtitle";
    title.id = titleId;
    title.textContent = `${i + 1}. ${q.question}`;
    head.appendChild(title);
    sec.appendChild(head);

    const ch = document.createElement("div");
    ch.className = "clarify-choices";
    q.choices.forEach((choiceText, idx)=>{
      if(!q.multi){
        const {btn, bare} = choiceButton(choiceText, idx);
        btn.onclick = ()=>{
          st.skipped = false;
          if(st.single === bare){ st.single = null; }         // tap again to clear
          else { st.single = bare; st.text = ""; ui.other.value = ""; }
          repaint(q); scheduleLock(q, 0);
        };
        ui.btns.push({el: btn, bare});
        ch.appendChild(btn);
      } else {
        const {row, cb, bare} = choiceCheckRow(choiceText);
        cb.onchange = ()=>{
          st.skipped = false;
          if(cb.checked) st.multi.add(bare); else st.multi.delete(bare);
          repaint(q); scheduleLock(q, 0);
        };
        ui.checks.push({el: cb, bare});
        ch.appendChild(row);
      }
    });
    if(q.choices.length) sec.appendChild(ch);

    const other = otherTextarea(q.choices.length ? "Other (type your own answer)" : "Type your answer", 1);
    other.setAttribute("aria-label", q.choices.length ? `Other answer for question ${i + 1}` : `Answer for question ${i + 1}`);
    other.value = st.text;
    other.oninput = ()=>{
      st.text = other.value;
      if(st.text.trim()){ st.skipped = false; if(!q.multi) st.single = null; }
      repaint(q); scheduleLock(q, 700);
    };
    other.onblur = ()=>{ if(L[q.qid].timer) sendLock(q); };
    ui.other = other;
    sec.appendChild(other);

    const foot = document.createElement("div");
    foot.className = "clarify-qfoot";
    const saved = document.createElement("span");
    saved.className = "clarify-saved";
    ui.saved = saved;
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "clarify-skip-btn";
    skip.onclick = ()=>{
      st.skipped = !st.skipped;
      if(st.skipped){ st.single = null; st.multi.clear(); st.text = ""; other.value = ""; }
      repaint(q); scheduleLock(q, 0);
    };
    ui.skip = skip;
    foot.append(saved, skip);
    sec.appendChild(foot);
    list.appendChild(sec);
  });

  const bar = document.createElement("div");
  bar.className = "clarify-batch-bar";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "clarify-skip-btn clarify-cancel-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = ()=>submitClarifyBatch(card, "cancel");
  submitBtn.type = "button";
  submitBtn.className = "clarify-submit-btn";
  submitBtn.textContent = "Submit answers";
  submitBtn.onclick = ()=>submitClarifyBatch(card, "submit");
  bar.append(cancelBtn, submitBtn);
  card.append(list, bar);

  card._batch.setSubmitting = (v)=>{
    submitting = v;
    qs.forEach(q=>{ const ls = L[q.qid]; if(v && ls.timer){ clearTimeout(ls.timer); ls.timer = null; } });
    submitBtn.textContent = v ? "Submitting…" : "Submit answers";
    cancelBtn.disabled = v;
    updateStatus();
  };
  card._batch.close = ()=>{ closed = true; qs.forEach(q=>{ if(L[q.qid].timer) clearTimeout(L[q.qid].timer); }); };
  qs.forEach(repaint);
  // Focus the first unanswered question (a section, not an input, so no on-screen keyboard pops up) unless the
  // user is typing in the composer.
  card._afterMount = ()=>{
    const ae = document.activeElement;
    if(ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT") && ae.value) return;
    const first = qs.find(q=>valueOf(q) === null && !S[q.qid].skipped) || qs[0];
    U[first.qid].sec.focus();
  };
}

function expireClarifyBatch(card){
  if(!card || !cardAlive(card) || !card.classList.contains("pending")) return;
  if(card._batch && card._batch.submitting) return;
  if(state.activeClarifyId === card.dataset.cid) state.activeClarifyId = null;
  settleClarifyCard(card.dataset.cid, "", card, "timeout");
}

async function submitClarifyBatch(card, mode){
  const B = card._batch, cid = card.dataset.cid;
  if(!B || B.submitting) return;
  B.setSubmitting(true);
  card.classList.add("submitting");
  let body;
  if(B.proto) body = mode === "cancel" ? {clarify_id: cid, outcome: "cancelled"} : {clarify_id: cid, answers: B.answers()};
  else body = {clarify_id: cid, answer: mode === "cancel" ? "" : JSON.stringify({answers: B.answers()})};
  try{
    card._stopTimer();
    const res = await postJson(sessionUrl(cardSid(card), "/clarify/respond"), body);
    if(res.status === 409 || res.status === 404){ settleClarifyCard(cid, "", card, "expired"); return; }
    if(!res.ok) throw new Error(await failureMessage(res));
    settleClarifyCard(cid, "", card, mode === "cancel" ? "cancelled" : "submitted");
  }catch(e){
    B.setSubmitting(false);
    card.classList.remove("submitting");
    showToast("Could not submit answers: " + e.message, "error");
  }finally{
    if(state.activeClarifyId === cid && !card.classList.contains("submitting")) state.activeClarifyId = null;
  }
}

// Empty a card and give it the settled frame and its question title.
function startSettledCard(card, className, fallbackTitle){
  const title = card.querySelector(".clarify-q")?.textContent || fallbackTitle;
  card.className = className;
  card.replaceChildren();
  const hdr = document.createElement("div");
  hdr.className = "clarify-hdr";
  const qEl = document.createElement("div");
  qEl.className = "clarify-q";
  qEl.textContent = title;
  hdr.appendChild(qEl);
  card.appendChild(hdr);
}

// Read-only summary of a batch: the final answers after submit, otherwise what the server holds (locked).
function settleClarifyBatch(card, how, info){
  const B = card._batch;
  if(B.close) B.close();
  startSettledCard(card, "clarify-card clarify-batch settled", "Questions");

  const live = document.createElement("div");
  live.className = "clarify-answer";
  live.setAttribute("aria-live", "polite");
  const note = document.createElement("span");
  note.className = "clarify-ans-skipped";
  let rows = B.confirmed, showRows = true;
  if(how === "submitted"){ note.textContent = "Answers sent"; rows = B.answers(); }
  else if(how === "cancelled"){ note.textContent = "Cancelled (no answers sent)"; showRows = false; }
  else if(how === "timeout") note.textContent = B.proto ? "Time ran out. The agent received the answers saved before then." : "Time ran out (the agent was told it timed out)";
  else if(how === "expired") note.textContent = "Already answered or expired" + (B.proto ? ". Showing the answers that were saved." : "");
  else note.textContent = outcomeNote(info && info.outcome, true);
  live.appendChild(note);
  card.appendChild(live);
  if(showRows){
    B.questions.forEach((q, i)=>{
      const row = document.createElement("div");
      row.className = "clarify-sum-row";
      const qe = document.createElement("div");
      qe.className = "clarify-sum-q";
      qe.textContent = `${i + 1}. ${q.question}`;
      const ae = document.createElement("div");
      const v = rows[q.qid];
      if(v == null || !String(v).trim()){
        ae.className = "clarify-sum-a clarify-ans-skipped";
        ae.textContent = (how === "submitted" || Object.prototype.hasOwnProperty.call(rows, q.qid)) ? "Skipped" : "No answer";
      } else {
        ae.className = "clarify-sum-a";
        ae.textContent = formatClarifyAnswer(v);
      }
      row.append(qe, ae);
      card.appendChild(row);
    });
  }
}

export async function submitClarifyResponse(clarifyId, answer, cardEl){
  if(cardEl) cardEl.classList.add("submitting");
  try{
    const res = await postJson(sessionUrl(cardSid(cardEl), "/clarify/respond"), {clarify_id: clarifyId, answer});
    if(res.status === 409 || res.status === 404){
      // Already answered elsewhere, or the request expired (the model got "timed_out"): do NOT
      // present the user's answer as accepted.
      settleClarifyCard(clarifyId, "", cardEl, "expired");
      return;
    }
    if(!res.ok) throw new Error(await failureMessage(res));
    settleClarifyCard(clarifyId, answer, cardEl);
  }catch(e){
    if(cardEl) cardEl.classList.remove("submitting");
    showToast("Could not submit clarify response: " + e.message, "error");
  }finally{
    if(state.activeClarifyId === clarifyId) state.activeClarifyId = null;
  }
}

// how: "answered" (default) | "expired" (409 / timed out) | "closed" (clarify.settled from the server).
export function settleClarifyCard(clarifyId, answerText, targetOrBubble, how, info){
  const cid = clarifyId || "";
  const root = targetOrBubble || $("thread");
  let card = null;
  if(root.matches && root.matches(".clarify-card")) card = root;
  else if(how === "closed") card = findClarifyCard(root, cid);   // never settle an unrelated card
  else card = findClarifyCard(root, cid) || root.querySelector(".clarify-card.pending");
  if(!card) return;
  // A server-side settle must not overwrite a card the user already answered.
  if(how === "closed" && !card.classList.contains("pending") && !card.classList.contains("submitting")) return;
  // Our own submit is in flight: its response settles the card, not the server's echo of it.
  if(how === "closed" && card._batch && card._batch.submitting) return;
  if(card._stopTimer) card._stopTimer();
  if(card._batch){ settleClarifyBatch(card, how || "answered", info); return; }

  startSettledCard(card, "clarify-card settled", "Clarifying Question");

  const ansRow = document.createElement("div");
  ansRow.className = "clarify-answer";

  if(how === "expired" || how === "closed"){
    const note = document.createElement("span");
    note.className = "clarify-ans-skipped";
    note.textContent = how === "expired" ? "Already answered or expired" : outcomeNote(info && info.outcome, false);
    ansRow.appendChild(note);
    card.appendChild(ansRow);
    return;
  }

  const text = answerText ? stripRecommended(formatClarifyAnswer(answerText).trim()) : "";

  if(text){
    const badge = document.createElement("span");
    badge.className = "clarify-ans-badge";
    badge.textContent = "Answer";
    const val = document.createElement("span");
    val.textContent = text;
    ansRow.append(badge, " ", val);
  } else {
    const skipped = document.createElement("span");
    skipped.className = "clarify-ans-skipped";
    skipped.textContent = "Skipped (agent decided)";
    ansRow.appendChild(skipped);
  }
  card.appendChild(ansRow);
}

// Recovery after a reconnect, refocus or silent stream: while a stream is live and delivering frames the card
// arrives on it; once it has been silent for CLARIFY_STALE_MS (lost frame, dropped connection, mobile suspend)
// ask the server instead.
export async function probePendingClarify(){
  if(!state.activeId) return;
  const S = foregroundStream();
  if(S && Date.now() - S.lastFrameAt < CLARIFY_STALE_MS) return;
  state.lastClarifyProbeAt = Date.now();
  try{
    const r = await api(sessionUrl(state.activeId, "/clarify/pending"));
    if(r.ok){
      const data = await r.json();
      if(data.pending && data.clarify){
        const existing = findClarifyCard(document, data.clarify.clarify_id);
        if(!existing){
          const bubbles = $("thread").querySelectorAll(".msg.assistant");
          const bubble = bubbles[bubbles.length - 1] || $("thread");
          renderClarifyCard(data.clarify, bubble);
        }
      }
    }
  }catch{ /* background probe: the next focus or watchdog tick retries */ }
}

// The composer's pending clarify is whichever card in the visible thread still waits for an answer.
export function syncActiveClarify(){
  const c = $("thread").querySelector(".clarify-card.pending, .clarify-card.submitting");
  state.activeClarifyId = c ? (c.dataset.cid || null) : null;
}

// Keyboard answers for a pending single-question card: 1-9 or a-z pick a choice, Enter submits. Batch cards are
// tap/click only, and nothing fires while the user is typing.
export function initClarifyHotkeys(){
  window.addEventListener("keydown", (e)=>{
    if(e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const focused = document.activeElement;
    if(focused && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.isContentEditable)) return;
    const card = document.querySelector(".clarify-card.pending");
    if(!card || card._batch) return;
    const choices = card.querySelectorAll(".clarify-choice-btn");
    if(!choices.length) return;
    const k = e.key.toLowerCase();
    const idx = /^[1-9]$/.test(k) ? Number(k) - 1 : /^[a-z]$/.test(k) ? k.charCodeAt(0) - 97 : -1;
    if(idx >= 0){
      if(idx < choices.length){ e.preventDefault(); choices[idx].click(); }
      return;
    }
    const submit = card.querySelector(".clarify-submit-btn");
    if(e.key === "Enter" && submit && !submit.disabled){ e.preventDefault(); submit.click(); }
  });
}
