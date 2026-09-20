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
    for r in (results.get('rows') or results.get('results') or []):
        c = cases_by_id.get(r['id'])
        if c:
            r['expect'] = c['expect']
            r['title'] = c['title']
            r['url'] = c['url']

    return dataset, results


def wilson(hit, total, z=1.96):
    """二项比例的 Wilson 置信区间。

    20 条里对 19 条是 95%，但这个比例的 95% 区间宽达 [76%, 99%] ——
    光报点估计会让人高估结论强度。把区间摆出来，比被问「样本够吗」要主动。
    """
    if not total:
        return (0.0, 0.0)
    p = hit / total
    d = 1 + z * z / total
    center = (p + z * z / (2 * total)) / d
    half = z * ((p * (1 - p) / total + z * z / (4 * total * total)) ** 0.5) / d
    return (max(0.0, center - half), min(1.0, center + half))


def ci_text(hit, total):
    lo, hi = wilson(hit, total)
    return f'[{lo * 100:.0f}%, {hi * 100:.0f}%]'


def compute(results):
    raw = results.get('rows') or results.get('results') or []

    # ---- 多轮结果摊平成「一条用例一个代表结果」----
    # 代表结果取**多数表决**（平票取较早那轮），这样下面所有指标逻辑都能直接复用。
    # passes / validRuns / verdict 留着，供「多轮稳定性」那一节单独统计。
    from collections import Counter as _C

    def label_of(x):
        g = x.get('got')
        if not g:
            return '__error__'
        return 'ok:false' if g.get('ok') is False else (g.get('category') or '__unknown__')

    rows = []
    for r in raw:
        runs = [x for x in (r.get('runs') or []) if x.get('ok') and x.get('got')]
        if not runs:
            rows.append({**r, 'ok': False, 'error': '没有有效运行', 'got': None})
            continue

        top = _C(label_of(x) for x in runs).most_common(1)[0][0]
        rep = next((x for x in runs if label_of(x) == top), runs[0])
        rows.append({
            **r,
            'ok': True,
            'error': None,
            'got': rep['got'],
            'elapsedMs': rep.get('elapsedMs'),
            'attempts': rep.get('attempts', 1),
        })

    # 只统计跑出结果的条目；调用失败单独算
    call_failed = [r for r in rows if not r.get('ok')]
    done = [r for r in rows if r.get('ok')]

    # 正样本：该被消化的（金标准 ok:true）
    should_digest = [r for r in done if r['expect'].get('ok', True)]
    refused = [r for r in should_digest if r['got'] and r['got']['ok'] is False]
    digestible = [r for r in should_digest if r['got'] and r['got']['ok'] is not False]
    hit = [r for r in digestible if r['got']['category'] == r['expect']['category']]

    # 负样本：本来就不该被消化的（登录页 / 验证码页 / 404 / 纯导航页）
    should_refuse = [r for r in done if not r['expect'].get('ok', True)]
    # 被判成「可以消化」= 误纳。比漏掉更糟：用户会拿到一段凭空生成的摘要，而且看不出来。
    over_accepted = [r for r in should_refuse if r['got'] and r['got']['ok'] is not False]

    retried = [r for r in done if (r.get('attempts') or 0) > 1]
    times = [r['elapsedMs'] for r in done if r.get('elapsedMs')]

    # 三类用例分开统计：它们说明的是不同的事，
    # 合在一起算会让「哪一类多」决定总分的高低。
    by_source = {}
    for src, label in (('bookmark', '真实内容'), ('probe', '边界探针')):
        subset = [r for r in digestible if r.get('source') == src]
        if subset:
            h = [r for r in subset if r['got']['category'] == r['expect']['category']]
            by_source[src] = {'label': label, 'hit': len(h), 'total': len(subset), 'kind': 'category'}

    if should_refuse:
        by_source['negative'] = {
            'label': '负样本（不该消化）',
            'hit': len(should_refuse) - len(over_accepted),
            'total': len(should_refuse),
            'kind': 'refuse',
        }

    # ---- 多轮稳定性 ----
    # 单次一致率只是个点估计，真正说明问题的是「这条用例稳不稳」。
    # 翻转的最值得改判据 —— 它们精确指出哪句话没兜住。
    from collections import Counter as _C2
    verdicts = dict(_C2(r.get('verdictName') or r.get('verdict') for r in raw if r.get('verdict')))
    flips = [r['id'] for r in raw if r.get('verdict') == 'flip']
    stable_fails = [r['id'] for r in raw if r.get('verdict') == 'stable-fail']
    repeat = results.get('meta', {}).get('repeat', 1)

    # 每一轮单独算一次一致率 —— 轮次之间的波动比一个点估计诚实得多
    per_round = []
    for i in range(repeat):
        h = t = 0
        for r in raw:
            runs = r.get('runs') or []
            if i >= len(runs) or not runs[i].get('ok') or not runs[i].get('got'):
                continue
            if not r['expect'].get('ok', True):
                continue
            g = runs[i]['got']
            if g.get('ok') is False:
                continue
            t += 1
            if g.get('category') == r['expect']['category']:
                h += 1
        if t:
            per_round.append((h, t))

    return {
        'total': len(rows),
        'callFailed': call_failed,
        'done': done,
        'shouldDigest': should_digest,
        'shouldRefuse': should_refuse,
        'refused': refused,
        'overAccepted': over_accepted,
        'digestible': digestible,
        'hit': hit,
        'miss': [r for r in digestible if r['got']['category'] != r['expect']['category']],
        'retried': retried,
        'bySource': by_source,
        'avgSec': (sum(times) / len(times) / 1000) if times else 0,
        'maxSec': (max(times) / 1000) if times else 0,
        'repeat': repeat,
        'verdicts': verdicts,
        'flips': flips,
        'stableFails': stable_fails,
        'perRound': per_round,
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
    L.append('| 指标 | 结果 | 95% Wilson 区间 | 说明 |')
    L.append('|---|---|---|---|')
    L.append(f"| **分类一致率** | **{pct(len(m['hit']), len(m['digestible']))}** "
             f"（{len(m['hit'])}/{len(m['digestible'])}）| {ci_text(len(m['hit']), len(m['digestible']))} | "
             f"正样本中与金标准一致的条数 |")
    L.append(f"| **误纳率** | **{pct(len(m['overAccepted']), len(m['shouldRefuse']))}** "
             f"（{len(m['overAccepted'])}/{len(m['shouldRefuse'])}）| — | "
             f"不该消化的被消化了 —— 用户会拿到一段凭空生成的摘要，而且看不出来，**比漏掉更糟** |")
    L.append(f"| 误拒率 | {pct(len(m['refused']), len(m['shouldDigest']))} "
             f"（{len(m['refused'])}/{len(m['shouldDigest'])}）| — | 该消化的被判成不可消化 |")
    L.append(f"| 调用失败率 | {pct(len(m['callFailed']), m['total'])} "
             f"（{len(m['callFailed'])}/{m['total']}）| — | 没跑出结构（网络 / 校验反复不过）|")
    L.append(f"| 重试率 | {pct(len(m['retried']), len(m['done']))} "
             f"（{len(m['retried'])}/{len(m['done'])}）| — | 需要重试才通过，反映 prompt 稳定性 |")
    L.append(f"| 平均耗时 | {m['avgSec']:.1f} 秒 | — | 单条 |")
    L.append(f"| 最长耗时 | {m['maxSec']:.1f} 秒 | — | 单条 |")
    L.append('')
    L.append(f"> 分类一致率的 95% Wilson 区间是 **{ci_text(len(m['hit']), len(m['digestible']))}** ——")
    L.append(f"> 用例只有 {m['total']} 条，区间偏宽，**分数只看趋势，不要当精确值**。")
    L.append('> 区间不是「不确定性」的免责声明，而是让读者知道这个数字能支撑多强的结论。')
    L.append('')

    if m['repeat'] > 1:
        v = m['verdicts']
        L.append('## 多轮稳定性')
        L.append('')
        L.append(f'每条用例跑了 **{m["repeat"]} 轮**。模型有随机性，单次一致率只是个点估计 ——')
        L.append('真正说明问题的是「这条用例稳不稳定」。')
        L.append('')
        L.append('| 判定 | 条数 | 含义 |')
        L.append('|---|---|---|')
        L.append(f"| 稳定通过 | {v.get('stable-pass', 0)} | 每一轮都对，判据兜住了 |")
        L.append(f"| **翻转** | {v.get('flip', 0)} | 时对时错 —— **判据在这条上没写清楚，最该改的是它** |")
        L.append(f"| 稳定失败 | {v.get('stable-fail', 0)} | 每一轮都错，是真的有问题 |")
        if v.get('error'):
            L.append(f"| 调用失败 | {v.get('error', 0)} | 没跑出结构 |")
        L.append('')

        if m['flips']:
            L.append('翻转的用例：' + '、'.join(f'`{x}`' for x in m['flips']))
            L.append('')
        if m['stableFails']:
            L.append('稳定失败的用例：' + '、'.join(f'`{x}`' for x in m['stableFails']))
            L.append('')
        if m['perRound']:
            rounds = '　'.join(f'第{i + 1}轮 {h}/{t}' for i, (h, t) in enumerate(m['perRound']))
            L.append(f'每轮单独算的一致率：{rounds}')
            L.append('')
            L.append('> 轮次之间的差值就是「随机性有多大」。拿两个版本的单轮成绩比优劣，')
            L.append('> 很可能只是抽到了运气不同的那一次。')
            L.append('')

    L.append('## 分组表现')
    L.append('')
    L.append('| 来源 | 通过率 | 95% Wilson 区间 | 说明 |')
    L.append('|---|---|---|---|')
    descs = {
        'bookmark': '在实际内容上的表现',
        'probe': '在判据边界上的表现（专打模糊地带）',
        'negative': '**该拦下的有没有被拦下**（登录页 / 验证码页 / 404 / 纯导航页）',
    }
    for src in ('bookmark', 'probe', 'negative'):
        s = m['bySource'].get(src)
        if not s:
            continue
        L.append(f"| {s['label']} | {pct(s['hit'], s['total'])} （{s['hit']}/{s['total']}） | "
                 f"{ci_text(s['hit'], s['total'])} | {descs[src]} |")
    L.append('')
    L.append('> 三类分开看的原因：它们回答的是不同的问题，合在一起算等于让「哪类用例多」决定总分。')
    L.append('')

    L.append('## 逐条明细')
    L.append('')
    L.append('| 用例 | 期望 | 得到 | 结果 | 字数 | 耗时 |')
    L.append('|---|---|---|---|---|---|')

    for r in (results.get('rows') or results.get('results') or []):
        if not r.get('ok'):
            L.append(f"| `{r['id']}` | — | — | ❌ 调用失败 | — | — |")
            continue

        got = r['got']
        is_negative = not r['expect'].get('ok', True)

        if is_negative:
            # 负样本：通过 = 被正确拦下
            exp_label = '`ok:false`'
            if got['ok'] is False:
                verdict, cat = '✅ 正确拦下', '`ok:false`'
            else:
                verdict, cat = '⚠️ **误纳**', got['category'] or '—'
        else:
            exp_label = r['expect']['category']
            if got['ok'] is False:
                verdict, cat = '⛔ 判为不可消化', '`ok:false`'
            elif got['category'] == r['expect']['category']:
                verdict, cat = '✅', got['category']
            else:
                verdict, cat = '⚠️ 分歧', got['category']

        retry = f"（重试 {r['attempts'] - 1}）" if r.get('attempts', 1) > 1 else ''
        L.append(
            f"| `{r['id']}` | {exp_label} | {cat} | {verdict} | "
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
    print('─' * 54)
    print(f"  分类一致率   {pct(len(m['hit']), len(m['digestible']))}  ({len(m['hit'])}/{len(m['digestible'])})"
          f"  95% CI {ci_text(len(m['hit']), len(m['digestible']))}")
    print(f"  误纳率       {pct(len(m['overAccepted']), len(m['shouldRefuse']))}  "
          f"({len(m['overAccepted'])}/{len(m['shouldRefuse'])})   不该消化的被消化了")
    print(f"  误拒率       {pct(len(m['refused']), len(m['shouldDigest']))}  "
          f"({len(m['refused'])}/{len(m['shouldDigest'])})   该消化的被判成不可消化")
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
