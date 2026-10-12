# 探针：PowerShell 辅助进程的 DPI 感知级别 + 它看到的屏幕尺寸
# 结论用途：SetWindowRgn 的坐标是否被系统当"逻辑像素"再乘一次 DPI 缩放。
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DpiProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowDpiAwarenessContext(IntPtr h);
  [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr dc, int i);
}
'@
$ctx = [DpiProbe]::GetThreadDpiAwarenessContext()
$aw = [DpiProbe]::GetAwarenessFromDpiAwarenessContext($ctx)
Write-Output ("DPI_AWARENESS = $aw   (0=UNAWARE 1=SYSTEM_AWARE 2=PER_MONITOR 3=PER_MONITOR_V2)")
Write-Output ("GetSystemMetrics SM_CXSCREEN=" + [DpiProbe]::GetSystemMetrics(0) + " SM_CYSCREEN=" + [DpiProbe]::GetSystemMetrics(1))
$dc = [DpiProbe]::GetDC([IntPtr]::Zero)
$hz = [DpiProbe]::GetDeviceCaps($dc, 118)
$vt = [DpiProbe]::GetDeviceCaps($dc, 117)
$lp = [DpiProbe]::GetDeviceCaps($dc, 88)
Write-Output ("GetDeviceCaps DESKTOPHORZRES=$hz DESKTOPVERTRES=$vt LOGPIXELSX=$lp")
Write-Output ("→ 若 SM_CXSCREEN 明显小于 DESKTOPHORZRES，说明本进程被系统 DPI 虚拟化（坐标会被再缩放一次）")
