// 验证 7：贴网址就消化（桌面端全链路）。
//
// handleMessage('DIGEST_URL') → fetcher 起隐藏窗口抓正文 → digest.js 消化 → store-file 落库。
// 这是桌面端最后一块，跑通之后「贴网址 → 摘要 → 进知识库」就闭环了。
//
// 跑法：npx electron verify-digest-url.js [url]
const { app } = require('electron');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
app.setPath('userData', 'C:/Users/Mapleooo/.workbuddy/tmp/wm-desktop-digest-url');

const { handleMessage } = require('./handlers.js');
const storeFile = require('./store-file.js');

const TARGET =
  process.argv.find((a) => /^https?:\/\//i.test(a)) ||
  'https://www.xiaoheihe.cn/app/bbs/link/06af727385cd';

const results = [];
const push = (label, pass, got) => {
  results.push({ label, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${got ? `\n       got = ${got}` : ''}`);
};

// 这个脚本没有主窗口，只有 fetcher 临时建的抓取窗口。
// 窗口销毁后 Electron 默认会「所有窗口关闭 → 退出应用」，
// 后续断言根本来不及跑 —— 拦一下。
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    await storeFile.clearArchive();

    console.log(`目标：${TARGET}`);
    console.log('抓取 + 消化中（约 20–30 秒）…\n');

    const started = Date.now();
    const res = await handleMessage({ type: 'DIGEST_URL', url: TARGET });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    push('DIGEST_URL 返回成功', res?.ok === true, JSON.stringify({ ok: res?.ok, error: res?.error }));
    push('有分类', !!res?.value?.category, String(res?.value?.category || ''));
    push('摘要非空', String(res?.value?.summary || '').length > 10, String(res?.value?.summary || '').slice(0, 50));
    push('要点 ≥ 3 条', Array.isArray(res?.value?.points) && res.value.points.length >= 3, String(res?.value?.points?.length || 0));
    push('抓到 ≥600 字', (res?.source?.charCount || 0) >= 600, `${res?.source?.charCount || 0} 字`);
    push('已落库', res?.archive?.ok === true, JSON.stringify(res?.archive || {}));

    const saved = await storeFile.readAllDigests();
    push('归档里有 1 条', saved.length === 1, String(saved.length));
    push('归档带正文全文', (saved[0]?.text || '').length >= 600, `${(saved[0]?.text || '').length} 字`);

    console.log(`\n耗时 ${elapsed}s`);
    console.log(`${results.filter((r) => r.pass).length}/${results.length} 通过`);

    await storeFile.clearArchive();
    app.exit(results.every((r) => r.pass) ? 0 : 1);
  } catch (err) {
    console.log(`[verify-digest-url] FAIL — ${err.stack || err.message}`);
    app.exit(1);
  }
});
