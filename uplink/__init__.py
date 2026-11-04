"""Hermes Uplink: a loopback proxy and browser client for a Hermes Agent gateway.

Entry points (run from the repository root; the launchers do this):

    python -m uplink.server             the proxy
    python -m uplink.configure [--check] first-run setup: credentials and the Hermes API server
    python -m uplink.funnel [command]   public access through Tailscale Funnel
    python -m uplink.assets --update    re-pin the client's static files after editing web/
"""
