/* test-v33-transaction.js — V3.3 Narration Transaction 验收测试
 *
 * 验证事务化回合状态机的 7 条核心契约：
 *   1. AI 成功路径：collecting → awaiting_narration → collecting(published)，章节正常生成
 *   2. AI 失败停在 awaiting_narration：世界状态零变化（chapterIndex/chronicle/scene/currentChapter 不变）
 *   3. 重试成功复用 pendingResolution：不重新裁决、不重选 Bot，retryCount 保留
 *   4. 重试失败递增 retryCount，仍停在 awaiting_narration
 *   5. resolving 异常 → 回 collecting，pendingResolution 清空，状态不变（边界 1A · Story 层）
 *   6. 开局 AI 失败：停在 awaiting_narration，无 currentChapter，可重试
 *   7. retryNarration({modelOverride}) 调用 ai.setModel（不崩溃）
 *
 * 依赖：test-helpers.js 的 createMockProvider / setupMockAI
 */
const Story = require('./story-core.js');
const helpers = require('./test-helpers.js');
const setupMockAI = helpers.setupMockAI;

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
 * §1 AI 成功路径：完整开局 + 回合，turnPhase 正确流转
 * ============================================================ */
section('§1 AI 成功路径 · collecting→awaiting_narration→collecting');
const p1 = setupMockAI(Story);
const st1 = await Story.startGame('V33-OK-1', playerSetup);
ok('开局后 turnPhase=collecting', Story.getTurnPhase(st1) === 'collecting', Story.getTurnPhase(st1));
ok('开局生成 currentChapter', !!st1.story.currentChapter && !!st1.story.currentChapter.title);
ok('开局调用 AI 1 次', p1.calls() === 1, 'calls=' + p1.calls());
ok('开局后 pendingResolution 已清空', Story.getPendingResolution(st1) === null);
ok('开局后 chapterIndex=1', st1.story.chapterIndex === 1, 'idx=' + st1.story.chapterIndex);

const choiceA = st1.story.turnChoices.lu[0];
const chBefore = st1.story.chapterIndex;
const chronBefore = st1.story.chronicle.length;
const callsBefore = p1.calls();
const st1b = await Story.playTurn({ choiceId: choiceA.id });
ok('回合后 chapterIndex+1', st1b.story.chapterIndex === chBefore + 1);
ok('回合后 turnPhase=collecting', Story.getTurnPhase(st1b) === 'collecting');
ok('回合后调用 AI 1 次', p1.calls() === callsBefore + 1, 'calls=' + p1.calls());
ok('回合后编年史新增', st1b.story.chronicle.length > chronBefore);
ok('回合后生成新选项', (st1b.story.turnChoices.lu || []).length >= 1);
ok('回合后 pendingResolution 已清空', Story.getPendingResolution(st1b) === null);
ok('回合后生成新章节正文', st1b.story.currentChapter.chapter.length > 20);

/* ============================================================
 * §2 AI 失败停在 awaiting_narration：世界状态零变化
 * ============================================================ */
section('§2 AI 失败 · 停在 awaiting_narration，状态冻结');
// 用 throw 模式：异常被 Provider 外层 catch 直接返回 null，不触发内置重试，1 次 mock = 1 次失败
setupMockAI(Story, { failUntil: 99, failMode: 'throw' });
const st2 = await Story.startGame('V33-FAIL-2', playerSetup);
// 开局即失败
ok('开局失败 turnPhase=awaiting_narration', Story.getTurnPhase(st2) === 'awaiting_narration', Story.getTurnPhase(st2));
ok('开局失败无 currentChapter', !st2.story.currentChapter);
ok('开局失败 chapterIndex=0', st2.story.chapterIndex === 0, 'idx=' + st2.story.chapterIndex);
const pr2 = Story.getPendingResolution(st2);
ok('开局失败 pendingResolution 存在', !!pr2);
ok('开局失败 pendingResolution.turnId=turn_opening', pr2 && pr2.turnId === 'turn_opening');
ok('开局失败有 lastNarrationError', !!pr2 && !!pr2.lastNarrationError);
ok('开局失败 retryCount=0', pr2 && pr2.retryCount === 0);

