// eval/run.mjs · 用**生产的消化链路**跑一遍评测集（支持重复多轮）
//
// 这里最关键的一点：直接 import 生产代码的 `digestDocument`，
// 不另写一份「评测专用」的调用。否则分数反映的是那个副本，不是产品 ——
// 对外说「分类准确率 90%」时，一问「你评的是哪份实现」就穿了。
//
// digest.js 是给浏览器写的，用 `chrome.runtime.getURL` 读 shared/ 下的配置。
// 在 Node 里补一个最小的替代（读的仍是仓库里同一份文件），其余逻辑原样复用。
//
// **为什么要 --repeat**：实测同一条用例、不改任何东西连跑两次会得到不同的分类 ——
// 模型是随机的，单次结果撑不起结论。跑 N 轮之后每条用例能分成三类：
//   稳定通过 / 稳定失败 / **翻转**（时对时错）
// 翻转的那些信息量最大：它们精确指出「判据的哪句话没兜住」。
//
// 用法：
//   node eval/run.mjs                   跑一轮
//   node eval/run.mjs --repeat 3        跑三轮（推荐，约 18 分钟）
//   node eval/run.mjs --only id1,id2    只跑指定用例
//
// 产物：eval/results.json —— **每轮结束就落盘**（中途看得见进度，被打断也不丢已跑的轮次）
// 指标由 eval/score.py 算（跑分与打分分开）

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATASET = path.join(ROOT, 'eval/dataset');
const OUT = path.join(ROOT, 'eval/results.json');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const ONLY = opt('only', '') ? opt('only', '').split(',').map((s) => s.trim()) : null;
const REPEAT = Math.max(1, Number(opt('repeat', 1)) || 1);

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

const { digestDocument } = await import(
  `file:///${path.join(ROOT, 'src/background/digest.js').replace(/\\/g, '/')}`
);

const dataset = JSON.parse(fs.readFileSync(path.join(DATASET, 'cases.json'), 'utf8'));
const cases = ONLY ? dataset.cases.filter((c) => ONLY.includes(c.id)) : dataset.cases;

// 开跑前先确认模型在，否则十几次超时很难看
try {
  const tags = await realFetch('http://127.0.0.1:11434/api/tags');
  if (!tags.ok) throw new Error(String(tags.status));
} catch (err) {
  console.log(`❌ Ollama 没在跑（${err.message}）。先启动它再跑评测。`);
  process.exit(1);
}

console.log(
  `评测 ${cases.length} 篇 × ${REPEAT} 轮 · 模型由 shared/prompt.json 决定` +
    (REPEAT > 1 ? `（约 ${Math.round((cases.length * REPEAT * 14) / 60)} 分钟）` : '')
);

const startedAll = Date.now();

// 每条用例收集 N 轮的结果
const rows = cases.map((c) => {
  const textPath = path.join(DATASET, c.text);
  const missing = !fs.existsSync(textPath);
  return {
    id: c.id,
    title: c.title,
    url: c.url,
    source: c.source,
    expect: c.expect,
    textPath,
    chars: missing ? 0 : fs.readFileSync(textPath, 'utf8').length,
    missing,
    runs: []
  };
});

// 版本信息先读好 —— 每次落盘都要带上（分数必须能对上哪版 prompt / schema）
const prompt = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/prompt.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/output-schema.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// 落盘。partial=true 表示还有轮次没跑完（verdict 尚未计算，字段为 null）。
function writeOut(partial = false) {
  const payload = {
    _comment:
      'eval/run.mjs 的原始产物。指标由 score.py 算（跑分与打分分开，结果可复算）。每条用例的 runs 是重复运行的多轮结果。',
    meta: {
      ranAt: new Date().toISOString(),
      elapsedSec: Number(((Date.now() - startedAll) / 1000).toFixed(0)),
      partial,
      repeat: REPEAT,
      model: prompt.model?.name || '',
      promptVersion: prompt.version,
      schemaVersion: schema.version,
      extensionVersion: manifest.version,
      caseCount: cases.length
    },
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      source: r.source,
      expect: r.expect,
      chars: r.chars,
      runs: r.runs,
      validRuns: r.validRuns ?? null,
      passes: r.passes ?? null,
      verdict: r.verdict ?? null
    }))
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

