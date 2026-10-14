# Register the desktop pet for autostart at login, without a flashing console window.
#
# Why a launcher instead of pointing autostart straight at electron.exe:
#   DSH sessions carry ELECTRON_RUN_AS_NODE=1, and the system environment may keep it too.
#   With that variable set, electron.exe runs in Node mode and the pet silently never appears.
#   The generated start-pet.cmd clears it first.
# ASCII only: PowerShell 5.1 misreads BOM-less UTF-8 Chinese and eats quotes.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$petDir = Join-Path $env:APPDATA 'DS-WhaleSong-Pet'
New-Item -ItemType Directory -Force -Path $petDir | Out-Null
$cmdPath = Join-Path $petDir 'start-pet.cmd'
$vbsPath = Join-Path $petDir 'start-pet-hidden.vbs'

# Electron's node shim is used because it is the only Node guaranteed present next to the app.
$node = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$cmd = @"
@echo off
set ELECTRON_RUN_AS_NODE=
cd /d "$repo"
"$node" "$repo\desktop\standalone"
"@
[System.IO.File]::WriteAllText($cmdPath, $cmd, [System.Text.Encoding]::GetEncoding(936))
Write-Output ("launcher : " + $cmdPath)

$vbs = @"
' Whale Song desktop pet - hidden autostart wrapper (no console flash).
Set sh = CreateObject("WScript.Shell")
sh.Run """$cmdPath""", 0, False
"@
[System.IO.File]::WriteAllText($vbsPath, $vbs, [System.Text.Encoding]::GetEncoding(936))
Write-Output ("hidden   : " + $vbsPath)

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$name = 'DS-WhaleSong-Pet'
New-ItemProperty -Path $runKey -Name $name -Value ('wscript.exe "' + $vbsPath + '"') -PropertyType String -Force | Out-Null
Write-Output ("run entry: " + $name + " = " + (Get-ItemProperty $runKey).$name)
Write-Output ""
Write-Output "The tray menu has a matching checkbox ('autostart'); it reads/writes this same entry."