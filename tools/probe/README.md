# 排查探针（tools/probe）

这些是出问题时**实际用得上**的诊断脚本。它们不属于产品代码，但每次调窗口/成型/拖动
都要靠它们取证 —— 所以一起进了仓库，别删。

## 为什么探针自己必须声明 DPI 感知（最重要的一条）

Windows 上 DPI-unaware 的进程**读到的窗口坐标是它自己虚拟化过的逻辑坐标**。
一个 DPI-unaware 的探针会把**完全正确**的区域报成"缩小了 0.667 倍"，
让人以为 `SetWindowRgn` 在缩放坐标 —— 这个幻觉我绕了好几轮才拆掉。

所以这些脚本开头都有：

```powershell
Add-Type -TypeDefinition '... SetProcessDpiAwarenessContext ...'
try { [void][X]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }
```

**改脚本时别删这两行。**

## 各脚本干什么

| 脚本 | 用途 |
| --- | --- |
| `probe-rgn-exact.ps1` | **成型听诊器**：读回 `SetWindowRgn` 设进去的区域，逐行展开，并对关键点做 `PtInRegion`。窗口句柄优先从壳的 `boot.log` 里取（标题扫描可能扫到旧实例） |
| `probe-rgn-cal.ps1` | **标定**：在一个自建窗口上请求已知区域再回读，解出"请求 → 实际"的映射（是否被 DPI 虚拟化） |
| `probe-rgn-cal-aware.ps1` | 同上，但先声明 DPI 感知 —— 用来对照证明开着感知时是 1:1 |
| `probe-rgn-dpi2.ps1` | 同一脚本跑两次（开/不开 DPI 感知）对比 `SetWindowRgn` 语义。保留它是因为这个结论太反直觉，值得能随时复验 |
| `probe-ps-dpi.ps1` | 报告 PowerShell 辅助进程自己的 DPI 感知级别（`DPI_AWARENESS=0` 就是 UNAWARE）+ 它看到的屏幕尺寸 |
| `list-windows.ps1` | 列可见顶层窗口（hwnd / pid / 矩形 / class / 标题）—— 找不到窗口时第一个用它 |
| `probe-cursor.ps1` | 采样全局光标（每 50ms 一次，共 6 秒）。用来区分"光标本身不动"和"拖动代码没用到光标" |

## 跑法（这台机器上没有 pwsh，只有 Windows PowerShell 5.1）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\probe\probe-rgn-exact.ps1
```

直接 `& .\x.ps1` 会被执行策略拦下来（"未对文件进行数字签名"）。

## 另外两个坑

1. **`.ps1` 请保持纯 ASCII**，或至少带 UTF-8 BOM。
   PowerShell 5.1 把**无 BOM 的 UTF-8** 当 ANSI 读，中文会把引号吃掉 → 语法错误。
   写文件的工具常常会丢 BOM，所以最稳是纯 ASCII（需要中文标题就用 `(char)0x9CB8...` 拼）。
2. **ADD-Type 用的是老 C# 编译器**：`try { ... return x } finally { ... }` 这种写法会编译失败，
   老老实实顺序写。
