# Hermes Uplink: Architecture

Uplink is a zero-build browser client plus a loopback-only proxy for [Hermes Agent](https://hermes-agent.nousresearch.com/). The proxy gates access with a passphrase, injects the Hermes API key server-side, and serves the pinned static client. Internet exposure is owned entirely by Tailscale Funnel; nothing in this repository stores tunnel credentials.

Design constraints:

- **No build step.** Plain HTML, CSS, and JS with one vendored dependency (`marked`); Python standard library only (the one exception, `hermes_interrupt.py`, runs inside Hermes's own runtime).
- **Loopback only.** The proxy binds 127.0.0.1; the API key never reaches the browser.
- **Pinned assets.** Served files are authorized by SHA-256 digests; the proxy refuses to start if they drift.
- **Shared sessions.** Sessions live in the Hermes store, so Uplink, CLI, TUI, and cron see the same conversations.
- **Frugal connectivity.** No background polling: refresh on focus/visibility, last-render cache, draft autosave, SSE keepalive.

## Components

```mermaid
flowchart TB
    subgraph WAN["Untrusted network"]
        EDGE["Browser<br/>index.html + app.js + app.css"]
    end
    subgraph HOST["Windows host"]
        TS["Tailscale Funnel<br/>*.ts.net :443 -> 127.0.0.1:8787"]
        PROXY["proxy.py :8787<br/>passphrase gate, static assets,<br/>Bearer injection, SSE relay"]
        CLI["hermes chat --resume … --format stream-json<br/>(turns into non-API sessions)"]
        GW["Hermes gateway<br/>API server :8642 + session owner"]
        STORE[("Shared Hermes session store")]
    end
    EDGE -- "HTTPS, session cookie" --> TS --> PROXY
    EDGE -. "local: http://127.0.0.1:8787" .-> PROXY
    PROXY -- "HTTP + Bearer key" --> GW --> STORE
    PROXY -- "subprocess, JSONL" --> CLI -- "owner protocol" --> GW
```

| Path | Role |
|---|---|
| [proxy.py](proxy.py) | Reverse proxy, auth gate, static server, digest verification |
| [hermes_native.py](hermes_native.py) | Turns into sessions the API server does not own: runs the Hermes CLI and translates its events (see Streaming) |
| [hermes_interrupt.py](hermes_interrupt.py) | Stop for those turns; run by Hermes's interpreter, not Uplink's |
| [internet_access.py](internet_access.py) | Tailscale Funnel lifecycle: status parsing, ownership guard, consent URL handling |
| [uplink_setup.py](uplink_setup.py) | First-run setup: validates settings, creates credentials, and configures and restarts the Hermes gateway |
| [uplink_common.py](uplink_common.py) | Defaults, credential-file handling, and the Windows console helper shared by the above |
| [web/](web/) | The client, served by the proxy: `index.html`, `app.js`, `app.css`, `sw.js`, `manifest.webmanifest`, `vendor/marked.umd.js`, `assets/` |
| [web/pinned-hashes.json](web/pinned-hashes.json) | Pinned SHA-256 digests of every served page, script, and stylesheet (written by `--update-hashes`) |
| [launch_local.bat](launch_local.bat) | Runs setup then the proxy in the foreground; `install` / `start` / `stop` / `status` manage login auto-start |
| [launch_internet.bat](launch_internet.bat) | Wrapper for `internet_access.py` |
| [windows/](windows/) | `autostart.vbs` (headless start at login) and `service.ps1` (PID-checked stop/status) |

`sw.js` exists mainly to make the app installable: it caches only the manifest, itself, and `marked`, never `index.html`, `app.js` or API calls.

The proxy takes the API key and passphrase from the `HERMES_API_KEY` / `UPLINK_PASSPHRASE` environment variables, falling back to the git-ignored `.uplink-key.txt` / `.uplink-pass.txt` that `uplink_setup.py` creates. Credential formats are validated in one place, `uplink_common.py`.

## Authentication and sessions

`/api/*`, `/v1/*`, and `/health` require a session cookie. The browser probes `/api/sessions`; a transport failure shows the offline banner, a `401` shows the passphrase modal.

```mermaid
sequenceDiagram
    participant B as Browser
    participant P as proxy.py
    participant G as Hermes gateway
    B->>P: GET /api/sessions?limit=1
    P-->>B: 401
    B->>P: POST /__auth {"passphrase"}
    P-->>B: 204 + Set-Cookie (HttpOnly, SameSite=Strict, Secure behind HTTPS)
    B->>P: GET /api/sessions (cookie)
    P->>G: GET /api/sessions + Authorization: Bearer key
    G-->>B: 200 (relayed)
```

Passphrase failures are limited to 10 per 60 s per client address (the correct passphrase is never locked out). Sessions last 12 h, at most 256 at a time. At most 32 proxy requests run concurrently (excess get `503`) and 128 connections (excess are dropped).

## Streaming

The client opens `POST /api/sessions/{id}/chat/stream` with `Idempotency-Key` / `X-Client-Turn-ID` set to a per-draft UUID that is kept until the stream is established, so a retried send reuses it. The proxy relays the SSE body unbuffered, closes the connection to delimit it, and writes `: ping` every 15 s of upstream silence to keep cellular NAT mappings alive; the client ignores comment frames.

Frames consumed by `handleFrame` (the gateway is authoritative): `assistant.delta {delta}`, `assistant.commentary {text, already_streamed}`, `assistant.completed {content}`, `tool.started` / `tool.completed` / `tool.failed {tool_name, preview, args}`, `error {message}`, `run.completed`, and the clarify events below. Frames carry `run_id`; Stop aborts the fetch and calls `POST /v1/runs/{run_id}/stop`.

**Sessions the API server does not own.** Hermes gives each conversation one owning surface, and the API server admits turns only into sessions it created (`source` `api_server` or `bot_room`); a send into a session created by the desktop app, CLI, TUI, or a messaging platform is refused with `permission_denied`. The proxy therefore looks up the session's `source` before each send. API-owned sessions stream over REST as above. Every other session's turn runs through the documented CLI interface `hermes chat --resume <id> --oneshot --query-file - --format stream-json`, which submits through the session's owner exactly as the desktop app does; [hermes_native.py](hermes_native.py) translates its JSONL (`text`, `tool_use`, `tool_result`, `result`) into the frames above, so the client cannot tell the paths apart. The interpreter and bootstrap come from `hermes --print-runtime-command`. Killing that CLI only detaches it (the owner keeps running the turn), so these turns get a proxy-issued `run_id` (`uplink-native-…`) and Stop runs [hermes_interrupt.py](hermes_interrupt.py), which sends the owner's `session.interrupt` the way the CLI's `/stop` does. What this path lacks: clarify cards (a one-shot turn's clarify returns "no user available; use your judgment"), and approvals follow `approvals.single_query_mode` (default deny). Set `HERMES_CLI` or `--hermes-cli` when `hermes` is not on the proxy's PATH; without it these sessions stay read-only.

Streams are tracked per session (`streams` map). Leaving a session parks its thread nodes in a detached holder, the stream keeps writing there, and the session row shows "new reply" or "question waiting" until the user returns. `localThread` marks threads holding stream-built content so passive refreshes do not overwrite them.

Clarify (interactive questions) is specified in [docs/clarify-protocol.md](docs/clarify-protocol.md).

## Client state

- **Sidebar:** a drawer below 768 px or in portrait; pinnable at ≥1024 px or ≥768 px landscape (preference in `localStorage`, applied synchronously to avoid layout shift). The main header collapses to two rows plus a More menu by container width.
- **Drafts:** saved per session in `localStorage`; cleared only once a stream is established; reconciled against history so a send that reached the server is not repeated.
- **Last-render cache:** `sessionRenderCache` per session; a failed history fetch never blanks an existing thread.
- **Unread:** the session list carries `unread`; opening a session PATCHes `{unread:false}` after history loads. A local write guard (10 s) stops a stale list page from flipping it back. Details and the planned activity status: [docs/session-status.md](docs/session-status.md).

## Security model

| Threat | Control |
|---|---|
| Unauthenticated public ingress | Funnel terminates TLS; proxy passphrase gate with constant-time compare and attempt limiting |
| API key exfiltration | Key stays in the proxy process; the browser holds only an opaque cookie |
| Tampered or injected scripts | Digest-pinned files; CSP `default-src 'none'`, `connect-src 'self'`, `script-src 'strict-dynamic'` with the `app.js` and `marked` digests, `script-src-attr 'none'`; `web/index.html` loads both scripts with matching SRI |
| Path traversal in static serving | Fixed file allowlist plus `vendor/` and `assets/` directories, resolved with `realpath` |
| Host pivoting | Loopback bind only; non-loopback upstreams require `--allow-remote-upstream` and HTTPS |
| Overwriting another Funnel/Serve config | `matching_uplink_route` refuses any other public route on 443; cleanup disables only a verified Uplink route |

Because of the CSP, UI code must not use inline `<script>`, inline `style=""` attributes, or `onclick=""`; use classes and `addEventListener`. CSSOM writes such as `style.setProperty` are allowed.

## Funnel lifecycle

`launch_internet.bat start` calls `internet_access.py start`, which: ensures the local proxy is healthy (starting `launch_local.bat` if not), loads the passphrase, ensures Tailscale is signed in (opening the consent URL it prints), reads `tailscale funnel status --json`, and either accepts the existing Uplink route, fails closed on a foreign route, or runs `tailscale funnel --bg --yes --https=443 http://127.0.0.1:<port>` and re-verifies. `status` and `cleanup` use the same ownership check.

## Operations

After editing anything in `web/` that the proxy pins (`index.html`, `app.js`, `app.css`, `sw.js`, `vendor/marked.umd.js`):

```powershell
python proxy.py --update-hashes   # rewrites web/pinned-hashes.json and web/index.html's SRI digests
python proxy.py --check-hashes    # exit 1 on drift
python -m unittest discover -s tests -v
```

Text assets are hashed and served with LF line endings, so a CRLF checkout does not break SRI. Manual probes:

```powershell
curl -s http://127.0.0.1:8642/health                       # gateway
curl -s -i http://127.0.0.1:8787/api/sessions              # expect 401
powershell -NoProfile -File .\windows\service.ps1 -Action status -Port 8787
python internet_access.py status
```
