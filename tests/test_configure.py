import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from uplink import configure, settings  # noqa: E402


class CredentialTests(unittest.TestCase):
    def test_ensure_credentials_generates_valid_files_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key, passphrase, notes = settings.ensure_credentials(root)
            self.assertRegex(key, settings.KEY_PATTERN.pattern)
            self.assertRegex(passphrase, settings.PASS_PATTERN.pattern)
            self.assertEqual(len(notes), 2)
            self.assertEqual(settings.ensure_credentials(root), (key, passphrase, []))

    def test_weak_passphrase_is_regenerated_but_malformed_key_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / settings.PASS_FILE).write_text("short", encoding="ascii")
            _, passphrase, _ = settings.ensure_credentials(root)
            self.assertNotEqual(passphrase, "short")
            (root / settings.KEY_FILE).write_text("bad key; calc", encoding="ascii")
            with self.assertRaises(settings.SettingsError):
                settings.ensure_credentials(root)

    @unittest.skipUnless(os.name == "nt", "NTFS ACLs")
    def test_credential_files_are_not_readable_by_other_accounts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings.ensure_credentials(root)
            for name in (settings.KEY_FILE, settings.PASS_FILE):
                acl = subprocess.run(["icacls", str(root / name)], capture_output=True, text=True).stdout
                self.assertNotRegex(acl, r"(?i)BUILTIN\\Users|Authenticated Users|Everyone|\(I\)")

    def test_parse_port_rejects_non_ports(self):
        self.assertEqual(settings.parse_port("8787"), 8787)
        for bad in ("", "0", "65536", "80a", "-1"):
            with self.assertRaises(settings.SettingsError):
                settings.parse_port(bad)


class ConfigureHermesTests(unittest.TestCase):
    KEY = "k" * 32

    def run_configure(self, config_text):
        calls = []

        def fake(hermes, *args, capture=False):
            calls.append(args)
            return subprocess.CompletedProcess([hermes, *args], 0, stdout="", stderr="")

        with mock.patch.object(configure, "_hermes", fake), \
                mock.patch.object(configure, "_hermes_config_text", return_value=config_text):
            configure.configure_hermes("hermes", self.KEY)
        return calls

    def test_fresh_config_is_enabled_keyed_and_gateway_restarted_with_arg_lists(self):
        self.assertEqual(
            self.run_configure(""),
            [
                ("config", "set", "API_SERVER_ENABLED", "true"),
                ("config", "set", "API_SERVER_KEY", self.KEY),
                ("gateway", "restart"),
            ],
        )

    def test_configured_hermes_is_only_restarted(self):
        for rendering in (f"API_SERVER_KEY: {self.KEY}", f"API_SERVER_KEY: '{self.KEY}'"):
            self.assertEqual(
                self.run_configure(f"API_SERVER_ENABLED: true\n{rendering}\n"),
                [("gateway", "restart")],
            )


if __name__ == "__main__":
    unittest.main()
