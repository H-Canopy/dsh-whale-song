# 更新日志 / Changelog

## 0.5.0 · 第一个正式发布 — 2026-10-13

> 本节全部是 **fork 增量**（H-Canopy）；下一节起为上游日志。
>
> **为什么从 `0.4.7-song.1` 跳到 `0.5.0`**：这一次加的是**架构级**的东西 ——
> 桌宠不再只是"DSH 界面里的一个插件"，而是**能在桌面上独立运行**的完整体。
> 按语义化版本，这种"运行形态变了"该给次版本号。
> （`0.4.x` 是上游的版本线 + 我们的增量后缀；`0.5.0` 起是本 fork 自己的正式版本线。）

### 桌面壳：**不依赖 DSH 也能在桌面上跑**

新增 `desktop/standalone/`（Electron 33 / Windows）：自带一个本机服务，
**直接从仓库读 `assets/pet.js`**，所以 **DSH 没开着她也照常待在桌面上** ——
模型、物理、44 个表情 / 8 个动作的菜单、点她互动全都在；
开着 DSH 时**额外**获得会话联动、钱包、音乐。

- **和上游桌面端的根本区别**：上游 `desktop/windows/main.js` 是去探
  `127.0.0.1:19387 / 3080 / 8080 / 3000`、`fetch /dsh-pet/pet.js`、再
  `win.loadURL(petBase + '/dsh-pet/standalone')` —— 即"加载 DSH 插件提供的那一页"，
  DSH 关掉就没内容。本壳不依赖它（`dshLink` 是可选参数）。
- 透明区域**逐点命中穿透**：`cordis` 侧上报掩码与可交互面板，主进程每 40ms
  用系统光标复算命中，**只在状态真变时**才切 `WS_EX_TRANSPARENT`（值去重）——
  反复无脑切换会让透明窗口疯狂重合成、看起来在闪。
- 默认 `focusable: false`（不抢 DSH 输入焦点），只有输入框临时要键盘。
- 可开关的**自主漫游**（闲置时自己平滑挪个位置），拖动/输入/面板打开时自动暂停。
- 位置按**角色屏幕锚点**记忆（兼容旧的 `[x, y]`），换分辨率 / 拔显示器后夹回可见区。
- 成型器（`window-shape.mjs`）保留作独立诊断，不参与运行时。

### 交互：拖动、点击、收起、缩放

- **拖动改增量法**：页面送相邻两次指针的**差值**，主进程消费差值再更新窗口位置；
  夹取时仍然消费输入，所以贴边回拖立刻响应。旧的"主进程读全局光标反推位置"
  真机上被证明 **x 跟得上、y 会冻住**。
- **只从她本体发起拖动**：命中用掩码逐点判定（可见像素外约 5px 容差），
  面板优先，透明空气既不拖也不挡。
- **点击手势分流**（上游原本的"戳她"一度被拖动门禁吃掉）：无移动的左键松开 → **戳她**；
  **500ms 内**在同一处再点 → 打开并聚焦对话框；移动 ≥4 DIP → 按拖动处理、不触发戳。
- **收起改成窗口内的「🐋 大肥鱼」标签**：旧的"贴边小球"是**第二个窗口**，
  会被放到屏幕外（实测 `(2463,1569)-(2835,2208)`，屏幕只有 2560×1600）→ 点不到 → 回不来，
  后来还渲染成一个越变越大的深色圆盘。**整条删除**，改成同一窗口内收起 + 托盘找回。
- **可放大**：桌面范围 150–280、显示宽度最多 384 DIP（原来只能缩不能放）。
- **修缩放闪帧**：真机复现——每次 `renderer.resize` 后立刻读画布，**可见像素全为 0**，
  要等下一帧才回来。改成 **WebGL 画布按最大允许尺寸一次配置、缩放只改 CSS 显示尺寸**，
  从根上不触发 resize。真实 Electron 连续 24 次交替放大/缩小，每步都有可见像素
  （旧版同序列每步为 0）。
- **输入**：修掉"隐藏 → 原生 `hide` → 页面又发 hidden"的**反馈循环**；
  焦点通知改去重；输入面板关闭时主动释放 DOM 焦点；**保护 IME 中文组合**期间的交互与回车确认。
- 页面快照分开上报**稳定布局 `body`**（用于位置保存与夹取）与**当前视觉 `model`**
  （用于掩码映射），避免戳她时的弹动把窗口带偏。

### 测试与工具：库自洽

- **19 组测试全绿**（`node tools/test-all.mjs`），其中：
  - `独立壳的窗口逻辑` 26 项、`独立壳的窗口成型` 27 项；
  - **`单实例归属与崩溃恢复` 23 项** —— 在**真实 Chromium** 里跑，覆盖隐藏恢复、
    中文输入、点击手势、缩放；
  - 宿主 160 项、DSH 合并与自动重连 12 项。
