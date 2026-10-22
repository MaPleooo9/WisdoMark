// WisdoMark · 本地归档库（IndexedDB）
//
// 为什么不继续用 chrome.storage.local：
//   storage.local 是纯 KV，适合存「最后一条结果」这类零星状态。
//   归档库要按时间列、按分类筛、按关键词搜，还要装下几十上百条 —— KV 得
//   把整个数组读出来再自己筛，条目一多就难看。
//   IndexedDB 有索引、能游标分页，且不需要任何额外权限。
//
// 这一层最要紧的职责是**去重**：
//   同一篇文章从不同入口进来时 URL 会带不同的跟踪参数 ——
//   B 站「搜索进来的」是 `?from=search&spm_id_from=333.337.0.0`，
//   「分享出来的」又是一串 share_*。不归一化的话，收藏夹里同一篇文章会被
//   消化三次、存三遍，后面的画像和清单都会跟着偏。
//
// service worker 会被浏览器随时回收，所以这里不缓存任何业务状态：
// 连接对象是可以重建的，数据一律在 IndexedDB 里。

const DB_NAME = 'wisdomark';
// v2：加了 byTime 复合索引（分页续读要用，见 searchDigests 的说明）
// v3：加 concepts 对象仓库（桌面端知识库的概念卡；与归档同库，便于按文章回查）
const DB_VERSION = 3;
const STORE = 'digests';
const CONCEPTS = 'concepts';

// 纯来源标记的参数，删掉不影响内容本身。
// 取舍偏保守：**宁可多列几个已知的跟踪参数，也不要因为一个参数不同就把
// 同一篇文章存成两条** —— 漏合并只让用户看到重复，误合并会真的丢内容，
// 所以这里只收「名字本身就说明它是来源标记」的参数，不碰 id / page 这类
// 可能承载内容定位的参数。
const TRACKING_PARAMS = new Set([
  // 通用分析参数
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name',
  'fbclid', 'gclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', 'spm_id_from', 'spm',
  'vd_source', 'share_source', 'share_medium', 'share_plat', 'share_tag', 'share_session_id',
  'share_times', 'from_source', 'from_spmid', 'unique_k', 'bbdown', 'timestamp',
  // 机翻页面自带的语言标记
  '_x_tr_sl', '_x_tr_tl', '_x_tr_hl', '_x_tr_pto'
]);

// `from` 只在 B 站当来源标记用（`?from=search`），别的站点它可能有实际含义，
// 所以按域名限定，不做全局删除。
const SITE_PARAMS = [
  { host: /(^|\.)bilibili\.com$/i, params: ['from'] }
];

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