// 用一个成功开局的状态来测试"回合中段失败"
setupMockAI(Story);
const st2b = await Story.startGame('V33-FAIL-2B', playerSetup);
const chIdxBefore = st2b.story.chapterIndex;
const chronLenBefore = st2b.story.chronicle.length;
const sceneBefore = JSON.stringify(st2b.story.currentScene);
const chapterBefore = st2b.story.currentChapter ? st2b.story.currentChapter.title : null;
// 切换到失败 provider 再回合
setupMockAI(Story, { failUntil: 99, failMode: 'throw' });
const choiceB = st2b.story.turnChoices.lu[0];
const st2c = await Story.playTurn({ choiceId: choiceB.id });
ok('回合失败 turnPhase=awaiting_narration', Story.getTurnPhase(st2c) === 'awaiting_narration');
ok('回合失败 chapterIndex 不变', st2c.story.chapterIndex === chIdxBefore, 'idx=' + st2c.story.chapterIndex + ' before=' + chIdxBefore);
ok('回合失败编年史不变', st2c.story.chronicle.length === chronLenBefore);
ok('回合失败场景不变', JSON.stringify(st2c.story.currentScene) === sceneBefore);
ok('回合失败 currentChapter 不变', st2c.story.currentChapter && st2c.story.currentChapter.title === chapterBefore);
const pr2c = Story.getPendingResolution(st2c);
ok('回合失败 pendingResolution 存在', !!pr2c);
ok('回合失败 pendingResolution.turnId=turn_0002', pr2c && pr2c.turnId === 'turn_0002', pr2c && pr2c.turnId);
ok('回合失败 sceneBefore 已冻结', pr2c && JSON.stringify(pr2c.sceneBefore) === sceneBefore);

/* ============================================================
 * §3 重试成功复用 pendingResolution：不重新裁决
 * ============================================================ */
section('§3 重试成功 · 复用 envelope，不重算');
// 开局失败 1 次后重试成功（throw 模式：1 次 mock = 1 次失败，不触发内置重试）
const p3 = setupMockAI(Story, { failUntil: 1, failMode: 'throw' });
const st3 = await Story.startGame('V33-RETRY-3', playerSetup);
ok('开局首次失败 awaiting_narration', Story.getTurnPhase(st3) === 'awaiting_narration');
ok('开局首次失败调用 1 次', p3.calls() === 1, 'calls=' + p3.calls());
const pr3fail = Story.getPendingResolution(st3);
const env3 = pr3fail && JSON.stringify(pr3fail.envelope);
// 重试
const callsBefore3 = p3.calls();
const r3 = await Story.retryNarration(st3, {});
ok('重试成功返回 state', !!r3);
ok('重试成功 turnPhase=collecting', Story.getTurnPhase(st3) === 'collecting');
ok('重试再调用 AI 1 次', p3.calls() === callsBefore3 + 1, 'calls=' + p3.calls());
ok('重试成功生成 currentChapter', !!st3.story.currentChapter);
ok('重试成功 pendingResolution 已清空', Story.getPendingResolution(st3) === null);
// 复用 envelope 验证：重试不重新裁决。这里通过"重试期间没有重新调用 Resolver.resolveTurn"间接验证——
// 直接对比：retryNarration 内部用 pr.envelope，未调用 Resolver。我们用调用次数间接保证（Provider 只被调 1 次）。
ok('重试期间仅调 AI 1 次（未重算 envelope）', p3.calls() === 2);

/* ============================================================
 * §4 重试失败递增 retryCount，仍停在 awaiting_narration
 * ============================================================ */
section('§4 重试失败 · retryCount 递增');
const p4 = setupMockAI(Story, { failUntil: 99, failMode: 'throw' });
const st4 = await Story.startGame('V33-RETRY-4', playerSetup);
ok('开局失败 retryCount=0', Story.getPendingResolution(st4).retryCount === 0);
await Story.retryNarration(st4, {});
ok('重试1次后 retryCount=1', Story.getPendingResolution(st4).retryCount === 1, 'rc=' + Story.getPendingResolution(st4).retryCount);
ok('重试1次后仍 awaiting_narration', Story.getTurnPhase(st4) === 'awaiting_narration');
await Story.retryNarration(st4, {});
ok('重试2次后 retryCount=2', Story.getPendingResolution(st4).retryCount === 2);
await Story.retryNarration(st4, {});
ok('重试3次后 retryCount=3', Story.getPendingResolution(st4).retryCount === 3);
ok('重试3次后仍 awaiting_narration', Story.getTurnPhase(st4) === 'awaiting_narration');
// 第4次重试（软上限不阻止）
await Story.retryNarration(st4, {});
ok('重试4次后 retryCount=4（软上限不阻止）', Story.getPendingResolution(st4).retryCount === 4);
ok('重试4次后仍可重试（未崩溃）', Story.getTurnPhase(st4) === 'awaiting_narration');

