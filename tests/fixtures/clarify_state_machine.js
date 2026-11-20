// Assertions for the browser's clarify state machine, run by tests/test_client_clarify.py inside a real
// Chromium over the real web/js modules. The page's fetch is replaced by a recording stub before any module
// loads (window.__calls / window.__scripted are set by the fixture HTML). The result is written to
// <pre id="test-result"> for the driver to parse from the dumped DOM.
// main.js is imported first, exactly as boot.js does in production: the module graph is cyclic, and main's
// top-level initComposer() only runs cleanly when evaluation starts here (entering via clarify.js instead
// leaves composer.js suspended mid-import, before its const FINE_POINTER — a TDZ error).
import "/js/main.js";
import {findClarifyCard, renderClarifyCard, settleClarifyCard} from "/js/clarify.js";
import {state} from "/js/state.js";

const results = [];
const check = (name, cond) => { results.push([name, Boolean(cond)]); };
const tick = () => new Promise((resolve)=> setTimeout(resolve, 0));
async function flush(rounds = 12){ for(let i = 0; i < rounds; i++) await tick(); }
function lastBody(suffix, cid){
  const matches = window.__calls.filter((c)=>{
    if(!c.path.endsWith(suffix)) return false;
    try { return JSON.parse(c.body || "{}").clarify_id === cid; } catch { return false; }
  });
  const last = matches[matches.length - 1];
  return last ? JSON.parse(last.body) : null;
}

async function main(){
  state.activeId = "test";   // cards take their session from the session on screen

  // Single question: pick a choice and submit; the answer is the choice with "(Recommended)" stripped.
  renderClarifyCard({clarify_id: "t1", question: "Which bucket?", choices: ["Alpha (Recommended)", "Beta"]});
  const c1 = findClarifyCard(document, "t1");
  check("single renders pending", c1 && c1.classList.contains("pending"));
  c1.querySelector(".clarify-choices .clarify-choice-btn").click();
  check("choice marks selected", Boolean(c1.querySelector(".clarify-choice-btn.selected")));
  c1.querySelector(".clarify-submit-btn").click();
  await flush();
  check("submit posts the bare answer", (lastBody("/clarify/respond", "t1") || {}).answer === "Alpha");
  check("submit settles the card", c1.classList.contains("settled") && !c1.classList.contains("pending"));
  check("settled shows the answer without the suffix",
        c1.textContent.includes("Alpha") && !c1.textContent.includes("Recommended"));

  // Single question: free text submitted with Enter.
  renderClarifyCard({clarify_id: "t2", question: "Custom?", choices: ["A"]});
  const c2 = findClarifyCard(document, "t2");
  const other2 = c2.querySelector(".clarify-other-input");
  other2.value = "free-form answer";
  other2.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
  await flush();
  check("Enter posts the typed answer", (lastBody("/clarify/respond", "t2") || {}).answer === "free-form answer");
  check("Enter settles the card", c2.classList.contains("settled"));

  // Skip: empty answer, "Skipped (agent decided)" summary.
  renderClarifyCard({clarify_id: "t3", question: "Skip?", choices: []});
  const c3 = findClarifyCard(document, "t3");
  c3.querySelector(".clarify-skip-btn").click();
  await flush();
  check("skip posts an empty answer", (lastBody("/clarify/respond", "t3") || {}).answer === "");
  check("skip settles as skipped", c3.textContent.includes("Skipped (agent decided)"));

  // Server says the question is already gone (409): the card must not present the answer as accepted.
  window.__scripted.t4 = 409;
  renderClarifyCard({clarify_id: "t4", question: "Stale?", choices: []});
  const c4 = findClarifyCard(document, "t4");
  c4.querySelector(".clarify-skip-btn").click();
  await flush();
  check("409 shows expiry instead of acceptance",
        c4.textContent.includes("Already answered or expired") && !c4.classList.contains("submitting"));

  // Server-side settle (clarify.settled) on an untouched card, and once only.
  renderClarifyCard({clarify_id: "t5", question: "Server?", choices: ["A"]});
  const c5 = findClarifyCard(document, "t5");
  settleClarifyCard("t5", "", null, "closed", {outcome: "submitted"});
  check("server settle notes answering elsewhere",
        c5.classList.contains("settled") && c5.textContent.includes("Answered elsewhere"));
  settleClarifyCard("t5", "", null, "closed", {outcome: "timed_out"});
  check("a second server settle does not overwrite the first", c5.textContent.includes("Answered elsewhere"));

  // Batch (proto): per-question lock as it is answered, final answers map, summary on settle.
  renderClarifyCard({clarify_id: "b6", batch: true, questions: [
    {qid: "q1", question: "First?", choices: ["X", "Y"]},
    {qid: "q2", question: "Second?"},
  ]});
  const c6 = findClarifyCard(document, "b6");
  check("batch renders one section per question", c6.querySelectorAll(".clarify-qtitle").length === 2);
  c6.querySelector(".clarify-choices .clarify-choice-btn").click();
  await flush(20);
  const lock6 = lastBody("/clarify/lock", "b6");
  check("batch locks the answered question", Boolean(lock6) && lock6.qid === "q1" && lock6.answer === "X");
  const other6 = c6.querySelectorAll(".clarify-other-input")[1];
  other6.value = "typed second";
  other6.dispatchEvent(new Event("input", {bubbles: true}));
  await flush(20);
  c6.querySelector(".clarify-submit-btn").click();
  await flush(30);
  const resp6 = lastBody("/clarify/respond", "b6");
  check("batch submit posts the answers map",
        Boolean(resp6 && resp6.answers) && resp6.answers.q1 === "X" && resp6.answers.q2 === "typed second");
  check("batch settles with the answers summary",
        c6.textContent.includes("Answers sent") && c6.textContent.includes("typed second"));

  // Batch re-rendered with a server-held answer (card recovered via /pending): the question shows as
  // answered without user action, and the held answer flows into the final submit.
  renderClarifyCard({clarify_id: "b7", batch: true,
                     questions: [{qid: "q1", question: "Locked?", choices: ["X"]}], locked: {q1: "X"}});
  const c7 = findClarifyCard(document, "b7");
  await flush();
  check("locked prefill renders as answered", c7.querySelector(".answered"));
  c7.querySelector(".clarify-submit-btn").click();
  await flush(30);
  const resp7 = lastBody("/clarify/respond", "b7");
  check("locked prefill is carried into the answers map",
        Boolean(resp7 && resp7.answers) && resp7.answers.q1 === "X");
}

function report(extra){
  const pre = document.createElement("pre");
  pre.id = "test-result";
  const failed = results.filter(([, ok])=> !ok).map(([name])=> name);
  pre.textContent = "TESTRESULT " + JSON.stringify(
    Object.assign({total: results.length, failed}, extra || {}));
  document.body.appendChild(pre);
}

let done = false;
setTimeout(()=>{ if(!done) report({error: "timeout"}); }, 5000);
main().then(()=>{ done = true; report(); })
        .catch((e)=>{ done = true; report({error: String(e && e.stack || e)}); });
