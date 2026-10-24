# Hermes gateway requirements

Uplink talks to the Hermes API server (the gateway's REST + SSE surface). Core chat works against a stock gateway; each optional feature below degrades cleanly when the gateway does not provide it. The "stock" column reflects NousResearch/hermes-agent `main` as checked on 2026-10-23; the reference implementation of everything marked *extension* is the `main` branch of [mr-september/hermes-agent](https://github.com/mr-september/hermes-agent).

## Core (stock)

| Used for | Endpoint or field |
|---|---|
| Health and feature detection | `GET /health`, `GET /v1/capabilities` (`features`, `endpoints`) |
| Session list and history | `GET /api/sessions?limit&include_children`, `GET /api/sessions/{id}`, `GET /api/sessions/{id}/messages`, `POST /api/sessions`; rows use `title`, `preview`, `source`, `message_count`, `last_active`, `is_internal_child` |
| Streaming turns | `POST /api/sessions/{id}/chat/stream` (SSE: `assistant.delta`, `assistant.commentary`, `assistant.completed`, `tool.started` / `tool.completed` / `tool.failed`, `error`, `run.completed`; frames carry `run_id`) |
| Stop | `POST /v1/runs/{run_id}/stop` |
| Models | `GET /api/model/options`, `POST /api/sessions/{id}/model`; session `model` and `provider` |
| Skills and toolsets panel | `GET /v1/skills`, `GET /v1/toolsets` |
| Mark read | `PATCH /api/sessions/{id}` with `{"unread": false}` |

## Optional features

| Feature | What the client uses | Without it | Stock |
|---|---|---|---|
| Unread badges | `unread` (boolean) on session list rows and on single-session get/patch responses | No unread badges; read-marking is a harmless no-op | The database computes `unread` and `PATCH` accepts it, but the REST responses do not return it. *Extension.* |
| Context ring | `context_used` and `context_window` (`context_limit` and `occupancy_pct` also read) on session detail | Ring shows "unknown" | Not on the REST session payload. *Extension.* |
| Interactive questions | `clarify` / `clarify.settled` / `clarify.intercept` SSE events; `POST …/clarify/respond`; `GET …/clarify/pending`; `client_capabilities` accepted on the chat request; `features.clarify` in `/v1/capabilities` | The agent's clarify call has no card to answer and waits for its timeout | The clarify core (single, multi-select, batch, locking) and its Telegram, Discord, Slack, TUI and Desktop front-ends are stock; the REST/SSE adapter is not. *Extension.* |
| Batched questions with partial saves | `POST …/clarify/lock`, `features.clarify_batch`, `batch` and `locked` fields on the `clarify` event | Batches fall back to one submit with no server-side partial save | As above. *Extension.* |
| Turn de-duplication | `Idempotency-Key` and `client_turn_id` on chat/stream | A retried send after a dropped connection can run twice | Not implemented for session streaming; the client already sends both. |
| Activity status | `activity_state`, `status_updated_at` on session rows | Not implemented in the client either | Planned; see [session-status.md](session-status.md). |

Protocol details for the clarify items are in [clarify-protocol.md](clarify-protocol.md).

## Compatibility rule

Uplink treats an absent field or feature flag as "unsupported", never as an empty or idle state, so an older gateway shows less rather than showing something wrong.
