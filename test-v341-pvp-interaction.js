const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('✓ ' + name); }
  else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function scene() {
  return { sceneId: 'scene_pvp', locationId: 'yard', locationName: '庭院', timeOfDay: '夜', weather: '晴', pressure: 1, deadline: null, visibleEntities: [], availableAssets: [], exits: [], activeThreadIds: [], sceneStatus: 'open' };
}
async function makeState(mode) {
  const state = await Story.createSession({ seed: 'V341-PVP-' + mode, skipOpening: true, pvpMode: mode, actors: [
    { id: 'feizhu', name: '飞猪', seatId: 'seat_0', controller: 'human' },
    { id: 'qingluo', name: '沈青萝', seatId: 'seat_1', controller: 'human' },
    { id: 'jiang', name: '江北客', seatId: 'seat_2', controller: 'human' },
  ] });
  state.story.currentScene = scene();
  state.actors.forEach(function (actor) { actor.locationId = 'yard'; });
  return state;
}

async function main() {
  const state = await makeState('dramatic');
  const intents = [
    Story.Intent.parseCustomText(state, 'feizhu', '继续睡觉'),
    Story.Intent.parseCustomText(state, 'qingluo', '观察周围'),
    Story.Intent.parseCustomText(state, 'jiang', '试图攻击玩家A'),
  ];
  const envelope = Story.Resolver.resolveTurn(state, intents);
  const attack = envelope.actions.find(function (action) { return action.actorId === 'jiang'; });
  const rest = envelope.actions.find(function (action) { return action.actorId === 'feizhu'; });
  ok('攻击动态目标为飞猪', attack.targetActorId === 'feizhu' && attack.targetName === '飞猪', JSON.stringify(attack));
  ok('PvP 返回规定 outcome', ['success', 'partial_success', 'setback'].indexOf(attack.outcome) >= 0, attack.outcome);
  ok('PvP 带 hostile 交互标签', attack.interactionTags.indexOf('pvp') >= 0 && attack.interactionTags.indexOf('hostile') >= 0);
  ok('双向 suspicion 关系变化存在', attack.relationEffects.some(function (r) { return r.actorId === 'jiang' && r.targetId === 'feizhu'; }) && attack.relationEffects.some(function (r) { return r.actorId === 'feizhu' && r.targetId === 'jiang'; }));
  ok('休息者被攻击后 interrupted', rest.outcome === 'interrupted', rest.outcome);
  ok('被攻击者本轮恢复被撤销', !rest.actorStatusDeltas.some(function (d) { return d.delta < 0 || (d.key === 'spirit' && d.delta > 0); }));
  ok('交互包含 attack_sleeping_actor', envelope.interactions.some(function (i) { return i.type === 'attack_sleeping_actor' && i.targetId === 'feizhu'; }));
  ok('目标状态 Delta 指向飞猪', envelope.publicDelta.some(function (d) { return d.op === 'UPDATE_ACTOR_STATUS' && d.target.actorId === 'feizhu'; }));

  const off = await makeState('off');
  const offEnvelope = Story.Resolver.resolveTurn(off, [Story.Intent.parseCustomText(off, 'jiang', '攻击玩家A')]);
  ok('pvpMode=off 制止攻击', offEnvelope.actions[0].outcome === 'stalemate');

  console.log('\nV3.4.1 PvP: ' + pass + ' passed / ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}
main().catch(function (error) { console.error(error); process.exitCode = 1; });
