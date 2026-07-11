const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('✓ ' + name); }
  else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); }
}
async function makeState(pressure) {
  const state = await Story.createSession({ seed: 'V341-LONG-' + pressure, skipOpening: true, actors: [
    { id: 'a', name: '甲', seatId: 'seat_0', controller: 'human' },
    { id: 'b', name: '乙', seatId: 'seat_1', controller: 'human' },
  ] });
  state.story.currentScene = { sceneId: 's', locationId: 'camp', locationName: '营地', timeOfDay: '夜', pressure: pressure, deadline: null, visibleEntities: [], availableAssets: [], exits: [], activeThreadIds: [], sceneStatus: 'open' };
  return state;
}
async function main() {
  const unsafe = await makeState(2);
  let envelope = Story.Resolver.resolveTurn(unsafe, [Story.Intent.parseCustomText(unsafe, 'a', '闭关数月')]);
  ok('单人不能在多人高压回合直接闭关', envelope.actions[0].outcome === 'long_action_request', envelope.actions[0].outcome);
  ok('被拦截的长期行动不推进数月', envelope.elapsedTime.unit === '片刻', JSON.stringify(envelope.elapsedTime));

  const safe = await makeState(1);
  envelope = Story.Resolver.resolveTurn(safe, [Story.Intent.parseCustomText(safe, 'a', '闭关数月'), Story.Intent.parseCustomText(safe, 'b', '静修数月')]);
  ok('安全且全部真人同意时可长期行动', envelope.actions.every(function (a) { return a.outcome !== 'long_action_request'; }));
  ok('全员同意后 elapsedTime 为数月', envelope.elapsedTime.unit === '月', JSON.stringify(envelope.elapsedTime));

  const away = await makeState(3);
  away.actors[0].presence = 'away';
  envelope = Story.Resolver.resolveTurn(away, [Story.Intent.parseCustomText(away, 'a', '闭关数月')]);
  ok('away/offscreen 角色可单独执行长期行动', envelope.actions[0].outcome !== 'long_action_request');
  console.log('\nV3.4.1 long actions: ' + pass + ' passed / ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}
main().catch(function (error) { console.error(error); process.exitCode = 1; });
