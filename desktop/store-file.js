// 桌面端的存储层：接口与 src/background/store.js 对齐，数据落本地 JSON。
//
// 为什么不直接复用 store.js：它建在 IndexedDB 上，**主进程没有这个 API**。
// 渲染进程有，但让主进程通过 IPC 远程指挥渲染进程读写太绕。
// 单机个人知识库的数据量（几百条归档 + 几百张卡）用 JSON 文件完全够，
// 而且换机器只要拷一个文件。
//
// 去重规则（dedupeKey / conceptKey）仍然从 store.js 引入 —— 不复制一份，避免两边漂移。
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// 与 handlers.js 保持一致：用 __dirname 在不在 asar 里判断。
// 之前这里还是 path.join(__dirname,'..')，打包后少一层 app-src，
// 报 "Cannot find module ...\resources\src\background\store.js"（2026-10-23）。
const ROOT = __dirname.includes('app.asar')
  ? path.join(process.resourcesPath, 'app-src')
  : path.join(__dirname, '..');

let storeMod = null;
async function loadStoreModule() {
  if (!storeMod) {
    storeMod = await import(pathToFileURL(path.join(ROOT, 'src', 'background', 'store.js')).href);
  }
  return storeMod;
}

let cachedPath = null;
function dataPath() {
  if (!cachedPath) {
    cachedPath = path.join(app.getPath('userData'), 'wisdomark', 'data.json');
  }
  return cachedPath;
}

function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
    return {
      digests: Array.isArray(raw.digests) ? raw.digests : [],
      concepts: Array.isArray(raw.concepts) ? raw.concepts : [],
    };
  } catch {
    return { digests: [], concepts: [] };
  }
}

function writeAll(data) {
  fs.mkdirSync(path.dirname(dataPath()), { recursive: true });
  fs.writeFileSync(dataPath(), JSON.stringify(data, null, 2), 'utf8');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 归档
// ---------------------------------------------------------------------------

async function countDigests() {
  return readAll().digests.length;
}

async function readAllDigests() {
  return readAll().digests.slice().sort((a, b) => a.digestedAt - b.digestedAt);
}

async function getDigest(rawUrl) {
  const { dedupeKey } = await loadStoreModule();
  const key = dedupeKey(rawUrl);
  if (!key) return null;
  return readAll().digests.find((d) => d.key === key) || null;
}

async function saveDigest(record = {}) {
  const { dedupeKey } = await loadStoreModule();
  const key = dedupeKey(record.url);
  if (!key) return { ok: false, error: '这条结果没有可归档的链接' };

  const data = readAll();
  const idx = data.digests.findIndex((d) => d.key === key);
  const prev = idx >= 0 ? data.digests[idx] : null;
  const now = Date.now();

  const next = {
    key,
    url: record.url || '',
    title: record.title || '(无标题)',
    host: hostOf(record.url),
    category: record.category || null,
    summary: record.summary || '',
    points: Array.isArray(record.points) ? record.points : [],
    charCount: record.charCount || 0,
    text: record.text || '',
    model: record.model || '',
    promptVersion: record.promptVersion || '',
    attempts: record.attempts || 0,
    trace: record.trace || null,
    ocr: record.ocr || null,
    firstDigestedAt: prev?.firstDigestedAt || now,
    digestedAt: now,
    digestCount: (prev?.digestCount || 0) + 1,
  };

  if (idx >= 0) data.digests[idx] = next;
  else data.digests.push(next);
  writeAll(data);

  return { ok: true, isNew: !prev, digestCount: next.digestCount, key, total: data.digests.length };
}

async function searchDigests({ keyword = '', category = '', limit = 30, before = null } = {}) {
  const kw = String(keyword || '').trim().toLowerCase();
  const cat = String(category || '').trim();

  let rows = readAll().digests.filter((r) => {
    if (cat && (r.category || '未分类') !== cat) return false;
    if (!kw) return true;
    return `${r.title || ''}\n${r.summary || ''}`.toLowerCase().includes(kw);
  });

  rows.sort((a, b) => b.digestedAt - a.digestedAt);

  if (before && before.time != null) {
    rows = rows.filter(
      (r) => r.digestedAt < before.time || (r.digestedAt === before.time && r.key < before.key)
    );
  }

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    hasMore: rows.length > limit,
    nextBefore: last ? { time: last.digestedAt, key: last.key } : null,
  };
}

