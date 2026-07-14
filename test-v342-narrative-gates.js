const Story = require('./story-core.js');

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('✓ ' + name); }
  else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); }
}

async function main() {
  const state = await Story.createSession({ seed: 'V342-GATES', skipOpening: true, actors: [
    { id: 'a', name: '阿悟', seatId: 'seat_0', controller: 'human' },
    { id: 'b', name: '阿萝', seatId: 'seat_1', controller: 'human' },
    { id: 'c', name: '阿客', seatId: 'seat_2', controller: 'human' },
  ] });
  state.story.currentScene = {
    sceneId: 'survey', locationId: 'survey_yard', locationName: '灵脉测绘场', timeOfDay: '清晨', weather: '雾', pressure: 2,
    visibleEntities: [{ id: 'ent_broker', name: '矿脉掮客', kind: 'npc' }],
    availableAssets: [], exits: [{ id: 'exit_to_latrine', name: '茅房', kind: 'exit', destination: { locationId: 'latrine', locationName: '茅房' } }],
  };
  state.story.activeThreads = [
    { threadId: 'public_thread', title: '公开测绘线', visibility: 'public', status: 'active', stage: 1 },
    { threadId: 'private_thread', title: '隐藏命数', visibility: 'private', status: 'active', stage: 1 },
    { threadId: 'dormant_thread', title: '沉睡线', visibility: 'public', status: 'dormant', stage: 1 },
  ];
  state.story.currentChapter = { title: '上一章', chapter: '上一章正文', canonicalSummary: '公共摘要：众人在测绘场停留。' };

  const envelope = {
    turnId: 'turn_0002', sceneBeforeId: 'survey', elapsedTime: { value: 1, unit: '片刻' },
    actions: [
      { actorId: 'a', category: 'freeform', source: 'custom', rawText: '在灶边煮面', targetType: 'self', targetId: 'a', targetName: '阿悟', outcome: 'success', gains: [], costs: [{ type: 'time', text: '耽误少量时间。' }], publicEffects: ['灶火和面香引来旁观。'] },
      { actorId: 'b', category: 'social', source: 'custom', rawText: '尝试拉住阿悟跳舞', targetType: 'actor', targetId: 'a', targetName: '阿悟', outcome: 'setback', gains: [], costs: [{ type: 'relation', text: '对方没有被强迫改变行动。' }], publicEffects: ['阿萝尝试拉住阿悟。'] },
      { actorId: 'c', category: 'travel', source: 'custom', rawText: '冲向敌人，中途突然转弯跑去茅房', targetType: 'exit', targetId: 'exit_to_latrine', targetName: '茅房', outcome: 'success', gains: [], costs: [{ type: 'action_reversal', text: '起始攻击没有完成。' }], publicEffects: ['阿客中途转向茅房。'], actionSequence: { transitions: [{ from: 'battle', to: 'travel' }], abortedIntents: [{ text: '冲向敌人', category: 'battle' }], finalIntent: { text: '跑去茅房', category: 'travel' } } },
    ],
    interactions: [{ interactionId: 'interaction_1', type: 'contested_pull', actorIds: ['b', 'a'], targetId: 'a', requiredNarrativeFacts: ['阿萝尝试拉住阿悟，但阿悟仍保有自己的行动选择'] }],
    publicDelta: [], privateDelta: [], narrationBeats: [],
  };
  const contract = Story.Narration.buildTurnContract(state, envelope, null, state.story.currentScene);
  const quality = Story.Narration.buildQualityPlan(state, contract, { scene: state.story.currentScene });
  const brief = Story.Narration.buildBrief(state, state.story.currentScene, envelope, null, state.story.currentScene);
  const ctx = Story.Provider._briefToCtx(state, brief);
  const serialized = JSON.stringify(ctx);

  ok('三名真人均进入行动事实', contract.humanActionFacts.length === 3);
  ok('合同记录真人提交与事实 ID', contract.submittedHumanActorIds.length === 3 && contract.actionFactIds.length === 3);
  ok('质量计划有主次、段落和动态篇幅', quality.primaryFactIds.length === 1 && quality.paragraphPlan.length >= 3 && quality.targetLength.minChars >= 600);
  ok('公共上下文移除 envelope', serialized.indexOf('_envelope') < 0 && serialized.indexOf('privateDelta') < 0);
  ok('公共上下文不含隐藏线程', serialized.indexOf('private_thread') < 0 && serialized.indexOf('dormant_thread') < 0);
  ok('公共上下文保留公开线程和上一章摘要', serialized.indexOf('public_thread') >= 0 && serialized.indexOf('公共摘要') >= 0);

  const incomplete = Story.Narration.validateTurnContractCompleteness(Object.assign({}, contract, { submittedHumanActorIds: ['a', 'b'] }));
  ok('遗漏真人行动在请求 AI 前被阻断', incomplete && incomplete.code === 'NARRATIVE_CONTRACT_INCOMPLETE');

  const sequence = Story.Intent.parseActionSequence(state, 'c', '冲向敌人，中途突然转弯跑去茅房');
  ok('复合行动拆出转折和最终行动', sequence.abortedIntents.length === 1 && sequence.finalIntent.category === 'travel');

  const absent = Story.Intent.parseCustomText(state, 'a', '拦截女掌柜查账本');
  ok('不在场目标标记为不可达', absent.targetKnown === true && absent.targetPresent === false && absent.targetReachable === false);

  const agency = Story.Narration.validatePlayerAgency({ chapter: '阿萝强迫阿悟跟着自己走，阿悟只能放弃本轮行动。' }, contract);
  ok('强制控制真人被拒绝', agency && agency.code === 'PLAYER_AGENCY_VIOLATION');

  const agencyAllowed = Story.Narration.validatePlayerAgency({ chapter: '阿萝攻击阿悟，攻势迫使旁观者确认阿悟仍能自行选择；阿萝没有替阿悟接受任何决定。' }, contract);
  ok('旁观者受影响和明确否定控制不会误报自主权', agencyAllowed === null);

  const pullFact = contract.mustRenderFacts.find(function (fact) { return fact.kind === 'action' && fact.actorId === 'b'; });
  const distantMention = '阿萝先在远处看了一眼。' + '石壁上的旧刻痕只记录风向与水汽，没有改变任何人的本轮选择。'.repeat(8) + '\n\n阿萝尝试拉住阿悟跳舞，但阿悟拒绝，阿萝因此受挫。';
  const localWindow = Story.Narration.validateActionFacts({ chapter: distantMention }, { mustRenderFacts: [pullFact], actorWhitelist: contract.actorWhitelist });
  ok('局部事实窗口选择真正行动段而非人物首次提及', localWindow === null, localWindow && localWindow.message);

  const consequence = Story.Narration.validateConsequenceBudget({ chapter: '阿悟在煮面时天道回应，面汤浮现灵脉地图。' }, contract);
  ok('荒诞行动不能凭空获得超自然奖励', consequence && ['UNAUTHORIZED_SUPERNATURAL_EFFECT', 'UNAUTHORIZED_CLUE'].indexOf(consequence.code) >= 0);

  const interaction = Story.Narration.validateInteractionFacts({ chapter: '阿萝伸手拉住阿悟，阿悟没有被迫改变自己的行动选择。' }, contract);
  ok('强制互动必须单独覆盖', interaction === null);

  const short = Story.Narration.validateChapterCompleteness({ title: '短章', chapter: '阿悟煮面。' }, contract);
  ok('短章不能发布', short && short.code === 'NARRATION_TOO_SHORT');

  console.log('\nV3.4.2 narrative gates: ' + pass + ' passed / ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
