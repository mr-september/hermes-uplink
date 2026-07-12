' hermes-uplink autostart — runs the proxy headless (no console window) on login.
' Placed in the Windows Startup folder by "launch.bat install".
' Safety: binds loopback only; remote access must use an HTTPS tunnel.

Option Explicit
Dim WShell, FSO, repo, key, pass, port, cmd
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
    Dim txt
    txt = s.ReadAll
    s.Close
    txt = Replace(txt, vbCr, "")
    txt = Replace(txt, vbLf, "")
    ReadFile = Trim(txt)
  Else
    ReadFile = ""
  End If
End Function

key  = ReadFile(".uplink-key.txt")
pass = ReadFile(".uplink-pass.txt")
If key = "" Or pass = "" Then
  MsgBox "Hermes Uplink credentials are missing. Run launch.bat once in the repository folder.", 48, "Hermes Uplink Error"
  WScript.Quit 1
End If
port = WShell.ExpandEnvironmentStrings("%HERMES_PORT%")
If port = "%HERMES_PORT%" Or port = "" Then port = "8787"

WShell.Environment("PROCESS")("HERMES_API_KEY")   = key
WShell.Environment("PROCESS")("UPLINK_PASSPHRASE")  = pass
WShell.Environment("PROCESS")("HERMES_UPSTREAM")   = "http://127.0.0.1:8642"

cmd = "pythonw.exe ""proxy.py"" --host ""127.0.0.1"" --port " & port
WShell.CurrentDirectory = repo

On Error Resume Next
WShell.Run cmd, 0, False   ' 0 = hidden window
If Err.Number <> 0 Then
  MsgBox "Failed to start Hermes Uplink background service: " & Err.Description & vbCrLf & "Command attempted: " & cmd, 48, "Hermes Uplink Error"
  WScript.Quit 1
End If
On Error GoTo 0

WScript.Quit 0