async function importDigests(records = []) {
  const { dedupeKey } = await loadStoreModule();
  const list = Array.isArray(records) ? records : [];
  const data = readAll();
  const stats = { added: 0, updated: 0, skipped: 0, invalid: 0 };

  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      stats.invalid += 1;
      continue;
    }
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    const key = url ? dedupeKey(url) : '';
    if (!key) {
      stats.invalid += 1;
      continue;
    }

    const idx = data.digests.findIndex((d) => d.key === key);
    const local = idx >= 0 ? data.digests[idx] : null;
    const at = Number.isFinite(raw.digestedAt) ? raw.digestedAt : Date.now();

    const rec = {
      key,
      url,
      title: typeof raw.title === 'string' && raw.title ? raw.title : '(无标题)',
      host: hostOf(url),
      category: typeof raw.category === 'string' ? raw.category : null,
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      points: Array.isArray(raw.points) ? raw.points.filter((p) => typeof p === 'string' && p) : [],
      charCount: Number.isFinite(raw.charCount) ? raw.charCount : 0,
      text: typeof raw.text === 'string' ? raw.text : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      promptVersion: typeof raw.promptVersion === 'string' ? raw.promptVersion : '',
      attempts: Number.isFinite(raw.attempts) ? raw.attempts : 0,
      trace: raw.trace && typeof raw.trace === 'object' ? raw.trace : null,
      ocr: raw.ocr && typeof raw.ocr === 'object' ? raw.ocr : null,
      firstDigestedAt: Number.isFinite(raw.firstDigestedAt) ? raw.firstDigestedAt : at,
      digestedAt: at,
      digestCount: Number.isFinite(raw.digestCount) && raw.digestCount > 0 ? raw.digestCount : 1,
    };

    if (!local) {
      data.digests.push(rec);
      stats.added += 1;
    } else if (rec.digestedAt > local.digestedAt) {
      data.digests[idx] = {
        ...rec,
        firstDigestedAt: Math.min(local.firstDigestedAt || rec.firstDigestedAt, rec.firstDigestedAt),
        digestCount: Math.max(local.digestCount || 1, rec.digestCount || 1),
      };
      stats.updated += 1;
    } else {
      stats.skipped += 1;
    }
  }

  writeAll(data);
  return stats;
}

async function clearArchive() {
  const data = readAll();
  data.digests = [];
  writeAll(data);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 概念卡
// ---------------------------------------------------------------------------

async function listConcepts({ limit = 200 } = {}) {
  return readAll()
    .concepts.slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

async function getConcept(key) {
  const { conceptKey } = await loadStoreModule();
  const k = conceptKey(key);
  if (!k) return null;
  return readAll().concepts.find((c) => c.key === k) || null;
}

async function saveConcept(card = {}) {
  const { conceptKey } = await loadStoreModule();
  const key = conceptKey(card.term);
  if (!key) return { ok: false, error: '缺少概念名' };

  const data = readAll();
  const idx = data.concepts.findIndex((c) => c.key === key);
  const prev = idx >= 0 ? data.concepts[idx] : null;
  const now = Date.now();

  const next = {
    key,
    term: String(card.term || '').trim(),
    aliases: Array.isArray(card.aliases) ? card.aliases.filter((a) => typeof a === 'string' && a.trim()) : [],
    rewrite: String(card.rewrite || ''),
    quote: String(card.quote || ''),
    source: card.source && typeof card.source === 'object' ? card.source : null,
    model: String(card.model || ''),
    confirmed: card.confirmed === true,
    createdAt: prev?.createdAt || now,
    updatedAt: now,
  };

  if (idx >= 0) data.concepts[idx] = next;
  else data.concepts.push(next);
  writeAll(data);

  return { ok: true, isNew: !prev, key };
}

async function deleteConcept(key) {
  const { conceptKey } = await loadStoreModule();
  const k = conceptKey(key);
  if (!k) return { ok: false, error: '缺少概念名' };
  const data = readAll();
  data.concepts = data.concepts.filter((c) => c.key !== k);
  writeAll(data);
  return { ok: true, key: k };
}

module.exports = {
  dataPath,
  countDigests,
  readAllDigests,
  getDigest,
  saveDigest,
  searchDigests,
  importDigests,
  clearArchive,
  listConcepts,
  getConcept,
  saveConcept,
  deleteConcept,
};
