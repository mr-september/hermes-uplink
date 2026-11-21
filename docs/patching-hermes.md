# Patching your own Hermes for Uplink

Uplink works against a stock Hermes gateway and shows less where a feature is missing ([gateway-requirements.md](gateway-requirements.md)). If upstream has not merged what you want, this page is a brief you can give to your own Hermes agent (or any coding agent) to add it to your local checkout.

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

## 2. Context ring, interactive questions, batch clarify

These are larger — occupancy spans the schema and store layers, and clarify is a REST surface upstream does not expose at all — so they are not reproduced here. The reference implementation is the **`larry` branch** of [mr-september/hermes-agent](https://github.com/mr-september/hermes-agent) — not `main`, which is a historical mirror. Start from that branch's `FORK.md`: its persistent-patch table names every owning module and its guard test, and it is kept current through each upstream sync.

| Feature | Fork owners (see `FORK.md` on `larry`) | Contract |
|---|---|---|
| Context ring | occupancy columns in `persistence/sqlite/_schema_ddl.py`, the worker receipt + holder merge rule, the session interface (`SESSION_ROW_COLUMNS`, `SessionRecord`), adapter mapping, and the API passthrough in `gateway/platforms/api_server.py` | adds `context_used` and `context_window` to the session detail response |
| Interactive questions | fork-owned `gateway/platforms/api_server_clarify*.py` plus session-scoped helpers in `tools/clarify_gateway.py`, composed on upstream's entry-scoped clarify internals | [clarify-protocol.md](clarify-protocol.md) |

Port the clarify surface against your checkout's current clarify internals, not against the fork's older code. Then advertise the features in `/v1/capabilities` (`features.clarify`, and `features.clarify_batch` if you also port batch locking), since Uplink treats an absent flag as unsupported.

Without section 2, a clarify call from the agent has no card in Uplink and waits for its timeout; avoid prompts that depend on it.

## 3. (Optional) sending into sessions the API server does not own

By default the API server admits turns only into sessions it created (`source` `api_server` or `bot_room`); Uplink handles other sessions through its CLI fallback and this is fine on stock. The reference implementation additionally widens the gates for `local`/`desktop` sessions so REST sends reach them directly. This must be done as a *storage-source* check (same physical store → same conversation identity), not by merely relaxing the admission tuple in `admit_api_steps`: a bare widening rebinds the conversation's route away from its owner, which is the defect the upstream check exists to prevent. Messaging sessions (telegram and friends) must stay refused. If you skip this section, nothing else breaks — Uplink keeps using the CLI fallback.

## After patching

Restart the gateway, reload Uplink, and open **Capabilities** (the ⓘ button) to see the raw `/v1/capabilities` response and confirm the flags you expect. Re-apply the patches after each Hermes update, since an upstream change to the touched functions can drop them silently; your agent's tests are the tripwire.