// 归一化 URL，得到去重键。
// 统一掉的都是「同一个页面」的不同写法，不改变指向的内容：
//   协议（http/https 常互相跳转）、主机名大小写、默认端口、末尾斜杠、
//   锚点（# 只是页内位置）、跟踪参数（且排序，避免顺序不同被当成两个）
export function dedupeKey(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return value; // 不是标准 URL（file: / chrome: 等）就原样当键
  }

  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  if (parsed.port === '80' || parsed.port === '443') parsed.port = '';

  const dropped = new Set(TRACKING_PARAMS);
  for (const { host, params } of SITE_PARAMS) {
    if (host.test(parsed.hostname)) params.forEach((p) => dropped.add(p));
  }

  const kept = [...parsed.searchParams.entries()]
    .filter(([k]) => !dropped.has(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  parsed.search = '';
  for (const [k, v] of kept) parsed.searchParams.append(k, v);

  // 末尾斜杠去掉，`/a/` 和 `/a` 是同一页；但根路径必须保留成 `/`
  const path = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = path || '/';

  return parsed.toString();
}

// ---------------------------------------------------------------------------
// IndexedDB 连接
// ---------------------------------------------------------------------------

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      // v1 → v2 升级时对象仓库已经存在，所以要拿到它再补索引，
      // 不能像新建时那样直接 createObjectStore（那会抛「已存在」）
      const store = db.objectStoreNames.contains(STORE)
        ? req.transaction.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: 'key' });

      if (!store.indexNames.contains('digestedAt')) store.createIndex('digestedAt', 'digestedAt');
      if (!store.indexNames.contains('category')) store.createIndex('category', 'category');

      // 复合索引 [digestedAt, key]：分页续读要靠它拿全序。
      // 只用 digestedAt 会丢记录 —— 同一毫秒连续写多条时时间相同，
      // 而续读的条件是「严格小于上一页最后一条的时间」，那些同时间、
      // 排在后面的记录会被整个跳过（实测 35 条只翻出 34 条）。
      // 加上主键之后每条记录的键都唯一，游标就有了全序，不重不漏。
      if (!store.indexNames.contains('byTime')) store.createIndex('byTime', ['digestedAt', 'key']);

      // v3：概念卡仓库。key 是归一化后的 term（同一个词只留一张卡）。
      // 与 digests 分仓库而不是塞进归档记录 —— 一张卡可以引用多篇文章，
      // 塞进任意一篇都会让「这张卡属于谁」变得含糊。
      if (!db.objectStoreNames.contains(CONCEPTS)) {
        const concepts = db.createObjectStore(CONCEPTS, { keyPath: 'key' });
        concepts.createIndex('updatedAt', 'updatedAt');
        concepts.createIndex('term', 'term');
      }
    };

    // 升级被别的连接挡住时（比如另一个窗口开着旧版侧栏）会一直等下去。
    // 记一条日志，至少排查时有据可依。
    req.onblocked = () => {
      console.warn('[WisdoMark] 归档库升级被占用，请关掉其它已经打开的侧栏后重试');
    };

    req.onsuccess = () => {
      const db = req.result;
      // 浏览器回收 worker、或扩展升级导致版本变化时连接会失效。
      // 不把缓存的 promise 清掉的话，后续每次调用都会拿到一个废连接，
      // 表现是「归档莫名其妙一直失败」，且不会自愈。
      db.onclose = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });

  return dbPromise;
}

// 把「开事务 → 跑操作 → 等事务真正提交」包成一次 Promise。
// 注意等的是 t.oncomplete 而不是 request.onsuccess —— 后者只说明这条记录
// 写进了事务，事务仍可能回滚。
function withStoreNamed(name, mode, work) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(name, mode);
        let out;

        try {
          out = work(t.objectStore(name));
        } catch (err) {
          try {
            t.abort();
          } catch {
            /* 事务可能已经结束，忽略 */
          }
          reject(err);
          return;
        }

        t.oncomplete = () => {
          // IDBRequest 取 result，游标收集出来的数组直接用
          resolve(out && typeof out === 'object' && 'result' in out ? out.result : out);
        };
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

// digests 的常用别名 —— 绝大多数调用只碰归档库
function withStore(mode, work) {
  return withStoreNamed(STORE, mode, work);
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

export async function getDigest(rawUrl) {
  const key = dedupeKey(rawUrl);
  if (!key) return null;

  return (await withStore('readonly', (s) => s.get(key))) || null;
}

export async function countDigests() {
  return (await withStore('readonly', (s) => s.count())) || 0;
}

// 按「最近消化」倒序取。游标取够 limit 条就停，不 continue 了 ——
// 事务会自然结束，不必把整个库读出来再切。
export async function listDigests({ limit = 50 } = {}) {
  const rows = await withStore('readonly', (s) => {
    const out = [];
    const req = s.index('digestedAt').openCursor(null, 'prev');

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return;
      out.push(cursor.value);
      cursor.continue();
    };

    return out;
  });

  return rows || [];
}

