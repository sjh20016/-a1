/* test-v332-director-candidates.js — V3.3.2 候选卷纲生成验收测试
 *
 * 验证：
 *   1. 同种子生成同样三张命途签。
 *   2. 三张命途签 family 不重复。
 *   3. 三张命途签标题不重复。
 *   4. 世界骰会影响权重，但不会让某一路线必出。
 *   5. 不同种子下候选组合会变化。
 *   6. activateArc 正确创建 activeArc、dormantArcs、线程、实体、时钟。
 */
const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}

function makeState(seed) {
  var state = Story.createEmptyState(seed);
  // 设置世界天道与故事引力
  state.world.worldBible = {
    heavenlyLaw: '因果具现',
    storyGravity: '剑修',
    startLocation: 'inn_redsand',
  };
  state.world.name = '红砂城';
  state.world.year = 3024;
  // 添加测试角色
  state.actors.push({
    id: 'lu', name: '陆知微', daoPath: '剑修', publicWish: '寻找失落剑经',
    controller: 'human', personalityTags: ['谨慎', '执念'],
    hidden: { injury: 0, cultivationProgress: 0, spirit: 10 },
    presence: '静坐檐下', locationId: 'inn_redsand',
  });
  state.actors.push({
    id: 'bot1', name: '韩照野', daoPath: '丹道', publicWish: '搜集天下丹方',
    controller: 'bot', personalityTags: ['好奇'],
    hidden: { injury: 0, cultivationProgress: 0, spirit: 10 },
    presence: '翻看账册', locationId: 'inn_redsand',
  });
  state.actors.push({
    id: 'bot2', name: '沈青萝', daoPath: '阵法', publicWish: '开拓秘境',
    controller: 'bot', personalityTags: ['冒险'],
    hidden: { injury: 0, cultivationProgress: 0, spirit: 10 },
    presence: '把玩阵盘', locationId: 'inn_redsand',
  });
  // 设置场景
  state.story.currentScene = {
    sceneId: 'inn_redsand',
    name: '红砂客栈',
    visibleEntities: [
      { id: 'ent_innkeeper', name: '客栈掌柜', kind: 'npc', affordances: ['social', 'negotiate', 'observe'] },
    ],
    focalActorIds: ['lu', 'bot1', 'bot2'],
  };
  return state;
}

