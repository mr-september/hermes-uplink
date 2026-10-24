"""Defaults and probe protocol shared by proxy.py and internet_access.py."""

DEFAULT_UPSTREAM = "http://127.0.0.1:8642"
DEFAULT_PORT = 8787
HEALTH_PROBE_HEADER = "X-Hermes-Uplink-Health"
HEALTH_PROBE_VALUE = "1"