for (let round = 0; round < REPEAT; round++) {
  if (REPEAT > 1) console.log(`\n───── 第 ${round + 1}/${REPEAT} 轮 ─────`);

  for (const row of rows) {
    if (row.missing) {
      row.runs.push({ ok: false, error: '缺正文快照', got: null });
      continue;
    }

    const text = fs.readFileSync(row.textPath, 'utf8');
    const t0 = Date.now();

    let out;
    try {
      out = await digestDocument({ title: row.title, url: row.url, text });
    } catch (err) {
      out = { ok: false, error: err?.message || String(err) };
    }

    const elapsedMs = Date.now() - t0;
    const got = !out.ok
      ? null
      : out.value?.ok === false
        ? { ok: false, category: null, summary: '', points: [], reason: out.value.reason || null }
        : {
            ok: true,
            category: out.value.category || null,
            summary: out.value.summary || '',
            points: out.value.points || []
          };

    row.runs.push({
      ok: out.ok,
      error: out.ok ? null : out.error || '消化失败',
      elapsedMs,
      attempts: out.attempts?.length || 0,
      got
    });

    // 单轮时逐条打印；多轮时太吵，只在每轮结束报一句
    if (REPEAT === 1) {
      const hit = got && got.ok && got.category === row.expect.category;
      const mark = !got ? '❌' : got.ok === false ? '⛔' : hit ? '✅' : '⚠️ ';
      console.log(
        `  ${mark} ${row.id.padEnd(20)} ${String(Math.round(elapsedMs / 1000)).padStart(3)}s  ` +
          `期望 ${String(row.expect.category).padEnd(6)} 得到 ${String(got?.category || (got?.ok === false ? 'ok:false' : '—')).padEnd(6)}`
      );
    }
  }

  if (REPEAT > 1) {
    console.log(`  本轮完成 ${rows.filter((r) => !r.missing).length} 条`);
    writeOut(true); // 每轮落盘 —— 中途看得见，被打断也不丢
  }
}

// ---- 派生「多轮判定」----
// 这是这次升级的核心产出：把「这条对不对」变成「这条稳不稳定」。
// 通过口径按用例类型分开 —— 负样本通过 = 被判 ok:false；正样本通过 = 分类与金标准一致。
for (const row of rows) {
  const valid = row.runs.filter((r) => r.ok && r.got);

  row.validRuns = valid.length;
  row.passes = valid.filter((r) =>
    row.expect.ok === false ? r.got.ok === false : r.got.ok && r.got.category === row.expect.category
  ).length;

  if (!valid.length) row.verdict = 'error';
  else if (row.passes === valid.length) row.verdict = 'stable-pass';
  else if (row.passes === 0) row.verdict = 'stable-fail';
  else row.verdict = 'flip';
}

const totalSec = ((Date.now() - startedAll) / 1000).toFixed(0);

if (REPEAT > 1) {
  const pick = (v) => rows.filter((r) => r.verdict === v);
  const flip = pick('flip');
  const fail = pick('stable-fail');

  console.log('\n───── 多轮判定 ─────');
  console.log(`  稳定通过 ${pick('stable-pass').length} 条`);
  console.log(`  稳定失败 ${fail.length} 条${fail.length ? '：' + fail.map((r) => r.id).join(', ') : ''}`);
  console.log(`  **翻转 ${flip.length} 条**${flip.length ? '：' + flip.map((r) => r.id).join(', ') : ''}`);
  if (flip.length) console.log('  （翻转的最值得改判据 —— 它们精确指出哪句话没兜住）');

  // 每轮单独的一致率 —— 轮次之间的差值就是「随机性有多大」
  console.log('\n  每轮单独的一致率：');
  for (let i = 0; i < REPEAT; i++) {
    let h = 0;
    let t = 0;
    for (const r of rows) {
      if (!r.expect.ok) continue;
      const run = r.runs[i];
      if (!run || !run.ok || !run.got || run.got.ok === false) continue;
      t += 1;
      if (run.got.category === r.expect.category) h += 1;
    }
    if (t) console.log(`    第 ${i + 1} 轮 ${h}/${t} = ${((h / t) * 100).toFixed(0)}%`);
  }
}

writeOut(false);

console.log(`\n总耗时 ${totalSec}s（${REPEAT} 轮），结果写入 eval/results.json`);
console.log('下一句：python eval/score.py');
