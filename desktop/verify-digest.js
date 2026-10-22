// 验证 3：Electron 里能不能跑通「抓取 → 消化」全链路。
//
// 复用：
//   - src/content/content-script.js  → 抓正文
//   - src/background/digest.js       → 消化（校验 + 重试 + trace）
//   - shared/prompt.json / output-schema.json → 与插件同一份
//
// 唯一需要适配的是 shared.js 读配置的方式：它用 chrome.runtime.getURL + fetch。
// 这里 shim 一个 file:// 版本的 chrome.runtime + fetch，业务代码一行没改。
//
// 跑法：npx electron verify-digest.js [url]
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'src', 'content', 'content-script.js');
const TARGET =
  process.argv.find((a) => /^https?:\/\//i.test(a)) ||
  'https://www.xiaoheihe.cn/app/bbs/link/06af727385cd';

// ---- shim：让 shared.js 以为自己在扩展里 ----
globalThis.chrome = {
  runtime: {
    getURL: (relative) => pathToFileURL(path.join(ROOT, relative)).href,
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const s = String(url);
  if (s.startsWith('file://')) {
    const text = await fsp.readFile(fileURLToPath(s), 'utf8');
    return new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(url, opts);
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 1000 });

  try {
    await win.loadURL(TARGET);
    await new Promise((r) => setTimeout(r, 7000));

    // 1. 抓正文（复用 content-script）
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    await win.webContents.executeJavaScript(`${code}\n;0`);
    const raw = await win.webContents.executeJavaScript('JSON.stringify(window.__wisdomark.extract())');
    const captured = JSON.parse(raw);

    console.log(`[capture] ${captured.charCount} 字 · ${captured.images.length} 张图 · ${captured.title}`);

    // 2. 消化（复用 digest.js）
    const digestUrl = pathToFileURL(path.join(ROOT, 'src', 'background', 'digest.js')).href;
    const { digestDocument } = await import(digestUrl);
    const res = await digestDocument({
      title: captured.title,
      url: captured.url,
      text: captured.text,
    });

    console.log(
      JSON.stringify(
        {
          ok: res.ok,
          error: res.error || null,
          category: res.value?.category,
          summary: res.value?.summary,
          points: Array.isArray(res.value?.points) ? res.value.points.length : 0,
          attempts: Array.isArray(res.attempts) ? res.attempts.length : 0,
          usedChars: res.source?.usedChars,
          model: res.meta?.model,
        },
        null,
        2
      )
    );

    console.log(res.ok ? '[verify-digest] PASS — 抓取 + 消化全链路跑通' : '[verify-digest] FAIL');
    app.exit(res.ok ? 0 : 1);
  } catch (err) {
    console.log(`[verify-digest] FAIL — ${err.stack || err.message}`);
    app.exit(1);
  }
});
