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
const { handleMessage, ROOT } = require('./handlers.js');

// 用户双击 exe 启动时不会有任何命令行参数，所以「验证用的那串参数」必须写进代码。
// 不加的后果：部分机器 / 虚拟机 / 远程桌面里 GPU 进程直接崩
// （GPU process exited unexpectedly: exit_code=-1073741819 → FATAL: GPU process isn't usable）。
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('in-process-gpu');

const SIDEPANEL = path.join(ROOT, 'src', 'sidepanel', 'sidepanel.html');
const extManifest = require(path.join(ROOT, 'manifest.json'));

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

  // 打包后出问题时，这两条日志是唯一线索（GUI 程序没有终端输出）
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.log('[preload-error]', preloadPath, error?.message || error);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('[render-gone]', JSON.stringify(details));
  });

  return win;
}

app.whenReady().then(() => {
  ipcMain.handle('wm:message', (_event, msg) => handleMessage(msg));
  // preload 同步取版本（见 preload.js 的 getManifest）
  ipcMain.on('wm:manifest', (event) => {
    event.returnValue = { version: extManifest.version, name: 'WisdoMark Desktop' };
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
