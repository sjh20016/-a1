const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) { if (condition) { pass++; console.log('✓ ' + name); } else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); } }
async function main() {
  const state = await Story.createSession({ seed: 'V341-REPAIR', skipOpening: true, actors: [
    { id: 'a', name: '飞猪', seatId: 'seat_0', controller: 'human' },
    { id: 'c', name: '江北客', seatId: 'seat_1', controller: 'human' },
  ] });
  state.story.currentScene = { sceneId: 's', locationId: 'yard', locationName: '旧祠', timeOfDay: '清晨', weather: '雾', pressure: 1, visibleEntities: [], availableAssets: [], exits: [] };
  const action = { actorId: 'c', category: 'battle', source: 'custom', rawText: '试图攻击玩家A', targetType: 'actor', targetId: 'a', targetName: '飞猪', outcome: 'partial_success', gains: [], costs: [{ text: '暴露敌意' }], publicEffects: ['江北客攻击飞猪，攻势未完全命中。'], timePassed: { value: 1, unit: '片刻' } };
  const envelope = { turnId: 'turn_0001', sceneBeforeId: 's', actions: [action], interactions: [], narrationBeats: [], publicDelta: [], privateDelta: [], elapsedTime: { value: 1, unit: '片刻' } };
  const brief = Story.Narration.buildBrief(state, state.story.currentScene, envelope, null, state.story.currentScene);
  let calls = 0;
  let correctionSeen = false;
  Story.setAIEnabled(true);
  Story.registerAIProvider({ narrate: async function (ctx) {
    calls++;
    if (calls === 1) return JSON.stringify({ title: '错误目标', chapter: '江北客攻击蒙面符修，攻势未完全命中，庭院里的风声因此一紧。', dialogues: [], endingImage: '' });
    correctionSeen = !!ctx.protocolCorrection && ctx.protocolCorrection.previousErrors.some(function (e) { return e.code === 'WRONG_ACTION_TARGET' || e.code === 'UNREGISTERED_ENTITY'; });
    return JSON.stringify({ title: '沉睡者与袭击者', chapter: '江北客主动攻击飞猪，剑锋在石阶前偏开，攻势未完全命中。飞猪闻声立即起身，原本的休息节奏被打断；江北客也因出手而暴露了敌意。', dialogues: [], endingImage: '' });
  } }, { provider: 'semantic-test', model: 'semantic-test' });
  const narration = await Story.Provider.narrate(state, brief);
  ok('语义失败只自动修复一次', calls === 2, String(calls));
  ok('第二次请求带 protocolCorrection', correctionSeen);
  ok('修复后章节被接受', narration && narration.chapter.indexOf('攻击飞猪') >= 0, JSON.stringify(narration));
  console.log('\nV3.4.1 semantic repair: ' + pass + ' passed / ' + fail + ' failed'); if (fail) process.exitCode = 1;
}
main().catch(function (error) { console.error(error); process.exitCode = 1; });
