// WisdoMark · 侧栏界面逻辑（阶段 1）
//
// 侧栏随时可能被关闭重开，所以不依赖内存状态：
// 需要留存的内容一律落 chrome.storage，重开时先渲染缓存再刷新。

import { recognizeImages, mergeWithDocument } from './ocr.js';

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
  bookmarkFolder: document.getElementById('bookmark-folder'),
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

  // 收藏夹列表懒加载 —— 没必要每次打开侧栏都去读一遍收藏夹树
  if (name === 'bookmarks' && !bookmarkFoldersLoaded) {
    bookmarkFoldersLoaded = true;
    loadBookmarkFolders();
  }
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
async function digestWithOcr(ocr) {
  const images = ocr?.images || [];

  let recognized;
  try {
    recognized = await recognizeImages(images, {
      domText: ocr?.text || '',
      onProgress: ({ stage, index, total }) => {
        setRunLabel(
          stage === 'engine'
            ? '正文在图里，正在启动本地 OCR'
            : `正在识别图片里的文字 ${index}/${total}`
        );
      }
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

function renderResult(resp, origin) {
  els.resultBody.innerHTML = '';
  els.resultBody.className = '';
  els.resultMeta.textContent = '';
  setHidden(els.resultRawWrap, true);
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

    // 图文帖的账要露出来：摘要突然有内容了，用户得知道是因为多喂了图片里的文字
    if (resp.ocr?.used) {
      els.resultBody.append(el('p', 'hint', buildOcrNote(resp.ocr)));
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

// 下拉里第一项固定是它，代表「跨所有文件夹取最近 N 条」
const RECENT_VALUE = '__recent';
// 记住上次选的收藏夹 —— 侧栏关掉重开内存就没了，这类偏好得落 storage
const FOLDER_STORE_KEY = 'lastBookmarkFolder';

// 把收藏夹树填进下拉框。只在第一次切到这个面板时调用（见 switchPane）。
async function loadBookmarkFolders() {
  els.bookmarkFolder.disabled = true;

  let resp;
  try {
    resp = await send('GET_BOOKMARK_FOLDERS');
  } catch (err) {
    resp = { ok: false, error: err.message };
  }

  els.bookmarkFolder.disabled = false;

  // 拿不到文件夹不算致命：保留「最近收藏」这一项，真去读的时候会给出明确原因
  // （多半是没给 bookmarks 权限，service-worker 会返回能照着做的提示）
  if (!resp?.ok) {
    els.bookmarkFolder.title = resp?.error || '';
    return;
  }

  const stored = await chrome.storage.local.get(FOLDER_STORE_KEY).catch(() => ({}));

  // 只重建后续项，第一项「最近收藏」始终保留
  els.bookmarkFolder.length = 1;

  for (const folder of resp.folders) {
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
    els.bookmarkFolder.append(option);
  }

  // 上次选的收藏夹可能已经被删掉了，确认还在选项里再恢复
  const wanted = stored?.[FOLDER_STORE_KEY];
  if (wanted && [...els.bookmarkFolder.options].some((o) => o.value === wanted)) {
    els.bookmarkFolder.value = wanted;
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
  wireUrlInput();

  els.btnDigestCurrent.addEventListener('click', () => runDigest('current'));
  els.btnExtract.addEventListener('click', handleExtract);
  els.btnLoadBookmarks.addEventListener('click', handleLoadBookmarks);
  // 选了哪个收藏夹就记住，下次开侧栏还是它
  els.bookmarkFolder.addEventListener('change', () => {
    chrome.storage.local.set({ [FOLDER_STORE_KEY]: els.bookmarkFolder.value }).catch(() => {});
  });
  els.btnCopyResult.addEventListener('click', handleCopyResult);
  els.btnRecheck.addEventListener('click', checkOllama);

  // 切标签页 / 页面跳转时同步当前页信息
  chrome.tabs.onActivated.addListener(refreshActiveTab);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url) refreshActiveTab();
  });
}

init();
