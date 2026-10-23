// 验证 9：桌面端的诊断 trace。
//
// 要证两件事：
//   1. 成功的消化把 trace 挂进了归档记录（调了几次 / 耗时 / token），且能经 SEARCH_ARCHIVE 传到界面
//   2. 失败诊断日志的通道是通的（手工塞一条，能从 GET_FAILURES 读回、能清空）
//
// 跑法：npx electron verify-trace.js
const { app } = require('electron');
const path = require('node:path');

app.setPath('userData', 'C:/Users/Mapleooo/.workbuddy/tmp/wm-desktop-trace');
app.on('window-all-closed', () => {});

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

app.whenReady().then(async () => {
  try {
    await storeFile.clearArchive();
    await storeFile.clearFailures();

    console.log(`目标：${TARGET}\n抓取 + 消化中…\n`);
    const res = await handleMessage({ type: 'DIGEST_URL', url: TARGET });
    push('消化成功', res?.ok === true, JSON.stringify({ ok: res?.ok, error: res?.error }));

    const saved = await storeFile.readAllDigests();
    const trace = saved[0]?.trace;

    push('归档记录带 trace', !!trace, JSON.stringify({ has: !!trace }));
    push('记了模型调用次数', trace?.calls >= 1, String(trace?.calls));
    push('记了总耗时', typeof trace?.ms === 'number' && trace.ms > 0, `${trace?.ms} ms`);
    push('记了输入 token', typeof trace?.promptEvalCount === 'number' && trace.promptEvalCount > 0, String(trace?.promptEvalCount));
    push('每一轮带 valid 标记', Array.isArray(trace?.steps) && trace.steps.every((s) => 'valid' in s), JSON.stringify(trace?.steps?.map((s) => ({ valid: s.valid, ms: s.ms }))));

    // 界面拿到的行里也要有 trace（否则「这一条是怎么来的」还是空的）
    const search = await handleMessage({ type: 'SEARCH_ARCHIVE', keyword: '', limit: 10 });
    push('SEARCH_ARCHIVE 的 rows 带 trace', !!search?.rows?.[0]?.trace, JSON.stringify({ has: !!search?.rows?.[0]?.trace }));

    // ---- 失败日志通道 ----
    push('初始失败日志为空', (await handleMessage({ type: 'GET_FAILURES' }))?.total === 0, '0');

    await storeFile.pushFailure({
      at: Date.now(),
      url: 'https://example.com/broken',
      title: '（测试）失败样本',
      origin: 'desktop',
      error: 'Ollama 连接被拒绝',
      networkError: true,
      ms: 1200,
      calls: 2,
      extract: { charCount: 900, lowContent: false, loginWall: null, consentWall: null, foregroundFallback: false, minChars: 400 },
      attempts: [{ attempt: 1, ms: 1200, valid: false, errors: ['connect ECONNREFUSED'], rawPreview: '{"ok":' }],
    });

    const failures = await handleMessage({ type: 'GET_FAILURES' });
    push('GET_FAILURES 读到 1 条', failures?.total === 1, String(failures?.total));
    push('失败条目带抓取侧诊断', !!failures?.failures?.[0]?.extract?.charCount, JSON.stringify(failures?.failures?.[0]?.extract));
    push('失败条目带原始输出预览', !!failures?.failures?.[0]?.attempts?.[0]?.rawPreview, String(failures?.failures?.[0]?.attempts?.[0]?.rawPreview));

    const cleared = await handleMessage({ type: 'CLEAR_FAILURES' });
    push('CLEAR_FAILURES 清空', (await handleMessage({ type: 'GET_FAILURES' }))?.total === 0, JSON.stringify(cleared));

    await storeFile.clearArchive();
    console.log(`\n${results.filter((r) => r.pass).length}/${results.length} 通过`);
    app.exit(results.every((r) => r.pass) ? 0 : 1);
  } catch (err) {
    console.log(`[verify-trace] FAIL — ${err.stack || err.message}`);
    app.exit(1);
  }
});
