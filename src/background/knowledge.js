// WisdoMark · 知识库：搜索即建卡（0.21.0）
// ─────────────────────────────────────────────────────────────
// 为什么不是「预提取全库概念」：
//   实测 qwen3:8b 提概念 26 个里约一半是文件名 / 事件 / 操作步骤，
//   而 quote 逐字只有 17/26。它分不清「术语」和「文中出现的专有名词」。
//
// 所以反过来：不预建库，只在用户**真的搜一个词**时，才去归档全文里找解释它的段落。
//   好处：不会产生废卡；每张卡天然带来源；成本只花在搜过的那次。
//
// 三层设计（对应 2026-10-22 的实测）：
//   1. 检索：关键词 + 别名，遍历归档全文切段 —— 4/4 词命中
//   2. 排序：按「像不像定义」打分，**不做硬过滤** —— 硬过滤会漏掉
//      「扩展成…的 X」这类真定义；最终由用户点选
//   3. 改写：模型只改一段；改完做锚点校验（改写出原文没有的数字 / 专名就降级为原句）
// ─────────────────────────────────────────────────────────────

import { readAllDigests } from './store.js';
import { chat } from './llm.js';

const PARA_MIN_CHARS = 20; // 太短的碎片不参与（标签、按钮文字）
const MAX_PER_DOC = 3;
const MAX_TOTAL = 10;

// 段落切分。正文快照里一行往往就是一段，所以按换行切；
// 连续空行产生的空串过滤掉，太短的片段也过滤掉。
export function splitParagraphs(text) {
  return String(text || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= PARA_MIN_CHARS);
}

// 「像不像定义」的分数。只用于排序，不用于淘汰 —— 实测硬过滤会误杀：
//   「…扩展成可以搜索、分类、长期整理的剪贴板管理器」不含「X 是」，但它是真定义。
export function scoreParagraph(para, terms) {
  const hit = terms.find((t) => para.includes(t));
  if (!hit) return -1;

  let score = 0;

  // X 在段首 40 字内：「X 是一种…」这类典型定义
  if (para.indexOf(hit) <= 40) score += 5;

  // 段内出现「X 是 / X 指 / X 称为 / X 叫做 / X 可以看作」
  const defRe = new RegExp(
    `${escapeRe(hit)}\\s*(是|指|称为|叫做|可以看作|指的是|是一种|即|就是)`
  );
  if (defRe.test(para)) score += 10;

  // 长度像定义段（40~300 字）：太短像碎片，太长像整节论述
  if (para.length >= 40 && para.length <= 300) score += 3;

  // 同一段里出现两次以上，说明这段确实在围绕它讲
  if (para.split(hit).length - 1 >= 2) score += 2;

  return score;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 全库检索：返回排好序的候选段。
// 遍历 readAllDigests 而不是建倒排索引 —— 单机几百条 × 几千字，
// 一次全遍历是几十毫秒，先不引入索引的复杂度（真慢了再说）。
export async function lookup(term, { aliases = [], limit = MAX_TOTAL } = {}) {
  const value = String(term || '').trim();
  if (!value) return { ok: false, error: '请输入要查的词' };

  const terms = [...new Set([value, ...aliases.map((a) => String(a || '').trim())].filter(Boolean))];
  const records = await readAllDigests();

  const candidates = [];

  for (const rec of records) {
    // 老记录没有全文 —— 跳过，不假装有（0.20.0 之前归档的记录）
    if (!rec.text) continue;

    let perDoc = 0;
    splitParagraphs(rec.text).forEach((para, i) => {
      if (perDoc >= MAX_PER_DOC) return;
      const score = scoreParagraph(para, terms);
      if (score <= 0) return;

      candidates.push({
        articleKey: rec.key,
        title: rec.title || '(无标题)',
        url: rec.url || '',
        paragraphIndex: i + 1,
        text: para,
        score,
      });
      perDoc += 1;
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  return {
    ok: true,
    term: value,
    searchedDocs: records.length,
    docsWithText: records.filter((r) => r.text).length,
    candidates: candidates.slice(0, limit),
    total: candidates.length,
  };
}

// 锚点校验：改写里出现原文没有的阿拉伯数字 / 英文专名 → 判定为「加了原文没有的信息」。
//
// 只查这两类，不查中文数字（「十五」↔「15」的转换会误报，lang 层面没有可靠写法）。
// 误报代价：把一条本来忠实的改写降级成原句 —— 可接受，用户只是少读一层转述。
export function extractAnchors(text) {
  const s = String(text || '');
  const nums = s.match(/\d+(?:\.\d+)?%?/g) || [];
  const latin = (s.match(/[A-Za-z][A-Za-z0-9_.-]{1,}/g) || []).filter((w) => w.length >= 2);
  return { nums, latin };
}

export function anchorCheck(rewrite, quote) {
  const { nums, latin } = extractAnchors(rewrite);
  const q = String(quote || '').toLowerCase();

  const missNum = nums.filter((n) => !String(quote || '').includes(n));
  const missLat = latin.filter((w) => !q.includes(w.toLowerCase()));

  return { ok: missNum.length === 0 && missLat.length === 0, missNum, missLat };
}

const SYSTEM = `你把一段原文改写成一句「概念卡」上的解释。

硬要求：
1. 只能使用原文里出现的信息，**不能补充原文没有的事实、数字或专有名词**。
2. 脱离上下文也能看懂 —— 原文里的「它 / 这个」要换成具体的名字。
3. 一句话，不超过 120 字。原文是中文就写中文，专有名词保留英文原样。

只输出 JSON，不要其他文字：
{"rewrite":"..."}`;

function parseJson(raw) {
  let s = (raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

// 由「用户选中的候选段」生成一张卡（不落库 —— 由调用方确认后 saveConcept）。
export async function buildCard({ term, aliases = [], candidate, modelCfg, timeoutMs = 60000 }) {
  const value = String(term || '').trim();
  const quote = String(candidate?.text || '').trim();
  if (!value || !quote) return { ok: false, error: '缺少概念名或原文段落' };

  let rewrite = '';
  let modelError = null;

  try {
    const { content, totalMs } = await chat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `概念：${value}\n\n原文：\n${quote}` },
      ],
      modelCfg,
      { timeoutMs }
    );

    const parsed = parseJson(content);
    rewrite = String(parsed.rewrite || '').trim();
    if (!rewrite) modelError = '模型没有给出改写';
  } catch (err) {
    modelError = err?.message || String(err);
  }

  // 没有改写也要能建卡 —— 原文本身就是最有价值的解释，不让一次模型失败挡住用户
  const anchor = rewrite ? anchorCheck(rewrite, quote) : { ok: false, missNum: [], missLat: [] };

  return {
    ok: true,
    modelError,
    term: value,
    aliases,
    // 改写没通过锚点校验 → 降级：只显示原句，不用改写
    rewrite: anchor.ok ? rewrite : '',
    rewriteRejected: rewrite ? !anchor.ok : false,
    missingAnchors: anchor.ok ? [] : [...anchor.missNum, ...anchor.missLat],
    quote,
    source: {
      articleKey: candidate.articleKey || '',
      title: candidate.title || '',
      url: candidate.url || '',
      paragraphIndex: candidate.paragraphIndex || 0,
    },
  };
}
