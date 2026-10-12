# 受控复现 v2：DPI-unaware 进程调 SetWindowRgn 的坐标语义
# 手法：同一份脚本跑两次，一次用 SetProcessDpiAwarenessContext 打开感知，一次不打开，对比结果。
# 只创建自用窗口，用完销毁，不碰桌宠。
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RgnTest2 {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct WNDCLASSW {
    public uint style; public IntPtr lpfnWndProc; public int cbClsExtra; public int cbWndExtra;
    public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
    public string lpszMenuName; public string lpszClassName;
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate IntPtr WndProcDelegate(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern ushort RegisterClassW(ref WNDCLASSW c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateWindowExW(uint ex, string cls, string txt, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr h, IntPtr r, bool redraw);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr r);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr r, out RECT box);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  // 自己持有委托实例，防止被 GC 回收（踩过一次）
  public static WndProcDelegate KeepWndProc;
}
'@

$makeAware = $args.Count -ge 1 -and $args[0] -eq 'aware'
if ($makeAware) {
  # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
  $ok = $false
  try { $ok = [RgnTest2]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { $ok = $false }
  if (-not $ok) { try { $ok = [RgnTest2]::SetProcessDpiAwarenessContext([IntPtr](-3)) } catch { $ok = $false } }
  Write-Output ("尝试设为 PER_MONITOR_AWARE: " + $ok)
}

$ctx = [RgnTest2]::GetThreadDpiAwarenessContext()
$aw = [RgnTest2]::GetAwarenessFromDpiAwarenessContext($ctx)
$modeName = 'unaware'
if ($makeAware) { $modeName = 'aware' }
Write-Output ("=== 模式: $modeName | DPI_AWARENESS = $aw (0=UNAWARE 2=PER_MONITOR) ===")

# 保持委托引用
$script:keep = [RgnTest2+WndProcDelegate]{
  param([IntPtr]$h, [uint32]$m, [IntPtr]$w, [IntPtr]$l)
  return [RgnTest2]::DefWindowProcW($h, $m, $w, $l)
}
[RgnTest2]::KeepWndProc = $script:keep

$wc = New-Object RgnTest2+WNDCLASSW
$wc.lpfnWndProc = [System.Runtime.InteropServices.Marshal]::GetFunctionPointerForDelegate($script:keep)
$wc.lpszClassName = 'DshRgnProbeWnd2'
$wc.hbrBackground = [IntPtr]6
$null = [RgnTest2]::RegisterClassW([ref]$wc)

# WS_POPUP = 0x80000000（无边框、无标题栏，和桌宠同构）
$WS_POPUP = [uint32]2147483648
$h = [RgnTest2]::CreateWindowExW(0, 'DshRgnProbeWnd2', 'rgn-probe', $WS_POPUP, 300, 300, 400, 400, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
if ($h -eq [IntPtr]::Zero) { throw 'CreateWindowExW 失败' }

$wr = New-Object RgnTest2+RECT
$null = [RgnTest2]::GetWindowRect($h, [ref]$wr)
$cr = New-Object RgnTest2+RECT
$null = [RgnTest2]::GetClientRect($h, [ref]$cr)
Write-Output ("window rect = ({0},{1})-({2},{3}) {4}x{5}" -f $wr.Left,$wr.Top,$wr.Right,$wr.Bottom,($wr.Right-$wr.Left),($wr.Bottom-$wr.Top))
Write-Output ("client rect = ({0},{1})-({2},{3}) {4}x{5}" -f $cr.Left,$cr.Top,$cr.Right,$cr.Bottom,($cr.Right-$cr.Left),($cr.Bottom-$cr.Top))

$reqL = 100; $reqT = 100; $reqR = 200; $reqB = 200
$rgn = [RgnTest2]::CreateRectRgn($reqL, $reqT, $reqR, $reqB)
$sr = [RgnTest2]::SetWindowRgn($h, $rgn, $false)
Write-Output ("SetWindowRgn 返回 = $sr")

$probe = [RgnTest2]::CreateRectRgn(0,0,1,1)
$type = [RgnTest2]::GetWindowRgn($h, $probe)
$box = New-Object RgnTest2+RECT
$null = [RgnTest2]::GetRgnBox($probe, [ref]$box)
[void][RgnTest2]::DeleteObject($probe)

Write-Output ("requested   = ($reqL,$reqT)-($reqR,$reqB)")
Write-Output ("applied     = ({0},{1})-({2},{3}) {4}x{5} regionType={6}" -f $box.Left,$box.Top,$box.Right,$box.Bottom,($box.Right-$box.Left),($box.Bottom-$box.Top),$type)
[void][RgnTest2]::DestroyWindow($h)