// 归档搜索：关键词 + 分类筛选，带分页。
//
// 搜的是「标题 + 摘要」，**不搜 points** —— 要点动辄几百字，把它也搜进去会让
// 「正文里顺带提了一句」的内容大量命中，噪音换来的召回不划算。
//
// 分页用「上一页最后一条的 [消化时间, 主键]」当游标，而不是 offset：
// offset 在库里有新内容写进来时会错位（同一条出现两次、或者漏掉一条）。
//
// 为什么游标要带上主键：digestedAt 是 Date.now()，**同一毫秒连续写多条会撞时间**
// （批量消化就是连续写库），只按时间切页会漏掉「时间相同、排在后面」的记录。
// 实测：35 条里只翻出 34 条。加上主键之后每条记录的索引键都唯一，游标有全序，不重不漏。
// 用法上多取一条来判断「还有没有更多」—— 比再单独查一次 count 便宜。
export async function searchDigests({ keyword = '', category = '', limit = 30, before = null } = {}) {
  const kw = String(keyword || '').trim().toLowerCase();
  const cat = String(category || '').trim();

  const rows = await withStore('readonly', (s) => {
    const out = [];
    const range =
      before?.time != null ? IDBKeyRange.upperBound([before.time, before.key], true) : null;
    const req = s.index('byTime').openCursor(range, 'prev');

    req.onsuccess = () => {
      const cursor = req.result;
      // 多取一条：out.length 到 limit + 1 就说明后面还有
      if (!cursor || out.length > limit) return;
      const row = cursor.value;
      if (matchesArchiveQuery(row, kw, cat)) out.push(row);
      cursor.continue();
    };

    return out;
  });

  const list = rows || [];
  const hasMore = list.length > limit;
  const page = hasMore ? list.slice(0, limit) : list;
  const last = page[page.length - 1];

  return {
    rows: page,
    hasMore,
    nextBefore: last ? { time: last.digestedAt, key: last.key } : null
  };
}

function matchesArchiveQuery(row, kw, cat) {
  // 没分类的老记录归到「未分类」，和界面上的选项对齐
  if (cat && (row.category || '未分类') !== cat) return false;
  if (!kw) return true;

  return `${row.title || ''}\n${row.summary || ''}`.toLowerCase().includes(kw);
}

// 列出「分类体系比当前旧的」记录 —— 重新分类只处理这些。
//
// 判断依据是记录自己带的 promptVersion，不引入任何外部状态：
// 改了 prompt 并升版本号，老记录就自动变成"待更新"；
// 重跑过的记录会写入新版本号，于是**中断后再点一次会自动跳过已处理的**。
//
// 顺序按最近消化倒序（走的还是 byTime 索引），让刚看过的内容先被校正。
export async function listStaleDigests({ version = '', limit = 0 } = {}) {
  const cur = String(version || '');

  const rows = await withStore('readonly', (s) => {
    const out = [];
    const req = s.index('byTime').openCursor(null, 'prev');

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || (limit > 0 && out.length >= limit)) return;
      const row = cursor.value;
      if ((row.promptVersion || '') !== cur) out.push(row);
      cursor.continue();
    };

    return out;
  });

  return rows || [];
}

// 写一条归档。同 URL 覆盖而非新增，并累计消化次数。
//
// 「先读再写」分成两次事务 —— 单看这一步是有竞态的，但消息路由是串行处理
// （service worker 里同一时刻只会跑一个 handler），实际不会并发到同一个键上。
export async function saveDigest(record = {}) {
  const key = dedupeKey(record.url);
  if (!key) return { ok: false, error: '这条结果没有可归档的链接' };

  const now = Date.now();
  const prev = await getDigest(record.url);

  const next = {
    key,
    url: record.url || '',
    title: record.title || '(无标题)',
    host: hostOf(record.url),
    category: record.category || null,
    summary: record.summary || '',
    points: Array.isArray(record.points) ? record.points : [],
    charCount: record.charCount || 0,
    // 正文全文（0.20.0）。此前归档只有摘要 + 要点，原文抓完就丢；
    // 「搜索即建卡」要在全文里找定义句，所以必须留下来。
    // 老记录读到的是 undefined —— 检索侧按「无全文」处理，不假装有。
    text: record.text || '',
    model: record.model || '',
    // 写库时用的是哪一版分类体系。「重新分类」靠它筛出过期的记录 ——
    // 改了 prompt 并升版本号之后，老记录会自动变成「待更新」，
    // 不需要额外维护任何状态；也因此中断后重来不会重复处理。
    promptVersion: record.promptVersion || '',
    attempts: record.attempts || 0,
    // 阶段 4 的 trace：这次消化花多久、调了几次模型、耗了多少 token。
    // 不存模型原始输出（几 KB），只存每轮的耗时 / 校验结果 / 错误 / token —— 见 trace.js。
    // 老记录没有这个字段（读到的是 undefined），UI 要能容错。
    trace: record.trace || null,
    ocr: record.ocr || null,
    // 首次消化的时间不动 —— 「这篇是什么时候进来的」和「上次重读是什么时候」
    // 是两个问题，画像和清单都更关心前者
    firstDigestedAt: prev?.firstDigestedAt || now,
    digestedAt: now,
    digestCount: (prev?.digestCount || 0) + 1
  };

  await withStore('readwrite', (s) => s.put(next));

  return {
    ok: true,
    isNew: !prev,
    digestCount: next.digestCount,
    key,
    total: await countDigests()
  };
}

