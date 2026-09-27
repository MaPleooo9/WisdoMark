#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""eval/quality.py · 摘要质量评测（**纯计算，不调模型**）

## 评的是什么

不评「我觉得这段摘要写得好不好」—— 那是审美，没有标准也复算不了。
评的是**它有没有做到自己在 prompt 里承诺的事**。`shared/prompt.json` 里可核查的承诺：

| # | 承诺（原文措辞） | 能否机械核查 |
|---|---|---|
| 1 | 不得编造正文里没有的数字 | ✅ 数字幻觉率 |
| 2 | 专有名词、产品名、命令名要原样照抄，不要在词中间插入顿号、空格 | ✅ 拆分改写检测 |
| 3 | 不许写「介绍了重要性」「值得关注」这类空话 | 🔶 词表命中（只能抓明显的） |
| 4 | 每条要落到具体细节（名称、数字、步骤、结论） | 🔶 锚点占比（代理指标） |
| 5 | 压缩重复，不压信息 | ❌ 需要语义判断 |
| 6 | 单一主题并列清单：原文 11 项就写 11 条，一项不漏 | ✅ 条目回收比 |
| 7 | 聚合类按主题归纳，条数远少于条目数 | ✅ 方向性检查 |
| 8 | 聚合类要在 summary 里说明原文收录多少条 | ✅ summary 含数字 |
| 9 | 超 20 条时要在 summary 里说明 | 🔶 条件触发才查 |

## 两个主指标

- **关键锚点召回率**：原文里的数字与拉丁专名，有多少被装进了卡片（summary + 全部要点）。
  这是「漏没漏」的下限检查 —— **低了一定是漏了；高了不等于写得好。**
- **数字幻觉率**：卡片里出现的数字，有多少在原文里找不到。
  这是「编没编」的检查 —— 幻觉是用户**无法察觉**的伤害（和误纳同一个逻辑），所以单列。

## 用法

    python eval/quality.py                 # → eval/quality.md
    python eval/quality.py --show 5        # 控制台多打几条明细

