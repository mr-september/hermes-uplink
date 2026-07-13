' hermes-uplink autostart — runs the proxy headless (no console window) on login.
' Placed in the Windows Startup folder by "launch_local.bat install".
' Safety: binds loopback only; remote access must use an HTTPS tunnel.

Option Explicit
 Dim WShell, FSO, repo, key, pass, port, upstream, pythonw, cmd
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

Function Matches(pattern, value)
  Dim re
  Set re = New RegExp
  re.Pattern = pattern
  re.Global = False
  re.IgnoreCase = False
  Matches = re.Test(value)
End Function

Function ValidPort(value)
  Dim number
  If Not Matches("^[0-9]{1,5}$", value) Then
    ValidPort = False
    Exit Function
  End If
  On Error Resume Next
  Err.Clear
  number = CLng(value)
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    ValidPort = False
    Exit Function
  End If
  On Error GoTo 0
  ValidPort = (number >= 1 And number <= 65535)
End Function

Function FindPythonw()
  Dim process, output, lines, line
  FindPythonw = ""
  On Error Resume Next
  Err.Clear
  Set process = WShell.Exec("where.exe pythonw.exe")
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If
  output = Replace(process.StdOut.ReadAll, vbCr, "")
  On Error GoTo 0
  lines = Split(output, vbLf)
  For Each line In lines
    If Trim(line) <> "" Then
      FindPythonw = Trim(line)
      Exit Function
    End If
  Next
End Function

key  = ReadFile(".uplink-key.txt")
pass = ReadFile(".uplink-pass.txt")
If Not Matches("^[A-Za-z0-9_-]{32}$", key) Or Not Matches("^[A-Za-z0-9]{20,}$", pass) Then
  MsgBox "Hermes Uplink credentials are missing or invalid. Run launch_local.bat once in the repository folder.", 48, "Hermes Uplink Error"
  WScript.Quit 1
End If
port = WShell.ExpandEnvironmentStrings("%HERMES_PORT%")
If port = "%HERMES_PORT%" Or port = "" Then port = "8787"
If Not ValidPort(port) Then
  MsgBox "HERMES_PORT must be a decimal TCP port from 1 through 65535.", 48, "Hermes Uplink Error"
  WScript.Quit 1
End If
upstream = WShell.ExpandEnvironmentStrings("%HERMES_UPSTREAM%")
If upstream = "%HERMES_UPSTREAM%" Or upstream = "" Then upstream = "http://127.0.0.1:8642"
pythonw = FindPythonw()
If pythonw = "" Then
  MsgBox "pythonw.exe was not found in PATH. Install Python or update PATH, then retry.", 48, "Hermes Uplink Error"
  WScript.Quit 1
End If

WShell.Environment("PROCESS")("HERMES_API_KEY")   = key
WShell.Environment("PROCESS")("UPLINK_PASSPHRASE")  = pass
WShell.Environment("PROCESS")("HERMES_UPSTREAM")   = upstream

cmd = """" & pythonw & """ ""proxy.py"" --host ""127.0.0.1"" --port " & port
WShell.CurrentDirectory = repo

On Error Resume Next
WShell.Run cmd, 0, False   ' 0 = hidden window
If Err.Number <> 0 Then
  MsgBox "Failed to start Hermes Uplink background service: " & Err.Description & vbCrLf & "Command attempted: " & cmd, 48, "Hermes Uplink Error"
  WScript.Quit 1
End If
On Error GoTo 0

WScript.Quit 0
