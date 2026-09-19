#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""eval/score.py · 把 results.json 变成指标和报告

跑分（run.mjs）和打分分开，是为了让结果可复算 —— 改了金标准不用重跑模型。

用法：
    python eval/score.py
    python eval/score.py --report eval/report.md

指标口径：
    分类一致率  与金标准一致的条数 / 应消化的条数（ok:false 的不计入分母）
    误拒率      该 ok:true 却被判 ok:false 的比例 —— 这一项和准确率同等重要
    调用失败率  压根没跑出结构（网络 / 校验反复不过）的比例
    重试率      需要重试才通过的比例（反映 prompt 的稳定性）
"""

import argparse
import io
import json
import os
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVAL = os.path.join(ROOT, 'eval')


def load():
    with io.open(os.path.join(EVAL, 'dataset/cases.json'), encoding='utf-8') as f:
        dataset = json.load(f)
    with io.open(os.path.join(EVAL, 'results.json'), encoding='utf-8') as f:
        results = json.load(f)

    # **金标准以 cases.json 为准**，不能用 results.json 里那份。
    # 后者是跑分当时的快照；裁判改了金标准之后还拿旧值打分的话，
    # 「跑分与打分分开」就白设计了 —— 每次都要重跑五分钟的模型。
    cases_by_id = {c['id']: c for c in dataset['cases']}
    for r in results['results']:
        c = cases_by_id.get(r['id'])
        if c:
            r['expect'] = c['expect']
            r['title'] = c['title']
            r['url'] = c['url']

    return dataset, results


def compute(results):
    rows = results['results']

    # 只统计跑出结果的条目；调用失败单独算
    call_failed = [r for r in rows if not r.get('ok')]
    done = [r for r in rows if r.get('ok')]

    # 「本来该被消化」的：金标准 ok:true
    should_digest = [r for r in done if r['expect'].get('ok', True)]
    refused = [r for r in should_digest if r['got'] and r['got']['ok'] is False]
    digestible = [r for r in should_digest if r['got'] and r['got']['ok'] is not False]

    hit = [r for r in digestible if r['got']['category'] == r['expect']['category']]

    retried = [r for r in done if (r.get('attempts') or 0) > 1]
    times = [r['elapsedMs'] for r in done if r.get('elapsedMs')]

    # 真实内容与合成探针分开统计：两者说明的是不同的事，
    # 合在一起算会让「探针很多」把真实表现稀释掉。
    by_source = {}
    for src, label in (('bookmark', '真实内容'), ('probe', '边界探针')):
        subset = [r for r in digestible if r.get('source') == src]
        if subset:
            h = [r for r in subset if r['got']['category'] == r['expect']['category']]
            by_source[src] = {'label': label, 'hit': len(h), 'total': len(subset)}

    return {
        'total': len(rows),
        'callFailed': call_failed,
        'done': done,
        'shouldDigest': should_digest,
        'refused': refused,
        'digestible': digestible,
        'hit': hit,
        'miss': [r for r in digestible if r['got']['category'] != r['expect']['category']],
        'retried': retried,
        'bySource': by_source,
        'avgSec': (sum(times) / len(times) / 1000) if times else 0,
        'maxSec': (max(times) / 1000) if times else 0,
    }


def pct(a, b):
    return f'{a / b * 100:.1f}%' if b else '—'


def report(dataset, results, m):
    meta = results['meta']
    L = []

    L.append('# WisdoMark 评测报告')
    L.append('')
    L.append('> 由 `eval/run.mjs` 跑分、`eval/score.py` 出报告。')
    L.append('> 跑分直接调用生产代码的消化链路（`src/background/digest.js`），不是另写一份实现 ——')
    L.append('> 否则分数反映的是那个副本，不是产品本身。')
    L.append('')

    L.append('## 环境与版本')
    L.append('')
    L.append('| 项 | 值 |')
    L.append('|---|---|')
    L.append(f"| 跑分时间 | {meta['ranAt'].replace('T', ' ')[:19]} |")
    L.append(f"| 模型 | `{meta['model']}` |")
    L.append(f"| prompt | `{meta['promptVersion']}` |")
    L.append(f"| 输出结构 | `{meta['schemaVersion']}` |")
    L.append(f"| 扩展版本 | `{meta['extensionVersion']}` |")
    L.append(f"| 用例数 | {meta['caseCount']} |")
    L.append(f"| 总耗时 | {meta['elapsedSec']} 秒 |")
    L.append('')

    L.append('## 指标')
    L.append('')
    L.append('| 指标 | 结果 | 说明 |')
    L.append('|---|---|---|')
    L.append(f"| **分类一致率** | **{pct(len(m['hit']), len(m['digestible']))}** "
             f"（{len(m['hit'])}/{len(m['digestible'])}）| 与金标准一致的条数 |")
    L.append(f"| 误拒率 | {pct(len(m['refused']), len(m['shouldDigest']))} "
             f"（{len(m['refused'])}/{len(m['shouldDigest'])}）| 该消化的被判成不可消化 |")
    L.append(f"| 调用失败率 | {pct(len(m['callFailed']), m['total'])} "
             f"（{len(m['callFailed'])}/{m['total']}）| 没跑出结构（网络 / 校验反复不过）|")
    L.append(f"| 重试率 | {pct(len(m['retried']), len(m['done']))} "
             f"（{len(m['retried'])}/{len(m['done'])}）| 需要重试才通过，反映 prompt 稳定性 |")
    L.append(f"| 平均耗时 | {m['avgSec']:.1f} 秒 | 单条 |")
    L.append(f"| 最长耗时 | {m['maxSec']:.1f} 秒 | 单条 |")
    L.append('')

    L.append('## 分组表现')
    L.append('')
    L.append('| 来源 | 分类一致率 | 说明 |')
    L.append('|---|---|---|')
    for src in ('bookmark', 'probe'):
        s = m['bySource'].get(src)
        if not s:
            continue
        desc = '在实际内容上的表现' if src == 'bookmark' else '在判据边界上的表现（专打模糊地带）'
        L.append(f"| {s['label']} | {pct(s['hit'], s['total'])} （{s['hit']}/{s['total']}） | {desc} |")
    L.append('')

    L.append('## 逐条明细')
    L.append('')
    L.append('| 用例 | 期望 | 得到 | 结果 | 字数 | 耗时 |')
    L.append('|---|---|---|---|---|---|')

    for r in results['results']:
        if not r.get('ok'):
            L.append(f"| `{r['id']}` | — | — | ❌ 调用失败 | — | — |")
            continue

        got = r['got']
        if got['ok'] is False:
            verdict = '⛔ 判为不可消化'
            cat = 'ok:false'
        elif got['category'] == r['expect']['category']:
            verdict = '✅'
            cat = got['category']
        else:
            verdict = '⚠️ 分歧'
            cat = got['category']

        retry = f"（重试 {r['attempts'] - 1}）" if r.get('attempts', 1) > 1 else ''
        L.append(
            f"| `{r['id']}` | {r['expect']['category']} | {cat} | {verdict} | "
            f"{r.get('chars', '—')} | {r['elapsedMs'] / 1000:.0f}s{retry} |"
        )

    L.append('')

    if m['miss'] or m['refused']:
        L.append('## 与金标准不一致的条目')
        L.append('')
        L.append('金标准已经过人工裁决，所以下面这些不是「待确认」，而是**模型的判断错了** ——')
        L.append('它们正是下一轮改进判据的输入：每一条分歧都指向判据里某个没写清的边界。')
        L.append('')

        for r in m['miss'] + m['refused']:
            L.append(f"### `{r['id']}` · {r['title']}")
            L.append('')
            L.append(f"- 链接：{r['url']}")
            if r['got']['ok'] is False:
                L.append(f"- 金标准：`{r['expect']['category']}`　模型：**判为不可消化**（{r['got'].get('reason')}）")
            else:
                L.append(f"- 金标准：`{r['expect']['category']}`　模型：`{r['got']['category']}`")
            L.append(f"- 摘要：{r['got']['summary'][:160]}")
            L.append(f"- 要点 {len(r['got']['points'])} 条，第一条：{(r['got']['points'] or ['—'])[0][:80]}")
            L.append('')

    L.append('## 已知限制')
    L.append('')
    L.append('- **正文是快照**（`eval/dataset/texts/`）：抓取用的是生产的 content-script，')
    L.append('  但「等正文稳定」的策略是评测脚本自己实现的（生产那份依赖 `chrome.tabs`，跑在 service worker 里）。')
    L.append('- 用例数偏少，分类一致率只应看趋势，不要当成精确值。')
    L.append('- 要点完整性（有没有漏内容）需要人工判断，本报告不含该项。')
    L.append('- 单机单次跑分；模型有随机性（`temperature 0.2`），同一批跑两次结果可能不同。')
    L.append('')

    return '\n'.join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--report', default=os.path.join(EVAL, 'report.md'))
    args = ap.parse_args()

    dataset, results = load()
    m = compute(results)
    text = report(dataset, results, m)

    with io.open(args.report, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text + '\n')

    print('指标')
    print('─' * 46)
    print(f"  分类一致率   {pct(len(m['hit']), len(m['digestible']))}  ({len(m['hit'])}/{len(m['digestible'])})")
    print(f"  误拒率       {pct(len(m['refused']), len(m['shouldDigest']))}  ({len(m['refused'])}/{len(m['shouldDigest'])})")
    print(f"  调用失败率   {pct(len(m['callFailed']), m['total'])}  ({len(m['callFailed'])}/{m['total']})")
    print(f"  重试率       {pct(len(m['retried']), len(m['done']))}  ({len(m['retried'])}/{len(m['done'])})")
    print(f"  平均耗时     {m['avgSec']:.1f} 秒 / 最长 {m['maxSec']:.1f} 秒")
    print()

    if m['miss']:
        print('与金标准不一致（模型的失误，也是改进判据的线索）')
        print('─' * 46)
        for r in m['miss']:
            print(f"  {r['id']:18s} 金标准 {r['expect']['category']:6s} → 模型 {r['got']['category']}")
        print()

    print(f'报告已写入 {os.path.relpath(args.report, ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
