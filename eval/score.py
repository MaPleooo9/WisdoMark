#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""eval/score.py · 把 results.json 变成指标和报告

跑分（run.mjs）和打分分开，是为了让结果可复算 —— 改了金标准不用重跑模型。

用法：
    python eval/score.py
    python eval/score.py --report eval/report.md

指标口径：
    分类一致率  与金标准一致的条数 / 应消化的条数（ok:false 的不计入分母）
    误纳率      不该消化的却被消化了的比例 —— 用户会拿到一段凭空生成的摘要，比漏掉更糟
    误拒率      该 ok:true 却被判 ok:false 的比例 —— 这一项和准确率同等重要
    调用失败率  压根没跑出结构（网络 / 校验反复不过）的比例
    重试率      需要重试才通过的比例（反映 prompt 的稳定性）

    ⚠️ 误纳率有多个口径（模型侧 / 模型是唯一防线 / 端到端），
       报告里用的是**模型侧**（能从本仓库复算的那个），另两个当参考写在表下。
       别把「排除掉抓取侧护栏兜底的条目」当成默认口径 —— 那正是挑有利分母。
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
            # 「这条主要靠哪一环拦下」—— 报告要能区分漏在抓取侧还是模型侧
            r['guard'] = c.get('guard', '')
            r['guardNote'] = c.get('guardNote', '')

    return dataset, results


def manifest_version():
    """当前仓库里的扩展版本。

    跑分产物里记着「跑分当时的版本」，这里读的是「现在仓库的版本」。
    两者不一致时报告要主动说清楚差在哪 —— 不能让读者自己去发现对不上。
    """
    try:
        with io.open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8') as f:
            return json.load(f).get('version', '')
    except Exception:
        return ''