- **生成器收进仓库** `tools/shell-gen/`（以前只在作者机器的 `_staging/`，
  也就是 clone 下来拿到一堆"改了会被覆盖、却找不到生成器"的生成物）。
  已做幂等性验证：连跑两遍产物逐字节一致。
- **探针收进仓库** `tools/probe/`，含成型听诊器、DPI 标定、光标采样等。
- **交接文档收进仓库** `docs/pet-shell/`。

### 发布材料：从"上游的"改成"本 fork 的"

- **`LICENSE` 补上素材的非商业声明**：原来只有一份纯 MIT、只署 Andersen216，
  而角色形象与模型是 **CC BY-NC-SA 4.0（非商业 + 署名 + 相同方式共享）**。
  别人只读 LICENSE 会合理地以为模型也能商用 —— 那是拿别人的非商业素材再授权，
  责任在发布方。现在分成"代码 MIT / 素材 CC BY-NC-SA 4.0"两段，
  列全 上善无形 / ZipZipPipe / 氵六青 的署名与主页。
- **`tools/publish.mjs` 修到能在 Windows 上跑**：原来有两个 Unix-only 依赖
  （`-o /dev/null`、`sleep`），会报满屏 `curl: (23) … write of N bytes` 再崩在
  `spawnSync sleep ENOENT`；插件名还写死成上游名，导致自检**永远报假红**。
  现在改用 Node 自带 `fetch`，包名/owner 可覆盖，`node tools/publish.mjs --check` **全绿**。
- 投稿条目、发布指南、三份推广文案里的仓库地址、安装命令、作者身份
  **全部改成本 fork**（以前照着做会推到上游仓库）；
  并清掉了几处不实说法（"做了 Mac 桌面版"、"收起成小圆球"、
  指向不存在的网站/安装包的链接）。

### 与上游的关系

- **署名**：`package.json` 的 `author` **保留 Andersen216**（那是上游 MIT 代码的版权署名，
  抹掉才是问题）；本 fork 以 `contributors` 最后一条 + README + LICENSE 出现。
  市场的"发布者"取自**仓库 owner**（H-Canopy），不是这个字段。
- **包名故意不同**（`dsh-whale-song` ≠ `dsh-whale-girl-live2d`）：
  包名 / 安装源 / profile 键名都不同 ⇒ **装一个、卸一个不会影响另一个**。
  ⚠️ 但两者插件 id（`dsh-live2d-pet`）与 `/dsh-pet/*` 路由前缀相同，
  **不建议两个同时启用**（此条为推断，未经实测）。
