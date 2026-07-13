"""Small Windows-console helpers shared by the foreground launchers."""

from __future__ import annotations

import os


def enable_console_selection() -> bool:
    """Enable QuickEdit selection when the current process has a console."""
    if os.name != "nt":
        return False
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.GetStdHandle(-10)  # STD_INPUT_HANDLE
        if handle in (0, -1):
            return False
        mode = ctypes.c_uint()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        enable_extended_flags = 0x0080
        enable_quick_edit_mode = 0x0040
        return bool(
            kernel32.SetConsoleMode(
                handle,
                mode.value | enable_extended_flags | enable_quick_edit_mode,
            )
        )
    except (AttributeError, OSError, TypeError, ValueError):
        return False
