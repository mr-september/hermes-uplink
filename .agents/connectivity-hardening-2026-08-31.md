# Completion Report: Degraded Connectivity Hardening

- **Date Executed:** 2026-08-31
- **Commit:** `d136dbe` feat(uplink): harden connectivity — last-render cache, offline banner, idempotency transport
- **Note:** The original `Degraded Connectivity Assessment.md` review document was deleted prior to commit; the assessment content is preserved in commit history under that filename if needed. This completion report is the durable record of what was implemented.

---

## 1. Assessment §6 Recommendations Implementation Status

* **§6.1 Non-Destructive History Catch Handler**
  * *Status:* Implemented
  * *References:* [`index.html:1458-1472`](file:///e:/hermes-uplink/index.html#L1458-L1472)
  * *Details:* Removed `renderThread([])` from `openSession()` catch handler. Existing DOM retained on transport failure; falls back to cached render only if thread is empty.

* **§6.2 Per-Session Last-Render Cache**
  * *Status:* Implemented (Narrowed per-session, no global fallback)
  * *References:* [`index.html:419`](file:///e:/hermes-uplink/index.html#L419), [`index.html:1463-1466`](file:///e:/hermes-uplink/index.html#L1463-L1466), [`index.html:1772`](file:///e:/hermes-uplink/index.html#L1772)
  * *Details:* `sessionRenderCache` Map stores rendered message arrays keyed by session ID. `lastRenderedThread` global variable was removed to prevent cross-session stale state leakage.

* **§6.3 Turn Idempotency (`Idempotency-Key` / Client Turn ID)**
  * *Status:* P1-PARTIAL (Transport plumbing landed; upstream dedup contract TBD with `api_server.py` maintainers)
  * *References:* [`index.html:1548-1567`](file:///e:/hermes-uplink/index.html#L1548-L1567), [`proxy.py:566`](file:///e:/hermes-uplink/proxy.py#L566)
  * *Details:* Emits `Idempotency-Key` & `X-Client-Turn-ID` headers + `client_turn_id` body field; forwarded by `proxy.py`.

* **§6.4 Composer Draft Preservation**
  * *Status:* Implemented
  * *References:* [`index.html:434-443`](file:///e:/hermes-uplink/index.html#L434-L443), [`index.html:1572-1574`](file:///e:/hermes-uplink/index.html#L1572-L1574), [`index.html:1587-1592`](file:///e:/hermes-uplink/index.html#L1587-L1592), [`index.html:2349-2354`](file:///e:/hermes-uplink/index.html#L2349-L2354)
  * *Details:* Autosaves keystrokes to `localStorage`. Draft cleared only upon confirmed stream inception. Failed stream restores text to input box; retry button reloads draft.

* **§6.5 Differentiated Offline Banner vs. Auth Gate**
  * *Status:* Implemented
  * *References:* [`index.html:445-454`](file:///e:/hermes-uplink/index.html#L445-L454), [`index.html:485-492`](file:///e:/hermes-uplink/index.html#L485-L492), [`index.html:550-554`](file:///e:/hermes-uplink/index.html#L550-L554)
  * *Details:* Network transport dropouts surface sticky `#offlineBanner` and schedule probes. Modal `#authModal` reserved strictly for HTTP `401 Unauthorized`.

* **§6.6 SSE Application Keepalive Heartbeats**
  * *Status:* Deferred (P2)
  * *Rationale:* Infrastructure-invasive change requiring coordination with `api_server.py`. Deferred until field reports demonstrate carrier-level NAT dropouts.

* **§6.7 `online`/`offline`/`pagehide` Lifecycle Auto-Recovery**
  * *Status:* Implemented
  * *References:* [`index.html:2357-2374`](file:///e:/hermes-uplink/index.html#L2357-L2374)
  * *Details:* Auto-reconnects and boots upon `online` event; transitions status to bad on `offline`; aborts streams on `pagehide`.

---

## 2. Out-of-Scope Work

* **Added:**
  * Synchronized `ARCHITECTURE.md` (§1, §2, §3, §4, §5) and `README.md` (Features).
  * Added test cases to `tests/test_proxy.py` (`test_idempotency_headers_are_forwarded_upstream`, `test_client_non_destructive_history_and_race_guards`).
* **Deleted / Restored:**
  * `docs/clarify-design-spec.md` — Restored. Deletion staging was an accidental leftover from previous doc hygiene passes.

---

## 3. Deviations & Rationale

* **Deviation 1 (IndexedDB -> Memory Cache):** Replaced IndexedDB recommendation with in-memory `sessionRenderCache` Map to preserve thin-client server-authority model without introducing schema migrations and sync layers.
* **Deviation 2 (Eliminated Global Fallback):** Narrowed §6.2 to strictly use per-session cache entries, eliminating cross-session stale message leakage.
* **Deviation 3 (Conditional Draft Eviction):** Deferred draft clearing from dispatch inception to first chunk confirmation to prevent offline text destruction.

---

## 4. Verification Evidence

* **Pytest Suite:** 36/36 tests passing (`python -m unittest discover -s tests -v` / `pytest tests/ -v`).
* **Hash Integrity:** Pinned SHA-256 asset and CSP hashes match with 0 drift (`python proxy.py --check-hashes`).
