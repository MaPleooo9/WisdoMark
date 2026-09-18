// WisdoMark · 后台服务（service worker）
//
// 只做两件事：消息路由 + 结果落 storage。
// 具体能力拆在隔壁几个模块里：
//   shared.js  读 shared/ 的 prompt 与校验规则（单一来源）
//   llm.js     本地 Ollama 调用
//   digest.js  消化流水线（校验 + 重试 + trace）
//   page.js    标签页与抓正文
//
// 注意：service worker 不是常驻进程，浏览器会在空闲时回收它。
// 任何需要跨事件存活的状态都必须落 chrome.storage，不要依赖模块级变量。

import { pingOllama } from './llm.js';
import { getActiveTab, extractActivePage, extractFromUrl } from './page.js';
import { digestDocument, rankBatch, buildProfile, buildActionPlan } from './digest.js';
import { saveDigest, countDigests, listDigests, getDigest, searchDigests, listStaleDigests } from './store.js';
import { loadShared } from './shared.js';

// ---------------------------------------------------------------------------
// 侧栏行为
// ---------------------------------------------------------------------------

// 让「点击工具栏图标」直接展开侧栏，而不是弹一个 popup。
// 该设置是持久化的，但读未打包扩展时会重置，所以在顶层再设一次（幂等）。
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[WisdoMark] 设置侧栏行为失败：', err));

// ---------------------------------------------------------------------------
// 收藏夹
// ---------------------------------------------------------------------------

const BOOKMARK_LIMIT = 20; // 「最近收藏」取多少条
const FOLDER_LIMIT = 50; // 单个收藏夹最多列多少条

// 缺 bookmarks 权限时 chrome.bookmarks 是 undefined，调用直接抛
// 「Cannot read properties of undefined」—— 用户既看不懂，也不知道该做什么。
// 实测：这条权限从阶段 0 起就一直漏着，这个入口从未成功过。所有收藏夹入口共用这一个判断。
function bookmarkApiMissing() {
  return {
    ok: false,
    error:
      'WisdoMark 还没有「收藏夹」权限。请到 edge://extensions 重新加载本扩展，' +
      '重新加载时会请求这个权限，同意后就能读取收藏了。'
  };
}

const hasBookmarkApi = () => !!(chrome.bookmarks && chrome.bookmarks.getTree);

function toItem(bookmark) {
  return {
    id: bookmark.id,
    title: bookmark.title || '(无标题)',
    url: bookmark.url,
    host: safeHost(bookmark.url),
    addedAt: bookmark.dateAdded || null
  };
}

