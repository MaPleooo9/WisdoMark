// WisdoMark · 侧栏界面逻辑（阶段 1）
//
// 侧栏随时可能被关闭重开，所以不依赖内存状态：
// 需要留存的内容一律落 chrome.storage，重开时先渲染缓存再刷新。

const els = {
  // 消息 / 状态
  ollamaDot: document.getElementById('ollama-dot'),
  ollamaLabel: document.getElementById('ollama-label'),
  ollamaDetail: document.getElementById('ollama-detail'),
  modelList: document.getElementById('model-list'),
  btnRecheck: document.getElementById('btn-recheck'),
  runStatus: document.getElementById('run-status'),

  // 输入区
  inputTabs: document.getElementById('input-tabs'),
  panes: {
    paste: document.getElementById('pane-paste'),
    bookmarks: document.getElementById('pane-bookmarks'),
    current: document.getElementById('pane-current')
  },
  urlInput: document.getElementById('url-input'),
  btnDigestUrl: document.getElementById('btn-digest-url'),
  btnLoadBookmarks: document.getElementById('btn-load-bookmarks'),
  bookmarkList: document.getElementById('bookmark-list'),
  bookmarkHint: document.getElementById('bookmark-hint'),
  pageTitle: document.getElementById('page-title'),
  pageUrl: document.getElementById('page-url'),
  btnDigestCurrent: document.getElementById('btn-digest-current'),
  btnExtract: document.getElementById('btn-extract'),
  extractResult: document.getElementById('extract-result'),

  // 结果区
  resultCard: document.getElementById('result-card'),
  resultSource: document.getElementById('result-source'),
  resultBody: document.getElementById('result-body'),
  resultMeta: document.getElementById('result-meta'),
  resultRawWrap: document.getElementById('result-raw-wrap'),
  resultRaw: document.getElementById('result-raw')
};

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setHidden(node, hidden) {
  node.classList.toggle('is-hidden', hidden);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// 消化要 5~15 秒，不给反馈用户会以为卡死。显示一个走秒的计时器。
let ticker = null;

function startRunStatus(label) {
  const startedAt = Date.now();

  const paint = () => {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    els.runStatus.textContent = `${label}… 已用 ${seconds} 秒`;
  };

  setHidden(els.runStatus, false);
  paint();
  stopRunStatus();
  ticker = setInterval(paint, 100);
}

function stopRunStatus() {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function setBusy(busy, label) {
  els.btnDigestUrl.disabled = busy;
  els.btnLoadBookmarks.disabled = busy;
  applyUnsupported(busy);

  for (const btn of els.bookmarkList.querySelectorAll('button')) btn.disabled = busy;

  if (busy) {
    startRunStatus(label || '处理中');
  } else {
    stopRunStatus();
    setHidden(els.runStatus, true);
  }
}

// 当前页不支持注入时（浏览器内部页 / 扩展页）按钮要一直禁用，
// 不能因为 setBusy(false) 又把它放出来
function applyUnsupported(busy) {
  els.btnDigestCurrent.disabled =
    busy || els.btnDigestCurrent.dataset.unsupported === '1';
  els.btnExtract.disabled = busy || els.btnExtract.dataset.unsupported === '1';
}

// ---------------------------------------------------------------------------
// 输入区标签页
// ---------------------------------------------------------------------------

function switchPane(name) {
  for (const btn of els.inputTabs.querySelectorAll('.tab')) {
    btn.classList.toggle('is-active', btn.dataset.pane === name);
  }
  for (const [key, pane] of Object.entries(els.panes)) {
    setHidden(pane, key !== name);
  }
}

// ---------------------------------------------------------------------------
// 当前页面
// ---------------------------------------------------------------------------

async function refreshActiveTab() {
  const resp = await send('GET_ACTIVE_TAB');

  if (!resp?.ok) {
    els.pageTitle.textContent = '—';
    els.pageUrl.textContent = resp?.error || '取不到当前标签页';
    els.btnDigestCurrent.dataset.unsupported = '1';
    els.btnExtract.dataset.unsupported = '1';
    applyUnsupported(false);
    return;
  }

  els.pageTitle.textContent = resp.tab.title || '（无标题）';
  els.pageUrl.textContent = resp.tab.url || '（无 URL）';

  const supported = resp.tab.injectable ? '0' : '1';
  els.btnDigestCurrent.dataset.unsupported = supported;
  els.btnExtract.dataset.unsupported = supported;
  applyUnsupported(false);

  if (!resp.tab.injectable) {
    els.extractResult.className = 'hint';
    els.extractResult.textContent = '当前页面不支持抓取（浏览器内部页面或扩展页面）';
  }
}

// 只抓正文，不调模型 —— 留给排查用（比如怀疑正文提取有问题时）
async function handleExtract() {
  setBusy(true, '正在抓取正文');
  els.extractResult.className = 'hint';

  let resp;
  try {
    resp = await send('EXTRACT_ACTIVE_PAGE');
  } catch (err) {
    resp = { ok: false, error: err.message };
  } finally {
    setBusy(false);
  }

  if (!resp?.ok) {
    els.extractResult.className = 'hint is-fail';
    els.extractResult.textContent = `抓取失败：${resp?.error || '未知原因'}`;
    return;
  }

  els.extractResult.className = 'hint is-ok';
  els.extractResult.textContent = `已抓到 ${resp.charCount} 字（${resp.title || '无标题'}）`;
}

// ---------------------------------------------------------------------------
// 消化
// ---------------------------------------------------------------------------

async function runDigest(kind, payload) {
  const label = kind === 'current'
    ? '正在读取当前页面并调用本地模型'
    : '正在打开链接、等页面渲染后调用模型';

  setBusy(true, label);

  let resp;
  try {
    resp = kind === 'current'
      ? await send('DIGEST_ACTIVE_PAGE')
      : await send('DIGEST_URL', payload);
  } catch (err) {
    resp = { ok: false, error: err.message };
  } finally {
    setBusy(false);
  }

  renderResult(resp, kind === 'current' ? 'current' : 'url');
}

function handleDigestUrl() {
  const value = els.urlInput.value.trim();

  // 留空 = 用当前页面，省得用户为了读当前页还得先把链接复制出来
  if (!value) {
    runDigest('current');
    return;
  }

  runDigest('url', { url: value });
}

// ---------------------------------------------------------------------------
// 结果渲染
// ---------------------------------------------------------------------------

function renderResult(resp, origin) {
  els.resultBody.innerHTML = '';
  els.resultBody.className = '';
  els.resultMeta.textContent = '';
  setHidden(els.resultRawWrap, true);
  setHidden(els.resultCard, false);

  // 落库失败（网络 / 抓取 / 校验耗尽）—— 用抓取到的来源信息兜底显示
  if (!resp || resp.ok !== true) {
    renderFailure(resp);
    return;
  }

  const { value, meta, attempts, source, extract } = resp;

  els.resultSource.textContent = describeSource(source);

  if (value.ok === true) {
    // 分类徽标可能为 null（阶段 1 落下的老结果没有 category 字段），过滤掉再插入
    const chip = buildCategoryChip(value.category);

    els.resultBody.append(
      ...[chip, el('p', 'result-summary', value.summary), buildPoints(value.points)].filter(Boolean)
    );

    if (extract?.foregroundFallback) {
      els.resultBody.append(
        el(
          'p',
          'hint',
          '这个页面的正文是切到前台之后才渲染出来的 —— 后台标签页会被浏览器节流，靠滚动才加载的内容不出来。'
        )
      );
    }
  } else if (extract?.lowContent) {
    // 抓取阶段就没拿到正文。和「模型认为它不是内容主体」是两回事，
    // 混成一句话会让用户完全不知道下一步该干什么。
    renderLowContentNotice(resp);
  } else {
    // 模型判定这一页没有可消化的正文主体（登录页 / 错误页 / 导航页等），
    // 属于设计内的护栏，不是报错。
    // 护栏边界收得很紧：内容体裁、主题是否与读者方向相关，都不是判 false 的理由 ——
    // 曾经因为边界划错，把「应用推荐」「游戏更新公告」这类最该被压缩的内容全拒了。
    const box = el('div', 'notice');
    box.append(
      el('p', 'notice-title', '这一页没有可消化的正文'),
      el('p', 'notice-body', value.reason || '未给出原因'),
      el(
        'p',
        'hint',
        '只有登录页、错误页、导航页这类没有正文主体的页面会走到这里；应用推荐、更新公告、教程都会正常消化。'
      )
    );
    els.resultBody.append(box);
  }

  if (extract?.keptTabOpen) {
    els.resultBody.append(
      el('p', 'hint', '抓取用的那个标签页保留着没关，可以切过去看看它到底加载出了什么。')
    );
  }

  els.resultMeta.textContent = buildMetaText(meta, attempts);

  const lastAttempt = attempts?.[attempts.length - 1];
  if (lastAttempt?.raw) {
    els.resultRaw.textContent = lastAttempt.raw;
    setHidden(els.resultRawWrap, false);
  }
}

// 来源行：标题 · 域名（抓到 N 字）。
// 字数必须露出来 —— 用户第一眼要靠它判断「抓到的是文章还是导航页」。
function describeSource(source) {
  const name = source?.title
    ? `${source.title} · ${hostOf(source.url)}`
    : source?.url || '—';

  return source?.charCount ? `${name}（抓到 ${source.charCount} 字）` : name;
}

// 「页面没渲染出正文」专用提示。和模型护栏分开写，因为下一步的动作完全不同。
function renderLowContentNotice(resp) {
  const chars = resp?.source?.charCount || 0;

  const box = el('div', 'notice');
  box.append(
    el('p', 'notice-title', '这个页面没抓到正文'),
    el(
      'p',
      'notice-body',
      `只抓到 ${chars} 个字，基本是导航和页脚。不是模型偷懒 —— 是页面还没把正文渲染出来。常见原因：正文靠 JS 动态加载、需要登录、或者拦了自动访问。`
    )
  );

  if (resp?.extract?.foregroundFallback) {
    box.append(el('p', 'notice-body', '已经试过把标签页切到前台多等 6 秒，依然没出来。'));
  }

  box.append(
    el(
      'p',
      'hint',
      '如果这一页你自己打开能看到完整内容：切到那个标签页，用上面的「当前页面」入口再点一次 —— 手动打开的页面已经渲染好了，一定能抓到。'
    )
  );

  els.resultBody.append(box);
}

// 分类徽标。分类名是中文，不能直接当 class 用，所以走 data-category 让 CSS 选。
// 老结果（阶段 1 存的，没有 category 字段）返回 null，由调用方过滤。
function buildCategoryChip(category) {
  if (!category) return null;

  const chip = el('span', 'result-category', category);
  chip.dataset.category = category;
  return chip;
}

function buildPoints(points) {
  const list = el('ol', 'points');
  for (const point of points) list.append(el('li', null, point));
  return list;
}

function renderFailure(resp) {
  const error = resp?.error || '未知原因';

  els.resultSource.textContent = describeSource(resp?.source);
  els.resultBody.className = 'notice';

  els.resultBody.append(
    el('p', 'notice-title', '消化失败'),
    el('p', 'notice-body', error)
  );

  const attempts = resp?.attempts || [];
  if (attempts.length) {
    const box = el('div', 'attempts');
    box.append(el('p', 'attempts-title', `共尝试 ${attempts.length} 次`));
    for (const a of attempts) {
      const line = a.errors?.length
        ? `第 ${a.attempt} 次 · ${a.elapsedMs} ms · ${a.errors.join('；')}`
        : `第 ${a.attempt} 次 · ${a.elapsedMs} ms`;
      box.append(el('p', 'attempt-line', line));
    }
    els.resultBody.append(box);
  }

  if (resp?.keptTabOpen) {
    els.resultBody.append(
      el('p', 'notice-body', '为方便排查，抓取用的标签页保留着，没有自动关闭。')
    );
  }

  const lastAttempt = attempts[attempts.length - 1];
  if (lastAttempt?.raw) {
    els.resultRaw.textContent = lastAttempt.raw;
    setHidden(els.resultRawWrap, false);
  }
}

function buildMetaText(meta, attempts) {
  if (!meta) return '';

  const parts = [
    `模型 ${meta.model}`,
    `尝试 ${attempts.length} 次`,
    `共 ${attempts.reduce((sum, a) => sum + (a.elapsedMs || 0), 0)} ms`
  ];

  // 用 meta 里的数字，不依赖 source —— source 会被抓取来源覆盖，meta 才是权威值
  if (meta.truncated) {
    parts.push(`正文已截断 ${meta.originalChars} → ${meta.usedChars} 字`);
  }

  if (meta.droppedFields?.length) {
    parts.push(`丢弃多余字段：${meta.droppedFields.join('、')}`);
  }

  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// 最近收藏
// ---------------------------------------------------------------------------

async function handleLoadBookmarks() {
  els.btnLoadBookmarks.disabled = true;
  els.btnLoadBookmarks.textContent = '读取中…';
  els.bookmarkHint.className = 'hint';

  let resp;
  try {
    resp = await send('GET_RECENT_BOOKMARKS', { limit: 20 });
  } catch (err) {
    resp = { ok: false, error: err.message };
  }

  els.btnLoadBookmarks.disabled = false;
  els.btnLoadBookmarks.textContent = '读取最近收藏';
  els.bookmarkList.innerHTML = '';

  if (!resp?.ok) {
    els.bookmarkHint.className = 'hint is-fail';
    els.bookmarkHint.textContent = `读取失败：${resp?.error || '未知原因'}`;
    return;
  }

  if (!resp.items.length) {
    els.bookmarkHint.className = 'hint';
    els.bookmarkHint.textContent = '最近 20 条收藏里没有可抓取的网页，只有文件夹或本地链接。';
    return;
  }

  els.bookmarkHint.className = 'hint';
  els.bookmarkHint.textContent = `共 ${resp.items.length} 条，点任意一条直接消化。`;

  for (const item of resp.items) {
    const li = el('li', 'row-item');
    const btn = el('button', 'row-btn');
    btn.type = 'button';
    btn.append(
      el('span', 'row-title', item.title),
      el('span', 'row-host', item.host || item.url)
    );
    btn.addEventListener('click', () => runDigest('url', { url: item.url }));
    li.append(btn);
    els.bookmarkList.append(li);
  }
}

// ---------------------------------------------------------------------------
// Ollama 探活
// ---------------------------------------------------------------------------

function renderOllamaStatus(status) {
  if (!status) {
    els.ollamaLabel.textContent = '等待探活…';
    els.ollamaDetail.textContent = '等待探活…';
    return;
  }

  if (status.ok) {
    els.ollamaDot.className = 'dot dot-ok';
    els.ollamaLabel.textContent = `${status.models.length} 个模型`;
    els.ollamaDetail.className = 'details-note is-ok';
    els.ollamaDetail.textContent = `已连接 · ${status.elapsedMs} ms`;

    els.modelList.innerHTML = '';
    for (const m of status.models) {
      const li = el('li', 'row-item');
      const box = el('div', 'row-static');
      box.append(
        el('span', 'row-title', m.name),
        el(
          'span',
          'row-host',
          [m.parameterSize, m.quantization, m.contextLength ? `${m.contextLength} ctx` : '']
            .filter(Boolean)
            .join(' · ')
        )
      );
      li.append(box);
      els.modelList.append(li);
    }
    return;
  }

  els.ollamaDot.className = 'dot dot-fail';
  els.ollamaLabel.textContent = '未连接';
  els.ollamaDetail.className = 'details-note is-fail';
  els.modelList.innerHTML = '';

  els.ollamaDetail.textContent = [`连接失败：${status.error || '未知原因'}`, status.hint || '']
    .filter(Boolean)
    .join(' ');
}

async function checkOllama() {
  els.btnRecheck.disabled = true;
  els.ollamaDot.className = 'dot dot-idle';
  els.ollamaLabel.textContent = '检测中…';

  let status;
  try {
    status = await send('PING_OLLAMA');
  } catch (err) {
    status = { ok: false, error: err.message };
  }

  renderOllamaStatus(status);
  els.btnRecheck.disabled = false;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function restoreLastDigest() {
  try {
    const resp = await send('GET_LAST_DIGEST');
    if (resp?.ok && resp.digest) renderResult(resp.digest);
  } catch {
    // 还原失败不影响使用，忽略
  }
}

async function init() {
  // 先渲染上次的探活结果，避免侧栏重开时一片空白
  const { ollamaStatus } = await chrome.storage.local.get('ollamaStatus');
  renderOllamaStatus(ollamaStatus);

  await refreshActiveTab();
  await restoreLastDigest();
  await checkOllama();

  els.inputTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (tab) switchPane(tab.dataset.pane);
  });

  els.btnDigestUrl.addEventListener('click', handleDigestUrl);
  els.urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleDigestUrl();
  });

  els.btnDigestCurrent.addEventListener('click', () => runDigest('current'));
  els.btnExtract.addEventListener('click', handleExtract);
  els.btnLoadBookmarks.addEventListener('click', handleLoadBookmarks);
  els.btnRecheck.addEventListener('click', checkOllama);

  // 切标签页 / 页面跳转时同步当前页信息
  chrome.tabs.onActivated.addListener(refreshActiveTab);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url) refreshActiveTab();
  });
}

init();
