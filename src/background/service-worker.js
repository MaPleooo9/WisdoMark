// WisdoMark · 后台服务（service worker）
//
// 职责：侧栏行为、本地 Ollama 调用、状态持久化。
//
// 注意：service worker 不是常驻进程，浏览器会在空闲时回收它，
// 任何状态都必须落 chrome.storage，不要依赖模块级内存变量跨事件存活。

const OLLAMA_BASE = 'http://localhost:11434';

// ---------------------------------------------------------------------------
// 侧栏行为
// ---------------------------------------------------------------------------

// 让「点击工具栏图标」直接展开侧栏，而不是弹一个 popup。
// 该设置是持久化的，但读未打包扩展时会重置，所以在顶层再设一次（幂等，成本可忽略）。
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[WisdoMark] 设置侧栏行为失败：', err));

// ---------------------------------------------------------------------------
// 本地 Ollama
// ---------------------------------------------------------------------------

// 探活：GET /api/tags 返回本机已安装的模型列表。
// 失败的最常见两种原因：Ollama 没启动 / 未放行 chrome-extension 来源。
async function pingOllama() {
  const startedAt = Date.now();

  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`, { method: 'GET' });

    if (!resp.ok) {
      return await saveOllamaStatus({
        ok: false,
        error: `HTTP ${resp.status}`,
        elapsedMs: Date.now() - startedAt
      });
    }

    const data = await resp.json();
    const models = (data.models || []).map((m) => ({
      name: m.name,
      parameterSize: m.details?.parameter_size || '',
      quantization: m.details?.quantization_level || '',
      contextLength: m.details?.context_length || null,
      capabilities: m.capabilities || []
    }));

    return await saveOllamaStatus({
      ok: true,
      models,
      elapsedMs: Date.now() - startedAt
    });
  } catch (err) {
    // fetch 直接抛错通常是「连不上端口」，而不是 HTTP 层错误
    return await saveOllamaStatus({
      ok: false,
      error: err?.message || String(err),
      hint: '请确认 Ollama 已启动；若仍失败，检查 OLLAMA_ORIGINS 是否放行 chrome-extension://',
      elapsedMs: Date.now() - startedAt
    });
  }
}

// 探活结果落 storage：侧栏重开或 worker 被回收后，仍能立刻显示上次结果
async function saveOllamaStatus(result) {
  const payload = { ...result, checkedAt: Date.now() };
  await chrome.storage.local.set({ ollamaStatus: payload });
  return payload;
}

// ---------------------------------------------------------------------------
// 标签页
// ---------------------------------------------------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    return { ok: false, error: '没有取到活动标签页' };
  }

  return {
    ok: true,
    tab: {
      id: tab.id,
      url: tab.url || '',
      title: tab.title || '',
      // 浏览器内部页面（chrome:// 、扩展页）不允许注入脚本，提前标记出来
      injectable: isInjectable(tab.url || '')
    }
  };
}

function isInjectable(url) {
  return /^https?:\/\//i.test(url);
}

// ---------------------------------------------------------------------------
// 抓正文（阶段 1 起步版）
//
// 采用「当前页注入」方案（已拍板）：
//   1. 先把 content script 注入目标标签页（授权来自 host_permissions）
//   2. 再在同一个 isolated world 里调用它暴露的提取函数
// 两步注入保证重复点击时不会重复定义函数（content script 内部做了幂等判断）。
// ---------------------------------------------------------------------------

async function extractActivePage() {
  const { ok, tab, error } = await getActiveTab();

  if (!ok) return { ok: false, error };
  if (!tab.injectable) {
    return { ok: false, error: '当前页面不支持注入（浏览器内部页面或扩展页面）' };
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/content-script.js']
    });

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__wisdomark.extract()
    });

    return result?.result || { ok: false, error: '注入成功但未取到返回值' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// 消息路由（侧栏 → 后台）
// ---------------------------------------------------------------------------

const HANDLERS = {
  PING_OLLAMA: pingOllama,
  GET_ACTIVE_TAB: getActiveTab,
  EXTRACT_ACTIVE_PAGE: extractActivePage
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
