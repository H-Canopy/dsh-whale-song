# Sample the global cursor position the same way the shell does (GetCursorPos),
# to tell "the cursor's Y is not moving" apart from "our drag math ignores Y".
# Run this, then move the mouse in a big vertical line while it samples.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CurProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
}
'@
# Match the shell: DPI aware, so we read real physical pixels.
try { [void][CurProbe]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }

$samples = @()
$t0 = Get-Date
for ($i = 0; $i -lt 120; $i++) {
  $p = New-Object CurProbe+POINT
  [void][CurProbe]::GetCursorPos([ref]$p)
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  $samples += [pscustomobject]@{ ms = $ms; x = $p.X; y = $p.Y }
  Start-Sleep -Milliseconds 50
}
Write-Output 'ms     x     y    dY   dX'
$prev = $null
foreach ($s in $samples) {
  $dy = if ($prev) { $s.y - $prev.y } else { 0 }
  $dx = if ($prev) { $s.x - $prev.x } else { 0 }
  Write-Output ("{0,5} {1,5} {2,5} {3,4} {4,4}" -f $s.ms, $s.x, $s.y, $dy, $dx)
  $prev = $s
}
$ys = $samples | ForEach-Object { $_.y }
$xs = $samples | ForEach-Object { $_.x }
Write-Output ''
Write-Output ("Y range: {0} .. {1}  (span {2})" -f ($ys | Measure-Object -Minimum).Minimum, ($ys | Measure-Object -Maximum).Maximum, (($ys | Measure-Object -Maximum).Maximum - ($ys | Measure-Object -Minimum).Minimum))
Write-Output ("X range: {0} .. {1}  (span {2})" -f ($xs | Measure-Object -Minimum).Minimum, ($xs | Measure-Object -Maximum).Maximum, (($xs | Measure-Object -Maximum).Maximum - ($xs | Measure-Object -Minimum).Minimum))
