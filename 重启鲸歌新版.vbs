Set petShell = CreateObject("WScript.Shell")
Set petFiles = CreateObject("Scripting.FileSystemObject")
petRoot = petFiles.GetParentFolderName(WScript.ScriptFullName)
petShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & petRoot & "\tools\restart-next.ps1""", 0, False