export async function clearArchive() {
  await withStore('readwrite', (s) => s.clear());
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 备份与迁移（导出 / 导入）
// ---------------------------------------------------------------------------
//
// 数据只在本机 IndexedDB 里：换机器、重装扩展、清空浏览器数据都会丢。
// 导出一份 JSON 带走；导入时**合并**而不是替换 —— 见 importDigests 的说明。

// 导入条数上限。导入文件是外部输入（可能手改过、也可能来自别的版本），
// 上限挡的是畸形数据，不是正常使用 —— 20,000 条远超单机实际规模。
export const MAX_IMPORT_RECORDS = 20000;

// 全量读库（导出用）。与 listDigests 的取舍相反：
// 那边是给界面翻页的，取够 limit 就停；这边要的是「一份完整副本」，所以一次走完游标。
// 按消化时间升序，导出的文件里顺序稳定，便于人工比对。
export async function readAllDigests() {
  const rows = await withStore('readonly', (s) => {
    const out = [];
    const req = s.index('byTime').openCursor(null, 'next');

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      out.push(cursor.value);
      cursor.continue();
    };

    return out;
  });

  return rows || [];
}

// 一条导入记录 → 库里的记录形状。没有可用链接就返回 null，由调用方计数跳过。
//
// key 一律**重算**，不信文件里那个：去重规则会随版本演进，而且手改过的文件
// 完全可以塞一个和 url 对不上的 key，那样会绕过去重、在库里造出重复条目。
function normalizeImported(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  const key = url ? dedupeKey(url) : '';
  if (!key) return null;

  const str = (v) => (typeof v === 'string' ? v : '');
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

  const at = num(raw.digestedAt) || Date.now();

  return {
    key,
    url,
    title: str(raw.title) || '(无标题)',
    host: hostOf(url),
    category: typeof raw.category === 'string' ? raw.category : null,
    summary: str(raw.summary),
    points: Array.isArray(raw.points) ? raw.points.filter((p) => typeof p === 'string' && p) : [],
    charCount: num(raw.charCount),
    // v1 备份没有这个字段 —— 读出来是空串，检索时按「无全文」处理。
    // 不能因为缺字段就把整条记录判无效：备份的主要价值是摘要与要点。
    text: str(raw.text),
    model: str(raw.model),
    promptVersion: str(raw.promptVersion),
    attempts: num(raw.attempts),
    // trace / ocr 是排查用的附加数据，形状对就带着走
    trace: obj(raw.trace),
    ocr: obj(raw.ocr),
    firstDigestedAt: num(raw.firstDigestedAt) || at,
    digestedAt: at,
    digestCount: num(raw.digestCount) > 0 ? num(raw.digestCount) : 1
  };
}

// 同一条链接本地已有、且导入的那份更新时：内容用导入的，但两个**累计字段**
// 不能跟着变小 ——
//   firstDigestedAt 取较早的（「这篇什么时候进来的」只有一个答案）
//   digestCount 取较大的（导入不该把「读过几次」改小）
function mergeIntoLocal(local, incoming) {
  return {
    ...incoming,
    key: local.key,
    firstDigestedAt: Math.min(
      local.firstDigestedAt || incoming.firstDigestedAt,
      incoming.firstDigestedAt || local.firstDigestedAt
    ),
    digestCount: Math.max(local.digestCount || 1, incoming.digestCount || 1)
  };
}

