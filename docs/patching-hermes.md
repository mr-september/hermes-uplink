# Patching your own Hermes for Uplink

Uplink works against a stock Hermes gateway and shows less where a feature is missing ([gateway-requirements.md](gateway-requirements.md)). If upstream has not merged what you want, this page is a brief you can give to your own Hermes agent (or any coding agent) to add it to your local checkout. It is self-contained: nothing here requires any repository other than your hermes-agent checkout.

> **Prompt for the agent.** You are patching a local checkout of hermes-agent so the Hermes Uplink web client can use optional gateway features. Do only the sections below that I name. Locate code by the symbol names given, not by line number, because my checkout may differ from the one this was written against. Before editing, confirm each named symbol exists; if one does not, stop and report what you found instead of guessing. Make the smallest change, follow the repo's own conventions (`AGENTS.md`, line-count and lint checks), add a test that fails before the change, and do not push or open a PR.

The sections are keyed to hermes-agent `main` at `b1ef9bea695d` (2026-11-20), *after* the storage-layer rewrite that retired `hermes_state.SessionDB`. If your checkout predates that rewrite, the symbols differ (`hermes_state.SessionDB`, `get_session_unread`, `_ensure_session_db_async`); ask your agent to map the same behavior onto its own store API rather than pasting this code.

## 1. `unread` on REST session responses

**Symptom:** Uplink shows no unread badges. `PATCH /api/sessions/{id}` with `{"unread": false}` already works, but no REST response returns `unread`.

**Cause:** the persistence store derives `unread` (read-watermark recency), but the REST row builders drop it: `_session_row()` never copies it from the store's list entry, `_session_response()`'s `safe_keys` omits it, and `GET`/`PATCH` on a single session never read it.

**Verified against** NousResearch/hermes-agent `main` as of 2026-11-21 (`b1ef9bea695d`; symbols: `_session_row`, `APIServerAdapter._session_response`, `persistence/sqlite/conversation/_store/sessions.py::session_unread`).

1. Add `"unread"` to the `safe_keys` tuple in `APIServerAdapter._session_response()` in `gateway/platforms/api_server.py`.
2. In the module-level `_session_row(session, entry=None)` in the same file, copy `unread` from `entry` when present. The store's session-list owner computes it (see `session_unread` in `persistence/sqlite/conversation/_store/sessions.py`); confirm your list projection actually carries the field and extend the projection if it does not — do not re-derive the recency rule in the API layer.
3. For the single-session `GET`/`PATCH` paths, read the store's own derived value rather than recomputing: `await store.aio.sessions.summary(session_id).unread`. Never derive it from `last_activity_at` — the message-write path updates no stamp there, and the endpoint will disagree with the list.

**Test:** create sessions that are never-tracked, marked unread, marked read, and active after being read; assert `list`, `get`, and `patch` agree for each. The test must fail on the unpatched code with `KeyError: 'unread'`.

**Check:** `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8642/api/sessions/<id>` shows `"unread": false`; restart the gateway first.

## 2. Context ring (`context_used` / `context_window`)

**Semantics:** `context_window` is the context window of the model the session last ran with; `context_used` is the token count of the most recent assembled prompt. Both are `null` until the session's first completed agent turn.

**Failure mode to guard against:** silent drops. Every layer between the writer and the response drops a key it does not know about, so carry the two fields through *all* of them:

1. **Schema** — two nullable integer columns, `context_window` and `context_used`, on the sessions table, added through your checkout's schema/migration machinery (as of the key pin: `persistence/sqlite/_schema_ddl.py`).
2. **Write path** — wherever the agent loop reports the prompt-size observation after a turn (near the context controller that decides when to compact — it knows both the assembled prompt size and the configured window), persist it through the per-session update path that already writes session stats. Merge rule: a reported value overwrites; a turn that reports nothing must keep the stored value — never null it out.
3. **Read path** — carry both columns through every hop of a session row: the store's row-column list and record type (as of the key pin: `SESSION_ROW_COLUMNS` and `SessionRecord`), the adapter that maps a store row to an API dict, and the session detail response, which gains both fields, nullable.

