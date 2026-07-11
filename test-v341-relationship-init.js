/* V3.4.1：角色列表完成后再建立全向关系图。 */
const Story = require('./story-core.js');

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('✓ ' + name); }
  else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); }
}

async function main() {
  const state = await Story.createSession({
    seed: 'V341-RELATIONS', skipOpening: true,
    actors: [
      { id: 'a', name: '甲', seatId: 'seat_0', controller: 'human', startingRelation: { b: '旧识' } },
      { id: 'b', name: '乙', seatId: 'seat_1', controller: 'human' },
      { id: 'c', name: '丙', seatId: 'seat_2', controller: 'bot' },
    ],
  });
  const a = state.actors[0];
  const b = state.actors[1];
  const c = state.actors[2];
  ok('A 具有指向 B/C 的关系', !!a.relationships.b && !!a.relationships.c);
  ok('B 具有指向 A/C 的关系', !!b.relationships.a && !!b.relationships.c);
  ok('C 具有指向 A/B 的关系', !!c.relationships.a && !!c.relationships.b);
  ok('初始关系提示在第二阶段生效', a.relationships.b.trust === 1);

  Story.Delta._applyOne(state, { op: 'UPDATE_RELATION', target: { actorId: 'b', relatedActorId: 'a' }, payload: { axis: 'suspicion', delta: 1 } });
  ok('反向关系 Delta 不再被静默丢弃', b.relationships.a.suspicion === 1);
  ok('默认 behaviorState 已就绪', a.behaviorState && a.behaviorState.consecutiveSameAction === 0);

  console.log('\nV3.4.1 relationships: ' + pass + ' passed / ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
