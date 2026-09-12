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
  const maxAttempts = prompt.limits.maxAttempts ?? 3;
  const timeoutMs = prompt.limits.requestTimeoutMs ?? 120000;

  const attempts = [];
  let messages = buildMessages(prompt, { title, url, text: source.text });

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
