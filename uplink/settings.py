"""Defaults, host paths, credential files, and the console helper shared by the entry points."""

from __future__ import annotations

import base64
import getpass
import os
import re
import secrets
import string
import subprocess
from pathlib import Path

DEFAULT_UPSTREAM = "http://127.0.0.1:8642"
DEFAULT_PORT = 8787
HEALTH_PROBE_HEADER = "X-Hermes-Uplink-Health"
HEALTH_PROBE_VALUE = "1"

# The repository root: credentials, the pid file, the launchers, and web/ live here.
ROOT = Path(__file__).resolve().parent.parent
KEY_FILE = ".uplink-key.txt"
PASS_FILE = ".uplink-pass.txt"
PID_FILE = ROOT / ".uplink.pid"
KEY_PATTERN = re.compile(r"[A-Za-z0-9_-]{32}")
PASS_PATTERN = re.compile(r"[A-Za-z0-9]{20,}")

# Host entry points, also named in user-facing messages: .bat on Windows, .sh on Linux.
LOCAL_LAUNCHER = "launch_local.bat" if os.name == "nt" else "launch_local.sh"
INTERNET_LAUNCHER = "launch_internet.bat" if os.name == "nt" else "launch_internet.sh"


class SettingsError(RuntimeError):
    """A user-actionable configuration problem."""


def parse_port(text: str) -> int:
    if not text.isdigit() or not 1 <= int(text) <= 65535:
        raise SettingsError("The TCP port (HERMES_PORT or --port) must be a decimal number from 1 through 65535.")
    return int(text)


def env_port() -> int:
    return parse_port(os.environ.get("HERMES_PORT", str(DEFAULT_PORT)))


def read_credential(name: str, pattern: re.Pattern, root: Path = ROOT) -> str | None:
    """Return the stripped contents of a credential file, or None if missing or malformed."""
    try:
        value = (root / name).read_text(encoding="ascii").strip()
    except (OSError, UnicodeError):
        return None
    return value if pattern.fullmatch(value) else None


def restrict_to_current_user(path: Path) -> None:
    """Make the file readable and writable by the current user only (NTFS ACL on Windows, mode 0600 elsewhere)."""
    if os.name != "nt":
        path.chmod(0o600)
        return
    result = subprocess.run(
        ["icacls", str(path), "/inheritance:r", "/grant:r", f"{getpass.getuser()}:F"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise SettingsError(f"Could not restrict permissions on {path.name}: {result.stdout.strip() or result.stderr.strip()}")


def ensure_credentials(root: Path = ROOT) -> tuple[str, str, list[str]]:
    """Return (api_key, passphrase, notes), creating or repairing the credential files.

    An existing malformed API key is never replaced silently (it may be configured in
    Hermes already); a missing or weak passphrase is regenerated. Both files are
    restricted to the current user on every call, which also repairs older installs.
    """
    notes: list[str] = []
    key = read_credential(KEY_FILE, KEY_PATTERN, root)
    if key is None:
        if (root / KEY_FILE).exists():
            raise SettingsError(f"{KEY_FILE} has an invalid format; delete it to generate a new key.")
        key = base64.urlsafe_b64encode(secrets.token_bytes(24)).decode("ascii")
        (root / KEY_FILE).write_text(key, encoding="ascii", newline="")
        notes.append("Generated API key.")
    passphrase = read_credential(PASS_FILE, PASS_PATTERN, root)
    if passphrase is None:
        alphabet = string.ascii_letters + string.digits
        passphrase = "".join(secrets.choice(alphabet) for _ in range(24))
        (root / PASS_FILE).write_text(passphrase, encoding="ascii", newline="")
        notes.append("Generated passphrase.")
    for name in (KEY_FILE, PASS_FILE):
        restrict_to_current_user(root / name)
    return key, passphrase, notes


def enable_console_selection() -> bool:
    """Enable QuickEdit selection when the current process has a Windows console."""
    if os.name != "nt":
        return False
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.GetStdHandle(-10)  # STD_INPUT_HANDLE
        if handle in (0, -1):
            return False
        mode = ctypes.c_uint()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        enable_extended_flags = 0x0080
        enable_quick_edit_mode = 0x0040
        return bool(
            kernel32.SetConsoleMode(handle, mode.value | enable_extended_flags | enable_quick_edit_mode)
        )
    except (AttributeError, OSError, TypeError, ValueError):
        return False
