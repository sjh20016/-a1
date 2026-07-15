'use strict';

const Story = require('./story-core.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  OK ' + name); }
  else { failed++; console.error('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

function baseState() {
  const state = Story.createEmptyState();
  state.actors = [{ id: 'lu', name: '陆知微', seatId: 'seat_0', controller: 'human' }];
  state.story.currentScene = {
    sceneId: 'sect_gate', locationId: 'sect', locationName: '宗门', timeOfDay: '清晨', weather: '晴', pressure: 1,
    visibleEntities: [], availableAssets: [], exits: [],
  };
  Story._activateState(state);
  return state;
}

function travelBrief(state) {
  const action = {
    actorId: 'lu', category: 'travel', source: 'custom', rawText: '离开宗门前往小镇吃饭',
    targetType: 'exit', targetId: 'destination_town', targetName: '小镇', outcome: 'success',
    gains: [{ type: 'location', text: '抵达新地点。' }], costs: [{ type: 'time', text: '路途耗时数日。' }],
    publicEffects: ['陆知微动身前往小镇。'], timePassed: { value: 3, unit: '日' },
    targetResolution: { known: true, present: true, reachable: true },
  };
  const envelope = {
    turnId: 'turn_policy', sceneBeforeId: 'sect_gate', actions: [action], interactions: [],
    narrationBeats: [], publicDelta: [], privateDelta: [], elapsedTime: { value: 3, unit: '日' },
  };
  return Story.Narration.buildBrief(state, state.story.currentScene, envelope, null, state.story.currentScene);
}

async function main() {
  console.log('\n=== test-v344-validation-policy ===');

  check('未登记实体属于连续性记忆', Story.Narration.ValidationPolicy.level({ code: 'UNREGISTERED_ENTITY' }) === 'memory');
  check('行动表达缺失属于一次修复项', Story.Narration.ValidationPolicy.level({ code: 'MISSING_ACTION_FACT' }) === 'repair');
  check('行动目标冲突仍是硬阻断', Story.Narration.ValidationPolicy.level({ code: 'WRONG_ACTION_TARGET' }) === 'block');
  check('玩家自主权冲突仍是硬阻断', Story.Narration.ValidationPolicy.level({ code: 'PLAYER_AGENCY_VIOLATION' }) === 'block');

  const state = baseState();
  const brief = travelBrief(state);
  let calls = 0;
  const omittedActionChapter = [
    '陆知微仍在原处整理袖口，听旁人谈论晨间的风与院墙外渐渐热闹起来的声音。她没有说明接下来准备做什么，只把随身物件重新收拢。',
    '石阶上的光影缓慢移动，附近有人来往，也有人低声交换无关紧要的见闻。场面保持平静，没有新的伤势、奖励、线索或力量凭空出现。',
  ].join('\n\n');
  Story.setAIEnabled(true);
  Story.registerAIProvider({ narrate: async function () {
    calls++;
    return JSON.stringify({ title: '晨间停留', chapter: omittedActionChapter, dialogues: [], endingImage: '' });
  } }, { provider: 'policy-test', model: 'policy-test' });

  const accepted = await Story.Provider.narrate(state, brief);
  check('表达缺失只自动修复一次', calls === 2, String(calls));
  check('第二次仍未命中词面时不再卡死回合', !!accepted && accepted._validationPolicyApplied === true, JSON.stringify(accepted));
  check('被放行的表达偏差带有 MISSING_ACTION_FACT 告警', accepted && accepted._validationWarnings.some(function (warning) { return warning.code === 'MISSING_ACTION_FACT'; }), JSON.stringify(accepted && accepted._validationWarnings));
  check('告警写入连续性叙事记忆', state.story.narrativeContinuityMemory.observations.some(function (item) { return item.code === 'MISSING_ACTION_FACT'; }), JSON.stringify(state.story.narrativeContinuityMemory));

  const gateResult = Story.Narration.validatePublishGate(state, accepted, brief);
  check('已执行分层策略的修复项不会被第二道发布闸门再次拦截', gateResult === null, JSON.stringify(gateResult));

  const battleContract = {
    turnId: 'turn_battle', humanActorIds: ['attacker'], submittedHumanActorIds: ['attacker'],
    mustRenderFacts: [{
      factId: 'fact_attack', kind: 'action', actorId: 'attacker', actorName: '江北客', actionType: 'battle', actionText: '攻击飞猪',
      targetType: 'actor', targetId: 'target', targetName: '飞猪', outcome: 'partial_success', outcomeLabel: '部分成功',
      gains: [], costs: ['暴露敌意'], agencyPolicy: { affectsOtherHuman: true }, consequencePolicy: {},
    }],
    actorWhitelist: [{ id: 'attacker', name: '江北客' }, { id: 'target', name: '飞猪' }], entityWhitelist: [],
    canonicalScene: { locationName: '旧祠', timeOfDay: '清晨' }, elapsedTime: { value: 1, unit: '片刻' }, previousTurnSummary: '',
  };
  const battleBrief = { turnContract: battleContract, director: null, enforcePublishGate: true, qualityPlan: null };
  const wrongTarget = {
    title: '错位攻击',
    chapter: [
      '江北客突然攻击蒙面符修，剑锋虽然未完全命中，却仍逼得对方后退。既定目标站在远处，没有成为这次攻击的对象。院中的尘土被脚步扬起，众人都看清了出手的方向。灰瓦下积着昨夜雨水，兵刃掠过时带起一线冷光，石阶旁围观的人随即散开。',
      '蒙面符修退到廊柱后，抬手遮住面孔，江北客仍把剑尖朝向他，而不是本地裁决指定之人。晨雾越过残墙，旧祠里的木门被风吹得轻轻作响。真正目标始终没有承受这一击，攻击方向和既定目标形成了清楚冲突，其他环境描写也没有改变这一事实。',
      '片刻之后，江北客收住脚步，蒙面符修也没有继续逼近。院落恢复短暂安静，所有人仍停留在原来的位置，时间没有异常跳跃，也没有额外奖励、伤势、线索或超自然力量凭空出现。',
    ].join('\n\n'),
    _validationPolicyApplied: true,
  };
  const hardBlock = Story.Narration.validatePublishGate(state, wrongTarget, battleBrief);
  check('明确写错攻击目标时发布闸门仍然阻断', hardBlock && hardBlock.code === 'WRONG_ACTION_TARGET', JSON.stringify(hardBlock));

  const memoryContract = {
    turnId: 'turn_memory', isOpening: true, humanActorIds: [], submittedHumanActorIds: [], mustRenderFacts: [],
    actorWhitelist: [], entityWhitelist: [], optionalAtmosphere: [], canonicalScene: { locationName: '山道', timeOfDay: '清晨' },
    elapsedTime: { value: 1, unit: '片刻' }, previousTurnSummary: '',
  };
  const memoryBrief = { turnContract: memoryContract, director: null, enforcePublishGate: false, qualityPlan: null };
  const incidentalEntity = {
    title: '山道偶遇',
    chapter: '清晨的山道上，三眼青狼的影子只在远处林边一闪，并未接近任何人，也没有形成战斗、奖励、伤势或新的持久线索。路旁挑担的行人继续赶路，茶摊主人收起昨夜留下的灯罩。这些短暂景物只构成沿途气氛，不改变角色位置、状态和本地裁决。',
  };
  const memoryOnly = Story.Narration.blockingViolation(state, Story.Narration.validateCanonicalClaims(incidentalEntity, memoryContract), memoryBrief);
  check('无状态影响的未登记描写只形成记忆告警', memoryOnly === null, JSON.stringify(memoryOnly));
  check('连续性记忆保留未登记实体观察', state.story.narrativeContinuityMemory.observations.some(function (item) { return item.code === 'UNREGISTERED_ENTITY'; }));

  const publicContext = Story.Narration.buildPublicContext(state, brief, brief.projectedState, brief.qualityPlan);
  check('AI 上下文明示连续性记录只是指导', publicContext.constraints.continuityMemoryIsGuidance === true);
  check('AI 上下文携带最近连续性观察', Array.isArray(publicContext.continuityMemory) && publicContext.continuityMemory.length > 0);

  console.log('Validation policy passed ' + passed + ' / failed ' + failed);
  if (failed) process.exit(1);
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
