"""用本地模型判「原文是否支持这条摘要」—— 语义层面的忠实度检查。

## 这是什么

`quality.py` 查的是「词有没有抄进去」（数字召回 / 幻觉 / 空话）。
它查不到**意思讲反**和**张冠李戴** —— 把 A 的结论安到 B 头上，锚点照样全部命中。

这个脚本补的就是那一段：让模型读「原文 + 摘要」，判原文是否支持这条摘要。
它比锚点类指标更接近人想要的答案，代价是**慢三个数量级**（每条约 1.4 秒 vs 纯计算）。

## 两种模式

    python eval/faithfulness.py                # 跑真实数据，出 faithfulness.md
    python eval/faithfulness.py --calibrate    # 标定：量这个 judge 本身准不准
    python eval/faithfulness.py --rejudge      # 无视缓存，重新逐条判定

判定结果（**不含原文**）缓存在 `judge-results.json`：改了报告格式重跑是纯计算、秒级；
换了模型 / 提示词 / 数据会自动作废重判。原文按 (用例, 要点) 回 `load_pairs()` 现取 ——
`eval/dataset/texts/` 是别人文章的全文，不入公开仓库。

**必须先跑标定**：默认模式会把标定结果写进报告，没有 `judge-calibration.json`
时报告会明说「未标定」。一个不知道准不准的 judge，和没有 judge 是一样的。

## 标定怎么做的（难点：没有人工金标准）

拿**真实且忠实**的（要点，原文）对，人为改成「意思反了」——
答案由构造方式决定，不需要人工标注：

| 组 | 构造 | 期望 |
|---|---|---|
| 控制组 | 原样 | 支持 → 量**特异度**（会不会冤枉好人）|
| 反转·数字 | 把要点里的数字换成**整篇原文都没有**的数 | 不支持 |
| 反转·反义 | 把方向词反过来（支持→不支持、提高→降低）| 不支持 |
| 错配 | 要点配**另一篇文档**的段落 | 不支持 |

后三组合起来就是**灵敏度**（能不能抓到意思反了）。

## 这个指标看不见什么

- **只能排序，不能当闸门**。特异度 97% 意味着 100 条好要点里它仍会误报约 3 条；
  拿它自动拦截用户的内容，就是每 30 条冤枉一条。
- **判断基于给定的原文片段**，不是整篇。摘要的依据散落在别处时，它会判「不支持」——
  实测残留的误报基本都是这一种，所以**真实特异度比测出来的更高**（=测出来的是下界）。
- **数字是标定集上的**。标定集是「措辞重合 ≥0.5」的对，也就是模型写得比较老实的那一批；
  换成大量改写、跨段归纳的输出，灵敏度会掉。

跑之前需要 Ollama 在跑、且本地有 `qwen3:8b`（标定用的就是它）。
"""

import sys, io, os, re, json, time, random, hashlib, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import quality as Q

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVAL = os.path.dirname(os.path.abspath(__file__))
OLLAMA = 'http://127.0.0.1:11434/api/chat'
CALIB = os.path.join(EVAL, 'judge-calibration.json')

JUDGE_MODEL = 'qwen3:8b'

JUDGE_SYS = (
    '你是一个严格的核查员。给定「原文」和「摘要」，判断**原文是否支持摘要这条说法**。\n'
    '规则：\n'
    '1. 只根据原文判断，不要用你自己知道的任何知识补充。\n'
    '2. 摘要里的关键信息（数字、方向、主体、有无）只要与原文冲突，或原文里没有依据，'
    '就判 supported=false。\n'
    '3. 意思相同但换了说法，算支持。\n'
    '4. 摘要比原文更笼统（概括），只要不冲突，也算支持。\n'
    '只输出 JSON。'
)

SCHEMA = {
    'type': 'object',
    'properties': {'supported': {'type': 'boolean'}, 'reason': {'type': 'string'}},
    'required': ['supported', 'reason'],
}


# ---------------------------------------------------------------------------
# 调用
# ---------------------------------------------------------------------------

