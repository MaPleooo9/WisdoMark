// eval/fetch.mjs · 抓评测集的正文快照
//
// **为什么存快照，而不是每次跑分现抓**
// 分数要可复现。网站改版、文章被删、登录墙变化，都会让「上周 87 分」这句话失去意义。
// 快照一次性抓下来进仓库，之后跑分只读快照 —— 输入固定，分数才可比。
//
// **为什么用无头浏览器 + 生产的 content-script**
// 提取逻辑必须是插件本身那份（src/content/content-script.js），否则评的就不是插件。
// 只有「等正文稳定」的策略是新写的（生产那份跑在 service worker 里，依赖 chrome.tabs）。
//
// 用法：
//   node eval/fetch.mjs                     抓所有缺快照的
//   node eval/fetch.mjs --only id1,id2      只抓指定几条
//   node eval/fetch.mjs --force             已有的也重抓
//   node eval/fetch.mjs --port 9480         换调试端口

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const DATASET = path.join(ROOT, 'eval/dataset');
const TEXTS = path.join(DATASET, 'texts');
const CASES = path.join(DATASET, 'cases.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(opt('port', 9480));
const ONLY = opt('only', '') ? opt('only', '').split(',').map((s) => s.trim()) : null;
const FORCE = flag('force');

const TMP = `C:/Users/Mapleooo/.workbuddy/tmp/edge-fetch-${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();

// 给无头浏览器一个正常的浏览器 UA。
// 实测：阮一峰博客对默认 UA（含无头标记 / curl）直接 403，换上正常 UA 就 200。
// 这不是「绕过反爬」——插件在真实浏览器里跑的时候用的就是正常 UA，
// 不带上它，抓取行为和插件真实行为反而不一致，评测也就偏了。
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';

const dataset = JSON.parse(fs.readFileSync(CASES, 'utf8'));

// 生产那份提取逻辑，原样注入（只把图片张数上限放开，方便看到这一页到底有多少张正文图）
const contentScript = fs
  .readFileSync(path.join(ROOT, 'src/content/content-script.js'), 'utf8')
  .replace(/const MAX_IMAGES = \d+;/, 'const MAX_IMAGES = 60;');

const targets = dataset.cases.filter((c) => {
  if (ONLY && !ONLY.includes(c.id)) return false;
  if (FORCE) return true;
  return !fs.existsSync(path.join(DATASET, c.text));
});

if (!targets.length) {
  console.log('没有需要抓的（都已有快照）。要重抓加 --force。');
  process.exit(0);
}

console.log(`准备抓 ${targets.length} 篇：${targets.map((t) => t.id).join(', ')}\n`);

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}`,
  `--user-agent=${USER_AGENT}`, 'about:blank'
], { stdio: 'ignore', detached: true });

process.on('exit', () => {
  try { spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

function connect(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    ws.addEventListener('open', () => resolve({
      send: (method, params = {}) => new Promise((res) => {
        const mid = ++id; pending.set(mid, res);
        ws.send(JSON.stringify({ id: mid, method, params }));
      }),
      close: () => ws.close()
    }));
  });
}

let version = null;
for (let i = 0; i < 40; i++) {
  try { version = await j('/json/version'); break; } catch {}
  await sleep(400);
}
if (!version) { console.log('❌ 无头浏览器没起来'); process.exit(1); }

const browser = await connect(version.webSocketDebuggerUrl);

// 等正文稳定 —— 和 page.js 同一套思路：只要还在变长就继续等，
// 但返回的是**文本最长的那一次**，避免结尾抖动反而取到更短的。
async function fetchOne(url) {
  const created = await browser.send('Target.createTarget', { url });
  const targetId = created.result.targetId;

  let target = null;
  for (let i = 0; i < 40; i++) {
    const list = await j('/json/list');
    target = list.find((t) => t.id === targetId);
    if (target?.webSocketDebuggerUrl) break;
    await sleep(250);
  }
  if (!target) return { ok: false, error: '标签页没连上' };

  const page = await connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.bringToFront').catch(() => {});
  await sleep(600);
  await page.send('Runtime.evaluate', { expression: contentScript });

  const startedAt = Date.now();
  let best = null;
  let lastLen = -1;
  let lastChangeAt = Date.now();

  while (Date.now() - startedAt < 28000) {
    await sleep(400);

    const r = await page.send('Runtime.evaluate', {
      expression: 'window.__wisdomark ? window.__wisdomark.extract() : null',
      returnByValue: true
    }).catch(() => null);

    const v = r?.result?.result?.value;
    if (!v?.ok) continue;

    if (!best || v.text.length > best.text.length) best = v;

    if (v.text.length !== lastLen) {
      lastLen = v.text.length;
      lastChangeAt = Date.now();
      continue;
    }
    if (Date.now() - lastChangeAt < 1200) continue;
    if (v.text.length >= 400) break;
    // 一直很短：可能是登录墙或纯图页面，别耗满 28 秒
    if (Date.now() - startedAt > 12000) break;
  }

  page.close();
  await browser.send('Target.closeTarget', { targetId }).catch(() => {});
  return best || { ok: false, error: '没能读到正文' };
}

const report = [];

for (const item of targets) {
  const r = await fetchOne(item.url);

  if (!r.ok || !r.text) {
    report.push({ ...item, chars: 0, status: 'fail', detail: r.error || '正文为空' });
    console.log(`  ❌ ${item.id.padEnd(18)} 抓不到（${r.error || '正文为空'}）`);
    continue;
  }

  fs.writeFileSync(path.join(DATASET, item.text), r.text, 'utf8');

  // 收藏时标题只有站名的那种，用抓到的真标题补上
  if ((item.title || '').includes('待抓取确认') && r.title) {
    item.title = r.title;
  }

  const low = r.text.length < 400;
  report.push({ ...item, chars: r.text.length, status: low ? 'low' : 'ok', detail: r.title });

  console.log(
    `  ${low ? '⚠️ ' : '✅'} ${item.id.padEnd(18)} ${String(r.text.length).padStart(6)} 字  ${r.title || ''}`
  );
  if (r.loginWall?.hit) console.log(`        （识别成登录墙：${r.loginWall.reason}）`);
}

// 标题有更新的话写回 cases.json
const updated = JSON.stringify(dataset, null, 2) + '\n';
const before = fs.readFileSync(CASES, 'utf8');
if (updated !== before) {
  fs.writeFileSync(CASES, updated, 'utf8');
  console.log('\n（cases.json 里的占位标题已用抓到的真实标题补上）');
}

const okCount = report.filter((r) => r.status === 'ok').length;
const lowCount = report.filter((r) => r.status === 'low').length;
const failCount = report.filter((r) => r.status === 'fail').length;

console.log(`\n完成：${okCount} 篇正常、${lowCount} 篇正文过短、${failCount} 篇抓不到`);
console.log(`快照目录：eval/dataset/texts/`);
process.exit(0);
