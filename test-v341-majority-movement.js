const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) { if (condition) { pass++; console.log('✓ ' + name); } else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); } }
function state() {
  const s = Story.createEmptyState();
  s.actors = ['a', 'b', 'c'].map(function (id) { return { id: id, name: id, controller: 'human', presence: 'present', relationships: {} }; });
  s.story.currentScene = { sceneId: 's', locationId: 'start', locationName: '起点', timeOfDay: '清晨', weather: '', pressure: 1, visibleEntities: [], availableAssets: [], exits: [
    { id: 'east', name: '东口', kind: 'exit', destination: { locationId: 'east_land', locationName: '东地' } },
    { id: 'west', name: '西口', kind: 'exit', destination: { locationId: 'west_land', locationName: '西地' } },
  ] };
  return s;
}
function move(id, target) { return { actorId: id, category: 'travel', targetId: target, targetName: target, outcome: 'success', timePassed: { value: 1, unit: '片刻' } }; }
function envelope(actions) { return { actions: actions, elapsedTime: { value: 1, unit: '片刻' }, worldDelta: {} }; }
function main() {
  let s = state();
  ok('第一真人单独移动不再带走整队', Story.Scene.shouldTransition(s, envelope([move('a', 'east')])) === 'partial_move');
  s = state();
  ok('3 名真人中 2 人同出口构成多数', Story.Scene.shouldTransition(s, envelope([move('b', 'east'), move('c', 'east')])) === 'move');
  s = state();
  ok('不同出口无多数时不整队迁移', Story.Scene.shouldTransition(s, envelope([move('a', 'east'), move('b', 'west')])) === 'partial_move');
  console.log('\nV3.4.1 majority movement: ' + pass + ' passed / ' + fail + ' failed'); if (fail) process.exitCode = 1;
}
main();
