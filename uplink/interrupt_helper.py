"""Interrupt the running turn of one Hermes session (run inside Hermes's own runtime, not by Uplink's Python).

``uplink.native`` launches this file by path through the interpreter and bootstrap that
``hermes --print-runtime-command`` reports, so ``hermes_cli`` is importable and nothing from Uplink is. It speaks
the gateway owner's protocol the way the classic CLI's ``/stop`` does: attach to the session, then
``session.interrupt`` with the execution generation the owner reports. Killing a ``hermes chat`` client never
stops a turn (the owner keeps running it).

Usage: interrupt_helper.py SESSION_ID    -> prints one JSON line {"ok": bool, "reason": str}; exit 0 when ok.
"""
import asyncio
import contextlib
import json
import sys


async def _interrupt(session_id):
    from hermes_cli import gateway_client
    # outside_restart_wait (0.22.6+) keeps the attach away from an owner in a restart's after-turn wait;
    # 0.22.1-0.22.5 have the same session.resume / session.interrupt protocol without it.
    with getattr(gateway_client, "outside_restart_wait", contextlib.nullcontext)():
        async with gateway_client.connect_gateway() as client:
            snapshot = await client.rpc("session.resume", session_id=session_id)
            await client.rpc("session.interrupt", session_id=session_id,
                             execution_generation=snapshot.get("execution_generation", 0))


def main(argv):
    if len(argv) != 2 or not argv[1]:
        print(json.dumps({"ok": False, "reason": "usage"}))
        return 2
    try:
        asyncio.run(_interrupt(argv[1]))
    except Exception as exc:  # the reason is reported to the proxy; nothing is retried here
        print(json.dumps({"ok": False, "reason": str(exc)[:200] or type(exc).__name__}))
        return 1
    print(json.dumps({"ok": True, "reason": "interrupted"}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
