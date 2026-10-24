# Clarify protocol (client contract)

When the agent calls `clarify`, the gateway emits a question on the open chat stream and waits. Uplink renders a card; the answer travels over a separate HTTP call, never a second `/chat/stream`. This documents what [app.js](../app.js) sends and expects; the gateway (`gateway/platforms/api_server.py` in the Hermes fork) is authoritative.

## Notification (SSE, on `POST /api/sessions/{id}/chat/stream`)

| Event | Payload fields used |
|---|---|
| `clarify` | `clarify_id`, `question`, `choices[]`, `multi_select`, `timeout_seconds`, `created_at` (epoch s); batch: `questions[{qid, question, choices, multi_select}]`, `batch` (true = lock protocol), `locked{qid: answer\|null}` (present on recovery) |
| `clarify.settled` | `clarify_id`, `outcome` (`submitted` / `timed_out` / `cancelled`); retires the card whoever answered |
| `clarify.intercept` | `message`; the gateway started no turn because a question was waiting; the client drops its bubbles and restores the card |

The chat request advertises support with `client_capabilities: ["clarify", "clarify_batch"]`. The client derives the list from `GET /v1/capabilities` (`features.clarify`, `features.clarify_batch`, `endpoints.session_clarify_respond` / `session_clarify_lock`) and assumes both until that answers.

## Resolution

- `POST /api/sessions/{id}/clarify/respond`
  - single question: `{clarify_id, answer}`; `answer` is text, a JSON-array string for multi-select, or `""` to skip;
  - batch (`batch: true`): `{clarify_id, answers: {qid: string|null}}`, or `{clarify_id, outcome: "cancelled"}`;
  - batch from a gateway without the lock protocol: `{clarify_id, answer: JSON.stringify({answers})}`, or `""` to cancel.
  - `409` / `404` means already answered or expired; the card settles as expired and the typed answer is not shown as accepted.
- `POST /api/sessions/{id}/clarify/lock` (batch only): `{clarify_id, qid, answer|null}`, sent as each question is answered so the server holds partial answers; the response `{locked}` is authoritative. `409` closes the card.
- `GET /api/sessions/{id}/clarify/pending` returns `{pending, clarify}`. It is probed on focus/visibility and when an active stream has been silent for 45 s, and restores a card the stream failed to deliver.

## Client behaviour

- A countdown runs only when the server sent `timeout_seconds`. A single-question card stays answerable until `clarify.settled`; a batch becomes a read-only summary at zero.
- Typing in the composer while a single question is pending skips it; if the turn is still streaming, the text is kept for sending afterwards. A pending batch is never answered by typed text.
- Cards survive session switches: a background stream keeps writing into detached nodes, and the session row shows "question waiting".
- Hotkeys apply to single-question cards only: digits or letters select a choice, Enter submits.