async function getRecentBookmarks({ limit = BOOKMARK_LIMIT } = {}) {
  if (!hasBookmarkApi()) return bookmarkApiMissing();

  try {
    // getRecent 返回的是「文件夹 + 书签」混合列表，文件夹没有 url，过滤掉
    const raw = await chrome.bookmarks.getRecent(limit);
    const items = raw.filter((b) => /^https?:\/\//i.test(b.url || '')).map(toItem);

    return { ok: true, items, limit };
  } catch (err) {
    return { ok: false, error: `读取收藏夹失败：${err?.message || err}` };
  }
}

// 收藏夹树 → 扁平列表。保留 depth 是给下拉框做缩进用的 ——
// 侧栏只有三百来像素宽，塞个嵌套展开的树控件不现实，缩进的下拉最省地方。
async function getBookmarkFolders() {
  if (!hasBookmarkApi()) return bookmarkApiMissing();

  try {
    const tree = await chrome.bookmarks.getTree();
    const folders = [];

    // 根节点自己没有名字（id 就是 '0'），它的 children 才是
    // 「收藏夹栏 / 其他收藏夹 / 移动设备书签」这三项，要保留
    const walk = (nodes, depth) => {
      for (const node of nodes || []) {
        if (!node.children) continue;

        folders.push({
          id: node.id,
          title: (node.title || '').trim() || '(未命名文件夹)',
          depth,
          // 让用户在下拉里一眼看出哪些是空文件夹，不必点进去才发现
          direct: node.children.filter((c) => c.url).length,
          subFolders: node.children.filter((c) => c.children).length
        });

        walk(node.children, depth + 1);
      }
    };

    // 从根的子节点开始走：根自己（id '0'）没有名字，选它等于「全部收藏」，
    // 放进下拉只会显示成「(未命名文件夹)」让人摸不着头脑
    walk(tree[0]?.children || [], 0);
    return { ok: true, folders };
  } catch (err) {
    return { ok: false, error: `读取收藏夹列表失败：${err?.message || err}` };
  }
}

// 取某个收藏夹里的网页书签。
// 刻意连子文件夹一起收：用户选了「技术」，下面分「前端」「后端」，
// 他要的是「这个分类下的所有文章」，不是「直接躺在这个文件夹里的那几篇」。
async function getBookmarksInFolder({ folderId, limit = FOLDER_LIMIT } = {}) {
  if (!hasBookmarkApi()) return bookmarkApiMissing();
  if (!folderId) return { ok: false, error: '没有指定收藏夹' };

  try {
    const [root] = await chrome.bookmarks.getSubTree(folderId);
    if (!root) return { ok: false, error: '这个收藏夹不存在了，可能刚被删掉' };

    const found = [];
    const collect = (node) => {
      for (const child of node.children || []) {
        if (child.children) collect(child);
        else if (/^https?:\/\//i.test(child.url || '')) found.push(child);
      }
    };
    collect(root);

    // 收藏夹里的自然顺序是「加到哪算哪」，按加入时间倒序更接近「最近想看的」
    found.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));

    return {
      ok: true,
      items: found.slice(0, limit).map(toItem),
      total: found.length,
      limit
    };
  } catch (err) {
    return { ok: false, error: `读取收藏夹失败：${err?.message || err}` };
  }
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 消化
// ---------------------------------------------------------------------------

// 跑完流水线后落库。落的是完整结果（含 attempts），侧栏重开能还原，阶段 3 也用得上。
async function digestAndStore(extracted) {
  // 图文帖：正文文字太少，干货在图里。这里先不调模型 —— 把图片清单交回侧栏，
  // 由它做本地 OCR，拼进正文后再走 DIGEST_TEXT 回来。模型只被调用一次。
  if (extracted.ocr?.needed) {
    return {
      ok: true,
      needOcr: true,
      ocr: {
        images: extracted.ocr.images,
        text: extracted.text,
        title: extracted.title || '',
        url: extracted.url || '',
        source: extracted.source || '',
        imageTotal: extracted.ocr.imageTotal || extracted.ocr.images.length,
        lowContent: !!extracted.lowContent,
        foregroundFallback: !!extracted.foregroundFallback,
        minChars: extracted.minChars || null
      }
    };
  }

  const result = await digestDocument({
    title: extracted.title,
    url: extracted.url,
    text: extracted.text
  });

  const payload = {
    ...result,
    // 展开 result.source：它带着截断相关的 originalChars / usedChars，
    // 直接覆盖会导致 UI 显示「已截断 undefined → undefined 字」
    source: {
      ...(result.source || {}),
      title: extracted.title || '',
      url: extracted.url || '',
      charCount: extracted.charCount || 0,
      origin: extracted.source || ''
    },
    // 抓取侧的诊断，透传给 UI。
    // 没有它，用户看到「这一页没有可消化的正文」时无法分辨到底是
    // 「页面没渲染出正文（SPA / 登录墙）」还是「模型认为它不是内容主体」，
    // 这两种情况要说完全不同的话、给完全不同的下一步。
    extract: {
      lowContent: !!extracted.lowContent,
      keptTabOpen: !!extracted.keptTabOpen,
      foregroundFallback: !!extracted.foregroundFallback,
      minChars: extracted.minChars || null,
      // 命中说明这一页卡在登录 / 权限校验界面（url / password / captcha / text 四种原因）。
      // UI 要给的下一步和「SPA 没渲染出来」完全不同，不能混着说。
      loginWall: extracted.loginWall || null
    },
    // OCR 的账要记清楚：识别了几张、丢了几张、补了多少字。
    // 用户看到摘要变了，得能查到是因为多喂了图片文字。
    ocr: extracted.ocr || null,
    finishedAt: Date.now()
  };

  // 归档进 IndexedDB（阶段 2.2）。这是后面「批量消化 / 画像推断 /
  // 可行动清单 / 归档搜索」的共同地基 —— 没有历史记录，那四项都无处落脚。
  //
  // 归档失败不能让整次消化看起来失败：结果已经在手上，照样给用户，
  // 只在 UI 上说明这次没存上。所以这里自己吞异常，不往外抛。
  payload.archive = await archiveResult(result, payload);

  // quiet = 批量消化。此时不写「最近一次结果」：
  // 跑完一批再重开侧栏，却只看到其中最后一条的单条结果，会让人以为整批只消化了一条。
  if (!extracted.quiet) {
    await chrome.storage.local.set({ lastDigest: payload });
  }

  return payload;
}

// 一次消化 → 一条归档记录。返回给 UI 的元信息：是不是新的、第几次、库里共几篇。
async function archiveResult(result, payload) {
  // 模型判定「没有可消化正文」的不入档 —— 存进去只会污染后面的画像
  if (result?.value?.ok !== true) return null;

  try {
    const saved = await saveDigest({
      url: payload.source.url,
      title: payload.source.title,
      category: result.value.category,
      summary: result.value.summary,
      points: result.value.points,
      charCount: payload.source.charCount,
      model: result.meta?.model || '',
      // 这一条是用哪版分类体系判的 —— 见 store.js 的 listStaleDigests
      promptVersion: result.meta?.promptVersion || '',
      attempts: Array.isArray(result.attempts) ? result.attempts.length : 0,
      ocr: payload.ocr || null
    });

    if (!saved.ok) return { error: saved.error };

    return { isNew: saved.isNew, digestCount: saved.digestCount, total: saved.total };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

async function digestActivePage() {
  const { ok, tab, error } = await getActiveTab();

  if (!ok) return { ok: false, error };
  if (!tab.injectable) {
    return { ok: false, error: '当前页面不支持抓取（浏览器内部页面或扩展页面）' };
  }

  const extracted = await extractActivePage();
  if (!extracted.ok) return extracted;

  return digestAndStore(extracted);
}

async function digestUrl({ url, quiet }) {
  const target = normalizeUrl(url);

  if (!target) {
    return { ok: false, error: '请填一个 http/https 开头的链接' };
  }

  const extracted = await extractFromUrl(target);
  if (!extracted.ok) return extracted;

  // quiet 一路带到流水线：批量消化时不覆盖「最近一次结果」
  return digestAndStore({ ...extracted, quiet: !!quiet });
}

// 用户经常只粘 "example.com/a/b"，补上协议头再试
function normalizeUrl(input) {
  const value = String(input || '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+(\/|$|\?|#)/.test(value)) return `https://${value}`;
  return null;
}

// 侧栏做完 OCR 之后回来：正文已经是「原正文 + 图片文字」，直接走同一条流水线。
// 这里不再重新抓一次页面 —— 那会把用户刚等到的 OCR 结果连同样的正文又抓一遍。
async function digestText({ text, title, url, source, ocr, quiet }) {
  const merged = String(text || '');

  if (!merged.trim()) {
    return { ok: false, error: '没有可消化的正文' };
  }

  return digestAndStore({
    text: merged,
    charCount: merged.length,
    title: title || '',
    url: url || '',
    source: source || '',
    quiet: !!quiet,
    minChars: ocr?.minChars || null,
    // OCR 之后的字数要重新判一次：识别出来的文字如果够长，
    // 就不该再报「这个页面没抓到正文」
    lowContent: ocr?.minChars ? merged.length < ocr.minChars : false,
    ocr: ocr ? { ...ocr, needed: false } : null
  });
}

// 批量消化时，侧栏对每一条先问一句「这条归档里有没有」——
// 有就直接复用，不再重跑一次模型。这是「跑第二批几乎不用等」的前提。
async function getArchiveByUrl({ url }) {
  try {
    const record = await getDigest(url);
    return { ok: true, record: record || null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function getLastDigest() {
  const { lastDigest } = await chrome.storage.local.get('lastDigest');
  return { ok: true, digest: lastDigest || null };
}

// 归档搜索（2.3）。侧栏每敲一个字都会走这里，所以只返回结果列表本身 +
// 一个总数，不把每条记录整份带回去 —— points 动辄几百字，几十条一起传没有意义。
//
// 但**列表里点开某一条时要能立刻看到摘要和要点**，所以这里把要用的字段挑出来传，
// 不传的是 ocr / model / attempts 这些排查用的东西（那些用 GET_ARCHIVE_BY_URL 拿）。
async function searchArchive({ keyword = '', category = '', limit = 30, before = null } = {}) {
  try {
    const [{ prompt }, result, total] = await Promise.all([
      loadShared(),
      searchDigests({ keyword, category, limit, before }),
      countDigests()
    ]);

    return {
      ok: true,
      total,
      hasMore: result.hasMore,
      nextBefore: result.nextBefore,
      // 当前分类体系版本 —— 侧栏拿它和每条记录的版本比，判断哪些是「旧分类」
      version: prompt.version,
      rows: result.rows.map((r) => ({
        key: r.key,
        url: r.url,
        title: r.title,
        host: r.host,
        category: r.category,
        summary: r.summary,
        points: r.points || [],
        digestedAt: r.digestedAt,
        firstDigestedAt: r.firstDigestedAt,
        digestCount: r.digestCount || 1,
        promptVersion: r.promptVersion || ''
      }))
    };
  } catch (err) {
    return { ok: false, error: `读归档失败：${err?.message || err}` };
  }
}

// 重新分类：列出「分类体系比当前旧」的记录（只给 url / title，侧栏不需要别的）。
//
// 判断靠记录自身的 promptVersion，不依赖任何外部状态 ——
// 所以中途关掉侧栏、下次再点，已经重跑过的会被自动排除，不会白跑第二遍。
async function listStaleArchive() {
  try {
    const { prompt } = await loadShared();

    const rows = await listStaleDigests({ version: prompt.version });

    return {
      ok: true,
      version: prompt.version,
      count: rows.length,
      // 只回传重跑必需的两个字段 —— 几百条带摘要要点一起传没有意义
      rows: rows.map((r) => ({ url: r.url, title: r.title, category: r.category }))
    };
  } catch (err) {
    return { ok: false, error: `读归档失败：${err?.message || err}` };
  }
}

// 归档库概况。侧栏用来看「落库这件事到底有没有在工作」，
// 阶段 2.3 的归档面板和 2.4 的批量消化也从这里取数据。
async function getArchiveStats() {
  try {
    const [total, latest] = await Promise.all([countDigests(), listDigests({ limit: 1 })]);

    const head = latest?.[0] || null;
    return {
      ok: true,
      total,
      latest: head
        ? {
            title: head.title,
            url: head.url,
            category: head.category,
            digestedAt: head.digestedAt,
            digestCount: head.digestCount
          }
        : null
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// 画像（2.5）：把归档里的内容聚合成「你在关注什么、现在在哪」
// ---------------------------------------------------------------------------

// 最多看这么多条。再往前的内容反映的是「当时在关注什么」，已经过时了；
// 而且几十条的摘要合起来就不是小上下文了。
const PROFILE_SAMPLE = 40;

// 少于这个数就直接不给结论 —— 三五条内容推出来的「关注方向」纯属碰运气，
// 而用户会把它当成事实。
const PROFILE_MIN_SAMPLE = 5;

async function buildProfileNow() {
  let records;
  try {
    records = await listDigests({ limit: PROFILE_SAMPLE });
  } catch (err) {
    return { ok: false, error: `读归档失败：${err?.message || err}` };
  }

  if (records.length < PROFILE_MIN_SAMPLE) {
    return {
      ok: false,
      error:
        `归档里只有 ${records.length} 条，太少 —— 这样推出来的方向多半不准，所以先不给结论。` +
        '用「批量」消化一批，或者再消化几篇，攒够 5 条以上再来。',
      sampleCount: records.length
    };
  }

  const result = await buildProfile({
    items: records.map((r) => ({ title: r.title, category: r.category, summary: r.summary }))
  });

  if (!result.ok) return { ok: false, error: result.error, attempts: result.attempts };

  // 分类分布走代码统计：真实数字，不经过模型。模型只给定性的判断。
  const byCategory = countByCategory(records);

  const payload = {
    ok: true,
    themes: result.themes,
    level: result.level,
    stageReason: result.stageReason,
    lean: result.lean,
    summary: result.summary,
    sampleCount: records.length,
    byCategory,
    builtAt: Date.now(),
    meta: result.meta
  };

  // 落 storage：侧栏关掉重开还能看到上次的画像，不必重跑模型
  await chrome.storage.local.set({ profile: payload });
  return payload;
}

async function getProfile() {
  const { profile } = await chrome.storage.local.get('profile');
  return { ok: true, profile: profile || null };
}

// ---------------------------------------------------------------------------
// 2.6 可行动清单
// ---------------------------------------------------------------------------

// 和画像取同一批素材（最近 40 条）。两边取不同样本的话，会出现
// 「画像说他偏实操、清单却让他先读理论」这种自相矛盾。
const ACTION_SAMPLE = 40;
const ACTION_MIN_SAMPLE = 5;

// 分类分布由代码统计，不经过模型 —— 它在计数上不可靠，而且算错了没人看得出来。
// 画像卡片和清单都用到它，所以抽出来共用（两处各写一遍必然漂移）。
function countByCategory(records) {
  const byCategory = {};

  for (const r of records) {
    const key = r.category || '未分类';
    byCategory[key] = (byCategory[key] || 0) + 1;
  }

  return byCategory;
}

async function buildActionsNow() {
  let records;
  try {
    records = await listDigests({ limit: ACTION_SAMPLE });
  } catch (err) {
    return { ok: false, error: `读归档失败：${err?.message || err}` };
  }

  if (records.length < ACTION_MIN_SAMPLE) {
    return {
      ok: false,
      error:
        `归档里只有 ${records.length} 条，太少 —— 基于三五条内容提的「下一步」多半是套话。` +
        '用「批量」消化一批，或者再消化几篇，攒够 5 条以上再来。',
      sampleCount: records.length
    };
  }

  const items = records.map((r) => ({
    title: r.title,
    category: r.category,
    summary: r.summary,
    url: r.url
  }));

  // 清单必须基于画像。没算过就顺手算一份 —— 用户点的是「生成清单」，
  // 不该先被要求去点另一个按钮；画像本身也会落库，侧栏的画像卡片跟着就有了。
  const { profile: cached } = await chrome.storage.local.get('profile');

  let profile = cached;
  let profileStep = 'reused';

  if (!profile?.themes?.length) {
    const built = await buildProfile({ items });

    if (!built.ok) {
      return {
        ok: false,
        error: `生成清单前先要算出画像，那一步失败了：${built.error}`,
        stage: 'profile',
        attempts: built.attempts
      };
    }

    profileStep = 'built';
    profile = {
      ok: true,
      themes: built.themes,
      level: built.level,
      stageReason: built.stageReason,
      lean: built.lean,
      summary: built.summary,
      sampleCount: items.length,
      byCategory: countByCategory(records),
      builtAt: Date.now(),
      meta: built.meta
    };

    await chrome.storage.local.set({ profile });
  }

  const result = await buildActionPlan({ items, profile });

  if (!result.ok) {
    return { ok: false, error: result.error, stage: 'actions', attempts: result.attempts };
  }

  const payload = {
    ok: true,
    gap: result.gap,
    // 动作里的 refs 是条目序号（prompt 的列表就是这么编号的）。这里投影成界面
    // 能直接用的形状 —— 侧栏不必再查一次归档，也就不会出现「序号对不上」。
    actions: result.actions.map((a) => ({
      ...a,
      refs: (a.refs || []).map((n) => ({
        index: n,
        title: items[n - 1]?.title || '',
        url: items[n - 1]?.url || ''
      }))
    })),
    sampleCount: items.length,
    profileStep,
    builtAt: Date.now(),
    meta: result.meta
  };

  await chrome.storage.local.set({ actionPlan: payload });
  return payload;
}

async function getActionPlan() {
  const { actionPlan } = await chrome.storage.local.get('actionPlan');
  return { ok: true, actionPlan: actionPlan || null };
}

// ---------------------------------------------------------------------------
// Ollama 探活结果落 storage：侧栏重开或 worker 被回收后仍能立刻显示上次结果
// ---------------------------------------------------------------------------

async function refreshOllamaStatus() {
  const result = await pingOllama();
  const payload = { ...result, checkedAt: Date.now() };

  await chrome.storage.local.set({ ollamaStatus: payload });
  return payload;
}

// ---------------------------------------------------------------------------
// 消息路由（侧栏 → 后台）
// ---------------------------------------------------------------------------

const HANDLERS = {
  PING_OLLAMA: refreshOllamaStatus,
  GET_ACTIVE_TAB: getActiveTab,
  EXTRACT_ACTIVE_PAGE: extractActivePage,
  GET_RECENT_BOOKMARKS: getRecentBookmarks,
  GET_BOOKMARK_FOLDERS: getBookmarkFolders,
  GET_BOOKMARKS_IN_FOLDER: getBookmarksInFolder,
  DIGEST_ACTIVE_PAGE: digestActivePage,
  DIGEST_URL: digestUrl,
  DIGEST_TEXT: digestText,
  GET_LAST_DIGEST: getLastDigest,
  GET_ARCHIVE_STATS: getArchiveStats,
  GET_ARCHIVE_BY_URL: getArchiveByUrl,
  SEARCH_ARCHIVE: searchArchive,
  LIST_STALE_DIGESTS: listStaleArchive,
  RANK_BATCH: rankBatch,
  BUILD_PROFILE: buildProfileNow,
  GET_PROFILE: getProfile,
  BUILD_ACTIONS: buildActionsNow,
  GET_ACTIONS: getActionPlan
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];

  if (!handler) {
    sendResponse({ ok: false, error: `未知消息类型：${msg?.type}` });
    return false;
  }

  // 返回 true 表示会异步调用 sendResponse，保持消息通道开启
  Promise.resolve(handler(msg))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));

  return true;
});
