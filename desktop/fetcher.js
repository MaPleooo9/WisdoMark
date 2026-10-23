// 主进程抓取：隐藏 BrowserWindow 加载目标页 → 注入 content-script → 取正文。
//
// 复用 src/content/content-script.js（与插件同一份），不重写提取逻辑。
// 已验证（verify-fetch.js）：小黑盒 924 字、5 张图、无登录墙。
const { BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'src', 'content', 'content-script.js');

// SPA 渲染稳定要时间。插件里是 6 秒前台兜底，这里给 7 秒。
const WAIT_MS = 7000;

// Electron 默认 UA 带 "Electron" 字样，部分站点会拦；伪装成普通 Chrome。
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// 同一时刻只抓一个 —— 桌面端是单人使用，抢网络没意义，反而更难排查
let busy = false;

async function fetchPage(url) {
  if (busy) return { ok: false, error: '正在抓取上一页，请稍候' };
  busy = true;

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1000,
    webPreferences: {
      // 抓的是外部网页 —— 这里必须隔离（与主窗口的 contextIsolation:false 不同）
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: true,
      images: true,
    },
  });

  try {
    win.webContents.setUserAgent(USER_AGENT);
    await win.loadURL(url);
    await new Promise((r) => setTimeout(r, WAIT_MS));

    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    // 脚本完成值是 window.__wisdomark（含函数），会被序列化成 "could not be cloned"，
    // 末尾补 ;0 压成原始类型。
    await win.webContents.executeJavaScript(`${code}\n;0`);

    const raw = await win.webContents.executeJavaScript(
      `JSON.stringify(window.__wisdomark && typeof window.__wisdomark.extract === 'function'
        ? window.__wisdomark.extract()
        : null)`
    );

    if (!raw || raw === 'null') {
      return { ok: false, error: '抓取脚本没有挂上（window.__wisdomark 不存在）' };
    }

    const out = JSON.parse(raw);
    return {
      ok: true,
      title: out.title || '',
      url: out.url || url,
      text: out.text || '',
      charCount: out.charCount || 0,
      images: out.images || [],
      loginWall: out.loginWall || null,
      consentWall: out.consentWall || null,
    };
  } catch (err) {
    return { ok: false, error: `抓取失败：${err?.message || err}` };
  } finally {
    try {
      win.destroy();
    } catch {
      /* 窗口可能已经因为页面崩溃被回收 */
    }
    busy = false;
  }
}

module.exports = { fetchPage };
