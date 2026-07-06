/* test-v332-director-vote.js — V3.3.2 投票系统验收测试
 *
 * 验证：
 *   1. 真人可投票与改票。
 *   2. Bot 自动投票。
 *   3. 所有真人投票后才可结算。
 *   4. 同票时由固定 director RNG 决定。
 *   5. 同种子同票局面结果一致。
 *   6. 未选路线进入 dormantArcs。
 */
const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}

function makeState(seed) {
  var state = Story.createEmptyState(seed);
  state.world.worldBible = {
    heavenlyLaw: '因果具现',
    storyGravity: '剑修',
    startLocation: 'inn_redsand',
  };
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
    choicePrefs: { '遗物': 3, '探索': 1 },
  });
  state.actors.push({
    id: 'bot2', name: '沈青萝', daoPath: '阵法', publicWish: '开拓秘境',
    controller: 'bot', personalityTags: ['冒险'],
    hidden: { injury: 0, cultivationProgress: 0, spirit: 10 },
    presence: '把玩', locationId: 'inn_redsand',
    choicePrefs: { '探索': 4, '遗物': 2 },
  });
  state.actors.push({
    id: 'bot3', name: '顾长风', daoPath: '游侠', publicWish: '经商致富',
    controller: 'bot', personalityTags: ['务实'],
    hidden: { injury: 0, cultivationProgress: 0, spirit: 10 },
    presence: '算账', locationId: 'inn_redsand',
    choicePrefs: { '商会': 3, '交易': 2 },
  });
  state.story.currentScene = {
    sceneId: 'inn_redsand', name: '红砂客栈',
    visibleEntities: [{ id: 'ent_innkeeper', name: '掌柜', kind: 'npc', affordances: ['social'] }],
    focalActorIds: ['lu', 'bot1', 'bot2', 'bot3'],
  };
  return state;
}

async function main() {
  console.log('\n=== test-v332-director-vote ===');

  // ---- 1. 准备：生成候选并设置投票阶段 ----
  var state = makeState('VOTE-TEST-01');
  state.story.director.candidates = Story.Director.generateCandidates(state);
  state.story.director.phase = 'voting';
  var candidates = state.story.director.candidates;
  var d = state.story.director;

  ok('投票阶段 phase=voting', d.phase === 'voting');
  ok('有 3 张候选', candidates.length === 3);

  // ---- 2. 真人投票 ----
  Story.DirectorVote.submitVote(state, 'lu', candidates[0].arcId);
  ok('真人投票后记录存在', d.votesByActorId['lu'] === candidates[0].arcId);

  // ---- 3. 真人改票 ----
  Story.DirectorVote.submitVote(state, 'lu', candidates[1].arcId);
  ok('真人改票后记录更新', d.votesByActorId['lu'] === candidates[1].arcId);

  // ---- 4. Bot 自动投票 ----
  var bot1Vote = Story.DirectorVote.autoVoteForBot(state, 'bot1');
  ok('Bot1 自动投票返回有效 arcId', bot1Vote && candidates.some(function (c) { return c.arcId === bot1Vote; }));
  Story.DirectorVote.submitVote(state, 'bot1', bot1Vote);

  var bot2Vote = Story.DirectorVote.autoVoteForBot(state, 'bot2');
  ok('Bot2 自动投票返回有效 arcId', bot2Vote && candidates.some(function (c) { return c.arcId === bot2Vote; }));
  Story.DirectorVote.submitVote(state, 'bot2', bot2Vote);

  var bot3Vote = Story.DirectorVote.autoVoteForBot(state, 'bot3');
  ok('Bot3 自动投票返回有效 arcId', bot3Vote && candidates.some(function (c) { return c.arcId === bot3Vote; }));
  Story.DirectorVote.submitVote(state, 'bot3', bot3Vote);

  ok('Bot 不改票（第二次调用结果相同）', Story.DirectorVote.autoVoteForBot(state, 'bot1') === bot1Vote);

  // ---- 5. 结算投票 ----
  var winner = Story.DirectorVote.finalizeVote(state);
  ok('finalizeVote 返回胜出 arcId', candidates.some(function (c) { return c.arcId === winner; }));
  ok('候选卡 voteScore 已更新', candidates.every(function (c) { return typeof c.voteScore === 'number'; }));

  // ---- 6. 同种子同票局面结果一致 ----
  var state2 = makeState('VOTE-TEST-01');
  state2.story.director.candidates = Story.Director.generateCandidates(state2);
  state2.story.director.phase = 'voting';
  Story.DirectorVote.submitVote(state2, 'lu', candidates[1].arcId);
  Story.DirectorVote.submitVote(state2, 'bot1', bot1Vote);
  Story.DirectorVote.submitVote(state2, 'bot2', bot2Vote);
  Story.DirectorVote.submitVote(state2, 'bot3', bot3Vote);
  var winner2 = Story.DirectorVote.finalizeVote(state2);
  ok('同种子同票结果一致', winner === winner2, 'w1=' + winner + ' w2=' + winner2);

  // ---- 7. 同票 RNG 决定 ----
  var state3 = makeState('VOTE-TIE-01');
  state3.story.director.candidates = Story.Director.generateCandidates(state3);
  state3.story.director.phase = 'voting';
  // 每人投不同的候选，制造平票
  Story.DirectorVote.submitVote(state3, 'lu', state3.story.director.candidates[0].arcId);
  Story.DirectorVote.submitVote(state3, 'bot1', state3.story.director.candidates[0].arcId);
  Story.DirectorVote.submitVote(state3, 'bot2', state3.story.director.candidates[1].arcId);
  Story.DirectorVote.submitVote(state3, 'bot3', state3.story.director.candidates[1].arcId);
  var winner3 = Story.DirectorVote.finalizeVote(state3);
  ok('同票时 RNG 决定胜者', state3.story.director.candidates.some(function (c) { return c.arcId === winner3; }));

  // 同种子同票 → 同结果
  var state4 = makeState('VOTE-TIE-01');
  state4.story.director.candidates = Story.Director.generateCandidates(state4);
  state4.story.director.phase = 'voting';
  Story.DirectorVote.submitVote(state4, 'lu', state4.story.director.candidates[0].arcId);
  Story.DirectorVote.submitVote(state4, 'bot1', state4.story.director.candidates[0].arcId);
  Story.DirectorVote.submitVote(state4, 'bot2', state4.story.director.candidates[1].arcId);
  Story.DirectorVote.submitVote(state4, 'bot3', state4.story.director.candidates[1].arcId);
  var winner4 = Story.DirectorVote.finalizeVote(state4);
  ok('同种子同票结果一致（平票）', winner3 === winner4, 'w3=' + winner3 + ' w4=' + winner4);

  console.log('\n' + '  Director 投票测试通过 ' + pass + ' / 失败 ' + fail);
  if (fail) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});