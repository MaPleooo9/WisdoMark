// 把 electron-builder 的产物部署到 app/（可直接运行的目录）。
//
// 为什么需要这一步：electron-builder 的输出是 `out/win-unpacked/`，
// 而用户要双击的是 `app/electron.exe`。中间差一层，也差一个
// 「用官方签名的 electron.exe 替换会被 SAC 拦的 WisdoMark.exe」的动作。
//
// ⚠️ 不用 fs.cpSync：它覆盖文件的方式是「先 unlink 再写」，
// 而 app.asar 常被 IDE 的文件索引持有读句柄 —— unlink 会失败（EPIPE），
// 但直接写入内容是可以的。所以这里逐文件 copyFileSync。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'out', 'win-unpacked');
const DEST = path.join(ROOT, 'app');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(SRC)) {
  console.error(`找不到 ${SRC}，先跑 electron-builder`);
  process.exit(1);
}

let copied = 0;
function copyOver(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyOver(from, to);
    } else if (entry.name === 'WisdoMark.exe') {
      // 会被 Windows 智能应用控制拦（未签名），跳过
      continue;
    } else {
      fs.copyFileSync(from, to);
      copied += 1;
    }
  }
}

copyOver(SRC, DEST);

const target = path.join(DEST, 'electron.exe');
if (!fs.existsSync(target)) {
  fs.copyFileSync(ELECTRON, target);
  console.log('已补 electron.exe（官方签名，可绕过 SAC）');
}

console.log(`已部署 ${copied} 个文件到 ${DEST}`);
console.log('启动：', target);
