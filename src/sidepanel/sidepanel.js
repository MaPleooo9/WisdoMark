// WisdoMark · 侧栏界面逻辑（阶段 1）
//
// 侧栏随时可能被关闭重开，所以不依赖内存状态：
// 需要留存的内容一律落 chrome.storage，重开时先渲染缓存再刷新。

import { recognizeImages, mergeWithDocument } from './ocr.js';
import { runBatchDigest, BATCH_DEFAULT } from './batch.js';

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
    current: document.getElementById('pane-current'),
    batch: document.getElementById('pane-batch'),
    archive: document.getElementById('pane-archive')
  },
  urlInput: document.getElementById('url-input'),
  btnDigestUrl: document.getElementById('btn-digest-url'),
  btnLoadBookmarks: document.getElementById('btn-load-bookmarks'),
  bookmarkFolder: document.getElementById('bookmark-folder'),
  bookmarkList: document.getElementById('bookmark-list'),
  bookmarkHint: document.getElementById('bookmark-hint'),
  pageTitle: document.getElementById('page-title'),
  pageUrl: document.getElementById('page-url'),
  btnDigestCurrent: document.getElementById('btn-digest-current'),
  btnExtract: document.getElementById('btn-extract'),
  extractResult: document.getElementById('extract-result'),

  // 批量
  batchFolder: document.getElementById('batch-folder'),
  btnRefreshFolders: document.getElementById('btn-refresh-folders'),
  batchSize: document.getElementById('batch-size'),
  btnRunBatch: document.getElementById('btn-run-batch'),
  batchHint: document.getElementById('batch-hint'),
  batchProgress: document.getElementById('batch-progress'),
  batchResult: document.getElementById('batch-result'),

  // 归档
  archiveKeyword: document.getElementById('archive-keyword'),
  archiveCategory: document.getElementById('archive-category'),
  archiveStat: document.getElementById('archive-stat'),
  archiveList: document.getElementById('archive-list'),
  archiveHint: document.getElementById('archive-hint'),
  btnArchiveMore: document.getElementById('btn-archive-more'),

  // 我的画像
  profileNote: document.getElementById('profile-note'),
  profileBody: document.getElementById('profile-body'),
  btnBuildProfile: document.getElementById('btn-build-profile'),

  // 行动清单
  actionNote: document.getElementById('action-note'),
  actionBody: document.getElementById('action-body'),
  btnBuildActions: document.getElementById('btn-build-actions'),

  // 结果区
  resultCard: document.getElementById('result-card'),
  resultNote: document.getElementById('result-note'),
  resultSource: document.getElementById('result-source'),
  resultBody: document.getElementById('result-body'),
  resultMeta: document.getElementById('result-meta'),
  btnCopyResult: document.getElementById('btn-copy-result'),
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
let runLabel = '';

function startRunStatus(label) {
  const startedAt = Date.now();

  runLabel = label;

  const paint = () => {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    els.runStatus.textContent = `${runLabel}… 已用 ${seconds} 秒`;
  };

  setHidden(els.runStatus, false);
  paint();
  stopRunStatus();
  ticker = setInterval(paint, 100);
}

// 长流程（抓取 → OCR → 调模型）要能换文案，否则用户看到「正在打开链接」走了 10 秒
// 会以为卡住了
function setRunLabel(label) {
  runLabel = label;
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

let bookmarkFoldersLoaded = false;

function switchPane(name) {
  for (const btn of els.inputTabs.querySelectorAll('.tab')) {
    btn.classList.toggle('is-active', btn.dataset.pane === name);
  }
  for (const [key, pane] of Object.entries(els.panes)) {
    setHidden(pane, key !== name);
  }

  // 「消化结果」这张卡片是**单条消化**的产物（粘贴链接 / 当前页面 / 收藏列表都走它）。
  // 切到批量面板就收起来 —— 批量是另一件事，留着这张卡片会让人以为批量也出了结果。
  // 切回其他面板时按内容恢复：resultBody 里有东西（成功结果或失败原因）就说明
  // 上次确实出过结果，不该让用户以为它丢了。
  if (name === 'batch') {
    setHidden(els.resultCard, true);
  } else if (els.resultBody.innerHTML) {
    setHidden(els.resultCard, false);
  }

  // 收藏夹列表懒加载 —— 没必要每次打开侧栏都去读一遍收藏夹树。
  // 批量面板用的是同一棵树（一次加载，填两个下拉），所以两个面板共用这一次。
  if ((name === 'bookmarks' || name === 'batch') && !bookmarkFoldersLoaded) {
    bookmarkFoldersLoaded = true;
    loadBookmarkFolders();
  }

  // 归档面板每次切进来都重查一次：本地查询很快，而且用户刚消化完一篇切过来
  // 就该看到它。代价是分页回到第一页 —— 默认就 30 条，不常翻到后面。
  if (name === 'archive') searchArchive();
}

// 「点进去就全选」：粘下一条链接时不用先 Ctrl+A 把上一条清掉。
// 只在「获得焦点」那一次全选 —— 已经聚焦后再点一下，用户是想把光标挪到中间改字，
// 这时候再抢着全选会让人没法编辑。
let selectAllOnMouseUp = false;

function wireUrlInput() {
  els.urlInput.addEventListener('focus', () => {
    els.urlInput.select();
    selectAllOnMouseUp = true;
  });

  els.urlInput.addEventListener('mouseup', (event) => {
    if (!selectAllOnMouseUp) return;
    // 浏览器在 mouseup 时才真正落下光标位置，这里挡掉它，保住全选
    event.preventDefault();
    selectAllOnMouseUp = false;
  });

  els.urlInput.addEventListener('blur', () => {
    selectAllOnMouseUp = false;
  });

  els.urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleDigestUrl();
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
  }

  // 图文帖：抓到的文字太少，干货在图里。后台不调模型，先把图片清单交过来，
  // 由侧栏做本地 OCR，拼进正文后再让模型消化一次。
  if (resp?.needOcr) {
    resp = await digestWithOcr(resp.ocr);
  }

  setBusy(false);
  renderResult(resp, kind === 'current' ? 'current' : 'url');
}

