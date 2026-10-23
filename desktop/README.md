# WisdoMark Desktop（验证阶段）

桌面端目标：**贴网址就消化** + 本地知识库，复用扩展已有的抓取与消化链路，不重写业务逻辑。

> **两个版本号，别混**：`desktop/package.json` 是桌面端自己的版本（`0.1.0`，还没发过版）；
> 界面徽标显示的 `v0.22.2` 是**扩展的版本** —— 界面代码来自扩展，功能以它为准。

## 现在验证到哪

| 验证 | 脚本 | 结果 |
|---|---|---|
| Electron 能创建窗口 | `verify-window.js` | ✅ 通过 |
| 复用 `content-script.js` 抓 SPA 正文 | `verify-fetch.js` | ✅ 小黑盒 924 字、5 张图、无登录墙 |
| 复用 `digest.js` 完成消化 | `verify-digest.js` | ✅ 分类「生活常识」、摘要 + 10 条要点、一次通过 |
| 侧栏界面原样加载 | `verify-ui.js` | ✅ 6 个 tab / 6 个 pane / Ollama 探活正常（2 个模型） |
| 文件存储 + 知识库检索 | `verify-data.js` | ✅ 导入 4 篇 / 归档搜索 / 搜 Token 出定义段 / 建卡落库 |
| IPC 全链路（界面 → 主进程） | `verify-ipc.js` | ✅ 6/6，用的是与 `main.js` 同一份 handler |
| **贴网址就消化** | `verify-digest-url.js` | ✅ 抓 924 字 → 「生活常识」+ 10 要点 → 落库带全文，26.8s |
| **画像 + 行动清单** | `verify-profile.js` | ✅ 11/11 —— 8 条真实摘要 → 4 个方向 + 4 个动作，清单复用画像 |
| **诊断 trace + 失败日志** | `verify-trace.js` | ✅ 12/12 —— 记下 1 次调用 / 17.9s / 3022 输入 token；失败队列能读能清 |

**结论：抓取与消化可以零改动复用。** 唯一需要适配的是 `shared.js` 读配置的方式（`chrome.runtime.getURL` + `fetch`）—— 用一个 `file://` 的 shim 就够，业务代码一行没动。

## 怎么跑

```bash
cd desktop
npm install        # Electron 45，二进制约 357 MB

# 普通桌面环境
npm start
npx electron verify-digest.js

# 当前 WorkBuddy 沙箱环境（三个坑见下）
unset ELECTRON_RUN_AS_NODE
./node_modules/electron/dist/electron.exe \
  --no-sandbox --disable-gpu --disable-gpu-sandbox --in-process-gpu \
  verify-digest.js
```

## 三个环境坑（实测）

1. **`ELECTRON_RUN_AS_NODE=1` 被预设** —— `require('electron')` 返回二进制路径字符串，报
   `Cannot read properties of undefined (reading 'whenReady')`。执行前 `unset ELECTRON_RUN_AS_NODE`。
2. **GPU 进程在沙箱里崩** —— `GPU process exited unexpectedly: exit_code=-1073741819`，随后
   `FATAL: GPU process isn't usable`。加 `--no-sandbox --disable-gpu --disable-gpu-sandbox --in-process-gpu` 四件套。
3. **`executeJavaScript` 注入 content-script 报 `An object could not be cloned`** —— 脚本最后一条语句的完成值是
   `window.__wisdomark`（含函数），序列化失败。末尾补 `;0` 把完成值压成原始类型。

> Electron 的 `process.argv` 结构和 Node 不同，**不要假定 `argv[2]` 是 URL**（实测拿到空串，
> 报 `ERR_INVALID_URL`）；扫 `argv` 里 `^https?://` 的那一项。

## 打包

```bash
npm run dist
```

产物：`dist/WisdoMark-0.1.0-portable-x64.exe`（约 **104 MB**，免安装，双击即用）。

**只出 `portable`，不出 `nsis`**，两个原因：

- 两个 target 默认输出同名（`WisdoMark-0.1.0-x64.exe`），nsis 失败留下的 **189 KB stub 会把 portable 覆盖掉**
- nsis 在签卸载器那步调 Wine，本机报 `spawn UNKNOWN`

**打包后必须验的三件事**（都踩过）：

1. **`resources/app-src/vendor/` 必须在** —— `src/sidepanel/ocr.js` 是**顶层 import** OCR 引擎的。
   少了它整个 `sidepanel.js` 加载失败，表现为「静态界面在，但版本徽标是 `—`、Ollama 一直检测中」。
2. **`main.js` 必须把 GPU 参数写进代码**（`appendSwitch`）—— 用户双击不会带命令行参数。
3. **必须真实跑一次消化，不能只验证「界面能开」** —— `app.asar` 的路径在业务代码里才第一次被用到。
   `store-file.js` 漏改 `__dirname/..` 时，界面一切正常，一点消化就报
   `Cannot find module ...\resources\src\background\store.js`（少一层 `app-src`）。

> **所有** `__dirname` 的用法都要用「在不在 `app.asar` 里」判断，不能用 `app.isPackaged`：
> 直接用官方 `electron.exe` 加载 `resources/app.asar` 时 `process.defaultApp` 仍是 `true`，
> `isPackaged` 会误判成 `false`，`ROOT` 落到 `resources/` 上。

> 本机环境（WorkBuddy 沙箱）的 Device Guard 会拦未签名的新 exe：
> `已被组织 Device Guard 策略阻止`。所以「真机双击」这条**在当前环境验不了**，
> 只验证到「代码内置开关后，不带参数启动界面完整」。个人机器上大概不会拦。

## 还没做

- 「当前页面 / 批量」：桌面端先不接，消息会明确回「暂未接入」
- 归档导出 / 导入：handler 已接，但界面的文件选择框还没单独验
- OCR：图文帖暂不处理。**行为与扩展不同** —— 扩展会先识别图片文字再消化，桌面端直接按正文来，
  结果里会标 `ocrSkipped`。这不是 bug，是桌面端先不做这一块
- 打包（electron-builder，暂不做）

## 存储：JSON 文件，不是 IndexedDB

主进程没有 IndexedDB，所以 `desktop/store-file.js` 实现了一份**接口与 `store.js` 对齐**的文件存储：

- 数据落在 `app.getPath('userData')/wisdomark/data.json`
- `dedupeKey / conceptKey` 仍从 `src/background/store.js` 引入，不复制一份
- 归档 / 概念卡都在同一个文件里，换机器拷一个文件即可

`src/background/knowledge.js` 的 `lookup()` 增加了可选的 `records` 参数：桌面端传入文件里的记录，
插件不传、走归档库 —— 业务逻辑没有分叉。

## 已验证的 chrome shim 边界

界面侧只需要 7 个 API（`runtime.sendMessage / lastError / getManifest / getURL`、`storage.local`、`tabs.onActivated / onUpdated`）。
`preload.js` 全部顶住了；`tabs` 的监听是空实现，桌面端没有标签页事件。

> `sandbox: false` 是必须的 —— Electron 默认的 sandbox 会限制 preload 里的 `require`，
> 实测报 `module not found: node:path`，随后 `window.chrome` 根本没注入，界面初始化中断。
