/* test-v332-director-transaction.js — V3.3.2 Director 事务安全验收测试
 *
 * 验证 AI 失败时 Director 状态不变：
 *   1. currentBeatIndex 不变。
 *   2. pressureClock 不变。
 *   3. dormantArcs 不变。
 *   4. activeArc.status 不变。
 *   5. divergenceLog 不变。
 *   6. AI 成功后 DirectorPlan 才真正应用。
 */
const Story = require('./story-core.js');
const helpers = require('./test-helpers.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}

function snapshotDirector(state) {
  var d = state.story.director;
  return {
    phase: d.phase,
    hasActiveArc: !!d.activeArc,
    activeArcStatus: d.activeArc ? d.activeArc.status : null,
    currentBeatIndex: d.activeArc ? d.activeArc.currentBeatIndex : -1,
    clockCurrents: d.activeArc ? (d.activeArc.pressureClocks || []).map(function (c) { return c.current; }) : [],
    dormantCount: d.dormantArcs.length,
    divergenceLogLen: d.activeArc ? (d.activeArc.divergenceLog || []).length : 0,
    revealLogLen: d.activeArc ? (d.activeArc.revealLog || []).length : 0,
    lastEvent: d.lastDirectorEvent ? d.lastDirectorEvent.beatId : null,
  };
}

async function main() {
  console.log('\n=== test-v332-director-transaction ===');

  // ---- 1. 准备带 Director 的完整状态 ----
  helpers.setupMockAI(Story);
  var playerSetup = {
    name: '陆知微', identity: '青霄宗外门弟子', daoPath: '剑修',
    publicWish: '寻找失落剑经', hiddenFate: '残剑记得一个不存在的人名',
    personalityTags: ['谨慎', '执念'],
  };
  var state = await Story.startGame('DIRECTOR-TX-01', playerSetup);
  var d = state.story.director;

  // 手动激活一个卷纲（跳过投票流程）
  d.candidates = Story.Director.generateCandidates(state);
  d.phase = 'voting';
  Story.Director.activateArc(state, d.candidates[0].arcId);
  Story.Director.applyOpeningSeed(state, d.activeArc);
  Story._writeChoices(state, Story.ChoiceFactory.buildAll(state, state.story.currentScene, null));
  ok('事务测试初始状态：activeArc 已激活', d.activeArc !== null && d.phase === 'active');

  // 快照初始 Director 状态
  var snapBefore = snapshotDirector(state);

  // ---- 2. AI 失败：Director 状态不变 ----
  // 注册一个会失败的 AI provider
  Story.registerAIProvider({
    narrate: async function () { throw new Error('模拟 AI 故障'); },
  }, { provider: 'fail', model: 'fail' });

  // 触发一个回合（AI 会失败）
  try {
    var choices = Story.getChoicesForActor(state, 'lu');
    var picked = choices[0];
    await Story.resolveTurn(state, { lu: { choiceId: picked.id } });
  } catch (e) {
    // 预期失败
  }

  var snapAfter = snapshotDirector(state);
  ok('AI 失败后 currentBeatIndex 不变', snapAfter.currentBeatIndex === snapBefore.currentBeatIndex,
    'before=' + snapBefore.currentBeatIndex + ' after=' + snapAfter.currentBeatIndex);
  ok('AI 失败后 pressureClock 不变', JSON.stringify(snapAfter.clockCurrents) === JSON.stringify(snapBefore.clockCurrents),
    'before=' + JSON.stringify(snapBefore.clockCurrents) + ' after=' + JSON.stringify(snapAfter.clockCurrents));
  ok('AI 失败后 activeArc.status 不变', snapAfter.activeArcStatus === snapBefore.activeArcStatus,
    'before=' + snapBefore.activeArcStatus + ' after=' + snapAfter.activeArcStatus);
  ok('AI 失败后 dormantArcs 数量不变', snapAfter.dormantCount === snapBefore.dormantCount);
  ok('AI 失败后 divergenceLog 不变', snapAfter.divergenceLogLen === snapBefore.divergenceLogLen);

  // ---- 3. AI 成功：DirectorPlan 应用 ----
  // 重新注册成功的 AI
  helpers.setupMockAI(Story);
  Story.setAIEnabled(true);

  // 重置状态
  var state2 = await Story.startGame('DIRECTOR-TX-02', playerSetup);
  var d2 = state2.story.director;
  d2.candidates = Story.Director.generateCandidates(state2);
  d2.phase = 'voting';
  Story.Director.activateArc(state2, d2.candidates[0].arcId);
  Story.Director.applyOpeningSeed(state2, d2.activeArc);
  Story._writeChoices(state2, Story.ChoiceFactory.buildAll(state2, state2.story.currentScene, null));

  var snapBefore2 = snapshotDirector(state2);
  var choices2 = Story.getChoicesForActor(state2, 'lu');
  // 找一个 investigate 选项来触发 advance
  var invChoice = choices2.find(function (c) { return c.directorRole === 'arc'; }) ||
    choices2.find(function (c) { return c.intentCategory === 'investigate'; }) ||
    choices2[0];
  ok('真实回合存在可提交选项', !!invChoice);
  await Story.resolveTurn(state2, { lu: { choiceId: invChoice.id } });

  var snapAfter2 = snapshotDirector(state2);
  ok('AI 成功后 currentBeatIndex 已变化', snapAfter2.currentBeatIndex !== snapBefore2.currentBeatIndex,
    'before=' + snapBefore2.currentBeatIndex + ' after=' + snapAfter2.currentBeatIndex);
  ok('AI 成功后 divergenceLog +1', snapAfter2.divergenceLogLen === snapBefore2.divergenceLogLen + 1,
    'before=' + snapBefore2.divergenceLogLen + ' after=' + snapAfter2.divergenceLogLen);
  ok('AI 成功后 lastDirectorEvent.result = advance',
    state2.story.director.lastDirectorEvent && state2.story.director.lastDirectorEvent.result === 'advance',
    state2.story.director.lastDirectorEvent ? state2.story.director.lastDirectorEvent.result : 'null');
  ok('AI 成功后 pendingResolution 已清空', Story.getPendingResolution(state2) === null);

  // ---- 4. AI 提前揭露 forbiddenReveals：停在 narration_failed，不应用 DirectorPlan ----
  var state3 = await Story.startGame('DIRECTOR-TX-FORBIDDEN', playerSetup);
  var d3 = state3.story.director;
  d3.candidates = Story.Director.generateCandidates(state3);
  d3.phase = 'voting';
  Story.Director.activateArc(state3, d3.candidates[0].arcId);
  Story.Director.applyOpeningSeed(state3, d3.activeArc);
  Story._writeChoices(state3, Story.ChoiceFactory.buildAll(state3, state3.story.currentScene, null));
  var forbidden = d3.activeArc.beats[d3.activeArc.currentBeatIndex].forbiddenReveals[0];
  Story.registerAIProvider({
    narrate: async function () {
      return JSON.stringify({
        title: '提前泄密',
        chapter: ('这一章表面推进行动，暗中却直接写出了' + forbidden + '，导致当前 Beat 的禁止揭露被命中。').repeat(3),
        dialogues: [],
        endingImage: '',
      });
    },
  }, { provider: 'leak', model: 'leak' });
  Story.setAIEnabled(true);
  var snapBefore3 = snapshotDirector(state3);
  var choices3 = Story.getChoicesForActor(state3, 'lu');
  var arcChoice3 = choices3.find(function (c) { return c.directorRole === 'arc'; }) || choices3[0];
  await Story.resolveTurn(state3, { lu: { choiceId: arcChoice3.id } });
  var snapAfter3 = snapshotDirector(state3);
  var pending3 = Story.getPendingResolution(state3);
  ok('命中 forbiddenReveals 后停在 narration_failed', Story.getTurnPhase(state3) === 'narration_failed');
  ok('命中 forbiddenReveals 后 DirectorPlan 不应用', snapAfter3.currentBeatIndex === snapBefore3.currentBeatIndex);
  ok('命中 forbiddenReveals 后 pendingResolution 保留', !!pending3);
  ok('命中 forbiddenReveals 错误码正确',
    pending3 && pending3.lastNarrationError && pending3.lastNarrationError.code === 'FORBIDDEN_REVEAL',
    pending3 && pending3.lastNarrationError ? pending3.lastNarrationError.code : 'null');

  console.log('\n' + '  Director 事务测试通过 ' + pass + ' / 失败 ' + fail);
  if (fail) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
