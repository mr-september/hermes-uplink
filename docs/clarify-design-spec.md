# Hermes Uplink — Clarify (Interactive Multiple-Choice) Support: Technical Specification

**Status:** APPROVED DESIGN SPECIFICATION (Build deferred per 2026-08-28 scoping; Direction 1 Dynamic TTL completed, Direction 2 Clarify Transport fully specified).  
**Authors/Reviewers:** Larry & Principal Investigator (Amended & Hardened: 2026-08-29).  
**Target Components:** `gateway/platforms/api_server.py`, `tools/clarify_gateway.py`, `E:/hermes-uplink/index.html`, `E:/hermes-uplink/proxy.py`.

---

## 1. Problem Statement & Operational Context

When the Hermes LLM agent invokes the `clarify` tool during a conversation hosted on the REST/SSE gateway (`gateway/platforms/api_server.py`), remote web and mobile clients connected via **Hermes Uplink** cannot view or respond to the clarifying question.

### Specific Failure Modes:
1. **Tool Execution Failure:** The REST API server does not instantiate an `AIAgent.clarify_callback`. When the agent decides to ask a clarifying question, `tools/clarify_tool.py` fails immediately with `"Clarify tool is not available in this execution context"`.
2. **Missing SSE Wire Protocol:** Even if registered, `api_server.py` does not emit structured `clarify` SSE frames on `/api/sessions/{id}/chat/stream`.
3. **Client Deadlock:** In Uplink (`index.html`), active streaming sets `streaming = true`, which locks out the composer input (`if (streaming) return;`). The user is presented with no interactive buttons or input card, and cannot resolve the waiting agent.
4. **Thread Starvation:** On messaging platforms with button support, the agent thread blocks synchronously inside `tools.clarify_gateway.wait_for_response`. Over REST, an unhandled clarify blocks the worker thread until the global timeout (default 3600s) expires.

---

## 2. Root Cause Analysis (Verified Against Codebase)

1. **Missing Adapter Plumbing in `gateway/platforms/api_server.py`:**
   - In `api_server.py::_create_agent()` (L2814–3158), `AIAgent` is instantiated without a `clarify_callback`.
   - In `api_server.py::_handle_session_chat_stream()` (L4725–4960), the SSE event loop dispatches `assistant.delta`, `tool.started`, `tool.completed`, `tool.failed`, and `run.completed`, but has no hook or queue integration for `clarify` requests.
2. **Missing Dedicated Resolution Endpoint in `api_server.py`:**
   - Unlike approvals (`POST /v1/runs/{run_id}/approval`), `api_server.py` exposes no HTTP endpoint to resolve a pending `_ClarifyEntry` registered in `tools.clarify_gateway`.
3. **Missing Card Renderer & Dispatcher in `E:/hermes-uplink/index.html`:**
   - `handleFrame()` (L692) only recognizes `assistant.delta`, `tool.*`, and `run.completed`.
   - `index.html` lacks UI components for single-choice buttons, multi-select checkboxes, free-text ("Other") inputs, composite batch questionnaires, and settled history representation.

---

