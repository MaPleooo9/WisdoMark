// 验证 1：Electron 能不能起一个窗口。
// 不弹窗（show:false），加载一个内联页面，确认 did-finish-load 触发后退出。
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800 });
  win.loadURL('data:text/html,<h1>wisdomark</h1>');

  win.webContents.once('did-finish-load', () => {
    console.log('[verify-window] OK — 窗口创建并加载完成');
    app.quit();
  });

  win.webContents.once('did-fail-load', (_e, code, desc) => {
    console.log(`[verify-window] FAIL — ${code} ${desc}`);
    app.exit(1);
  });
});
