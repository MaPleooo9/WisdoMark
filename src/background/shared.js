// WisdoMark · shared/ 的唯一入口
//
// 职责：把仓库根目录 shared/ 下的 JSON 读进来，并对外提供
//   - loadShared()      加载 prompt.json + output-schema.json
//   - renderTemplate()  极简模板渲染（{{key}} 占位）
//   - validateDigest()  按 output-schema.json 校验模型输出
//
// 为什么要有这一层：prompt / 调用参数 / 校验规则必须是「单一来源」。
// 阶段 3 的 Python 评测脚本读的是同一份 JSON，这样评测分数才代表插件的真实表现。

const SHARED_PATHS = {
  prompt: 'shared/prompt.json',
  schema: 'shared/output-schema.json'
};

// service worker 会被回收，缓存只是省一次 fetch，丢了也无所谓
let cache = null;

async function fetchJson(relativePath) {
  const url = chrome.runtime.getURL(relativePath);
  const resp = await fetch(url);

  if (!resp.ok) {
    throw new Error(`读取 ${relativePath} 失败：HTTP ${resp.status}`);
  }

  try {
    return await resp.json();
  } catch (err) {
    throw new Error(`${relativePath} 不是合法 JSON：${err.message}`);
  }
}

export async function loadShared() {
  if (cache) return cache;

  const [prompt, schema] = await Promise.all([
    fetchJson(SHARED_PATHS.prompt),
    fetchJson(SHARED_PATHS.schema)
  ]);

  cache = { prompt, schema };
  return cache;
}

// 单次替换，不做递归 —— 正文里带 {{xxx}} 也不会被二次解释
export function renderTemplate(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole
  );
}

// 组装首次请求的 messages
export function buildMessages(prompt, { title, url, text }) {
  return [
    {
      role: 'system',
      content: renderTemplate(prompt.system, { readerProfile: prompt.readerProfile })
    },
    {
      role: 'user',
      content: renderTemplate(prompt.userTemplate, {
        title: title || '（无标题）',
        url: url || '',
        text
      })
    }
  ];
}

// ---------------------------------------------------------------------------
// 结构校验
// ---------------------------------------------------------------------------

// 返回 { ok: true, value } 或 { ok: false, errors: string[] }
// value 只保留 schema 里声明过的字段，多余字段直接丢掉
export function validateDigest(raw, schema) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['顶层必须是一个 JSON 对象'] };
  }

  const variant = (schema.variants || []).find((v) => raw.ok === v.when.ok);

  if (!variant) {
    return {
      ok: false,
      errors: [`ok 字段缺失或不是布尔值（收到：${JSON.stringify(raw.ok)}）`]
    };
  }

  const errors = [];
  const value = { ok: variant.when.ok };

  for (const [name, rule] of Object.entries(variant.fields || {})) {
    const result = validateField(raw[name], rule, name);

    if (result.errors.length) errors.push(...result.errors);
    else value[name] = result.value;
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value,
    droppedFields: Object.keys(raw).filter((k) => !(k in value))
  };
}

function validateField(raw, rule, name) {
  const errors = [];

  if (rule.type === 'string') {
    if (typeof raw !== 'string') return { errors: [`${name} 必须是非空字符串，收到 ${describe(raw)}`] };

    const value = raw.trim();
    if (rule.minLen != null && value.length < rule.minLen) {
      errors.push(`${name} 过短：${value.length} 字，至少 ${rule.minLen} 字`);
    }
    if (rule.maxLen != null && value.length > rule.maxLen) {
      errors.push(`${name} 过长：${value.length} 字，最多 ${rule.maxLen} 字`);
    }

    return errors.length ? { errors } : { errors, value };
  }

  // 枚举：值必须来自 schema 里声明的白名单。
  // 分类字段用它 —— 模型自由发挥出「技术/AI」这类近义写法时，宁可重试也不要污染后续的归类与统计。
  if (rule.type === 'enum') {
    if (typeof raw !== 'string') {
      return { errors: [`${name} 必须是字符串，收到 ${describe(raw)}`] };
    }

    const value = raw.trim();
    const values = rule.values || [];

    if (!values.includes(value)) {
      return {
        errors: [`${name} 取值不在允许范围内：收到 ${JSON.stringify(value)}，允许 ${values.join(' / ')}`]
      };
    }

    return { errors, value };
  }

  if (rule.type === 'string[]') {
    if (!Array.isArray(raw)) return { errors: [`${name} 必须是数组，收到 ${describe(raw)}`] };

    if (rule.exactLen != null && raw.length !== rule.exactLen) {
      return { errors: [`${name} 必须恰好 ${rule.exactLen} 条，收到 ${raw.length} 条`] };
    }
    if (rule.minItems != null && raw.length < rule.minItems) {
      return { errors: [`${name} 至少 ${rule.minItems} 条，收到 ${raw.length} 条`] };
    }
    if (rule.maxItems != null && raw.length > rule.maxItems) {
      return { errors: [`${name} 最多 ${rule.maxItems} 条，收到 ${raw.length} 条`] };
    }
    // 兼容旧写法：数组上的 minLen 与 minItems 同义
    if (rule.minLen != null && raw.length < rule.minLen) {
      return { errors: [`${name} 至少 ${rule.minLen} 条，收到 ${raw.length} 条`] };
    }

    const badType = raw.findIndex((s) => typeof s !== 'string');
    if (badType !== -1) {
      return { errors: [`${name} 第 ${badType + 1} 条不是字符串`] };
    }

    const value = raw.map((s) => s.trim());

    if (rule.itemMinLen != null) {
      const short = value.filter((s) => s.length < rule.itemMinLen).length;
      if (short) errors.push(`${name} 中有 ${short} 条过短（少于 ${rule.itemMinLen} 字），疑似空话`);
    }
    if (rule.itemMaxLen != null) {
      const long = value.filter((s) => s.length > rule.itemMaxLen).length;
      if (long) errors.push(`${name} 中有 ${long} 条过长（超过 ${rule.itemMaxLen} 字）`);
    }
    if (rule.uniqueItems) {
      const dup = value.length - new Set(value).size;
      if (dup) errors.push(`${name} 中有 ${dup} 条重复`);
    }

    return errors.length ? { errors } : { errors, value };
  }

  return { errors: [`${name} 的规则类型 ${rule.type} 未实现`] };
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return `${typeof value}：${JSON.stringify(value)?.slice(0, 60)}`;
}
