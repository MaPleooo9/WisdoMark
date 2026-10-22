// 验证 5：桌面端的数据层（文件存储 + 知识库检索 + 建卡）。
//
// 不走 IPC —— 直接调 store-file.js 与 knowledge.js，确认「换了存储介质之后，
// 业务逻辑仍然成立」。IPC 那一层由 verify-ui / 实际窗口覆盖。
//
// 跑法：npx electron verify-data.js
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { pathToFileURL, fileURLToPath } = require('node:url');

const ROOT = path.join(__dirname, '..');

// 用临时 userData，别污染真实数据
app.setPath('userData', 'C:/Users/Mapleooo/.workbuddy/tmp/wm-desktop-verify');

globalThis.chrome = {
  runtime: { getURL: (relative) => pathToFileURL(path.join(ROOT, relative)).href },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const s = String(url);
  if (s.startsWith('file://')) {
    const text = await fsp.readFile(fileURLToPath(s), 'utf8');
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, opts);
};

const storeFile = require('./store-file.js');

const results = [];
const push = (label, pass, got) => {
  results.push({ label, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${got ? `\n       got = ${got}` : ''}`);
};

app.whenReady().then(async () => {
  try {
    await storeFile.clearArchive();

    const demo = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'demo-archive.json'), 'utf8'));
    const stats = await storeFile.importDigests(demo.records);
    push('导入演示数据 4 篇', stats.added === 4, JSON.stringify(stats));

    const search = await storeFile.searchDigests({ limit: 30 });
    push('归档列表读到 4 条', search.rows.length === 4, String(search.rows.length));
    push('按消化时间倒序', search.rows[0]?.digestedAt >= search.rows[1]?.digestedAt, String(search.rows[0]?.title));

    const kw = await storeFile.searchDigests({ keyword: '剪贴板', limit: 30 });
    push('关键词搜索命中', kw.rows.length >= 1, String(kw.rows.length));

    const knowledge = await import(
      pathToFileURL(path.join(ROOT, 'src', 'background', 'knowledge.js')).href
    );
    const shared = await import(
      pathToFileURL(path.join(ROOT, 'src', 'background', 'shared.js')).href
    );

    const records = await storeFile.readAllDigests();
    const lookup = await knowledge.lookup('Token', { records });
    push('知识库搜 Token 有候选', lookup.ok && lookup.candidates.length > 0, String(lookup.candidates.length));
    push(
      '第一条是定义段',
      /计量单位|中文名/.test(lookup.candidates[0]?.text || ''),
      String(lookup.candidates[0]?.text || '').slice(0, 40)
    );

    const { prompt } = await shared.loadShared();
    const card = await knowledge.buildCard({
      term: 'Token',
      candidate: lookup.candidates[0],
      modelCfg: prompt.model,
    });
    push('建卡（真实模型）', card.ok === true && !!card.quote, JSON.stringify({ ok: card.ok, err: card.modelError }));

    await storeFile.saveConcept({
      term: card.term,
      aliases: card.aliases,
      rewrite: card.rewrite,
      quote: card.quote,
      source: card.source,
      confirmed: true,
    });
    const cards = await storeFile.listConcepts();
    push('概念卡落库', cards.length === 1 && cards[0].term === 'Token', String(cards.length));

    // 清理
    await storeFile.clearArchive();
    await storeFile.deleteConcept('Token');

    console.log(`\n${results.filter((r) => r.pass).length}/${results.length} 通过`);
    app.exit(results.every((r) => r.pass) ? 0 : 1);
  } catch (err) {
    console.log(`[verify-data] FAIL — ${err.stack || err.message}`);
    app.exit(1);
  }
});
