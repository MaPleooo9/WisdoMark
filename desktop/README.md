# WisdoMark Desktop（验证阶段）

桌面端目标：**贴网址就消化** + 本地知识库，复用扩展已有的抓取与消化链路，不重写业务逻辑。

## 现在验证到哪

| 验证 | 脚本 | 结果 |
|---|---|---|
| Electron 能创建窗口 | `verify-window.js` | ✅ 通过 |
| 复用 `content-script.js` 抓 SPA 正文 | `verify-fetch.js` | ✅ 小黑盒 924 字、5 张图、无登录墙 |
| 复用 `digest.js` 完成消化 | `verify-digest.js` | ✅ 分类「生活常识」、摘要 + 10 条要点、一次通过 |

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

- 界面：复用 `src/sidepanel/`，替换 `chrome.*` 调用
- 存储：IndexedDB → 本地文件 / SQLite
- 「贴网址 → 抓取 → 消化 → 入库」的完整编排
- 归档导入（复用 `assets/demo-archive.json`）
- 打包（electron-builder，暂不做）
