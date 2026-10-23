// 验证 8：桌面端的画像与行动清单。
//
// 用 eval/results.json 里的真实摘要构造 8 条归档（demo 只有 4 条，不够画像的门槛 5），
// 然后依次走 BUILD_PROFILE → GET_PROFILE → BUILD_ACTIONS → GET_ACTIONS。
//
// 跑法：npx electron verify-profile.js
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
app.setPath('userData', 'C:/Users/Mapleooo/.workbuddy/tmp/wm-desktop-profile');

// 没有主窗口，只有模型调用；防止「所有窗口关闭就退出」
app.on('window-all-closed', () => {});

const { handleMessage } = require('./handlers.js');
const storeFile = require('./store-file.js');

const results = [];
const push = (label, pass, got) => {
  results.push({ label, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${got ? `\n       got = ${got}` : ''}`);
};

app.whenReady().then(async () => {
  try {
    await storeFile.clearArchive();

    // ---- 构造 8 条真实归档（只取标题/分类/摘要，画像不需要全文）----
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'results.json'), 'utf8'));
    const picked = [];

    for (const row of raw.rows) {
      const run = row.runs.find((r) => r.ok && r.got?.ok === true);
      if (!run) continue;
      picked.push({
        url: row.url,
        title: row.title,
        category: run.got.category,
        summary: run.got.summary,
        points: run.got.points,
        text: '',
        digestedAt: Date.now() - picked.length * 60_000,
      });
      if (picked.length >= 8) break;
    }

    const imported = await storeFile.importDigests(picked);
    push('构造并导入 8 条归档', imported.added === 8, JSON.stringify(imported));

    // ---- 画像 ----
    console.log('\n[1/2] 生成画像…');
    const profile = await handleMessage({ type: 'BUILD_PROFILE' });

    push('BUILD_PROFILE 成功', profile?.ok === true, JSON.stringify({ ok: profile?.ok, error: profile?.error }));
    push('关注方向 ≥ 2 条', Array.isArray(profile?.themes) && profile.themes.length >= 2, String(profile?.themes?.length || 0));
    push('阶段是枚举值', ['入门', '进阶', '实战', '说不准'].includes(profile?.level), String(profile?.level));
    push('分类分布由代码统计', !!profile?.byCategory && Object.keys(profile.byCategory).length >= 2, JSON.stringify(profile?.byCategory));

    const gotProfile = await handleMessage({ type: 'GET_PROFILE' });
    push('GET_PROFILE 读回同一份', gotProfile?.profile?.builtAt === profile?.builtAt, JSON.stringify({ has: !!gotProfile?.profile }));

    // ---- 行动清单 ----
    console.log('\n[2/2] 生成行动清单（应复用刚算的画像）…');
    const actions = await handleMessage({ type: 'BUILD_ACTIONS' });

    push('BUILD_ACTIONS 成功', actions?.ok === true, JSON.stringify({ ok: actions?.ok, error: actions?.error }));
    push('动作 ≥ 2 条', Array.isArray(actions?.actions) && actions.actions.length >= 2, String(actions?.actions?.length || 0));
    push('复用了已有画像', actions?.profileStep === 'reused', String(actions?.profileStep));
    push(
      'refs 已投影出标题',
      (actions?.actions || []).some((a) => (a.refs || []).some((r) => r.title)),
      JSON.stringify((actions?.actions?.[0]?.refs || []).slice(0, 1))
    );

    const gotActions = await handleMessage({ type: 'GET_ACTIONS' });
    push('GET_ACTIONS 读回同一份', gotActions?.actionPlan?.builtAt === actions?.builtAt, JSON.stringify({ has: !!gotActions?.actionPlan }));

    await storeFile.clearArchive();
    console.log(`\n${results.filter((r) => r.pass).length}/${results.length} 通过`);
    app.exit(results.every((r) => r.pass) ? 0 : 1);
  } catch (err) {
    console.log(`[verify-profile] FAIL — ${err.stack || err.message}`);
    app.exit(1);
  }
});
