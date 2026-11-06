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

' Interpreter: pythonw.exe beside UPLINK_PYTHON when that is set (see
' launch_local.bat), else pythonw.exe on PATH.
Dim PYWEXE, chosen
PYWEXE = "pythonw.exe"
chosen = WShell.Environment("PROCESS")("UPLINK_PYTHON")
If chosen <> "" Then
  PYWEXE = FSO.BuildPath(FSO.GetParentFolderName(chosen), "pythonw.exe")
  If Not FSO.FileExists(PYWEXE) Then PYWEXE = chosen   ' the window is hidden either way
End If

' uplink.configure --check validates HERMES_PORT and the credential files.
On Error Resume Next
rc = WShell.Run("""" & PYWEXE & """ -m uplink.configure --check", 0, True)   ' 0 = hidden window, True = wait
If Err.Number <> 0 Then
  MsgBox "Could not run " & PYWEXE & ". Install Python, add it to PATH, or set UPLINK_PYTHON, then retry.", 48, "Hermes Uplink Error"
  WScript.Quit 1
End If
On Error GoTo 0
If rc <> 0 Then
  MsgBox "Hermes Uplink settings are missing or invalid. Run launch_local.bat once in the repository folder.", 48, "Hermes Uplink Error"
  WScript.Quit 1
End If

WShell.Run """" & PYWEXE & """ -m uplink.server", 0, False
