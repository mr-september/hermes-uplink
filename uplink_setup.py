"""Prepare the local proxy: validate settings, create credentials, configure the Hermes gateway.

    python uplink_setup.py          full setup (idempotent), then print the connection banner
    python uplink_setup.py --check  validate settings and credentials only; change nothing

Hermes is always invoked with an argument list, never through a shell, so credential
file contents cannot inject commands.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from uplink_common import (
    DEFAULT_PORT,
    KEY_FILE,
    KEY_PATTERN,
    PASS_FILE,
    PASS_PATTERN,
    ROOT,
    SettingsError,
    ensure_credentials,
    parse_port,
    read_credential,
)

ENABLED_PATTERN = re.compile(r"^API_SERVER_ENABLED:[ ]*true", re.MULTILINE)


def _hermes(hermes: str, *args: str, capture: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run([hermes, *args], capture_output=capture, text=True, check=False)


def _hermes_config_text(hermes: str) -> str:
    result = _hermes(hermes, "config", "path", capture=True)
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if result.returncode != 0 or not lines:
        return ""
    try:
        return Path(lines[-1]).read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return ""


def configure_hermes(hermes: str, api_key: str) -> None:
    """Enable the Hermes API server, install the key if absent, and restart the gateway."""
    print("[*] Ensuring Hermes API Server is enabled...")
    config = _hermes_config_text(hermes)
    if not ENABLED_PATTERN.search(config):
        if _hermes(hermes, "config", "set", "API_SERVER_ENABLED", "true").returncode != 0:
            raise SettingsError("Hermes API configuration failed.")
    if f"API_SERVER_KEY: {api_key}" not in config and f"API_SERVER_KEY: '{api_key}'" not in config:
        if _hermes(hermes, "config", "set", "API_SERVER_KEY", api_key).returncode != 0:
            raise SettingsError("Hermes API key configuration failed.")
    print("[*] Ensuring gateway is running (API server lives inside it)...")
    if _hermes(hermes, "gateway", "restart").returncode != 0:
        raise SettingsError("Hermes gateway restart failed. The proxy was not started.")


def check() -> None:
    parse_port(os.environ.get("HERMES_PORT", str(DEFAULT_PORT)))
    if read_credential(KEY_FILE, KEY_PATTERN) is None or read_credential(PASS_FILE, PASS_PATTERN) is None:
        raise SettingsError("Credentials are missing or invalid; run launch_local.bat once.")


def setup() -> None:
    port = parse_port(os.environ.get("HERMES_PORT", str(DEFAULT_PORT)))
    hermes = shutil.which("hermes")
    if hermes is None:
        raise SettingsError("The 'hermes' command-line interface was not found in your PATH.")
    key, passphrase, notes = ensure_credentials(ROOT)
    for note in notes:
        print(f"[*] {note}")
    configure_hermes(hermes, key)
    print()
    print("=" * 60)
    print(" Hermes Uplink ready on this machine.")
    print(f" URL :  http://127.0.0.1:{port} (local browser only)")
    print(f" Pass:  {passphrase}   (type on connect)")
    print(" For phone access:  run launch_internet.bat for an HTTPS URL")
    print("=" * 60)
    print()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="validate only; change nothing")
    args = parser.parse_args(argv)
    try:
        check() if args.check else setup()
    except SettingsError as exc:
        print(f"[!] {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