**Test:** fake a turn that reports known token counts, then `GET /api/sessions/<id>` and assert both values; follow with a turn that reports nothing and assert the stored values survive. No capabilities flag is needed for this one — Uplink shows the ring when the fields are present and hides it when they are not.

## 3. Interactive questions (clarify) and the batch lock

The wire contract is fully specified in [clarify-protocol.md](clarify-protocol.md) — implement exactly that; your checkout's agent-side `clarify` tool already owns the ask-and-wait machinery (as of the key pin: `tools/clarify_gateway.py`). What upstream lacks is the gateway's REST/SSE surface around it. Four parts:

1. **SSE on the chat stream.** When the agent calls `clarify` mid-turn on a streamed request, emit the `clarify` event with the fields in the protocol's table, including the batch shapes (`questions`, `batch: true`, and `locked` on recovery). Emit `clarify.settled` with the outcome (`submitted` / `timed_out` / `cancelled`) when the question resolves, no matter which path resolved it — answer, timeout, typed-reply skip, or cancel.
2. **Session-scoped routes.** The client cannot address a question by run id alone — discovery must work by session. Implement `GET /api/sessions/{id}/clarify/pending` (returns `{pending, clarify}`), `POST /api/sessions/{id}/clarify/respond` (single, batch, and lockless-batch body shapes; an already-settled `clarify_id` answers `409`/`404`, never `200`), and `POST /api/sessions/{id}/clarify/lock` for batch (stores the partial answer, returns the authoritative `{locked}`).
3. **Typed-reply composition.** A user message arriving while a *single* question is pending resolves it as skipped and then proceeds as a normal turn. One arriving while a *batch* is pending starts no turn and receives the `clarify.intercept` event. Compose these behaviors onto your checkout's existing clarify internals — do not duplicate the agent-side question machinery.
4. **Capabilities.** Advertise `features.clarify`, the endpoint keys `session_clarify_respond` and `session_clarify_lock`, and `features.clarify_batch` only if you implemented the lock route. Uplink treats absent flags as unsupported; an absent flag is a correct degradation, a false one is not.

**Test:** with a live gateway, run one streamed turn that triggers `clarify` with a generous timeout, then drive the protocol's happy path, the `409` double-answer, the timeout, and the typed-reply cases over HTTP.

Without this section, a clarify call from the agent has no card in Uplink and waits for its timeout; avoid prompts that depend on it.

## 4. (Optional) sending into sessions the API server does not own

By default the API server admits turns only into sessions it created (`source` `api_server` or `bot_room`); Uplink handles other sessions through its CLI fallback and this is fine on stock. Optionally, you can widen the gates for `local`/`desktop` sessions so REST sends reach them directly. Do it as a *storage-source* check (same physical store → same conversation identity), not by merely relaxing the admission tuple in `admit_api_steps`: a bare widening rebinds the conversation's route away from its owner, which is the defect the upstream check exists to prevent. Messaging sessions (telegram and friends) must stay refused. If you skip this section, nothing else breaks — Uplink keeps using the CLI fallback.

## 5. (Optional) Kanban board (read-only)

Implement per [kanban-protocol.md](kanban-protocol.md); the endpoints must be advertised under
`features.kanban_read` with the endpoint keys `kanban_boards`, `kanban_board`, and `kanban_task` in
`/v1/capabilities`. The shape doc is the authority — this section is only the pointer. Without it, Uplink shows
no board view and no kanban affordance.

## After patching

Restart the gateway, reload Uplink, and open **Capabilities** (the ⓘ button) to see the raw `/v1/capabilities` response and confirm the flags you expect. Re-apply the patches after each Hermes update, since an upstream change to the touched functions can drop them silently; your agent's tests are the tripwire.
