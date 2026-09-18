// WisdoMark · 批量消化编排（阶段 2.4）
//
// 为什么编排放在**侧栏**、而不是 service worker 里：
//   MV3 的 service worker 空闲几十秒就会被浏览器回收，而一批 10 条要跑好几分钟。
//   把循环放在 SW 里，跑到第三条就会被掐断，用户还完全不知道为什么停了。
//   侧栏页面只要开着就不会被回收 —— 让它当调度者，SW 只负责「消化一条」这一件事。
//
// 中断怎么续：
//   每条跑完都已经落进 IndexedDB（digestAndStore 里做的）。所以关掉侧栏再打开、
//   重跑一遍，已消化的会被直接复用 —— 等于从断点接着跑，不重复消耗。
//
// 复用窗口：归档里这条是最近 30 天内消化的就不再重跑模型。
//   批量要的是「横向排序」，不需要每次重新读一遍原文。

export const BATCH_MIN = 5;
export const BATCH_MAX = 20;
export const BATCH_DEFAULT = 10;

const REUSE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function isFresh(record, now = Date.now()) {
  return !!record?.digestedAt && now - record.digestedAt < REUSE_WINDOW_MS;
}

// 跑一批。items 是 [{ url, title }]（来自书签）。
// 返回 { ok, results, ranked, stopped?, error? }。
//
// send            —— 侧栏与后台通信的函数（注入进来，便于单独验证编排逻辑）
// digestWithOcr   —— 单条的 OCR 分叉处理（图文帖要先在侧栏做 OCR）。不传则遇到图文帖按失败处理
// onProgress      —— 每步回调，UI 靠它更新
// shouldStop      —— 返回 true 时在当前这一条跑完后停下
// force           —— 跳过归档复用，强制重跑。重新分类用它（复用旧结果等于没重跑）
// skipRanking     —— 跑完不排序。重新分类要的是「校正分类」，不是「排出优先级」
export async function runBatchDigest({
  items = [],
  send,
  digestWithOcr,
  onProgress,
  shouldStop,
  force = false,
  skipRanking = false
} = {}) {
  const total = items.length;
  const results = [];
  const skipped = [];

  for (const [index, item] of items.entries()) {
    if (shouldStop?.()) return { ok: false, stopped: true, results, skipped };

    await onProgress?.({ phase: 'checking', index, total, item });

    // 先问归档库。查不到 / 过期都不算错，继续走正常消化。
    // force 时整段跳过 —— 重新分类的意义就是覆盖旧结果。
    let cached = null;
    if (!force) {
      try {
        const resp = await send('GET_ARCHIVE_BY_URL', { url: item.url });
        if (resp?.ok && isFresh(resp.record)) cached = resp.record;
      } catch {
        /* 查询失败不影响主流程 */
      }
    }

    if (cached) {
      results.push({
        url: item.url,
        title: cached.title || item.title,
        category: cached.category,
        summary: cached.summary,
        points: cached.points || [],
        fromArchive: true
      });
      await onProgress?.({ phase: 'reused', index, total, item, record: cached });
      continue;
    }

    await onProgress?.({ phase: 'digesting', index, total, item });

    let resp;
    try {
      // quiet：批量不覆盖「最近一次结果」。否则跑完一批、重开侧栏，
      // 只看到其中最后一条的单条结果，会让人以为整批只消化了一条。
      resp = await send('DIGEST_URL', { url: item.url, quiet: true });
    } catch (err) {
      resp = { ok: false, error: err?.message || String(err) };
    }

    // 图文帖：后台会把图片清单交回来，让侧栏先做本地 OCR，再送回后台消化。
    // 批量里必须同样处理，否则图文帖会整批变成失败。
    if (resp?.needOcr && typeof digestWithOcr === 'function') {
      try {
        resp = await digestWithOcr(resp.ocr, { quiet: true });
      } catch (err) {
        resp = { ok: false, error: `OCR 失败：${err?.message || err}` };
      }
    }

    if (resp?.ok === true && resp.value?.ok === true) {
      results.push({
        url: item.url,
        title: resp.source?.title || item.title,
        category: resp.value.category,
        summary: resp.value.summary,
        points: resp.value.points || [],
        fromArchive: false
      });
      await onProgress?.({ phase: 'done', index, total, item, resp });
    } else {
      // 单条失败不打断整批 —— 10 条里坏 1 条，剩下 9 条照样该排序。
      skipped.push({
        url: item.url,
        title: item.title,
        reason: resp?.error || resp?.value?.reason || '没能消化'
      });
      await onProgress?.({ phase: 'failed', index, total, item, resp });
    }
  }

  if (!results.length) {
    return { ok: false, error: '这一批没有一条消化成功', results, skipped };
  }

  // 重新分类要的是「分类被校正」，不是「排出优先级」—— 排序那一步纯属浪费
  if (skipRanking) return { ok: true, results, skipped, ranked: null };

  await onProgress?.({ phase: 'ranking', total, ok: results.length, skipped: skipped.length });

  // 横向排序：只喂「标题 + 分类 + 摘要」，不喂正文 ——
  // 10 条正文会撑爆上下文，而排序本来也不需要对全文的判断。
  let ranked;
  try {
    ranked = await send('RANK_BATCH', {
      items: results.map((r) => ({ title: r.title, category: r.category, summary: r.summary }))
    });
  } catch (err) {
    ranked = { ok: false, error: err?.message || String(err) };
  }

  return { ok: true, results, skipped, ranked };
}
