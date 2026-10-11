# PLAN-OURS.md —— 我们对本仓库做了什么（以及为什么）

> 本仓库是 [Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d) 的 fork。
> 上游提供了 Live2D 桌宠的全部基础：模型加载、agent 状态驱动、气泡、道具、菜单、HUD、钱包、桌面壳。
> **我们的增量只有一个方向：把她和"音乐 / 在线电台 / 网易云联动"接成一只会干活的桌宠。**

## 一、许可与署名（必须保留）

| 范围 | 许可 |
| --- | --- |
| 上游代码 + 我们的代码 | **MIT**（上游 Copyright © 2026 Andersen216；我们的增量部分同样 MIT） |
| `assets/model/**`（moc3 / 贴图 / 动作 / 表情 / 物理） | **CC BY-NC-SA 4.0（非商业 · 相同方式共享）**，**署名要写全三位** |
| `assets/vendor/live2dcubismcore.min.js` | Live2D Inc. 的 Redistributable Code，按 Cubism SDK 条款 |
| `assets/vendor/pixi.min.js`、`cubism4.min.js` | MIT |

**三位署名（角色形象链）**：

1. **上善无形** —— 鲸鱼娘角色原作 OC「溟月」 <https://space.bilibili.com/4456176>
2. **ZipZipPipe** —— 加入 DeepSeek 元素的「女仆鲸鱼娘」二次设计 <https://space.bilibili.com/4168597>
3. **氵六青** —— 本仓库所用 Live2D 模型（绑定 / 动作 / 表情） <https://space.bilibili.com/11272072>

**非商业**：不收费、不带货、不接广告变现、不卖周边、不作为付费产品或服务的卖点。
**同许可**：改编后的美术素材继续按 CC BY-NC-SA 4.0 分发。
**说明修改**：本文档第四节逐条列出我们的改动。

## 二、我们要做的（里程碑）

### M1 · 音乐（先打通一条）
- 读挂件的只读接口 `window.dshwMediaNow()`（若装了挂件 fork：`dsh plugin add github:H-Canopy/DeepSeek-Balance-Whale-Widget`）；
  没装时读挂件宿主的回环路由（`/dsh-whale/netease.json` 等）作为兜底。
- 表现：开始播放 → 换表情（`happy`/`listening`）+ 头顶信封简报（曲名/歌手/音源）；
  暂停 → `sleepy`；切歌 → `playMotion` 换动作；放歌期间小幅度摆动。
- 菜单加一页「🎵 音乐」：上一首 / 播放暂停 / 下一首 / 打开挂件面板。

### M2 · 电台
- 同上，简报里带电台名 + ICY 正在播的曲目；收藏/切台走挂件已有接口。

### M3 · 网易云
- `report` 面板显示"正在播放 + 音源"；遥控（播放/暂停/上下首）接到她的气泡菜单。
- 已知限制照抄挂件的（会员曲只试听、整包播放会替换队列、SMTC 无进度）。

### M4 · 收敛与发布
- 把 A（挂件 fork）里那段**实验性的"调她"代码删掉**，只保留只读接口 `window.dshwMediaNow()`；
  集成逻辑全部收在本仓库（依赖方向：宠物读挂件，而不是挂件知道宠物）。
- README 写清：非商业 + 三位署名 + 与上游的关系 + 安装（本包与她原包**包名相同、不能并存**）。

### M5 · 统一层（不依赖任何插件也能用）
> 与 M1–M3 的差别：前三个里程碑是"读挂件"，M5 是"读 Windows"。做完之后挂件才可以退休。
- 宿主 `lib/smtc-helper.ps1` 泛化：`-App '<过滤器>'`（默认仍是"只网易云"）+ `-List` 枚举全部媒体会话。
- 宿主路由 `/dsh-pet/media`（仅回环）：读列表 / 读当前曲目 / 白名单遥控，短 TTL 缓存。
- 前端 `assets/media-smtc.js`：列播放器、选"当前生效"、固定跟随，暴露 `window.dshwSongSMTC`。
- 媒体桥改成四路回退（统一层 → 挂件接口 → 挂件宿主路由 → 静默），设置里可整块关掉。
- 点播层适配器 `sources/netease.mjs`：网易云搬进适配器接口，为"再插一个平台"留位置。

## 三、依赖与不做什么

- **不合并**上游未采纳的东西；上游更新用 `git pull upstream main` 跟。
- **不改**她的模型文件（SA 下改也可，但我们没必要动美术）。
- **不做**商业化路径（NC 决定）；要商用得换一个可商用的形象。
- **不做**账号/cookie/绕版权相关的一切（沿用挂件的红线）。

## 四、我们的改动记录（每完成一项就在这里加一条）

- 2026-10-11：新建本 fork；尚未改动上游代码（仅加本文件）。
- 2026-10-11：改名定位 `dsh-whale-song` / `0.4.6-song.1`（与上游包可并存）；媒体桥
  `assets/media-bridge.js`（默认不发简报）；偏好四键走她的 `CFG`；设置页三行；独立「音乐」页签；
  右键双击＝播放/暂停；花费额度提示；音源适配器插口 `sources/`（契约 + 加载器 + 模板）。
- 2026-10-12（`0.4.6-song.2`）：**统一层**落地 ——
  1. `lib/smtc-helper.ps1` 泛化（`-App` 过滤器 + `-List`；不带参数时行为不变）。真机三验：
     默认只网易云 / `-App '.*'` / `-List`（列出 3 个会话）；`play`→`Playing`、`pause`→`Paused` 复原验证过。
  2. 宿主路由 `/dsh-pet/media`（仅回环 + 信任栅栏）：GET 列表 / GET 当前曲目 / POST 白名单遥控，
     `toggle` 由宿主翻成 play/pause，1.5s·5s 短缓存，控制后作废读缓存，失败不缓存。
  3. 新前端 `assets/media-smtc.js` + 「音乐」页签列出检测到的播放器（当前生效高亮、可固定跟随）；
     媒体桥四路回退；新增设置开关 `设置 → 读系统媒体`（默认开，关掉后零请求）。
  4. `sources/netease.mjs`：网易云点播搬成适配器（不改行为，接口换适配器形状）。
  5. 测试：新增 `tools/test-media-route.mjs`（41/41，`--live` 打真机 8/8）、
     `tools/test-media-smtc.mjs`（41/41）；扩写 `test-media-bridge.mjs`（24/24）、
     `test-prefs.mjs`、`test-sources.mjs`。**尚未动**上游 `pet.js` 的既有逻辑（只在音乐页与设置页做加法）。
