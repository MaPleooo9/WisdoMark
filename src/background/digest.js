// WisdoMark · 消化流水线（阶段 1 的核心难点在这里）
//
// 流程：组装 prompt → 调 Ollama（JSON 模式）→ 解析 → 按 schema 校验 → 不合格就带着
// 错误原因重试，直到用满 maxAttempts。
//
// 两个刻意的设计：
//   1. 每次尝试都记进 attempts（原始输出、耗时、错误原因）。阶段 4 的 trace 和
//      阶段 3 的失败分类都靠它，现在不记后面补不回来。
//   2. 网络类错误（连不上 / 超时）不重试 —— 重试只是把 2 分钟的等待乘以 3，
//      而且大概率还是失败。只有「输出结构不对」才值得重试。

import { loadShared, buildMessages, renderTemplate, validateDigest } from './shared.js';
import { chat } from './llm.js';

export async function digestDocument({ title, url, text }) {
  const { prompt, schema } = await loadShared();

  const source = truncateText(text || '', prompt.limits.maxInputChars);
  const shape = detectShape({ title, text: source.text });
  const maxAttempts = prompt.limits.maxAttempts ?? 3;
  const timeoutMs = prompt.limits.requestTimeoutMs ?? 120000;

  const attempts = [];
  let messages = buildMessages(prompt, { title, url, text: source.text, shape });

  for (let index = 1; index <= maxAttempts; index += 1) {
    const startedAt = Date.now();
    let reply;

    try {
      reply = await chat(messages, prompt.model, { timeoutMs });
    } catch (err) {
      attempts.push({
        attempt: index,
        elapsedMs: Date.now() - startedAt,
        valid: false,
        errors: [err.message],
        raw: ''
      });

      return {
        ok: false,
        error: err.message,
        attempts,
        source: describeSource(title, url, source)
      };
    }

    const parsed = parseJsonLoose(reply.content);
    const outcome = parsed.ok
      ? validateDigest(parsed.value, schema)
      : { ok: false, errors: [`输出不是合法 JSON：${parsed.error}`] };

    attempts.push({
      attempt: index,
      elapsedMs: Date.now() - startedAt,
      valid: outcome.ok,
      errors: outcome.errors || [],
      raw: reply.content,
      evalCount: reply.evalCount
    });

    if (outcome.ok) {
      return {
        ok: true,
        value: outcome.value,
        attempts,
        meta: {
          model: prompt.model.name,
          promptVersion: prompt.version,
          schemaVersion: schema.version,
          truncated: source.truncated,
          originalChars: source.originalChars,
          usedChars: source.text.length,
          shape,
          droppedFields: outcome.droppedFields || []
        },
        source: describeSource(title, url, source)
      };
    }

    // 带上「模型上次说了什么 + 错在哪」再问一次，比原样重试有效得多
    messages = [
      ...messages,
      { role: 'assistant', content: reply.content },
      {
        role: 'user',
        content: renderTemplate(prompt.repairTemplate, {
          errors: outcome.errors.join('；'),
          raw: String(reply.content).slice(0, 600)
        })
      }
    ];
  }

  return {
    ok: false,
    error: `连续 ${maxAttempts} 次输出都不符合结构要求，已放弃`,
    attempts,
    source: describeSource(title, url, source)
  };
}

function describeSource(title, url, source) {
  return {
    title: title || '',
    url: url || '',
    originalChars: source.originalChars,
    usedChars: source.text.length,
    truncated: source.truncated
  };
}

// 长文截断：按字符数上限切，尽量切在句末，避免半句话喂给模型
export function truncateText(text, maxChars) {
  const originalChars = text.length;

  if (originalChars <= maxChars) {
    return { text, truncated: false, originalChars };
  }

  let cut = text.slice(0, maxChars);
  const boundary = Math.max(
    cut.lastIndexOf('。'),
    cut.lastIndexOf('！'),
    cut.lastIndexOf('？'),
    cut.lastIndexOf('\n')
  );

  // 句末离切口太远就别将就了，硬切即可
  if (boundary > maxChars - 300) cut = cut.slice(0, boundary + 1);

  return { text: cut, truncated: true, originalChars };
}

// 解析模型输出。开了 format:json 之后基本就是纯 JSON，但 8B 偶尔会裹一层
// markdown 代码块或前后带一句废话，这里兜住这两种情况。
export function parseJsonLoose(content) {
  const raw = String(content ?? '').trim();

  if (!raw) return { ok: false, error: '内容为空' };

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    // 继续往下兜
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return { ok: true, value: JSON.parse(fenced[1].trim()) };
    } catch {
      // 继续往下兜
    }
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');

  if (start !== -1 && end > start) {
    try {
      return { ok: true, value: JSON.parse(raw.slice(start, end + 1)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return { ok: false, error: '找不到 JSON 对象' };
}

// ---------------------------------------------------------------------------
// 输入形态判定：聚合类 vs 单一主题
// ---------------------------------------------------------------------------
//
// 为什么这个判断放在代码里、而不是交给模型（2026-09-15 实测）：
//   同一篇阮一峰周刊、同一个 prompt，模型的输出在 **16 / 42 / 45 / 46 条**之间跳。
//   它不是不会归纳 —— 在 system 里明确告诉它「这份正文是聚合类」之后，输出立刻
//   稳定成 **10 条、耗时 27.8s**（不给信号时要 41~66s，还常因超上限白跑一轮重试）。
//
//   根因是**周刊的条目在形式上就是并列清单**，和「一篇文章列了 11 个要点」长得
//   一模一样，8B 模型区分不了「该跟随条目数」还是「该按主题归纳」。既然它判不出来，
//   就别让它判 —— 用可机械识别的特征替它决定，再把结论明确告诉它。
//
// 判据要「准」而不是「宽」—— 这里的方向和登录墙检测相反：
//   漏判 → 回到罗列，会因超上限白跑一轮重试，**但信息不丢**；
//   误判 → 单一主题被强行归并，**会真的丢信息**（正是用户抱怨过的那个问题）。
// 所以只收「一说出来就说明是刊物」的词。
// 实测踩过：加过「一览」之后，「React 19 的新特性一览」这种正常文章标题被误判成聚合类。
const AGGREGATE_PATTERNS = [
  /周刊|周报|双周报|日报|月报|半月刊|月刊|季刊|年刊|特刊|专刊|早报|晚报/,
  /第\s*\d+\s*期/,
  /合集|盘点|汇总|资讯集锦|周更|要闻/,
  /\bweekly\b|\bnewsletter\b|\broundup\b/i
];

export function detectShape({ title = '', text = '' } = {}) {
  const hit = (value) => AGGREGATE_PATTERNS.some((re) => re.test(value));

  // 标题最权威 —— 刊名几乎一定写在标题里
  if (hit(String(title || ''))) return 'aggregate';

  // 标题看不出来时（有些站点的标题被取成了站名）再看正文开头。
  // 只取开头一小段：正文中段提到「周刊」多半只是引用，不代表这篇是聚合类。
  if (hit(String(text || '').slice(0, 200))) return 'aggregate';

  return 'single';
}
