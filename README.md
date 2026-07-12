# Hermes Uplink

A **thin, text-only remote client** for [Hermes Agent](https://hermes-agent.nousresearch.com/).
Use your home desktop's Hermes from any laptop or phone (browser) — with **all your existing
sessions visible and resumable**, full tool/skill access, and no screen-sharing/video bandwidth.

> Design principle: *no agent code, no framework, no build step.* The client is one HTML file.
> All the work is done by Hermes's **first-party API Server** (which runs natively on Windows — no WSL2).
> We only add a ~100-line stdlib proxy so the client is same-origin and the API key never leaves
> your desktop.

> **Scope note:** this repo is intentionally minimal and standalone — it does *not* patch the Hermes
> agent or its Electron UI. If you want tighter integration (e.g. a toggle inside Hermes's own
> settings page), that is an upstream feature for Nous Research, or a personalized fork you can
> build on top of this. We keep uplink decoupled so it survives agent upgrades.

```mermaid
flowchart LR
    subgraph EDGE["Edge device (phone / laptop)"]
        B[Browser<br/>index.html<br/>vanilla JS, no build]
    end
    subgraph DESKTOP["Home desktop (Windows, native, NO WSL2)"]
        P[proxy.py<br/>stdlib HTTP<br/>key injected server-side]
        A[Hermes gateway<br/>API Server :8642]
        R[(Shared session store<br/>%LOCALAPPDATA%\hermes\sessions<br/>desktop / tui / cron / cli)]
    end
    TUN{{Tunnel<br/>Cloudflare (quick / named)}}
    B -- "HTTPS same-origin<br/>(no API key in browser)" --> P
    P -- "Bearer token<br/>(added here)" --> A
    A -- "reads/writes" --> R
    B -. "remote reach" .-> TUN -.-> P
    classDef edge fill:#1f6feb22,stroke:#1f6feb;
    classDef desk fill:#21262d,stroke:#f0a500;
    class B edge;
    class P,A,R desk;
```

## Files

| File | Role |
|------|------|
| `index.html` | The client. Vanilla JS, mobile-responsive, zero dependencies, no build step. |
| `proxy.py`   | Stdlib reverse proxy. Serves `index.html` same-origin and forwards `/api/*` `/v1/*` `/health*` to the Hermes API Server with the Bearer key added **server-side**. |
| `launch.bat` | Windows launcher (enables API Server, sets `HERMES_API_KEY` + `API_SERVER_KEY`, `HERMES_PORT`, `HERMES_UPSTREAM`). |
| `.gitignore` | Excludes `.uplink-key.txt` and `__pycache__`. |

## What works (anchored to the documented API Server contract)

- Lists **all** sessions from the shared session store (CLI, Electron/desktop, Telegram, cron…).
- Resume / continue any session; new chat; full-text search.
- Streaming turns via SSE: `run.started` → `message.started` → `assistant.delta` → `tool.progress`
  (rendered as tool-call cards) → `assistant.completed` → `run.completed`.
- Skills & toolsets discovery via `/v1/skills` and `/v1/toolsets`.
- `/v1/capabilities` is exposed for clients that want to feature-detect.

### Themes / UX parity (reality check)
This client is a **from-scratch minimal UI**, NOT a clone of the native Hermes Electron app.
Consequences:
- It does **not** inherit the desktop app's skins/theme engine. It ships **one dark theme**
  (Hermes-amber accent) with a mobile-responsive 3-pane layout (sessions · chat · skills/tools).
- To get the **real** Hermes Electron UI on an edge device talking to your desktop backend,
  see **"Alternative: official Desktop remote-backend"** below — that path reuses Hermes's own
  rendering and its theme system, but its live chat pane needs a POSIX PTY (WSL2) on the *host*.

## Setup — two steps, then you're done

### Step 1 — Desktop (one time, one click)
Double-click **`launch.bat`**. It enables the Hermes API Server, generates an API key (and writes it to
Hermes's `API_SERVER_KEY` so the proxy key and server key stay in sync) + a one-time **passphrase**,
restarts the gateway, and starts the local proxy on `http://127.0.0.1:8787`.
It prints the **passphrase** — that's the only secret you'll ever type on a phone.

> Want it to start automatically when you log in? Run `launch.bat install` once (no admin needed).
> Then `launch.bat start` / `stop` / `status` / `uninstall` control it.

### Step 2 — Edge device (phone / laptop browser)
1. **Open the URL** (see "How to reach it" below).
2. **Type the passphrase once.** A cookie is saved — you never type it again.
3. **Add to Home Screen** (phone) → a full-screen app icon. Done.

That's it. To use it later, just open the icon/bookmark.

---

### How to reach it from elsewhere

| Where | What to open | Notes |
|-------|--------------|-------|
| Same machine | `http://127.0.0.1:8787` | always works |
| Phone on same WiFi | `http://<desktop-ip>:8787` | needs `set HERMES_BIND=0.0.0.0` before `launch.bat` (exposes port on LAN; passphrase still required) |
| **Over the internet** | a tunnel URL (next section) | recommended for untrusted networks |

#### Internet access — Cloudflare Tunnel (the only remote method)

We use **Cloudflare Tunnel** (`cloudflared`). It opens an *outbound* connection from your desktop to
Cloudflare and gives you a public `https://….trycloudflare.com` URL — no port-forwarding, no static
IP, no router config. You can use it **with or without a free Cloudflare account**:

| | **A. Quick tunnel (no account)** | **B. Named tunnel (free account)** |
|---|---|---|
| Setup | just run `tunnel.bat` | one-time: create tunnel in Cloudflare, run `cloudflared tunnel run <name>` |
| URL | random `*.trycloudflare.com`, **changes every launch** | **stable/permanent** (e.g. `hermes.yourname.trycloudflare.com` or your own domain) |
| Survives restart? | no (new URL each time) | **yes** |
| Passphrase | still required (our proxy gate) | still required, **or** add Cloudflare Access SSO (Google/GitHub login, no passphrase) |
| Best for | "I want to check my agent from the hotel tonight" | a permanent phone bookmark / daily use |

**Path A — unregistered, ephemeral (default, zero signup):**
1. Local proxy running: double-click `launch.bat` (or `launch.bat start`).
2. Run **`tunnel.bat`** — first time it downloads the portable `cloudflared` (~50 MB, one-time), then
   prints a URL like `https://wise-fog-1234.trycloudflare.com`. Open it on your phone, type the
   **passphrase** once. Done. `tunnel.bat` uses `--no-prechecks --protocol http2` so it works even
   where Cloudflare's startup pre-check is flaky (it can falsely report a block on edge port 7844).
   To stop, close the `tunnel.bat` window.

**Path B — registered, durable (free Cloudflare account, stable bookmark):**
1. Sign up free at https://dash.cloudflare.com/ (no payment; a custom domain is *optional*).
2. Install `cloudflared` (already downloaded to `bin\` by `tunnel.bat`), then in a terminal:
   ```bat
   bin\cloudflared.exe login
   bin\cloudflared.exe tunnel create hermes-uplink
   bin\cloudflared.exe tunnel route dns hermes-uplink hermes.yourname.trycloudflare.com
   ```
3. Run it (proxy must be up): `bin\cloudflared.exe tunnel run hermes-uplink` → permanent URL.
   (Optional) Add Cloudflare **Access** (zero-knowledge SSO) so no passphrase is needed:
   https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/tunnel-guide/

**Official docs:** Quick Tunnels https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/do-more-with-tunnels/trycloudflare/
· Install `cloudflared` https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/install-cloudflared/
· Named tunnels + Access SSO https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/tunnel-guide/

> **Troubleshooting — tunnel starts but no URL / "hard_fail" on port 7844:** Cloudflare's *startup*
> connectivity pre-check can falsely report a block on edge port 7844 even when the tunnel works.
> `tunnel.bat` already passes `--no-prechecks` to skip it. If running `cloudflared` manually and you
> see `hard_fail=true` with no URL, add `--no-prechecks`. The local app is unaffected either way.

---

### Multi-device sync (no battery drain)
The shared session store is the single source of truth, so all devices see the same sessions.
The client refreshes **when you actually look at it** (tab/window focus, or opening the app) plus a
manual **↻ button**. No background poller — so it won't drain your phone. Switching laptop→phone
converges within ~1 second of opening the tab.

### Security model (important)
- The proxy requires the **passphrase** before any `/api` or `/v1` call (returns `401` otherwise).
  The passphrase is **separate from the Hermes API key** — the key is injected server-side and
  never reaches the browser. So a tunnel URL alone is useless to an attacker.
- For zero passphrase-to-remember, front the tunnel with **Cloudflare Access SSO** (sign in with
  Google/GitHub) — one-time Cloudflare login + domain.

### Auto-start on login (no elevation)
`launch.bat install` copies `autostart.vbs` into the Windows **Startup** folder (the same mechanism
Hermes's own gateway login item uses) — no admin needed. `start` runs it headless via `pythonw`.
This is intentionally kept out of the Hermes agent/Electron code; uplink stays a focused, standalone
repo (see scope note at top).

## Verification checklist (run before trusting it)

- [ ] `curl http://127.0.0.1:8642/health` → `{"status":"ok"}`
- [ ] `curl http://127.0.0.1:8787/api/sessions` (no key) → **401** (gate works)
- [ ] `curl "http://127.0.0.1:8787/__auth?t=<passphrase>"` → **204 + Set-Cookie**
- [ ] with cookie: `/api/sessions` → **200** + your **desktop/Electron** sessions (shared store)
- [ ] `curl http://127.0.0.1:8787/v1/capabilities` works with **no key** (proxy injects it)
- [ ] Open the URL in a phone browser; type passphrase once; resume an LLM-Isomorph session;
      confirm a tool call executes on the desktop.

## Alternative: official Desktop "remote backend"

Hermes's **first-party Electron app** can attach to a dashboard on another machine
(`Settings → Gateway → Remote gateway` → Remote URL + Sign in). That reuses Hermes's own UI
and theme engine. Caveat: on a **native-Windows host** the dashboard's live `/chat` pane needs a
POSIX PTY (WSL2), so the chat tab would show a "use WSL2" banner — the session *viewer* and config
pages work natively. The dashboard is a different server (`hermes dashboard`, port 9119) than the
API Server (8642) used here; they are complementary, not interchangeable.

## Honest limitations

- Depends on the documented API Server REST/SSE surface (`/api/sessions`, `/v1/skills`,
  `/v1/toolsets`, `/v1/capabilities`). First-party and versioned with the agent, but a major
  breaking change upstream would need a small client tweak.
- `proxy.py` buffers each response (incl. SSE) before relaying — fine interactively; chunked
  passthrough is a later enhancement.
- No file upload (the API Server itself doesn't support non-image uploads); images not surfaced yet.
- Not a fork of hermes-webui; intentionally reimplements nothing of the agent.
- Theme parity with the desktop app is **not** automatic (see Themes note above).

## Why not hermes-webui / Open WebUI?

- **Open WebUI** keeps its *own* session store → your desktop/Electron sessions would be invisible
  on the phone (siloed). Disqualified by the "continue existing sessions" requirement.
- **hermes-webui** (and the `hermes-windows-native` packaging) is a third-party, heavier
  reimplementation that has historically broken on Windows (no tools/skills access) and is
  version-pinned (0.17.0). We avoid it to stay decoupled and minimal.
