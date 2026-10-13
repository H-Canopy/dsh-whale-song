# 桌面版（Windows）· Desktop shell for Windows

> **本 fork 的 Windows 入口已统一**：`main.js` 转发到 `desktop/standalone/main.js`，两种启动路径共用一个实例。请在仓库根目录运行 `npm run desktop:start`，完整现状见 [`../standalone/README.md`](../standalone/README.md)。下面保留上游历史说明。

> **和 macOS 版是同一个东西的两个平台实现**：她本身还是那份 DSH 插件
> （模型、联动、菜单、钱包全在插件里），这里只是一个**透明、无边框、永远置顶**的窗口，
> 加载插件提供的那一页。

---

> ⚠️ **重要：请解压到「纯英文、不含空格」的路径**
>
> 例如 `D:\whalepet\` ✅；`D:\DeepSeek Harness\DS-WhaleGirl-Pet-Windows\` ❌（含空格）、
> `D:\鲸鱼娘桌宠\` ❌（含中文）—— 后两种情况目前在部分机器上会**双击即闪退**
> （退出码 `0x80000003`，Electron 在创建 userData 之前就崩，详见
> [Issue #6](https://github.com/Andersen216/dsh-whale-girl-live2d/issues/6)）。
> 换到纯英文无空格路径即可正常使用（已由报告者实测确认）。


### 启动不了？先双击 `run-with-fallback.cmd`

如果双击 `DS-WhaleGirl-Pet.exe` **没有任何反应**（没窗口、没托盘、没日志），
在同一个文件夹里双击 **`run-with-fallback.cmd`** —— 它会依次用
「常规 → 禁用 GPU → 禁用 GPU+沙箱 → 软件渲染」四种方式重试，
把每次的退出码写进 `%APPDATA%\ds-whale-girl-pet\launcher.log`，
并告诉你哪种能跑起来。**把那个结果发到 issue**，我们就能定位
（已知案例见 [Issue #6](https://github.com/Andersen216/dsh-whale-girl-live2d/issues/6)）。

## 怎么装（三步，不用开命令行）

**① 先装插件**（在 DSH 里，任选一种）

```bash
dsh plugin --profile web add github:Andersen216/dsh-whale-girl-live2d
```

或者更省事：装好下面的客户端后，**第一次打开它就会问你**，点「一键安装插件」即可 ——
它会替你跑上面那条命令（这就是主人要的「下载软件同时把插件装好」）。

**② 下载客户端**

到 [Releases](https://github.com/Andersen216/dsh-whale-girl-live2d/releases) 下
**`DS-WhaleGirl-Pet-Windows.zip`**（约 108 MB）：

- **解压到任意目录**（比如 `D:\DS-WhaleGirl-Pet`）
- **双击里面的 `DS 鲸鱼娘桌宠.exe`** —— 免安装
- 想常驻就右键那个 exe →「发送到」→「桌面快捷方式」；再右键快捷方式 →「固定到开始屏幕」

> 目前的包是**作者在自己的 Mac 上交叉编译**的（用 `--win zip` 绕开 NSIS，因为 Mac 上没有 Windows 打包器）。
> 正式的 NSIS 安装包（`DS-WhaleGirl-Pet-Windows-Setup.exe`）等
> [`.github/workflows/build-windows.yml`](../../.github/workflows/build-windows.yml)
> 在 GitHub 的 Windows 机器上跑起来后会自动产出并挂到 Release。

**③ 重启 DSH，然后双击桌面上的她**

DSH 重启后插件才会挂上；客户端每 5 秒会自动重连，所以**不用重启客户端**，她自己会出来。

> 客户端里如果显示「🐋 正在找 DSH…」，说明插件还没装好或 DSH 没运行 ——
> 那张卡片上直接有「一键安装插件」和「重新连接」两个按钮。

---

## 能干什么

| 功能 | 说明 |
| --- | --- |
| 跟着 agent 动 | 思考/读文件/上网/写代码/报错/收工，她都有反应（和网页版完全一致） |
| **点击穿透** | 鼠标压在她身上才收点击，其它地方直接穿到下面的窗口，**不挡你干活** |
| 拖她 = 拖窗口 | 松手位置会记住；在面板里拖动则交给网页（设置里的滑块照样能拖） |
| **贴边悬浮球** | 点 `–` 收起 → 变成小圆球贴到最近的一侧；拖它可以挪；点一下展开 |
| 托盘菜单 | 右下角托盘图标（🐋）里：重新加载 / 收起 / 展开 / 回到右下角 / **低性能模式** / 一键安装插件 / 彻底退出 |
| **低性能模式** | 不自己找戏、不自言自语，只眨眼 + 轻微摆动 + 视线，点了她才动（笔记本省电用） |
| 一键打开 DSH | 她那排按钮里的 **↗**，直接用默认浏览器打开 DSH 界面 |

---

## 自己编译（不想下载现成的）

Windows 上需要 Node 20+：

```powershell
cd desktop\windows
npm install
npm start          # 本地跑起来看看
npm run dist       # 打包成 NSIS 安装包（产物在 dist\）
```

**作者没有 Windows 机器**，所以正式的 .exe 是 **GitHub Actions 在 windows-latest 上编译**的
（见 [`.github/workflows/build-windows.yml`](../../.github/workflows/build-windows.yml)）：
在 Actions 页面点一次 Run workflow，或者打一个 `v*` tag，就会自动构建并挂到 Release。

---

## 它怎么工作的（以及和 macOS 版的区别）

两端**共用同一套前端协议**，所以 `assets/pet.js` 一行都不用改：

| | macOS 版 | Windows 版（本目录） |
| --- | --- | --- |
| 窗口 | Swift + WKWebView | Electron |
| 前端桥 | `window.webkit.messageHandlers.dshpetshell` | **Electron 的 preload 照着同名补了一个**，前端无感 |
| 点击穿透 | 定时问页面「鼠标下面是 model / panel / none」 | 同样定时问，用 `setIgnoreMouseEvents(forward)` 生效 |
| 本机通行证 | `~/.dsh/dsh-live2d-pet-desktop.json` 写成 cookie | 同一张通行证，写成 Electron 的 cookie |
| 打字 | 需要覆写无边框窗口的 `canBecomeKey` | Electron 默认可聚焦，**没这个坑** |
| 性能陷阱 | 被 App Nap 掐掉 `requestAnimationFrame`（要 `beginActivity`） | Electron 没有 App Nap，但设了 `backgroundThrottling: false` 防止后台降频 |
| 控制入口 | 菜单栏图标 | **系统托盘**图标 |

**一个刻意留的坑位说明**：macOS 版曾经踩过「展开→页面回 shown→又展开」的**无限递归**
（日志涨到 5472 万行、CPU 打满）。Windows 版从第一版起就给每条指令加了**状态守卫**
（已经展开就不再展开、已经收起就不再收起），不留这个隐患。
