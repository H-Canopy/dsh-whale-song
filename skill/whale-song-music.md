---
name: whale-song-music
description: 控制桌宠「鲸歌」的音乐 —— 点播指定歌曲/歌单（网易云，走官方客户端）、读当前在放什么、播放/暂停/上下首、本地音乐与音源适配器。当用户说「放首歌」「点一首/点播/给我放 X」「切下一首」「暂停/继续」「现在在放什么」「换个音乐文件夹」时用这个 skill。
---

# 鲸歌的音乐控制（agent 视角）

> 为什么是 skill 而不是插件面板里的搜索框：用户来找你的时候**已经在打字**了。
> 在对话里点播天然支持模糊匹配、多轮更正、看结果列表；再往桌宠那 258px 高的面板里塞一个
> 搜索框，只会把按钮挤出可见区（已实测踩坑）。所以**面板负责显示与控制，搜索走对话**。

## 一、点播歌曲（最常用）

网易云是**让官方客户端自己播**（`orpheus://` 协议），不算解码、不碰账号：

```powershell
$node='<node 路径>'
& $node D:\Plugins\dsh-netease\netease-cli.mjs search "晴天 周杰伦"     # 只搜，列出候选（含 fee 档位）
& $node D:\Plugins\dsh-netease\netease-cli.mjs play "晴天 周杰伦"       # 搜 + 播（内部会挑最合适的一条）
& $node D:\Plugins\dsh-netease\netease-cli.mjs play --id 3440441479     # 指定 id 播（用户/你已确认过的那条）
& $node D:\Plugins\dsh-netease\netease-cli.mjs play --list <歌单id>      # 整单播放（会替换客户端队列，属于破坏性操作）
& $node D:\Plugins\dsh-netease\netease-cli.mjs plinfo "<歌单链接或id>"   # 先看歌单是什么再决定
```

**规矩**

1. **先搜再播**（除非用户点名要哪一版）：`search` 的结果里 `fee=8` 是免费档、`fee=1` 是会员档
   （通常只能试听一段，到点会自己跳走）、`fee=0` 是无版权/下架。**优先挑 fee=8**。
2. 结果里同名翻唱/钢琴版/女声版很多（实测搜「晴天 周杰伦」10 条里只有 1 条是原唱）。
   拿不准就先列 3~5 条给用户选，别擅自播一个翻唱。
3. **整单播放会替换客户端的播放队列**（用户正在听的东西会被顶掉）。用户没明确要求就别用。
4. 用户没在做"验证/测试"，而只是在用音乐时，**播放本身是他要的动作，直接做**；
   但如果是你在做**测试**，必须先拿到明确授权（见《测试规矩》）。

## 二、现在在放什么 / 播放控制

```powershell
& $node D:\Plugins\dsh-netease\netease-cli.mjs now        # 当前曲目（走 SMTC，任何播放器都行）
& $node D:\Plugins\dsh-netease\netease-cli.mjs pause      # 暂停
& $node D:\Plugins\dsh-netease\netease-cli.mjs resume     # 继续
& $node D:\Plugins\dsh-netease\netease-cli.mjs next       # 下一首（prev 同理）
& $node D:\Plugins\dsh-netease\netease-cli.mjs launch     # 客户端没开就打开它
& $node D:\Plugins\dsh-netease\netease-cli.mjs doctor     # 排障：环境/客户端/协议/会话都查一遍
```

`now/pause/resume/next/prev` 走的是 **Windows 媒体会话（SMTC）**，所以对**任何**播放器都管用
（网易云 / QQ音乐 / PotPlayer / VLC / 浏览器），不限于网易云。

## 三、宿主也有一套（插件自带，与 CLI 是两条路）

插件 whale-song 的宿主提供：

| 路由 | 用途 |
| --- | --- |
| `GET /dsh-pet/media?list=1` | 列出机器上所有媒体会话（`{appId,title,artist,status}`） |
| `GET /dsh-pet/media[?app=]` | 当前曲目（`app` 是 AppId 过滤器，如 `cloudmusic`） |
| `POST /dsh-pet/media {cmd,app?}` | `play` / `pause` / `toggle` / `next` / `prev`（白名单，作用于当前生效播放器） |
| `GET /dsh-whale/music.json` | 本地音乐歌单 + 设置 |
| `GET /dsh-whale/music-file?id=` | 本地音频字节（支持 Range/seek） |
| `POST /dsh-whale/music.json` | `set-settings` / `set-dir` / `upload` / `delete` |
| `GET /dsh-whale/radio-search`、`radio-stream` | 在线电台搜索 / 代理播放（需回环） |

**边界**：这些路由都过宿主的信任栅栏（需要 DSH 会话 cookie 或桌面版通行证），
而且 `radio-*` 只认回环。从命令行直接 curl 通常会被 401 挡掉 —— **不是坏了，是设计如此**；
要读它们就从浏览器/页面里读，或者直接用上面第一、二节的 CLI。

**本地音乐**：`set-dir` 可以把用户自己的音乐文件夹扫进歌单（歌单 = 自定义文件夹 ∪ 托管目录
`$DSH_HOME/whale-music`）。用户说"把我 D 盘的音乐加进来"就：

```powershell
# 举例：通过页面/前端设置，或直接改状态文件后让前端刷新
# 状态文件：$DSH_HOME/.dshw-music.json   （{"customDir": "D:\\Music", ...}）
```

改完要让用户刷新页面（或点音乐页那栏的"用这个文件夹"）才会重扫。

## 四、测试规矩（硬要求）

- **不要为了测试乱放歌**：要验证"能播"，就"切成用户正在听的下一首再切回来"；
  真要动播放状态，**先拿显式授权**（用户点头或 `DSHW_NETEASE_LIVE=1` 这类开关）。
- 探针/脚本里凡是会发出声音的步骤，结束前**必须恢复原状并暂停**。
- 相关测试（都在插件仓库里，不会碰用户的音乐）：
  `node tools/test-all.mjs`（9 组，含媒体路由 49/49、本地音乐 37/37）。

## 五、许可与署名（别越线）

- 只调官方客户端的 `orpheus://` 协议播放，**不解码音频、不做"免费听 VIP"、不碰账号 cookie**。
- 模型素材是 **CC BY-NC-SA 4.0（非商业）**，三位署名不能删：上善无形 / ZipZipPipe / 氵六青。
