"""Interrupt the running turn of one Hermes session (run inside Hermes's own runtime, not by Uplink's Python).

The proxy launches this through the interpreter and bootstrap that ``hermes --print-runtime-command`` reports
(see hermes_native.helper_command), so ``hermes_cli`` is importable. It speaks the gateway owner's protocol the
way the classic CLI's ``/stop`` does: attach to the session, then ``session.interrupt`` with the execution
generation the owner reports. Killing a ``hermes chat`` client never stops a turn (the owner keeps running it).

Usage: hermes_interrupt.py SESSION_ID    -> prints one JSON line {"ok": bool, "reason": str}; exit 0 when ok.
"""
import asyncio
import json
import sys


async def _interrupt(session_id):
    from hermes_cli.gateway_client import connect_gateway, outside_restart_wait
    with outside_restart_wait():
        async with connect_gateway() as client:
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
