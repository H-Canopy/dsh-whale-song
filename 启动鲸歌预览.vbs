Set petShell = CreateObject("WScript.Shell")
Set petFiles = CreateObject("Scripting.FileSystemObject")
petRoot = petFiles.GetParentFolderName(WScript.ScriptFullName)
petShell.CurrentDirectory = petRoot
petShell.Run "node """ & petRoot & "\tools\start-next.mjs""", 0, False
