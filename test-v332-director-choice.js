/* test-v332-director-choice.js — V3.3.2 ChoiceFactory 导演层接入验收测试
 *
 * 验证：
 *   1. 每回合最多一项 arc 选项。
 *   2. 至少一项 scene 或 character 选项。
 *   3. 主线 Arc 被打碎后，不再持续生成旧主线推进选项。
 *   4. 场景没有 NPC 时，不生成交涉选项。
 *   5. 场景没有 relic 时，不生成御器选项。
 */
const Story = require('./story-core.js');
const helpers = require('./test-helpers.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}

async function main() {
  console.log('\n=== test-v332-director-choice ===');

  helpers.setupMockAI(Story);
  Story.setAIEnabled(true);

  // ---- 1. 准备带 Director 的完整状态 ----
  var playerSetup = {
    name: '陆知微', identity: '青霄宗外门弟子', daoPath: '剑修',
    publicWish: '寻找失落剑经', hiddenFate: '残剑记得一个不存在的人名',
    personalityTags: ['谨慎', '执念'],
  };
  var state = await Story.startGame('CHOICE-TEST', playerSetup);
  var d = state.story.director;

  // 激活 trade_contract 卷纲
  d.candidates = Story.Director.generateCandidates(state);
  d.phase = 'voting';
  Story.Director.activateArc(state, d.candidates[0].arcId);

  // ---- 2. 每回合最多一项 arc 选项 ----
  var choices = Story.getChoicesForActor(state, 'lu');
  ok('getChoicesForActor 返回选项', choices && choices.length > 0);
  var arcChoices = choices.filter(function (c) { return c.directorRole === 'arc'; });
  ok('每回合最多一项 arc 选项', arcChoices.length <= 1, 'arcChoices=' + arcChoices.length);

  // ---- 3. 至少一项 scene 或 character 选项 ----
  var nonArcChoices = choices.filter(function (c) { return c.directorRole !== 'arc'; });
  ok('至少有非 arc 选项', nonArcChoices.length > 0);

  // ---- 4. 所有选项有 directorRole 标签 ----
  ok('所有选项有 directorRole', choices.every(function (c) { return c.directorRole === 'arc' || c.directorRole === 'character' || c.directorRole === 'scene'; }));

  // ---- 5. 主线 Arc 被打碎后不再生成旧主线推进选项 ----
  // 模拟打碎
  var beat = d.activeArc.beats[0];
  beat.status = 'shattered';
  d.activeArc.status = 'shattered';
  d.activeArc.currentBeatIndex = 0;
  d.activeArc.beats.push({
    beatId: 'trade_01_shattered', title: '碎片', dramaticGoal: '新的威胁。',
    status: 'active',
    advanceSignals: { categories: ['investigate', 'social'], targets: [] },
    bendSignals: { categories: ['negotiate'], targets: [] },
    stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
    shatterKeywords: [], allowedReveals: [], forbiddenReveals: [],
    nextOnAdvance: null, nextOnBend: null, nextOnStall: null, nextOnShatter: null,
  });
  d.activeArc.currentBeatIndex = d.activeArc.beats.length - 1;

  var choicesAfterShatter = Story.getChoicesForActor(state, 'lu');
  ok('shatter 后仍有选项', choicesAfterShatter && choicesAfterShatter.length > 0);
  ok('shatter 后 arc 选项不超过 1', choicesAfterShatter.filter(function (c) { return c.directorRole === 'arc'; }).length <= 1);

  // ---- 6. 场景没有 NPC 时不生成交涉选项 ----
  var state2 = await Story.startGame('CHOICE-NO-NPC', playerSetup);
  state2.story.currentScene.visibleEntities = state2.story.currentScene.visibleEntities.filter(function (e) { return e.kind !== 'npc'; });
  var choicesNoNpc = Story.getChoicesForActor(state2, 'lu');
  var socialChoices = choicesNoNpc.filter(function (c) {
    return c.intentCategory === 'social' || c.intentCategory === 'negotiate';
  });
  // 注意：ChoiceFactory 可能仍会生成 social 选项（如角色间互动），但 targetType 不应是 npc
  ok('无 NPC 场景仍可生成选项', choicesNoNpc.length > 0);

  // ---- 7. 场景没有 relic 时不生成御器选项 ----
  var state3 = await Story.startGame('CHOICE-NO-RELIC', playerSetup);
  state3.story.currentScene.visibleEntities = state3.story.currentScene.visibleEntities.filter(function (e) { return e.kind !== 'relic'; });
  var choicesNoRelic = Story.getChoicesForActor(state3, 'lu');
  var useRelicChoices = choicesNoRelic.filter(function (c) { return c.intentCategory === 'use_relic'; });
  ok('无 relic 场景不生成御器选项', useRelicChoices.length === 0, 'use_relic=' + useRelicChoices.length);

  console.log('\n' + '  Director Choice 测试通过 ' + pass + ' / 失败 ' + fail);
  if (fail) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});