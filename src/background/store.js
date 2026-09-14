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
const DB_VERSION = 1;
const STORE = 'digests';

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
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('digestedAt', 'digestedAt');
        store.createIndex('category', 'category');
      }
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
function withStore(mode, work) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        let out;

        try {
          out = work(t.objectStore(STORE));
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
    model: record.model || '',
    attempts: record.attempts || 0,
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
