"""The passphrase gate's state: browser sessions and the failed-attempt limiter."""

import secrets
import time
from threading import Lock

SESSION_TTL = 12 * 60 * 60
MAX_SESSIONS = 256
ATTEMPT_WINDOW = 60
ATTEMPT_LIMIT = 10


class Sessions:
    """Opaque browser-session tokens with an absolute expiry; the oldest is evicted at capacity."""

    def __init__(self, ttl=SESSION_TTL, capacity=MAX_SESSIONS):
        self.ttl, self._capacity = ttl, capacity
        self._lock = Lock()
        self._expiry = {}

    def create(self):
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self._lock:
            for key, expires in list(self._expiry.items()):
                if expires <= now:
                    del self._expiry[key]
            if len(self._expiry) >= self._capacity:
                del self._expiry[min(self._expiry, key=self._expiry.get)]
            self._expiry[token] = now + self.ttl
        return token

    def valid(self, token):
        if not token:
            return False
        with self._lock:
            expires = self._expiry.get(token)
            if expires is None:
                return False
            if expires <= time.time():
                del self._expiry[token]
                return False
        return True

    def revoke(self, token):
        if token:
            with self._lock:
                self._expiry.pop(token, None)


class AttemptLimiter:
    """Failed passphrase attempts per client in a fixed window. A correct passphrase is never limited."""

    def __init__(self, window=ATTEMPT_WINDOW, limit=ATTEMPT_LIMIT):
        self._window, self._limit = window, limit
        self._lock = Lock()
        self._attempts = {}   # client -> (window start, failures)

    def record_failure(self, client):
        """Count a failed attempt; return the seconds to wait when the client is over the limit, else 0."""
        now = time.monotonic()
        with self._lock:
            for key, (started, _) in list(self._attempts.items()):
                if now - started >= self._window * 2:
                    del self._attempts[key]
            started, count = self._attempts.get(client, (now, 0))
            if now - started >= self._window:
                started, count = now, 0
            if count >= self._limit:
                return max(1, int(self._window - (now - started)))
            self._attempts[client] = (started, count + 1)
        return 0

    def reset(self, client):
        with self._lock:
            self._attempts.pop(client, None)
