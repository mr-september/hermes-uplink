#!/usr/bin/env bash
# =====================================================================
#  hermes-uplink  -  launcher / service manager (Linux)
# ---------------------------------------------------------------------
#  Usage:
#    ./launch_local.sh              -> set up, then run the proxy in the foreground
#    ./launch_local.sh install      -> start now and at every login (systemd user service)
#    ./launch_local.sh uninstall    -> stop and remove the service
#    ./launch_local.sh start        -> start the background service now
#    ./launch_local.sh stop         -> stop the background service
#    ./launch_local.sh status       -> is it running?
#
#  Env (optional):
#    HERMES_PORT      port to bind      (default 8787)
#    HERMES_UPSTREAM  API Server URL    (default http://127.0.0.1:8642)
#    HERMES_CLI       hermes launcher   (default: hermes on PATH)
#
#  Setup (credentials, Hermes configuration, gateway restart) lives in
#  uplink_setup.py. "start" and "install" write a systemd user unit that
#  records this shell's PATH and the settings above, because the user
#  service manager does not inherit the login shell's environment.
#  Logs: journalctl --user -u hermes-uplink
# =====================================================================
set -euo pipefail
ROOT=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
cd "$ROOT"

UNIT=hermes-uplink.service
UNIT_FILE=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT
HERMES_PORT=${HERMES_PORT:-8787}
export HERMES_PORT

PYTHON=$(command -v python3 || true)
if [ -z "$PYTHON" ]; then
  echo "[!] Python 3 is not installed or not in your PATH. Please install it to continue." >&2
  exit 1
fi

# systemd unit-file quoting: a double-quoted word with \ and " escaped, % doubled
# (specifiers), and for command lines $ doubled (variable expansion). Path
# settings such as WorkingDirectory= take the raw path: only % is escaped there.
quote_path() { printf '%s' "${1//%/%%}"; }
quote_env() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "${s//%/%%}"; }
quote_cmd() { local s; s=$(quote_env "$1"); printf '%s' "${s//\$/\$\$}"; }

require_systemd() {
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    echo "[!] No systemd user session is available. Run ./launch_local.sh with no argument to keep the proxy in the foreground." >&2
    exit 1
  fi
}

# Full setup only when the credentials are missing or invalid; it restarts the Hermes gateway.
ensure_setup() {
  "$PYTHON" uplink_setup.py --check >/dev/null 2>&1 || "$PYTHON" uplink_setup.py
}

write_unit() {
  mkdir -p "$(dirname "$UNIT_FILE")"
  {
    echo "# Written by $ROOT/launch_local.sh; rerun it with start or install to refresh."
    echo "[Unit]"
    echo "Description=Hermes Uplink local proxy"
    echo "StartLimitIntervalSec=60"
    echo "StartLimitBurst=5"
    echo
    echo "[Service]"
    echo "Type=simple"
    echo "WorkingDirectory=$(quote_path "$ROOT")"
    echo "Environment=$(quote_env "PATH=$PATH")"
    echo "Environment=$(quote_env "HERMES_PORT=$HERMES_PORT")"
    if [ -n "${HERMES_UPSTREAM:-}" ]; then echo "Environment=$(quote_env "HERMES_UPSTREAM=$HERMES_UPSTREAM")"; fi
    if [ -n "${HERMES_CLI:-}" ]; then echo "Environment=$(quote_env "HERMES_CLI=$HERMES_CLI")"; fi
    echo "ExecStartPre=$(quote_cmd "$PYTHON") $(quote_cmd "$ROOT/uplink_setup.py") --check"
    echo "ExecStart=$(quote_cmd "$PYTHON") $(quote_cmd "$ROOT/proxy.py")"
    echo "Restart=on-failure"
    echo "RestartSec=5"
    echo
    echo "[Install]"
    echo "WantedBy=default.target"
  } > "$UNIT_FILE"
  systemctl --user daemon-reload
}

is_active() { systemctl --user is-active --quiet "$UNIT"; }

case "${1:-}" in
  "")
    "$PYTHON" uplink_setup.py
    exec "$PYTHON" proxy.py --port "$HERMES_PORT"
    ;;
  install)
    require_systemd
    ensure_setup
    write_unit
    systemctl --user enable "$UNIT"
    systemctl --user restart "$UNIT"
    echo "[+] Installed and started on http://127.0.0.1:$HERMES_PORT; it starts again at every login."
    if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != "yes" ]; then
      echo "[*] User services stop at logout. To keep the proxy (and a Hermes gateway run as a user service)"
      echo "    running with nobody logged in, including after a reboot, run once: sudo loginctl enable-linger $(id -un)"
    fi
    ;;
  uninstall)
    if [ -f "$UNIT_FILE" ]; then
      systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
      rm -f "$UNIT_FILE"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      echo "[+] Removed auto-start and stopped the service."
    else
      echo "[!] Not installed."
    fi
    ;;
  start)
    require_systemd
    ensure_setup
    write_unit
    systemctl --user start "$UNIT"
    echo "[+] Started in the background on http://127.0.0.1:$HERMES_PORT."
    ;;
  stop)
    if is_active; then
      systemctl --user stop "$UNIT"
      echo "[+] Stopped."
    else
      echo "[!] Not running."
      exit 1
    fi
    ;;
  status)
    if is_active; then
      echo "[+] Running on http://127.0.0.1:$HERMES_PORT"
    else
      echo "[!] Not running (run: ./launch_local.sh start)"
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 [install|uninstall|start|stop|status]" >&2
    exit 2
    ;;
esac
