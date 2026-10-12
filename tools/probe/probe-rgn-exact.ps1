# Desktop-shell "window shaping" stethoscope (READ ONLY).
# Reads back the region set by SetWindowRgn, expands it row by row, and
# point-tests key locations with PtInRegion.
#
# IMPORTANT (a trap that cost us hours): this probe MUST declare DPI awareness
# itself. A DPI-unaware process reads the region in ITS OWN virtualized space
# (coordinates divided by 1.5), so a perfectly correct region gets misreported
# as "shrunk by 0.667x". Keep the SetProcessDpiAwarenessContext call below.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class RgnProbe2 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr r, out RECT box);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr r, int x, int y);
  [DllImport("gdi32.dll")] public static extern int GetRegionData(IntPtr r, int n, IntPtr buf);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  // The window title is CJK; build it from code points so this file stays pure ASCII.
  public static string PetTitle() {
    return "DS " + (char)0x9CB8 + (char)0x9C7C + (char)0x5A18 + (char)0x684C + (char)0x5BA0;
  }
  public static IntPtr FindByTitle(string want) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256);
      if (sb.ToString() == want) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static int RectCount(IntPtr hrgn) {
    int need = GetRegionData(hrgn, 0, IntPtr.Zero);
    if (need <= 0) return 0;
    IntPtr buf = Marshal.AllocHGlobal(need);
    GetRegionData(hrgn, need, buf);
    int count = Marshal.ReadInt32(buf, 8);
    Marshal.FreeHGlobal(buf);
    return count;
  }
}
'@

# Must run before any window metric is taken.
try { [void][RgnProbe2]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }

$hwnd = [IntPtr]::Zero
# Preferred: take the hwnd straight out of the shell's own boot.log. A title scan
# can pick up a STALE window from an older launch (different size) and silently
# measure the wrong thing -- that wasted a round.
$log = Join-Path $env:APPDATA 'ds-whale-girl-pet\boot.log'
if (Test-Path $log) {
  $last = Select-String -Path $log -Pattern 'hwnd":(\d+)' | Select-Object -Last 1
  if ($last) { $hwnd = [IntPtr][int]$last.Matches[0].Groups[1].Value }
}
if ($hwnd -eq [IntPtr]::Zero) { $hwnd = [RgnProbe2]::FindByTitle([RgnProbe2]::PetTitle()) }
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'pet window not found (shell not running?)'; exit 1 }

$rc = New-Object RgnProbe2+RECT
[void][RgnProbe2]::GetWindowRect($hwnd, [ref]$rc)
$W = $rc.Right - $rc.Left
$H = $rc.Bottom - $rc.Top
$dpi = [RgnProbe2]::GetDpiForWindow($hwnd)
Write-Output ("hwnd={0}  window=({1},{2})-({3},{4})  {5}x{6}  dpi={7} scale={8}" -f $hwnd,$rc.Left,$rc.Top,$rc.Right,$rc.Bottom,$W,$H,$dpi,($dpi/96.0))

$hrgn = [RgnProbe2]::CreateRectRgn(0,0,1,1)
$type = [RgnProbe2]::GetWindowRgn($hwnd, $hrgn)
$box = New-Object RgnProbe2+RECT
[void][RgnProbe2]::GetRgnBox($hrgn, [ref]$box)
$n = [RgnProbe2]::RectCount($hrgn)
Write-Output ("region type={0} bbox(local)=({1},{2})-({3},{4}) {5}x{6} rects={7}" -f $type,$box.Left,$box.Top,$box.Right,$box.Bottom,($box.Right-$box.Left),($box.Bottom-$box.Top),$n)
Write-Output ''

Write-Output '=== region coverage by row (local y : x ranges) ==='
for ($y = 0; $y -lt $H; $y += 8) {
  $runs = @(); $inRun = $false; $start = 0
  for ($x = 0; $x -lt $W; $x++) {
    $in = [RgnProbe2]::PtInRegion($hrgn, $x, $y)
    if ($in -and -not $inRun) { $inRun = $true; $start = $x }
    elseif (-not $in -and $inRun) { $inRun = $false; $runs += ("{0}-{1}" -f $start,($x-1)) }
  }
  if ($inRun) { $runs += ("{0}-{1}" -f $start,($W-1)) }
  if ($runs.Count -gt 0) { Write-Output ("y={0,4} : {1}" -f $y, ($runs -join ' ')) }
}

Write-Output ''
Write-Output '=== PtInRegion at key points ==='
Write-Output 'NOTE: the region lives in PHYSICAL pixels. Page/DOM measurements (stage 240x209,'
Write-Output 'toolbar y 561-587, bubble, menu) are in CSS pixels, so they are also probed x1.5.'
Write-Output 'See _staging/measure-geo.mjs for where the CSS numbers come from.'
$S = $dpi / 96.0
function P([string]$n,[int]$x,[int]$y,[switch]$css) {
  $px = $x; $py = $y
  if ($css) { $px = [int][math]::Round($x * $S); $py = [int][math]::Round($y * $S) }
  $tag = if ($css) { 'CSS' } else { 'phys' }
  Write-Output ("{0,-30} {1} ({2,4},{3,5}) inRegion={4}" -f $n,$tag,$px,$py,[RgnProbe2]::PtInRegion($hrgn,$px,$py))
}
Write-Output '-- her body / stage --'
P 'her body center' 292 450 -css
P 'her head'        292 360 -css
P 'her feet'        292 545 -css
P 'stage topleft'   172 344 -css
P 'stage botright'  412 553 -css
Write-Output '-- UI that must stay clickable --'
P 'toolbar chat'    240 574 -css
P 'toolbar dots'    290 574 -css
P 'toolbar min'     340 574 -css
P 'toolbar open'    390 574 -css
P 'bubble'          200 280 -css
P 'menu area'       200 150 -css
Write-Output '-- dead zone (should be OUT so the desktop gets the click) --'
P 'topleft blank'    30  30 -css
P 'midleft blank'    30 300 -css
P 'bottombar left'   30 590 -css
[void][RgnProbe2]::DeleteObject($hrgn)