/* ============================================================
 * §5 resolving 异常 → 回 collecting，状态不变（边界 1A · Story 层）
 * ============================================================ */
section('§5 resolving 异常 · 回 collecting，pendingResolution 清空');
setupMockAI(Story);
const st5 = await Story.startGame('V33-EXC-5', playerSetup);
const chIdx5 = st5.story.chapterIndex;
const chronLen5 = st5.story.chronicle.length;
const sceneStr5 = JSON.stringify(st5.story.currentScene);
// 临时让 Resolver.resolveTurn 抛错
const origResolve = Story.Resolver.resolveTurn;
Story.Resolver.resolveTurn = function () { throw new Error('mock resolving error'); };
let threw5 = false;
let st5b;
try {
  st5b = await Story.playTurn({ choiceId: st5.story.turnChoices.lu[0].id });
} catch (e) {
  threw5 = true;
}
Story.Resolver.resolveTurn = origResolve;  // 恢复
ok('resolving 异常被抛出', threw5);
ok('异常后 turnPhase=collecting', Story.getTurnPhase(st5) === 'collecting', Story.getTurnPhase(st5));
ok('异常后 pendingResolution=null', Story.getPendingResolution(st5) === null);
ok('异常后 chapterIndex 不变', st5.story.chapterIndex === chIdx5);
ok('异常后编年史不变', st5.story.chronicle.length === chronLen5);
ok('异常后场景不变', JSON.stringify(st5.story.currentScene) === sceneStr5);

/* ============================================================
 * §6 开局 AI 失败：停在 awaiting_narration，无 currentChapter
 * ============================================================ */
section('§6 开局 AI 失败 · 可重试，无 currentChapter');
const p6 = setupMockAI(Story, { failUntil: 1, failMode: 'throw' });
const st6 = await Story.startGame('V33-OPEN-6', playerSetup);
ok('开局失败 turnPhase=awaiting_narration', Story.getTurnPhase(st6) === 'awaiting_narration');
ok('开局失败无 currentChapter', !st6.story.currentChapter);
ok('开局失败 chapterIndex=0', st6.story.chapterIndex === 0);
ok('开局失败 pendingResolution.turnId=turn_opening', Story.getPendingResolution(st6).turnId === 'turn_opening');
// 重试成功
const r6 = await Story.retryNarration(st6, {});
ok('开局重试成功返回 state', !!r6);
ok('开局重试成功 turnPhase=collecting', Story.getTurnPhase(st6) === 'collecting');
ok('开局重试成功生成 currentChapter', !!st6.story.currentChapter);
ok('开局重试成功 chapterIndex=1', st6.story.chapterIndex === 1);
ok('开局重试成功 pendingResolution 清空', Story.getPendingResolution(st6) === null);

/* ============================================================
 * §7 retryNarration({modelOverride}) 调用 ai.setModel（不崩溃）
 * ============================================================ */
section('§7 换模型重试 · 调用 ai.setModel');
setupMockAI(Story, { failUntil: 99, failMode: 'throw' });
const st7 = await Story.startGame('V33-MODEL-7', playerSetup);
// 注入 setModel 间谍
let setModelCalled = null;
Story.ai.setModel = function (m) { setModelCalled = m; };
try {
  await Story.retryNarration(st7, { modelOverride: 'deepseek-chat' });
  ok('retryNarration 换模型不崩溃', true);
  ok('ai.setModel 被调用', setModelCalled === 'deepseek-chat', 'got=' + setModelCalled);
  ok('换模型后仍 awaiting_narration（AI 仍失败）', Story.getTurnPhase(st7) === 'awaiting_narration');
} finally {
  delete Story.ai.setModel;  // 恢复（原对象无此方法）
}

console.log('\n========================================');
console.log('V3.3 Transaction 测试通过 ' + pass + ' / 失败 ' + fail);
console.log('========================================');
if (fail > 0) process.exitCode = 1;
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
