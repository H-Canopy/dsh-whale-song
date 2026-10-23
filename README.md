<div align="center">

<img src="docs/images/hero.webp" width="320" alt="鲸歌 WhaleSong" />

<h1>鲸歌 · WhaleSong</h1>

<p><b>住在你桌面上的鲸。</b><br/>桌面伙伴 · DSH 联动 · 音乐控制<br/><sub>A Live2D desktop companion for the DeepSeek Harness Web UI.</sub></p>

[![License](https://img.shields.io/badge/license-MIT-2563eb.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/H-Canopy/dsh-whale-song?color=2563eb&label=release)](../../releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0ea5e9.svg)](#快速开始)
[![Electron](https://img.shields.io/badge/electron-33-47848f.svg)](package.json)
[![Assets](https://img.shields.io/badge/%E8%A7%92%E8%89%B2%E8%B5%84%E4%BA%A7-%E4%B8%8D%E9%9A%8F%E4%BB%93%E5%BA%93%E6%8F%90%E4%BE%9B-f59e0b.svg)](ASSET_POLICY.md)

</div>

> [!IMPORTANT]
> 程序代码以 MIT 开放；**正式角色的图片、动画、表情图集与源工程不随仓库提供**。
> 没有正式资产时，她会以一只标着 `DEMO` 的通用鲸鱼出现——功能与代码完全一致。

## 特性

| 能力 | 说明 |
| --- | --- |
| **脱离 DSH 独立运行** | 自带 Electron 桌面壳（Windows）：透明窗口、置顶、穿透、拖动、收起、150–280 缩放、低功耗。DSH 没开，她也在。 |
| **DSH 联动** | 对话、任务状态、钱包余额实时反映在她身上；点她一下就能直接跟 agent 说话。 |
| **音乐控制** | 本地音乐 / 在线电台（Radio Browser · SomaFM）/ 网易云联动；右键双击播放暂停，优先走系统媒体会话（SMTC）。 |
| **可开发** | 50+ 个测试与诊断脚本、行为断言闸门、资产边界审计（CI 每次提交都跑）。 |
## 快速开始

**一、装进 DSH**（Web 界面右下角那一位）

```bash
dsh plugin --profile web add github:H-Canopy/dsh-whale-song
```

**二、桌面独立版**（不需要 DSH，需要 Node.js 18+ 与 Windows 10/11）

```bash
npm install
npm run desktop:start
```

**三、只看不装**

```bash
npm install
npm run preview
```

## 她能做什么

- 跟着 agent 的真实状态换表情与动作：待机、思考、干活、报错、收工。
- 点她一下 → 说话；500ms 内在同一处再点 → 打开对话框。
- 右键 → 换表情 / 换装 / 摆场景 / 演动作 / 音乐。
- 闲置时自己慢慢挪个位置（拖动或打字时自动暂停）。
- 装了正式资产时还有视频动作：待机、阅读、哈欠、伸懒腰、转圈、跑步。

## 仓库结构

```text
assets/      渲染层与行为脚本（pet.js、media-*）
lib/         插件入口与媒体服务
desktop/     Windows 桌面壳
standalone/  单页预览
sources/     音乐源适配（本地 / 电台 / 网易云）
skill/       DSH skill：教 agent 怎么驱动她
tools/       测试、诊断、打包、发布
docs/        文档与展示图
```

## 资产与许可

| 内容 | 许可 |
| --- | --- |
| 程序代码 | MIT，保留原作者与许可声明 |
| `assets/demo-whale.svg`（通用示例） | MIT |
| 正式角色形象 / 动画 / 表情图集 / 源工程 | **保留所有权利**，不随仓库提供 |
| `docs/images/` 下的展示图 | 仅用于项目介绍，不授予提取、再分发、改编或商用 |

细则见 [ASSET_POLICY.md](ASSET_POLICY.md)、[NOTICE.md](NOTICE.md)、[AUTHORS.md](AUTHORS.md)、[PROVENANCE.md](PROVENANCE.md)。

## 开发

```bash
npm run test:all                    # 全量行为断言
python tools/audit-public-assets.py # 资产边界审计
npm run desktop:dist                # 打 Windows 包
```

改动请先读 [CONTRIBUTING.md](CONTRIBUTING.md)：**不要把角色资产提交进仓库**，CI 会拦。

## 致谢

- [Andersen216](https://github.com/Andersen216) —— 原桌宠插件与桌面壳（MIT）
- 上善无形 —— 鲸鱼娘角色原作「溟月」
- ZipZipPipe —— 女仆鲸鱼娘二次设计
- 氵六青 —— Live2D 模型制作（绑定 / 动作 / 表情）

## 来源

代码起点是 [Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d)（MIT）。
鲸歌自 2026 年 10 月起独立维护，品牌、形象与动作按自己的方向走；代码的来源不构成角色资产的授权。
