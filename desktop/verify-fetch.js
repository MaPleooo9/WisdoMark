// 验证 2：Electron 能不能复用扩展的抓取链路。
//
// 做法：BrowserWindow 打开目标页（Electron 自带 Chromium）→ 等渲染稳定 →
// 注入现有的 src/content/content-script.js → 调 window.__wisdomark.extract()。
//
// 这一步过，说明「桌面端贴网址就消化」的抓取层不用重写。
//
// 跑法：npx electron verify-fetch.js [url]
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// Electron 的 process.argv 结构和 Node 不同：不能假定 argv[2] 就是 URL
// （实测这里拿到的是空串，报 ERR_INVALID_URL）。扫一遍找 http 开头的参数。
const TARGET =
  process.argv.find((a) => /^https?:\/\//i.test(a)) ||
  'https://www.xiaoheihe.cn/app/bbs/link/06af727385cd';
const SCRIPT_PATH = path.join(__dirname, '..', 'src', 'content', 'content-script.js');
const WAIT_MS = 7000; // SPA 渲染稳定；比扩展里的 6 秒前台兜底再多给一点

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 1000 });

  try {
    await win.loadURL(TARGET);
  } catch (err) {
    console.log(`[verify-fetch] FAIL — 打不开页面：${err.message}`);
    app.exit(1);
    return;
  }

  // 等正文渲染稳定（content-script 本身也有一套等待逻辑，但这里先给页面时间）
  await new Promise((r) => setTimeout(r, WAIT_MS));

  try {
    const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
    // 脚本最后一条语句的完成值是 window.__wisdomark（含函数），
    // executeJavaScript 会尝试序列化它并报 "An object could not be cloned"。
    // 末尾补一个 ;0，把完成值压成原始类型。
    await win.webContents.executeJavaScript(`${code}\n;0`);
    const raw = await win.webContents.executeJavaScript('JSON.stringify(window.__wisdomark.extract())');
    const out = JSON.parse(raw);

    console.log(
      JSON.stringify(
        {
          ok: out.ok,
          title: out.title,
          chars: out.charCount,
          images: out.images.length,
          loginWall: out.loginWall,
          consentWall: out.consentWall,
          head: String(out.text || '').slice(0, 160),
        },
        null,
        2
      )
    );

    console.log(out.charCount >= 600 ? '[verify-fetch] PASS — 抓到正文' : '[verify-fetch] FAIL — 正文不足 600 字');
    app.exit(out.charCount >= 600 ? 0 : 1);
  } catch (err) {
    console.log(`[verify-fetch] FAIL — ${err.message}`);
    app.exit(1);
  }
});
