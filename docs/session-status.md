# Session status, unread state and the mobile header

How Uplink shows what is happening in your sessions, what it needs from the Hermes gateway, and what is planned. Sections are marked **Implemented** or **Planned**.

## Mobile header (implemented)

The main header adapts to the width of the main pane, not the viewport, because a phone in landscape pins the sidebar and leaves a narrower pane than the viewport suggests.

- **Wide pane:** one row with the session title, model chip, session-ID chip, connection dot, and the Capabilities, Refresh and Skills/Tools buttons.
- **Pane ≤ 600 px:** two rows. The first holds the Sessions button and the session title (up to two lines). The second holds the model chip (name plus a provider/default subline, wrapping only at `- _ . :`), the connection dot, and a **More** menu with Capabilities, Copy session ID, Refresh and Skills / Tools.
- **Short viewport (≤ 480 px high, e.g. landscape phone or open keyboard):** collapses back to one compact row to keep the thread tall.
- **Accessibility:** every icon button has an accessible name. The More menu uses `aria-haspopup` / `aria-expanded`, moves focus in on open, restores it on close, and closes on Escape, outside tap, Tab or resize. Controls are 44×44 px on coarse pointers. The full model and provider stay available in the model picker and the chip's accessible name.
- **Composer:** on coarse pointers Enter inserts a newline and Ctrl+Enter or the send button sends; the placeholder does not advertise Enter-to-send.

## Unread and attention indicators (implemented)

Two kinds of marker appear on session rows, and on the Sessions button as one non-numeric dot when another session has one:

| Marker | Source | Meaning |
|---|---|---|
| `unread` badge | the gateway's session list | activity newer than the shared read watermark, including work done from other clients |
| `question waiting` / `new reply` | the client | a stream in a session you left asked a clarify question, or finished |

Delegate child sessions (`is_internal_child: true`) are hidden from the list.

**Gateway contract.** Session rows carry a boolean `unread`; `PATCH /api/sessions/{id}` with `{"unread": false}` stamps the shared watermark for the whole conversation lineage. A gateway that omits `unread` simply shows no unread badges.

**Read-marking rules.**

- Opening a session marks it read only after its history has loaded successfully.
- The watermark is also written when a visible run completes and on refresh, at most once per 10 s per session for passive triggers, only while the page is visible, and never during an active stream.
- A just-written local value overrides list responses for 10 s, so a stale list page cannot flip a just-read session back to unread. A failed write is rolled back.
- A session never stamped by any client reads as read; a completion in a never-opened session therefore shows no unread badge.

## Activity status (planned)

Not implemented. The design keeps activity and unread as separate facts and never reports a session idle when it cannot know.

**States and precedence** (highest first): needs input, working (a stalled run is shown as working with a distinct cue), background work, completed-unread, idle. Percent progress is never shown.

**Honesty rules.**

- A source that cannot be observed is `unknown`, rendered quietly or not at all. It is never shown as idle.
- A stale snapshot (offline, or older than the freshness window) keeps its last state with an explicit stale cue.
- A missing status field means unsupported, not idle.

**Coverage.** The gateway can report activity only for runs it hosts: API-server runs (including Uplink's) and messaging-gateway turns. CLI, TUI and desktop-app runs are separate processes and report `unknown`; their completion still produces an unread badge.

**Proposed API.** Additive optional fields on session rows: `activity_state` (`idle | working | needs_input | stalled | unknown`) and `status_updated_at`, computed in one batched pass so the sidebar needs no per-row requests, and advertised through `/v1/capabilities`. `needs_input` comes from a pending clarify or an approval wait. Freshness would use the existing refresh on focus/visibility plus, at most, a low-frequency poll (15–30 s) paused while hidden, weighed against the battery and data budget.

## Non-goals

Status-based sorting, push notifications, numeric badges, a cross-process activity store, and any change to the shared-session model, the proxy's auth flow or the zero-build client.
