const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('✓ ' + name); }
  else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); }
}
async function main() {
  const state = await Story.createSession({ seed: 'V341-REPEAT-PVP', skipOpening: true, pvpMode: 'dramatic', actors: [
    { id: 'a', name: '飞猪', seatId: 'seat_0', controller: 'human' },
    { id: 'c', name: '江北客', seatId: 'seat_1', controller: 'human' },
  ] });
  state.story.currentScene = { sceneId: 's', locationId: 'yard', locationName: '院落', timeOfDay: '夜', pressure: 1, deadline: null, visibleEntities: [], availableAssets: [], exits: [], activeThreadIds: [], sceneStatus: 'open' };
  const attacks = [];
  for (let i = 0; i < 3; i++) {
    const envelope = Story.Resolver.resolveTurn(state, [Story.Intent.parseCustomText(state, 'c', '攻击玩家A')]);
    attacks.push(envelope.actions[0]);
    Story.Behavior.commitFromEnvelope(state, envelope);
  }
  ok('三轮始终攻击飞猪', attacks.every(function (a) { return a.targetActorId === 'a' && a.targetName === '飞猪'; }));
  ok('第2次冲突升级', attacks[1].interactionTags.indexOf('escalating_pvp') >= 0);
  ok('第3次记录 repeatedTargetCount=3', attacks[2].repetition.repeatedTargetCount === 3, JSON.stringify(attacks[2].repetition));
  ok('升级冲突增加 hostility', attacks[2].actorStatusDeltas.filter(function (d) { return d.key === 'hostility'; }).length >= 2);
  console.log('\nV3.4.1 repeated PvP: ' + pass + ' passed / ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}
main().catch(function (error) { console.error(error); process.exitCode = 1; });