// 「正文 + 图片文字」合成一份稿子再消化。
// 这一步不重新抓页面 —— 抓一次要等渲染、还可能撞上登录墙，
// 而正文和图片 URL 在第一次抓取时就已经拿到了。
async function digestWithOcr(ocr, { onProgress, quiet } = {}) {
  const images = ocr?.images || [];

  let recognized;
  try {
    recognized = await recognizeImages(images, {
      domText: ocr?.text || '',
      // 单条消化时进度写进输入区的状态行；批量时由调用方接管 ——
      // 否则那一行会变成「某一条的 OCR 进度」，和批量的整体进度对不上
      onProgress:
        onProgress ||
        (({ stage, index, total }) => {
          setRunLabel(
            stage === 'engine'
              ? '正文在图里，正在启动本地 OCR'
              : `正在识别图片里的文字 ${index}/${total}`
          );
        })
    });
  } catch (err) {
    recognized = { ok: false, error: err?.message || String(err) };
  }

  // 一张都没认出可用文字：如实说「没抓到正文」，不要硬着头皮把 1118 字开场白送去总结 ——
  // 那正是用户抱怨「这个网站就不太行」的样子：有结果，但全是废话。
  if (!recognized?.ok || !recognized.text) {
    return {
      ok: true,
      value: {
        ok: false,
        reason:
          recognized?.error ||
          `正文只有 ${ocr?.text?.length || 0} 字，${images.length} 张图片也没能识别出可用文字`
      },
      source: { title: ocr?.title, url: ocr?.url, charCount: ocr?.text?.length || 0 },
      extract: {
        lowContent: true,
        foregroundFallback: !!ocr?.foregroundFallback,
        minChars: ocr?.minChars || null
      },
      ocrAttempted: images.length
    };
  }

  setRunLabel('图片文字已识别，正在调用本地模型');

  const merged = mergeWithDocument(ocr?.text || '', recognized.text);

  return send('DIGEST_TEXT', {
    text: merged,
    title: ocr?.title,
    url: ocr?.url,
    source: ocr?.source,
    // 批量路径要求「别覆盖最近一次结果」，一路带下去
    quiet: !!quiet,
    ocr: {
      used: true,
      minChars: ocr?.minChars || null,
      total: images.length,
      imageTotal: ocr?.imageTotal || images.length,
      recognized: recognized.items.length,
      dropped: recognized.dropped,
      chars: recognized.chars,
      model: recognized.model
    }
  }).catch((err) => ({ ok: false, error: err.message }));
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
// 批量消化（阶段 2.4）
// ---------------------------------------------------------------------------
//
// 编排本身在 batch.js 里（放在侧栏，是因为 MV3 的 service worker 活不了几分钟）。
// 这里只负责界面：收集选择、画进度、渲染排序结果。

let batchRunning = false;
let batchAbort = false;

const BATCH_PHASE_LABEL = {
  checking: '查归档…',
  reused: '复用归档 ✓',
  digesting: '消化中…',
  done: '完成 ✓',
  failed: '失败'
};

async function handleRunBatch() {
  // 再按一次 = 停下。不强杀正在跑的那一条（模型调用打断不了），
  // 让它跑完 —— 已经付出的时间不该白费，而且它跑完会顺带存进归档。
  if (batchRunning) {
    batchAbort = true;
    els.batchHint.textContent = '正在停下…（当前这一条跑完就停；已经消化的都存好了）';
    return;
  }

  const folderId = els.batchFolder.value;
  const size = Number(els.batchSize.value) || BATCH_DEFAULT;

  els.batchHint.className = 'hint';
  els.batchProgress.innerHTML = '';
  els.batchResult.innerHTML = '';
  // 收起上一次单条消化的结果卡片 —— 跑批量时它只会碍事，
  // 而且容易让人以为「批量只出了这一条的结果」
  setHidden(els.resultCard, true);
  els.batchHint.textContent = '正在读取收藏夹…';

  let resp;
  try {
    resp =
      folderId === RECENT_VALUE
        ? await send('GET_RECENT_BOOKMARKS', { limit: size })
        : await send('GET_BOOKMARKS_IN_FOLDER', { folderId, limit: size });
  } catch (err) {
    resp = { ok: false, error: err.message };
  }

  const items = (resp?.items || []).slice(0, size);

  if (!resp?.ok || !items.length) {
    els.batchHint.className = 'hint is-fail';
    els.batchHint.textContent = resp?.error || '这个收藏夹里没有可抓取的网页。';
    return;
  }

  // 记住这次的选择，下次打开还是它
  chrome.storage.local
    .set({ [BATCH_FOLDER_STORE_KEY]: folderId, [BATCH_SIZE_STORE_KEY]: String(size) })
    .catch(() => {});

  batchRunning = true;
  batchAbort = false;
  els.btnRunBatch.textContent = '停止（跑完当前这条）';
  els.batchHint.textContent = `共 ${items.length} 条，已消化过的会直接复用。`;

  const rows = items.map(() => '排队中');
  const startedAt = Date.now();

  const paint = () => {
    els.batchProgress.innerHTML = '';
    items.forEach((item, i) => {
      const li = el('li', 'row-item');
      li.append(
        el('span', 'row-title', `${i + 1}. ${item.title || item.url}`),
        el('span', 'row-host', rows[i])
      );
      els.batchProgress.append(li);
    });
  };

  paint();

  let outcome;
  try {
    outcome = await runBatchDigest({
      items,
      send,
      digestWithOcr,
      shouldStop: () => batchAbort,
      onProgress: ({ phase, index, total }) => {
        if (phase === 'ranking') {
          els.batchHint.textContent = `${total} 条都处理完，正在排序、挑必看…`;
          return;
        }

        rows[index] = BATCH_PHASE_LABEL[phase] || phase;

        const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
        els.batchHint.textContent = `第 ${index + 1}/${total} 条 · 已用 ${seconds} 秒`;
        paint();
      }
    });
  } finally {
    batchRunning = false;
    els.btnRunBatch.textContent = '开始批量消化';
  }

  if (outcome.stopped) {
    els.batchHint.className = 'hint';
    els.batchHint.textContent = '已停下。已经消化的都进归档了，再点一次会从断点接着跑。';
    return;
  }

  if (!outcome.ok) {
    els.batchHint.className = 'hint is-fail';
    els.batchHint.textContent = outcome.error || '批量消化失败。';
    return;
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
  const failNote = outcome.skipped.length ? `，${outcome.skipped.length} 条没消化成功` : '';
  els.batchHint.className = 'hint';
  els.batchHint.textContent = `完成：${outcome.results.length} 条进入排序${failNote}，共 ${seconds} 秒。`;

  renderBatchResult(outcome);
}

function renderBatchResult({ results, skipped, ranked }) {
  const box = el('div', 'notice');

  if (ranked?.ok) {
    box.append(el('p', 'notice-title', '本周必看'));

    if (ranked.overview) box.append(el('p', 'notice-body', ranked.overview));

    ranked.mustRead.forEach((entry, i) => {
      const item = results[entry.index];
      if (!item) return;

      // 「为什么必看」常驻显示 —— 它是这一批的核心产出，不该也被收进折叠里
      box.append(el('p', 'batch-reason', `· ${entry.reason}`));
      box.append(buildBatchRow(item, i + 1));
    });
  } else {
    // 排序失败不该让整批白跑 —— 内容都已经消化并归档了
    box.append(
      el('p', 'notice-title', '排序没成'),
      el('p', 'notice-body', ranked?.error || '模型没能给出排序结果。'),
      el('p', 'hint', '下面按原顺序列出这一批，内容都在。')
    );
  }

  els.batchResult.append(box);

  // 完整顺序：排好序就按排序结果，否则按原顺序
  const order = ranked?.ok && ranked.order.length ? ranked.order : results.map((_, i) => i);
  const list = el('div', 'batch-list');

  order.forEach((idx, rank) => {
    const item = results[idx];
    if (item) list.append(buildBatchRow(item, rank + 1));
  });

  els.batchResult.append(el('p', 'hint', '全部（按推荐顺序，点标题看内容）'), list);

  if (skipped?.length) {
    const failList = el('ul', 'row-list');

    for (const item of skipped) {
      const li = el('li', 'row-item');
      li.append(
        el('span', 'row-title', item.title || item.url),
        el('span', 'row-host', item.reason)
      );
      failList.append(li);
    }

    els.batchResult.append(el('p', 'hint', '没消化成功的（不影响其余条目）'), failList);
  }
}

// 一条批量结果：左侧可展开的标题（点开看这条的消化内容），右侧「打开原文」。
//
// 为什么折叠而不是平铺：一批十几条，把摘要和要点全铺出来会把面板撑得没法看，
// 用户反而找不到「哪几条值得看」。默认只给标题，想看哪条点哪条。
function buildBatchRow(item, rank) {
  const wrap = el('div', 'batch-row');

  const details = el('details', 'batch-item');
  const summary = el('summary');

  summary.append(
    el('span', 'batch-title', `${rank ? `${rank}. ` : ''}${item.title || item.url}`)
  );
  if (item.category) summary.append(el('span', 'batch-meta', item.category));
  details.append(summary);

  // 展开区就是单条消化时那张卡片的核心：摘要 + 要点
  const detail = el('div', 'batch-detail');

  if (item.summary) detail.append(el('p', '', item.summary));

  if (item.points?.length) {
    const ul = el('ul');
    for (const point of item.points) ul.append(el('li', '', point));
    detail.append(ul);
  }

  if (!item.summary && !item.points?.length) {
    detail.append(el('p', '', '这条没有留下可看的内容。'));
  }

  details.append(detail);
  wrap.append(details);

  // 「打开原文」放在折叠区外面：不展开也能直接跳过去
  const open = el('a', 'batch-open', '原文 ↗');

  if (item.url) {
    open.href = item.url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.title = item.url;
  } else {
    open.classList.add('is-off');
  }

  wrap.append(open);

  return wrap;
}

// ---------------------------------------------------------------------------
// 我的画像（2.5）
// ---------------------------------------------------------------------------
//
// 数据全部来自本地归档库，分析也全在本地跑。
// 输入是「最近 N 条的标题 + 分类 + 摘要」，不喂正文 —— 判断「在关注什么方向」用摘要就够。

async function handleBuildProfile() {
  if (els.btnBuildProfile.disabled) return;

  els.btnBuildProfile.disabled = true;
  els.btnBuildProfile.textContent = '分析中…（约 20 秒）';
  els.profileNote.textContent = '正在读归档、调用本地模型';

  let resp;
  try {
    resp = await send('BUILD_PROFILE');
  } catch (err) {
    resp = { ok: false, error: err.message };
  }

  els.btnBuildProfile.disabled = false;
  els.btnBuildProfile.textContent = '重新分析';

  if (!resp?.ok) {
    // 「条数不够」是正常状态而不是故障 —— 文案要说清下一步，不能只丢一句失败
    renderProfileNotice(resp?.error || '分析失败。');
    return;
  }

  renderProfile(resp);
}

function renderProfileNotice(text) {
  els.profileBody.innerHTML = '';
  els.profileBody.append(el('p', 'hint is-fail', text));
  els.profileNote.textContent = '还没能给出结论';
}

function renderProfile(profile) {
  els.profileBody.innerHTML = '';
  els.profileNote.textContent = `基于最近 ${profile.sampleCount} 条 · ${formatWhen(profile.builtAt)}`;
  // 已经有画像了，按钮的语义从「分析」变成「重新分析」。
  // 重开侧栏还原出来的画像也走这里 —— 否则按钮会显示「分析我的收藏」，像是从没算过。
  els.btnBuildProfile.textContent = '重新分析';

  const box = el('div', 'notice');

  if (profile.summary) box.append(el('p', 'notice-body', profile.summary));

  if (profile.themes?.length) {
    const ul = el('ul', 'profile-themes');

    for (const theme of profile.themes) {
      const li = el('li');
      li.append(el('span', 'profile-theme', theme.name), el('span', 'profile-note', theme.note));
      ul.append(li);
    }

    box.append(el('p', 'notice-title', '你在关注'), ul);
  }

  // 位置分两行：枚举值 + 它的依据。依据才是用户判断「这画像靠不靠谱」的东西，
  // 只给一个「进阶」等于没给。
  if (profile.level) {
    box.append(el('p', 'notice-body', `现在的位置：${profile.level}`));
    if (profile.stageReason) box.append(el('p', 'hint', profile.stageReason));
  }

  if (profile.lean) box.append(el('p', 'notice-body', `倾向：${profile.lean}`));

  els.profileBody.append(box);

  // 分类分布是代码从归档里数出来的真实数字，和上边模型给的定性判断分开显示 ——
  // 免得用户把两者都当成「模型说的」
  const dist = Object.entries(profile.byCategory || {}).sort((a, b) => b[1] - a[1]);

  if (dist.length) {
    const list = el('ul', 'row-list');

    for (const [name, count] of dist) {
      const li = el('li', 'row-item');
      li.append(el('span', 'row-title', name), el('span', 'row-host', `${count} 条`));
      list.append(li);
    }

    els.profileBody.append(el('p', 'hint', '归档里各分类的条数（直接统计，不是模型估的）'), list);
  }
}

function formatWhen(ts) {
  if (!ts) return '—';

  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 重开侧栏时先把上次的画像渲染出来，不必重跑一遍模型
async function restoreProfile() {
  try {
    const resp = await send('GET_PROFILE');
    if (resp?.ok && resp.profile) renderProfile(resp.profile);
  } catch {
    // 还原失败不影响使用，忽略
  }
}

// ---------------------------------------------------------------------------
// 行动清单（2.6）
// ---------------------------------------------------------------------------
//
// 整条链路的终点：分类 → 归档 → 画像 → 清单。
// 前面每一步产出的都是「对内容的理解」，只有这里产出「对下一步的建议」。
//
// 它依赖画像，但用户点的是「生成行动清单」—— 没有画像时后台会顺手算一份，
// 不该要求他先去点另一个按钮。

async function handleBuildActions() {
  if (els.btnBuildActions.disabled) return;

  els.btnBuildActions.disabled = true;
  els.btnBuildActions.textContent = '生成中…（约 30 秒）';
  // 没有画像时会先算画像，这一步要说出来，否则用户以为卡住了
  els.actionNote.textContent = '正在读归档、调用本地模型';

  let resp;
  try {
    resp = await send('BUILD_ACTIONS');
  } catch (err) {
    resp = { ok: false, error: err.message };
  }

  els.btnBuildActions.disabled = false;
  els.btnBuildActions.textContent = '重新生成';

  if (!resp?.ok) {
    renderActionsNotice(resp);
    return;
  }

  // 后台在没有画像时顺手算了一份 —— 这边把画像卡片一起刷新，
  // 否则会出现「清单出来了，画像却还是空的」这种自相矛盾的状态
  if (resp.profileStep === 'built') {
    try {
      const p = await send('GET_PROFILE');
      if (p?.ok && p.profile) renderProfile(p.profile);
    } catch {
      // 画像卡片没刷新不影响清单本身
    }
  }

  renderActions(resp);
}

function renderActionsNotice(resp) {
  els.actionBody.innerHTML = '';
  els.actionBody.append(el('p', 'hint is-fail', resp?.error || '生成失败。'));
  els.actionNote.textContent =
    resp?.stage === 'profile' ? '画像那一步就没成' : '还没能给出清单';
}

function renderActions(plan) {
  els.actionBody.innerHTML = '';
  els.actionNote.textContent = `基于最近 ${plan.sampleCount} 条 · ${formatWhen(plan.builtAt)}`;
  // 已经有清单了，按钮语义从「生成」变成「重新生成」——
  // 重开侧栏还原出来的清单也走这里，否则按钮会像是从没生成过
  els.btnBuildActions.textContent = '重新生成';

  if (plan.gap) {
    const gap = el('div', 'notice');
    gap.append(el('p', 'notice-title', '最该补的一块'), el('p', 'notice-body', plan.gap));
    els.actionBody.append(gap);
  }

  const list = el('ul', 'action-list');

  for (const action of plan.actions || []) {
    const li = el('li', 'action-item');

    const head = el('p', 'action-head');
    if (action.kind) {
      const kind = el('span', 'action-kind', action.kind);
      kind.dataset.kind = action.kind;
      head.append(kind);
    }
    head.append(el('span', 'action-title', action.title || ''));
    li.append(head);

    if (action.why) li.append(el('p', 'action-line', `为什么：${action.why}`));
    if (action.how) li.append(el('p', 'action-line', `第一步：${action.how}`));

    // 引用的收藏直接给链接 —— 清单的价值一半在「做什么」，
    // 另一半在「拿什么做」，让人能立刻点进去
    const refs = (action.refs || []).filter((r) => r?.url);
    if (refs.length) {
      const line = el('p', 'action-refs', '参考：');

      refs.forEach((ref, i) => {
        if (i) line.append(document.createTextNode(' · '));
        const a = el('a', '', ref.title || ref.url);
        a.href = ref.url;
        a.target = '_blank';
        a.rel = 'noreferrer';
        a.title = ref.url;
        line.append(a);
      });

      li.append(line);
    }

    list.append(li);
  }

  els.actionBody.append(list);
}

async function restoreActions() {
  try {
    const resp = await send('GET_ACTIONS');
    if (resp?.ok && resp.actionPlan) renderActions(resp.actionPlan);
  } catch {
    // 还原失败不影响使用，忽略
  }
}

// ---------------------------------------------------------------------------
// 归档搜索（2.3）
// ---------------------------------------------------------------------------
//
// 前面攒下来的东西到这里才算真正用上：不必「再消化一次」才能看到旧内容。
//
// 搜索是**本地**的（在 IndexedDB 里扫），不经过模型 —— 关键词匹配没必要花 20 秒。
// 按语义找（「跟性能有关的」）是另一个量级的事，先不做。
//
// 分页用「上一页最后一条的时间」当游标，而不是把整库拉到侧栏再切：
// 库会越攒越大，一次全读出来的代价迟早会显出来。

const ARCHIVE_PAGE = 30;

let archiveBefore = null; // 下一页从哪开始（null = 从头）
let archiveSeq = 0; // 请求序号，用来丢弃过期结果

async function searchArchive({ more = false } = {}) {
  // 防抖只保证「不在打字途中狂发请求」，但用户停一下又改一个字时，
  // 两个请求会同时在飞 —— 先发的不一定先回，界面就可能显示上一个词的結果。
  // 所以每次请求带一个序号，回来时对不上就丢掉。
  const seq = ++archiveSeq;

  if (!more) archiveBefore = null;
  els.btnArchiveMore.disabled = true;

  let resp;
  try {
    resp = await send('SEARCH_ARCHIVE', {
      keyword: els.archiveKeyword.value.trim(),
      category: els.archiveCategory.value,
      limit: ARCHIVE_PAGE,
      before: archiveBefore
    });
  } catch (err) {
    resp = { ok: false, error: err?.message || String(err) };
  }

  if (seq !== archiveSeq) return; // 已经有更新的查询了，这次结果作废

  els.btnArchiveMore.disabled = false;

  if (!resp?.ok) {
    els.archiveStat.textContent = '读归档失败';
    els.archiveHint.textContent = resp?.error || '读归档失败。';
    els.archiveHint.className = 'hint is-fail';
    return;
  }

  if (!more) els.archiveList.innerHTML = '';

  for (const row of resp.rows) {
    els.archiveList.append(buildArchiveItem(row));
  }

  archiveBefore = resp.nextBefore;
  setHidden(els.btnArchiveMore, !resp.hasMore);
  els.archiveHint.className = 'hint';

  renderArchiveStat(resp);
}

function renderArchiveStat(resp) {
  const shown = els.archiveList.children.length;
  const filtered = !!els.archiveKeyword.value.trim() || !!els.archiveCategory.value;

  if (!resp.total) {
    els.archiveStat.textContent = '库里还没有内容';
    els.archiveHint.textContent = '先消化几篇（粘贴链接、收藏夹、当前页面都行），这里就有东西可翻了。';
    return;
  }

  els.archiveStat.textContent = filtered
    ? `命中 ${shown}${resp.hasMore ? '+' : ''} 条 · 库中 ${resp.total} 篇`
    : `显示 ${shown}${resp.hasMore ? '+' : ''} 条 · 库中 ${resp.total} 篇`;

  if (!shown && filtered) {
    els.archiveHint.textContent = '没找到匹配的内容。换个词试试，或者把分类改回「全部分类」。';
  } else if (!shown) {
    els.archiveHint.textContent = '库里还没有内容。';
  } else {
    els.archiveHint.textContent = '点标题展开摘要与要点；「打开原文」直接跳过去。按最近消化排序。';
  }
}

function buildArchiveItem(row) {
  const li = el('li', 'archive-item');
  const details = document.createElement('details');

  const summary = el('summary', 'archive-summary');
  // 老记录可能没有分类（阶段 1 落下时还没有这个字段），chip 会返回 null
  const chip = buildCategoryChip(row.category);
  if (chip) summary.append(chip);

  const wrap = el('div', 'archive-title-wrap');
  wrap.append(el('span', 'archive-title', row.title || '(无标题)'));

  const meta = [
    row.host,
    formatWhen(row.firstDigestedAt || row.digestedAt),
    row.digestCount > 1 ? `读过 ${row.digestCount} 次` : ''
  ].filter(Boolean);

  wrap.append(el('span', 'archive-meta', meta.join(' · ')));
  summary.append(wrap);
  details.append(summary);

  // 摘要和要点跟着列表一起回来，所以展开是瞬时的 —— 不必再请求一次。
  // 代价只是把这两项带上，而它们本来就是用户要看的东西。
  const body = el('div', 'archive-body');
  if (row.summary) body.append(el('p', 'result-summary', row.summary));
  if (row.points?.length) body.append(buildPoints(row.points));

  if (row.url) {
    const link = el('a', 'archive-link', '打开原文 ↗');
    link.href = row.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    body.append(link);
  }

  details.append(body);
  li.append(details);
  return li;
}

// 输入时不要每敲一个字就查一次库
function debounce(fn, wait) {
  let timer = null;

  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const searchArchiveDebounced = debounce(() => searchArchive(), 250);

// ---------------------------------------------------------------------------
// 结果渲染
// ---------------------------------------------------------------------------

// 最近一次成功的结果，供「复制结果」取内容。
// 侧栏重开是由 storage 还原的，那条路径也会重新走一遍 renderResult，所以这里只管当前这次。
let currentResult = null;

// 拼复制出去的文本。刻意不加 Markdown 标记 —— 粘到微信、记事本、聊天框里
// 「#」「**」只会碍眼；「标题 · 分类」+ 空行 + 编号列表，在哪都读得顺。
function buildCopyText(result) {
  const title = result?.source?.title || '';
  const url = result?.source?.url || '';
  const { category, summary, points } = result?.value || {};

  const head = [title, category].filter(Boolean).join(' · ');
  const lines = [];

  if (head) lines.push(head);
  if (summary) lines.push('', summary);

  if (Array.isArray(points) && points.length) {
    lines.push('');
    for (const [index, point] of points.entries()) lines.push(`${index + 1}. ${point}`);
  }

  if (url) lines.push('', `来源：${url}`);

  return lines.join('\n').trim();
}

let copyResetTimer = null;

async function handleCopyResult() {
  const text = currentResult ? buildCopyText(currentResult) : '';
  if (!text) return;

  let done = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 扩展页面调 navigator.clipboard 需要 clipboardWrite 权限，没声明时会被拒。
    // 退回到 execCommand —— 它虽已废弃，但只要求当前有用户手势，兼容性反而最稳。
    done = legacyCopy(text);
  }

  els.btnCopyResult.textContent = done ? '已复制 ✓' : '复制失败，请手动选中';
  clearTimeout(copyResetTimer);
  copyResetTimer = setTimeout(() => {
    els.btnCopyResult.textContent = '复制结果';
  }, 1600);
}

function legacyCopy(text) {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

// 结果卡片能收起：它常常有十几条要点，展开着会把下面的画像、本地模型全挤下去。
// 两个时机要用不同策略，所以把决定权交给调用方，这里不猜 ——
//   刚消化完的这一次：必须展开，否则用户会以为没出结果
//   重开侧栏还原上次的结果：按用户上次的选择（默认收起）
const RESULT_OPEN_KEY = 'resultCardOpen';

function setResultOpen(open) {
  if (els.resultCard.open !== open) els.resultCard.open = open;
}

// 来源同时写两处：折叠区内是完整描述（含抓到的字数），标题右侧是标题本身。
// 收起时靠后者认出这是哪一篇。
function setResultSource(source) {
  els.resultSource.textContent = describeSource(source);
  els.resultNote.textContent = source?.title || source?.url || '—';
}

function renderResult(resp, origin, { collapsed = false } = {}) {
  els.resultBody.innerHTML = '';
  els.resultBody.className = '';
  els.resultMeta.textContent = '';
  els.resultNote.textContent = '—';
  setHidden(els.resultRawWrap, true);
  setResultOpen(!collapsed);
  setHidden(els.resultCard, false);

  // 复制按钮只在出了真实结果时出现 —— 失败提示没什么可复制的。
  // 顺带把这次的结果留住，供复制时取内容。
  currentResult = resp?.ok === true && resp?.value?.ok === true ? resp : null;
  setHidden(els.btnCopyResult, !currentResult);
  els.btnCopyResult.textContent = '复制结果';

  // 落库失败（网络 / 抓取 / 校验耗尽）—— 用抓取到的来源信息兜底显示
  if (!resp || resp.ok !== true) {
    renderFailure(resp);
    return;
  }

  const { value, meta, attempts, source, extract } = resp;

  setResultSource(source);

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

    // 图文帖的账要露出来：摘要突然有内容了，用户得知道是因为多喂了图片里的文字
    if (resp.ocr?.used) {
      els.resultBody.append(el('p', 'hint', buildOcrNote(resp.ocr)));
    }

    // 归档状态。落库是后面「画像 / 清单 / 搜索」的地基，用户得看得见它在工作；
    // 同一篇重复消化时更要明说 —— 否则会以为库里又存了一条重复的。
    const archiveNote = buildArchiveNote(resp.archive);
    if (archiveNote) els.resultBody.append(el('p', 'hint', archiveNote));
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

  // 登录页在上面已经解释清楚了，再补一句「切过去看看加载了什么」，
  // 只会让人以为那边还有东西没看到
  if (extract?.keptTabOpen && !extract?.loginWall) {
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

  // 登录 / 权限校验页：对它说「切到前台重试」是空头支票 ——
  // 用户自己打开也只是登录界面，重试多少次还是那十几个字。
  // 该给的是「先登录」这一步，而不是重试建议。
  if (resp?.extract?.loginWall) {
    box.append(
      el('p', 'notice-title', '这一页需要先登录'),
      el(
        'p',
        'notice-body',
        `只抓到 ${chars} 个字，页面停在登录 / 权限校验界面（${describeLoginWall(resp.extract.loginWall)}）。`
      ),
      el(
        'p',
        'hint',
        '先在浏览器里把这一页登录好，再切回这里、用上面的「当前页面」入口消化 —— 登录之后才有正文。'
      ),
      el(
        'p',
        'hint',
        '如果这一页本来就只是个登录页（比如学校的统一身份认证），那它没有内容可消化，忽略即可。'
      )
    );
    els.resultBody.append(box);
    return;
  }

  box.append(el('p', 'notice-title', '这个页面没抓到正文'));

  // 图文帖走了 OCR 还是没结果 —— 这是另一种情况，不能和「页面没渲染出来」混为一谈：
  // 页面明明渲染好了，是图里的字没被认出来，用户要做的也不是「切到前台重试」。
  if (resp?.ocrAttempted) {
    box.append(
      el(
        'p',
        'notice-body',
        `正文只有 ${chars} 字，${resp.ocrAttempted} 张图片也都没能识别出可用文字。常见的两种：图是艺术字标题 / 纯装饰图，或者图里的字太小太花。`
      ),
      el(
        'p',
        'hint',
        '这种情况下没有可总结的实质内容 —— 与其让模型拿开场白编一份摘要，不如直说没抓到。'
      )
    );
    els.resultBody.append(box);
    return;
  }

  box.append(
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

// 把抓取侧报的登录墙原因翻译成人话 —— 用户该知道是凭什么判断的，
// 否则「你凭什么说这是登录页」本身就成了新的疑问。
function describeLoginWall(reason) {
  const reasons = {
    url: '地址里带登录标识',
    password: '页面有密码输入框',
    captcha: '页面有验证码输入框',
    text: '页面只有登录相关文字'
  };

  return reasons[reason] || '页面特征像是登录页';
}

// 归档状态。新增 / 重复覆盖 / 没存上，三种情况要说不同的话 ——
// 尤其第二种：不说清楚，用户会以为库里又添了一条重复的。
function buildArchiveNote(archive) {
  if (!archive) return '';

  if (archive.error) {
    return `这次没能归档（${archive.error}）—— 摘要照样能看，但没进本地库。`;
  }

  if (archive.isNew === false) {
    return `这篇之前消化过，已更新归档（第 ${archive.digestCount} 次 · 库中 ${archive.total} 篇）。`;
  }

  if (archive.isNew === true) {
    return `已归档 · 库中 ${archive.total} 篇。`;
  }

  return '';
}

// OCR 的账：看了几张、认出几张、补了多少字。
// 这三件事用户都该知道 —— 摘要质量突然变好或变差，原因就在这里。
function buildOcrNote(ocr) {
  const parts = [`这一页的正文在图里：${ocr.total} 张图识别出 ${ocr.recognized} 张，补进 ${ocr.chars} 字`];

  if (ocr.dropped) {
    parts.push(`${ocr.dropped} 张没认出可用文字（多是封面艺术字或装饰图）`);
  }

  // 两种「没识别」的原因不一样，要分开说，否则用户看到张数对不上会怀疑漏了内容
  const skipped = (ocr.imageTotal || ocr.total) - ocr.total;
  if (skipped > 0) {
    parts.push(`另有 ${skipped} 张不在正文区，没有送来识别`);
  }

  if (ocr.stoppedByBudget) {
    parts.push(`还有 ${ocr.stoppedByBudget} 张没识别（前面认出的字已经够用，继续认只是白等）`);
  }

  return `${parts.join('，')}。`;
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

  setResultSource(resp?.source);
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

// 下拉里第一项固定是它，代表「跨所有文件夹取最近 N 条」
const RECENT_VALUE = '__recent';
// 记住上次选的收藏夹与批量条数 —— 侧栏关掉重开内存就没了，这类偏好得落 storage
const FOLDER_STORE_KEY = 'lastBookmarkFolder';
const BATCH_FOLDER_STORE_KEY = 'lastBatchFolder';
const BATCH_SIZE_STORE_KEY = 'lastBatchSize';

// 把收藏夹树填进下拉框。只在第一次切到相关面板时调用（见 switchPane）。
async function loadBookmarkFolders() {
  els.bookmarkFolder.disabled = true;
  els.batchFolder.disabled = true;

  let resp;
  try {
    resp = await send('GET_BOOKMARK_FOLDERS');
  } catch (err) {
    resp = { ok: false, error: err.message };
  }

  els.bookmarkFolder.disabled = false;
  els.batchFolder.disabled = false;

  // 拿不到文件夹不算致命：保留「最近收藏」这一项，真去读的时候会给出明确原因
  // （多半是没给 bookmarks 权限，service-worker 会返回能照着做的提示）
  if (!resp?.ok) {
    els.bookmarkFolder.title = resp?.error || '';
    els.batchFolder.title = resp?.error || '';
    return;
  }

  const stored = await chrome.storage.local
    .get([FOLDER_STORE_KEY, BATCH_FOLDER_STORE_KEY])
    .catch(() => ({}));

  // 单条消化和批量用的是同一棵树：前者关心「这次读哪个」，后者关心「从哪一批里取」
  fillFolderSelect(els.bookmarkFolder, resp.folders, stored?.[FOLDER_STORE_KEY]);
  fillFolderSelect(els.batchFolder, resp.folders, stored?.[BATCH_FOLDER_STORE_KEY]);
}

// 把收藏夹树填进一个下拉框。第一项「最近收藏」始终保留，只重建后续项。
function fillFolderSelect(select, folders, wanted) {
  select.length = 1;

  for (const folder of folders) {
    const option = document.createElement('option');
    option.value = folder.id;

    // 缩进表示层级：侧栏只有三百来像素，塞不下可展开的树控件
    const indent = '　'.repeat(folder.depth); // 全角空格，比普通空格更稳
    const scope = folder.direct
      ? `（${folder.direct} 篇）`
      : folder.subFolders
        ? `（含 ${folder.subFolders} 个子文件夹）`
        : '（空）';

    option.textContent = `${indent}${folder.title}${scope}`;
    select.append(option);
  }

  // 上次选的收藏夹可能已经被删掉了，确认还在选项里再恢复
  if (wanted && [...select.options].some((o) => o.value === wanted)) {
    select.value = wanted;
  }
}

// 收藏夹树只在第一次切到面板时读一次。用户中途新建了收藏夹，下拉里就不会出现 ——
// 给一个手动刷新的入口，比每次切面板都重读一遍收藏夹树划算。
async function handleRefreshFolders() {
  const keepBatch = els.batchFolder.value;
  const keepSingle = els.bookmarkFolder.value;

  els.btnRefreshFolders.disabled = true;
  els.btnRefreshFolders.textContent = '刷新中…';

  try {
    await loadBookmarkFolders();
  } finally {
    els.btnRefreshFolders.disabled = false;
    els.btnRefreshFolders.textContent = '刷新列表';
  }

  // 尽量留住用户当前选的那个 —— 新建一个收藏夹不该把已选中的顶掉
  for (const [select, keep] of [
    [els.batchFolder, keepBatch],
    [els.bookmarkFolder, keepSingle]
  ]) {
    if (keep && [...select.options].some((o) => o.value === keep)) select.value = keep;
  }
}

async function handleLoadBookmarks() {
  const folderId = els.bookmarkFolder.value;
  const isRecent = folderId === RECENT_VALUE;

  els.btnLoadBookmarks.disabled = true;
  els.btnLoadBookmarks.textContent = '读取中…';
  els.bookmarkHint.className = 'hint';

  let resp;
  try {
    resp = isRecent
      ? await send('GET_RECENT_BOOKMARKS', { limit: 20 })
      : await send('GET_BOOKMARKS_IN_FOLDER', { folderId, limit: 50 });
  } catch (err) {
    resp = { ok: false, error: err.message };
  }

  els.btnLoadBookmarks.disabled = false;
  els.btnLoadBookmarks.textContent = '读取';
  els.bookmarkList.innerHTML = '';

  if (!resp?.ok) {
    els.bookmarkHint.className = 'hint is-fail';
    // service-worker 返回的 error 自带「读取收藏夹失败：…」这类前缀，这里不要再叠一层
    els.bookmarkHint.textContent = resp?.error || '读取失败：未知原因';
    return;
  }

  if (!resp.items.length) {
    els.bookmarkHint.className = 'hint';
    els.bookmarkHint.textContent = isRecent
      ? '最近 20 条收藏里没有可抓取的网页，只有文件夹或本地链接。'
      : '这个收藏夹里没有可抓取的网页（可能只存了文件夹或本地文件）。';
    return;
  }

  els.bookmarkHint.className = 'hint';
  const capped = resp.total > resp.items.length
    ? `（这个收藏夹共 ${resp.total} 条，先列出最近 ${resp.items.length} 条）`
    : '';
  els.bookmarkHint.textContent = `共 ${resp.items.length} 条${capped}，点任意一条直接消化。`;

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

// 还原上次的单条结果。默认**收起** —— 它是上次的产物，不是这次操作的反馈，
// 展开着会把下面的画像、本地模型都挤下去（用户就是为这个要求加折叠的）。
// 但用户上次自己展开过，就按展开还原：那是他的选择，不该每次重开都被推翻。
async function restoreLastDigest(open) {
  try {
    const resp = await send('GET_LAST_DIGEST');
    if (resp?.ok && resp.digest) {
      renderResult(resp.digest, 'restore', { collapsed: !open });
    }
  } catch {
    // 还原失败不影响使用，忽略
  }
}

async function init() {
  // 先渲染上次的探活结果，避免侧栏重开时一片空白
  const {
    ollamaStatus,
    [BATCH_SIZE_STORE_KEY]: lastBatchSize,
    [RESULT_OPEN_KEY]: lastResultOpen
  } = await chrome.storage.local.get(['ollamaStatus', BATCH_SIZE_STORE_KEY, RESULT_OPEN_KEY]);
  renderOllamaStatus(ollamaStatus);

  // 批量的收藏夹选择由 fillFolderSelect 在加载列表时恢复，条数在这里恢复
  if (lastBatchSize) els.batchSize.value = lastBatchSize;

  await refreshActiveTab();
  await restoreLastDigest(lastResultOpen === true);
  await restoreProfile();
  await restoreActions();
  await checkOllama();

  els.inputTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (tab) switchPane(tab.dataset.pane);
  });

  els.btnDigestUrl.addEventListener('click', handleDigestUrl);
  wireUrlInput();

  els.btnDigestCurrent.addEventListener('click', () => runDigest('current'));
  els.btnExtract.addEventListener('click', handleExtract);
  els.btnLoadBookmarks.addEventListener('click', handleLoadBookmarks);
  // 选了哪个收藏夹就记住，下次开侧栏还是它
  els.bookmarkFolder.addEventListener('change', () => {
    chrome.storage.local.set({ [FOLDER_STORE_KEY]: els.bookmarkFolder.value }).catch(() => {});
  });

  els.btnRunBatch.addEventListener('click', handleRunBatch);
  // 归档：输入即搜（防抖 250ms），换分类立刻重查，翻页追加
  els.archiveKeyword.addEventListener('input', searchArchiveDebounced);
  els.archiveCategory.addEventListener('change', () => searchArchive());
  els.btnArchiveMore.addEventListener('click', () => searchArchive({ more: true }));
  els.btnRefreshFolders.addEventListener('click', handleRefreshFolders);
  els.batchFolder.addEventListener('change', () => {
    chrome.storage.local.set({ [BATCH_FOLDER_STORE_KEY]: els.batchFolder.value }).catch(() => {});
  });
  els.batchSize.addEventListener('change', () => {
    chrome.storage.local.set({ [BATCH_SIZE_STORE_KEY]: els.batchSize.value }).catch(() => {});
  });
  els.btnCopyResult.addEventListener('click', handleCopyResult);
  // 记住结果卡片的展开 / 收起选择。
  // 绑在 summary 的 click 上而不是 details 的 toggle —— 程序设置 open 也会触发 toggle，
  // 那样「新结果自动展开」会顺手把偏好改成展开，下次重开就永远是展开的。
  // click 发生在状态切换之前，所以这里取到的是「即将变成」的值。
  els.resultCard.querySelector('summary').addEventListener('click', () => {
    chrome.storage.local.set({ [RESULT_OPEN_KEY]: !els.resultCard.open }).catch(() => {});
  });
  els.btnRecheck.addEventListener('click', checkOllama);
  els.btnBuildProfile.addEventListener('click', handleBuildProfile);
  els.btnBuildActions.addEventListener('click', handleBuildActions);

  // 切标签页 / 页面跳转时同步当前页信息
  chrome.tabs.onActivated.addListener(refreshActiveTab);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url) refreshActiveTab();
  });
}

init();
