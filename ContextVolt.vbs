'' ContextVolt — Silent Launcher
'' Runs start.bat with no visible console window.
'' Point the desktop/Start Menu shortcut at this file.

Dim shell, appDir
Set shell = CreateObject("WScript.Shell")
appDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "cmd /c """ & appDir & "\start.bat""", 0, False
