# 鲸歌 · 独立桌宠壳（Windows）

> 把 DS 鲸鱼娘放到**桌面上**：透明、置顶、点击穿透、贴边悬浮球。
> **不需要 DSH 在运行** —— 壳自带一个只监听 `127.0.0.1` 的迷你服务（静态资源 + 媒体会话）。

```
dsh-whale-song/
├── desktop/standalone/      ← 这个壳（Electron）
│   ├── main.mjs             窗口/托盘/穿透/贴边球（改自上游 desktop/windows，MIT）
│   ├── server.mjs           本地迷你服务：/dsh-pet/* 静态资源 + 媒体会话（复用 lib/media-bridge.mjs）
│   ├── ui/index.html        壳里的页面（她本体，全透明）
│   └── preload.js           给页面补 macOS 那套桥，让前端一行不用改
├── assets/                  她本体（模型/运行时/前端脚本）
└── lib/media-bridge.mjs     媒体会话桥（与 DSH 宿主**共用同一份**）
```

## 跑起来（开发）

```powershell
cd D:\Plugins\dsh-whale-song\desktop\standalone
pnpm install          # 首次：会下载 Electron（约 100MB）
pnpm start
```

跑起来后：她出现在主屏右下角，**背景全透明**；空白处的鼠标事件会**穿透**到下面的窗口；
托盘图标可以显示/隐藏/退出；工具栏还能「收起成悬浮小球」。

## 打包成安装包

```powershell
pnpm dist             # 产出 DS-WhaleSong-Pet-Windows-Setup.exe（NSIS）
```

⚠️ 没做代码签名：**发出去别人装的时候 Windows SmartScreen 会拦**（"未知发布者"），
要点"更多信息 → 仍要运行"。这是所有小项目发桌面端的通病，绕不过去。

## 独立模式有什么 / 没有什么

| 能力 | 独立壳 | 搭配 DSH（插件版） |
| --- | --- | --- |
| 桌面透明置顶、点击穿透、托盘、贴边球 | ✅ | ✅ |
| 模型渲染 / 物理 / 眨眼 / 视线跟随 | ✅ | ✅ |
| 菜单：表情 · 装饰 · 场景 · 动作 | ✅ | ✅ |
| **知道你在放什么歌 → 换表情/演动作** | ✅（直读 Windows 媒体会话，任何播放器都行） | ✅ |
| 音乐页：列出播放器 · 上下首 · 播放暂停 | ✅ | ✅ |
| 本地音乐（歌单/播放/选文件夹） | ✅ | ✅ |
| 点歌（说"放周杰伦的晴天"） | ❌ | ✅ |
| 跟着 agent 干活（思考/读文件/完成/报错） | ❌ | ✅ |
| 工作简报社（头顶信箱）、内心想法气泡 | ❌ | ✅ |
| 右键钱包（余额/本轮消耗） | ❌ | ✅ |
| 跟她说话（把话送进会话） | ❌ | ✅ |

一句话：**独立壳 = 桌面级的"看脸 + 会跟着音乐动"；搭配 DSH 才是完整版。**

## 它到底怎么脱离 DSH 的（实现要点）

1. **不找宿主，自己当宿主**：迷你服务把前端写死的 `/dsh-pet/*` 补齐 ——
   `pet.js`、`config`、`model/**`、`vendor/**`、`media`、`state`、`events`。
   上游壳里那套"扫端口找 DSH"的逻辑因此**自己就找到了我们的服务**（它探的就是 `/dsh-pet/pet.js`），
   所以窗口/托盘那 600 行**一行没改**。
2. **媒体会话共用实现**：`lib/media-bridge.mjs` 是宿主与壳共用的同一份（命令白名单、
   app 过滤器校验、短缓存、toggle 翻译都在里面），调用的是同一个 `lib/smtc-helper.ps1`。
   两边各写一份必然漂移，所以只留一处。
3. **不要通行证**：DSH 插件的 `/dsh-pet/*` 有过信任栅栏（要 DSH 会话 cookie），
   我们自己的服务只绑 `127.0.0.1`、没有栅栏，所以壳里那段读 token 的逻辑直接短路。
4. **DSH 专属接口就是 404**：`hud` / `say` / `control` / `cancel` 在独立模式下没有，
   前端对这些失败本来就有兜底（安静降级，不报错、不刷屏）。
5. **"打开 DSH"按钮说人话**：独立模式下点了会探一下有没有 DSH 在跑；没有就弹一个说明框
   （告诉她完整版要装插件），而不是打开一个错误页。

## 许可与署名（硬义务）

- 代码 **MIT**：上游壳与桌宠 © **Andersen216**；本壳的独立化改造 © **H-Canopy**。
- 角色形象 **CC BY-NC-SA 4.0（非商业）**：© **上善无形**（原作 OC「溟月」）·
  **ZipZipPipe**（女仆鲸鱼娘二次设计）· **氵六青**（Live2D 模型）。
- 本项目完全免费、不商业化。详见仓库根目录 `AUTHORS.md` / `NOTICE.md`。

## 验证

```powershell
# 壳的本地服务（不需要 Electron，纯 Node 就能验）
node tools/test-shell-server.mjs      # 18/18：资源在位 / 媒体会话可读 / 真浏览器渲染出她
# 浏览器版的单机 demo 页
node tools/test-standalone.mjs        # 13/13
# 仓库全量
node tools/test-all.mjs               # 12 组
```

**窗口本身**（透明/置顶/穿透/托盘）只有 Electron 能验 —— 需要先 `pnpm install` 下 Electron 再 `pnpm start`。
本机实测（`pnpm install` 后用 `node_modules/electron/dist/electron.exe .` 启动）：
`boot.log` 记录 `本地服务已起 → petBase=http://127.0.0.1:63675 → 加载本地页面 → 主窗口已创建 → 托盘已创建 → ready-to-show: 窗口即将显示`，
即**完全没连 DSH**。窗口参数另有打桩测试逐条断言（`node tools/test-shell-window.mjs`，19/19）。

### ⚠️ 一个只在 DSH 会话里会踩的坑：`ELECTRON_RUN_AS_NODE=1`

DSH 给子进程注入了 `ELECTRON_RUN_AS_NODE=1`（不是用户级/机器级环境变量）。有它的时候，
Electron 会**退化成纯 Node**：`require('electron')` 返回的是"可执行文件路径"字符串、`app` 是 undefined，
启动直接崩，boot.log 里只有一句 `Cannot read properties of undefined (reading 'whenReady')`。

- **普通用户双击安装包不会有这个问题**（那个变量只存在于 DSH 会话的进程环境里）。
- 但如果你在 DSH 的终端里起壳调试，要先清掉它：
  ```powershell
  Remove-Item Env:\ELECTRON_RUN_AS_NODE
  ```
- 测试脚本已经自动清掉它（见 `tools/test-shell-window.mjs` 里的说明）。
