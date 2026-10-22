// 消息处理的单一来源。
//
// main.js（真实窗口）与 verify-ipc.js（验证脚本）都 require 这一份 ——
// 否则验证脚本会拿「复制的精简版」去测，测过的是假货。
const path = require('node:path');
const fsp = require('node:fs/promises');
const { pathToFileURL, fileURLToPath } = require('node:url');

const ROOT = path.join(__dirname, '..');
const storeFile = require('./store-file.js');

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

async function handleMessage(msg) {
  const type = msg?.type || '';

  try {
    switch (type) {
      case 'PING_OLLAMA': {
        const { llm } = await loadMods();
        return await llm.pingOllama();
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
