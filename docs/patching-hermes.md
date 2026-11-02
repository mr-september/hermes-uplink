# Patching your own Hermes for Uplink

Uplink works against a stock Hermes gateway and shows less where a feature is missing ([gateway-requirements.md](gateway-requirements.md)). If upstream has not merged what you want, this page is a brief you can give to your own Hermes agent (or any coding agent) to add it to your local checkout.

> **Prompt for the agent.** You are patching a local checkout of hermes-agent so the Hermes Uplink web client can use optional gateway features. Do only the sections below that I name. Locate code by the symbol names given, not by line number, because my checkout may differ from the one this was written against. Before editing, confirm each named symbol exists; if one does not, stop and report what you found instead of guessing. Make the smallest change, follow the repo's own conventions (`AGENTS.md`, line-count and lint checks), add a test that fails before the change, and do not push or open a PR.

## 1. `unread` on REST session responses

**Symptom:** Uplink shows no unread badges. `PATCH /api/sessions/{id}` with `{"unread": false}` already works, but no REST response returns `unread`.

**Cause:** `SessionDB` derives `unread` for list rows, but `APIServerAdapter._session_response()` drops it from its allowlist, and `GET`/`PATCH` on a single session never compute it.

**Verified against** NousResearch/hermes-agent `main` as of 2026-10-23 (symbols: `_session_response`, `_handle_get_session`, `_handle_patch_session`, `SessionDB.session_unread`, `_read_one`, `_sql_session_last_active`).

1. Add `"unread"` to the `safe_keys` tuple in `APIServerAdapter._session_response()` in `gateway/platforms/api_server.py`. List rows now carry it.
2. Add a single-row read to `SessionDB`, using the same recency expression as the list so the endpoints cannot disagree:

```python
def get_session_unread(self, session_id: str) -> bool:
    row = self._read_one(
        f"SELECT s.last_read_at AS last_read_at, s.started_at AS started_at, "
        f"{_sql_session_last_active('s')} AS last_active FROM sessions s WHERE s.id = ?",
        (session_id,),
    )
    return self.session_unread(dict(row)) if row else False
```

3. In `_handle_get_session` and at the end of `_handle_patch_session`, derive it before building the response:

```python
db = await self._ensure_session_db_async()
unread = await asyncio.to_thread(db.get_session_unread, session["id"])
return web.json_response(
    {"object": "hermes.session", "session": self._session_response({**session, "unread": unread})}
)
```

If the repo enforces a per-file line cap (upstream does for `api_server.py` and `hermes_state_sessions.py`), put the helpers in new sibling modules and call them from the handlers instead of editing those files in place.

**Test:** create sessions that are never-tracked, marked unread, marked read, and active after being read; assert `list`, `get`, and `patch` agree for each. The test must fail on the unpatched code with `KeyError: 'unread'`.

**Check:** `curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8642/api/sessions/<id>` shows `"unread": false`; restart the gateway first.

## 2. Context ring, interactive questions, batch clarify

These are larger and tied to your checkout's clarify and runs code, so they are not reproduced here. The reference implementation is the `main` branch of [mr-september/hermes-agent](https://github.com/mr-september/hermes-agent); find the commits by subject and port them rather than cherry-picking blindly:

| Feature | Commit subject to search for | Contract |
|---|---|---|
| Context ring | `surface agent context-window occupancy to thin clients` | adds `context_used` and `context_window` to the session detail response |
| Interactive questions | `restore clarify REST surface for thin clients`, then `port the Uplink REST surface to upstream's callback contract` | [clarify-protocol.md](clarify-protocol.md) |

Port the later of the two clarify commits against your checkout's current clarify callback, not the earlier one. Then advertise the feature in `/v1/capabilities` (`features.clarify`, and `features.clarify_batch` if you also port batch locking), since Uplink treats an absent flag as unsupported.

Without section 2, a clarify call from the agent has no card in Uplink and waits for its timeout; avoid prompts that depend on it.

## 3. Admissions for pre-existing sessions (required since upstream `9bba78ef`)

**Symptom:** every send to a session that already exists (created by the desktop app, CLI, or a messaging surface) fails instantly: the SSE stream opens, emits `run.started`, then a single `error` frame with `permission_denied`, then `done`. No user message is admitted. Sends in brand-new Uplink sessions work, which makes it look intermittent.

**Cause:** two matching foreign-source gates compare the session row's `source` against API-only labels: `admit_api_steps()` in `gateway/session_api_turn.py` (`existing['source'] not in ('api_server', 'bot_room')`), and the storage-source binding checks in `gateway/session_api.py` (the bind write raises `permission_denied` when `row['source'] != storage_source`, with the same equality mirrored in the live-session pre-check and `restore_api_session()`). Gateways that stamp their own local sessions `local` or `desktop` therefore fail the first gate, and — after widening only the first — the second.

**Verified against** NousResearch/hermes-agent `main` as of the 2026-11-01 update (symbols: `admit_api_steps`, `authority.db.get_session`, `_BINDING_PREFIX` binding write, `restore_api_session`).

1. In `admit_api_steps()`, widen the tuple to include the source labels your gateway legitimately stamps on its own local sessions — on the reference checkout: `('api_server', 'bot_room', 'local', 'desktop')`.
2. In `gateway/session_api.py`, add one shared predicate and use it at all three equality sites instead of `!=` — the live-session pre-check in the bind path, the bind write, and the `restore_api_session()` verification:

```python
_LOCAL_STORAGE_SOURCES = frozenset({'local', 'desktop'})

def storage_source_matches(row_source, storage_source):
    return (row_source == storage_source
            or (storage_source == 'api_server' and row_source in _LOCAL_STORAGE_SOURCES))
```

Keep genuinely remote surfaces (e.g. `telegram`, `discord`) refused at both gates — that is the check's original purpose of not admitting into another adapter's session. The persisted binding keeps `storage_source='api_server'` (it names the owning adapter, not the surface stamp).

**Test:** create sessions whose `source` is `local` and `desktop`; call `admit_api_turn` (or POST `/api/sessions/{id}/chat/stream`) and assert admission instead of `permission_denied`. The reference fork ships this as `tests/gateway/test_api_local_surface_admission.py`. The test must fail on the unpatched code.

**Check:** restart the gateway, then in Uplink open any older session and send — the message admits and the agent answers.

## After patching

Restart the gateway, reload Uplink, and open **Capabilities** (the ⓘ button) to see the raw `/v1/capabilities` response and confirm the flags you expect. Re-apply the patches after each Hermes update, since an upstream change to the touched functions can drop them silently; your agent's tests are the tripwire.