def judge_once(src, point, model=JUDGE_MODEL, timeout=180):
    body = {
        'model': model, 'stream': False, 'format': SCHEMA,
        'messages': [
            {'role': 'system', 'content': JUDGE_SYS},
            {'role': 'user', 'content': f'原文：{src}\n\n摘要：{point}'},
        ],
        'options': {'temperature': 0},
        # ★ keep_alive 必须显式给：整轮要调两百多次，默认 5 分钟到点就卸载，
        # 然后每次重新加载 —— 实测这会把 8B 的 runner 拖崩（成片的 HTTP 503 /
        # 连接被重置，221 条里挂了 108 条）。**这里省掉的是一行，赔上的是半轮跑分。**
        'keep_alive': '30m',
    }
    if model.startswith('qwen3'):
        body['think'] = False
    req = urllib.request.Request(
        OLLAMA, data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json'})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    ms = int((time.time() - t0) * 1000)
    content = data.get('message', {}).get('content', '')
    try:
        p = json.loads(content)
        return bool(p.get('supported')), str(p.get('reason', ''))[:120], ms
    except Exception:
        return None, content[:120], ms


def judge(src, point, model=JUDGE_MODEL, retries=4):
    """带重试 —— 长跑中 Ollama 偶发 503 / 连接重置，一次失败不该毁掉整轮跑分。

    退避给到 2/4/8/16 秒：runner 崩了要几秒才拉起来，立刻重试只会连撞。
    """
    last = None
    for i in range(retries + 1):
        try:
            return judge_once(src, point, model)
        except Exception as e:
            last = e
            time.sleep(2 ** (i + 1))
    return None, f'调用失败：{type(last).__name__}', 0


# ---------------------------------------------------------------------------
# 取材：要点 + 它在原文里溯源到的段落（扩展为「段落+前后各一段」）
# ---------------------------------------------------------------------------

def doc_units(text):
    units = []
    for para in re.split(r'\n+', Q.strip_chrome(text)):
        sents = [s.strip() for s in re.split(r'(?<=[。！？；!?;])', para)
                 if len(Q._clean_for_match(s)) >= 8]
        if sents:
            units.append((para.strip(), sents))
    return units


def load_pairs(min_score=0.5):
    """(要点, 所在段落, 扩展上下文, 文档全文, 溯源分)。

    min_score：只用溯源重合度够高的对。低重合的多半是归纳改写，
    拿它们当「应当支持」的控制组会让特异度被低估（模型没错，是样本不够明确）。
    """
    rows = json.load(io.open(os.path.join(EVAL, 'results.json'), encoding='utf-8'))['rows']
    cases = {c['id']: c for c in json.load(io.open(
        os.path.join(EVAL, 'dataset', 'cases.json'), encoding='utf-8'))['cases']}
    pairs = []
    for row in rows:
        c = cases.get(row['id'])
        if not c or not c.get('expect', {}).get('ok', True):
            continue
        got = next((r['got'] for r in row['runs'] if r.get('got') and r['got'].get('ok')), None)
        if not got:
            continue
        text = io.open(os.path.join(EVAL, 'dataset', c['text']), encoding='utf-8').read()
        sents = Q.split_source_sentences(text)
        units = doc_units(text)
        owner = [u[0] for u in units for _ in u[1]]
        if len(owner) != len(sents):
            continue
        pts = got.get('points') or []
        for p, (sc, s) in zip(pts, Q.traceability(pts, sents)):
            if sc < min_score or not s or s not in sents:
                continue
            i = sents.index(s)
            pi = next((k for k, (pa, _) in enumerate(units) if pa == owner[i]), 0)
            # 扩展上下文：所在段落 + 前后各一段，截到 1800 字。
            # 不直接用整篇：本机 Ollama 默认上下文 4096 token，有的快照 6000+ 字，
            # 塞整篇会**静默截断** —— 那就变成了另一个实验，而且没人看得出来。
            wide = '\n'.join(u[0] for u in units[max(0, pi - 1): pi + 2])
            pairs.append({'case': row['id'], 'point': p, 'para': owner[i],
                          'ctx': wide[:1800], 'doc': text, 'score': sc})
    return pairs


def _latin_in(tok, hay):
    """拉丁专名在 hay 里**作为独立单词**出现过吗。

    不能用 `in`：`'go' in 'Google'` 是 True。而这条判据是用来**清掉**可疑条目的 ——
    误报等于**错误放行**，代价比漏报高。（`quality.py` 的专名覆盖侧还留着这个洞，
    记在 `quality.md` 盲区第 6 条；这里不重蹈。）

    ⚠️ 用 `norm()` 而不是 `tight()` 当底 —— tight 会把空格抹掉
    （`Xbox Accessories` → `XboxAccessories`），词边界就没了。
    """
    return bool(re.search(r'(?<![A-Za-z0-9])' + re.escape(tok) + r'(?![A-Za-z0-9])',
                          hay, re.I))


def locate_anchors(point, ctx, doc):
    """这条要点的**可核查锚点**分别出现在哪儿 —— 用来把「判断窗口太窄」和「真没依据」分开。

    judge 只看得到 ctx（所在段落 + 前后各一段），而一条要点常综合全文。
    所以它判「不支持」时有几种截然不同的原因，**证据强度也不同**：

      | 锚点去处 | 说明 |
      |---|---|
      | 数字在别处 | **强**：具体值在原文别处出现 → 基本可以确定是窗口问题 |
      | 只有专名在别处 | **弱**：`AI` 这类通用词在原文到处都是，不足以给这条要点背书 |
      | 全篇都查不到 | 可能是真幻觉，也可能是 judge 读错了原文（实测有这种）→ **重点看** |
      | 一个锚点都没有 | 纯中文论断，机器判不了 → 对着原句看 |

    返回 dict：{'else_num': [...], 'else_lat': [...], 'miss_num': [...], 'miss_lat': [...]}
    """
    ctx_t, doc_t = Q.tight(ctx), Q.tight(doc)
    ctx_n, doc_n = Q.norm(ctx), Q.norm(doc)
    r = {'else_num': [], 'else_lat': [], 'miss_num': [], 'miss_lat': []}
    for core, raw in Q.extract_numbers(point, with_decimals=True).items():
        if Q._num_covered(core, ctx_t):
            continue
        (r['else_num'] if Q._num_covered(core, doc_t) else r['miss_num']).append(raw)
    for w in Q.extract_latin(point):
        if _latin_in(w, ctx_n):
            continue
        (r['else_lat'] if _latin_in(w, doc_n) else r['miss_lat']).append(w)
    return r


# ---------------------------------------------------------------------------
# 标定：构造已知答案的样本，量 judge 自己
# ---------------------------------------------------------------------------

ANTONYMS = [
    ('不支持', '支持'), ('不适合', '适合'), ('不推荐', '推荐'),
    ('不需要', '需要'), ('不可以', '可以'),
    ('高于', '低于'), ('大于', '小于'), ('超过', '低于'), ('优于', '劣于'),
    ('增加', '减少'), ('提升', '下降'), ('提高', '降低'), ('上升', '下降'),
    ('最大', '最小'), ('最多', '最少'), ('最高', '最低'), ('最快', '最慢'),
]


def mut_num(point, doc_tight):
    """把要点里的一个数字换成**整篇原文都没有**的数 —— 单位留着，读起来自然，但一定无依据。

    ⚠️ 两个必查：
      ① 新数不能已经出现在要点里（否则改出来是「30秒、10分钟、10分钟、30分钟」
         这种重复，**不构成矛盾**，只是漏了一项 —— 拿它测灵敏度是白扣分）。
      ② 新数不能在整篇原文里出现（否则它其实有依据，答案就不确定了）。
    """
    nums = Q.extract_numbers(point)
    for raw in nums.values():
        m = re.match(r'^(\d+(?:\.\d+)?)\s*(.*)$', raw)
        if not m:
            continue
        old, unit = m.group(1), m.group(2)
        for k in (3, 7, 11, 5, 2):
            new = str(int(float(old) * k + 7)) if '.' not in old else f'{float(old) * k + 7:.1f}'
            if new == old or re.search(r'(?<![\d.])' + re.escape(new) + r'(?![\d])', point):
                continue
            if re.search(r'(?<![\d.])' + re.escape(new) + r'(?![\d])', doc_tight):
                continue
            return point.replace(raw, f'{new}{unit}', 1)
    return None


def mut_ant(point):
    """把方向词反过来。列表里**不收单字** —— 实测「能↔不能」会把「技能」改成「技不能」。"""
    for a, b in ANTONYMS:
        out = None
        if a in point:
            out = point.replace(a, b, 1)
        elif b in point:
            out = point.replace(b, a, 1)
        if not out or '不不' in out or out == point:
            continue
        return out
    return None


def build_samples(pairs):
    ctrl, m_num, m_ant, mism = [], [], [], []
    for pr in pairs:
        ctrl.append(dict(pr, group='控制组', expect=True))
        if len(m_num) < 80:
            r = mut_num(pr['point'], Q.tight(pr['ctx']))
            if r:
                m_num.append(dict(pr, point=r, group='反转·数字', expect=False))
        if len(m_ant) < 80:
            r = mut_ant(pr['point'])
            if r:
                m_ant.append(dict(pr, point=r, group='反转·反义', expect=False))
    by_case = {}
    for pr in pairs:
        by_case.setdefault(pr['case'], []).append(pr)
    ids = sorted(by_case)
    for pr in pairs:
        if len(mism) >= 80:
            break
        other = random.choice([i for i in ids if i != pr['case']])
        mism.append(dict(pr, ctx=random.choice(by_case[other])['ctx'],
                         group='错配', expect=False))
    return ctrl + m_num + m_ant + mism


def calibrate(model=JUDGE_MODEL):
    random.seed(20260930)
    pairs = load_pairs()
    if not pairs:
        print('❌ 没有可用的（要点，原文）对 —— 先跑 node eval/run.mjs 生成 results.json')
        return 1
    samples = build_samples(pairs)
    groups = {}
    for s in samples:
        groups.setdefault(s['group'], []).append(s)

    print(f'标定 judge：{model}')
    print(f'  取材 {len(pairs)} 对（溯源重合 ≥0.5）→ 样本 {len(samples)} 条')
    for g, ss in groups.items():
        print(f'    {g:12s} {len(ss):3d} 条')

    detail, res = [], {}
    for g, ss in groups.items():
        hits, total, lat, failed = 0, 0, [], 0
        for s in ss:
            got, why, ms = judge(s['ctx'], s['point'], model)
            lat.append(ms)
            if got is None:
                failed += 1
                continue
            total += 1
            if got == s['expect']:
                hits += 1
            else:
                detail.append({'group': g, 'expect': s['expect'], 'got': got,
                               'point': s['point'], 'src': s['ctx'][:400],
                               'why': why, 'case': s['case']})
        res[g] = {'hit': hits, 'total': total, 'avgSec': round(sum(lat) / len(lat) / 1000, 2) if lat else 0}
        print(f'    → 判对 {hits}/{total}  ' + (f'⚠️ {failed} 条失败' if failed else ''))

    spec = res.get('控制组', {'hit': 0, 'total': 0})
    inj = [v for k, v in res.items() if k != '控制组']
    ih, it = sum(v['hit'] for v in inj), sum(v['total'] for v in inj)
    out = {
        'model': model,
        'calibratedOn': time.strftime('%Y-%m-%d'),
        'samplePairs': len(pairs),
        'groups': res,
        'specificity': round(spec['hit'] / spec['total'], 4) if spec['total'] else None,
        'sensitivity': round(ih / it, 4) if it else None,
        'note': ('特异度是**下界**：判断只依据「所在段落 + 前后各一段」，'
                 '摘要依据散落在别处时会判不支持，实测残留误报基本都是这种。'),
        'detail': detail,
    }
    io.open(CALIB, 'w', encoding='utf-8').write(json.dumps(out, ensure_ascii=False, indent=2))

    print(f'\n  特异度（不冤枉好人）  {out["specificity"] * 100:.1f}%')
    print(f'  灵敏度（抓到意思反了）{out["sensitivity"] * 100:.1f}%')
    print(f'\n已写入 {os.path.relpath(CALIB, ROOT)}')
    print(f'判错的 {len(detail)} 条明细也在里面 —— **换提示词或换模型之后要重跑，'
          f'别拿旧数字配新实现。**')
    return 0


# ---------------------------------------------------------------------------
# 逐条判定（带缓存）
#
# 判定要调模型（几百条约几分钟），出报告是纯计算。拆开之后**改报告格式不用重跑模型**，
# 和 `results.json` → `score.py`、`quality.py` 的分工一致。
# ---------------------------------------------------------------------------

JUDGE_CACHE = os.path.join(EVAL, 'judge-results.json')
# 人工复核的判定。**这不是指标、也不可复算** —— 它是「证据」，
# 和 `cases.json` 里的金标准同类。所以单独存一个文件，脚本只负责渲染。
REVIEW = os.path.join(EVAL, 'review.json')


def _stamp():
    """缓存的有效性标识：换了模型 / 换了提示词 / 换了数据，缓存就作废。

    ⚠️ **不存原文。** `eval/dataset/texts/` 是别人文章的全文，按约定不入公开仓库；
    报告要原文时按 (用例, 要点) 回 `load_pairs()` 里现取。
    """
    try:
        pv = json.load(io.open(os.path.join(ROOT, 'shared', 'prompt.json'),
                               encoding='utf-8')).get('version', '')
    except Exception:
        pv = ''
    return {
        'model': JUDGE_MODEL,
        'promptVersion': pv,
        'judgeSys': hashlib.sha1(JUDGE_SYS.encode('utf-8')).hexdigest()[:12],
    }


def judge_all(pairs, force=False):
    """逐条判定，结果落盘。有可用缓存就直接用，除非 force。"""
    stamp = _stamp()
    # 光看条数不够：`results.json` 重跑后条数可能相同而内容全变，
    # 那样缓存会被**错误复用**，报告看起来完全正常但写的是上一批数据的结论。
    stamp['pointsHash'] = hashlib.sha1(
        '||'.join(pr['point'] for pr in pairs).encode('utf-8')).hexdigest()[:12]
    if not force and os.path.exists(JUDGE_CACHE):
        try:
            c = json.load(io.open(JUDGE_CACHE, encoding='utf-8'))
            if (all(c.get(k) == v for k, v in stamp.items())
                    and len(c.get('verdicts', [])) == len(pairs)):
                print(f'  用缓存（判定于 {c.get("judgedOn")}）—— 要重判加 --rejudge')
                return c['verdicts'], c
            print('  缓存与当前模型 / 提示词 / 数据不一致 → 重新判定')
        except Exception:
            print('  缓存损坏 → 重新判定')

    judge('热身', '热身', JUDGE_MODEL, retries=0)   # 先热一次，别让加载时间混进统计
    verdicts = []
    for i, pr in enumerate(pairs, 1):
        got, why, ms = judge(pr['ctx'], pr['point'])
        verdicts.append({'case': pr['case'], 'point': pr['point'],
                         'supported': got, 'why': why, 'ms': ms})
        if i % 20 == 0:
            bad = sum(1 for v in verdicts if v['supported'] is False)
            bad_f = sum(1 for v in verdicts if v['supported'] is None)
            print(f'    …已判 {i}/{len(pairs)}（判「不支持」{bad}，失败 {bad_f}）')

    c = dict(stamp, judgedOn=time.strftime('%Y-%m-%d %H:%M'), verdicts=verdicts)
    io.open(JUDGE_CACHE, 'w', encoding='utf-8').write(
        json.dumps(c, ensure_ascii=False, indent=1))
    return verdicts, c


# ---------------------------------------------------------------------------
# 默认模式：跑真实数据，出复核清单
# ---------------------------------------------------------------------------

def run(force=False):
    calib = None
    if os.path.exists(CALIB):
        calib = json.load(io.open(CALIB, encoding='utf-8'))
    review = None
    if os.path.exists(REVIEW):
        review = json.load(io.open(REVIEW, encoding='utf-8'))
        review = {(r['case'], r['point']): r for r in review['verdicts']}

    # ⚠️ 这里**不设 min_score** —— 要判全部要点。
    # 标定那边限制在 ≥0.5（控制组需要「明确被支持」的样本），
    # 但核查这边如果沿用同一个阈值，就会**恰好把最可疑的低溯源分要点全排除掉** ——
    # 而它们正是最该被 judge 看的那一批。
    pairs = load_pairs(min_score=0.0)
    if not pairs:
        print('❌ 没有可用的（要点，原文）对 —— 先跑 node eval/run.mjs')
        return 1

    print(f'忠实度核查（{JUDGE_MODEL}）')
    print('─' * 58)
    print(f'  待判 {len(pairs)} 条要点')

    verdicts, cache = judge_all(pairs, force)

    # 按 (用例, 要点) 把判定贴回取材结果，取回 ctx / doc / 溯源分
    pool = {}
    for v in verdicts:
        pool.setdefault((v['case'], v['point']), []).append(v)

    flagged, lat, failed = [], [], []
    for pr in pairs:
        lst = pool.get((pr['case'], pr['point']))
        v = lst.pop(0) if lst else None
        if not v or v['supported'] is None:
            # ⚠️ 失败的调用**不能计进耗时平均** —— 它返回 0ms，会把平均值拉低，
            # 让整轮看起来比实际快得多（实测第一版把 5.2 秒/条报成了 0.8 秒）。
            failed.append(dict(pr, why=(v or {}).get('why', '缓存里没有这一条')))
            continue
        lat.append(v['ms'])
        if not v['supported']:
            flagged.append(dict(pr, why=v['why']))

    ok = len(lat)
    sec = sum(lat) / ok / 1000 if ok else 0

    L = []
    L.append('# 忠实度核查（模型判「原文是否支持这条摘要」）')
    L.append('')
    L.append(f'模型：`{JUDGE_MODEL}`　判定于 {cache.get("judgedOn", "?")}　要点 {len(pairs)} 条：'
             f'**成功判了 {ok} 条**（平均 {sec:.1f} 秒/条）'
             + (f'，**{len(failed)} 条调用失败**' if failed else '，零失败'))
    L.append('')
    if failed:
        L.append(f'> ⚠️ **有 {len(failed)} 条没能判定**，它们不在下面的统计里 ——')
        L.append('> 所以「判不支持」的条数是**在当前覆盖范围内的**，不是全部。')
        L.append('> 失败基本是 Ollama 侧的 503 / 连接重置（runner 反复换入换出），'
                 '修法已经写进脚本：显式 `keep_alive: 30m` + 退避重试。')
        L.append('')
    if calib:
        L.append(f'**这个 judge 本身的准确率**（标定于 {calib["calibratedOn"]}，'
                 f'{calib["samplePairs"]} 对样本 / {sum(v["total"] for v in calib["groups"].values())} 条）：')
        L.append('')
        L.append('| 方向 | 结果 | 怎么读 |')
        L.append('|---|---|---|')
        L.append(f'| 特异度（不冤枉好人） | **{calib["specificity"] * 100:.1f}%** | '
                 f'忠实要点里被判「不支持」的比例越高越糟 —— **这是误报率** |')
        L.append(f'| 灵敏度（抓到意思反了） | **{calib["sensitivity"] * 100:.1f}%** | '
                 f'人为注入的矛盾里被抓到的比例 |')
        L.append('')
        L.append(f'> {calib["note"]}')
        L.append('')
        per = calib['groups']
        L.append('分项（注入方式不同，难度差很多）：')
        L.append('')
        L.append('| 组 | 判对 | 说明 |')
        L.append('|---|---|---|')
        for g, v in per.items():
            L.append(f'| {g} | {v["hit"]}/{v["total"]} | '
                     + ('原样，应判「支持」' if g == '控制组' else '应判「不支持」') + ' |')
        L.append('')
        L.append('> ⚠️ **这个数必须跟着实现走。** 改了提示词或换了模型就要重跑 '
                 '`--calibrate`，否则报告里写的是另一个 judge 的成绩。')
    else:
        L.append('> ⚠️ **未标定** —— 还没有 `judge-calibration.json`，'
                 '不知道这个 judge 准不准。先跑 `python eval/faithfulness.py --calibrate`。')
    L.append('')

    L.append(f'## 被判「原文不支持」的要点（{len(flagged)} / {ok} 条成功判定的）')
    L.append('')
    bucket = {}
    if not flagged:
        L.append('- （没有）')
    else:
        # 先用「锚点在全篇的哪里」把几种完全不同的原因分开 ——
        # 否则「32 条可疑」这个数字会被当成 32 个问题读。
        # ⚠️ 数字和专名的**证据强度不一样**：数字（具体值）在原文别处出现是硬证据；
        # 而 `AI` 这类通用专名在原文到处都是，根本不足以给一条要点背书 ——
        # 所以两者分成不同的桶，不能混成一句「依据在别处，可跳过」。
        for f in flagged:
            a = locate_anchors(f['point'], f['ctx'], f['doc'])
            f['anchors'] = a
            f['bucket'] = ('全篇也无' if (a['miss_num'] or a['miss_lat'])
                           else '数字在别处' if a['else_num']
                           else '仅专名在别处' if a['else_lat']
                           else '无锚点')
        for f in flagged:
            bucket.setdefault(f['bucket'], []).append(f)

        L.append('judge 只看得到「所在段落 + 前后各一段」，而一条要点常综合全文 ——')
        L.append('所以这 %d 条里混着**几种完全不同**的东西，先用机器判得了的锚点分开：' % len(flagged))
        L.append('')
        L.append('| 分类 | 条数 | 怎么处理 |')
        L.append('|---|---|---|')
        L.append(f'| **数字在原文别处** | {len(bucket.get("数字在别处", []))} | '
                 '**强证据** —— 具体值在别处出现，基本是判断窗口的问题，可以跳过 |')
        L.append(f'| **只有专名在原文别处** | {len(bucket.get("仅专名在别处", []))} | '
                 '**弱证据** —— `AI` 这类通用词在原文到处都是，不足以给一条要点背书 → 去那一处看一眼 |')
        L.append(f'| **全篇都查不到锚点** | {len(bucket.get("全篇也无", []))} | '
                 '真幻觉，或者 judge **读错了原文**（实测两种都有）→ **重点看** |')
        L.append(f'| 无可核查锚点（纯中文论断） | {len(bucket.get("无锚点", []))} | '
                 '机器判不了 → 对着原句看 |')
        L.append('')
        L.append('> ⚠️ **「可以跳过」也不等于没问题。** 它只说明这条要点用到的数字在原文里存在，')
        L.append('> 不说明它的**论断方向**和原文一致 —— 方向对不对机器判不了（那正是 `quality.md` 溯源表管的事）。')
        L.append('')

        # —— 人工复核那一桶（读整篇原文，因为锚点判据在这一桶上帮不上忙）——
        if review:
            rev = [review.get((f['case'], f['point'])) for f in flagged]
            rev = [r for r in rev if r]
            n_bad = sum(1 for r in rev if r['verdict'] == '真问题')
            n_doubt = sum(1 for r in rev if r['verdict'] == '存疑')
            n_ok = sum(1 for r in rev if r['verdict'] == '不是问题')
            machine_real = len(bucket.get('全篇也无', []))
            L.append(f'### 人工复核（无锚点那一桶，已复核 {len(rev)} / {len(bucket.get("无锚点", []))} 条）')
            L.append('')
            L.append('| 复核结论 | 条数 |')
            L.append('|---|---|')
            L.append(f'| 不是问题（judge 误报） | {n_ok} |')
            L.append(f'| **真问题** | **{n_bad}** |')
            L.append(f'| 存疑（超出原文的推断，但与原文不冲突） | {n_doubt} |')
            L.append('')
            L.append('> 复核方式是**读整篇原文** —— judge 只看到「所在段落 + 前后各一段」，')
            L.append('> 而这一桶恰好是「锚点判据帮不上忙」的那一批，只能靠读全篇。')
            L.append('> ⚠️ 这仍然是**第三个意见，不是金标准**；它比 judge 强的地方只有一个：能看到全篇。')
            L.append('> ⚠️ 复核结论按 (用例, 要点) 与 `review.json` 匹配 —— 用例集一变，旧条目大多对不上，')
            L.append('> 所以这里的覆盖是**部分的**：没对上的在表里显示「（未复核）」。')
            L.append('')
            L.append('**把三层合起来看**（这是本报告真正该给出的数字）：')
            L.append('')
            L.append(f'    {len(pairs)} 条要点 → judge 报 {len(flagged)} 条可疑')
            L.append(f'      → 机器清掉 {len(bucket.get("数字在别处", [])) + len(bucket.get("仅专名在别处", []))} 条（锚点在原文别处，是判断窗口的问题）')
            L.append(f'      → 剩 {machine_real + len(rev)} 条：{machine_real} 条机器已核实为真、{len(rev)} 条人工读过')
            L.append(f'      → **最终确认 {machine_real + n_bad} 条为真**，另有 {n_doubt} 条存疑')
            L.append('')
            L.append('#### 确认的问题（逐条附原文依据）')
            L.append('')
            if not any(r['verdict'] in ('真问题', '存疑') for r in rev):
                L.append('- （本次人工复核的条目里没有确认为真问题或存疑的）')
            for r in rev:
                if r['verdict'] in ('真问题', '存疑'):
                    L.append(f"- **`{r['case']}`**（{r['verdict']}）：{r['point']}")
                    L.append(f"  - 依据：{r['evidence']}")
                    L.append(f"  - 判断：{r['note']}")
            L.append('')
            if n_bad:
                L.append(f'> **人工读整篇确认了 {n_bad} 条真问题。** 上一轮（2026-10-01）报出的那条根因是')
                L.append('> **评论区 / 推荐区的内容被当成了正文** ——「用户反馈表明……」（评论区根本没人反馈过）、')
                L.append('> 「作者认为 AI 最大问题不是重复造轮子……」（「重复造轮子」出自**读者评论**）。')
                L.append('> 那不是「编造」，是**把别处的内容记到了本文头上**：每个词都能在原文里找到，')
                L.append('> 锚点判据永远抓不到这一类。')
            else:
                L.append('> 本次人工复核的条目里**没有确认为真问题的**。')
                L.append('> 上一轮（2026-10-01）报出的那条根因是**评论区 / 推荐区的内容被当成了正文** ——')
                L.append('> 它不是「编造」，而是**把别处的内容记到了本文头上**：每个词都能在原文里找到，')
                L.append('> 锚点判据永远抓不到这一类。该根因已从抓取侧裁掉（2026-10-15 / `0.18.0`，见 `AGENTS.md` 第十一节）。')
            L.append('')

        L.append('按溯源重合度升序 —— **低分那端更可能是真问题**。')
        L.append('')
        if review:
            L.append('| 用例 | 溯源分 | 锚点 | 摘要 | 人工复核 | judge 的理由 |')
            L.append('|---|---|---|---|---|---|')
        else:
            L.append('| 用例 | 溯源分 | 锚点 | 摘要 | judge 的理由 |')
            L.append('|---|---|---|---|---|')
        for f in sorted(flagged, key=lambda x: x['score']):
            a = f['anchors']
            if f['bucket'] == '全篇也无':
                mark = '**全篇也无**：' + '、'.join((a['miss_num'] + a['miss_lat'])[:3])
            elif f['bucket'] == '数字在别处':
                mark = '数字在别处：' + '、'.join(a['else_num'][:3])
            elif f['bucket'] == '仅专名在别处':
                mark = '仅专名：' + '、'.join(a['else_lat'][:3])
            else:
                mark = '—'
            rv = review.get((f['case'], f['point'])) if review else None
            if review:
                v = ({'真问题': '**真问题**', '存疑': '存疑'}.get(rv['verdict'], '不是问题')
                     if rv else '（未复核）')
                L.append(f"| `{f['case']}` | {f['score']:.2f} | {mark} | "
                         f"{f['point'][:52]} | {v} | {f['why'][:56]} |")
            else:
                L.append(f"| `{f['case']}` | {f['score']:.2f} | {mark} | "
                         f"{f['point'][:58]} | {f['why'][:70]} |")
        L.append('')
    L.append('## 这个指标看不见什么')
    L.append('')
    L.append('- **只能排序，不能当闸门。** 特异度不是 100%：拿它自动拦截用户的内容，'
             '就会按误报率冤枉一部分正常内容。它的定位是**把人的注意力引到该看的地方**。')
    L.append('- **判断依据是原文片段**（所在段落 + 前后各一段），不是整篇。'
             f'所以上面有 {len(bucket.get("数字在别处", [])) + len(bucket.get("仅专名在别处", []))} 条'
             '被指出的问题，其实是「依据在窗口之外」而非真问题。')
    L.append('- **只判「有没有依据」，不判「写得值不值得读」。** 一条完全忠实但空洞的要点，'
             '在这里也是满分的。')
    L.append(f'- **{len(bucket.get("无锚点", []))} 条纯中文论断机器帮不上忙。** 试过退一步用「4 字词组是否在原文别处出现」来清，'
             '**放弃了**：实测 19 条里能清掉 13 条，但抽查发现误清明显 ——')
    L.append('  例如「流鼻涕是鼻腔的正常反应」被判「别处有（正常反应）」，而**原文写的是「鼻涕要忍住不擦」，'
             '两者真冲突**；还有 `Clippi` 这种名字被切成 `ppi可` 的碎片也算命中。')
    L.append('  按本项目的规矩（**命中里误报 ≥ 真报的检查不该以指标形式存在**），宁可不做。')
    L.append('- ⚠️ **「内容是真的、但记错了出处」这一类，本指标结构上看不见。**')
    L.append('  它的判据是「原文支不支持这条说法」—— 而这类问题的每个词都能在原文里找到，'
             '锚点全中、judge 也会判「支持」。上一轮（2026-10-01）确认的 4 条问题里，**2 条是这一类**：')
    L.append('  「用户反馈表明……」（评论区根本没人反馈过）、「作者认为……重复造轮子……」'
             '（那句出自**读者评论**，作者主张的是另一件事）。')
    L.append('  根因是**评论区与推荐区没被当成页面装饰裁掉**：')
    L.append('  `eval/run.mjs` 把**整份快照**喂给模型，而 `strip_chrome` 只裁了徽标 / 日期 / 邮箱这类零碎。'
             '实测（2026-10-01：21 份快照里 **5 份含「相似内容」推荐区**，最多的一篇占全文 **52.3%**；'
             '这 5 份里 **23.9% 的数字锚**落在推荐区，当轮确认的 4 条问题**全部**出自这 5 份）。')
    L.append('  → 根因**已从抓取侧裁掉**（2026-10-15 / `0.18.0`，见 `AGENTS.md` 第十一节）：'
             '裁的是评论正文与推荐区，不是调 judge 提示词；'
             '顺带也让 `quality.md` 的召回率分母更干净。')
    L.append('')

    out = os.path.join(EVAL, 'faithfulness.md')
    io.open(out, 'w', encoding='utf-8').write('\n'.join(L))
    print(f'\n  判「不支持」的：{len(flagged)} / {ok} 条成功判定' + (f'（另有 {len(failed)} 条未判定）' if failed else ''))
    if bucket:
        for k in ('数字在别处', '仅专名在别处', '全篇也无', '无锚点'):
            if k in bucket:
                print(f'    {k:12s} {len(bucket[k]):3d} 条')
    if review:
        rev = [review.get((f['case'], f['point'])) for f in flagged]
        rev = [r for r in rev if r]
        bad = sum(1 for r in rev if r['verdict'] == '真问题')
        dbt = sum(1 for r in rev if r['verdict'] == '存疑')
        real = len(bucket.get('全篇也无', [])) + bad
        print(f'  人工已复核 {len(rev)} 条：真问题 {bad} / 存疑 {dbt} / '
              f'不是问题 {len(rev) - bad - dbt}')
        print(f'  ★ 最终确认为真：{real} 条（另有 {dbt} 条存疑）')
    print(f'  报告已写入 {os.path.relpath(out, ROOT)}')
    return 0


def main():
    if '--calibrate' in sys.argv:
        model = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--model=')), JUDGE_MODEL)
        return calibrate(model)
    return run(force='--rejudge' in sys.argv)


if __name__ == '__main__':
    sys.exit(main())
