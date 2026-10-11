# 发布说明：鲸歌 dsh-whale-song `0.4.6-song.2`

> 这一版是**可以公开发布**的状态。下面按"复制就能用"的顺序给三段文字 + 发布前自检。

---

## 一、发布前自检（发布者自己跑一遍）

```powershell
$node='C:\Users\11422\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
# 1) 全部测试（10 组）
& $node D:\Plugins\dsh-whale-song\tools\test-all.mjs
# 2) 外部验收（挂件那两套 harness 打我们的插件）
$env:DSHW_PLUGIN_DIR='D:/Plugins/dsh-whale-song'
& $node D:\Plugins\whale-widget-patch-tests\music-harness.mjs   # 41/43（2 条是挂件自身 UI 路由）
& $node D:\Plugins\whale-widget-patch-tests\radio-harness.mjs   # 52/52
Remove-Item Env:\DSHW_PLUGIN_DIR
# 3) 泄露扫描（看有没有 CRITICAL）
& $node D:\Plugins\whale-widget-patch-tests\leak-scan.mjs D:\Plugins\dsh-whale-song --ok H-Canopy
```

**发布前必看三条**
1. **署名三连不能删**：上善无形 / ZipZipPipe / 氵六青（`AUTHORS.md` + `NOTICE.md` + 仓库首页）。
2. **本项目非商业**：不收费、不带货、不接广告、不卖周边、不作为付费卖点。
   `assets/model/**` 是 **CC BY-NC-SA 4.0**；代码是 MIT —— 两句话都得在首页出现。
3. **说明修改**：fork 相对上游改了什么，指到 `PLAN-OURS.md`（CC BY-NC-SA 要求的"indicate changes"）。

---

## 二、仓库首页已经写好的部分

仓库 README 开头那段（`SONG-NOTE` 区块）就是给 visitor 看的门面：一句话定位 +
能力表 + 安装命令 + 归属与许可 + "下面是上游原始文档"。**不用改**，除非要加截图。

---

## 三、可以直接贴到网上的短文案

### A. 一段话版（论坛/群/即刻/朋友圈）

> 给 DSH 的桌宠「鲸歌」加了个音乐系统：她能**直接读 Windows 的媒体会话** ——
> 你在网易云、QQ音乐、PotPlayer、VLC 甚至浏览器里放什么，她都知道，会跟着换表情；
> 点开菜单里的「🎵 音乐」能看有哪些播放器在跑、点一下固定跟随、上下一首/暂停都在；
> 本地音乐也能放（歌单、拖动进度、播完自动下一首）。想点歌就在对话里说「放周杰伦的晴天」。
> 不装别的插件也能用。**完全免费、开源、非商业**（角色形象与模型是三位作者的，
> 按 CC BY-NC-SA 4.0 署名）。
> 仓库：https://github.com/H-Canopy/dsh-whale-song

### B. 带表格的技术版（少数派/V2EX/GitHub Release）

> ## 鲸歌 · dsh-whale-song（`0.4.6-song.2`）
>
> 上游 [dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d) 的增强 fork：
> 把她和"音乐"真正接起来。
>
> | 能力 | 实现 |
> | --- | --- |
> | 知道在放什么 → 换表情/演动作 | 直读 Windows 媒体会话（SMTC），**任何**往外发会话的播放器都行，不依赖别的插件 |
> | 「音乐」页列出检测到的播放器 | 点一下固定跟随；遥控指令是固定白名单，只走本机回环 |
> | 本地音乐 | 歌单（托管目录 ∪ 你的文件夹）、音频 Range（可拖进度）、自动下一首 |
> | 点歌 | 在对话里说「放周杰伦的晴天」（走官方客户端 `orpheus://`，不解码、不碰账号） |
>
> 安装：`dsh plugin --profile web add github:H-Canopy/dsh-whale-song`（装完**重启一次 DSH**）
>
> **许可**：代码 MIT（上游 © Andersen216 / 增量 © H-Canopy）；
> 角色形象 © 上善无形、ZipZipPipe，Live2D 模型 © 氵六青 —— **CC BY-NC-SA 4.0，非商业**。
> 本项目免费、不商业化。

### C. 微博/B 站动态（短）

> 给 DSH 桌宠做了个音乐系统：她知道我在放什么（网易云/QQ音乐/PotPlayer/浏览器都行），
> 会跟着换表情，菜单里能换歌、也能放本地音乐，想点歌直接跟她说。
> 免费开源、非商业 👉 github.com/H-Canopy/dsh-whale-song
> 角色/模型 © 上善无形 · ZipZipPipe · 氵六青（CC BY-NC-SA 4.0）

---

## 四、发布动作清单（按顺序）

- [ ] `git push origin main`（已有 8+ 个提交，见 `git log`）
- [ ] 打 tag：`git tag -a v0.4.6-song.2 -m "..."` + `git push origin v0.4.6-song.2`
- [ ] GitHub Release：标题写版本，正文贴上面 **B** 段 + 改动清单链接（`PLAN-OURS.md`）
- [ ] 仓库 About 填一句 + Topics：`dsh` `deepseek-harness` `live2d` `desktop-pet` `music`
- [ ] （可选）npm 发布：`node tools/publish-npm.mjs --check` 先看检查项
- [ ] 贴文案（A/B/C 选一个）

---

## 五、别做的事（许可红线）

- ❌ 不要删/改三位作者署名，不要声称模型或角色是自己做的
- ❌ 不要用于任何商业场景（收费、带货、广告、付费产品卖点）
- ❌ 不要把 `assets/model/**` 按 MIT 分发（它是 CC BY-NC-SA 4.0）
- ❌ 不要描述成"能免费听 VIP"—— 点播走的是官方客户端，会员内容仍由客户端自己判定
