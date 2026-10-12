# 壳层生成器（tools/shell-gen）

这几个脚本**生成** `desktop/standalone/` 下那几个文件。它们不是普通源码 ——
改错了地方会被下一次生成覆盖，所以务必先读这一页。

## 谁生成谁

| 生成器 | 输入（**改这里**） | 输出（**别直接改**） |
| --- | --- | --- |
| `make-standalone-shell.mjs` | `desktop/windows/main.js` + `preload.js` | `desktop/standalone/main.js`、`desktop/standalone/preload.js` |
| `make-shell-cjs-shape.mjs` | `desktop/standalone/window-shape.mjs` | `desktop/standalone/window-shape.cjs` |
| `make-shell-cjs-server.mjs` | `desktop/standalone/server.mjs` | `desktop/standalone/server.cjs` |
| `make-shell-cjs-bridge.mjs` | `lib/media-bridge.mjs` | `desktop/standalone/media-bridge.cjs` |

**为什么要有生成器**：Electron 33 的 ESM 加载器处理内置模块 `electron` 会崩
（`cjsPreparseModuleExports: Cannot read properties of undefined`），所以壳一律走 CommonJS；
而宿主侧用的是 ESM。与其维护两份实现，不如**生成** CJS 那份，并在测试里对账。

## 怎么跑

```bash
node tools/shell-gen/make-shell-cjs-shape.mjs
node tools/shell-gen/make-shell-cjs-server.mjs
node tools/shell-gen/make-shell-cjs-bridge.mjs
node tools/shell-gen/make-standalone-shell.mjs     # 最后跑它：它会把 main.js/preload.js 整个重写
node tools/test-all.mjs                            # 16 组，全绿才算没改坏
```

脚本靠**自身位置**定位仓库根（往上退两级），不写死绝对路径。

## 踩过的坑（改生成器前必读）

1. **`main.js` 只在文件末尾写盘一次** —— 所有注入都必须在写盘之前，
   否则注入只存在于内存、文件里没有（踩过两次）。
2. **单引号字符串里的中文双引号 `"…"` 会截断字符串**（踩过三次）。
   同理：别在字符串里放裸的反引号，也别在生成器自己的模板字面量里用反引号。
3. **断言要放在对应注入之后**，并且**先过滤注释行**再匹配
   —— 否则注释里提到的 API 名会误报（`stripBom` 那条自己骗过自己）。
4. **别用带常量名的精确正则定位**（`expand: 6,` 那条因为带了 `OFFSET` 静默没匹配上）。
5. **花括号配平切块会被模板字面量 `${...}` 骗到** —— 切整段请用**段落标记**，
   不要用 `{`/`}` 计数（`ballHTML` 那次就把 `ball-move` 处理器漏掉了）。
6. **改完必须跑 `node tools/test-all.mjs`** —— 16 组里有一组专门守这些生成物。
