' hermes-uplink autostart: runs the proxy headless (no console window) at login.
' Started at login by the Startup-folder stub that "launch_local.bat install"
' writes, and directly by "launch_local.bat start".
' The proxy binds loopback only; remote access goes through launch_internet.bat.

Option Explicit
Dim WShell, FSO, rc
Set WShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

' This script lives in <repo>\windows; the proxy and credentials are in <repo>.
WShell.CurrentDirectory = FSO.GetParentFolderName(FSO.GetParentFolderName(WScript.ScriptFullName))

' uplink.configure --check validates HERMES_PORT and the credential files.
On Error Resume Next
rc = WShell.Run("pythonw.exe -m uplink.configure --check", 0, True)   ' 0 = hidden window, True = wait
If Err.Number <> 0 Then
  MsgBox "pythonw.exe was not found in PATH. Install Python or update PATH, then retry.", 48, "Hermes Uplink Error"
  WScript.Quit 1
End If
On Error GoTo 0
If rc <> 0 Then
  MsgBox "Hermes Uplink settings are missing or invalid. Run launch_local.bat once in the repository folder.", 48, "Hermes Uplink Error"
  WScript.Quit 1
End If

WShell.Run "pythonw.exe -m uplink.server", 0, False
