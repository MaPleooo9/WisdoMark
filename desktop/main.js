// WisdoMark Desktop · 主进程
//
// 当前阶段：把 src/sidepanel/ 的界面原样加载进窗口，业务消息逐步接。
// 抓取与消化已由 verify-*.js 证明可复用；这里先解决「界面能显示」。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SIDEPANEL = path.join(ROOT, 'src', 'sidepanel', 'sidepanel.html');

// 消息处理：已接的先接，没接的明确回「暂未接入」——
// 不要返回 undefined，否则侧栏会静默以为成功，反而更难查。
async function handleMessage(msg) {
  const type = msg?.type || '';

  try {
    if (type === 'PING_OLLAMA') {
      const { pingOllama } = await import(
        pathToFileURL(path.join(ROOT, 'src', 'background', 'llm.js')).href
      );
      return await pingOllama();
    }

    if (type === 'GET_ACTIVE_TAB') {
      return { ok: false, error: '桌面端没有「活动标签页」，请用「粘贴链接」' };
    }

    if (type === 'GET_LAST_DIGEST') return { ok: true, digest: null };
    if (type === 'GET_ARCHIVE_STATS') return { ok: true, total: 0, latest: null };

    return { ok: false, error: `桌面端暂未接入：${type}` };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    title: 'WisdoMark Desktop',
    backgroundColor: '#fafafa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 桌面端只加载本地页面，没有第三方内容；抓取用的窗口是单独的、隔离的
      contextIsolation: false,
      nodeIntegration: false,
      // preload 需要 require('path') 之类的能力，sandbox 会把它限制掉
      sandbox: false,
    },
  });

  win.loadFile(SIDEPANEL);

  // 渲染进程的 console 转发到终端，方便看界面加载时的报错
  win.webContents.on('console-message', (...args) => {
    const message = args[1] && typeof args[1] === 'object' ? args[1].message : args[2];
    if (message) console.log('[renderer]', message);
  });

  return win;
}

app.whenReady().then(() => {
  ipcMain.handle('wm:message', (_event, msg) => handleMessage(msg));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
