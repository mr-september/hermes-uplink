# Hermes Uplink — Mobile Edge UX & Shared Session Status

**Status:** Milestones 1 and 2 are implemented on `master`; milestones 3-5 are not started (updated 2026-10-24). Coverage decision **B2-lite** (2026-10-20); see §4, §7, §8.
**Target:** mobile Edge on phone/tablet; preserve desktop behavior.
**Uplink baseline:** `E:/hermes-uplink`, branch `master`, commit `ada3e17` at spec creation.
**Hermes baseline:** `C:\Users\Larry\AppData\Local\hermes\hermes-agent`, commit `5247b2b` (fork of NousResearch/hermes-agent per its `FORK.md`; `origin` is read-only upstream). Phase B changes this repo, not Uplink (§3.7). §2 claims were verified against it on 2026-10-19.
**Purpose:** one design/implementation contract, not a task queue. Kanban remains the execution-status source of truth.

## Executive summary

- **Build:** a less crowded mobile header, readable model identity, and per-session indicators for working and completed-unread conversations, including one aggregate dot on the drawer button so status is visible while the drawer is closed.
- **Approach:** keep the Uplink client zero-build; make layout changes mobile-specific; mirror Electron's status *semantics and precedence* (not its data source, which is client-local); take unread from the shared database and activity from the Hermes processes the API server can actually observe.
- **Decision (B2-lite):** activity is reported for API-server runs (including Uplink's) and gateway/messaging turns; CLI/TUI/Electron-originated runs report `unknown`, never idle. Unread covers every origin. A cross-process activity store (B2-full) is explicitly deferred (Appendix A).
- **Main risk:** the API server must map gateway turns to stored session ids correctly (lineage rotation) and must not report `idle` for a session that another process may be running; Phase A is a short spike on exactly that.
- **Sequencing:** (1) mobile header/composer; (2) unread end-to-end (one-line backend change + client); (3) short spike; (4) B2-lite activity backend; (5) working indicators. Each milestone ships independently (§8).

## 1. Decisions and defaults

### 1.1 Session-status coverage (decision: B2-lite)

**Decision:** report activity for what the API-server process can observe authoritatively, and say `unknown` for the rest. Do not infer idle.

| Origin of the running turn | `working` / `needs_input` | Shown as when not running | Unread |
|---|---|---|---|
| Uplink / API-server runs (`/chat/stream`, `/v1/runs`) | authoritative (`_run_statuses`) | `idle` | yes |
| Messaging gateway turns (Telegram etc., same process) | authoritative (running-agent/turn state), pending Phase A mapping check | `idle` | yes |
| CLI / TUI / Electron turns (other processes) | **not observable** | `unknown` while a live foreign lease exists on the session (see below), else `idle` | yes |

Rule that keeps `idle` honest: the server may report `idle` only if no covered source is running the session **and** no live foreign process holds an active-session lease on it. An open lease is not evidence of work, but it is evidence that the server cannot rule work out, so it downgrades `idle` to `unknown` (Phase A verifies the registry can be read read-only from the API server; if not, `unknown` applies to every session whose `source` is a non-gateway origin).

**Consequence for the user, stated plainly:** a run started in Electron or the CLI will not show as working in Uplink in this release; it will show quietly as unknown and will flip to completed-unread when it finishes. Starting work from Uplink or Telegram shows working. This is the accepted trade-off for not adding a cross-process store.

**Deferred alternative (B2-full, Appendix A):** CLI/TUI/Electron write turn state into the existing cross-process lease registry so the API server can report their activity. Revisit if the unknown state proves annoying in daily use.

**Rejected alternative:** report only Uplink-started runs and call everything else idle. It is misleading for a shared-session product: a run can continue after Uplink switches sessions or disconnects, and another client can work on the same session.

### 1.2 State semantics

Keep activity and unread as separate facts; one does not erase the other. Proposed additive session fields (names provisional until the source-mapping spike):

- `activity_state`: `idle | working | needs_input | stalled | unknown`
- `unread`: boolean, backed by shared read state
- `status_updated_at`: timestamp/freshness evidence where available

Uplink's list rendering reads `s.active` for a "live" badge, but `_session_response()` does not emit `active` (verified: not in its `safe_keys`), so that badge never renders today. Phase B either removes the dead code or replaces it with `activity_state`; do not ship two "live" notions.

The UI resolves overlapping states in this order, matching `session-dot-state.ts` (verified): **needs input → working (stalled refines working) → background/delegating → completed-unread → draft → idle**. Deliberate deviations from Electron, stated so they are not accidental: (a) `draft` is omitted from shared status (it is local; Uplink has its own draft autosave); (b) `background` (background processes or async delegation after the parent turn ended) is shown as a working variant with its own label, e.g. "background work"; (c) `stalled` is rendered as working with a distinct cue ("working — no recent activity"), as Electron keeps the running arc for it. Do not promise percentage progress.

Treat two different "not known" situations separately:

- **Unsupported source** (server reports `unknown` because that origin cannot be measured): render no activity marker, or a very quiet one, so most rows are not decorated. Unread, if known, still renders.
- **Stale snapshot** (client lost connectivity, or `status_updated_at` is older than the freshness window): keep the last known state only with an explicit stale cue. Never render stale or missing data as idle.

### 1.3 Read behavior

Opening a session clears unread only **after its history has loaded successfully**. Keep the shared read watermark current while that session is selected and visible, so a completion the user actually sees is not left green. Write it on completion of a visible run, on regaining visibility, and on open, and at most once per ~10 s per session (never per stream chunk); write only while `document.visibilityState` is visible. Note that unread is derived as `last_active > last_read_at` (NULL watermark = read), so a message sent from Uplink itself advances `last_active` and would mark the session unread unless the watermark is re-stamped after the turn completes. Mirror Electron's write guard (`UNREAD_WRITE_GUARD_MS`, `session-unread-remote.ts`): after a local read/unread write, keep the local value until a list response confirms it or the guard expires, so a stale list page cannot flip a just-read session back to unread. An Edge read should clear the same durable unread state seen by Electron; session-id compression/lineage must continue to resolve to the same conversation.

### 1.4 Mobile header and model identity

At phone widths, use a deliberate two-row layout rather than squeezing the current one-row flex bar. "Phone width" is defined by the width of the main pane (container query on `#main`, or equivalent), not the viewport: the existing sidebar pins at ≥768px landscape, so a phone in landscape (~844px) has a ~560px main pane that a `max-width:600px` viewport rule would miss. In short-height viewports (landscape phone, keyboard open) collapse back to a single compact row or hide the secondary row so the thread keeps usable height.

- **Primary row:** Sessions/drawer control (carrying the aggregate status dot, §1.6) and the active session title.
- **Secondary row:** model selector (up to two meaningful text lines), non-shrinking connection indicator, and a clearly labeled More menu for secondary actions that do not fit.
- **More menu default contents:** Capabilities, Copy session ID, Refresh, and Skills/Tools. Keep session selection, model selection, and message Send readily reachable. The Skills/Tools button currently reuses the Settings gear glyph (⚙); give it a distinct icon/label. The menu must be keyboard/screen-reader operable: `aria-haspopup`/`aria-expanded`, focus moved in on open and restored on close, Escape and outside-tap to close.
- **Model chip:** show the recognizable model name and, where useful, provider/default as a separate subline. Wrap at meaningful boundaries; clamp only the visible chip. Keep the full model/provider identity available in the model picker and accessible name. Do not expose only an unexplained truncated provider slug.
- **Settings:** center the gear glyph explicitly. Keep the desktop one-row header and desktop sizing unchanged.

For coarse-pointer controls, target a 44×44 CSS-pixel hit area. If that makes the header too dense, move a secondary action to More rather than shrinking controls.

### 1.5 Session ordering and scope limits

Keep the existing recency ordering. Do not add status sorting, push notifications, numeric badges/counts, model-picker redesign, or a broad visual refresh in this change. (A single non-numeric aggregate dot on the drawer button, §1.6, is in scope.) Match Electron’s status meaning and precedence; do not port unrelated Electron surface behavior.

### 1.6 Drawer-level aggregate indicator

On phones the sidebar is a closed drawer, so per-row indicators are only seen after opening it. Show one small non-numeric dot on the Sessions/drawer button, derived from sessions *other than the active one* using the same precedence as §1.2 (needs-input > working > unread > none; in Milestone 2, before activity exists, only unread applies), with an accessible label (e.g. "Sessions — another session needs input"). No counts. Also show the active session's own state in the header title area, since the sidebar row is not visible there.

## 2. Verified baseline and impact radius

### Uplink client (`E:/hermes-uplink`)

- `index.html` uses a single flex header row with multiple fixed-width controls; there is no general mobile reflow. The small-screen rule only caps `.modelchip` at 120px.
- `.modelchip-text` is single-line/no-wrap/ellipsis. `formatModelName()` displays the final slash-delimited model segment; the full model and provider are only in the chip `title`, which is not a dependable touch affordance.
- `.dot` is 7px wide but has no `flex-shrink: 0`; the connection dot can be squeezed by neighboring controls. It represents Uplink connection, not chat progress.
- `.toolbtn` is 40×40px and does not explicitly center its contents. Several icon-only controls (`settingsBtn`, `menuBtn`, `infoBtn`, `refreshBtn`, `rightBtn`, and `idChip`) rely on `title` rather than an accessible name.
- The composer advertises “Enter to send” while coarse-pointer input handling makes Enter insert a newline; Ctrl+Enter sends. Keep mobile Enter as newline and make the hint accurate (or generic).
- `viewport-fit=cover`, dynamic viewport sizing, and mobile safe-area padding already exist; preserve them.
- `renderSessions()` renders a "live" badge from `s.active` (never populated, see above), sorts by `updated_at || last_active`, and the client refreshes only on load and `visibilitychange`/focus (no polling).
- `probePendingClarify()` already uses `GET /api/sessions/{id}/clarify/pending` for the *active* session only; `docs/clarify-protocol.md` defines that transport and is the natural source for `needs_input`.
- The proxy CSP sets `style-src-attr 'none'` and `script-src-attr 'none'` and allows only pinned external scripts: new UI (More menu, status cues) must use CSS classes and `addEventListener`/property handlers, never inline `style=""` or `onclick=""` attributes, and must not inject `<style>` elements.
- Any edit to `index.html`, `app.js`, `app.css` or `sw.js` must refresh the pinned digests with `python proxy.py --update-hashes` (verify with `--check-hashes`) in the same change; stale pins fail closed and prevent proxy startup. Do not bump `sw.js` unless it changes (neither `index.html` nor `app.js` is cached by the service worker).

### Hermes API and Electron reference

- `gateway/platforms/api_server.py::_handle_list_sessions()` lists persisted sessions and passes them through `_session_response()`.
- `_session_response()` currently omits `unread` and any per-session activity state (verified: `safe_keys` has neither, nor `active`/`updated_at`; Uplink's `updated_at` sort key therefore always falls back to `last_active`). `PATCH /api/sessions/{session_id}` accepts `unread` and calls `db.set_session_read`, which stamps the `last_read_at` watermark across the whole compression lineage. `list_sessions_rich` **already computes** `unread` (`session_unread`: `last_active > last_read_at`, NULL = read) for every row, so exposing unread is a one-line projection change; only activity needs new work. List responses are `{object:"list", data:[…], has_more}`.
- Uplink requests `include_children=true`; the API marks delegate children with `is_internal_child`, which Uplink does not use, so internal child sessions can appear as ordinary rows and would carry their own status dots. Filter or fold them under their parent when adding status.
- `api_server_runs.py` keeps pollable run state in `_run_statuses`, keyed by `run_id`, with `session_id` and status `queued | running | waiting_for_approval | terminal`; Uplink's `/chat/stream` runs register there too. It is in-memory (terminal entries kept `_RUN_STATUS_TTL` = 3600 s), persisted only for idempotent runs, and runs orphaned by a gateway restart are reported `interrupted`. There is no per-session projection in `GET /api/sessions`; `/v1/health` exposes only a global `active_runs` count. `waiting_for_approval` is a second `needs_input` source besides clarify.
- The messaging gateway (Telegram etc.) runs in the same process as the API server (`gateway_state.json` shows one pid hosting both) and tracks `_running_agents` / session leases in `gateway/run.py`, and the API adapter holds a `gateway_runner` reference (set by `gateway/run.py`; `None` if the API server runs standalone). The runner keeps per-session `TurnState` (`agent`, `started_ts`, `lease`) keyed by *routing key*, not stored session id, so a key→session mapping (including compression rotation) is required. `_active_structured_run_count` already treats `queued`, `running`, `waiting_for_approval` and `stopping` as active. CLI, TUI and Electron turns run in other processes and are not visible in either structure. A separate cross-process registry, `hermes_cli/active_sessions.py` (file + flock, pid liveness, per-entry `metadata`, `updated_at`), records which sessions are *open* in CLI/TUI/gateway surfaces, not whether a turn is running.
- Unread caveat: `session_unread` treats a NULL `last_read_at` as read, so a session never stamped by any client cannot show unread. Opening a session (either client) stamps it. Expect new completions in never-opened sessions to show no unread dot; do not stamp the whole list to "fix" this.
- The desktop reference is `apps/desktop/src/store/session-dot-state.ts` and related state stores. It distinguishes working, background, stalled, needs-input, unread, draft, and idle; its priority is needs-input, working (stalled refines it), background, unread, draft, idle. **Its activity inputs are client-side runtime state, not backend truth:** `$workingSessionIds`/`$attentionSessionIds` derive from each session's `busy`/`needsInput` in the app's own `$sessionStates` cache, fed by the gateway events that Electron instance ingests; only unread (`row.unread`) comes from the backend. Electron therefore cannot see another client's runs either, so "mirror Electron" applies to the *semantics and precedence*, not to a data source Uplink can reuse. It also accounts for delegated subagents and session lineage. Uplink should reuse the semantics, not create a competing definition.
- Relevant backend regression suite: `tests/gateway/test_session_api.py` (exists). Uplink’s existing proxy/integrity tests are `E:/hermes-uplink/tests/test_proxy.py`. No browser-based responsive UI test harness was identified during scoping.

## 3. Known unknowns and implementation guardrails

1. **Activity-source coverage:** settled by §1.1 (B2-lite). Remaining Phase A questions: how a gateway routing key maps to the stored session id (including mid-turn rotation); behaviour when `gateway_runner` is `None`; whether the lease registry can be read read-only from the API server and how foreign leases are distinguished from the gateway's own; how `stalled` is derived for API runs (age of `updated_at`/`last_event` against a threshold); and the effect of a gateway restart (in-memory runs vanish; interrupted runs must not read as idle while a foreign lease exists). Do not claim all-source coverage; the matrix in Phase A is the contract.
2. **Background lineage:** a parent turn may finish while delegated work continues. Associate active children with the durable conversation lineage, following the Electron behavior. A merely open browser/session lease is not evidence of work (it may only be used to downgrade `idle` to `unknown`, §1.1).
3. **Freshness and failure:** define how the client learns that a status snapshot is stale, and choose the transport: default proposal is refresh on focus/visibility plus a low-frequency poll (e.g. 15–30 s, paused when hidden) of the single batched list call, with SSE only if Phase A shows a shared event source. Quantify the battery/data cost against Architecture principle 6. Network loss or a missing status field must produce `unknown/stale`, not idle. Preserve the last known state only with an explicit stale cue.
4. **Read races:** test opening a session while another client writes, completion while the session is visible, and a run finishing while the viewer is disconnected. Only successful content load/visible acknowledgement should advance the shared read watermark.
5. **API compatibility and cost:** prefer additive optional response fields or one batched status projection; avoid one request per sidebar row. Keep existing clients valid and avoid exposing private agent/run objects.
6. **Touch tradeoff:** validate the More-menu grouping at 320px and larger mobile widths. Do not sacrifice the model label or 44px targets to preserve low-frequency header buttons.
7. **Cross-repo ownership:** Phase B modifies the Hermes fork (`mr-september/hermes-agent`, upstream NousResearch is read-only), not Uplink. Keep the delta small and conflict-resistant: B1 is a one-line `safe_keys` change; B2 puts its logic in a new fork-owned module (e.g. `gateway/platforms/api_session_status.py`) with at most one-line hooks in upstream-owned files, plus a `FORK.md` note. Keep it additive so a failed or deferred backend change leaves Uplink working (client treats absent fields as unsupported, not idle). Upstreaming is optional and later.

## 4. Roadmap and acceptance gates

Milestones are ordered by value and independence; the lettered phases keep their earlier meaning. Concrete tasks, files and rollback are in §8.

### Milestone 1 — Phase C: mobile header and composer (Uplink only)

Implement the mobile-only two-row header, model chip formatting, More menu, centered settings/icon buttons, non-shrinking connection dot, accessible names, and touch targets. Correct the coarse-pointer composer hint without changing the existing mobile Enter/newline behavior. Preserve the desktop header and existing safe-area handling.

**Exit gate:** no clipped controls or horizontal overflow at 320/360/390px and in phone landscape (~844×390) with the keyboard open; long session/model names remain understandable; status dot stays visibly 7px; desktop layout is unchanged; all icon controls have accessible names; proxy pins recomputed and proxy tests green.

### Milestone 2 — Phase B1 + D1: unread end-to-end

Backend (B1): add the already-computed `unread` boolean to `_session_response()`; test that list and single-session responses carry it and that `PATCH unread` round-trips. Client (D1): render completed-unread per row (green, non-color label), the drawer-button aggregate dot for other sessions, read-marking per §1.3 (after successful history load, on completion while visible, rate-limited, local write guard), and `is_internal_child` handling.

**Exit gate:** a completion in another client shows unread in Uplink; opening it in Uplink clears it in Electron; a stale list page cannot flip a just-read session; absent `unread` field (old backend) renders nothing, not an error; delegate children do not appear as ordinary rows.

### Milestone 3 — Phase A-lite: short spike (can run alongside Milestone 1)

Answer the §3.1 questions with code reading plus a throwaway script or test against a running gateway. Output: a one-page source-coverage matrix (what is authoritative, what is `unknown`, how restart/standalone/rotation behave), the exact field names, and the freshness rule.

**Exit gate:** the matrix and contract are written into this spec; negative control agreed (missing/stale status never renders idle).

### Milestone 4 — Phase B2-lite: activity projection in Hermes

Add `activity_state` and `status_updated_at` per listed session, computed in one batched pass over `_run_statuses` plus the gateway runner's turn state (and the foreign-lease check for the `idle`→`unknown` downgrade). Needs-input comes from `waiting_for_approval` and pending clarify. Advertise via `/v1/capabilities`. Never expose agent or run objects.

**Exit gate:** tests cover start → working, completion → idle + unread, approval/clarify → needs_input, `stopping` → working, background/delegated continuation (if Phase A shows it is observable, otherwise documented as unknown), foreign lease → unknown, standalone API server (no runner) → API runs only, rotation/lineage, restart; existing `tests/gateway/test_session_api.py` green; list latency measured with 200 rows.

### Milestone 5 — Phase D2: working indicators and final verification

Render working / stalled / background / needs-input / unknown / stale states per §1.2 using a static compact treatment: accent for working (with a subtle row-edge activity cue), green for completed-unread, amber for needs-input, quiet neutral for unknown and an explicit stale cue for stale. Non-color labels; animation disabled under `prefers-reduced-motion`; header state for the active session; add the freshness transport from §3.3.

**Exit gate:** verify state transitions and cross-client behaviour; offline/stale handling; Uplink proxy tests and asset-pin checks; focused Hermes session API tests; narrow mobile viewport in Edge (portrait, landscape, drawer open, keyboard open); no desktop regression or stray artifacts.

## 5. Non-goals

- No local-only “currently streaming” badge presented as authoritative shared status.
- No status-based reordering, notification system, numeric unread counts, or fabricated progress percentages.
- No change to the shared-session model, security boundary, proxy/auth flow, or zero-build client architecture.
- No broad desktop redesign or changes to unrelated session controls.
- No cross-process activity store or CLI/TUI/Electron instrumentation in this change (deferred, Appendix A).

## 6. Review points before implementation

1. **Coverage:** decided: B2-lite (§1.1). Re-open only if Electron/CLI-originated runs turn out to matter more than expected after Milestone 5.
2. **More-menu contents:** default to Capabilities, Copy session ID, Refresh, and Skills/Tools, keeping Sessions/model selection/Send visible. Confirm only if one of those secondary actions should remain directly visible on a 320px screen.
3. **Branching:** decided: everything stays on the user's own forks, nothing is pushed or proposed upstream. Hermes commits go directly on the fork's `larry` branch, following the precedent of earlier Uplink-driven commits there (`feat(api): ...`); Uplink work was reviewed on a feature branch and is merged to `master`.

## 7. Revision log

- **2026-10-20:** adopted B2-lite (coverage table, `idle`→`unknown` foreign-lease rule); resequenced into five independently shippable milestones; implementation started. Retracted a mistaken duplicate-`offlineRetryBtn` claim.
- **2026-10-19:** verified against Hermes `5247b2b`: `unread` is computed but not exposed; `active` is never emitted (the client's "live" badge was dead code and has since been removed); Electron activity is client-local runtime state; added the unread write guard, background precedence, `is_internal_child`, and the B1/B2 split.

## 8. Action plan

| # | Milestone | Repo | Main files | Tests / verification | Rollback |
|---|---|---|---|---|---|
| 1 | Mobile header + composer | Uplink | `index.html`; `proxy.py` pins via `python proxy.py --update-hashes` | `tests/test_proxy.py`; manual 320/360/390 portrait + 844×390 landscape + keyboard open; desktop unchanged | revert commit; re-run `--update-hashes` |
| 2a | Expose `unread` (B1) | Hermes fork | `gateway/platforms/api_server.py` (`safe_keys` + bool coercion) | extend `tests/gateway/test_session_api.py` (list, get, PATCH round-trip, lineage) | revert one-line change; Uplink ignores absent field |
| 2b | Unread UI + read marking (D1) | Uplink | `index.html` (`renderSessions`, `openSession`, drawer button), pins | proxy tests; manual cross-client check with Electron; write-guard race test by hand | revert commit |
| 3 | Source-coverage spike | Hermes (read-only) + spec | `gateway/run.py`, `gateway/session_state.py`, `hermes_cli/active_sessions.py`, `api_server_runs.py` | written matrix added to §2/§3 | n/a |
| 4 | Activity projection (B2-lite) | Hermes fork | new `gateway/platforms/api_session_status.py`; one-line hooks in `api_server.py`; `FORK.md` note | new tests in `tests/gateway/test_session_api.py` (scenarios in Milestone 4 gate); 200-row latency check | disable via capability flag / revert hook; Uplink shows nothing for absent field |
| 5 | Working indicators (D2) + freshness poll | Uplink | `index.html`, pins | transitions, offline/stale, reduced-motion, narrow viewport checks | revert commit |

**Progress (2026-10-24):** Hermes `35a6dd36d7` on `larry`; Uplink `8e00d70` (header) and `4a48c37` (unread) on `master`. Milestone 1 implemented and checked in headless Chromium at 320/390 portrait and 844×390 landscape plus desktop (no overflow, 44px targets on coarse pointers, More menu keyboard/Escape/focus-return, 7px dot). Milestone 2a implemented (`unread` on list/get/patch via new `SessionDB.get_session_unread`; 40/40 `tests/gateway/test_session_api.py` pass in a Linux Python 3.12 venv). Milestone 2b implemented and scripted-tested against a mocked API (unread badge, drawer dot, read-on-open, write guard, rate limit, failed PATCH, absent field, child filtering). Not yet exercised: a real Hermes gateway restart plus live cross-client check with Electron, and a physical phone. Milestones 3-5 not started.

Working rules: each milestone is its own commit (Hermes on a feature branch in the fork); Hermes gateway restart is needed after 2a and 4; do not start 5 before 4's gate passes; Kanban holds task-level execution status, this spec holds the contract.

## Appendix A — Deferred: B2-full (cross-process activity)

Idea: extend `hermes_cli/active_sessions.py` entries (already file-locked, pid-liveness-pruned, with `metadata` and `updated_at`) with turn state written by the CLI, TUI and Electron backend at turn start/end/needs-input plus a slow heartbeat (~30 s) for stalled detection; the API server reads the registry and merges it with `_run_statuses` and gateway state. Crash safety comes from the existing liveness pruning. Open questions to resolve before building: whether `_read_entries` validation tolerates new fields; lock contention and whole-file rewrite cost per update (write only on edges and heartbeat); whether the Electron backend's turns go through the same acquisition path (`tui_gateway/methods_session.py` claims lazily on the first turn); and the merge-conflict cost in `cli.py` and `tui_gateway`, which should be isolated behind a small fork-owned helper. Do not start without a decision that the `unknown` state is a real daily annoyance.