- 已向上游作者报备：[Issue #12](https://github.com/Andersen216/dsh-whale-girl-live2d/issues/12)。

### 验证与边界

- **真人复测通过**（用户实测）：点她身体有反应、500ms 内再点开对话框、拖动跟手且不误触发戳、
  调大小不闪、中文输入不断字、收起/展开与托盘找回正常。
- 自动测试：**19 组全绿**。
- **未真机验证**（别当成"已支持"）：**100% / 200% 缩放**、**多显示器 / 拔插显示器**。
  几何行为有自动测试覆盖，但没有真机确认。

> ⚠️ 装了/更新了要**重启一次 DSH**（宿主插件只在启动时加载）；只改前端脚本（`assets/`）刷新页面即可。

## 0.4.6-song.2 · 增量 — 2026-10-12

> 本节全部是 **fork 增量**（H-Canopy）；上一节起为上游日志。

### 统一层：不装挂件也能"知道在放什么、并且遥控它"

原来"她知道在放什么"完全依赖挂件（`dsh-whale-widget`）暴露的 `window.dshwMediaNow()`；
没装挂件就一片空白。现在改成读 **Windows 自己的媒体会话表（SMTC）** —— 网易云 / QQ音乐 /
酷狗 / Spotify / foobar2000 / PotPlayer / VLC / 浏览器，只要往外发会话就自动可用。

- **`lib/smtc-helper.ps1` 泛化**（原来只认网易云）：新增 `-App '<过滤器>'` 与 `-List`；
  **不带 `-App` 时行为与以前完全一致**（仍然只认网易云），所以老调用方不会悄悄变宽。
  安全边界写在文件头：过滤器有长度与字符限制，非法正则按"没匹配"处理。
- **新宿主路由 `/dsh-pet/media`**（仅回环，过 `connection.requestRejection` 信任栅栏）：
  `GET ?list=1` 列出全部媒体会话、`GET [?app=]` 读当前曲目、`POST {cmd:'play'|'pause'|'toggle'|'next'|'prev', app?}`
  遥控。命令是白名单（一个字符都不透传），`toggle` 由宿主读一次状态翻成 play/pause；
  读结果有 1.5 秒 / 5 秒的短缓存（一次 SMTC 实测约 500ms，前端 2 秒轮询不能每次都起进程），
  **控制成功后立刻作废读缓存**，失败不进缓存。
- **新前端 `assets/media-smtc.js`**（统一层前端）：轮询上面的路由，选"当前生效播放器"
  （正在播的优先，其次有曲目的），`AppId` 换成人话名字，暴露 `window.dshwSongSMTC`
  （`now()/players()/pick()/control()`）。**默认开、只读**：只有你点音乐页按钮才会发控制命令。
- **媒体桥改成四路回退**：统一层 → 挂件接口 → 挂件宿主路由 `/dsh-whale/netease.json` → 静默。
  设置里可整块关掉（`设置 → 读系统媒体`），关掉后前端**一次请求都不发**。
- **「音乐」页签升级**：列出检测到的播放器，当前生效的高亮（`●`），点一下固定跟随它
  （再点/点"跟随系统"取消），四个遥控按钮作用于当前生效播放器。
- **`sources/netease.mjs`**：把网易云点播从挂件搬成**音源适配器**（搜索 → 官方客户端
  `orpheus://<base64>` 播放，不解码、不碰凭据、不绕会员判定）。以后加 QQ 音乐只是"再插一个文件"。

验证：`test-media-route.mjs` 41/41（另 `--live` 打真机 SMTC 8/8）、`test-media-smtc.mjs` 41/41、
`test-media-bridge.mjs` 24/24、`test-music-pane.mjs` 24/24、`test-prefs.mjs` / `test-spend.mjs` /
`test-sources.mjs` 全通过 —— 一条命令：`node tools/test-all.mjs [--live]`。
真机证据：`-List` 列出 3 个会话（cloudmusic.exe / MSEdge / …）；`-Cmd play` → 状态变 `Playing`
→ `-Cmd pause` → 状态回 `Paused`（曲目与最终状态与操作前一致）。

> ⚠️ 装了本版要**重启 DSH**（宿主插件只在启动时加载）：`/dsh-pet/media` 与 `media-smtc.js`
> 是新加的路由。只改前端脚本（`assets/`）时刷新页面即可。

## 0.4.6 — 2026-10-01

### 宿主识别：不再依赖固定端口，任何人任何端口都能自动对上

之前客户端靠「候选端口列表（19387 / 3080 …）」猜宿主 —— 那只是本机的端口，
别人的 DSH 可能跑在完全不同的端口上，属于"恰巧碰中"。

现在三段式，逐级兜底，**不靠猜**：

1. **插件写下的真实端口**：插件跑在宿主里，能直接读到 `ctx.webServer.port`，写进
   `~/.dsh/dsh-live2d-pet-desktop.json` 的 `port` 字段（老文件缺 port 会自动补写）。
2. **扫描本机所有监听端口**：macOS 用 `lsof -nP -iTCP -sTCP:LISTEN`、Windows 用
   `netstat -ano -p tcp`，**不看进程名、不看固定端口**；逐个探 `/dsh-pet/pet.js`：
   200 就是它，401 说明插件在但票不对（也先进去）。端口没监听会被立刻拒绝，所以扫描很快。
3. **常见端口兜底**：19387 / 3080 / 8080 / 3000（仅在前两步都失败时使用）。

实测：文件里 `port=3080` 时客户端连 3080；两个宿主同时开着时以插件最后写入的为准。
macOS 与 Windows 两端实现同一套顺序。

## 0.4.5 — 2026-10-01

### 明确兼容范围：对齐最新宿主（0.2.0-rc.x）

- README 增加「兼容性」表：**目标版本 DSH 0.2.0-rc.1 / 0.2.0-rc.2**（官方桌面版当前版本）；
  **0.1.x 不支持**（会报 `failed to import` / `did not activate`）
- 依据：宿主插件 API 在 0.1.x → 0.2.x 之间发生过变动（`connection.requestRejection`
  在 0.1.0-rc.3 上不存在、0.1.5-rc.2 上才有）；本插件只依赖 Node 内置模块、无第三方依赖，
  因此加载失败属于宿主 API 不匹配，而非缺依赖
- 对应 GitHub Issue #1（桌面版 0.1.7-rc.2 安装报错）：建议升级宿主后重装

## 0.4.4 — 2026-09-30

> **English summary**: mouse-move stutter on macOS is fixed. Two causes, both in the shell:
> (1) `ignoresMouseEvents` was re-assigned every 90 ms tick, making the window server redo hit
> testing constantly; (2) every tick did a JS round-trip into the page (`elementFromPoint` + per-pixel
> alpha sampling) even though she occupies ~10 % of the window. Now the shell caches her bounds and
> the panel rects once per second and answers the common case locally — measured:
> `探针统计：本地判定 575 次 / 进网页 0 次` in one minute.

### 修：macOS 鼠标一动就卡

两个原因，都在外壳里（前端一行没改）：

1. **`ignoresMouseEvents` 每 90ms 重复赋值** —— 即使值没变也赋，窗口服务器于是不停重算命中测试。
   现在只在真正变化时赋值。
2. **每 90ms 都往网页里问一次「鼠标在不在她身上」** —— 一次 IPC + `elementFromPoint` +
   逐像素 alpha 采样；而她的可见范围只占 560×900 窗口的约 10%，**九成询问是浪费**。
   现在：壳子每秒缓存一次她的范围和面板矩形，之后 90% 的探针**本地纯计算**得出结果。

实测（重启后运行一分钟）：`探针统计：本地判定 575 次 / 进网页 0 次`；
壳子主进程 3.2%、WebContent 4.8% —— 鼠标移动不再触发任何 JS 往返。

（还加了「探针统计」日志，每 60 秒一行，以后再卡可以直接看数字定位。）

补充（同一天）：窗口从 560×900 缩到 **460×700** —— 面板最大 471 高、聊天框 370 宽，
加上她约 200px，留足余量即可。实测（程序模拟鼠标连续移动 6 秒量 WindowServer）：
桌宠在跑 66.4% → 关掉桌宠 78.8%（说明卡顿的主因不在本应用，见 README 排错）；
缩窗后同场景 58.3%。


## 0.4.3 — 2026-09-30

> **English summary**: the macOS shell no longer hard-codes the DSH port. It discovers the host at
> launch (listening ports owned by `DeepSeek` / `node`, probed with the desk token) so it works with
> both the **official DSH desktop app** (Electron, port chosen by the host — 19387 here) and a
> manually started `dsh web`. The plugin itself needed no changes. Verified in the log:
> `找到宿主（票有效）: http://127.0.0.1:19387`.

### 适配官方桌面版（只改 macOS App，插件零改动）

DSH 官方桌面版（`DeepSeek Harness.app` 0.2.0-rc.2，Electron）会自己起一个本地 web 服务，
端口由宿主决定（本机实测 `127.0.0.1:19387`，而手动的 `dsh web` 是 3080）。
外壳原来把 3080 写死了，所以连不上官方桌面版。

现在改成**启动时发现宿主**：

1. `lsof` 列出本机监听端口，挑出 `DeepSeek` / `dsh` / `node` 这些进程占用的端口
2. 逐个探 `HEAD/GET /dsh-pet/pet.js`（带通行证）：`200` 就用它；只有 `401` 时也先进去（票可能过期）
3. 兜底候选：19387（官方桌面版实测端口）、3080、8080、3000
4. ↗ 按钮和诊断页也跟着发现出来的宿主走

实测：日志输出 `找到宿主（票有效）: http://127.0.0.1:19387`，
页面 `DSHPet=yes` —— 官方桌面版下正常。插件侧不需要任何适配（`desktop` profile 里已装好）。

## 0.4.2 — 2026-09-27

> **English summary**: macOS only — the drag "air wall" is gone. AppKit constrains windows to the
> screen by default (so a title bar cannot go above the menu bar); for a borderless pet window that
> clamped the window's top at the visible frame's top. Overriding `constrainFrameRect` makes her
> draggable anywhere, including partially off-screen.

### 修：拖到屏幕中上部就撞上一堵「空气墙」（macOS）

拖动日志是铁证 —— 连拖 5 次，窗口 y 每次都停在 **150**：
`150 + 900（窗口高）= 1050` = 屏幕可用区顶边，一个像素都不差。

原因不在我们的逻辑，而在 AppKit 的默认行为：`NSWindow.constrainFrameRect(_:to:)`
会把窗口约束在屏幕内（防止标题栏顶到菜单栏上方）。桌宠是无边框窗口、本来就该能拖到任意位置，
所以覆写它、原样返回 frame 即可。

现在她可以拖到屏幕任何地方，包括拖到菜单栏那一片、甚至半出屏。

## 0.4.1 — 2026-09-27

> **English summary**: UI colour unified to the whale blue used by the site and the app icon (CSS
> variables only, no layout changes); the desktop shell now decides drag ownership at the moment the
> drag starts (previously a 90 ms-stale hit-test could hand the drag to the page, which can only move
> her inside the window — that felt like an invisible boundary); and the panel-clipping experiments
> were reverted back to the known-good placement code.

### 修 / 改

- **配色统一成鲸鱼蓝**（`#3b62f6`，与官网、App 图标同一套）；只动颜色变量，没碰任何布局代码
- **桌面版拖动不再有"隐形边界"**：拖动的归属改成在**拖动开始那一刻**判定 ——
  之前如果鼠标按下时探针的上一次结果恰好是「面板」，这次拖动就会被交给网页，
  而网页只能在她自己的窗口范围内挪动，于是撞到窗口的边（看着像"拖不出这块区域"）
- **回退面板相关的试验改动**：退回 08098af 的定位代码（主人认可的「只是稍微被截」那版），
  真浏览器自检 99/0

## 0.4.0 — 2026-09-26

> **English summary / 英文摘要**
>
> **New: a macOS desktop shell.** The plugin can now live on your desktop instead of inside a browser tab:
> a native transparent, borderless, always-on-top window with **click-through** (only the pixels she
> actually covers take the mouse), drag-to-move, an **edge-snapping frosted-glass ball** when collapsed,
> a 🐋 menu-bar entry, "quit the app" in her own settings, a **low-power mode**, and a proper app icon.
> It is shipped as a separate download in Releases — the plugin itself (the web version) is unchanged and
> still supports Windows / macOS / Linux.
>
> **Fixed**: her tail and out-of-frame expressions were being clipped (the viewport was exactly the
> character's bounding box, with no margin); a large white rectangle behind her in the desktop shell
> (the private `WKWebView` background key is `_setDrawsBackground:`, not `setDrawsBackground:`);
> typing was impossible in the shell (borderless windows need `canBecomeKey`); the collapse button was
> a one-way trip (the restore handle was missing from the click-through whitelist); and the ball could
> disappear with no way back.
>
> **Performance**: frame rate is now capped (30 fps standard / 20 fps low-power) instead of running at
> display refresh (up to 120 fps on ProMotion), the render resolution was lowered from 2× to 1.5×
> (1× in low-power), the desktop shell releases its App Nap exemption while collapsed, and the hit-test
> probe was slowed down. Measured on this machine: shell process 0.5–0.8 % CPU, WebKit renderer 0.2–0.4 %.

### 新增：macOS 桌面版（原生壳）

她可以**搬到桌面上**，不再只活在浏览器标签页里 —— 透明、无边框、永远置顶的原生窗口：

- **点击穿透**：只有她真正占的像素才收鼠标事件（用模型自己的 alpha 掩码判定），
  其余地方点一下就穿到下面的 App —— 不会挡你干活
- **拖她 = 拖窗口**，松手位置记住；拖动不会被误判成「摸头」
- **收起 = 贴边悬浮球**：瞬间出现在离她最近的那一侧，深色玻璃球 + DSH 图标，
  悬停微放大、拖动跟手、松手动画贴边
- 菜单栏 🐋：重新加载 / 回到右下角 / 收起成小球 / 展开 / 小球大小 / **低性能模式** / 保存截图 / **彻底退出**
- 她自己的设置页里也多了「收起成悬浮小球」「彻底关闭桌宠应用」
- **App 图标**：蓝色渐变圆角框 + 她的平常脸立绘
- 只安装一处：`~/Applications/DS 鲸鱼娘桌宠.app`（刻意不在仓库里留第二份）

**装法**：先在 DSH 里装插件（就是下面那些），再去 Releases 下载
`DS-WhaleGirl-Pet-macOS-*.zip`。完整说明见 [`desktop/README.md`](desktop/README.md)。

### 修：尾巴和出格的表情被截掉

原来视窗高度**正好等于**角色实体高度、宽度按固定宽高比算，所以横向超出的尾巴、
纵向超出的表情都被画布裁掉。现在实体四周各留 10% 余量，宽度取「固定宽高比」与
「实体宽度+余量」中更宽者；缩放改成按实体高度算 —— 她**屏幕上的大小不变**，周围多出空间。

### 修：桌面壳里的四个硬伤

1. **大白框**：`WKWebView` 关白底的老写法查的是 `setDrawsBackground:`，但这个私有属性在
   运行时真名是 `_setDrawsBackground:`（KVC 找得到），于是一直被判「不支持」而跳过 → 白底常驻。
   现在两个真键都调上，并递归拆掉内部 `NSScrollView` 的白底。
2. **打不了字**：无边框窗口 `canBecomeKey` 默认 false，键盘事件进不到窗口。
   现在是 `PetWindow` 子类 + 点她时 `NSApp.activate` + 焦点交给网页。
3. **一收起就再也点不回来**：恢复把手是 `.dshp-tab`，而点击穿透的判定写死了一张类名白名单，
   恰好没它。现在改成「`elementFromPoint` 返回的任何她自己的 DOM 都算可交互」。
4. **收起后小球不见了**：加了「页面隐藏但两个窗口都不见 → 自动把球叫回来」的自愈。

### 性能：她之前是满帧满分辨率在跑

- 帧率上限 **30 帧**（低性能档 20 帧）—— 之前跟着显示器刷新率跑，ProMotion 上就是 120 帧
- 渲染分辨率从 2 倍降到 **1.5 倍**（低性能档 1 倍）
- 桌面壳**收起成小球时释放 App Nap 豁免** —— 之前的写法让她永远满速渲染，
  浏览器里标签页不聚焦会自动降频、壳子里不会，这就是「浏览器不卡、壳子卡」的原因
- 点击穿透探针 50ms → 90ms，健康检查 6s → 20s，去掉开发期的自动截图
- 新增**低性能模式**（菜单栏 🐋 可切）：不自己找戏、不自言自语、不弹瞌睡台词，
  只留眨眼 + 轻微摆动 + 视线；点了她才动

## 0.3.3 — 2026-09-25

> **English summary / 英文摘要**
>
> Fixed the eyes being frozen **closed** — a regression introduced in 0.3.2. The framework's
> `getParameterDefaultValue()` takes an *index*, not a parameter id; passing an id returned `undefined`, the
> fallback treated it as `0`, and the eye-open parameter was written as 0 and snapshotted for good. Ids are now
> converted to indices and skipped when unknown, plus a self-heal that restores the default when the eyes stay
> closed for 1.5 s with nobody claiming them. Blinking now runs on a natural schedule (every 2.6–5.4 s,
> ~0.19 s per blink, 15% double blinks, none while a motion or an eye-controlling expression is active).
> Bubbles, menus, the wallet and the composer are anchored to the top of her head (0–1 px off centre, pushed
> inside the viewport near a wall). Tests: 159 static + 99 in-browser, all green.

### 修：眼睛被永久冻成「闭着」（0.3.2 引入的，我的错）

0.3.2 里我加了「停动作时把参数复位到默认值」，但框架的 `getParameterDefaultValue(t)`
收的是**下标**不是 id —— 我传了 id，拿到 `undefined`，兜底又把它当成 0，
于是「睁眼」参数被写成 0（闭眼）并永久存进参数快照。现在：id 先转下标、取不到就**跳过**
（绝不猜 0），另外加了一层「眼睛自愈」兜底：没人认领眼睛参数、又闭了 1.5 秒以上，就按默认值纠回来。

### 眨眼：改成自然的节奏

框架自带的是「下次眨眼 = random × 7 秒」，有时连着眨两下、有时七八秒不眨。
现在自己控制：间隔 2.6~5.4 秒、单次约 0.19 秒（闭 60ms + 停 30ms + 睁 100ms）、
15% 概率连眨两下；**动作播放中或表情在管眼睛时不眨**。实测 12 秒眨 3 次。
（判断「动作在播」不能用框架的 `isFinished()`，它空闲时也返回「没结束」——
这就是第一版眨眼一次都不眨的原因，改成我们自己按动作时长记账。）

### 聊天框对准她的头顶

以前面板以「根节点中心」居中，而根节点包含整张书桌场景，中心 ≠ 脑袋中心，所以看着总偏。
现在用测量出来的头部重心当锚点：中间时**偏差 0~1px**，靠左/右墙时自动往屏内让，不会被墙切掉。
眼神跟随鼠标这一套完全没动（幅度 58%、限速 1.6/秒）。


## 0.3.2 — 2026-09-25

> **English summary / 英文摘要**
>
> Two real bugs. **(1)** After using the omurice action it stayed on the desk forever, even after a
> reset: the framework snapshots parameters *after* motions write them, so a stopped motion's last frame was
> reloaded every frame. Stopping a motion now resets those parameters to the model defaults and re-saves the
> snapshot — the same fix covers phones and expressions that would not go away. **(2)** Popups opened left one
> time and right the next and were half-clipped at a wall; positioning is pure computation now. Also: the Speak
> button became a toggle, and dragging can no longer clip the bottom toolbar.

### 「蛋包饭永远挂着」的根因修掉了（真 bug，藏在框架里）

pixi-live2d-display 每帧的顺序是：动作写入 → `saveParameters()` 存快照 → 眨眼/视线/呼吸/物理
→ 我们的 rig → `update()` → `loadParameters()` 把快照装回来。
**快照是在动作写入之后存的**，所以动作一停，快照里留的就是它最后一帧的姿势，每帧都被装回来 ——
这就是主人看到的「用过蛋包饭之后它永远挂在桌上，连一键重置都没用」。
现在 `stopMotion()` 会顺手 `clearMotionPose()`：把动作写过的参数设回 `getParameterDefaultValue()`，
再重新存一次快照。手机 / 表情「回不去」这一整类问题都一起解决了。
回归测试直接读**模型参数**（不是我们自己的状态）：动画中 12 个参数被改动，结束后全部回到默认。

### 弹窗不再一次左一次右

旧写法是「把位移清零 → 量面板位置 → 据此设位移」，而位移本身有过渡动画，
量到动画中间态就会一次算左一次算右，靠墙时还会卡进墙里一半。
现在 `placePanel()` 是纯计算：桌宠在屏幕左半边就往右开、右半边就往左开，再兜底夹进视口。
气泡、菜单、钱包、输入框都走它。测试连开三次，位置必须逐个字符一致。

### 其它

- 「说话」按钮改成开关：点一次开、再点一次关（以前再点只会重新打开，像关不掉）。
- 气泡也支持纵向兜底位移，桌宠拖到屏幕顶端时不会被切掉。
- 竖直位置的安全夹（别让底下三个按钮被屏幕切掉）在拖动和惯性里也生效了。


## 0.3.1 — 2026-09-25

> **English summary / 英文摘要**
>
> All of these were reported by users: snapping is **side-only** (the vertical position stays exactly
> where you put her), the composer only opens from the Speak button (double-clicking the model no longer opens
> it), the wallet's × closes the wallet instead of the menu, right-click toggles it, and a freely-dropped pet is
> no longer pulled back to the wall after a reload.

### 交互修正（都是主人报的）

- **输入框不再乱弹**：以前双击模型会弹出输入框，现在只有点工具栏「说话」才开；
  双击仍然算戳她一下。
- **钱包的 × 修好了**：以前那个 × 一律去关菜单，钱包不是菜单管的，所以点了没反应。
- **右键变成开关**：点一次开钱包，再点一次收起（以前第二次右键会被「点外面就关」抢先关掉再被打开）。
- **只吸左右墙，不吸底部**：松手时靠左/右墙就吸过去，**竖直位置保持你放的高度**；
  离两侧都远就停在原地。竖直方向只做「别让底下三个按钮被屏幕切掉」的软夹。
  存档从 `corner`（左下/右下角）改成 `{edge, edgeY}`，老存档自动迁移。
- 顺带修掉：从墙边拖到自由位置后，存档里还留着旧的 `edge`，重载会被拉回墙上。


## 0.3.0 — 2026-09-25

> **English summary / 英文摘要**
>
> New: **right-click opens a wallet HUD** — remaining balance (DeepSeek's official `user/balance`
> endpoint), this turn's cost (auto-popped when a turn ends: money + tokens), today's total, peak hours in red /
> off-peak in green, and a countdown to the next price change. The accounting is computed inside the host and
> does **not** depend on `dsh-whale-widget`. The HUD never fights the chat for screen space. Host-side changes
> need a DSH restart.

### 右键 = 钱包 HUD（余额 / 本轮消耗 / 峰谷计价）

- **右键不再弹设置**，改成弹一个醒目的框：剩余余额、本轮消耗、今日已用、**峰（红）/谷（绿）**、距下一次峰谷切换还有多久。
- 每一轮结束**自动弹出**「本轮消耗」（金额 + tokens），9 秒后自己收；鼠标停上去不会被打断。
- **计价自己做在宿主里**，不依赖任何别的插件：DeepSeek 官方 `user/balance` 取余额
  （key 走 DSH 凭据服务 `DEEPSEEK_API_KEY`），峰谷按官方规则（工作日 9–12 / 14–18 为高峰，
  周末、调休上班日、法定节假日全天为谷），按 命中/未命中/输出 三个口径分别计价
  （Flash 0.02/1/4，高峰 ×2；Pro 为 3 倍）。
- 新增宿主接口 `GET /dsh-pet/hud` 与 SSE 事件 `hud-turn`。
- 前端优先读自己的接口；装了 `dsh-whale-widget` 时回退用它的账本对账（实测那个插件被停用后其接口是 404，所以才要自带）。
- **不与对话抢屏幕**：开菜单时 HUD 自动收起、点击别处/`Esc` 可关、面板会被夹回视口内不会被切掉。
- 测试：静态/宿主 **158 项**、浏览器端 **127 项**（含「计价公式正确」「宿主接口挂了要能降级」）。


## 0.2.0 — 2026-09-25

> **English summary / 英文摘要**
>
> First release: the Live2D whale girl as a desktop pet inside the DeepSeek Harness Web UI. A
> four-tab menu — expressions / accessories / scenes / actions, with temporary / persistent / persistent /
> one-shot lifetimes — every one of them mapped from the original model author's 52-hotkey sheet. One-click
> reset, and she no longer gets angry from casual clicking. Code MIT © 2026 Andersen216; artwork
> CC BY-NC-SA 4.0, non-commercial, credited to 上善无形 / ZipZipPipe / 氵六青.

这一版把「菜单里点了没用」「工作模式卡死」「老是生气」这几个体验问题集中修掉了，
并且**把动作表整个换成原作者自己的按键表**。

### 按原作者的按键表重建了动作体系

- 读了模型包里的 `按键表.txt` 与 `c_0120.vtube.json`（52 条热键），逐条对照后重排菜单：
  **表情 / 装饰 / 场景 / 动作** 四页，规矩分别是「临时 3~4 秒 / 常驻 / 常驻 / 一次性」。
  逐条对照见 [`docs/作者按键表-对照.md`](docs/作者按键表-对照.md)。
- **装饰**：四副眼镜、三张贴纸、情绪花花、单边马尾、发箍、头顶鲸鱼 —— 一直存在，同类互斥。
- **场景**：深色桌布、鲸鱼放桌上、巴菲、粉/白魔爪、掏出手机、手机换色 —— 一直存在。
- **动作**（新增一批）：猫爪摆手、喵喵手、双手比耶、冒爱心、心跳、MoeMoeQ~、
  橡皮擦、撤回、蛋包饭、自拍、快速自拍、鲸鱼喷水 —— 演一遍就消失。
- 照搬作者的前置依赖：**白魔爪 → 粉魔爪**、**手机换色 / 自拍 / 快速自拍 → 掏出手机**
  （点的时候自动补前置，不会再出现「素材没亮所以看不出效果」）。
- 自带表情变化的动画（自拍、喷水、番茄酱、猫爪）**不再叠一张我们的脸**，
  交还给动画本身，避免「冲突 / 覆盖」。
- 作者把「鲸鱼喷水」绑在左键上，所以戳她的时候也会偶尔喷一下水。
- 「闭眼口水」按作者按键表（Alt+T）恢复；呆呆眼 / 晕晕 / 泡泡糖 / 重锤出击仍然不上。

### 菜单表情改成「临时」

- 点菜单里的表情只演 **3.6 秒**（一次性层），到点自己让位，平常状态永远是**平常脸**。
- 期间她自己的表情、agent 事件、或者你再点一个，都会立刻把它顶掉。
- 不再使用 30 秒的手动常驻层；「表情」页按**表情**去重（星星眼只出现一次）。

### 修掉「工作模式卡死」（主人报的 bug）

- 病根：一键重置**没有停掉干活轮播**，9~14 秒后底层状态又被推回「看资料 + 星星眼」，
  看起来就是「重置也救不回来」。
- 现在重置 = 停轮播 + 清空所有道具层（含手机）+ 清掉临时表演 + 脸回平常，
  重置后 8 秒内的采样必须一直是「本子 + 笔 + 平常脸」（回归测试盯着）。
- 蛋包饭按主人要求做成**一次性**：挤完番茄酱就消失，绝不留在桌上。

### 点她不再动不动就生气

- 旧的连点判定是「两次点击间隔 < 1.8 秒就累加」，于是每 1.5 秒点一下，第三下就炸毛。
- 现在是**滑动窗口 + 平均间隔**的真速率判定：
  ≤ 2 次/秒 永远是可爱反应；2.4 次/秒以上只是撒娇抗议；3.8 次/秒以上且窗口内 ≥7 下才真炸毛，
  而且炸毛后有 6 秒冷静期。
- 平常戳身子池里已经没有任何「生气的脸」；摸头池里「被叫胖」那条权重压到 0.4。
- 待机不再无缘无故摆生气脸（换成了流汗）。

### UI

- **底下三个按钮**原来被 `left:50%` 挤成 104px 宽、文字折行后高 66px；现在
  `width:max-content` + 缩小一号 → 48×20，排成一行。
- **大小滑块现在可以一路拖到底**：拖的时候冻结 UI 缩放，滑块轨道不会再从鼠标底下跑掉。
- 菜单面板不再被屏幕边缘切掉（自动夹回视口内），`Esc` 可关，顶部多了「现在是什么状态」。
- 每个菜单项都有配好的台词（鼠标悬停能看到她会说什么）。

### 发布相关

- 插件改名为 **`dsh-whale-girl-live2d`**（中文名「鲸鱼娘桌宠 —— DSH 里的 Live2D 鲸鱼娘」）。
  原因：`dsh-whale-girl` / `dsh-whale-girl-pet` / `dsh-whale-pet` 在 npm 上**都已被别人的
  鲸鱼娘桌宠占用**，撞名会导致市场装错包。
- 署名：**Andersen216**（插件作者）；模型/角色：上善无形、ZipZipPipe、氵六青（CC BY-NC-SA 4.0，非商业）。
- 新增 `AUTHORS.md`、`docs/发布到插件市场.md`、`docs/投稿条目.yml`、
  `npm run release:github` / `npm run release:check`（一条命令建仓库 + 推代码 + 提市场 PR）。

### 新增测试与工具

- `npm run test:catalog`：把 44 个表情 / 11 个装饰 / 6 个场景 / 12 个动作逐个点一遍，
  用像素差客观测「点了到底有没有反应」（现在 0 个哑按钮）。
- `npm run test:e2e:ui`：用 CDP 真鼠标事件验证滑块拖拽与按钮尺寸。
- `npm run repro:stuck`：复现「工作模式 + 互动 + 一键重置」那条链路的时序。
- 回归测试总数：静态 149 项、浏览器端 97 项，全绿。

## 0.1.0 — 2026-09-24

- 第一版：模型常驻 DSH Web GUI，由 agent 事件驱动表情与动作，气泡说话，
  点击/拖拽/贴边、右键菜单、一键重置、隐藏与找回、按 mtime 热更新。
