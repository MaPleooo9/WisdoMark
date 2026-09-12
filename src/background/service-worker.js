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
import { digestDocument } from './digest.js';

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

const BOOKMARK_LIMIT = 20;

async function getRecentBookmarks({ limit = BOOKMARK_LIMIT } = {}) {
  try {
    // getRecent 返回的是「文件夹 + 书签」混合列表，文件夹没有 url，过滤掉
    const raw = await chrome.bookmarks.getRecent(limit);

    const items = raw
      .filter((b) => /^https?:\/\//i.test(b.url || ''))
      .map((b) => ({
        id: b.id,
        title: b.title || '(无标题)',
        url: b.url,
        host: safeHost(b.url),
        addedAt: b.dateAdded || null
      }));

    return { ok: true, items, limit };
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
      minChars: extracted.minChars || null
    },
    // OCR 的账要记清楚：识别了几张、丢了几张、补了多少字。
    // 用户看到摘要变了，得能查到是因为多喂了图片文字。
    ocr: extracted.ocr || null,
    finishedAt: Date.now()
  };

  await chrome.storage.local.set({ lastDigest: payload });
  return payload;
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

async function digestUrl({ url }) {
  const target = normalizeUrl(url);

  if (!target) {
    return { ok: false, error: '请填一个 http/https 开头的链接' };
  }

  const extracted = await extractFromUrl(target);
  if (!extracted.ok) return extracted;

  return digestAndStore(extracted);
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
async function digestText({ text, title, url, source, ocr }) {
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
    minChars: ocr?.minChars || null,
    // OCR 之后的字数要重新判一次：识别出来的文字如果够长，
    // 就不该再报「这个页面没抓到正文」
    lowContent: ocr?.minChars ? merged.length < ocr.minChars : false,
    ocr: ocr ? { ...ocr, needed: false } : null
  });
}

async function getLastDigest() {
  const { lastDigest } = await chrome.storage.local.get('lastDigest');
  return { ok: true, digest: lastDigest || null };
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
  DIGEST_ACTIVE_PAGE: digestActivePage,
  DIGEST_URL: digestUrl,
  DIGEST_TEXT: digestText,
  GET_LAST_DIGEST: getLastDigest
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
