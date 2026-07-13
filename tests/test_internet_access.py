import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import internet_access


def funnel_payload(target="http://127.0.0.1:8787", hostname="uplink.tailnet.ts.net", allow=True):
    return {
        "TCP": {"443": {"HTTPS": True}},
        "Web": {
            f"{hostname}:443": {
                "Handlers": {"/": {"Proxy": target}},
            }
        },
        "AllowFunnel": {f"{hostname}:443": allow},
    }


class FakeRunner:
    def __init__(self, responses=None):
        self.responses = responses or {}
        self.calls = []

    def __call__(self, args, timeout):
        self.calls.append((list(args), timeout))
        key = tuple(args[1:])
        response = self.responses.get(key)
        if response is None:
            return internet_access.CommandResult(0, "{}", "")
        if callable(response):
            return response(args, timeout)
        return response


class InternetAccessTests(unittest.TestCase):
    def test_find_tailscale_executable_from_path(self):
        self.assertEqual(
            internet_access.find_tailscale_executable(which=lambda name: "C:/Tailscale/tailscale.exe"),
            "C:/Tailscale/tailscale.exe",
        )

    def test_find_tailscale_executable_from_common_install_path(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Tailscale" / "tailscale.exe"
            path.parent.mkdir()
            path.write_bytes(b"test")
            found = internet_access.find_tailscale_executable(
                environ={"ProgramFiles": directory},
                which=lambda _name: None,
            )
            self.assertEqual(found, str(path))

    def test_missing_tailscale_executable_is_reported(self):
        self.assertIsNone(internet_access.find_tailscale_executable(which=lambda _name: None, environ={}))

    def test_parse_valid_funnel_status(self):
        routes = internet_access.parse_funnel_status(funnel_payload())
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0].hostname, "uplink.tailnet.ts.net")
        self.assertEqual(routes[0].public_port, 443)
        self.assertEqual(routes[0].path, "/")
        self.assertTrue(routes[0].allow_funnel)

    def test_parse_nested_service_funnel_status(self):
        payload = {
            "Services": {
                "svc:uplink": funnel_payload(),
            }
        }
        routes = internet_access.parse_funnel_status(payload)
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0].target, "http://127.0.0.1:8787")

    def test_malformed_status_json_is_rejected(self):
        with self.assertRaises(internet_access.InternetAccessError):
            internet_access._parse_json("not-json", "Funnel status")

    def test_tailscale_consent_url_is_extracted(self):
        output = "Please approve Funnel: https://login.tailscale.com/f/funnel?node=abc123."
        self.assertEqual(
            internet_access.extract_tailscale_consent_url(output),
            "https://login.tailscale.com/f/funnel?node=abc123",
        )

    def test_interactive_runner_opens_consent_url_from_command_output(self):
        command = [
            sys.executable,
            "-c",
            "print('approve https://login.tailscale.com/f/funnel?node=test123.')",
        ]
        with patch("internet_access.webbrowser.open", return_value=True) as opener:
            result = internet_access._default_interactive_runner(command, timeout=3)
        self.assertEqual(result.returncode, 0)
        opener.assert_called_once_with(
            "https://login.tailscale.com/f/funnel?node=test123",
            new=2,
            autoraise=True,
        )

    def test_invalid_public_hostname_is_not_accepted(self):
        payload = funnel_payload(hostname="attacker.example.com")
        self.assertEqual(internet_access.parse_funnel_status(payload), [])

    def test_matching_route_requires_expected_target_and_public_permission(self):
        routes = internet_access.parse_funnel_status(funnel_payload())
        route = internet_access.matching_uplink_route(routes, 8787)
        self.assertIsNotNone(route)

        wrong_target = internet_access.parse_funnel_status(funnel_payload("http://127.0.0.1:9999"))
        with self.assertRaises(internet_access.InternetAccessError):
            internet_access.matching_uplink_route(wrong_target, 8787)

        private_route = internet_access.parse_funnel_status(funnel_payload(allow=False))
        with self.assertRaises(internet_access.InternetAccessError):
            internet_access.matching_uplink_route(private_route, 8787)

    def test_multiple_public_routes_are_always_a_conflict(self):
        payload = funnel_payload()
        payload["Web"]["other.tailnet.ts.net:443"] = {
            "Handlers": {"/": {"Proxy": "http://127.0.0.1:9999"}}
        }
        payload["AllowFunnel"]["other.tailnet.ts.net:443"] = True
        routes = internet_access.parse_funnel_status(payload)
        with self.assertRaises(internet_access.InternetAccessError):
            internet_access.matching_uplink_route(routes, 8787)

    def test_existing_matching_route_is_idempotent(self):
        runner = FakeRunner(
            {
                ("funnel", "status", "--json"): internet_access.CommandResult(
                    0, json.dumps(funnel_payload()), ""
                )
            }
        )
        client = internet_access.TailscaleClient("tailscale.exe", runner=runner)
        route = internet_access.ensure_funnel_route(client, 8787)
        self.assertEqual(route.hostname, "uplink.tailnet.ts.net")
        self.assertEqual(len(runner.calls), 1)

    def test_cleanup_requires_owned_route(self):
        matching = internet_access.parse_funnel_status(funnel_payload())
        self.assertEqual(
            internet_access.require_owned_route(matching, 8787).hostname,
            "uplink.tailnet.ts.net",
        )

        unrelated = internet_access.parse_funnel_status(
            funnel_payload("http://127.0.0.1:9999")
        )
        with self.assertRaises(internet_access.InternetAccessError):
            internet_access.require_owned_route(unrelated, 8787)

        with self.assertRaises(internet_access.InternetAccessError):
            internet_access.require_owned_route([], 8787)

    def test_command_construction_uses_argument_arrays(self):
        runner = FakeRunner()
        interactive = FakeRunner()
        client = internet_access.TailscaleClient(
            "tailscale.exe",
            runner=runner,
            interactive_runner=interactive,
        )
        client.enable_funnel(8787)
        client.disable_funnel()
        self.assertEqual(
            [call[0] for call in interactive.calls + runner.calls],
            [
                ["tailscale.exe", "funnel", "--bg", "--yes", "--https=443", "http://127.0.0.1:8787"],
                ["tailscale.exe", "funnel", "--https=443", "off"],
            ],
        )
        self.assertNotIn("test-passphrase", json.dumps(interactive.calls + runner.calls))

    def test_funnel_enable_uses_interactive_runner(self):
        calls = []

        def interactive(args, timeout):
            calls.append((list(args), timeout))
            return internet_access.CommandResult(0, "", "")

        client = internet_access.TailscaleClient(
            "tailscale.exe",
            interactive_runner=interactive,
        )
        client.enable_funnel(8787)
        self.assertEqual(calls[0][0], ["tailscale.exe", "funnel", "--bg", "--yes", "--https=443", "http://127.0.0.1:8787"])

    def test_status_command_requires_valid_json(self):
        runner = FakeRunner(
            {
                ("status", "--json"): internet_access.CommandResult(0, "[]", ""),
            }
        )
        client = internet_access.TailscaleClient("tailscale.exe", runner=runner)
        with self.assertRaises(internet_access.InternetAccessError):
            client.status()

    def test_authentication_requires_running_backend_state(self):
        needs_login = FakeRunner(
            {
                ("status", "--json"): internet_access.CommandResult(
                    0, json.dumps({"BackendState": "NeedsLogin"}), ""
                ),
            }
        )
        client = internet_access.TailscaleClient("tailscale.exe", runner=needs_login)
        self.assertFalse(client.is_authenticated())

        running = FakeRunner(
            {
                ("status", "--json"): internet_access.CommandResult(
                    0, json.dumps({"BackendState": "Running"}), ""
                ),
            }
        )
        client = internet_access.TailscaleClient("tailscale.exe", runner=running)
        self.assertTrue(client.is_authenticated())

    def test_nonzero_tailscale_command_is_reported(self):
        runner = FakeRunner(
            {
                ("status", "--json"): internet_access.CommandResult(1, "", "login required"),
            }
        )
        client = internet_access.TailscaleClient("tailscale.exe", runner=runner)
        with self.assertRaises(internet_access.TailscaleCommandError) as context:
            client.status()
        self.assertIn("login required", str(context.exception))

    def test_local_proxy_start_wait_is_bounded_and_succeeds(self):
        clock = [0.0]
        checks = [False, False, True]
        started = []

        def health(_port):
            return checks.pop(0)

        def sleeper(seconds):
            clock[0] += seconds

        internet_access.ensure_local_proxy(
            8787,
            root=Path(__file__).resolve().parents[1],
            health_check=health,
            process_starter=started.append,
            sleeper=sleeper,
            monotonic=lambda: clock[0],
        )
        self.assertEqual(started, [Path(__file__).resolve().parents[1] / "launch_local.bat"])

    def test_local_proxy_start_wait_fails_with_timeout(self):
        clock = [0.0]

        def sleeper(seconds):
            clock[0] += seconds

        with self.assertRaises(internet_access.InternetAccessError):
            internet_access.ensure_local_proxy(
                8787,
                root=Path(__file__).resolve().parents[1],
                health_check=lambda _port: False,
                process_starter=lambda _path: None,
                sleeper=sleeper,
                monotonic=lambda: clock[0],
            )

    def test_interactive_menu_keeps_running_until_explicit_exit(self):
        choices = iter(["2", "", "4"])
        with patch("builtins.input", side_effect=lambda _prompt: next(choices)):
            with patch.object(internet_access, "show_status", return_value=0) as status:
                self.assertEqual(internet_access._menu(8787), 0)
        status.assert_called_once_with(8787)


if __name__ == "__main__":
    unittest.main()