## 3. Architectural Design & Systems Topology

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       CLARIFY RUNTIME SEQUENCE                                         │
│                                                                                                        │
│  Uplink Web Client                     Uplink Proxy               API Server              Agent Worker │
│     (index.html)                        (proxy.py)              (api_server.py)             (Thread)   │
│          │                                   │                         │                        │      │
│          │─── POST /chat/stream ────────────►│─── POST /chat/stream ──►│─── agent.run() ───────►│      │
│          │    (SSE stream opened)            │                         │                        │      │
│          │                                   │                         │    Calls clarify()     │      │
│          │                                   │                         │◄── clarify_callback ───┤      │
│          │                                   │                         │                        │      │
│          │                                   │                         ├── clarify_gateway.     │      │
│          │                                   │                         │   register(cid, ...)   │      │
│          │                                   │                         │                        │      │
│          │                                   │                         │    wait_for_response() │      │
│          │                                   │                         │◄── (Blocks Worker) ────┤      │
│          │◄── event: clarify ────────────────│◄── event: clarify ──────┤                        │      │
│          │    {clarify_id, choices, ...}     │                         │                        │      │
│          │                                   │                         │                        │      │
│     [Render Card]                            │                         │   (Keepalive :ping)    │      │
│    (User selects "B")                        │                         │                        │      │
│          │                                   │                         │                        │      │
│          │─── POST /clarify/respond ────────►│─── POST /clarify/resp ─►│                        │      │
│          │    {"clarify_id": "...", ...}     │                         ├── resolve_gateway_     │      │
│          │◄── 200 OK {"ok": true} ───────────│◄── 200 OK ──────────────┤   clarify(cid, ans)    │      │
│          │                                   │                         │                        │      │
│          │                                   │                         │── Unblocks Worker ────►│      │
│          │                                   │                         │                        │      │
│          │◄── event: tool.completed ─────────│◄── event: tool.complete ┤◄── tool result ────────┤      │
│          │◄── event: assistant.delta ────────│◄── event: delta ────────┤◄── response text ──────┤      │
│          │◄── event: run.completed ──────────│◄── event: completed ────┤◄── turn complete ──────┤      │
│          │                                   │                         │                        │      │
│     [Settle Card]                            │                         │                        │      │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Invariants:
1. **Clean Protocol Separation:** Clarify *notification* travels downstream over the existing open SSE connection (`/chat/stream`). Clarify *resolution* travels upstream via a dedicated, lightweight RPC endpoint (`POST /api/sessions/{id}/clarify/respond`).
2. **No Stream Multiplexing / Concurrency Collisions:** Answering a clarify never opens a second `/chat/stream` request, preventing 409/429 turn-lease conflicts and avoiding client-side `streaming=true` lockouts.
3. **Thread Safety & Inactivity Heartbeats:** Agent thread blocks on `tools.clarify_gateway.wait_for_response()`, which polls in 1-second slices, pulsing `touch_activity_if_due` to ensure server-side inactivity watchdogs do not terminate the session while the user is reading or typing.
4. **Idempotent Resolution:** `resolve_gateway_clarify` is first-writer-wins and thread-safe under `_lock`. Late submissions after timeout or external resolution return a clean `409 Conflict` / `410 Gone` without corrupting state.

---

## 4. Detailed Technical Specification

### 4.1 Gateway REST Server (`gateway/platforms/api_server.py`)

#### 4.1.1 Agent Callback Injection
In `_create_agent()`, instantiate and wire `agent.clarify_callback`:

```python
def _make_clarify_callback(session_id: str, session_key: str, event_queue: asyncio.Queue, loop: asyncio.AbstractEventLoop):
    def _clarify_callback_sync(question: str, choices: Optional[List[str]], multi_select: bool = False, questions: Optional[List[dict]] = None, urgency: Optional[str] = None) -> str:
        from tools import clarify_gateway as _clarify_mod
        from tools.clarify_tool import mark_recommended, resolve_clarify_timeout
        import uuid, time

        clarify_id = uuid.uuid4().hex[:10]
        decorated_choices = mark_recommended(choices) if choices else None
        
        entry = _clarify_mod.register(
            clarify_id=clarify_id,
            session_key=session_key or session_id,
            question=question,
            choices=decorated_choices,
            multi_select=bool(multi_select),
        )

        user_config = _load_gateway_config()
        timeout_seconds = resolve_clarify_timeout(user_config, urgency=urgency)

        payload = {
            "clarify_id": clarify_id,
            "session_id": session_id,
            "question": question,
            "choices": decorated_choices,
            "multi_select": bool(multi_select),
            "urgency": (urgency or "medium").lower(),
            "timeout_seconds": timeout_seconds,
            "created_at": time.time(),
            "questions": questions,
        }

        # Schedule SSE frame delivery on the aiohttp event loop
        loop.call_soon_threadsafe(
            event_queue.put_nowait,
            ("clarify", payload)
        )

        # Block the agent thread until answered or timed out
        response = _clarify_mod.wait_for_response(clarify_id, timeout=timeout_seconds)
        return response if response is not None else ""

    return _clarify_callback_sync
```

#### 4.1.2 Dedicated Clarify Response Endpoint
Add route to `api_server.py`:
- **Method & Route:** `POST /api/sessions/{session_id}/clarify/respond`
- **Authentication:** `_check_auth(request)` (Bearer token)
- **Request Body Schema:**
  ```json
  {
    "clarify_id": "c1a2b3c4d5",
    "answer": "PostgreSQL"
  }
  ```
  *(For multi-select or batch, `answer` is a JSON array string `["PostgreSQL", "SQLite"]`, a JSON object string of batch answers `{"q0": "A", "q1": "B"}`, or bare text for "Other")*

