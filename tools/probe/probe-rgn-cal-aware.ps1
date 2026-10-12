# 标定：把一组已知矩形区域贴到**桌宠窗口**上，再回读它落到了哪里。
# 输出 期望 → 实测，用来解出真实的坐标变换（缩放 or 平移 or 剪裁）。
# ⚠️ 只是探针：会在桌宠窗口上短暂设置区域，跑完恢复不了原样（成型器 1.5s 内会重新覆盖）。
param()
$ErrorActionPreference = 'Stop'
# —— 模拟新辅助进程：先打开 DPI 感知 ——
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class DpiSet { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c); [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext(); [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c); }'
$aw1 = [DpiSet]::SetProcessDpiAwarenessContext([IntPtr](-4))
if (-not $aw1) { $aw1 = [DpiSet]::SetProcessDpiAwarenessContext([IntPtr](-3)) }
Write-Output ("SetProcessDpiAwarenessContext ok=$aw1  awareness=" + [DpiSet]::GetAwarenessFromDpiAwarenessContext([DpiSet]::GetThreadDpiAwarenessContext()))

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RgnCal {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr r);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr h, IntPtr r, bool redraw);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr r, out RECT box);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
}
'@

# 找到桌宠窗口（标题精确匹配）
$sig = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class FindPet {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public static IntPtr Find(string want) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256);
      if (sb.ToString() == want) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
Add-Type -TypeDefinition $sig
$hwnd = [FindPet]::Find('DS 鲸鱼娘桌宠')
if ($hwnd -eq [IntPtr]::Zero) { Write-Output '没找到桌宠窗口'; exit 1 }

$wr = New-Object RgnCal+RECT
$null = [RgnCal]::GetWindowRect($hwnd, [ref]$wr)
$cr = New-Object RgnCal+RECT
$null = [RgnCal]::GetClientRect($hwnd, [ref]$cr)
$dpi = [RgnCal]::GetDpiForWindow($hwnd)
Write-Output ("hwnd=$hwnd  window=({0},{1})-({2},{3}) {4}x{5}  client={6}x{7}  dpi={8}" -f `
  $wr.Left,$wr.Top,$wr.Right,$wr.Bottom,($wr.Right-$wr.Left),($wr.Bottom-$wr.Top),($cr.Right-$cr.Left),($cr.Bottom-$cr.Top),$dpi)
Write-Output ''

# 逐个试：期望局部矩形 → 回读实测
$tests = @(
  @{ n='A 100x100 @ (0,0)';       l=0;   t=0;   r=100; b=100 },
  @{ n='B 100x100 @ (100,100)';   l=100; t=100; r=200; b=200 },
  @{ n='C 100x100 @ (200,300)';   l=200; t=300; r=300; b=400 },
  @{ n='D 200x150 @ (150,400)';   l=150; t=400; r=350; b=550 }
)
foreach ($t in $tests) {
  $rgn = [RgnCal]::CreateRectRgn($t.l, $t.t, $t.r, $t.b)
  $res = [RgnCal]::SetWindowRgn($hwnd, $rgn, $false)
  $probe = [RgnCal]::CreateRectRgn(0,0,1,1)
  $type = [RgnCal]::GetWindowRgn($hwnd, $probe)
  $box = New-Object RgnCal+RECT
  $null = [RgnCal]::GetRgnBox($probe, [ref]$box)
  [void][RgnCal]::DeleteObject($probe)
  $sw = $box.Right - $box.Left
  $sh = $box.Bottom - $box.Top
  $ex = $t.r - $t.l
  $eh = $t.b - $t.t
  Write-Output ("{0,-22} 期望({1},{2})-({3},{4}) {5}x{6}  →  实测({7},{8})-({9},{10}) {11}x{12}  scale=({13:N2},{14:N2}) dx={15} dy={16} setRet={17} type={18}" -f `
    $t.n, $t.l,$t.t,$t.r,$t.b,$ex,$eh, $box.Left,$box.Top,$box.Right,$box.Bottom,$sw,$sh, ($sw/$ex), ($sh/$eh), ($box.Left-$t.l), ($box.Top-$t.t), $res, $type)
  Start-Sleep -Milliseconds 120
}
