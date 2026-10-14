# Compile a real .exe launcher for the desktop pet (RestartPet.exe) + desktop shortcut.
#
# Why a compiled launcher instead of a .cmd:
#   closing the console also killed the pet, because a cmd-spawned child stays in the
#   console's process tree. A compiled launcher frees the console immediately and spawns
#   the pet fully detached, with no console window at all (and no cmd code-page mojibake).
#
# ASCII only (PS 5.1 misreads BOM-less UTF-8 Chinese and eats quotes).
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$petDir = Join-Path $env:APPDATA 'DS-WhaleSong-Pet'
New-Item -ItemType Directory -Force -Path $petDir | Out-Null
$exePath = Join-Path $petDir 'RestartPet.exe'
$electron = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$appDir = Join-Path $repo 'desktop\standalone'

if (-not (Test-Path $electron)) { throw "electron.exe not found: $electron" }
if (-not (Test-Path $appDir))   { throw "app dir not found: $appDir" }

# Escape a path for a C# string literal (double the backslashes).
function CsStr([string]$s) { '"' + $s.Replace('\', '\\') + '"' }

$csharp = @'
using System;
using System.Diagnostics;
using System.Threading;

public class RestartPet
{
    [STAThread]
    public static int Main(string[] args)
    {
        // 1) Close any running instance. Verified on the reference machine: no other
        //    program uses electron.exe, and the pet is single-instance anyway, so a
        //    second launch would only wake the existing one (never two pets).
        try
        {
            foreach (var p in Process.GetProcessesByName("electron"))
            {
                try { p.Kill(); } catch { }
            }
        }
        catch { }
        // Wait for the user-data lock to be released, otherwise the relaunch can hit
        // "profile in use" and silently do nothing.
        Thread.Sleep(2000);

        // 2) Relaunch fully detached, no console window, so closing a terminal cannot
        //    take the pet with it.
        var psi = new ProcessStartInfo();
        psi.FileName = __ELECTRON__;
        psi.Arguments = __APPDIR_Q__;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WorkingDirectory = __REPO__;

        // DSH sessions export ELECTRON_RUN_AS_NODE=1; if it leaks into the child,
        // electron.exe runs in Node mode and the pet never appears (silent failure).
        try { psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE"); } catch { }

        try
        {
            var child = Process.Start(psi);
            if (child == null) return 2;
            return 0;
        }
        catch
        {
            return 3;
        }
    }
}
'@

$source = $csharp.Replace('__ELECTRON__', (CsStr $electron))
$source = $source.Replace('__APPDIR_Q__', ('"\"' + $appDir.Replace('\', '\\') + '\""'))
$source = $source.Replace('__REPO__', (CsStr $repo))

Write-Output "compiling -> $exePath"
Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $exePath -OutputType WindowsApplication
Write-Output ("built: " + $exePath + "  (" + (Get-Item $exePath).Length + " bytes)")

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Restart Desktop Pet.lnk'
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = $exePath
$s.WorkingDirectory = $repo
$s.Description = 'Restart the DS Whale Song desktop pet'
$s.IconLocation = "$repo\desktop\windows\build\icon.png"
$s.Save()
Write-Output ("shortcut -> " + $lnk)
