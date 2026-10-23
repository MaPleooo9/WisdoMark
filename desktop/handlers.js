// 消息处理的单一来源。
//
// main.js（真实窗口）与 verify-ipc.js（验证脚本）都 require 这一份 ——
// 否则验证脚本会拿「复制的精简版」去测，测过的是假货。
const path = require('node:path');
const fsp = require('node:fs/promises');
const { pathToFileURL, fileURLToPath } = require('node:url');

// 开发态：desktop/.. = 仓库根；打包后：resources/app-src（见 electron-builder.yml 的 extraResources）
//
// ⚠️ 不能用 app.isPackaged 判断：直接用官方 electron.exe 加载 resources/app.asar 时，
// process.defaultApp 仍是 true，isPackaged 会误判成 false，ROOT 落到 resources/ 上，
// 报 "Cannot find module ...\resources\manifest.json"（2026-10-23 实测）。
// 用 __dirname 在不在 asar 里判断，跟怎么启动无关。
const ROOT = __dirname.includes('app.asar')
  ? path.join(process.resourcesPath, 'app-src')
  : path.join(__dirname, '..');

const storeFile = require('./store-file.js');
const { fetchPage } = require('./fetcher.js');

// shared.js 用 chrome.runtime.getURL + fetch 读两个 JSON。
// 主进程没有 chrome，shim 一份 file:// 版本。
globalThis.chrome = {
  runtime: { getURL: (relative) => pathToFileURL(path.join(ROOT, relative)).href },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const s = String(url);
  if (s.startsWith('file://')) {
    const text = await fsp.readFile(fileURLToPath(s), 'utf8');
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, opts);
};

// 业务模块是 ESM，主进程是 CJS —— 动态 import 一次并缓存
let mods = null;
async function loadMods() {
  if (!mods) {
    const [knowledge, digest, llm, shared] = await Promise.all([
      import(pathToFileURL(path.join(ROOT, 'src/background/knowledge.js')).href),
      import(pathToFileURL(path.join(ROOT, 'src/background/digest.js')).href),
      import(pathToFileURL(path.join(ROOT, 'src/background/llm.js')).href),
      import(pathToFileURL(path.join(ROOT, 'src/background/shared.js')).href),
    ]);
    mods = { knowledge, digest, llm, shared };
  }
  return mods;
}

