"""The browser client in web/: which files are served, their pinned digests, and the CSP built from them.

Code files (.html, .js, .css) are authorized by pinned digest, not by whatever is on disk. After editing one, run

    python -m uplink.assets --update    rewrite web/pinned-hashes.json and index.html's SRI attributes
    python -m uplink.assets --check     exit 1 on drift

as part of the same reviewed change. The server loads every served file once at startup, refuses to start on
drift, and serves only those verified bytes. Text files are hashed and served with LF line endings, so a CRLF
checkout does not break SRI. index.html's script tags carry SRI and their digests go into the CSP; the modules
they import are trusted through 'strict-dynamic' and pinned here.
"""
from __future__ import annotations

import argparse
import base64
import dataclasses
import hashlib
import json
import re
import sys
from pathlib import Path

from .settings import ROOT

WEB = ROOT / "web"
PIN_FILE_NAME = "pinned-hashes.json"
INDEX = "index.html"
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}
TEXT_SUFFIXES = frozenset({".html", ".js", ".css", ".webmanifest", ".svg"})
PINNED_SUFFIXES = frozenset({".html", ".js", ".css"})
SCRIPT_TAG_RE = re.compile(r'<script\b[^>]*?\bsrc="([^"]+)"[^>]*?\bintegrity="sha256-([^"]*)"')
INLINE_SCRIPT_RE = re.compile(r"<script(?![^>]*\bsrc\b)", re.IGNORECASE)


class AssetError(RuntimeError):
    """The client files are missing, unreadable, or do not match their pins."""


@dataclasses.dataclass(frozen=True)
class Asset:
    body: bytes
    content_type: str
    cache_control: str


def _read(path: Path) -> bytes:
    data = path.read_bytes()
    if path.suffix in TEXT_SUFFIXES:
        data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return data


def _digest(data: bytes) -> str:
    return base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")


def load_files(web: Path = WEB) -> dict[str, bytes]:
    """Every servable file under web/, keyed by its URL path relative to the root (``js/main.js``)."""
    try:
        files = {
            path.relative_to(web).as_posix(): _read(path)
            for path in sorted(web.rglob("*"))
            if path.is_file() and path.suffix in CONTENT_TYPES
        }
    except OSError as error:
        raise AssetError(f"cannot read the client files in {web}: {error}") from error
    if INDEX not in files:
        raise AssetError(f"{web / INDEX} is missing")
    return files


def _pinned(files: dict[str, bytes]) -> dict[str, str]:
    return {name: _digest(data) for name, data in files.items() if Path(name).suffix in PINNED_SUFFIXES}


def _read_pins(web: Path) -> dict[str, str]:
    try:
        pins = json.loads((web / PIN_FILE_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise AssetError(f"cannot read {web / PIN_FILE_NAME}: {error}") from error
    if not isinstance(pins, dict):
        raise AssetError(f"{web / PIN_FILE_NAME} must be a JSON object")
    return pins


def drift(web: Path = WEB, files: dict[str, bytes] | None = None) -> list[tuple[str, str, str]]:
    """Every way the files disagree with their pins, as (item, expected, actual); empty when they match."""
    files = load_files(web) if files is None else files
    pins, actual = _read_pins(web), _pinned(files)
    mismatches = [(name, pins.get(name, "(not pinned)"), actual.get(name, "(missing)"))
                  for name in sorted(set(pins) | set(actual)) if pins.get(name) != actual.get(name)]
    html = files.get(INDEX, b"").decode("utf-8")
    for src, declared in SCRIPT_TAG_RE.findall(html):
        if declared != actual.get(src):
            mismatches.append((f"{INDEX} integrity for {src}", actual.get(src, "(missing)"), declared))
    if INLINE_SCRIPT_RE.search(html):
        mismatches.append((f"{INDEX} inline <script>", "none", "present"))
    return mismatches


def update(web: Path = WEB) -> dict[str, str]:
    """Refresh index.html's SRI attributes, then rewrite the pins for every code file."""
    files = load_files(web)

    def with_digest(match: re.Match) -> str:
        src = match.group(1)
        if src not in files:
            return match.group(0)
        whole, start = match.group(0), match.start(0)
        return whole[: match.start(2) - start] + _digest(files[src]) + whole[match.end(2) - start:]

    html = SCRIPT_TAG_RE.sub(with_digest, files[INDEX].decode("utf-8"))
    (web / INDEX).write_text(html, encoding="utf-8", newline="\n")
    pins = _pinned(load_files(web))
    (web / PIN_FILE_NAME).write_text(json.dumps(pins, indent=2) + "\n", encoding="utf-8", newline="\n")
    return pins


def build_csp(script_digests) -> str:
    scripts = " ".join(f"'sha256-{digest}'" for digest in script_digests)
    return (
        "default-src 'none'; "
        f"script-src 'strict-dynamic' {scripts}; "
        "style-src 'self'; "
        "script-src-attr 'none'; style-src-attr 'none'; "
        "img-src 'self'; "
        "connect-src 'self'; "
        "font-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; "
        "base-uri 'none'; "
        "form-action 'self'; frame-ancestors 'none'"
    )


class Site:
    """The verified client, held in memory: ``get(url_path)`` returns an Asset or None."""

    def __init__(self, web: Path = WEB):
        files = load_files(web)
        mismatches = drift(web, files)
        if mismatches:
            item, expected, actual = mismatches[0]
            raise AssetError(f"integrity check failed for {item}: expected sha256-{expected}, got sha256-{actual} "
                             f"(run python -m uplink.assets --update after reviewing the change)")
        self._assets = {
            "/" + name: Asset(data, CONTENT_TYPES[Path(name).suffix], "no-cache" if name == INDEX else "no-store")
            for name, data in files.items()
        }
        self._assets["/"] = self._assets["/" + INDEX]
        html = files[INDEX].decode("utf-8")
        self.csp = build_csp(digest for _, digest in SCRIPT_TAG_RE.findall(html))

    def get(self, url_path: str) -> Asset | None:
        return self._assets.get(url_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m uplink.assets", description="Pin or verify the client files in web/.")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--update", action="store_true", help="rewrite web/pinned-hashes.json and index.html's SRI digests")
    action.add_argument("--check", action="store_true", help="exit 1 if any file differs from its pin")
    args = parser.parse_args(argv)
    try:
        if args.update:
            print(f"[+] Pinned digests updated (web/{PIN_FILE_NAME}, {INDEX} SRI):")
            for name, digest in update().items():
                print(f"    {name}: {digest}")
            return 0
        mismatches = drift()
    except AssetError as error:
        print(f"[!] {error}")
        return 1
    if not mismatches:
        print("[+] All pinned digests match the files.")
        return 0
    print("[!] Pinned digest drift detected:")
    for item, expected, actual in mismatches:
        print(f"    {item}:\n      expected: {expected}\n      actual:   {actual}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
