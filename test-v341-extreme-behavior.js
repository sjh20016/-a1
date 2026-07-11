/* 永久回归夹具：10 回合连续休息 + 连续攻击玩家A。 */
const fs = require('fs');
const path = require('path');
const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) { if (condition) { pass++; console.log('✓ ' + name); } else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); } }
async function main() {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-fixtures', 'extreme-behavior-001.json'), 'utf8'));
  const actorIds = { A: 'feizhu', B: 'shen', C: 'jiang' };
  const state = await Story.createSession({ seed: 'V341-EXTREME', skipOpening: true, pvpMode: 'dramatic', actors: fixture.actors.map(function (entry, index) {
    return { id: actorIds[entry.seat], name: entry.name, seatId: 'seat_' + index, controller: entry.controller };
  }) });
  state.story.currentScene = { sceneId: 'realm_gate', locationId: 'realm_gate', locationName: '秘境裂隙入口', timeOfDay: '夜', weather: '雾', pressure: 1, deadline: null, visibleEntities: [{ id: 'rift', name: '秘境裂隙', kind: 'clue' }], availableAssets: [], exits: [], activeThreadIds: [], sceneStatus: 'open' };
  state.actors.forEach(function (actor) { actor.locationId = 'realm_gate'; });
  const initialTime = state.story.currentScene.timeOfDay;
  let lastEnvelope;
  let bActionCount = 0;
  for (let round = 0; round < fixture.rounds; round++) {
    const intents = [
      Story.Intent.parseCustomText(state, 'feizhu', '继续睡觉'),
      Story.Intent.parseCustomText(state, 'shen', round % 2 ? '调查秘境裂隙' : '观察秘境裂隙'),
      Story.Intent.parseCustomText(state, 'jiang', '试图攻击玩家A'),
    ];
    const envelope = Story.Resolver.resolveTurn(state, intents);
    const attack = envelope.actions.find(function (action) { return action.actorId === 'jiang'; });
    const rest = envelope.actions.find(function (action) { return action.actorId === 'feizhu'; });
    if (envelope.actions.some(function (action) { return action.actorId === 'shen'; })) bActionCount++;
    ok('第' + (round + 1) + '回合攻击目标始终为飞猪', attack.targetActorId === 'feizhu' && attack.targetName === '飞猪');
    ok('第' + (round + 1) + '回合飞猪休息被打断', rest.outcome === 'interrupted');
    Story.Delta.applyEnvelope(state, envelope);
    state.story.currentScene = Story.Scene.composeNext(state, envelope);
    Story.Behavior.commitFromEnvelope(state, envelope);
    lastEnvelope = envelope;
  }
  ok('沈青萝 10 回合行动全部进入裁决', bActionCount === 10, String(bActionCount));
  ok('连续休息在第3次后无恢复收益', !lastEnvelope.actions.find(function (a) { return a.actorId === 'feizhu'; }).actorStatusDeltas.some(function (d) { return d.delta < 0 || (d.key === 'spirit' && d.delta > 0); }));
  ok('连续 PvP 升级至第10次', lastEnvelope.actions.find(function (a) { return a.actorId === 'jiang'; }).repetition.repeatedTargetCount === 10);
  ok('双方戒备关系已恶化', state.actors.find(function (a) { return a.id === 'jiang'; }).relationships.feizhu.suspicion > 0 && state.actors.find(function (a) { return a.id === 'feizhu'; }).relationships.jiang.suspicion > 0);
  ok('场景时间不再停在初始夜色', state.story.currentScene.timeOfDay !== initialTime, state.story.currentScene.timeOfDay);
  const contract = Story.Narration.buildTurnContract(state, lastEnvelope, null, state.story.currentScene);
  const bad = { title: '错误章', chapter: '江北客攻击蒙面符修，一只三眼青狼从深夜中加入战斗，数月后他们才停手。' };
  ok('替换玩家目标会被拒绝', !!Story.Narration.validateActionFacts(bad, contract));
  ok('新增蒙面敌人/妖狼会被拒绝', Story.Narration.validateCanonicalClaims(bad, contract).code === 'UNREGISTERED_ENTITY');
  ok('片刻/一夜被写成数月会被拒绝', Story.Narration.validateTemporalConsistency(bad, contract).code === 'TEMPORAL_CONTRADICTION');
  console.log('\nV3.4.1 extreme fixture: ' + pass + ' passed / ' + fail + ' failed'); if (fail) process.exitCode = 1;
}
main().catch(function (error) { console.error(error); process.exitCode = 1; });
