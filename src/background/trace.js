// WisdoMark · 诊断日志（阶段 4 的可观测性）
//
// 要回答的问题只有一个：**这一次消化到底经历了什么** ——
// 花了多久、调了几次模型、耗了多少 token、失败的话卡在哪一步。
//
// ---------------------------------------------------------------------------
// ⚠️ 两类数据分开存，这是本模块最重要的设计
//
//   成功的消化 → trace 挂在**归档记录**上（跟着那条记录走，见 store.js 的 saveDigest）
//   失败的消化 → 进**本模块的独立日志**（chrome.storage.local 的环形缓冲）
//
// 为什么不把失败也写进归档库：归档库是**用户资产**。
// 它会被「画像推断」「批量排序」「归档搜索」读取 ——
// 把失败记录混进去，画像会把它当成一篇内容、搜索会搜出没有摘要的空条目。
// **诊断数据污染业务数据，属于那种不报错、但结果悄悄变错的问题**，
// 前面已经在「数量交给代码统计」上吃过一次同类的亏。
// ---------------------------------------------------------------------------
//
// 另一个取舍：归档记录里的 trace **不存模型原始输出**。
// digest.js 的 attempts 里带着 `raw`（模型完整回复，可能几 KB）——
// 那是给调试用的，存进归档库会让每条记录膨胀好几倍。
// 所以这里做一次「瘦身」：**只有没通过的那一轮**留 raw，且截断 600 字
// （诊断「模型到底输出了什么鬼」需要它；通过的那一轮留着没有价值）。

export const FAILURES_KEY = 'wisdomarkFailures';

// 30 条够回看最近几天的状况，也不会让 storage.local 无限长
export const FAILURE_LIMIT = 30;

const RAW_PREVIEW = 600;
const ERROR_MAX = 200;
const ERRORS_MAX = 5;

function clip(value, n) {
  const s = String(value ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// 把 digest.js 的 attempts 瘦身成可落库的形态。
// keepRaw：调用方决定要不要留模型原始输出（失败场景留，成功场景不留）
export function trimAttempts(attempts, { keepRaw = false } = {}) {
  if (!Array.isArray(attempts)) return [];

  return attempts.map((a) => ({
    attempt: a.attempt ?? null,
    ms: a.elapsedMs ?? null,
    valid: !!a.valid,
    errors: (a.errors || []).slice(0, ERRORS_MAX).map((e) => clip(e, ERROR_MAX)),
    evalCount: a.evalCount ?? null,
    // 输入 token 与输出 token 要分开 —— 长文慢是因为输入大，不是因为模型啰嗦
    promptEvalCount: a.promptEvalCount ?? null,
    modelMs: a.modelMs ?? null,
    // 只有没过的那一轮才有诊断价值
    rawPreview: !a.valid && keepRaw ? clip(a.raw, RAW_PREVIEW) : undefined
  }));
}

// 组装挂在归档记录上的 trace
export function buildTrace({ attempts, ms, networkError = false, at = Date.now() } = {}) {
  const steps = trimAttempts(attempts, { keepRaw: false });

  return {
    ms: ms ?? null,
    // 「调了几次模型」比「重试几次」直观：1 次就是一次过
    calls: steps.length,
    networkError: !!networkError,
    // token 用真实值（Ollama 自报），不是估的；全为 null 说明这次没走到模型
    promptEvalCount: sum(steps.map((s) => s.promptEvalCount)),
    evalCount: sum(steps.map((s) => s.evalCount)),
    modelMs: sum(steps.map((s) => s.modelMs)),
    steps,
    at
  };
}

// 累加 token。全 null 时返回 null 而不是 0 —— 「没数据」和「确实是 0」要能分开
function sum(values) {
  const nums = values.filter((v) => typeof v === 'number');
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

// 读失败日志。storage.local 读失败不该让调用方崩 —— 诊断数据没那么重要
export async function listFailures() {
  try {
    const got = await chrome.storage.local.get(FAILURES_KEY);
    const list = got?.[FAILURES_KEY];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// 记一条失败。新的在前（列表按时间倒序，UI 直接渲染）
//
// 并发：这里是「读—改—写」两步。service worker 的消息路由对消化是串行的，
// 批量消化也是一条条跑，所以实际不会撞到同一个键上；真撞上最坏也只是少记一条日志。
export async function recordFailure(entry = {}) {
  const record = {
    at: entry.at || Date.now(),
    url: entry.url || '',
    title: entry.title || '(无标题)',
    // 这一条是从哪来的（粘贴 / 收藏夹 / 批量 / 当前页）——
    // 排查「只有批量失败」这类问题时，这是第一个要看的字段
    origin: entry.origin || '',
    error: clip(entry.error, ERROR_MAX),
    networkError: !!entry.networkError,
    ms: entry.ms ?? null,
    calls: Array.isArray(entry.attempts) ? entry.attempts.length : 0,
    // 抓取侧诊断：失败到底是「没抓到正文」还是「模型不行」，全靠这几个字段区分。
    // 没有它，用户看到一句「Ollama 返回 HTTP 403」根本不知道该去改哪里。
    extract: {
      charCount: entry.extract?.charCount ?? null,
      lowContent: !!entry.extract?.lowContent,
      loginWall: entry.extract?.loginWall || null,
      consentWall: entry.extract?.consentWall || null,
      foregroundFallback: !!entry.extract?.foregroundFallback,
      minChars: entry.extract?.minChars ?? null
    },
    attempts: trimAttempts(entry.attempts, { keepRaw: true })
  };

  try {
    const list = await listFailures();
    await chrome.storage.local.set({
      [FAILURES_KEY]: [record, ...list].slice(0, FAILURE_LIMIT)
    });
    return { ok: true, count: Math.min(list.length + 1, FAILURE_LIMIT) };
  } catch (err) {
    // 记日志失败绝不能影响主链路 —— 消化结果已经在用户手上了
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function clearFailures() {
  await chrome.storage.local.remove(FAILURES_KEY);
  return { ok: true };
}
