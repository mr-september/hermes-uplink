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

**Test:** create sessions that are never-tracked, marked unread, marked read, and active after being read; assert `list`, `get` and `patch` agree for each. The test must fail on the unpatched code with `KeyError: 'unread'`.

**Check:** `curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8642/api/sessions/<id>` shows `"unread": false`; restart the gateway first.

## 2. Context ring, interactive questions, batch clarify

These are larger and tied to your checkout's clarify and runs code, so they are not reproduced here. The reference implementation is the `main` branch of [mr-september/hermes-agent](https://github.com/mr-september/hermes-agent); find the commits by subject and port them rather than cherry-picking blindly:

| Feature | Commit subject to search for | Contract |
|---|---|---|
| Context ring | `surface agent context-window occupancy to thin clients` | adds `context_used` and `context_window` to the session detail response |
| Interactive questions | `restore clarify REST surface for thin clients`, then `port the Uplink REST surface to upstream's callback contract` | [clarify-protocol.md](clarify-protocol.md) |

Port the later of the two clarify commits against your checkout's current clarify callback, not the earlier one. Then advertise the feature in `/v1/capabilities` (`features.clarify`, and `features.clarify_batch` if you also port batch locking), since Uplink treats an absent flag as unsupported.

Without section 2, a clarify call from the agent has no card in Uplink and waits for its timeout; avoid prompts that depend on it.

## After patching

Restart the gateway, reload Uplink, and open **Capabilities** (the ⓘ button) to see the raw `/v1/capabilities` response and confirm the flags you expect. Re-apply the patches after each Hermes update, since an upstream change to the touched functions can drop them silently; your agent's tests are the tripwire.