- **Handler Logic:**
  ```python
  async def _handle_session_clarify_respond(self, request: "web.Request") -> "web.Response":
      auth_err = self._check_auth(request)
      if auth_err:
          return auth_err
      session_id = request.match_info["session_id"]
      body, err = await self._read_json_body(request)
      if err:
          return err

      clarify_id = body.get("clarify_id")
      answer = body.get("answer")
      if not clarify_id:
          return web.json_response(_openai_error("Missing 'clarify_id'"), status=400)
      if answer is None:
          return web.json_response(_openai_error("Missing 'answer'"), status=400)

      from tools import clarify_gateway as _clarify_mod
      resolved = _clarify_mod.resolve_gateway_clarify(clarify_id, str(answer))
      if not resolved:
          return web.json_response(
              _openai_error("Clarify request has expired or was already resolved", code="clarify_expired"),
              status=409
          )
      return web.json_response({"ok": True, "clarify_id": clarify_id, "status": "resolved"})
  ```

#### 4.1.3 Pending Clarify Probe Endpoint (Mobile Reconnection Recovery)
To support seamless recovery when mobile connections drop mid-stream:
- **Method & Route:** `GET /api/sessions/{session_id}/clarify/pending`
- **Authentication:** `_check_auth(request)` (Bearer token)
- **Handler Logic:**
  ```python
  async def _handle_session_clarify_pending(self, request: "web.Request") -> "web.Response":
      auth_err = self._check_auth(request)
      if auth_err:
          return auth_err
      session_id = request.match_info["session_id"]
      gateway_session_key, _ = self._parse_session_key_header(request)
      session_key = gateway_session_key or session_id

      from tools import clarify_gateway as _clarify_mod
      entry = _clarify_mod.get_pending_for_session(session_key, include_choice_prompts=True)
      if entry is None or entry.event.is_set():
          return web.json_response({"pending": False})

      return web.json_response({
          "pending": True,
          "clarify": {
              "clarify_id": entry.clarify_id,
              "session_id": session_id,
              "question": entry.question,
              "choices": entry.choices,
              "multi_select": entry.multi_select,
          }
      })
  ```

#### 4.1.4 Inbound Message Text-Intercept (Reconnect / Deadlock Breaker)
In `_handle_session_chat_stream` and `_handle_session_chat`, before initializing a fresh agent turn, check if the session has an unblocked pending clarify:
```python
from tools import clarify_gateway as _clarify_mod
intercept_status = _clarify_mod.attempt_text_response_for_session(gateway_session_key or session_id, user_message)

if intercept_status == _clarify_mod.TEXT_RESOLVED:
    # Text resolved a pending blocked turn; do not start a second agent turn.
    return web.json_response({"ok": True, "status": "resolved_pending_clarify"})
elif intercept_status == _clarify_mod.TEXT_REJECTED_PROSE:
    # User sent unrelated prose while a choice prompt was waiting.
    # Cancel the pending clarify to prevent deadlock and allow the new message to run.
    _clarify_mod.clear_session(gateway_session_key or session_id)
```

---

### 4.2 Uplink Client (`E:/hermes-uplink/index.html`)

#### 4.2.1 Event Handling in `handleFrame`
Expand `handleFrame(frame, bubble)`:
```javascript
if (event === "clarify") {
  renderClarifyCard(obj, bubble);
} else if (event === "tool.completed" && obj && obj.tool_name === "clarify") {
  settleClarifyCard(obj, bubble);
}
```

#### 4.2.2 Clarify Card Component Lifecycle & DOM Structure
The UI must support two visual and functional states:

