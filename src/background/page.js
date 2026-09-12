// WisdoMark · 标签页与抓正文
//
// 抓正文路径已在 AGENTS.md 拍板：「当前页注入」——把 content script 注入到一个
// 页面里，然后在同一个 isolated world 调用它暴露的提取函数。
//
// 两种入口：
//   extractActivePage()  当前标签页。用户手动打开的页面已经渲染好，抓到就是正文。
//   extractFromUrl(url)  收藏夹 / 粘贴的链接。它不是当前页，所以新开一个后台标签页，
//                        等它真正渲染出正文再取，成功后关掉，不打断用户正在看的东西。
//
// ⚠️ 血泪教训（阶段 1 验收时踩的，别退回去）：
// 第三方 SPA（小黑盒、知乎、掘金这类）服务端只返回一个空壳，正文全靠 JS 渲染。
// 「tabs.onUpdated 到 complete」只代表壳和静态资源加载完，此刻正文通常还没渲染出来。
// 直接抓会得到几百字的导航 + 页脚（实测小黑盒：287 字，正文 0 字），模型只能判
// 「没有可消化的正文」——它不是错，是我们喂错了东西。
// 所以必须等「正文长度稳定」再取，必要时把标签页短暂切到前台再等一轮。

// 正文短于这个字数，就怀疑是「没渲染完 / 登录墙 / 反爬拦截」，而不是「文章本来就短」。
// 实测小黑盒空壳的可见文本是 287 字，正常文章至少几百字，取 400 作为分界。
const MIN_CONTENT_CHARS = 400;

const POLL_MS = 400; // 轮询间隔
const QUIET_MS = 1000; // 正文长度多久不变才算渲染完成
const STABLE_MAX_WAIT_MS = 10000; // 后台等渲染，最多等这么久
const FOREGROUND_WAIT_MS = 6000; // 前台兜底再等这么久

// ---------------------------------------------------------------------------
// 图文帖：什么时候值得动用 OCR
//
// 实测 B 站 opus（「零基础 AI Agent 学习路线图」那篇）：DOM 里只有 1118 字，
// 全是「大家好，今天我要讲七个阶段」这种开场白；真正的干货 —— 七个阶段的划分、
// Track A / Track B 两条路线、每个阶段要用的工具（aider、LangGraph、MCP、RAG）——
// 全在 16 张图里。模型只能拿开场白写摘要，写出来当然空洞。
//
// 判据刻意保守：只有「正文短 + 正文区大图多」才动手，正常文章一张图都不会去识别。
// ---------------------------------------------------------------------------

export const OCR_TEXT_THRESHOLD = 2000; // 正文短于这个字数才怀疑是图文帖
export const OCR_MIN_IMAGES = 2; // 至少这么多张正文大图才值得

export function decideOcr({ text = '', images = [], imageTotal } = {}) {
  const candidates = Array.isArray(images) ? images : [];
  const needed = candidates.length >= OCR_MIN_IMAGES && text.length < OCR_TEXT_THRESHOLD;

  return {
    needed,
    images: needed ? candidates : [],
    textChars: text.length,
    imageCount: candidates.length,
    // content script 只交回前 N 张，总数另算 —— 摘要漏掉后半篇时要能解释为什么
    imageTotal: imageTotal ?? candidates.length
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isInjectable(url) {
  return /^https?:\/\//i.test(url || '');
}

export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) return { ok: false, error: '没有取到活动标签页' };

  return {
    ok: true,
    tab: {
      id: tab.id,
      url: tab.url || '',
      title: tab.title || '',
      injectable: isInjectable(tab.url)
    }
  };
}

// ---------------------------------------------------------------------------
// 注入与读取
// ---------------------------------------------------------------------------

// content script 内部做了幂等判断（`if (!window.__wisdomark)`），重复注入安全
async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/content/content-script.js']
  });
}

async function callExtract(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    // 页面在轮询期间可能发生导航，此时注入的脚本连同 window.__wisdomark 一起没了，
    // 这里必须判空，交给 readText 决定要不要重新注入
    func: () => (window.__wisdomark ? window.__wisdomark.extract() : null)
  });

  return result?.result || null;
}

// SPA 路由切换会销毁 isolated world 里的注入脚本，所以读不到就补注一次
async function readText(tabId) {
  let value = await callExtract(tabId).catch(() => null);

  if (!value) {
    await injectContentScript(tabId).catch(() => {});
    value = await callExtract(tabId).catch(() => null);
  }

  return value;
}

async function extractFromTab(tabId) {
  await injectContentScript(tabId);
  const value = await callExtract(tabId);

  return value || { ok: false, error: '注入成功但未取到返回值' };
}

