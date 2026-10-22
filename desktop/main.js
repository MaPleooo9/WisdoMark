// WisdoMark Desktop · 主进程
//
// 架构：
//   渲染进程 = 原样加载的 src/sidepanel/（preload 注入 chrome shim）
//   主进程   = 消息处理（handlers.js）+ 存储（store-file.js）+ 模型调用（Ollama）
//   抓取     = 隐藏 BrowserWindow 注入 content-script（下一步接）
//
// 存储为什么不用 IndexedDB：主进程没有这个 API。见 store-file.js 的说明。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { handleMessage } = require('./handlers.js');

const ROOT = path.join(__dirname, '..');
const SIDEPANEL = path.join(ROOT, 'src', 'sidepanel', 'sidepanel.html');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    title: 'WisdoMark Desktop',
    backgroundColor: '#fafafa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 桌面端只加载本地页面；抓取窗口是单独的、隔离的
      contextIsolation: false,
      nodeIntegration: false,
      // preload 要 require('path')，sandbox 会限制掉
      sandbox: false,
    },
  });

  win.loadFile(SIDEPANEL);

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
