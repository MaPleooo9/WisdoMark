// WisdoMark · 正文图片的离线 OCR（侧栏）
//
// 解决的场景：图文帖（B 站 opus、小红书笔记、公众号长图）的干货在图里，文字只有开场白。
// 实测那篇《零基础 AI Agent 学习路线图》：DOM 只给到 1118 字开场白，
// 七个阶段的划分、Track A / Track B、每个阶段要用的工具全在 16 张图里，
// 不识别图就只能写出一份空洞的摘要。
//
// 为什么 OCR 放在侧栏，不放在 service worker：
//   1. MV3 的 service worker 起不了 Worker，也不能跑 WebAssembly（会被回收，且 CSP 卡死）；
//   2. 侧栏是扩展页面，和 service worker 一样有 host_permissions 兜底，
//      取跨源图片不受 CORS 限制（B 站图床实测 200 + `Access-Control-Allow-Origin: *`）；
//   3. 一张图识别约 1 秒、8 张就是 8 秒 —— 这个等待过程必须能显示进度，侧栏正是显示的地方。
//
// 引擎是仓库里 vendor/tesseract 的离线构建，全程不联网。
// 三个必须照抄的配置（workerBlobURL / corePath / CSP）见 vendor/tesseract/README.md。

import Tesseract from '../../vendor/tesseract/tesseract.esm.min.js';

// 质量门。实测数据（B 站 opus 正文图）：
//   流程图      2482×2535  置信度 87%  → 收
//   正文截图    1242×1656  置信度 90%  → 收（但和 DOM 文字重复，会被去重丢掉）
//   封面艺术字  1242×1656  置信度 33%  → 丢
// 封面那张是最值得警惕的失败模式：黑字压在带纸纹的浅色背景上，人眼很清楚，
// 但 Tesseract 的二值化会被纹理骗到，输出全是乱码。所以置信度必须卡。
const MIN_CONFIDENCE = 55;
const MIN_CHARS = 8; // 少于这个字数基本是零碎噪声（页码、水印）
const MAX_MERGED_CHARS = 5000; // 拼进正文的上限，再多会把原正文挤出模型上下文

let workerPromise = null;

// worker 只建一次，之后的图片复用。侧栏关掉时进程结束，它会一起没。
function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('chi_sim', 1, {
      workerPath: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
      // 必须 false：tesseract.js 默认用 blob: 起 worker，MV3 的 script-src 'self' 不允许，
      // 报错信息还会指向 workerPath，看上去像路径写错了
      workerBlobURL: false,
      corePath: chrome.runtime.getURL('vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js'),
      langPath: chrome.runtime.getURL('vendor/tesseract/lang')
    }).catch((err) => {
      // 失败不要缓存，否则用户重试一次也永远失败
      workerPromise = null;
      throw err;
    });
  }

  return workerPromise;
}

async function loadCanvas(url) {
  const resp = await fetch(url);

  if (!resp.ok) throw new Error(`取图失败 HTTP ${resp.status}`);

  const blob = await resp.blob();
  if (!blob.size) throw new Error('图片是空的');

  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();

  return canvas;
}

// Tesseract 会在汉字之间插空格（「学 习 路 线 图」），它把每个字当成独立词。
// 不还原回去，喂给模型的正文会变得很难读，模型也更容易抄错关键词。
function normalize(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/(?<=[\u4e00-\u9fa5])[ \t]+(?=[\u4e00-\u9fa5])/g, '')
    .replace(/[ \t]+(?=[，。、；：？！）】》”’])/g, '')
    .replace(/(?<=[（【《“‘])[ \t]+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.replace(/\s/g, '').length >= 2)
    .join('\n')
    .trim();
}

const squeeze = (value) => String(value || '').replace(/\s+/g, '');

// 图文帖里很常见「文字正文 + 同一段文字的截图」。
// 实测 B 站那篇的第 3 张图就是正文的截图，识别置信度 90%、结果几乎一字不差 ——
// 不丢的话，同样的内容会被喂给模型两遍，要点也会重复。
function alreadyInDocument(ocrText, domText) {
  const probe = squeeze(ocrText).slice(0, 24);
  return probe.length >= 12 && squeeze(domText).includes(probe);
}

function buildOcrBlock(items) {
  const parts = [];
  let used = 0;

  for (const [index, item] of items.entries()) {
    const block = `【图片 ${index + 1}】\n${item.text}`;
    if (used + block.length > MAX_MERGED_CHARS) break;
    parts.push(block);
    used += block.length;
  }

  return parts.join('\n\n');
}

// 拼进正文。给模型留一句话说明这段字的来路 —— 它是识别结果，不是原文照抄。
export function mergeWithDocument(domText, ocrBlock) {
  const header = '\n\n【以下文字来自正文里的图片，由本地 OCR 识别，可能有识别误差】\n\n';
  return `${domText || ''}${header}${ocrBlock}`.trim();
}

// images: content script 给的 [{ url, width, height, alt }]
// 返回 { ok, items, dropped, text, chars } —— 一张都没通过质量门时 text 是空串
export async function recognizeImages(images, { domText = '', onProgress } = {}) {
  if (!images?.length) return { ok: false, error: '没有可识别的图片' };

  const report = (stage, index) => onProgress?.({ stage, index, total: images.length });

  report('engine', 0);

  let worker;
  try {
    worker = await getWorker();
  } catch (err) {
    return { ok: false, error: `OCR 引擎启动失败：${err?.message || err}` };
  }

  const items = [];
  let dropped = 0;

  for (const [index, image] of images.entries()) {
    report('recognize', index + 1);

    try {
      const canvas = await loadCanvas(image.url);
      const { data } = await worker.recognize(canvas);
      const text = normalize(data.text);
      const confidence = Math.round(data.confidence || 0);

      if (confidence < MIN_CONFIDENCE || text.replace(/\s/g, '').length < MIN_CHARS) {
        dropped += 1;
        continue;
      }

      if (alreadyInDocument(text, domText)) {
        dropped += 1;
        continue;
      }

      items.push({ url: image.url, text, confidence });
    } catch {
      // 单张图取不到 / 解码失败不该毁掉整次消化，记一笔继续
      dropped += 1;
    }
  }

  const text = buildOcrBlock(items);

  return { ok: true, items, dropped, text, chars: text.length, model: 'tesseract chi_sim (fast)' };
}
