// eval/shapes.mjs · 打印每条用例的「输入形态」（single / aggregate）
//
// 为什么要单独一个脚本：形态判断（detectShape）是**生产代码**里的逻辑
// （`src/background/digest.js`），而质量评测是 Python 写的。
// 与其在 Python 里照抄一份正则（那就成了「两个来源」，迟早漂移），
// 不如直接 import 生产那个函数，把结果打印成 JSON 交给 Python。
//
// 用法：node eval/shapes.mjs        → stdout 输出 {"id": "single" | "aggregate", ...}

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATASET = path.join(ROOT, 'eval/dataset');

// digest.js 是给浏览器写的，模块顶层可能碰到 chrome.*，补个最小替身
globalThis.chrome = { runtime: { getURL: (p) => p } };

const { detectShape } = await import(
  `file:///${path.join(ROOT, 'src/background/digest.js').replace(/\\/g, '/')}`
);

const dataset = JSON.parse(fs.readFileSync(path.join(DATASET, 'cases.json'), 'utf8'));
const out = {};

for (const c of dataset.cases) {
  const textPath = path.join(DATASET, c.text);
  const text = fs.existsSync(textPath) ? fs.readFileSync(textPath, 'utf8') : '';
  out[c.id] = detectShape({ title: c.title, text });
}

process.stdout.write(JSON.stringify(out));
