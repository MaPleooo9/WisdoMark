// eval/shapes.mjs · 打印每条用例的「输入形态」（single / aggregate）与「模型实际看到的字数」
//
// 为什么要单独一个脚本：形态判断（detectShape）与长文截断（truncateText）都是**生产代码**
// （`src/background/digest.js`），而质量评测是 Python 写的。
// 与其在 Python 里照抄一份正则 / 截断规则（那就成了「两个来源」，迟早漂移），
// 不如直接 import 生产那两个函数，把结果打印成 JSON 交给 Python。
//
// **为什么还要报 usedChars**：`quality.py` 拿**原文**当标尺算召回率。但超长正文会被
// `truncateText` 截断后才喂给模型 —— 若标尺仍用磁盘上的完整原文，截掉的那截尾巴里
// 的数字会被记成「模型漏了」，而模型根本没见过它们。用 `usedChars` 把标尺对齐到
// 模型的真实输入，指标才量的是「给它的东西它带出来了没有」。
//
// 用法：node eval/shapes.mjs
//   → stdout: {"id": {"shape": "single" | "aggregate", "usedChars": N, "truncated": bool}, ...}

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATASET = path.join(ROOT, 'eval/dataset');

// digest.js 是给浏览器写的，模块顶层可能碰到 chrome.*，补个最小替身
globalThis.chrome = { runtime: { getURL: (p) => p } };

const { detectShape, truncateText } = await import(
  `file:///${path.join(ROOT, 'src/background/digest.js').replace(/\\/g, '/')}`
);

const prompt = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/prompt.json'), 'utf8'));
const maxChars = prompt.limits.maxInputChars;

const dataset = JSON.parse(fs.readFileSync(path.join(DATASET, 'cases.json'), 'utf8'));
const out = {};

for (const c of dataset.cases) {
  const textPath = path.join(DATASET, c.text);
  const text = fs.existsSync(textPath) ? fs.readFileSync(textPath, 'utf8') : '';
  // 与 digest.js 同一条链路：先按 maxInputChars 截断，再判形态（生产也是这么调的）
  const t = truncateText(text, maxChars);
  out[c.id] = {
    shape: detectShape({ title: c.title, text: t.text }),
    usedChars: t.text.length,
    truncated: t.truncated,
  };
}

process.stdout.write(JSON.stringify(out));