def prompt_version():
    """当前仓库里的 prompt 版本。

    这是判断「一份老报告还算不算数」的**真正判据** ——
    模型收到的输入（`prompt.json`）和判定标准（`output-schema.json`）都在 `shared/` 里，
    这两个文件没动过，指标就不会变。`src/` 下改了多少都不必然影响它
    （抓取侧护栏、trace 记录都不改变喂给模型的内容）。
    """
    try:
        with io.open(os.path.join(ROOT, 'shared', 'prompt.json'), encoding='utf-8') as f:
            return json.load(f).get('version', '')
    except Exception:
        return ''


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

    # 「模型是唯一防线」的负样本：这些条目若模型失手，产品就真的漏了。
    # 其余条目另有抓取侧护栏兜底（登录墙 / Cookie 墙），模型失手也不等于产品失手。
    # 这个数字和「误纳率」互补 —— 后者衡量模型单独的能力，前者衡量产品的实际暴露面。
    sole_guard = [r for r in should_refuse if (r.get('guard') or '') == '模型侧']
    sole_guard_caught = [r for r in sole_guard if r['got'] and r['got']['ok'] is False]

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
        # 摊平后的「一条用例一个代表结果」，逐条明细直接复用它。
        # 不暴露出去的话，report() 只能去遍历原始 rows —— 那里只有 runs、没有 ok/got，
        # 于是整张明细表会全部显示「调用失败」。这个 bug 真的发生过：
        # 报告头部写着 95%，底部 27 行全 ❌，一份报告自己打自己的脸。
        # 多数表决只能有一份实现，指标区和明细区必须读同一个列表才不会再次分叉。
        'rows': rows,
        'total': len(rows),
        'callFailed': call_failed,
        'done': done,
        'shouldDigest': should_digest,
        'shouldRefuse': should_refuse,
        'refused': refused,
        'overAccepted': over_accepted,
        'soleGuard': sole_guard,
        'soleGuardCaught': sole_guard_caught,
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

    # 跑分版本 vs 当前仓库 —— **让报告自己诊断**它还算不算数。
    #
    # 演进过程值得记一笔：第一版写的是「差异在抓取侧（detectConsentWall + digestAndStore 早退）」
    # —— 版本号是动态读的不会烂，但那段分析是写死的，多加一个版本就变成假话。
    # 第二版换成「跑 git log 看源码树有没有改」，也不行：trace 那次提交确实动了
    # digest.js，命令有输出，可它改的只是记录字段、不改变喂给模型的内容，
    # 于是**判据和结论对不上**。
    #
    # 现在落在 prompt 版本号上：模型收到的输入与判定标准都只在 shared/ 里，
    # 那两个文件的版本号没变，指标就不可能变。判据本身可自动核对，不用人来解释。
    cur_version = manifest_version()
    cur_prompt = prompt_version()
    if cur_version and cur_version != meta['extensionVersion']:
        same_prompt = bool(cur_prompt) and cur_prompt == meta['promptVersion']
        L.append(f"> **跑分版本 vs 当前仓库**：这份报告的数字跑于扩展 `{meta['extensionVersion']}` / "
                 f"prompt `{meta['promptVersion']}`，"
                 f"当前仓库是 `{cur_version}` / prompt `{cur_prompt or '—'}`。")
        L.append('>')
        if same_prompt:
            L.append('> **prompt 版本一致，所以这份数字仍然有效。** 判据就这一条：')
            L.append('> 模型收到的输入与判定标准都在 `shared/prompt.json`（prompt 正文与参数）')
            L.append('> 和 `shared/output-schema.json`（校验规则）里 —— 它们没动过，指标就不会变。')
            L.append('>')
            L.append('> `src/` 下的改动不必然影响指标：抓取侧护栏、trace 记录都不改变喂给模型的内容。')
            L.append('> 所以判据落在这两个文件的版本号上，**而不是「源码树里有没有新提交」**。')
            L.append('>')
            L.append('> 因此没有重跑模型 —— 重跑一次约 16 分钟，不会改变这里任何一项指标，')
            L.append('> 却会引入模型随机性、把一条「三轮零翻转」的干净基线搅浑。')
        else:
            L.append('> ⚠️ **prompt 版本对不上（或读不到）—— 这份数字已经过期，不要引用。**')
            L.append('> 重新跑：`node eval/run.mjs`（约 16 分钟）→ `python eval/score.py`。')
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
    L.append('> **误纳率这一个数有三个口径，别混用**（表内只放能从本仓库复算的）：')
    L.append('>')
    L.append(f"> - **模型侧 {len(m['overAccepted'])}/{len(m['shouldRefuse'])}**：本评测链路能测到的全部 ——")
    L.append('>   负样本是**直接喂给模型**的，抓取侧根本不在这条链路上。这是唯一能从本仓库复算的口径，所以放在表里。')
    L.append(f"> - **模型是唯一防线 {len(m['soleGuardCaught'])}/{len(m['soleGuard'])} 拦下**"
             f"（{'、'.join('`' + r['id'] + '`' for r in m['soleGuard']) or '—'}）：")
    L.append('>   只有这些条目，模型失手才等于产品失手；其余另有抓取侧护栏兜底。这才是真实的暴露面。')
    L.append('> - **端到端 0/' + str(len(m['shouldRefuse'])) + '**：`neg-cookie` 在到达模型之前已被抓取侧拦下。')
    L.append('>   但支撑它的是**仓库外**的端到端脚本（真实页面上 9/9），本报告无法自动产出 ——')
    L.append('>   拿一个不可复算的数字当头条，等于用一句别人验不了的话自我背书，所以它只写在这里、不进指标表。')
    L.append('>')
    L.append('> 头条用的是**最差的那个口径**：把唯一失手的那条从分母里剔掉，正是「挑有利分母」，')
    L.append('> 省下的几分好看远远抵不上失掉的可信度。')
    L.append(f"> 另外提醒：负样本只有 {len(m['shouldRefuse'])} 条，**单条就是 "
             f"{100.0 / len(m['shouldRefuse']):.1f} 个百分点** —— 这里的变化只应看趋势。")
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
        'negative': '**该拦下的有没有被拦下**（登录页 / 验证码页 / 404 / 纯导航页 / Cookie 与隐私声明页）',
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

    if m['shouldRefuse']:
        L.append('## 负样本：拦在哪一环')
        L.append('')
        L.append('一条负样本有**两个互相独立的事实**：「产品里该由谁拦」和「这条评测链路里谁真的拦住了」。')
        L.append('评测把正文**直接喂给模型**（`digestDocument`），抓取侧的护栏不在链路上 ——')
        L.append('两者不一致时（`neg-login`、`neg-cookie`）恰恰是最该点名的，所以拆成两列。')
        L.append('')
        L.append('| 用例 | 设计上归谁拦 | 本链路（模型侧） | 为什么归这一环 |')
        L.append('|---|---|---|---|')
        guard_order = {'模型侧': 0, '两侧': 1, '抓取侧': 2}
        for r in sorted(m['shouldRefuse'], key=lambda x: guard_order.get(x.get('guard') or '', 9)):
            guard = r.get('guard') or '—'
            leaked = r['got'] and r['got']['ok'] is not False
            if guard == '模型侧':
                # 唯一防线：模型失手 = 产品失手
                mark = '⚠️ **误纳**（产品真漏）' if leaked else '✅ 拦下 · **唯一防线**'
            elif guard == '两侧':
                # 两侧都能拦：模型兜住了是分内之事，拦不住还有抓取侧
                mark = '⚠️ 误纳 · 预期外（抓取侧本应兜住）' if leaked else '✅ 模型兜住了（本环由两侧共担）'
            else:
                # 抓取侧负责：模型这一环拦住算额外，拦不住是设计使然
                mark = '⚠️ **误纳** · 预期内（已由抓取侧拦下）' if leaked else '✅ 模型也拦住了（额外，不在模型侧责任内）'
            L.append(f"| `{r['id']}` | {guard} | {mark} | {r.get('guardNote') or ''} |")
        L.append('')
        L.append('> 读法：**「设计上归谁拦」是产品分工，「本链路」是评测实测，两者不是一回事。**')
        L.append(f"> 只有标了「唯一防线」的 {len(m['soleGuard'])} 条，模型失手才等于产品失手 ——")
        L.append(f"> 当前 {len(m['soleGuardCaught'])}/{len(m['soleGuard'])} 拦下。")
        L.append('> 标「不计入模型侧责任」不是免罪，它说明这条本来就不该指望模型；')
        L.append('> 标「额外拦住了」也不加分，换一篇文章它未必还兜得住。')
        L.append('')
        L.append('> **这一节只反映模型侧的拦截能力。** 评测是把正文直接喂给模型，')
        L.append('> 抓取侧的判据（URL 特征 / 密码框 / 验证码框 / 正文过短且含登录话术 / Cookie 与隐私话术）')
        L.append('> 不在这条链路上 —— 它要在真实浏览器里单独验。')
        L.append('')

    L.append('## 评测覆盖不到的地方（这份报告能支撑什么结论）')
    L.append('')
    L.append('本报告测的是**消化链路**（`digestDocument`）。下面这些环节不在它的覆盖范围内 ——')
    L.append('写出来是为了让「这个分数能支撑多强的结论」可判断，不是为了免责：')
    L.append('')
    L.append('| 环节 | 为什么覆盖不到 | 在别处怎么验 |')
    L.append('|---|---|---|')
    L.append('| 抓取侧护栏（登录墙 / Cookie 墙 / 过短正文） | 评测把正文直接喂给模型，不经过 content-script | 端到端脚本 `wm-consent-test.mjs`，真实页面上 9/9（脚本在仓库外）|')
    L.append('| 图文帖 OCR（Tesseract） | 评测喂的是已拼好的正文快照，识别质量本身没有指标 | 人工抽查；本报告不含该项 |')
    L.append('| 归档去重（URL 归一化） | `store.js` 的逻辑不在这条链路上 | 开发期独立验证脚本（仓库外）|')
    L.append('| 抓取时序（等正文渲染稳定） | 评测用固定快照，生产依赖 `chrome.tabs` | 人工在真实页面上观察 |')
    L.append('| 要点完整度 / 摘要幻觉 | 需要人工判断 | 计划中的人工评分表 |')
    L.append('')

    L.append('## 逐条明细')
    L.append('')
    L.append('| 用例 | 期望 | 得到 | 结果 | 字数 | 耗时 |')
    L.append('|---|---|---|---|---|---|')

    # 用 compute() 摊平后的行（多数表决结果）。**不要**去遍历原始 rows ——
    # 那里只有 runs、没有 ok/got，整张表会全部显示「调用失败」。
    for r in m['rows']:
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
                # 护栏归属在抓取侧的条目，模型拦不住是设计使然（它根本不该被问到）
                outside = '（已由抓取侧拦下，不在本链路）' if r.get('guard') == '抓取侧' else ''
                verdict, cat = f'⚠️ **误纳**{outside}', got['category'] or '—'
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
    L.append(f"- 用例数偏少（{m['total']} 条），分类一致率只应看趋势，不要当成精确值。")
    L.append('- 要点完整性（有没有漏内容）需要人工判断，本报告不含该项。')
    L.append(f"- **单机**：模型有随机性（`temperature 0.2`）。已跑 {m['repeat']} 轮取多数表决、")
    L.append('  给出翻转条数与 Wilson 区间；但换机器或换模型版本都要重跑才算数。')
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
    for r in m['shouldRefuse']:
        leaked = r['got'] and r['got']['ok'] is not False
        print(
            f"      {'❌ 误纳' if leaked else '✅ 拦下'}  {(r.get('guard') or '—'):4s}  {r['id']}"
        )
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