async function main() {
  console.log('\n=== test-v332-director-candidates ===');

  // ---- 1. 同种子生成相同三张候选 ----
  var state1 = makeState('DIRECTOR-CAND-01');
  var state2 = makeState('DIRECTOR-CAND-01');
  var c1 = Story.Director.generateCandidates(state1);
  var c2 = Story.Director.generateCandidates(state2);
  ok('Recipe 池至少 10 条', Object.keys(Story.DirectorRecipes).length >= 10,
    'count=' + Object.keys(Story.DirectorRecipes).length);
  ok('同种子候选数相同', c1.length === c2.length, 'c1=' + c1.length + ' c2=' + c2.length);
  ok('同种子候选 arcId 相同', c1.every(function (c, i) { return c.arcId === c2[i].arcId; }));

  // ---- 2. 三张候选 family 不重复 ----
  var families = c1.map(function (c) { return c.family; });
  var uniqueFamilies = families.filter(function (f, i) { return families.indexOf(f) === i; });
  ok('三张候选 family 不重复', uniqueFamilies.length === 3, 'families=' + families.join(','));

  // ---- 3. 三张候选标题不重复 ----
  var titles = c1.map(function (c) { return c.title; });
  var uniqueTitles = titles.filter(function (t, i) { return titles.indexOf(t) === i; });
  ok('三张候选标题不重复', uniqueTitles.length === 3, 'titles=' + titles.join(','));

  // ---- 4. 候选至少覆盖两类 ----
  var coverageCount = uniqueFamilies.length;
  ok('候选覆盖至少两类题材', coverageCount >= 2, 'coverage=' + coverageCount);

  // ---- 5. 世界骰影响权重但不锁死 ----
  // 剑修角色应让 relic_identity 权重较高但不一定出现
  var scores = {};
  Object.keys(Story.DirectorRecipes).forEach(function (k) {
    scores[k] = Story.Director.scoreRecipe(state1, Story.DirectorRecipes[k]);
  });
  ok('relic_identity 权重高于 tower_expedition', scores.relic_identity >= scores.tower_expedition,
    'relic=' + scores.relic_identity + ' tower=' + scores.tower_expedition);

  // ---- 6. 不同种子候选组合可能变化 ----
  var signatures = {};
  ['DIRECTOR-CAND-99', 'DIRECTOR-CAND-100', 'DIRECTOR-CAND-101', 'DIRECTOR-CAND-102'].forEach(function (seed) {
    var st = makeState(seed);
    st.world.worldBible.heavenlyLaw = '时空紊乱';
    st.world.worldBible.storyGravity = '探索';
    st.actors[0].daoPath = '游侠';
    st.actors[0].publicWish = '开拓未知秘境';
    var sig = Story.Director.generateCandidates(st).map(function (c) { return c.arcId; }).join('|');
    signatures[sig] = true;
  });
  ok('不同种子下候选组合有实际变化', Object.keys(signatures).length >= 2,
    'signatures=' + Object.keys(signatures).join(' / '));

  // ---- 7. activateArc 测试 ----
  var state4 = makeState('DIRECTOR-ACTIVATE');
  state4.story.director.candidates = c1;
  state4.story.director.phase = 'voting';
  var threadCountBefore = state4.story.activeThreads.length;
  var entityCountBefore = state4.story.currentScene.visibleEntities.length;
  var arc = Story.Director.activateArc(state4, c1[0].arcId);
  var d = state4.story.director;
  ok('activateArc 返回 arc', !!arc);
  ok('activeArc 已设置', d.activeArc !== null);
  ok('activeArc.status = active', d.activeArc && d.activeArc.status === 'active');
  ok('phase 变为 active', d.phase === 'active');
  ok('currentBeatIndex = 0', d.activeArc && d.activeArc.currentBeatIndex === 0);
  ok('beats 数量 = 3', d.activeArc && d.activeArc.beats && d.activeArc.beats.length === 3);
  ok('压力时钟已创建', d.activeArc && d.activeArc.pressureClocks && d.activeArc.pressureClocks.length > 0);

  // ---- 8. dormantArcs 测试 ----
  ok('dormantArcs 有 2 条', d.dormantArcs.length === 2);
  ok('dormantArcs status = dormant', d.dormantArcs.every(function (da) { return da.status === 'dormant'; }));
  ok('dormantArcs 有 wakeConditions', d.dormantArcs.every(function (da) { return da.wakeConditions && da.wakeConditions.length > 0; }));
  ok('dormantArcs 不包含 activeArc', d.dormantArcs.every(function (da) { return da.arcId !== d.activeArc.arcId; }));

  // ---- 9. openingSeed 延后到 applyOpeningSeed ----
  ok('activateArc 不直接写 activeThreads', state4.story.activeThreads.length === threadCountBefore);
  ok('activateArc 不直接写 currentScene 实体', state4.story.currentScene.visibleEntities.length === entityCountBefore);
  Story.Director.applyOpeningSeed(state4, d.activeArc);
  ok('applyOpeningSeed 后 activeThreads 增加', state4.story.activeThreads.length > threadCountBefore);
  var arcThreads = state4.story.activeThreads.filter(function (t) { return t.sourceArcId === d.activeArc.arcId; });
  ok('activeThreads 包含 arc 线程', arcThreads.length > 0);
  ok('applyOpeningSeed 后场景实体增加', state4.story.currentScene.visibleEntities.length > entityCountBefore);

  console.log('\n' + '  Director 候选测试通过 ' + pass + ' / 失败 ' + fail);
  if (fail) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
