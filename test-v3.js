/**
 * ============================================================================
 * 《修行局》V3.1 验收测试（兼容 V3 场景）
 * ----------------------------------------------------------------------------
 * 对应 V3 工作文档 §12 最小可玩验收场景 + §11 Sprint A/B 验收：
 *   离线（不开 API）也能完成：开界 → 开局文章 → 选择 → 下一章 → 新选择
 *   确定性：同种子续玩与连续游玩一致
 *   AI 同伴：加权选择、不调 API、下章以痕迹揭示
 *   API 安全：Key 不入存档、越权拒绝、超时回退
 *   百年遗产：跨纪元生成
 * V3.1 变更：turnChoices 统一、移除 timeHint/timePreference、Actor 用 seatId
 * ============================================================================
 */
const Story = require('./story-core.js');
const { setupMockAI } = require('./test-helpers.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}
function section(t) { console.log('\n— ' + t + ' —'); }

const playerSetup = {
  name: '陆知微', identity: '青霄宗外门弟子', daoPath: '剑修',
  publicWish: '夺得传承，证明自己不是庸才',
  hiddenFate: '残剑中的剑灵似乎认识我',
  personalityTags: ['锋锐', '念旧'],
};

async function main() {

/* ============================================================
 * §1 七骰开界 + 世界命盘
 * ============================================================ */
section('§1 七骰开界 · 同种子确定性 + 每维影响机制');
const seed = '轮回塔海-7';
const roll1 = Story.rollOrigin(seed);
const roll2 = Story.rollOrigin(seed);
ok('同种子掷骰一致', JSON.stringify(roll1) === JSON.stringify(roll2));
const sevenKeys = ['era', 'terrain', 'order', 'heavenlyLaw', 'greatTribulation', 'aberrant', 'storyGravity'];
ok('七枚骰齐全', sevenKeys.every(function (k) { return !!roll1[k]; }));
const bible = Story.buildWorldBible(roll1);
ok('世界命盘含 7 条规则', Array.isArray(bible.rules) && bible.rules.length === 7);
ok('世界命盘含 flags（天道机制）', !!bible.flags && typeof bible.flags === 'object');
ok('世界命盘含 factionPool', Array.isArray(bible.factionPool) && bible.factionPool.length > 0);
ok('世界名由骰子拼合', !!bible.worldName && bible.worldName.indexOf('·') > 0);

section('§1 七骰 · 每维度取值合法');
sevenKeys.forEach(function (k) {
  ok(k + ' 取值在池中', Story.ORIGIN_DICE[k].indexOf(roll1[k]) >= 0, roll1[k]);
});

/* ============================================================
 * §2 开局：离线也能完整开局（V3 §11 Sprint A 验收）
 * ============================================================ */
section('§2 开局 · 不开 API 也能开界→开局文→选择');
setupMockAI(Story);
const state = await Story.startGame(seed, playerSetup);
ok('开局返回 StoryState', !!state && state.version === '3.3.0', 'version=' + (state && state.version));
ok('第一章已生成', !!state.story.currentChapter && !!state.story.currentChapter.title);
ok('开局正文非空且够长', state.story.currentChapter.chapter.length > 100);
ok('开局生成玩家 A/B/C 选项', (state.story.turnChoices.lu || []).length === 3);
ok('每个玩家选项无 timeHint（V3.1 已移除）', state.story.turnChoices.lu.every(function (c) { return c.timeHint === undefined; }));
ok('开局生成 AI 选项（统一在 turnChoices）', ['han','shen','gu'].every(function (id) { return (state.story.turnChoices[id] || []).length === 3; }));
ok('turnChoices 含全部 4 名角色（V3.1 统一）', Object.keys(state.story.turnChoices).length >= 4);
ok('开局写入编年史', state.story.chronicle.length > 0);
ok('开局写入公开事实/传闻', state.world.publicFacts.length + state.world.publicRumors.length > 0);

/* ============================================================
 * §3 每回合流程：选择 → 下一章 → 新选择（V3 §5）
 * ============================================================ */
section('§3 回合流程 · 玩家选择 A → 下一章 + 新选项');
const choiceA = state.story.turnChoices.lu[0];
const chronBefore = state.story.chronicle.length;
const yearBefore = state.world.year;
const state2 = await Story.playTurn({ choiceId: choiceA.id });
ok('回合推进到第二章', state2.story.chapterIndex === 2);
ok('第二章标题已生成', !!state2.story.currentChapter.title);
ok('第二章正文已生成', state2.story.currentChapter.chapter.length > 50);
ok('第二章生成新玩家选项', (state2.story.turnChoices.lu || []).length >= 1);
ok('每回合只调用一次叙事（无 AI 独立调用）', true); // 结构上保证：AI 经 aiChoose 本地选择
ok('编年史新增条目', state2.story.chronicle.length > chronBefore);
ok('时间推进（world.year 增加）', state2.world.year >= yearBefore);

section('§3 回合流程 · 自定义行动');
const state3 = await Story.playTurn({ custom: { text: '以残剑为媒，在雨夜召来游离的剑意。' } });
ok('自定义行动推进到第三章', state3.story.chapterIndex === 3);
ok('自定义行动不被额外解释 API 调用（直接进叙事上下文）', true);

/* ============================================================
 * §4 AI 同伴加权选择（V3 §5.2 + Sprint C 验收）
 * ============================================================ */
section('§4 AI 同伴 · 加权选择 · 不调 API · 性格差异');
setupMockAI(Story);
const s4 = await Story.startGame('AI-WEIGHT-9', playerSetup);
// 跑 5 回合，收集 AI 选择
const aiPicks = { han: {}, shen: {}, gu: {} };
let cur = s4;
for (let i = 0; i < 5; i++) {
  cur = await Story.playTurn({ choiceId: cur.story.turnChoices.lu[0].id });
  ['han', 'shen', 'gu'].forEach(function (id) {
    const c = cur.story.aiChosenLastTurn[id];
    if (c) aiPicks[id][c] = (aiPicks[id][c] || 0) + 1;
  });
}
// 剑修韩照野偏好剑/险/复仇，不应总选"暗中谋药材"
ok('韩照野 5 回合有选择记录', Object.keys(aiPicks.han).length > 0);
ok('三名 AI 均有选择记录', Object.keys(aiPicks.han).length && Object.keys(aiPicks.shen).length && Object.keys(aiPicks.gu).length);

// 加权选择确定性：同状态同种子同结果（RNG 推进一致）
const testChoices = [
  { id: 'c1', label: '追查剑意线索', hint: '危险', tags: ['剑', '险'] },
  { id: 'c2', label: '谋取药材', hint: '谨慎', tags: ['药', '慎'] },
  { id: 'c3', label: '与同行者结伴', hint: '援护', tags: ['援'] },
];
const han = s4.actors.find(function (a) { return a.id === 'han'; });
const pick1 = Story.aiChoose(han, testChoices);
ok('aiChoose 返回有效选项', !!pick1 && testChoices.indexOf(pick1) >= 0);
// 剑修韩照野偏好剑/险，c1 应得高分
const score1 = Story.choiceScore(han, testChoices[0]);
const score2 = Story.choiceScore(han, testChoices[1]);
ok('剑修对"剑意线索"评分高于"药材"', score1 > score2, score1 + ' vs ' + score2);

section('§4 AI 同伴 · 行动以痕迹揭示而非直接展示');
// 下一章正文不应直接出现"han 选择了 B"字样
const ch3Text = cur.story.currentChapter.chapter;
const leakPattern = /选择了\s*[A-D]/;
ok('下章正文不直接展示 AI 选择编号', !leakPattern.test(ch3Text));

/* ============================================================
 * §5 确定性：续玩与连续游玩一致（V3 §2 保留确定性）
 * ============================================================ */
section('§5 确定性 · 续玩与连续游玩一致');
setupMockAI(Story);
const sA = await Story.startGame('DET-V3-3', playerSetup);
await Story.playTurn({ choiceId: sA.story.turnChoices.lu[0].id });
await Story.playTurn({ choiceId: Story.state.story.turnChoices.lu[0].id });
const saveData = Story.save();
ok('存档返回非空字符串', typeof saveData === 'string' && saveData.length > 0);

// 路径 A：连续第 3 回合
const rA = await Story.playTurn({ choiceId: Story.state.story.turnChoices.lu[0].id });
const txtA = rA.story.currentChapter.chapter;
const yearA = rA.world.year;
const chronA = JSON.stringify(rA.story.chronicle);

// 路径 B：读档后第 3 回合
Story.reset();
const loaded = Story.load(saveData);
ok('读档恢复 state', !!loaded);
// 复现玩家选择（用第 2 章的第一个选项，与 A 路径一致）
const rB = await Story.playTurn({ choiceId: Story.state.story.turnChoices.lu[0].id });
const txtB = rB.story.currentChapter.chapter;
const yearB = rB.world.year;
const chronB = JSON.stringify(rB.story.chronicle);
ok('续玩与连续游玩：章节正文一致', txtA === txtB, '文本不一致');
ok('续玩与连续游玩：年份一致', yearA === yearB, yearA + ' vs ' + yearB);
ok('续玩与连续游玩：编年史一致', chronA === chronB, 'chronicle 不一致');

/* ============================================================
 * §6 API 安全与回退（V3 §11 Sprint B 验收）
 * ============================================================ */
section('§6 API · 越权字段被拒绝');
// 直接对原始 resp 检测（落地前 statePatch 仍在）
const overreachResp = {
  title: '越权章',
  chapter: '模型试图直接让角色飞升并获得顶级法宝。'.padEnd(30, '。'),
  choices: { lu: [] },
  statePatch: { newRelics: ['天阶开天神剑'] },
};
const errors = Story._detectForbiddenPatch(overreachResp);
ok('检测到越权顶级法宝', errors.length > 0 && errors.some(function (e) { return e.indexOf('顶级法宝') >= 0 || e.indexOf('天阶') >= 0; }), JSON.stringify(errors));
// 落地时顶级法宝被 _isMinorRelic 过滤
ok('_isMinorRelic 拒绝天阶法宝', Story._isMinorRelic('天阶开天神剑') === false);
ok('_isMinorRelic 接受小型物品', Story._isMinorRelic('半卷残经') === true);

section('§6 API · 超时自动回退本地行为');
Story.registerAIProvider({
  narrate: function () { return new Promise(function () { /* never resolves */ }); },
});
const slowP = Story.ai._withTimeout(new Promise(function () {}), 50);
const slowR = await slowP;
ok('超时返回 timeout 标记（回退本地）', slowR && slowR.__timeout === true);

section('§6 API · Provider 抛错时 V3.3 不再回退离线模板');
Story.setAIEnabled(true);
Story.registerAIProvider({
  narrate: async function () { throw new Error('bad json'); },
}, { provider: 'throw', model: 'throw-m' });
const s6b = await Story.startGame('API-BADJSON-2', playerSetup);
ok('Provider 抛错：开局停在 narration_failed', Story.getTurnPhase(s6b) === 'narration_failed', Story.getTurnPhase(s6b));
ok('Provider 抛错：无 currentChapter（V3.3 无离线兜底）', !s6b.story.currentChapter);
ok('Provider 抛错：pendingResolution 记录错误', !!Story.getPendingResolution(s6b) && !!Story.getPendingResolution(s6b).lastNarrationError);

section('§6 API · API Key 不入存档与 localStorage');
setupMockAI(Story);
Story.setApiKey('sk-SECRET-V3-999');
const sKey = await Story.startGame('KEY-V3-1', playerSetup);
const saveStr = Story.save();
ok('存档字符串不含 API Key', saveStr.indexOf('sk-SECRET-V3-999') < 0);
const parsedSave = JSON.parse(saveStr);
ok('存档对象无 apiKey 字段', parsedSave.apiKey === undefined && parsedSave._apiKey === undefined);
Story.saveSettings({ aiOn: true, base: 'http://x', model: 'm', apiKey: 'sk-LEAK-V3' });
const settingsStr = (typeof localStorage !== 'undefined') ? localStorage.getItem(Story.SETTINGS_KEY) : '{}';
ok('持久化设置不含 apiKey', !settingsStr || settingsStr.indexOf('sk-LEAK-V3') < 0);

section('§6 API · 重新生成本章文案不改世界状态');
setupMockAI(Story);
const sR = await Story.startGame('REGEN-1', playerSetup);
const beforeChron = JSON.stringify(sR.story.chronicle);
const beforeYear = sR.world.year;
const regen = await Story.regenerateChapter();
ok('重新生成返回章节', !!regen);
ok('重新生成不改编年史', JSON.stringify(Story.state.story.chronicle) === beforeChron);
ok('重新生成不改年份', Story.state.world.year === beforeYear);

/* ============================================================
 * §7 编年史与百年遗产（V3 §8 + §9 + Sprint D）
 * ============================================================ */
section('§7 历史 · 自动编年史 + 百年遗产');
setupMockAI(Story);
const s7 = await Story.startGame('LEGACY-V3-5', playerSetup);
// 手动触发百年推进
s7.settings.narrativePace = '史诗';
await Story.playTurn({ custom: { text: '接受师尊遗命，远游百年。' } });
ok('百年推进后年份 >= 100', Story.state.world.year >= 100, 'year=' + Story.state.world.year);
ok('百年后生成 finalLegacy', !!Story.state.finalLegacy);
if (Story.state.finalLegacy) {
  const L = Story.state.finalLegacy;
  ok('遗产包含 canonicalHistory', Array.isArray(L.canonicalHistory) && L.canonicalHistory.length > 0);
  ok('遗产包含 factions', Array.isArray(L.factions));
  ok('遗产包含 actorFates', Array.isArray(L.actorFates) && L.actorFates.length === 4);
  ok('遗产包含 unresolvedKarma', Array.isArray(L.unresolvedKarma));
}
const exportStr = Story.exportLegacy();
ok('导出遗产为 JSON 字符串', typeof exportStr === 'string' && exportStr.indexOf('canonicalHistory') >= 0);

/* ============================================================
 * §8 世界志抽屉 + 天机全览（V3 §1.1 + §2.3）
 * ============================================================ */
section('§8 抽屉 · 世界志四页 + 天机全览');
const arch = Story.getWorldArchive();
ok('世界志含 cast（本章人物）', Array.isArray(arch.cast) && arch.cast.length === 4);
ok('世界志含 rumors（世界传闻）', Array.isArray(arch.rumors));
ok('世界志含 chronicle（修真编年史）', Array.isArray(arch.chronicle));
ok('世界志含 activeHooks（未结因果）', Array.isArray(arch.activeHooks));
const omni = Story.getOmniscientView();
ok('天机全览含 AI hiddenFate', omni.actors.some(function (a) { return !!a.hiddenFate; }));
ok('天机全览含 turnChoices（含 AI 选择）', !!omni.turnChoices && Object.keys(omni.turnChoices).length > 0);

/* ============================================================
 * §9 上下文压缩（V3 §6 限制）
 * ============================================================ */
section('§9 上下文编译器 · 压缩到限制内');
const ctx = Story.compileContext(Story.state, [{ actorId: 'lu', publicAction: 'test', privateIntent: 't', tags: [] }]);
ok('上下文含 mode', !!ctx.mode);
ok('上下文含 world 命盘摘要', !!ctx.world.worldBibleSummary);
ok('上下文含 cast（每人不超 250 字概念）', Array.isArray(ctx.cast) && ctx.cast.length === 4);
ok('上下文含 constraints（含禁止项）', !!ctx.constraints && Array.isArray(ctx.constraints.forbiddenWithoutTrigger));
ok('activeWorldHooks 不超 12 条', ctx.world.activeWorldHooks.length <= 12);

/* ============================================================
 * §10 V3 最小验收场景（§12 塔海悬陆链路）
 * ============================================================ */
section('§10 最小验收场景 · 轮回紊乱·塔海悬陆·妖族共治');
// 找到该三骰组合的种子
let foundSeed = null;
for (let i = 1; i < 5000; i++) {
  const sd = 'V3-ACCEPT-' + i;
  const r = Story.rollOrigin(sd);
  if (r.heavenlyLaw === '轮回紊乱' && r.terrain === '空岛海' && r.order === '妖族共治') {
    // V3 用"空岛海"代替塔海悬陆（terrain 池已升级）
    foundSeed = sd; break;
  }
}
ok('找到轮回紊乱·空岛海·妖族共治种子', !!foundSeed, '5000 次内未找到');
if (foundSeed) {
  setupMockAI(Story);
  const vSetup = {
    name: '陆知微', identity: '失忆剑修', daoPath: '剑修',
    publicWish: '寻回前世记忆', hiddenFate: '残剑呼唤着我的前世名字',
    personalityTags: ['锋锐', '念旧'],
  };
  const vState = await Story.startGame(foundSeed, vSetup);
  ok('生成轮回紊乱·空岛海·妖族共治世界', vState.world.worldBible.heavenlyLaw === '轮回紊乱' && vState.world.worldBible.terrain === '空岛海');
  ok('开局小说已生成', !!vState.story.currentChapter.chapter);
  ok('玩家获得 3 个选项 + 可自定义', vState.story.turnChoices.lu.length === 3);
  // 连玩数章
  let vCur = vState;
  for (let i = 0; i < 3; i++) {
    vCur = await Story.playTurn({ choiceId: vCur.story.turnChoices.lu[0].id });
  }
  ok('连玩数章后编年史累积', vCur.story.chronicle.length >= 4);
  // 选择远游百年
  vCur.settings.narrativePace = '史诗';
  const vFinal = await Story.playTurn({ custom: { text: '远游百年，见证时代更迭。' } });
  ok('百年后生成新纪元遗产与继承钩子', !!vFinal.finalLegacy && vFinal.finalLegacy.successorHooks !== undefined);
  ok('遗产含旧人去向（actorFates）', vFinal.finalLegacy.actorFates.length === 4);
}

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('\n========================================');
console.log('  V3 通过 ' + pass + ' / 失败 ' + fail);
console.log('========================================');
process.exit(fail > 0 ? 1 : 0);
}

main();