// 用户经常只粘 "example.com/a/b"，补上协议头再试
function normalizeUrl(input) {
  const value = String(input || '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+(\/|$|\?|#)/.test(value)) return `https://${value}`;
  return null;
}

async function handleMessage(msg) {
  const type = msg?.type || '';

  try {
    switch (type) {
      case 'PING_OLLAMA': {
        const { llm } = await loadMods();
        return await llm.pingOllama();
      }

      // 贴网址就消化：抓取 → 护栏 → 消化 → 落库
      case 'DIGEST_URL': {
        const target = normalizeUrl(msg.url);
        if (!target) return { ok: false, error: '请填一个 http/https 开头的链接' };

        const captured = await fetchPage(target);
        if (!captured.ok) return captured;

        if (captured.consentWall) {
          return {
            ok: false,
            error: '这一页是 Cookie / 隐私声明页，没有可消化的正文',
            extract: { consentWall: captured.consentWall, lowContent: true },
          };
        }

        if (captured.loginWall) {
          return {
            ok: false,
            error: '这一页需要先登录（登录 / 验证码 / 权限校验）',
            extract: { loginWall: captured.loginWall, lowContent: true },
          };
        }

        if (captured.charCount < 400) {
          return {
            ok: false,
            error: `正文只有 ${captured.charCount} 字，没有可总结的实质内容`,
            source: { title: captured.title, url: captured.url, charCount: captured.charCount },
            extract: { lowContent: true },
          };
        }

        const { digest } = await loadMods();
        const result = await digest.digestDocument({
          title: captured.title,
          url: captured.url,
          text: captured.text,
        });

        if (!result.ok) {
          return {
            ok: false,
            error: result.error || '模型判定这一页没有可消化的正文',
            source: { title: captured.title, url: captured.url, charCount: captured.charCount },
            extract: { lowContent: false },
            attempts: result.attempts,
          };
        }

        const archive = await storeFile.saveDigest({
          url: captured.url,
          title: captured.title,
          category: result.value.category,
          summary: result.value.summary,
          points: result.value.points,
          charCount: captured.charCount,
          // 0.20.0 起归档带全文 —— 桌面端知识库的原料
          text: captured.text,
          model: result.meta?.model || '',
          promptVersion: result.meta?.promptVersion || '',
          attempts: Array.isArray(result.attempts) ? result.attempts.length : 0,
          trace: null,
          ocr: null,
        });

        // 桌面端不做 OCR：图文帖（正文短 + 图多）在扩展里会先识别图片文字再消化，
        // 这里直接按正文来。标出来，别让人以为图里的字被处理过。
        const ocrSkipped =
          Array.isArray(captured.images) && captured.images.length >= 2 && captured.charCount < 2000;

        return {
          ok: true,
          value: result.value,
          // 结果卡片靠 meta / attempts 显示「模型 · 尝试次数 · 耗时」；
          // 不传这两个字段，卡片那行就是空的（不报错，但信息丢了）。
          meta: result.meta,
          attempts: result.attempts,
          source: {
            ...result.source,
            title: captured.title,
            url: captured.url,
            charCount: captured.charCount,
          },
          extract: { lowContent: false, loginWall: null, consentWall: null, ocrSkipped },
          ocr: ocrSkipped ? { used: false, skipped: true, total: captured.images.length } : null,
          archive,
          finishedAt: Date.now(),
        };
      }

      case 'GET_ACTIVE_TAB':
        return { ok: false, error: '桌面端没有「活动标签页」，请用「粘贴链接」' };

      case 'GET_LAST_DIGEST':
        return { ok: true, digest: null };

      case 'GET_ARCHIVE_STATS': {
        const total = await storeFile.countDigests();
        const all = await storeFile.readAllDigests();
        const head = all[all.length - 1] || null;
        return {
          ok: true,
          total,
          latest: head
            ? {
                title: head.title,
                url: head.url,
                category: head.category,
                digestedAt: head.digestedAt,
                digestCount: head.digestCount,
              }
            : null,
        };
      }

      case 'SEARCH_ARCHIVE': {
        const result = await storeFile.searchDigests({
          keyword: msg.keyword || '',
          category: msg.category || '',
          limit: msg.limit || 30,
          before: msg.before || null,
        });
        const [total, { shared }] = await Promise.all([storeFile.countDigests(), loadMods()]);
        const { prompt } = await shared.loadShared();

        return {
          ok: true,
          total,
          hasMore: result.hasMore,
          nextBefore: result.nextBefore,
          version: prompt.version,
          // 白名单投影（与 service-worker 的 searchArchive 一致）；
          // text 刻意不传 —— 一页几十条 × 几千字会把 IPC 撑爆
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
            promptVersion: r.promptVersion || '',
            trace: r.trace || null,
          })),
        };
      }

      case 'GET_ARCHIVE_BY_URL':
        return { ok: true, record: await storeFile.getDigest(msg.url) };

      case 'EXPORT_ARCHIVE': {
        const records = await storeFile.readAllDigests();
        return {
          ok: true,
          format: 'wisdomark-archive',
          formatVersion: 2,
          exportedAt: new Date().toISOString(),
          count: records.length,
          records,
        };
      }

      case 'IMPORT_ARCHIVE': {
        const list = Array.isArray(msg.records) ? msg.records : null;
        if (!list || !list.length) return { ok: false, error: '这个文件里没有可导入的归档记录' };
        const stats = await storeFile.importDigests(list);
        return { ok: true, ...stats, total: await storeFile.countDigests() };
      }

      case 'LIST_CONCEPTS':
        return { ok: true, cards: await storeFile.listConcepts() };

      case 'DELETE_CONCEPT':
        return await storeFile.deleteConcept(msg.key);

      case 'LOOKUP_TERM': {
        const { knowledge } = await loadMods();
        const records = await storeFile.readAllDigests();
        return await knowledge.lookup(msg.term, { aliases: msg.aliases || [], records });
      }

      case 'BUILD_CARD': {
        if (!msg.candidate?.text) return { ok: false, error: '没有选中的原文段落' };

        const { knowledge, shared } = await loadMods();
        const { prompt } = await shared.loadShared();
        const card = await knowledge.buildCard({
          term: msg.term,
          aliases: msg.aliases || [],
          candidate: msg.candidate,
          modelCfg: prompt.model,
        });
        if (!card.ok) return card;

        const saved = await storeFile.saveConcept({
          term: card.term,
          aliases: card.aliases,
          rewrite: card.rewrite,
          quote: card.quote,
          source: card.source,
          model: prompt.model?.name || '',
          confirmed: true,
        });

        return { ...card, saved };
      }

      // 桌面端暂不适用的能力：明确回，不要静默
      case 'GET_FAILURES':
        return { ok: true, failures: [], total: 0 };
      case 'CLEAR_FAILURES':
        return { ok: true };
      case 'GET_PROFILE':
        return { ok: true, profile: null };
      case 'GET_ACTIONS':
        return { ok: true, actionPlan: null };
      case 'GET_RECENT_BOOKMARKS':
      case 'GET_BOOKMARKS_IN_FOLDER':
        return { ok: true, items: [] };
      case 'GET_BOOKMARK_FOLDERS':
        return { ok: true, folders: [] };
      case 'LIST_STALE_DIGESTS':
        return { ok: true, count: 0, rows: [] };

      default:
        return { ok: false, error: `桌面端暂未接入：${type}` };
    }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

module.exports = { handleMessage, loadMods, ROOT };
