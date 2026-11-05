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

' Pinned interpreter: uv-managed Python 3.14 base (unversioned directory name
' survives uv upgrades). Bare pythonw.exe was a PATH accident -- see the
' comment in launch_local.bat.
Dim PYWEXE
PYWEXE = "C:\Users\Larry\AppData\Roaming\uv\python\cpython-3.14-windows-x86_64-none\pythonw.exe"
If Not FSO.FileExists(PYWEXE) Then
  MsgBox "Pinned Python 3.14 not found at " & PYWEXE & ". Update PYWEXE in this script.", 48, "Hermes Uplink Error"
  WScript.Quit 1
End If

' uplink.configure --check validates HERMES_PORT and the credential files.
On Error Resume Next
rc = WShell.Run("""" & PYWEXE & """ -m uplink.configure --check", 0, True)   ' 0 = hidden window, True = wait
If Err.Number <> 0 Then
  MsgBox "Failed to run " & PYWEXE & ". Update PYWEXE in this script, then retry.", 48, "Hermes Uplink Error"
  WScript.Quit 1
End If
On Error GoTo 0
If rc <> 0 Then
  MsgBox "Hermes Uplink settings are missing or invalid. Run launch_local.bat once in the repository folder.", 48, "Hermes Uplink Error"
  WScript.Quit 1
End If

WShell.Run """" & PYWEXE & """ -m uplink.server", 0, False
