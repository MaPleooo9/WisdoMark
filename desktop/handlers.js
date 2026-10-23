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
    const [knowledge, digest, llm, shared, trace] = await Promise.all([
      import(pathToFileURL(path.join(ROOT, 'src/background/knowledge.js')).href),
      import(pathToFileURL(path.join(ROOT, 'src/background/digest.js')).href),
      import(pathToFileURL(path.join(ROOT, 'src/background/llm.js')).href),
      import(pathToFileURL(path.join(ROOT, 'src/background/shared.js')).href),
      import(pathToFileURL(path.join(ROOT, 'src/background/trace.js')).href),
    ]);
    mods = { knowledge, digest, llm, shared, trace };
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

// 分类分布由代码统计，不经过模型（它在计数上不可靠，算错了没人看得出来）。
// 与 service-worker.js 的 countByCategory 同源逻辑：那边没导出、且 import 了 chrome.*，
// 桌面端引不了；3 行纯函数，抄一份可以接受。
function countByCategory(records) {
  const byCategory = {};
  for (const r of records) {
    const key = r.category || '未分类';
    byCategory[key] = (byCategory[key] || 0) + 1;
  }
  return byCategory;
}

// 画像与清单取同一批素材（最近 N 条），否则会出现
// 「画像说他偏实操、清单却让他先读理论」这种自相矛盾。
function recentRecords(all, limit) {
  return all
    .slice()
    .sort((a, b) => b.digestedAt - a.digestedAt)
    .slice(0, limit);
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

        const { digest, trace: traceMod } = await loadMods();
        const digestStart = Date.now();
        const result = await digest.digestDocument({
          title: captured.title,
          url: captured.url,
          text: captured.text,
        });
        const ms = Date.now() - digestStart;

        if (!result.ok) {
          // 只有「压根没拿到结果」（网络错 / 结构反复不过）才记失败日志。
          // 模型判 ok:false 是护栏正常工作，不记 —— 混进去会把失败率淹掉。
          await storeFile.pushFailure({
            at: Date.now(),
            url: captured.url,
            title: captured.title,
            origin: 'desktop',
            error: result.error,
            networkError: !!result.networkError,
            ms,
            calls: Array.isArray(result.attempts) ? result.attempts.length : 0,
            extract: {
              charCount: captured.charCount,
              lowContent: captured.charCount < 400,
              loginWall: null,
              consentWall: null,
              foregroundFallback: false,
              minChars: 400,
            },
            attempts: traceMod.trimAttempts(result.attempts, { keepRaw: true }),
          });

          return {
            ok: false,
            error: result.error || '模型判定这一页没有可消化的正文',
            source: { title: captured.title, url: captured.url, charCount: captured.charCount },
            extract: { lowContent: false },
            attempts: result.attempts,
          };
        }

        // 成功的 trace 挂在归档记录上（与扩展同口径）：
        // 「这一条是怎么来的」—— 调了几次、耗时、token。
        const trace = traceMod.buildTrace({
          attempts: result.attempts,
          ms,
          networkError: !!result.networkError,
        });

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
          trace,
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
      case 'GET_FAILURES': {
        const failures = await storeFile.readFailures();
        return { ok: true, failures, total: failures.length };
      }
      case 'CLEAR_FAILURES':
        return await storeFile.clearFailures();
      // 画像 / 行动清单：产品的核心卖点（「对内容的理解」→「对下一步的建议」）。
      // 逻辑与 service-worker 的 buildProfileNow / buildActionsNow 一致，
      // 只是把存储从 chrome.storage 换成文件。
      case 'BUILD_PROFILE': {
        const { digest } = await loadMods();
        const records = recentRecords(await storeFile.readAllDigests(), 40);

        if (records.length < 5) {
          return {
            ok: false,
            error:
              `归档里只有 ${records.length} 条，太少 —— 这样推出来的方向多半不准，所以先不给结论。` +
              '再消化几篇，攒够 5 条以上再来。',
            sampleCount: records.length,
          };
        }

        const result = await digest.buildProfile({
          items: records.map((r) => ({ title: r.title, category: r.category, summary: r.summary })),
        });

        if (!result.ok) return { ok: false, error: result.error, attempts: result.attempts };

        const payload = {
          ok: true,
          themes: result.themes,
          level: result.level,
          stageReason: result.stageReason,
          lean: result.lean,
          summary: result.summary,
          sampleCount: records.length,
          byCategory: countByCategory(records),
          builtAt: Date.now(),
          meta: result.meta,
        };

        await storeFile.saveMeta({ profile: payload });
        return payload;
      }

      case 'GET_PROFILE': {
        const { profile } = await storeFile.readMeta();
        return { ok: true, profile: profile || null };
      }

      case 'BUILD_ACTIONS': {
        const { digest } = await loadMods();
        const records = recentRecords(await storeFile.readAllDigests(), 40);

        if (records.length < 5) {
          return {
            ok: false,
            error:
              `归档里只有 ${records.length} 条，太少 —— 基于三五条内容提的「下一步」多半是套话。` +
              '再消化几篇，攒够 5 条以上再来。',
            sampleCount: records.length,
          };
        }

        const items = records.map((r) => ({
          title: r.title,
          category: r.category,
          summary: r.summary,
          url: r.url,
        }));

        // 清单必须基于画像。没算过就顺手算一份 —— 用户点的是「生成清单」，
        // 不该先被要求去点另一个按钮。
        const { profile: cached } = await storeFile.readMeta();
        let profile = cached;
        let profileStep = 'reused';

        if (!profile?.themes?.length) {
          const built = await digest.buildProfile({ items });
          if (!built.ok) {
            return {
              ok: false,
              error: `生成清单前先要算出画像，那一步失败了：${built.error}`,
              stage: 'profile',
              attempts: built.attempts,
            };
          }

          profileStep = 'built';
          profile = {
            ok: true,
            themes: built.themes,
            level: built.level,
            stageReason: built.stageReason,
            lean: built.lean,
            summary: built.summary,
            sampleCount: items.length,
            byCategory: countByCategory(records),
            builtAt: Date.now(),
            meta: built.meta,
          };

          await storeFile.saveMeta({ profile });
        }

        const result = await digest.buildActionPlan({ items, profile });
        if (!result.ok) {
          return { ok: false, error: result.error, stage: 'actions', attempts: result.attempts };
        }

        const payload = {
          ok: true,
          gap: result.gap,
          // refs 是条目序号，投影成界面能直接用的形状（侧栏不必再查归档）
          actions: result.actions.map((a) => ({
            ...a,
            refs: (a.refs || []).map((n) => ({
              index: n,
              title: items[n - 1]?.title || '',
              url: items[n - 1]?.url || '',
            })),
          })),
          sampleCount: items.length,
          profileStep,
          builtAt: Date.now(),
          meta: result.meta,
        };

        await storeFile.saveMeta({ actionPlan: payload });
        return payload;
      }

      case 'GET_ACTIONS': {
        const { actionPlan } = await storeFile.readMeta();
        return { ok: true, actionPlan: actionPlan || null };
      }
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
