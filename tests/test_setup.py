import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import uplink_common  # noqa: E402
import uplink_setup  # noqa: E402


class CredentialTests(unittest.TestCase):
    def test_ensure_credentials_generates_valid_files_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key, passphrase, notes = uplink_common.ensure_credentials(root)
            self.assertRegex(key, uplink_common.KEY_PATTERN.pattern)
            self.assertRegex(passphrase, uplink_common.PASS_PATTERN.pattern)
            self.assertEqual(len(notes), 2)
            self.assertEqual(uplink_common.ensure_credentials(root), (key, passphrase, []))

    def test_weak_passphrase_is_regenerated_but_malformed_key_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / uplink_common.PASS_FILE).write_text("short", encoding="ascii")
            _, passphrase, _ = uplink_common.ensure_credentials(root)
            self.assertNotEqual(passphrase, "short")
            (root / uplink_common.KEY_FILE).write_text("bad key; calc", encoding="ascii")
            with self.assertRaises(uplink_common.SettingsError):
                uplink_common.ensure_credentials(root)

    def test_parse_port_rejects_non_ports(self):
        self.assertEqual(uplink_common.parse_port("8787"), 8787)
        for bad in ("", "0", "65536", "80a", "-1"):
            with self.assertRaises(uplink_common.SettingsError):
                uplink_common.parse_port(bad)


class ConfigureHermesTests(unittest.TestCase):
    KEY = "k" * 32

    def run_configure(self, config_text):
        calls = []

        def fake(hermes, *args, capture=False):
            calls.append(args)
            return subprocess.CompletedProcess([hermes, *args], 0, stdout="", stderr="")

        with mock.patch.object(uplink_setup, "_hermes", fake), \
                mock.patch.object(uplink_setup, "_hermes_config_text", return_value=config_text):
            uplink_setup.configure_hermes("hermes", self.KEY)
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