1. **Pending State (`.clarify-card.pending`):**
   - Displays the question text with a question icon.
   - **Urgency/TTL Badge:** If `timeout_seconds > 0` and `urgency !== 'blocking'`, show a live countdown timer (`Expires in 4m 30s`). If `blocking`, show `Requires input`.
   - **Options List (Single Question):**
     - **Single-select:** Choice buttons labeled `A`, `B`, `C`, `D` with `(Recommended)` highlighted in subtle accent color.
     - **Multi-select:** Checkboxes with a "Confirm Selection" button.
     - **"Other" Row:** Option button or toggle that reveals an inline auto-focused text area.
     - **Skip Button:** Sends empty answer `""`, allowing the agent to proceed on its own judgement.
   - **Composite Batch Form (`questions: [...]`):**
     - When `questions` array is present, render a composite multi-question card containing separate option groups (`q0`, `q1`, ...).
     - Provide a progress counter (`2 of 3 answered`) and a single "Submit All Answers" button that serializes the responses object.
   - **Keyboard Navigation:**
     - Digits `1..N` and letters `A..D` select choices immediately.
     - Arrow keys move visual selection focus.
     - `Enter` submits the active selection or typed text.
     - Keys are strictly scoped so typing into the "Other" field is not intercepted.

2. **Settled State (`.clarify-card.settled`):**
   - Replaces interactive buttons with a clean summary:
     - Question in bold.
     - Answer labeled with an answer badge (or *(Skipped)* in italics).
   - If historical transcript is loaded via `openSession()` (`GET /api/sessions/{id}/messages`), reconstruct the settled card from `tool_calls` where `name === 'clarify'`.

#### 4.2.3 Main Composer Integration (Implicit Skip on Send)
To match desktop behavior (`skipClarifyRequest`), the main bottom composer remains enabled while a clarify card is active. If the user chooses to type a fresh message in the main composer and hits Send/Enter:
```javascript
async function send() {
  if (streaming && !activeClarifyId) return;
  const ta = document.getElementById("input");
  const text = ta.value.trim();
  if (!text) return;

  // If a clarify is currently blocking, auto-skip it first so the agent unblocks
  if (activeClarifyId) {
    try {
      await api("/api/sessions/" + encodeURIComponent(activeId) + "/clarify/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clarify_id: activeClarifyId, answer: "" })
      });
    } catch (e) {
      // Best-effort skip; proceed with message dispatch
    }
    activeClarifyId = null;
  }

  ta.value = "";
  updateRingState();
  await streamTurn(text, activeId, { addUser: true });
}
```

#### 4.2.4 Reconnection Recovery Listener
On mobile browser focus / network reconnect:
```javascript
window.addEventListener("focus", async () => {
  if (!activeId || streaming) return;
  try {
    const r = await api("/api/sessions/" + encodeURIComponent(activeId) + "/clarify/pending");
    if (r.ok) {
      const data = await r.json();
      if (data.pending && data.clarify) {
        ensureClarifyCardMounted(data.clarify);
      }
    }
  } catch (e) {
    // Silent ignore on background probe failure
  }
});
```

#### 4.2.5 RPC Submission Function
```javascript
async function submitClarifyResponse(clarifyId, answer, cardElement) {
  cardElement.classList.add("submitting");
  try {
    const res = await api("/api/sessions/" + encodeURIComponent(activeId) + "/clarify/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clarify_id: clarifyId, answer: answer })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || "Clarify submission failed (status " + res.status + ")");
    }
    activeClarifyId = null;
  } catch (err) {
    cardElement.classList.remove("submitting");
    showNotification("Error: " + err.message, "error");
  }
}
```

---

### 4.3 Uplink Proxy (`E:/hermes-uplink/proxy.py`) & Security Integrity

1. **Route Whitelisting:**
   - Verify `proxy.py` passes `POST /api/sessions/{session_id}/clarify/respond` and `GET /api/sessions/{session_id}/clarify/pending` to upstream without modification (covered by generic `/api/sessions/*` prefix handling).
2. **CSP & Asset Hash Re-Pinning Guard:**
   - `proxy.py` enforces strict Content Security Policy and startup SHA-256 validation (`_validate_pinned_assets()`).
   - When `index.html` is edited, calculate new hashes and update `proxy.py`:
     ```python
     PINNED_ASSET_HASHES["index.html"] = "<new-sha256-base64>"
     INLINE_SCRIPT_HASH = "<new-inline-script-sha256-base64>"
     INLINE_STYLE_HASH = "<new-inline-style-sha256-base64>"
     ```

---

## 5. Failure Modes & Edge Case Matrix

