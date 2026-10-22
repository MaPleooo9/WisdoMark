// 验证 6：IPC 全链路 —— 渲染进程的 chrome.runtime.sendMessage → preload → 主进程 handler。
//
// 关键：这里 require 的是 **handlers.js**，与 main.js 同一份实现。
// （早期版本复制了一份精简 handler 来测，那测的是假货 —— 已改掉。）
//
// 跑法：npx electron verify-ipc.js
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// 用临时 userData，别污染真实数据
app.setPath('userData', 'C:/Users/Mapleooo/.workbuddy/tmp/wm-desktop-ipc');

const { handleMessage } = require('./handlers.js');
const storeFile = require('./store-file.js');

const results = [];
const push = (label, pass, got) => {
  results.push({ label, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${got ? `\n       got = ${got}` : ''}`);
};

app.whenReady().then(async () => {
  ipcMain.handle('wm:message', (_e, msg) => handleMessage(msg));
  await storeFile.clearArchive();

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (...args) => {
    const message = args[1] && typeof args[1] === 'object' ? args[1].message : args[2];
    if (message && /error|undefined/i.test(message)) console.log('[renderer]', message);
  });

  try {
    await win.loadFile(path.join(ROOT, 'src', 'sidepanel', 'sidepanel.html'));
    await new Promise((r) => setTimeout(r, 3000));

    const hasChrome = await win.webContents.executeJavaScript(
      `typeof chrome !== 'undefined' && typeof chrome.runtime.sendMessage === 'function'`
    );
    push('渲染进程里有 chrome.runtime.sendMessage', hasChrome === true, String(hasChrome));

    const ping = await win.webContents.executeJavaScript(
      `chrome.runtime.sendMessage({ type: 'PING_OLLAMA' })`
    );
    push('PING_OLLAMA 经 IPC 返回', ping?.ok === true, JSON.stringify({ ok: ping?.ok, models: ping?.models?.length }));

    const demo = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'demo-archive.json'), 'utf8'));
    await win.webContents.executeJavaScript(`window.__demoRecords = ${JSON.stringify(demo.records)}; 0`);
    const imported = await win.webContents.executeJavaScript(
      `chrome.runtime.sendMessage({ type: 'IMPORT_ARCHIVE', records: window.__demoRecords })`
    );
    push('IMPORT_ARCHIVE 经 IPC 导入 4 篇', imported?.ok === true && imported.added === 4, JSON.stringify(imported));

    const search = await win.webContents.executeJavaScript(
      `chrome.runtime.sendMessage({ type: 'SEARCH_ARCHIVE', keyword: '', limit: 30 })`
    );
    push('SEARCH_ARCHIVE 返回 4 条', search?.ok === true && search.rows?.length === 4, String(search?.rows?.length));

    const lookup = await win.webContents.executeJavaScript(
      `chrome.runtime.sendMessage({ type: 'LOOKUP_TERM', term: 'Token' })`
    );
    push('LOOKUP_TERM 返回候选', lookup?.ok === true && lookup.candidates?.length > 0, String(lookup?.candidates?.length));
    push(
      '候选第一条是定义段',
      /计量单位|中文名/.test(lookup?.candidates?.[0]?.text || ''),
      String(lookup?.candidates?.[0]?.text || '').slice(0, 40)
    );

    await storeFile.clearArchive();
    console.log(`\n${results.filter((r) => r.pass).length}/${results.length} 通过`);
    app.exit(results.every((r) => r.pass) ? 0 : 1);
  } catch (err) {
    console.log(`[verify-ipc] FAIL — ${err.stack || err.message}`);
    app.exit(1);
  }
});
