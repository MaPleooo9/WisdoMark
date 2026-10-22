# WisdoMark Desktop（验证阶段）

桌面端目标：**贴网址就消化** + 本地知识库，复用扩展已有的抓取与消化链路，不重写业务逻辑。

## 现在验证到哪

| 验证 | 脚本 | 结果 |
|---|---|---|
| Electron 能创建窗口 | `verify-window.js` | ✅ 通过 |
| 复用 `content-script.js` 抓 SPA 正文 | `verify-fetch.js` | ✅ 小黑盒 924 字、5 张图、无登录墙 |
| 复用 `digest.js` 完成消化 | `verify-digest.js` | ✅ 分类「生活常识」、摘要 + 10 条要点、一次通过 |
| 侧栏界面原样加载 | `verify-ui.js` | ✅ 6 个 tab / 6 个 pane / Ollama 探活正常（2 个模型） |

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

## 还没做

- **消息 handler**：界面能显示，但除了 `PING_OLLAMA`，其余消息都回「暂未接入」
- 存储：IndexedDB 在渲染进程里可用，`store.js` 可原样跑；需要把「扩展导出的 JSON」导进来
- 抓取：主进程要起隐藏的 `BrowserWindow` 执行 `content-script.js`（`verify-fetch.js` 已证明可行）
- 打包（electron-builder，暂不做）

## 已验证的 chrome shim 边界

界面侧只需要 7 个 API（`runtime.sendMessage / lastError / getManifest / getURL`、`storage.local`、`tabs.onActivated / onUpdated`）。
`preload.js` 全部顶住了；`tabs` 的监听是空实现，桌面端没有标签页事件。

> `sandbox: false` 是必须的 —— Electron 默认的 sandbox 会限制 preload 里的 `require`，
> 实测报 `module not found: node:path`，随后 `window.chrome` 根本没注入，界面初始化中断。