| Edge Case | Root Cause / Condition | Mitigation & Expected System Behavior |
| :--- | :--- | :--- |
| **Concurrent Resolution Race** | User taps Telegram button while Uplink card is open, or vice versa. | `tools.clarify_gateway.resolve_gateway_clarify` is guarded by an `RLock`. First writer sets event and stores response; second writer receives `False`. The second HTTP request returns `409 Conflict {"code": "clarify_expired"}`. Uplink UI catches 409 and smoothly transitions card to settled state. |
| **Client Disconnection / Tab Close** | User closes browser while clarify is blocking. | SSE connection drops. The server-side turn remains blocked until `urgency` TTL or global timeout expires. On timeout, `wait_for_response` returns `None` -> agent receives canonical `TIMEOUT_RESPONSE` and finishes turn gracefully. Upon reopening the tab, focus probe `GET /clarify/pending` restores card. |
| **Session Reset (`/new` or Delete)** | User deletes session or triggers `/new` while clarify is pending. | Session cleanup calls `tools.clarify_gateway.clear_session(session_key)`. All pending entries are popped and unblocked with empty sentinel `""`, unwinding the agent worker thread immediately. |
| **Stream Interruption (`Stop` button)** | User hits Stop button in Uplink while clarify card is waiting. | Uplink issues abort signal on `/chat/stream` and calls `POST /clarify/respond` with empty answer. Worker is unblocked and cleaned up. |
| **Batch Questions (`questions: [...]`)** | Model passes array of 2–5 questions simultaneously. | `clarify_callback` passes `questions` array in payload. Uplink renders composite multi-question form and submits dictionary/array answer. |

---

## 6. Verification & Test Plan (Implementation Phase)

### 6.1 Automated Unit & Integration Tests
1. **Gateway Unit Tests (`tests/gateway/test_api_server_clarify.py`):**
   - `test_clarify_sse_emission`: Mock agent clarify call; assert `clarify` SSE frame is placed on stream queue with correct `clarify_id`, `choices`, and `urgency`.
   - `test_clarify_respond_endpoint_success`: Register entry in `clarify_gateway`, call `POST /api/sessions/s1/clarify/respond`, assert `200 OK` and unblocked `wait_for_response`.
   - `test_clarify_pending_probe`: Verify `GET /api/sessions/s1/clarify/pending` returns `{"pending": true, ...}` while blocked, and `{"pending": false}` when empty.
   - `test_clarify_respond_expired_409`: Call `POST /clarify/respond` on non-existent or already resolved `clarify_id`, assert `409 Conflict`.
   - `test_text_intercept_deadlock_breaker`: Register pending clarify; send new turn text; verify `attempt_text_response_for_session` intercepts valid selection or clears session on prose.

2. **Uplink Proxy Tests (`tests/test_uplink_proxy.py`):**
   - Verify `proxy.py` starts cleanly with recalculated `PINNED_ASSET_HASHES`.
   - Verify `/api/sessions/{id}/clarify/*` forwards headers and bearer auth transparently.

### 6.2 End-to-End Manual Verification Runbook
1. **Single-Choice Selection:** Run prompt *"Should we deploy to staging or production?"* -> Verify Uplink renders card with `Staging (Recommended)` and `Production` -> Click `Staging` -> Verify stream resumes and agent prints confirmation.
2. **Multi-Select Checkboxes:** Run prompt with `multi_select: true` -> Verify checkboxes render -> Check options 1 and 3 -> Click Confirm -> Verify list reaches agent.
3. **Composite Batch Questionnaire:** Run multi-question prompt (`questions: [...]`) -> Verify composite card renders -> Select answers for all items -> Click "Submit All" -> Verify structured batch resolves.
4. **Main Composer Auto-Skip:** Trigger clarify card -> Type new prompt directly into main composer -> Press Enter -> Verify pending clarify auto-skips and new prompt executes.
5. **Urgency Countdown:** Trigger prompt with `urgency: "low"` (300s) -> Verify live countdown displays in UI -> Allow timer to expire -> Verify card transitions to `(Skipped)` and agent continues autonomously.
6. **Mobile Reconnection & Focus Probe:** Trigger clarify -> Disconnect network / switch tab -> Reconnect / refocus tab -> Verify `GET /clarify/pending` restores interactive card.
7. **History Rehydration:** Refresh browser page -> Open session -> Verify historical clarify turns render cleanly in Settled mode without active buttons.
