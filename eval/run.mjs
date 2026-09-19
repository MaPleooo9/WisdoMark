// eval/run.mjs · 用**生产的消化链路**跑一遍评测集
//
// 这里最关键的一点：直接 import 生产代码的 `digestDocument`，
// 不另写一份「评测专用」的调用。否则分数反映的是那个副本，不是产品 ——
// 对外说「分类准确率 90%」时，一问「你评的是哪份实现」就穿了。
//
// digest.js 是给浏览器写的，用 `chrome.runtime.getURL` 读 shared/ 下的配置。
// 在 Node 里补一个最小的替代（读的仍是仓库里同一份文件），其余逻辑原样复用。
//
// 用法：
//   node eval/run.mjs              跑全部
//   node eval/run.mjs --only id1,id2
//
// 产物：eval/results.json —— 原始结果，指标由 eval/score.py 算（跑分与打分分开）

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATASET = path.join(ROOT, 'eval/dataset');
const OUT = path.join(ROOT, 'eval/results.json');

const argv = process.argv.slice(2);
const onlyArg = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(',').map((s) => s.trim()) : null;
})();

// ---- 给生产代码补上 Node 里缺的那点东西 ----
globalThis.chrome = { runtime: { getURL: (p) => p } };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.startsWith('shared/')) {
    const text = fs.readFileSync(path.join(ROOT, url), 'utf8');
    return { ok: true, json: async () => JSON.parse(text) };
  }
  return realFetch(url, opts);
};

const { digestDocument } = await import(`file:///${path.join(ROOT, 'src/background/digest.js').replace(/\\/g, '/')}`);

const dataset = JSON.parse(fs.readFileSync(path.join(DATASET, 'cases.json'), 'utf8'));
const cases = onlyArg ? dataset.cases.filter((c) => onlyArg.includes(c.id)) : dataset.cases;

// 开跑前先确认模型在，否则十次超时很难看
try {
  const tags = await realFetch('http://127.0.0.1:11434/api/tags');
  if (!tags.ok) throw new Error(String(tags.status));
} catch (err) {
  console.log(`❌ Ollama 没在跑（${err.message}）。先启动它再跑评测。`);
  process.exit(1);
}

console.log(`评测 ${cases.length} 篇 · 模型由 shared/prompt.json 决定 · 逐条跑\n`);

const results = [];
const startedAll = Date.now();

for (const [i, c] of cases.entries()) {
  const textPath = path.join(DATASET, c.text);

  if (!fs.existsSync(textPath)) {
    results.push({ id: c.id, ok: false, error: '缺正文快照，先跑 eval/fetch.mjs' });
    console.log(`  ❌ ${c.id.padEnd(18)} 缺正文快照`);
    continue;
  }

  const text = fs.readFileSync(textPath, 'utf8');
  const t0 = Date.now();

  let out;
  try {
    out = await digestDocument({ title: c.title, url: c.url, text });
  } catch (err) {
    out = { ok: false, error: err?.message || String(err) };
  }

  const elapsed = Date.now() - t0;

  results.push({
    id: c.id,
    title: c.title,
    url: c.url,
    source: c.source,
    expect: c.expect,
    chars: text.length,
    elapsedMs: elapsed,
    attempts: out.attempts?.length || 0,
    ok: !!out.ok,
    error: out.ok ? null : out.error || '消化失败',
    got: out.ok
      ? {
          ok: out.value.ok,
          category: out.value.category || null,
          summary: out.value.summary || '',
          points: out.value.points || [],
          reason: out.value.reason || null
        }
      : null
  });

  const r = results[results.length - 1];
  const hit = r.got && r.got.ok !== false && r.got.category === c.expect.category;
  const mark = !r.got ? '❌' : r.got.ok === false ? '⛔' : hit ? '✅' : '⚠️ ';

  console.log(
    `  ${mark} ${c.id.padEnd(18)} ${String(Math.round(elapsed / 1000)).padStart(3)}s  ` +
      `期望 ${String(c.expect.category).padEnd(6)} 得到 ${String(r.got?.category || (r.got?.ok === false ? 'ok:false' : '—')).padEnd(6)} ` +
      `${r.attempts > 1 ? `（重试 ${r.attempts - 1} 次）` : ''}`
  );
}

const totalSec = ((Date.now() - startedAll) / 1000).toFixed(0);

// 版本信息一起存下来 —— 分数必须能对上「哪版 prompt / 哪版 schema」
const prompt = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/prompt.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/output-schema.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const payload = {
  _comment: 'eval/run.mjs 的原始产物。指标由 score.py 算 —— 跑分与打分分开，结果可复算。',
  meta: {
    ranAt: new Date().toISOString(),
    elapsedSec: Number(totalSec),
    model: prompt.model?.name || '',
    promptVersion: prompt.version,
    schemaVersion: schema.version,
    extensionVersion: manifest.version,
    caseCount: cases.length
  },
  results
};

fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log(`\n总耗时 ${totalSec}s，结果写入 eval/results.json`);
console.log(`下一句：python eval/score.py`);
