const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('✓ ' + name); }
  else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function intent(actorId, category, targetId, targetName) {
  return { actorId: actorId, source: 'custom', rawText: category, category: category, approach: 'normal', targetType: category === 'travel' ? 'exit' : 'clue', targetId: targetId, targetName: targetName, timePreference: category === 'travel' ? '数日' : '片刻', riskStyle: 'normal', derivedTags: [category], confidence: 1 };
}
async function main() {
  const state = await Story.createSession({ seed: 'V341-COOP', skipOpening: true, actors: [
    { id: 'a', name: '甲', seatId: 'seat_0', controller: 'human' },
    { id: 'b', name: '乙', seatId: 'seat_1', controller: 'human' },
    { id: 'c', name: '丙', seatId: 'seat_2', controller: 'human' },
  ] });
  state.story.currentScene = { sceneId: 's', locationId: 'r', locationName: '秘境', timeOfDay: '夜', pressure: 1, deadline: null, visibleEntities: [{ id: 'rift', name: '裂隙', kind: 'clue' }], availableAssets: [], exits: [{ id: 'east', name: '东口', kind: 'exit' }, { id: 'west', name: '西口', kind: 'exit' }], activeThreadIds: [], sceneStatus: 'open' };
  const coop = Story.Resolver.resolveTurn(state, [intent('a', 'investigate', 'rift', '裂隙'), intent('b', 'aid', 'rift', '裂隙')]);
  const investigation = coop.actions.find(function (a) { return a.actorId === 'a'; });
  ok('同目标调查+援护形成协作交互', coop.interactions.some(function (i) { return i.type === 'cooperative_investigation'; }));
  ok('协作调查提升结果', investigation.outcome === 'success' || investigation.outcome === 'great_success', investigation.outcome);
  ok('协作交互写入信任 Delta', coop.publicDelta.some(function (d) { return d.op === 'UPDATE_RELATION'; }));

  const conflict = Story.Resolver.resolveTurn(state, [intent('a', 'investigate', 'rift', '裂隙'), intent('c', 'battle', 'rift', '裂隙')]);
  ok('调查+破坏同目标形成冲突', conflict.interactions.some(function (i) { return i.type === 'investigate_destroy_conflict'; }));
  ok('冲突后调查只部分成功', conflict.actions.find(function (a) { return a.actorId === 'a'; }).outcome === 'partial_success');

  const together = Story.Resolver.resolveTurn(state, [intent('a', 'travel', 'east', '东口'), intent('b', 'travel', 'east', '东口')]);
  ok('同出口移动形成同行', together.interactions.some(function (i) { return i.type === 'group_travel'; }));
  const split = Story.Resolver.resolveTurn(state, [intent('a', 'travel', 'east', '东口'), intent('b', 'travel', 'west', '西口')]);
  ok('不同出口产生去留冲突', split.interactions.some(function (i) { return i.type === 'travel_conflict'; }));

  console.log('\nV3.4.1 cooperation: ' + pass + ' passed / ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}
main().catch(function (error) { console.error(error); process.exitCode = 1; });
