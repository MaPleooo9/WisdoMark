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
export function buildMessages(prompt, { title, url, text, shape }) {
  return [
    {
      role: 'system',
      content: renderTemplate(prompt.system, {
        readerProfile: prompt.readerProfile,
        shapeRule: shapeRuleFor(shape)
      })
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

// 把抓取侧判定的输入形态，翻译成一句直接告诉模型的话。
//
// 措辞必须明确到「这是什么类型」，不能只说「按主题归纳」——
// 实测（2026-09-15）：在 prompt 里写「聚合类要按主题归纳」这种描述性要求，
// 模型时听时不听（同一篇周刊输出在 16~46 条之间跳）；改成明确告知类型后
// 立刻稳定。含糊的指令对 8B 模型基本等于没写。
// 导出是为了让仓库外的验证脚本复用同一份文案，而不是抄一份副本
// （措辞是实测调出来的，抄出去就会和生产漂移）
export function shapeRuleFor(shape) {
  if (shape === 'aggregate') {
    return (
      '【输入类型】这份正文是「聚合类」：一份文档里收录了多条彼此无关的内容' +
      '（周刊 / 日报 / 合集这类）。按主题分组归纳，points 的条数等于主题数，不要逐条罗列。'
    );
  }

  if (shape === 'single') {
    return '【输入类型】这份正文整篇在讲一件事（单一主题），不是聚合类。';
  }

  // 没拿到形态信息时不说话，按 prompt 里的通则走
  return '';
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

// 批量排序结果的校验。结构和 variants 是两套，规则在 schema.batch 里 ——
// 判「单篇正文能不能撑起一张卡片」和判「一批卡片的优先级」是两件事，不硬塞进同一个 variants。
export function validateBatch(raw, schema) {
  const section = schema?.batch;

  if (!section) return { ok: false, errors: ['schema 里没有 batch 段'] };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['顶层必须是一个 JSON 对象'] };
  }

  const errors = [];
  const value = {};

  for (const [name, rule] of Object.entries(section.fields || {})) {
    const result = validateField(raw[name], rule, name);

    if (result.errors.length) errors.push(...result.errors);
    else value[name] = result.value;
  }

  return errors.length ? { ok: false, errors } : { ok: true, value };
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

  if (rule.type === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { errors: [`${name} 必须是数字，收到 ${describe(raw)}`] };
    }
    return { errors, value: raw };
  }

  // 批量排序的 order 用它：一个序号数组
  if (rule.type === 'number[]') {
    if (!Array.isArray(raw)) return { errors: [`${name} 必须是数组，收到 ${describe(raw)}`] };

    if (rule.minItems != null && raw.length < rule.minItems) {
      return { errors: [`${name} 至少 ${rule.minItems} 项，收到 ${raw.length} 项`] };
    }
    if (rule.maxItems != null && raw.length > rule.maxItems) {
      return { errors: [`${name} 最多 ${rule.maxItems} 项，收到 ${raw.length} 项`] };
    }

    const bad = raw.findIndex((n) => typeof n !== 'number' || !Number.isFinite(n));
    if (bad !== -1) return { errors: [`${name} 第 ${bad + 1} 项不是数字`] };

    return { errors, value: raw };
  }

  // 对象数组：批量排序的 mustRead 用它（[{index, reason}, ...]）。
  // 嵌套字段直接递归复用 validateField —— 只支持一层，够用，
  // 也不必为此长出一个通用的 JSON Schema 实现。
  if (rule.type === 'object[]') {
    if (!Array.isArray(raw)) return { errors: [`${name} 必须是数组，收到 ${describe(raw)}`] };

    if (rule.exactLen != null && raw.length !== rule.exactLen) {
      return { errors: [`${name} 必须恰好 ${rule.exactLen} 项，收到 ${raw.length} 项`] };
    }
    if (rule.minItems != null && raw.length < rule.minItems) {
      return { errors: [`${name} 至少 ${rule.minItems} 项，收到 ${raw.length} 项`] };
    }
    if (rule.maxItems != null && raw.length > rule.maxItems) {
      return { errors: [`${name} 最多 ${rule.maxItems} 项，收到 ${raw.length} 项`] };
    }

    const value = [];
    for (const [i, item] of raw.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { errors: [`${name} 第 ${i + 1} 项必须是对象`] };
      }

      const built = {};
      for (const [field, fieldRule] of Object.entries(rule.fields || {})) {
        const result = validateField(item[field], fieldRule, `${name}[${i + 1}].${field}`);
        if (result.errors.length) return { errors: result.errors };
        built[field] = result.value;
      }
      value.push(built);
    }

    return { errors, value };
  }

  return { errors: [`${name} 的规则类型 ${rule.type} 未实现`] };
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return `${typeof value}：${JSON.stringify(value)?.slice(0, 60)}`;
}
