const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) { if (condition) { pass++; console.log('✓ ' + name); } else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); } }
async function main() {
  const state = await Story.createSession({ seed: 'V341-CONTRACT', skipOpening: true, actors: [
    { id: 'a', name: '飞猪', seatId: 'seat_0', controller: 'human' },
    { id: 'b', name: '沈青萝', seatId: 'seat_1', controller: 'human' },
    { id: 'bot', name: '守护者', seatId: 'seat_2', controller: 'bot' },
  ] });
  const scene = { sceneId: 's', locationId: 'realm', locationName: '秘境入口', timeOfDay: '清晨', weather: '雾', pressure: 2, visibleEntities: [{ id: 'rift', name: '秘境裂隙', kind: 'clue' }], availableAssets: [{ id: 'key', name: '残缺钥印', kind: 'relic' }], exits: [], activeThreadIds: [] };
  state.story.currentScene = scene;
  state.story.activeThreads = [{ threadId: 'pub', title: '裂隙封印', visibility: 'public', status: 'active' }, { threadId: 'secret', title: '隐秘真相', visibility: 'private', status: 'active' }];
  const envelope = {
    turnId: 'turn_0001', sceneBeforeId: 's', elapsedTime: { value: 1, unit: '夜' },
    actions: [
      { actorId: 'a', category: 'rest', source: 'custom', rawText: '继续睡觉', targetType: 'self', targetId: 'a', targetName: '飞猪', outcome: 'interrupted', gains: [], costs: [{ text: '休息被打断' }], publicEffects: ['飞猪的休息被打断。'] },
      { actorId: 'b', category: 'investigate', source: 'custom', rawText: '调查裂隙', targetType: 'clue', targetId: 'rift', targetName: '秘境裂隙', outcome: 'success', gains: [{ text: '确认封印受损' }], costs: [], publicEffects: [] },
      { actorId: 'bot', category: 'observe', source: 'choice', rawText: '观察', targetType: 'clue', targetId: 'rift', targetName: '秘境裂隙', outcome: 'success', gains: [], costs: [], publicEffects: [] },
    ],
    interactions: [{ interactionId: 'i', type: 'attack_sleeping_actor', actorIds: ['bot', 'a'], targetId: 'a', requiredNarrativeFacts: ['守护者攻击飞猪', '飞猪的休息被打断'] }],
  };
  const contract = Story.Narration.buildTurnContract(state, envelope, { result: 'bend' }, scene);
  ok('契约版本与 turnId 正确', contract.contractVersion === '1.2' && contract.turnId === 'turn_0001');
  ok('每个真人行动各有事实', contract.mustRenderFacts.filter(function (f) { return f.kind === 'action'; }).length === 2);
  ok('Bot 单人行动不占真人行动事实', !contract.mustRenderFacts.some(function (f) { return f.kind === 'action' && f.actorId === 'bot'; }));
  ok('交互另生成一项事实', contract.mustRenderFacts.some(function (f) { return f.kind === 'interaction' && f.interactionType === 'attack_sleeping_actor'; }));
  ok('裂隙与公开线索进入实体白名单', contract.entityWhitelist.some(function (e) { return e.id === 'rift'; }) && contract.entityWhitelist.some(function (e) { return e.id === 'pub'; }));
  ok('私密线索不进入白名单', !contract.entityWhitelist.some(function (e) { return e.id === 'secret'; }));
  ok('统一 elapsedTime 进入契约', contract.elapsedTime.unit === '夜');
  console.log('\nV3.4.1 contract: ' + pass + ' passed / ' + fail + ' failed'); if (fail) process.exitCode = 1;
}
main().catch(function (error) { console.error(error); process.exitCode = 1; });