// 导入：按链接去重合并。
//
// **为什么不直接替换**：导入的多半是「另一台机器上的旧备份」。
// 替换会把本地已经重新消化过的记录打回旧版本 —— 用户要的是「把缺的补回来」，
// 不是「回到备份那天」。所以规则是：
//   本地没有       → 新增
//   本地有、导入更新 → 覆盖内容（累计字段取更完整的）
//   本地有、导入更旧 → 跳过（本地那份更好）
//
// 全程一个事务：先 getAll 建现有记录的索引，再逐条 put。
// 既省掉逐条开事务，也不会出现「读到一半、库被改了」的中间态。
export async function importDigests(records = []) {
  const list = Array.isArray(records) ? records : [];

  const normalized = [];
  let invalid = 0;
  for (const raw of list) {
    const rec = normalizeImported(raw);
    if (rec) normalized.push(rec);
    else invalid += 1;
  }

  const stats = { added: 0, updated: 0, skipped: 0, invalid };

  await withStore('readwrite', (s) => {
    const req = s.getAll();

    req.onsuccess = () => {
      const existing = new Map((req.result || []).map((r) => [r.key, r]));

      for (const rec of normalized) {
        const local = existing.get(rec.key);

        if (!local) {
          s.put(rec);
          stats.added += 1;
        } else if (rec.digestedAt > local.digestedAt) {
          s.put(mergeIntoLocal(local, rec));
          stats.updated += 1;
        } else {
          stats.skipped += 1;
        }
      }
    };

    return stats;
  });

  return stats;
}

// ---------------------------------------------------------------------------
// 概念卡（v3 / 0.21.0）
// ---------------------------------------------------------------------------
//
// 「搜索即建卡」的产物：用户搜一个词 → 从归档全文里找到解释它的段落 →
// 用户确认 → 存一张卡。卡是**缓存**，不是前提 —— 没搜过的词不会建卡。
//
// key 用归一化后的 term：同一个词只留一张卡；别名放在 aliases 里参与检索。
// 归一化只做全半角 / 大小写 / 空白，**不做语义合并** ——「RAG 和检索增强生成
// 是不是同一个东西」交给用户判断（卡片里可以手动加别名）。

export function conceptKey(term) {
  return String(term || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

function normalizeConcept(card = {}) {
  const key = conceptKey(card.term);
  if (!key) return null;

  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    key,
    term: String(card.term || '').trim(),
    aliases: Array.isArray(card.aliases)
      ? card.aliases.map((a) => String(a || '').trim()).filter(Boolean).slice(0, 12)
      : [],
    rewrite: str(card.rewrite).slice(0, 2000),
    quote: str(card.quote).slice(0, 4000),
    source: card.source && typeof card.source === 'object' ? card.source : null,
    model: str(card.model),
    confirmed: card.confirmed === true,
    createdAt: 0,
    updatedAt: 0
  };
}

export async function saveConcept(card = {}) {
  const base = normalizeConcept(card);
  if (!base) return { ok: false, error: '缺少概念名' };

  const prev = await getConcept(base.key);
  const now = Date.now();
  const next = { ...base, createdAt: prev?.createdAt || now, updatedAt: now };

  await withStoreNamed(CONCEPTS, 'readwrite', (s) => s.put(next));
  return { ok: true, isNew: !prev, key: base.key };
}

export async function getConcept(key) {
  const k = conceptKey(key);
  if (!k) return null;
  return (await withStoreNamed(CONCEPTS, 'readonly', (s) => s.get(k))) || null;
}

export async function listConcepts({ limit = 200 } = {}) {
  const rows = await withStoreNamed(CONCEPTS, 'readonly', (s) => {
    const out = [];
    const req = s.index('updatedAt').openCursor(null, 'prev');

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return;
      out.push(cursor.value);
      cursor.continue();
    };

    return out;
  });

  return rows || [];
}

export async function deleteConcept(key) {
  const k = conceptKey(key);
  if (!k) return { ok: false, error: '缺少概念名' };
  await withStoreNamed(CONCEPTS, 'readwrite', (s) => s.delete(k));
  return { ok: true, key: k };
}

export async function clearConcepts() {
  await withStoreNamed(CONCEPTS, 'readwrite', (s) => s.clear());
  return { ok: true };
}
