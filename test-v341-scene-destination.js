const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) { if (condition) { pass++; console.log('✓ ' + name); } else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); } }
function state() {
  const s = Story.createEmptyState();
  s.actors = [
    { id: 'a', name: '甲', controller: 'human', presence: 'present', locationId: 'realm_gate', relationships: {} },
    { id: 'b', name: '乙', controller: 'human', presence: 'present', locationId: 'realm_gate', relationships: {} },
    { id: 'c', name: '丙', controller: 'human', presence: 'present', locationId: 'realm_gate', relationships: {} },
  ];
  s.story.currentScene = { sceneId: 'gate', locationId: 'realm_gate', locationName: '秘境裂隙入口', templateId: 'sealed_realm_gate', timeOfDay: '清晨', weather: '雾', pressure: 2, deadline: null, visibleEntities: [{ id: 'seal', name: '封印', kind: 'clue' }], availableAssets: [], exits: [{ id: 'exit_realm_depth', name: '裂隙深处', kind: 'exit', affordances: ['travel', 'investigate'], destination: { locationId: 'realm_inner_gate', locationName: '秘境内门断层', templateId: 'sealed_realm_inner', visibleEntities: [{ id: 'inner_seal', name: '内门封石', kind: 'clue' }] } }] };
  return s;
}
function move(actorId) { return { actorId: actorId, category: 'travel', targetId: 'exit_realm_depth', targetName: '裂隙深处', outcome: 'success', gains: [], costs: [], relationEffects: [], threadEffects: [], timePassed: { value: 1, unit: '片刻' } }; }
function main() {
  const s = state();
  const exit = Story.Scene.Entity.normalize(s.story.currentScene.exits)[0];
  const destination = Story.SceneTransition.resolveDestination(s, move('a'), exit);
  ok('出口 destination 被原样解析', destination.locationId === 'realm_inner_gate' && destination.templateId === 'sealed_realm_inner', JSON.stringify(destination));
  const envelope = { actions: [move('a'), move('b')], elapsedTime: { value: 1, unit: '片刻' }, sceneBeforeId: 'gate', worldDelta: {}, interactions: [] };
  const next = Story.Scene.composeNext(s, envelope);
  ok('多数同出口时进入 destination', next.locationId === 'realm_inner_gate' && next.locationName === '秘境内门断层', JSON.stringify(next));
  ok('场景实体来自 destination 模板', next.visibleEntities.some(function (e) { return e.id === 'inner_seal'; }));
  ok('新场景不再注入车辙/残剑/古道', JSON.stringify(next).indexOf('车辙') < 0 && JSON.stringify(next).indexOf('残剑') < 0 && JSON.stringify(next).indexOf('古道') < 0);
  console.log('\nV3.4.1 scene destination: ' + pass + ' passed / ' + fail + ' failed'); if (fail) process.exitCode = 1;
}
main();
