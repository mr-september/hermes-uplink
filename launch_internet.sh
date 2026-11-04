#!/usr/bin/env bash
# =====================================================================
#  hermes-uplink - Tailscale Funnel internet-access launcher (Linux)
#  The provider workflow lives in uplink/funnel.py so it is testable.
#  Usage: ./launch_internet.sh [start|status|cleanup] [--yes]
# =====================================================================
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[!] Python 3 is not installed or not available in PATH." >&2
  exit 1
fi
exec python3 -m uplink.funnel "$@"
