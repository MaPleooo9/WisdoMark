// Electron 渲染进程的 chrome.* shim
//
// 侧栏代码（src/sidepanel/）原本跑在扩展里，依赖 7 个 chrome API。
// 这里用最小实现顶住，让界面能原样加载；真正的业务消息转发给主进程。
//
// 注意：主窗口用 contextIsolation:false —— 桌面端只加载本地页面，不加载外部内容。
// 抓取用的隐藏窗口是单独的（contextIsolation:true），不共用这份 shim。
const { ipcRenderer } = require('electron');
// 用不带 `node:` 前缀的写法：sandbox 模式下的 preload 对 `node:` 前缀解析不稳定
// （实测报 "module not found: node:path"）。
const path = require('path');
const { pathToFileURL } = require('url');

// 界面徽标显示的版本号从根 manifest.json 读，不硬编码。
// 之前写死 '0.23.0'，与实际版本对不上，属于「界面在说假话」。
const extManifest = require('../manifest.json');

const ROOT = path.join(__dirname, '..');

// storage.local：用 localStorage 兜住。
// 侧栏里两种风格都有 —— 回调式 get(keys, cb) 和 Promise 式 set(...).catch()。
function readKeys(keys) {
  const list =
    keys == null
      ? Object.keys(localStorage)
      : Array.isArray(keys)
        ? keys
        : typeof keys === 'string'
          ? [keys]
          : Object.keys(keys || {});

  const out = {};
  for (const k of list) {
    const raw = localStorage.getItem(k);
    if (raw != null) {
      try {
        out[k] = JSON.parse(raw);
      } catch {
        out[k] = raw;
      }
    }
  }
  return out;
}

const storageLocal = {
  get(keys, cb) {
    const result = readKeys(keys);
    if (typeof cb === 'function') {
      setTimeout(() => cb(result), 0);
      return undefined;
    }
    return Promise.resolve(result);
  },
  set(obj, cb) {
    for (const [k, v] of Object.entries(obj || {})) {
      localStorage.setItem(k, JSON.stringify(v));
    }
    if (typeof cb === 'function') setTimeout(cb, 0);
    return Promise.resolve();
  },
  remove(keys, cb) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) localStorage.removeItem(k);
    if (typeof cb === 'function') setTimeout(cb, 0);
    return Promise.resolve();
  },
};

const chromeShim = {
  runtime: {
    lastError: undefined,
    id: 'wisdomark-desktop',
    getManifest: () => ({ version: extManifest.version, name: 'WisdoMark Desktop' }),
    getURL: (relative) => pathToFileURL(path.join(ROOT, relative)).href,
    // 核心：所有业务消息转给主进程
    sendMessage(msg, cb) {
      const p = ipcRenderer.invoke('wm:message', msg);
      if (typeof cb === 'function') {
        p.then((resp) => cb(resp)).catch((err) => {
          chromeShim.runtime.lastError = { message: err?.message || String(err) };
          cb(undefined);
        });
        return undefined;
      }
      return p;
    },
    // 桌面端没有「别的扩展给我发消息」这回事
    onMessage: { addListener() {} },
  },
  storage: { local: storageLocal },
  // 桌面端没有标签页事件；stub 掉，避免绑定时报 undefined
  tabs: {
    onActivated: { addListener() {} },
    onUpdated: { addListener() {} },
  },
};

window.chrome = chromeShim;