// 等正文长度稳定下来。
// 只要长度还在增长就继续等；连续 QUIET_MS 没变化、且已经够长，就认为渲染完成。
// 返回的是「文本最长的那一次」，不是最后一次 —— 避免结尾抖动反而取到更短的。
async function waitForStableContent(tabId, { maxWaitMs, minChars }) {
  const startedAt = Date.now();
  let best = null;
  let lastLen = -1;
  let lastChangeAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    await sleep(POLL_MS);

    const current = await readText(tabId);
    if (!current?.ok) continue;

    if (!best || current.text.length > best.text.length) best = current;

    if (current.text.length !== lastLen) {
      lastLen = current.text.length;
      lastChangeAt = Date.now();
      continue;
    }

    if (Date.now() - lastChangeAt < QUIET_MS) continue;

    // 够了，收工
    if (current.text.length >= minChars) break;
    // 一直很短的：等过半程还没动静就别耗着了，多半真是一张空壳
    if (Date.now() - startedAt >= maxWaitMs / 2) break;
  }

  return best;
}

// 后台标签页可能被浏览器节流（不绘制、IntersectionObserver 不触发），
// 导致靠滚动才加载的正文一直不出来。把标签页短暂切到前台再等一轮，然后切回去。
async function tryForegroundBoost(tabId, minChars) {
  const [previous] = await chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .catch(() => []);

  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    return null;
  }

  const extracted = await waitForStableContent(tabId, {
    maxWaitMs: FOREGROUND_WAIT_MS,
    minChars
  });

  // 把用户原本在看的那一页切回来，别抢他的视线
  if (previous?.id && previous.id !== tabId) {
    await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
  }

  return extracted;
}

function pickLonger(a, b) {
  if (!a) return b;
  if (!b) return a;
  return b.text.length > a.text.length ? b : a;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

export async function extractActivePage() {
  const { ok, tab, error } = await getActiveTab();

  if (!ok) return { ok: false, error };
  if (!tab.injectable) {
    return { ok: false, error: '当前页面不支持注入（浏览器内部页面或扩展页面）' };
  }

  try {
    const extracted = await extractFromTab(tab.id);
    return {
      ...extracted,
      source: 'active-tab',
      lowContent: false,
      ocr: decideOcr(extracted)
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), source: 'active-tab' };
  }
}

// 打开一个后台标签页抓正文。
// 成功且内容够长 → 关掉标签页（用户无感）
// 内容太短 / 出错   → 保留标签页，方便用户自己看到底加载出了什么
export async function extractFromUrl(url, { timeoutMs = 25000, minChars = MIN_CONTENT_CHARS } = {}) {
  let tab;

  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (err) {
    return { ok: false, error: `打不开这个链接：${err?.message || err}` };
  }

  const loaded = await waitForTabComplete(tab.id, timeoutMs);

  if (!loaded) {
    return {
      ok: false,
      error: `等待页面加载超时（${Math.round(timeoutMs / 1000)} 秒）。可能是登录墙、反爬拦截，或页面一直有请求没结束。`,
      tabId: tab.id,
      keptTabOpen: true
    };
  }

  try {
    await injectContentScript(tab.id);
  } catch (err) {
    return {
      ok: false,
      error: `注入脚本失败：${err?.message || err}`,
      tabId: tab.id,
      keptTabOpen: true
    };
  }

  let extracted = await waitForStableContent(tab.id, { maxWaitMs: STABLE_MAX_WAIT_MS, minChars });
  let foregroundFallback = false;

  if (!extracted || extracted.text.length < minChars) {
    const boosted = await tryForegroundBoost(tab.id, minChars);
    if (boosted) {
      foregroundFallback = true;
      extracted = pickLonger(extracted, boosted);
    }
  }

  if (!extracted) {
    return {
      ok: false,
      error: '页面打开了，但没能取到任何正文',
      tabId: tab.id,
      keptTabOpen: true
    };
  }

  const lowContent = extracted.text.length < minChars;
  const ocr = decideOcr(extracted);
  const diagnostics = { lowContent, foregroundFallback, minChars, ocr };

  // 没抓到正文、也没有图可识别 —— 保留标签页，让用户自己看到底加载出了什么
  if (lowContent && !ocr.needed) {
    return {
      ...extracted,
      ...diagnostics,
      source: 'opened-tab',
      tabId: tab.id,
      keptTabOpen: true
    };
  }

  // 有图可识别的话标签页不用留：图片 URL 已经拿到，取图是侧栏自己去取的
  await chrome.tabs.remove(tab.id).catch(() => {});
  return { ...extracted, ...diagnostics, source: 'opened-tab' };
}

// 等标签页 status 变成 complete。
// 注意：attach 监听器的时候页面可能已经加载完了，所以要主动查一次当前状态。
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(value);
    };

    const onUpdated = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') finish(true);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t?.status === 'complete') finish(true);
      })
      .catch(() => {});
  });
}
