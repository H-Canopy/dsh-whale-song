$ErrorActionPreference='Stop'
$petRelease=Split-Path -Parent $PSScriptRoot
$petOutputs=Split-Path -Parent $petRelease
$petAppPaths=@('D:\Plugins\dsh-whale-song\desktop\standalone')
$petAppPaths+=@(Get-ChildItem -LiteralPath $petOutputs -Directory | Where-Object {$_.Name -like 'whalesong-*'} | ForEach-Object {Join-Path $_.FullName 'desktop\standalone'})
$petProcesses=Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object {
  $petCommand=$_.CommandLine
  $petCommand -and $petCommand -notmatch '--type=' -and @($petAppPaths | Where-Object {$petCommand.IndexOf($_,[StringComparison]::OrdinalIgnoreCase) -ge 0}).Count -gt 0
}
foreach($petProcess in $petProcesses){Stop-Process -Id $petProcess.ProcessId -ErrorAction SilentlyContinue}
if($petProcesses){Start-Sleep -Milliseconds 900}
$petNode=(Get-Command node -ErrorAction Stop).Source
Start-Process -FilePath $petNode -ArgumentList @(('"'+(Join-Path $PSScriptRoot 'start-next.mjs')+'"')) -WorkingDirectory $petRelease -WindowStyle Hidden
