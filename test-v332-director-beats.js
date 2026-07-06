/* test-v332-director-beats.js — V3.3.2 Beat 推进系统验收测试
 *
 * 验证：
 *   1. 调查密信触发 advance。
 *   2. 交涉/谈判触发 bend。
 *   3. 休息/等待/闭关触发 stall。
 *   4. 烧毁/撕毁关键线索触发 shatter。
 *   5. shatter 后不强制继续原 Beat（进入 shattered beat）。
 *   6. 压力时钟在 stall/shatter 时推进。
 */
const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}

function makeEnvelope(actions) {
  return { actions: actions };
}

function makeState() {
  var state = Story.createEmptyState('BEAT-TEST');
  state.world.worldBible = { heavenlyLaw: '契约具现', storyGravity: '经商', startLocation: 'inn_redsand' };
  state.world.name = '红砂城';
  state.world.year = 3024;
  state.actors.push({
    id: 'lu', name: '陆知微', daoPath: '剑修', publicWish: '寻找失落剑经',
    controller: 'human', personalityTags: ['谨慎'],
    hidden: { injury: 0, cultivationProgress: 0, spirit: 10 },
    presence: '静坐', locationId: 'inn_redsand',
  });
  state.actors.push({
    id: 'bot1', name: '韩照野', daoPath: '丹道', publicWish: '搜集天下丹方',
    controller: 'bot', personalityTags: ['好奇'],
    hidden: { injury: 0, cultivationProgress: 0, spirit: 10 },
    presence: '翻看', locationId: 'inn_redsand',
  });
  state.story.currentScene = {
    sceneId: 'inn_redsand', name: '红砂客栈',
    visibleEntities: [
      { id: 'ent_trade_letter', name: '半封商会密信', kind: 'clue', affordances: ['investigate', 'observe'] },
      { id: 'ent_innkeeper', name: '客栈掌柜', kind: 'npc', affordances: ['social', 'negotiate', 'observe'] },
    ],
    focalActorIds: ['lu', 'bot1'],
  };
  return state;
}

