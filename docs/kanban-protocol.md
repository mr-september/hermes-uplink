# Kanban board (client contract)

Uplink renders a read-only Kanban board over the gateway's kanban tasks: columns in the server's order, cards with
their rollups, and a detail drawer per task. There are no write actions in v1 — the board never moves, edits, or
comments on a task. This documents what [web/js/kanban.js](../web/js/kanban.js) sends and expects; the Hermes
gateway's API server is authoritative. See [gateway-requirements.md](gateway-requirements.md) for what stock
Hermes provides.

> **Fork extension.** These endpoints are *not* on the stock gateway's REST surface. They exist on the owner's
> fork and are specified here as the frozen contract both sides code against; a stock gateway answers 404 and
> advertises nothing, and Uplink then shows no kanban affordance at all. To add the endpoints to your own
> Hermes checkout, see [patching-hermes.md](patching-hermes.md) §5.

## Capabilities

`GET /v1/capabilities` gates the whole feature:

| Signal | Meaning |
|---|---|
| `features.kanban_read` = `true` | the kanban read routes exist |
| `endpoints.kanban_boards` | `GET /api/kanban/boards` |
| `endpoints.kanban_board` | `GET /api/kanban/board` |
| `endpoints.kanban_task` | `GET /api/kanban/tasks/{task_id}` |

The client requires the flag **and** all three endpoint keys before it shows the board button anywhere. Unlike
clarify, nothing is assumed while capabilities are pending or absent: a gateway that does not advertise kanban
must not gain an empty board, so the affordance stays hidden (the compatibility rule, see
[gateway-requirements.md](gateway-requirements.md)).

## Endpoints (all GET, bearer auth)

- `GET /api/kanban/boards` → `{"boards": [{"slug", "name", "archived"}]}`.
- `GET /api/kanban/board?board=<slug>&tenant=<t>&include_archived=<bool>` →
  `{"object": "hermes.kanban.board", "board": "<slug>", "column_order": [...], "columns": {"<status>": [task, ...]},
  "latest_event_id": N, "truncated": bool}`.
  - `column_order` is authoritative: the client renders exactly those columns, in that order, with counts. A
    missing `column_order` falls back to the `columns` keys.
  - `truncated: true` renders a visible "showing newest 500" note; absent or false renders nothing.
  - Task fields the client reads: `id`, `title`, `body`, `assignee`, `status`, `priority`, `created_at`,
    `age`, `latest_summary`, `comment_count`, `progress`, `parents_progress` (the last two are `{done, total}`
    or `null`). Unknown fields are ignored.
- `GET /api/kanban/tasks/{id}?board=<slug>` → `{"object": "hermes.kanban.task", "board", "task": {...},
  "links": {"parents": [ids], "children": [ids]}}`; `404` for an unknown id. The drawer shows the body,
  `comment_count`, and the parent/child links; link titles resolve from the already-loaded board where the id is
  present, otherwise the id stands. Status history beyond the task's own timestamps is out of scope.

**Board resolution:** the client always passes `?board=` explicitly — the server's default pointer can point at a
board the user did not choose. The board list is fetched first; a switcher appears only when more than one board
exists, and the chosen slug is kept for the session. `tenant` and `include_archived` are left at the server's
defaults.

## Client behaviour

- A card shows title, assignee, age (the server's `age`, else derived from `created_at`), and a rollup badge
  `done/total` whenever `progress ?? parents_progress` is non-null. A title starting with `GOAL:`
  (case-insensitive) marks a **GOAL card** — badge plus left accent — using the same rollup rule as the desktop
  client; nothing else is special about it.
- The priority accent is a display decision, not protocol: common labels (`urgent`/`critical`/`high`,
  `medium`/`normal`, `low`) and numeric priorities (≥3, 2, ≤1) get red / amber / grey left borders; an
  unrecognized value gets no accent.
- Clicking a card opens the detail drawer; `Escape` closes the drawer, then the board.
- Refetches happen when the board is opened and when the window regains focus or visibility, like the clarify
  pending probe — there is no background poller and no SSE in v1. A refetch whose `latest_event_id` differs from
  the last one flashes a quiet "updated" marker; it never scrolls or replaces what is on screen mid-read.
- A failed fetch keeps whatever board is already rendered and shows the error only over an empty view, matching
  the app's other panels.
