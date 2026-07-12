' hermes-uplink autostart — runs the proxy headless (no console window) on login.
' Placed in the Windows Startup folder by "launch.bat install".
' Safety: binds loopback by default; for LAN use set HERMES_BIND=0.0.0.0 in launch.bat / env.

Option Explicit
Dim WShell, FSO, repo, key, pass, port, bind, cmd
Set WShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

repo = WShell.CurrentDirectory
If Not FSO.FileExists(FSO.BuildPath(repo, "proxy.py")) Then
  ' When launched from Startup, CurrentDirectory may be %windir%; resolve our own folder.
  repo = FSO.GetParentFolderName(WScript.ScriptFullName)
End If

Function ReadFile(rel)
  Dim p, s
  p = FSO.BuildPath(repo, rel)
  If FSO.FileExists(p) Then
    Set s = FSO.OpenTextFile(p, 1)
    ReadFile = Trim(s.ReadAll)
    s.Close
  Else
    ReadFile = ""
  End If
End Function

key  = ReadFile(".uplink-key.txt")
pass = ReadFile(".uplink-pass.txt")
port = WShell.ExpandEnvironmentStrings("%HERMES_PORT%")
If port = "%HERMES_PORT%" Or port = "" Then port = "8787"
bind = WShell.ExpandEnvironmentStrings("%HERMES_BIND%")
If bind = "%HERMES_BIND%" Or bind = "" Then bind = "127.0.0.1"

WShell.Environment("PROCESS")("HERMES_API_KEY")   = key
WShell.Environment("PROCESS")("UPLINK_PASSPHRASE")  = pass
WShell.Environment("PROCESS")("HERMES_UPSTREAM")   = "http://127.0.0.1:8642"

cmd = "pythonw.exe proxy.py --host " & bind & " --port " & port
WShell.CurrentDirectory = repo
WShell.Run cmd, 0, False   ' 0 = hidden window
WScript.Quit 0
