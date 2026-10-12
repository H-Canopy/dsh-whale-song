# ⚠️ 探针自己也要声明 DPI 感知，否则它读到的区域是**逻辑坐标**（会被除以 1.5），
#    会把一个正确的区域误报成"被缩小了 0.667 倍"。（这个坑栽过一次）
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class ProbeDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c); }'
try { [void][ProbeDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }
# 列出所有可见的顶层窗口（找桌宠窗口到底还在不在）
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinList {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> All() {
    var outp = new List<string>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      int pid; GetWindowThreadProcessId(h, out pid);
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      var txt = new StringBuilder(256); GetWindowTextW(h, txt, 256);
      RECT r; GetWindowRect(h, out r);
      int w = r.Right-r.Left, hh = r.Bottom-r.Top;
      if (w < 80 || hh < 40) return true;
      outp.Add(string.Format("hwnd={0} pid={1} rect=({2},{3})-({4},{5}) {6}x{7} cls={8} title={9}",
        h, pid, r.Left, r.Top, r.Right, r.Bottom, w, hh, cls, txt));
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
'@
$all = [WinList]::All()
Write-Output ("visible top-level windows: " + $all.Count)
$all | ForEach-Object { Write-Output $_ }
