const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('✓ ' + name); }
  else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); }
}
async function main() {
  const state = await Story.createSession({ seed: 'V341-REST', skipOpening: true, actors: [
    { id: 'a', name: '甲', seatId: 'seat_0', controller: 'human' },
    { id: 'b', name: '乙', seatId: 'seat_1', controller: 'human' },
  ] });
  state.story.currentScene = { sceneId: 's', locationId: 'camp', locationName: '营地', timeOfDay: '夜', pressure: 1, deadline: null, visibleEntities: [], availableAssets: [], exits: [], activeThreadIds: [], sceneStatus: 'open' };
  state.actors[0].hidden.injury = 4;
  const rounds = [];
  for (let i = 0; i < 4; i++) {
    const envelope = Story.Resolver.resolveTurn(state, [Story.Intent.parseCustomText(state, 'a', i ? '继续睡觉' : '休息')]);
    rounds.push(envelope.actions[0]);
    Story.Behavior.commitFromEnvelope(state, envelope);
  }
  ok('第1次休息正常恢复', rounds[0].actorStatusDeltas.some(function (d) { return d.key === 'injury' && d.delta === -1; }));
  ok('第2次休息恢复减半', rounds[1].actorStatusDeltas.some(function (d) { return d.key === 'injury' && d.delta === -0.5; }));
  ok('第3次不再恢复', !rounds[2].actorStatusDeltas.some(function (d) { return d.delta < 0; }));
  ok('第3次产生 missed_opportunity', rounds[2].outcome === 'missed_opportunity');
  ok('第4次标记消极回避', rounds[3].interactionTags.indexOf('passive_avoidance') >= 0);
  ok('第4次影响同伴关系', rounds[3].relationEffects.some(function (r) { return r.actorId === 'b' && r.targetId === 'a'; }));
  ok('休息公开事实不再硬编客栈', rounds.every(function (r) { return (r.publicEffects || []).join('').indexOf('没有追出客栈') < 0; }));
  console.log('\nV3.4.1 repeated rest: ' + pass + ' passed / ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}
main().catch(function (error) { console.error(error); process.exitCode = 1; });
