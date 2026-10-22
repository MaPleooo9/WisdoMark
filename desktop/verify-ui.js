// 验证 4：侧栏界面能不能在 Electron 窗口里原样加载。
//
// 只证明「显示」这件事：窗口加载 sidepanel.html → 初始化跑完 → DOM 里五个 tab / 六个 pane 都在。
// 业务功能还没接（大部分消息会回「暂未接入」），这一步先确保界面不崩。
//
// 跑法：npx electron verify-ui.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

async function handleMessage(msg) {
  const type = msg?.type || '';
  try {
    if (type === 'PING_OLLAMA') {
      const { pingOllama } = await import(
        pathToFileURL(path.join(ROOT, 'src', 'background', 'llm.js')).href
      );
      return await pingOllama();
    }
    if (type === 'GET_ACTIVE_TAB') return { ok: false, error: '桌面端没有活动标签页' };
    if (type === 'GET_LAST_DIGEST') return { ok: true, digest: null };
    if (type === 'GET_ARCHIVE_STATS') return { ok: true, total: 0, latest: null };
    return { ok: false, error: `桌面端暂未接入：${type}` };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

app.whenReady().then(async () => {
  ipcMain.handle('wm:message', (_e, msg) => handleMessage(msg));

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

  const rendererLogs = [];
  win.webContents.on('console-message', (...args) => {
    const message = args[1] && typeof args[1] === 'object' ? args[1].message : args[2];
    if (message) {
      rendererLogs.push(message);
      console.log('[renderer]', message);
    }
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('[verify-ui] FAIL — 渲染进程崩溃', JSON.stringify(details));
    app.exit(1);
  });

  try {
    await win.loadFile(path.join(ROOT, 'src', 'sidepanel', 'sidepanel.html'));
    await new Promise((r) => setTimeout(r, 5000));

    const raw = await win.webContents.executeJavaScript(`JSON.stringify({
      title: document.title,
      tabs: [...document.querySelectorAll('.tab')].map(t => t.textContent.trim()),
      panes: [...document.querySelectorAll('.pane')].map(p => p.id),
      ollamaLabel: document.getElementById('ollama-label')?.textContent || '',
      stage: document.getElementById('stage-badge')?.textContent || '',
      kbSearchExists: !!document.getElementById('btn-kb-search'),
      bodyLength: document.body.innerText.length
    })`);
    const info = JSON.parse(raw);

    console.log('\n=== 界面状态 ===');
    console.log(JSON.stringify(info, null, 2));

    const ok =
      info.tabs.length >= 6 &&
      info.panes.length >= 6 &&
      info.kbSearchExists === true &&
      // bodyLength 只能量到「当前可见面板」——其余 pane 是 display:none，
      // innerText 不计入，所以不能拿它判断界面完整度。
      info.bodyLength > 100 &&
      info.ollamaLabel !== '检测中…' &&
      info.stage !== '—';

    console.log(ok ? '\n[verify-ui] PASS — 界面加载完成' : '\n[verify-ui] FAIL — 界面不完整');
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.log(`[verify-ui] FAIL — ${err.stack || err.message}`);
    app.exit(1);
  }
});