不调模型，所以秒级、可反复跑。**改了 prompt 之后不用重跑模型也能看这批指标**
（模型输出取自 `eval/results.json`）。
"""

import argparse
import io
import json
import os
import re
import subprocess
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVAL = os.path.join(ROOT, 'eval')
DATASET = os.path.join(EVAL, 'dataset')

sys.path.insert(0, EVAL)
import score  # noqa: E402  —— 复用它的多数表决与金标准合并，不另写一份


# ---------------------------------------------------------------------------
# 文本归一化
# ---------------------------------------------------------------------------

_FULLWIDTH = str.maketrans(
    '０１２３４５６７８９％＃－．，：；（）＋　',
    '0123456789%#-.,:;()+ ',
)


def norm(s):
    return str(s or '').translate(_FULLWIDTH)


def tight(s):
    """去掉所有空白 —— 用于「这个锚点有没有出现」的包含判断。

    为什么要去空白：原文「Win + V」和输出「Win+V」是同一个东西，
    带空格比对会误判成没覆盖。
    """
    return re.sub(r'\s+', '', norm(s))


# ---------------------------------------------------------------------------
# 锚点抽取：只抽**可核查**的东西
# ---------------------------------------------------------------------------

# 数字（含常见单位）。单位只是帮我们认出这是个有意义的数字，
# 比对时只用「数位核心」，避免「25 项」和「25项」被当成两个值。
_NUM_RE = re.compile(
    r'\d+(?:[.,]\d+)?\s*'
    r'(?:%|MB|GB|KB|TB|mb|gb|kb|tb|ms|fps|Hz|px|'
    r'分钟|小时|天|周|个月|年|个|条|款|次|倍|万|亿|元|块|项|张|页|人|台|度|寸|'
    r'MB/s|KB/s|K|M|G|k|m|s)'
)

# 拉丁词。中文文章里的拉丁词基本都是产品名 / 命令 / 术语，是很干净的专名信号。
_LATIN_RE = re.compile(r'[A-Za-z][A-Za-z0-9_.+\-]*')

# 常见英文虚词与站点噪声 —— 它们不是「专名」，留在分母里会稀释召回率
# ⚠️ 不要把 `ai` 这类**有实义的缩写**放进来：AI 是正经专名，误过滤会把它算成「没覆盖」
_STOP = {
    'the', 'and', 'for', 'with', 'you', 'your', 'this', 'that', 'are', 'not', 'can', 'will',
    'from', 'how', 'what', 'why', 'when', 'which', 'app', 'ok', 'it', 'is', 'to', 'of', 'in',
    'on', 'or', 'an', 'if', 'do', 'use', 'new', 'all', 'but', 'has', 'have', 'out', 'one',
    'two', 'per', 'via', 'vs', 'etc', 'http', 'https', 'www', 'com', 'cn', 'id',
    'pro', 'max', 'mini', 'plus', 'top', 'best',
}

# ---------------------------------------------------------------------------
# 界定「正文区域」—— 快照里混着站点自带的东西，**摘要本来就不该包含它们**
#
# 不过滤的话分母会被灌水：实测某一篇 3,684 字的快照里，14 个数字锚点全部来自
# 投票组件（`买过二手产品吗单选26人参与 / 真香 57.7%15人`）、评论数
# （`评论 (已有23条评论)`）和页脚推广（`3亿steam玩家必备应用`）——
# 于是「数字召回率 0/14」，而模型其实什么都没漏（那一篇正文里就没有数字）。
#
# ⚠️ 过滤方向是**有偏的**：如果误删了正文里的真数字，召回率会**偏高**（盲目乐观）；
# 反之留了装饰则会偏低。所以报告里必须说明「分母经过了这套过滤」，
# 而过滤规则就在下面这几行，读者可以自己判断裁剪得狠不狠。
# ---------------------------------------------------------------------------

# 页脚标记：从这里往后全是导航 / 备案号 / 推广 / 阅读器控件，不是正文
_FOOTER_MARKS = [
    '立即下载', '公网安备', '暂无更多内容', '联系我们', '关于我们',
    '黑盒语音', '小黑盒加速器', '扫描二维码', '关注公众号',
    # 微信公众号的内嵌阅读器：正文之后跟着「调整字号 / 留言 / 扫码关注」一整套控件
    '调整当前正文文字大小', '暂无留言', '已无更多数据', '微信扫一扫', '写留言',
]
# 投票组件：`买过二手产品吗单选26人参与 … 已结束`
_POLL_RE = re.compile(r'[^\n]{0,40}单选\s*\d+\s*人参与.*?(?:已结束|\Z)', re.S)
# 评论 / 留言计数：`评论 (已有23条评论)`、`1条留言`
_COMMENT_RE = re.compile(r'评论\s*[（(][^）)]{0,20}[)）]|\d+\s*条留言')
# 相对时间：`3天前 ·江苏` —— 这是发布时间，不是内容
_REL_TIME_RE = re.compile(r'\d+\s*(?:秒|分钟|小时|天|周|个月|年)\s*前')
# 用户等级 / 徽标：`Lv.17`、`lv 22`
# 注意：**不要用 `\b`** —— Python 的 `\w` 包含汉字，中文与数字之间不存在词边界，
# `\b2026\b` 匹配不到 `年2026年`。这个坑实测踩过（2026年没被过滤掉）。
_LEVEL_RE = re.compile(r'(?<![A-Za-z])lv\.?\s*\d+', re.I)
# 邮箱与域名：`yifeng.ruan`、`gmail.com`、`a@b.com`
_MAIL_RE = re.compile(
    r'[\w.+\-]+@[\w.\-]+|(?<![\w.\-])[\w\-]+\.(?:com|cn|net|org|ru|io|dev|me|xyz|link|top|cc)(?![\w\-])',
    re.I,
)
# 年份：紧跟「年」的数字是版式信息，摘要不写不算漏
_YEAR_RE = re.compile(r'\d{2,4}\s*年')

# 中文数字 —— 用来给「换个写法就算漏」误判兜底。
#
# 实测：原文写「主要 3 个原因」，模型写「主要三个原因」，纯数字比对会记成「漏了」，
# 但其实是同一个信息换了个写法。小数字最容易出现这种情况，所以 1~20 全部映射。
# 值是**可接受写法列表**（「2」既可能写成「二」也可能写成「两」，
# 用 dict 单值会被后者覆盖 —— 这个 bug 写过一次）。
_CN_NUM = {
    '1': ('一',), '2': ('二', '两', '俩'), '3': ('三',), '4': ('四',), '5': ('五',),
    '6': ('六',), '7': ('七',), '8': ('八',), '9': ('九',), '10': ('十',),
    '11': ('十一',), '12': ('十二',), '13': ('十三',), '14': ('十四',), '15': ('十五',),
    '16': ('十六',), '17': ('十七',), '18': ('十八',), '19': ('十九',), '20': ('二十',),
    '100': ('百',), '1000': ('千',),
}


def _num_covered(core, out_tight):
    """数字是否被覆盖：阿拉伯写法或中文写法任一命中都算。"""
    if tight(core) in out_tight:
        return True
    return any(cn in out_tight for cn in _CN_NUM.get(core, ()))


# 中文数字解析 —— 只为**幻觉判据**服务。
#
# 实测踩过的误报：原文写「每周固定花十五分钟」，模型写「每周固定花 15 分钟」——
# 这是正确的转换，但幻觉判据只看原文里的阿拉伯数字，于是把它记成
# 「模型编造了 15」。幻觉率是头条指标，**在这里误报等于冤枉模型**，必须修。
_CN_DIGITS = {'一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
_CN_UNITS = {'十': 10, '百': 100, '千': 1000}
_CN_RUN_RE = re.compile(r'[一二两三四五六七八九十百千]{1,6}')


def parse_cn_number(s):
    """把中文数字串解析成整数；解析不了返回 None。

    支持「十五」「二十」「三十五」「三百」「一千二百」这类常见写法。
    """
    total = 0
    cur = 0
    for ch in s:
        if ch in _CN_DIGITS:
            cur = _CN_DIGITS[ch]
        elif ch in _CN_UNITS:
            total += (cur or 1) * _CN_UNITS[ch]
            cur = 0
        else:
            return None
    return total + cur


def extract_cn_values(text):
    """原文里所有中文数字的**数值**集合 —— 供幻觉判据认定「这个数字来自正文」。"""
    out = set()
    for m in _CN_RUN_RE.finditer(norm(text)):
        v = parse_cn_number(m.group(0))
        if v:
            out.add(v)
    return out


def _num_supported(core, any_nums, cn_values):
    """输出里的这个数字，原文能支撑吗？（阿拉伯写法或中文写法任一都算）"""
    if core in any_nums:
        return True
    try:
        v = float(core)
    except ValueError:
        return False
    return v == int(v) and int(v) in cn_values


def strip_chrome(text):
    """裁掉页面装饰，得到「正文区域」。

    只用于**抽原文锚点**（问「该带出来的信息带了吗」）。
    摘要侧不裁剪 —— 模型写出来的东西本来就是干净的。
    """
    t = str(text or '')

    # 尾部页脚：从最早出现的页脚标记处截断
    cuts = [t.find(mark) for mark in _FOOTER_MARKS]
    cuts = [i for i in cuts if i > 0]
    if cuts:
        t = t[:min(cuts)]

    t = _POLL_RE.sub(' ', t)
    t = _COMMENT_RE.sub(' ', t)
    t = _REL_TIME_RE.sub(' ', t)
    t = _LEVEL_RE.sub(' ', t)
    t = _MAIL_RE.sub(' ', t)
    t = _YEAR_RE.sub(' ', t)
    return t


def extract_numbers(text):
    """数字锚 → {数位核心: 完整写法}"""
    out = {}
    for m in _NUM_RE.finditer(norm(strip_chrome(text))):
        raw = m.group(0)
        core = re.sub(r'[^\d.]', '', raw)
        core = core.strip('.')
        if core and len(core) <= 12:
            out.setdefault(core, raw.strip())
    return out


def extract_latin(text):
    """拉丁专名锚 → 原样写法（首见）"""
    out = {}
    for m in _LATIN_RE.finditer(norm(strip_chrome(text))):
        tok = m.group(0).strip('.-_')
        if len(tok) < 2:
            continue
        if tok.lower() in _STOP:
            continue
        if re.fullmatch(r'[\d.]+', tok):
            continue
        # `Lv.17` 这类带数字后缀的短前缀是徽标切剩下的碎片
        if re.fullmatch(r'[A-Za-z]{1,3}\.\d+', tok):
            continue
        out.setdefault(tok.lower(), tok)
    return out


# ---------------------------------------------------------------------------
# 核查各条承诺
# ---------------------------------------------------------------------------

# 承诺 3：空话词表。只收「一出现就说明这条没落到细节」的措辞。
_FILLER = [
    '值得关注', '重要性', '意义重大', '不容忽视', '总的来说', '综上所述',
    '需要注意的是', '值得一提', '非常重要', '值得一看', '有一定的', '值得注意',
    '值得学习', '很有帮助', '有很大帮助', '颇具',
]

# 承诺 6：原文的并列条目。行首编号三种写法。
_ITEM_RES = [
    re.compile(r'^[ \t]*\d{1,2}[.、)）][ \t]*\S', re.M),
    re.compile(r'^[ \t]*[一二三四五六七八九十]{1,3}[、.][ \t]*\S', re.M),
    re.compile(r'^[ \t]*[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]'),
]

# 承诺 2：被拆开的拉丁词。原文 `ReactRouter` 输出成 `React、Router` 这种。
_SPLIT_RE = re.compile(r'([A-Za-z]{2,})\s*[、，,]\s*([A-Za-z]{2,})')


def count_items(text):
    """数原文里的并列条目。取三种编号写法里命中最多的一种。

    为什么取最多而不是求和：同一份正文里混用「1.」和「一、」时，
    求和会把同一个条目数两遍（序号行可能同时被两种正则匹配到）。
    """
    return max((len(r.findall(text)) for r in _ITEM_RES), default=0)


# 承诺 8：聚合类要在 summary 里说明收录了多少条。
# 模型只能**自己数** —— 这正是本项目一贯警惕的事（「数量和占比一律由代码统计」），
# 所以这里不只查「写没写」，还把**模型自报的数**与**代码数出来的条目数**并排放，供人对照。
_COUNT_CLAIM_RE = re.compile(
    r'(?:收录|共|合计|总计|包含|汇总)\s*(\d{1,3})\s*(?:条|篇|则|项|个)'
    r'|(\d{1,3})\s*(?:条|篇|则)\s*(?:内容|资讯|文章|条目|新闻)'
)


def extract_count_claims(text):
    """输出里「自报收录数」的声明 → [数字]。"""
    out = []
    for m in _COUNT_CLAIM_RE.finditer(norm(text)):
        v = m.group(1) or m.group(2)
        if v:
            out.append(int(v))
    return out


def has_anchor(point):
    """这条要点里有没有「具体的东西」：数字、拉丁词、或引号里的术语。"""
    if _NUM_RE.search(norm(point)):
        return True
    if any(t.lower() not in _STOP for t in _LATIN_RE.findall(point)):
        return True
    return bool(re.search(r'[「『“"]([^」』”"]{2,})[」』”"]', point))


def check_case(text, got, shape):
    """对一条用例核查所有可机械核查的承诺。got = {'summary','points'}"""
    out_text = norm(got.get('summary', '') + '\n' + '\n'.join(got.get('points') or []))
    out_tight = tight(out_text)
    out_tight_low = out_tight.lower()

    # 两套锚点集合，用途不同：
    #   recall 侧用「去掉页面装饰」的版本 —— 问的是「该带出来的信息带了吗」
    #   hallucination 侧用「完整原文」的版本 —— 问的是「这个数字原文里有吗」。
    #     装饰也算「原文里有」：模型写了发布日期不算编造，只是没被要求写。
    in_nums = extract_numbers(strip_chrome(text))
    in_latin = extract_latin(strip_chrome(text))
    any_nums = extract_numbers(text)
    cn_values = extract_cn_values(text)

    # —— 承诺 1：不得编造正文里没有的数字 ——
    # 用**未过滤**的完整原文判「原文有没有」，并且认中文数字写法。
    out_nums = extract_numbers(out_text)
    invented = {
        c: raw for c, raw in out_nums.items() if not _num_supported(c, any_nums, cn_values)
    }

    # —— 承诺 2：专名要原样照抄 ——
    split_bad = []
    for a, b in _SPLIT_RE.findall(out_text):
        if (a + b).lower() in in_latin or (a + b) in in_latin:
            split_bad.append(f'{a}、{b}')

    # —— 关键锚点召回 ——
    # 数字与专名分开统计：数字基本不会被「换个说法」，是干净指标；
    # 专名会被合理翻译（Microsoft → 微软、Agent → 智能体），
    # 所以它天然偏低，只能当参考。
    missed_nums = {c: raw for c, raw in in_nums.items() if not _num_covered(c, out_tight)}
    missed_latin = {k: v for k, v in in_latin.items() if tight(v).lower() not in out_tight_low}

    # —— 承诺 3：空话 ——
    fillers = [(w, out_text.count(w)) for w in _FILLER if w in out_text]

    # —— 承诺 4：要点是否落到具体细节 ——
    points = got.get('points') or []
    vague = [p for p in points if not has_anchor(p)]

    # —— 承诺 6/7：条目数与形态的关系 ——
    n_items = count_items(text)
    n_points = len(points)

    # —— 承诺 8：聚合类的收录数 ——
    claims_anywhere = extract_count_claims(out_text)
    claims_in_summary = extract_count_claims(got.get('summary', ''))

    return {
        'inNums': len(in_nums),
        'inLatin': len(in_latin),
        'hitNums': len(in_nums) - len(missed_nums),
        'hitLatin': len(in_latin) - len(missed_latin),
        'missedNums': list(missed_nums.values()),
        'missedLatin': list(missed_latin.values()),
        'outNums': len(out_nums),
        'inventedNums': list(invented.values()),
        'splitNames': split_bad,
        'fillers': fillers,
        'nPoints': n_points,
        'nVague': len(vague),
        'vagueSamples': vague[:2],
        'nItems': n_items,
        'countClaims': claims_anywhere,
        'countInSummary': claims_in_summary,
        'shape': shape,
        'summary': got.get('summary', ''),
        'summaryChars': len(got.get('summary', '')),
        'pointChars': [len(p) for p in points],
        'inChars': len(text),
        'outChars': len(out_text),
    }


# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------

def load_shapes():
    """形态由生产代码的 detectShape 决定 —— 直接调它，不在 Python 里抄一份正则。"""
    node = os.environ.get('NODE_BIN') or 'node'
    try:
        out = subprocess.run(
            [node, os.path.join(EVAL, 'shapes.mjs')],
            capture_output=True, text=True, timeout=60,
        )
    except FileNotFoundError:
        raise SystemExit(
            '❌ 找不到 node。形态判断要用生产代码的 detectShape，请先装 Node 或设 NODE_BIN。'
        )
    if out.returncode != 0:
        raise SystemExit(f'❌ eval/shapes.mjs 执行失败：{out.stderr.strip()[:300]}')
    return json.loads(out.stdout)


def rate(a, b):
    return (a / b) if b else None


def fmt_rate(x):
    return '—' if x is None else f'{x * 100:.1f}%'


def compute(dataset, results, shapes):
    # 用 score.compute 摊平出的「多数表决代表结果」，而不是原始 runs ——
    # 多数表决只能有一份实现，两边读同一份才不会分叉（这个坑 report.md 刚踩过）。
    rows = score.compute(results)['rows']
    cases = {c['id']: c for c in dataset['cases']}

    ok_rows = []
    for r in rows:
        if not r.get('expect', {}).get('ok', True):
            continue  # 负样本本来就不该被消化，没有摘要可评
        if not r.get('ok') or not r.get('got') or r['got'].get('ok') is False:
            continue
        c = cases.get(r['id'])
        if not c:
            continue
        r['_shape'] = shapes.get(r['id'], 'single')
        r['_q'] = check_case(
            io.open(os.path.join(DATASET, c['text']), encoding='utf-8').read(),
            r['got'],
            r['_shape'],
        )
        ok_rows.append(r)
    return ok_rows


def report(rows, meta):
    n = len(rows)
    qs = [r['_q'] for r in rows]

    num_total = sum(q['inNums'] for q in qs)
    num_hit = sum(q['hitNums'] for q in qs)
    lat_total = sum(q['inLatin'] for q in qs)
    lat_hit = sum(q['hitLatin'] for q in qs)
    out_num_total = sum(q['outNums'] for q in qs)
    invented = sum(len(q['inventedNums']) for q in qs)
    points_total = sum(q['nPoints'] for q in qs)
    vague = sum(q['nVague'] for q in qs)
    fillers = sum(sum(c for _, c in q['fillers']) for q in qs)

    L = []
    L.append('# WisdoMark 摘要质量评测')
    L.append('')
    L.append('> 由 `eval/quality.py` 生成。**纯计算、不调模型** —— 模型输出取自 `eval/results.json`，')
    L.append('> 所以改了判据之后不重跑模型也能看这批指标。')
    L.append('')
    L.append('> 评的不是「摘要写得好不好」（那是审美，没有标准也复算不了），')
    L.append('> 而是**它有没有做到自己在 `shared/prompt.json` 里承诺的事**。')
    L.append('> 每条指标下面都写了它对应哪一句承诺、以及它看不见什么。')
    L.append('')

    L.append('## 主指标')
    L.append('')
    L.append('| 指标 | 结果 | 对应的承诺 |')
    L.append('|---|---|---|')
    L.append(f"| **数字召回率** | **{fmt_rate(rate(num_hit, num_total))}** "
             f"（{num_hit}/{num_total}）| 「原文里读者用得上的信息，是不是都被装进去了」"
             f"—— 数字基本不会被换说法，所以这是最干净的一项 |")
    L.append(f"| **数字幻觉率** | **{fmt_rate(rate(invented, out_num_total))}** "
             f"（{invented}/{out_num_total}）| 「不得编造正文里没有的数字」"
             f"—— 编没编的检查。幻觉是用户**无法察觉**的伤害，所以单列 |")
    L.append(f"| 专名覆盖（参考） | {fmt_rate(rate(lat_hit, lat_total))} "
             f"（{lat_hit}/{lat_total}）| 「专有名词要原样照抄」—— "
             f"**会合理翻译，所以天然偏低**：原文 `Microsoft` 输出写「微软」不算错 |")
    L.append(f"| 无锚点要点占比 | {fmt_rate(rate(vague, points_total))} （{vague}/{points_total}）| "
             f"「每条要落到具体细节」—— 只是「可核查性」，**不等于空泛**（见下） |")
    L.append(f"| 空话措辞命中 | {fillers} 处 | 「不许写『介绍了重要性』这类空话」 |")
    L.append(f"| 专名被拆分 | {sum(len(q['splitNames']) for q in qs)} 处 | "
             f"「专有名词要原样照抄，不要在词中间插入顿号、空格」 |")
    L.append('')
    L.append(f"> 统计范围：{n} 条有摘要输出的用例（负样本与调用失败的不计）。"
             f"锚点 {num_total + lat_total} 个（数字 {num_total} · 专名 {lat_total}），"
             f"输出侧数字 {out_num_total} 个。")
    L.append('')
    L.append('> ⚠️ **数字召回率是一个偏保守的下限值，别读成「只有一半信息被装进去」。**')
    L.append('> 它低估的原因是结构性的：模型把 N 条内容都写出来了但没写「N 个」、')
    L.append('> 把「1.2 万」写成「12000」这类改写，都会记成「没覆盖」。')
    L.append('> 所以它的正确定位是**横向比较**（哪一条明显偏低就该去看那张卡片），')
    L.append('> 而不是一个可以对外宣称的绝对分数。')
    L.append('')

    L.append('### 五个必须说清的盲区')
    L.append('')
    L.append('1. **数字召回率高 ≠ 写得好。** 它是**下限**检查：低了一定漏了内容；')
    L.append('   高只说明「数字抄进去了」，不说明讲对了 —— 把意思说反、把 A 的结论安到 B 头上，')
    L.append('   锚点照样全部命中。**语义层面的忠实度本报告不负责。**')
    L.append('2. **只看阿拉伯数字。** 中文数字（「七个阶段」的「七」）不在统计内，')
    L.append('   所以分母偏小、召回率会**偏高**一点。')
    L.append('3. **专名覆盖系统性偏低，只能当参考。** 模型把 `Microsoft` 写成「微软」、')
    L.append('   `Agent` 写成「智能体」都是对的，但在这里会被记成「没覆盖」。')
    L.append('   方向是保守的（低估），所以它适合用来**横向比较**，不适合当绝对分数。')
    L.append('4. **「无锚点」不等于「空泛」。** 一条要点里没有数字、没有拉丁词、也没有引号术语，')
    L.append('   只说明**读者没法快速核查它**，不代表它没内容 ——')
    L.append('   例如「支持为全年节假日和调休工作日设定闹钟」就很具体。')
    L.append('   真正的「空话」看上面那一行词表命中。')
    L.append('5. **装饰只过滤了认得出的那些，残留仍会让召回率偏低。**')
    L.append('   用户名（`PiKaChu345`）、代码示例里的英文标识这类没有稳定形态，没能过滤掉。')
    L.append('   它们留在分母里 ⇒ 召回率**被低估**。方向和第 2 条相反，两条叠在一起')
    L.append('   说明这个数**只能横向比、不能当绝对分**。')
    L.append('')
    L.append('> 分母已经剔掉页面装饰（等级徽标 `Lv.17` / 发布日期 / 邮箱 / 域名）——')
    L.append('> 那些**摘要本来就不该写**，留在分母里会把召回率灌水灌到不可读')
    L.append('> （实测：不过滤时 31.4%，且「原文没有可漏数字」的用例会被算成 0 分）。')
    L.append('> 幻觉判据用的是**未过滤**的完整原文：模型写了发布日期不算编造。')
    L.append('')

    # —— 分组：形态 ——
    L.append('## 按输入形态分组（这是最该看的一张表）')
    L.append('')
    L.append('形态由**生产代码的 `detectShape`** 决定（本脚本 import 它，没有在 Python 里抄一份正则）。')
    L.append('两种形态的目标完全不同，混在一起算没有意义：')
    L.append('')
    L.append('- **单一主题**：内容是「一件事分了 N 个条目」→ 条数应**跟着条目数走，一项不漏**，'
             '所以「要点数 < 原文编号项」就是要查的漏条目')
    L.append('- **聚合类**：一份文档装了多条彼此无关的内容 → 按主题归纳，'
             '**要点数少于原文条目数才是对的**（接近 1 反而说明没归纳）—— '
             '所以这一列对聚合类不能按「漏」读，它的专项检查在报告末尾')
    L.append('')
    L.append('| 形态 | 条数 | 数字召回率 | 专名覆盖 | 漏条目 / 归纳 | 无锚点要点 |')
    L.append('|---|---|---|---|---|---|')
    for shape, label in (('single', '单一主题'), ('aggregate', '聚合类')):
        sub = [q for q in qs if q['shape'] == shape]
        if not sub:
            continue
        nt = sum(q['inNums'] for q in sub)
        nh = sum(q['hitNums'] for q in sub)
        lt = sum(q['inLatin'] for q in sub)
        lh = sum(q['hitLatin'] for q in sub)
        # 用「计数」而不是「比值」：求和算比值会被个别用例
        # （原文只有 1 个编号项、卡片写了 19 条）带偏，得出 1.88 这种读不出意思的数。
        with_items = [q for q in sub if q['nItems'] >= 3]
        if shape == 'single':
            short = [q for q in with_items if q['nPoints'] < q['nItems']]
            drop = f"{len(short)} / {len(with_items)}" if with_items else '—'
        else:
            # 聚合类：少于原条目数才叫归纳成功，给「有没有归纳」而不是「漏没漏」
            collapsed = [q for q in with_items if q['nPoints'] < q['nItems']]
            drop = f"已归纳 {len(collapsed)}/{len(with_items)}" if with_items else '—'
        L.append(f"| {label} | {len(sub)} | {fmt_rate(rate(nh, nt))} | {fmt_rate(rate(lh, lt))} | {drop} | "
                 f"{fmt_rate(rate(sum(q['nVague'] for q in sub), sum(q['nPoints'] for q in sub)))} |")
    L.append('')
    L.append('> 「要点数 < 原文编号项」是**漏条目**最直接的形态（原文列了 11 项却只写 8 条）。')
    L.append('> 这里只统计原文有明显编号项（≥3）的用例 —— 观点 / 叙事类没有天然条目数，')
    L.append('> 拿它去比会得出「漏了一半」这种假结论。')
    L.append('')

    # —— 逐条 ——
    L.append('## 逐条明细')
    L.append('')
    L.append('| 用例 | 形态 | 原文数字 | 数字召回 | 专名覆盖 | 要点 | 原文编号项 | 回收比 | 幻觉数字 | 无锚点 | 压缩比 |')
    L.append('|---|---|---|---|---|---|---|---|---|---|---|')
    for r in sorted(rows, key=lambda x: (x['_q']['shape'], x['id'])):
        q = r['_q']
        rec = '—' if not q['inNums'] else f"{q['hitNums'] / q['inNums'] * 100:.0f}%"
        lat = '—' if not q['inLatin'] else f"{q['hitLatin'] / q['inLatin'] * 100:.0f}%"
        if q['nItems'] < 3:
            ratio = '—'  # 没有明显编号项就不算比值，免得得出「漏了一半」的假结论
        else:
            mark = '⚠️ ' if q['nPoints'] < q['nItems'] else ''
            ratio = f"{mark}{q['nPoints']}/{q['nItems']}"
        inv = f"⚠️ {len(q['inventedNums'])}" if q['inventedNums'] else '0'
        comp = f"{q['inChars'] / q['outChars']:.1f}×" if q['outChars'] else '—'
        L.append(
            f"| `{r['id']}` | {'单一' if q['shape'] == 'single' else '**聚合**'} | {q['inNums']} | {rec} | "
            f"{lat} | {q['nPoints']} | {q['nItems']} | {ratio} | {inv} | {q['nVague']} | {comp} |"
        )
    L.append('')
    L.append('> 「回收比」列只对「原文有明显编号项（≥3）」的用例给出；⚠️ 表示**要点数少于编号项数**。')
    L.append('')

    # —— 候选清单：给人工复核 ——
    L.append('## 给人工复核的候选（不是结论，是「去看一眼这些」）')
    L.append('')
    L.append('机械指标只能指路。下面这些是**最可能有问题的具体位置**，')
    L.append('每条都在 30 秒内能判断「是模型漏了/编了，还是我的指标误报」。')
    L.append('')

    miss_rows = sorted(rows, key=lambda x: -(len(x['_q']['missedNums']) + len(x['_q']['missedLatin'])))[:8]
    L.append('### 1. 原文有、卡片里没找到的锚点（可能漏了，也可能只是换了说法）')
    L.append('')
    for r in miss_rows:
        q = r['_q']
        miss = q['missedNums'][:5] + q['missedLatin'][:5]
        if not miss:
            continue
        L.append(f"- **`{r['id']}`**：{('、'.join(f'`{m}`' for m in miss))}")
    L.append('')

    inv_rows = [r for r in rows if r['_q']['inventedNums']]
    L.append('### 2. 卡片里有、原文里没找到的数字（可能编了，也可能是换算或计数）')
    L.append('')
    if inv_rows:
        for r in inv_rows:
            q = r['_q']
            L.append(f"- **`{r['id']}`**：{('、'.join(f'`{m}`' for m in q['inventedNums'][:8]))}")
            L.append(f"  - 摘要：{q['summary'][:100]}")
    else:
        L.append('- （没有）')
    L.append('')

    vague_rows = sorted(rows, key=lambda x: -x['_q']['nVague'])[:5]
    L.append('### 3. 不含任何具体锚点的要点（可能空泛）')
    L.append('')
    any_vague = False
    for r in vague_rows:
        for s in r['_q']['vagueSamples']:
            any_vague = True
            L.append(f"- **`{r['id']}`**：{s[:90]}")
    if not any_vague:
        L.append('- （没有）')
    L.append('')

    fill_rows = [r for r in rows if r['_q']['fillers']]
    L.append('### 4. 命中空话词表的措辞')
    L.append('')
    if fill_rows:
        for r in fill_rows:
            words = '、'.join(f"`{w}`×{c}" for w, c in r['_q']['fillers'])
            L.append(f"- **`{r['id']}`**：{words}")
    else:
        L.append('- （没有）')
    L.append('')

    # —— 聚合类的专项 ——
    agg = [r for r in rows if r['_q']['shape'] == 'aggregate']
    if agg:
        L.append('## 聚合类的专项检查')
        L.append('')
        L.append('prompt 对聚合类有额外要求：**按主题归纳（条数远少于条目数）**、'
                 '**在 summary 里说明原文一共收录了多少条**。')
        L.append('')
        L.append('后一条要求模型**自己数** —— 而「数量不该交给模型统计」是这个项目一以贯之的原则')
        L.append('（画像与批量的占比都拿回代码算了）。所以这里不只查「写没写」，')
        L.append('还把**模型自报的数**和**代码数出来的编号项数**并排放，供人对照：')
        L.append('')
        L.append('| 用例 | 原文编号项 | 要点数 | 归纳是否生效 | 收录数写在 summary？ | 模型自报 | 对得上吗 |')
        L.append('|---|---|---|---|---|---|---|')
        for r in agg:
            q = r['_q']
            collapsed = '✅ 归纳了' if q['nItems'] and q['nPoints'] < q['nItems'] else '⚠️ 没归纳'
            if q['countInSummary']:
                where = '✅ 有'
            elif q['countClaims']:
                where = '⚠️ **写在了要点里**（prompt 要求写 summary）'
            else:
                where = '⚠️ 没写'
            claimed = '、'.join(str(v) for v in q['countClaims']) or '—'
            if not q['countClaims'] or not q['nItems']:
                match = '—'
            elif any(abs(v - q['nItems']) <= 2 for v in q['countClaims']):
                match = '✅ 接近'
            else:
                match = f"⚠️ 与代码口径差 {min(abs(v - q['nItems']) for v in q['countClaims'])}"
            L.append(f"| `{r['id']}` | {q['nItems']} | {q['nPoints']} | {collapsed} | {where} | "
                     f"{claimed} | {match} |")
        L.append('')
        L.append('> ⚠️ **「对得上吗」不是判错。** 代码数的是「行首编号项」，')
        L.append('> 而周刊这类内容每换一节就重新从 1 开始编号，人工口径可能是「收录了多少篇」而不是「多少行」，')
        L.append('> 两者本来就不是同一个数。')
        L.append('> 这一列的作用是**把差异摆出来让人看一眼** —— 尤其是模型自报的数，')
        L.append('> 它没有任何原文依据（原文没写总数），是模型自己数出来的，')
        L.append('> **数错了用户也看不出来**，这正是它值得单列的原因。')
        L.append('')

    L.append('## 与 `report.md` 的分工')
    L.append('')
    L.append('| | `report.md` | 本报告 |')
    L.append('|---|---|---|')
    L.append('| 回答 | 分类对不对、该拦的拦住了吗 | 摘要与要点质量如何 |')
    L.append('| 口径 | 与金标准比对（分类 / ok 判定）| 与原文比对（锚点覆盖 / 幻觉）|')
    L.append('| 金标准 | 需要（人工裁决）| **不需要** —— 原文本身就是标尺 |')
    L.append('| 调模型 | 要（改了判据要重跑）| **不要**（纯计算）|')
    L.append('')

    return '\n'.join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--report', default=os.path.join(EVAL, 'quality.md'))
    ap.add_argument('--show', type=int, default=0, help='控制台额外打印前 N 条明细')
    args = ap.parse_args()

    dataset, results = score.load()
    shapes = load_shapes()
    rows = compute(dataset, results, shapes)

    if not rows:
        raise SystemExit('❌ 没有可评的用例（可能 results.json 里没有成功输出）')

    text = report(rows, results.get('meta', {}))
    with io.open(args.report, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text + '\n')

    qs = [r['_q'] for r in rows]
    nt = sum(q['inNums'] for q in qs)
    nh = sum(q['hitNums'] for q in qs)
    lt = sum(q['inLatin'] for q in qs)
    lh = sum(q['hitLatin'] for q in qs)
    on = sum(q['outNums'] for q in qs)
    iv = sum(len(q['inventedNums']) for q in qs)
    pt = sum(q['nPoints'] for q in qs)
    vg = sum(q['nVague'] for q in qs)

    print('摘要质量')
    print('─' * 58)
    print(f'  数字召回率      {fmt_rate(rate(nh, nt))}  ({nh}/{nt})')
    print(f'  数字幻觉率      {fmt_rate(rate(iv, on))}  ({iv}/{on})')
    print(f'  专名覆盖（参考）{fmt_rate(rate(lh, lt))}  ({lh}/{lt})')
    print(f'  无锚点要点占比  {fmt_rate(rate(vg, pt))}  ({vg}/{pt})')
    print(f'  评了 {len(rows)} 条')
    print()

    if args.show:
        print('前几条明细')
        print('─' * 58)
        for r in rows[:args.show]:
            q = r['_q']
            rec = '—' if not q['inNums'] else f"{q['hitNums']}/{q['inNums']}"
            print(f"  {r['id']:18s} {q['shape']:10s} 数字召回 {rec:8s} "
                  f"幻觉 {len(q['inventedNums'])}  要点 {q['nPoints']:2d}  "
                  f"原文条目 {q['nItems']}")
        print()

    print(f'报告已写入 {os.path.relpath(args.report, ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
