// WisdoMark · 本地 Ollama 调用封装
//
// 只做一件事：把 messages 发给本机 Ollama，拿回文本。
// 业务含义（怎么组装 prompt、怎么校验、失败了怎么重试）全在 digest.js。

export const OLLAMA_BASE = 'http://localhost:11434';

// 探活：GET /api/tags 返回本机已安装的模型列表。
// 失败最常见两种原因：Ollama 没启动 / 未放行 chrome-extension 来源。
export async function pingOllama() {
  const startedAt = Date.now();

  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`, { method: 'GET' });

    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}`, elapsedMs: Date.now() - startedAt };
    }

    const data = await resp.json();
    const models = (data.models || []).map((m) => ({
      name: m.name,
      parameterSize: m.details?.parameter_size || '',
      quantization: m.details?.quantization_level || '',
      contextLength: m.details?.context_length || null
    }));

    return { ok: true, models, elapsedMs: Date.now() - startedAt };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      hint: '请确认 Ollama 已启动；若仍失败，检查 OLLAMA_ORIGINS 是否放行 chrome-extension://',
      elapsedMs: Date.now() - startedAt
    };
  }
}

// 非流式对话调用。modelCfg 来自 shared/prompt.json 的 model 段。
// 返回 { content, evalCount, totalMs }
export async function chat(messages, modelCfg, { timeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let resp;

    try {
      resp = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelCfg.name,
          messages,
          ...modelCfg.request,
          options: modelCfg.options
        }),
        signal: controller.signal
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(`${Math.round(timeoutMs / 1000)} 秒内没有响应（模型可能过载，或上下文过长）`);
      }
      throw new Error(`连不上本地 Ollama：${err?.message || err}`);
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Ollama 返回 HTTP ${resp.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }

    const data = await resp.json();
    const content = data?.message?.content;

    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Ollama 返回了空内容');
    }

    return {
      content,
      evalCount: data.eval_count ?? null,
      totalMs: data.total_duration ? Math.round(data.total_duration / 1e6) : null
    };
  } finally {
    clearTimeout(timer);
  }
}
