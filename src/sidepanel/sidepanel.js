// WisdoMark · 侧栏界面逻辑
//
// 侧栏随时可能被关闭重开，所以不依赖内存状态：
// 需要留存的内容一律落 chrome.storage，重开时先渲染缓存再刷新。

const els = {
  ollamaStatus: document.getElementById('ollama-status'),
  ollamaDot: document.getElementById('ollama-dot'),
  ollamaLabel: document.getElementById('ollama-label'),
  ollamaDetail: document.getElementById('ollama-detail'),
  modelList: document.getElementById('model-list'),
  pageTitle: document.getElementById('page-title'),
  pageUrl: document.getElementById('page-url'),
  btnExtract: document.getElementById('btn-extract'),
  extractResult: document.getElementById('extract-result'),
  btnRecheck: document.getElementById('btn-recheck')
};

// 把回调式 sendMessage 包成 Promise，避免各处重复处理 lastError
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(resp);
    });
  });
}

// ---------------------------------------------------------------------------
// 当前页面
// ---------------------------------------------------------------------------

async function refreshActiveTab() {
  const resp = await send('GET_ACTIVE_TAB');

  if (!resp?.ok) {
    els.pageTitle.textContent = '—';
    els.pageUrl.textContent = resp?.error || '取不到当前标签页';
    els.btnExtract.disabled = true;
    return;
  }

  els.pageTitle.textContent = resp.tab.title || '（无标题）';
  els.pageUrl.textContent = resp.tab.url || '（无 URL）';
  els.btnExtract.disabled = !resp.tab.injectable;

  if (!resp.tab.injectable) {
    els.extractResult.textContent = '当前页面不支持抓取（浏览器内部页面或扩展页面）';
  }
}

// ---------------------------------------------------------------------------
// 抓正文
// ---------------------------------------------------------------------------

async function handleExtract() {
  els.btnExtract.disabled = true;
  els.btnExtract.textContent = '抓取中…';
  els.extractResult.className = 'hint';
  els.extractResult.textContent = '';

  const resp = await send('EXTRACT_ACTIVE_PAGE');

  els.btnExtract.textContent = '抓取正文';

  if (!resp?.ok) {
    els.extractResult.className = 'hint is-fail';
    els.extractResult.textContent = `抓取失败：${resp?.error || '未知原因'}`;
    els.btnExtract.disabled = false;
    return;
  }

  // 阶段 0 只验证「注入链路通不通」，先报告规模，不送模型
  els.extractResult.className = 'hint is-ok';
  els.extractResult.textContent = `已抓到 ${resp.charCount} 字（标题：${resp.title || '无'}）`;

  // 凑合看一眼正文质量，落 storage 便于后续阶段复用
  await chrome.storage.local.set({
    lastExtract: {
      url: resp.url,
      title: resp.title,
      charCount: resp.charCount,
      preview: resp.text.slice(0, 200),
      extractedAt: Date.now()
    }
  });

  els.btnExtract.disabled = false;
}

// ---------------------------------------------------------------------------
// Ollama 探活
// ---------------------------------------------------------------------------

function renderOllamaStatus(status) {
  if (!status) {
    els.ollamaDetail.textContent = '等待探活…';
    return;
  }

  if (status.ok) {
    els.ollamaDot.className = 'dot dot-ok';
    els.ollamaLabel.textContent = `${status.models.length} 个模型`;

    els.ollamaDetail.className = 'hint is-ok';
    els.ollamaDetail.textContent = `已连接 · ${status.elapsedMs} ms`;

    els.modelList.innerHTML = '';
    for (const m of status.models) {
      const li = document.createElement('li');

      const name = document.createElement('span');
      name.className = 'model-name';
      name.textContent = m.name;

      const meta = document.createElement('span');
      meta.className = 'model-meta';
      meta.textContent = [
        m.parameterSize,
        m.quantization,
        m.contextLength ? `${m.contextLength} ctx` : ''
      ]
        .filter(Boolean)
        .join(' · ');

      li.append(name, meta);
      els.modelList.append(li);
    }
    return;
  }

  els.ollamaDot.className = 'dot dot-fail';
  els.ollamaLabel.textContent = '未连接';
  els.modelList.innerHTML = '';

  els.ollamaDetail.className = 'hint is-fail';
  els.ollamaDetail.textContent = [
    `连接失败：${status.error || '未知原因'}`,
    status.hint || ''
  ]
    .filter(Boolean)
    .join('\n');
}

async function checkOllama() {
  els.btnRecheck.disabled = true;
  els.ollamaDot.className = 'dot dot-idle';
  els.ollamaLabel.textContent = '检测中…';

  try {
    renderOllamaStatus(await send('PING_OLLAMA'));
  } catch (err) {
    renderOllamaStatus({ ok: false, error: err.message });
  }

  els.btnRecheck.disabled = false;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function init() {
  // 先渲染上次的探活结果，避免侧栏重开时一片空白
  const { ollamaStatus } = await chrome.storage.local.get('ollamaStatus');
  renderOllamaStatus(ollamaStatus);

  await refreshActiveTab();
  await checkOllama();

  els.btnExtract.addEventListener('click', handleExtract);
  els.btnRecheck.addEventListener('click', checkOllama);

  // 切标签页 / 页面跳转时同步当前页信息
  chrome.tabs.onActivated.addListener(refreshActiveTab);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url) refreshActiveTab();
  });
}

init();
