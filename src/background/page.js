// WisdoMark · 标签页与抓正文
//
// 抓正文路径已在 AGENTS.md 拍板：「当前页注入」——把 content script 注入到一个
// 已经加载完的页面里，然后在同一个 isolated world 调用它暴露的提取函数。
//
// 两种入口：
//   extractActivePage()  当前标签页（阶段 0 既有能力）
//   extractFromUrl(url)  收藏夹/粘贴的链接 —— 它不是当前页，所以新开一个后台标签页，
//                        等加载完再注入，成功后关掉。不打断用户正在看的东西。

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

// 往指定标签页注入 content script 并调用提取函数。
// content script 内部做了幂等判断，重复注入不会重复定义。
async function extractFromTab(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/content/content-script.js']
  });

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__wisdomark.extract()
  });

  return result?.result || { ok: false, error: '注入成功但未取到返回值' };
}

export async function extractActivePage() {
  const { ok, tab, error } = await getActiveTab();

  if (!ok) return { ok: false, error };
  if (!tab.injectable) {
    return { ok: false, error: '当前页面不支持注入（浏览器内部页面或扩展页面）' };
  }

  try {
    const extracted = await extractFromTab(tab.id);
    return { ...extracted, source: 'active-tab' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), source: 'active-tab' };
  }
}

// 打开一个后台标签页抓正文。
// 成功 → 关掉标签页（用户无感）；失败 → 保留标签页，方便用户自己看到底加载出了什么。
export async function extractFromUrl(url, { timeoutMs = 25000 } = {}) {
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
    const extracted = await extractFromTab(tab.id);

    if (extracted.ok) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      return { ...extracted, source: 'opened-tab' };
    }

    return { ...extracted, source: 'opened-tab', tabId: tab.id, keptTabOpen: true };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      tabId: tab.id,
      keptTabOpen: true
    };
  }
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
