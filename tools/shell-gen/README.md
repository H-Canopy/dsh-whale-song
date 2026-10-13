# 桌面壳生成器

`main.js` 和 `preload.js` 是生成物。修改这里的 `templates/main.cjs`、`templates/preload.cjs`，然后生成；不要直接改生成物。

| 源文件 | 生成器 | 产物 |
| --- | --- | --- |
| `tools/shell-gen/templates/main.cjs`、`preload.cjs` | `make-standalone-shell.mjs` | `desktop/standalone/main.js`、`preload.js` |
| `desktop/standalone/server.mjs` | `make-shell-cjs-server.mjs` | `desktop/standalone/server.cjs` |
| `lib/media-bridge.mjs` | `make-shell-cjs-bridge.mjs` | `desktop/standalone/media-bridge.cjs` |
| `desktop/standalone/window-shape.mjs`（诊断工具，当前运行时不用） | `make-shell-cjs-shape.mjs` | `window-shape.cjs` |

```sh
npm run desktop:generate
node tools/test-all.mjs
```

两次生成的产物必须逐字节一致。生成器先检查模板语法，再写入输出。`desktop/windows/main.js` 是兼容旧入口的转发文件，也启动同一个实例。

窗口几何与拖动算法直接维护在 `desktop/standalone/window-state.cjs`；DSH 认证、发现和代理直接维护在 `dsh-link.cjs`。这些是源文件，不需要生成。

之前的 1,300 多行生成器通过字符串替换旧壳不断叠加补丁，容易重复注入、覆盖修改。这一轮改为版本控制中的完整模板，保留源文件与生成物的逐字节一致性测试。
