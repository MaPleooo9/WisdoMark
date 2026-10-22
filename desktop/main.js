// WisdoMark Desktop · 验证阶段的最小壳
//
// 现在只证明「Electron 能起窗口」；真正的界面下一步复用 src/sidepanel/。
// 抓取与消化的可行性已由 verify-*.js 验证（见 README）。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    title: 'WisdoMark Desktop',
    backgroundColor: '#fafafa',
    webPreferences: { contextIsolation: true },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