async function main() {
  console.log('\n=== test-v332-director-beats ===');

  var recipe = Story.DirectorRecipes.trade_contract;

  // ---- 1. advance：调查密信 ----
  var state1 = makeState();
  var d1 = state1.story.director;
  d1.phase = 'active';
  d1.activeArc = {
    arcId: 'arc_trade_contract', recipeId: 'trade_contract', family: 'intrigue',
    title: '商路与血契', publicPitch: '测试', tags: [],
    status: 'active', startedAtChapter: 1, currentBeatIndex: 0,
    beats: [{
      beatId: 'trade_01', title: '被截断的密信', dramaticGoal: '让商会异常进入视野。',
      status: 'active',
      advanceSignals: { categories: ['investigate'], targets: ['ent_trade_letter'] },
      bendSignals: { categories: ['social', 'negotiate'], targets: ['ent_innkeeper'] },
      stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
      shatterKeywords: ['烧掉密信', '撕毁密信', '卖掉密信'],
      allowedReveals: ['密信不是普通账目'],
      forbiddenReveals: ['幕后主使身份'],
      nextOnAdvance: 'trade_02', nextOnBend: 'trade_02', nextOnStall: 'trade_01', nextOnShatter: 'trade_01_shattered',
    }, {
      beatId: 'trade_02', title: '契约的代价', dramaticGoal: '发现契约不是交易。',
      status: 'pending',
      advanceSignals: { categories: ['investigate', 'social'], targets: [] },
      bendSignals: { categories: ['negotiate', 'deceive'], targets: [] },
      stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
      shatterKeywords: ['公开契约'],
      allowedReveals: ['契约并非自愿'],
      forbiddenReveals: ['最终受益人'],
      nextOnAdvance: 'trade_03', nextOnBend: 'trade_03', nextOnStall: 'trade_02', nextOnShatter: 'trade_02_shattered',
    }, {
      beatId: 'trade_03', title: '商路抉择', dramaticGoal: '选择站队。',
      status: 'pending',
      advanceSignals: { categories: ['social', 'negotiate'], targets: [] },
      bendSignals: { categories: ['travel', 'flee'], targets: [] },
      stallSignals: { categories: ['rest', 'wait'] },
      shatterKeywords: ['摧毁商会'],
      allowedReveals: ['契约的代价'],
      forbiddenReveals: [],
      nextOnAdvance: null, nextOnBend: null, nextOnStall: null, nextOnShatter: null,
    }],
    pressureClocks: [{ clockId: 'clock_caravan', label: '商队离城', current: 0, max: 3, onFull: 'divert' }],
    divergenceLog: [], revealLog: [],
  };
  var plan = Story.Director.evaluate(state1, makeEnvelope([
    { actorId: 'lu', intentCategory: 'investigate', targetId: 'ent_trade_letter' },
  ]));
  ok('调查密信 → advance', plan && plan.result === 'advance', 'got ' + (plan && plan.result));
  ok('advance 有 arcDeltas', plan && plan.arcDeltas && plan.arcDeltas.length > 0);
  ok('advance → ADVANCE_BEAT', plan && plan.arcDeltas[0].op === 'ADVANCE_BEAT');

  // ---- 2. bend：逼问掌柜 ----
  var state2 = makeState();
  var d2 = state2.story.director;
  d2.phase = 'active';
  d2.activeArc = JSON.parse(JSON.stringify(d1.activeArc));
  var plan2 = Story.Director.evaluate(state2, makeEnvelope([
    { actorId: 'lu', intentCategory: 'social', targetId: 'ent_innkeeper' },
  ]));
  ok('逼问掌柜 → bend', plan2 && plan2.result === 'bend', 'got ' + (plan2 && plan2.result));

  // ---- 3. stall：闭关 ----
  var state3 = makeState();
  var d3 = state3.story.director;
  d3.phase = 'active';
  d3.activeArc = JSON.parse(JSON.stringify(d1.activeArc));
  var plan3 = Story.Director.evaluate(state3, makeEnvelope([
    { actorId: 'lu', intentCategory: 'cultivate' },
  ]));
  ok('闭关 → stall', plan3 && plan3.result === 'stall', 'got ' + (plan3 && plan3.result));
  ok('stall 推进时钟', plan3 && plan3.clockDeltas && plan3.clockDeltas.length > 0 && plan3.clockDeltas[0].delta === 1);

  // ---- 4. shatter：烧毁密信 ----
  var state4 = makeState();
  var d4 = state4.story.director;
  d4.phase = 'active';
  d4.activeArc = JSON.parse(JSON.stringify(d1.activeArc));
  var plan4 = Story.Director.evaluate(state4, makeEnvelope([
    { actorId: 'lu', intentCategory: 'destroy', custom: { text: '烧掉密信，让这一切灰飞烟灭。' } },
  ]));
  ok('烧毁密信 → shatter', plan4 && plan4.result === 'shatter', 'got ' + (plan4 && plan4.result));
  ok('shatter → SHATTER_ARC', plan4 && plan4.arcDeltas[0].op === 'SHATTER_ARC');

  // ---- 5. shatter 后 applyPlan 产生 shattered beat ----
  var state5 = makeState();
  var d5 = state5.story.director;
  d5.phase = 'active';
  d5.activeArc = JSON.parse(JSON.stringify(d1.activeArc));
  Story.Director.applyPlan(state5, plan4);
  ok('shatter 后 activeArc.status = shattered', d5.activeArc.status === 'shattered');
  ok('shatter 后 beats 增加', d5.activeArc.beats.length > d1.activeArc.beats.length);
  var shatteredBeat = d5.activeArc.beats[d5.activeArc.beats.length - 1];
  ok('shattered beat beatId 包含 shattered', shatteredBeat.beatId.indexOf('shattered') >= 0);
  ok('shattered beat status = active', shatteredBeat.status === 'active');

  // ---- 6. applyPlan 不改变 divergenceLog 外的不相关状态 ----
  var state6 = makeState();
  var d6 = state6.story.director;
  d6.phase = 'active';
  d6.activeArc = JSON.parse(JSON.stringify(d1.activeArc));
  var planAdv = Story.Director.evaluate(state6, makeEnvelope([
    { actorId: 'lu', intentCategory: 'investigate', targetId: 'ent_trade_letter' },
  ]));
  Story.Director.applyPlan(state6, planAdv);
  ok('advance applyPlan 后 currentBeatIndex 更新', d6.activeArc.currentBeatIndex > 0);
  ok('原 beat status 变为 completed', d6.activeArc.beats[0].status === 'completed');
  ok('新 beat status 变为 active', d6.activeArc.beats[d6.activeArc.currentBeatIndex].status === 'active');
  ok('divergenceLog 已记录', d6.activeArc.divergenceLog.length > 0);
  ok('lastDirectorEvent 已更新', d6.lastDirectorEvent !== null);

  // ---- 7. 无 activeArc 时 evaluate 返回 null ----
  var state7 = makeState();
  var plan7 = Story.Director.evaluate(state7, makeEnvelope([
    { actorId: 'lu', intentCategory: 'investigate', targetId: 'ent_trade_letter' },
  ]));
  ok('无 activeArc 时 evaluate 返回 null', plan7 === null);

  console.log('\n' + '  Director Beat 测试通过 ' + pass + ' / 失败 ' + fail);
  if (fail) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});