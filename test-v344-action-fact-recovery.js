'use strict';

const fs = require('fs');
const path = require('path');
const Story = require('./story-core.js');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  OK ' + name);
    return;
  }
  failed++;
  console.error('  FAIL ' + name + (detail ? ' :: ' + detail : ''));
}

const sleepingChapter = `陆知微在试炼门前的石阶上寻了个避风的角落，将外袍裹紧，靠着廊柱缓缓阖上眼。她确实累了——三日前初到此界，一路奔波，连喘息的工夫都少有。阴云压得很低，院墙外偶尔传来几声夜鸟的啼叫，混着远处执事与几名修士交谈的模糊话音。她调整了一下姿势，让后背抵住粗粝的石面，呼吸渐渐平稳下来。

沈青萝从执事那边回来，瞥见蜷缩在阴影里的陆知微，脚步顿了顿。她没出声，只是将手里半凉的茶碗搁在陆知微身旁的台阶上，然后走开了。茶碗在青石板上磕出一声轻响，陆知微微微睁眼，看见碗沿冒着若有若无的热气，又合上了眼。

韩照野还在山门处与灰袍执事说话。顾长风站在几步外，手里捏着一枚刚领到的试炼令牌，翻来覆去地看，金属表面映着门缝漏出的烛光。他往陆知微这边扫了一眼，见她正睡觉，便没打扰，只把令牌收进袖中，继续听执事讲解试炼规矩。

大约一炷香的工夫，陆知微醒了过来。她揉了揉后颈，发现那碗茶已经凉透，但口渴得紧，还是端起来喝了一口。茶水带着粗涩的苦味，却让她精神了些。她站起身，抖了抖外袍上的灰尘，目光落向山门处——灰袍执事正将最后两枚木匣递出，韩照野和沈青萝各接过一枚，顾长风已经将自己的令牌挂在了腰间。

执事清了清嗓子，声音不高，却压过了院里的嘈杂：“试炼令牌已发完。领令者，子时前入试炼山道；逾时不候，令牌作废。”他合上木匣，转身走进门内，留下石阶上四人面面相觑。陆知微看了看手中的茶碗，又看了看山道入口处那扇半开的铁门，夜风从门缝里灌进来，带着泥土和铁锈的气味。`;

function legacyRestContract(outcome, outcomeLabel) {
  return {
    mustRenderFacts: [{
      factId: 'fact_action_0_actor_luzhiwei',
      kind: 'action',
      actorId: 'actor_luzhiwei',
      actorName: '陆知微',
      actionType: 'rest',
      actionText: '睡觉',
      targetType: 'self',
      targetId: 'self',
      targetName: 'self',
      outcome: outcome || 'quiet_success',
      outcomeLabel: outcomeLabel || '悄然成功',
      requiredMeaning: ['陆知微执行休息'],
      gains: ['精神稍有恢复。'],
      costs: [],
      agencyPolicy: { affectsOtherHuman: false },
    }],
  };
}

console.log('\n=== test-v344-action-fact-recovery ===');

const accepted = Story.Narration.validateActionFacts(
  { chapter: sleepingChapter },
  legacyRestContract()
);
check('旧存档 self 目标下，正文中的睡觉与醒来可通过事实闸门', accepted === null, JSON.stringify(accepted));

const missedOpportunity = Story.Narration.validateActionFacts(
  { chapter: sleepingChapter },
  legacyRestContract('missed_opportunity', '错失时机')
);
check('睡觉造成逾时作废时，正文可落实错失机会结果', missedOpportunity === null, JSON.stringify(missedOpportunity));

const missing = Story.Narration.validateActionFacts(
  { chapter: '陆知微站在试炼门前，始终清醒地观察来往修士。' },
  legacyRestContract()
);
check('确实没有睡觉时仍返回 MISSING_ACTION_FACT', missing && missing.code === 'MISSING_ACTION_FACT', JSON.stringify(missing));

const wrongOutcome = Story.Narration.validateActionFacts(
  { chapter: '陆知微靠着廊柱睡觉，片刻后仍旧疲惫不堪，未能得到任何恢复。' },
  legacyRestContract()
);
check('已写行动但结果错误时返回 WRONG_ACTION_OUTCOME', wrongOutcome && wrongOutcome.code === 'WRONG_ACTION_OUTCOME', JSON.stringify(wrongOutcome));

const travelState = Story.createEmptyState();
travelState.actors = [{ id: 'actor_luzhiwei', name: '陆知微', seatId: 'seat_0', controller: 'human' }];
travelState.story.currentScene = {
  sceneId: 'sect_gate', locationId: 'sect', locationName: '宗门', timeOfDay: '清晨', weather: '晴', pressure: 1,
  visibleEntities: [], availableAssets: [],
  exits: [{ id: 'exit_sect_gate', name: '山门', kind: 'exit', affordances: ['travel'] }],
};
Story._activateState(travelState);

const travelIntent = Story.Intent.parseCustomText(travelState, 'actor_luzhiwei', '离开宗门前往小镇吃饭');
check('自由移动解析保留显式目的地“小镇”', travelIntent.category === 'travel' && travelIntent.targetName === '小镇' && travelIntent.targetId !== 'nearest_exit', JSON.stringify(travelIntent));

const legacyTravelEnvelope = {
  turnId: 'turn_0002',
  elapsedTime: { value: 3, unit: '日' },
  actions: [{
    actorId: 'actor_luzhiwei', category: 'travel', source: 'custom', rawText: '离开宗门前往小镇吃饭',
    targetType: 'exit', targetId: 'nearest_exit', targetName: '最近出口', outcome: 'success',
    gains: [{ type: 'location', text: '抵达新地点。' }],
    costs: [{ type: 'time', text: '路途耗时数日。' }],
    publicEffects: ['陆知微动身前往下一处地点。'],
    targetResolution: { known: true, present: false, reachable: false },
  }],
  interactions: [], publicDelta: [], privateDelta: [],
  movementDecision: { targetId: 'nearest_exit', votes: 1, humanCount: 1, conflictingTargets: ['nearest_exit'], unanimous: true },
};
const travelContract = Story.Narration.buildTurnContract(travelState, legacyTravelEnvelope, null, travelState.story.currentScene);
const travelFact = travelContract.mustRenderFacts.find(function (fact) { return fact.kind === 'action'; });
check('已卡住的旧回合可从原始行动恢复小镇目标', legacyTravelEnvelope.actions[0].targetName === '小镇' && travelFact.targetName === '小镇', JSON.stringify(travelFact));
check('契约明确保留吃饭目的', travelFact.detailGroups && travelFact.detailGroups.some(function (group) { return group.label === '吃饭'; }), JSON.stringify(travelFact));
check('旧回合的移动决策同步迁移到恢复后的目的地', legacyTravelEnvelope.movementDecision.targetId === legacyTravelEnvelope.actions[0].targetId, JSON.stringify(legacyTravelEnvelope.movementDecision));

const travelAccepted = Story.Narration.validateActionFacts({
  chapter: '陆知微收拾好随身物件，离开宗门沿山路下行。日影偏西时，她来到镇上，在食肆点了热汤与饭菜，终于果腹。',
}, travelContract);
check('“来到镇上并用饭”的自然改写可通过行动事实闸门', travelAccepted === null, JSON.stringify(travelAccepted));

const travelPurposeMissing = Story.Narration.validateActionFacts({
  chapter: '陆知微离开宗门前往小镇，却没有吃饭，只在街口短暂停留。',
}, travelContract);
check('明确没有吃饭时仍拒绝复合行动', travelPurposeMissing && travelPurposeMissing.code === 'MISSING_ACTION_FACT', JSON.stringify(travelPurposeMissing));

const migratedScene = Story.Scene.composeNext(Story._clone(travelState), legacyTravelEnvelope);
check('旧回合提交后场景会落到小镇而不是“最近出口”', migratedScene.locationName === '小镇', JSON.stringify(migratedScene));

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
check('本地叙事重试通过当前房间协调器执行', html.includes('UI.room && UI.room.roomId && Room.coordinator.retryNarration'));
check('本地叙事重试不再引用不存在的 UI._room', !html.includes('UI._room && UI._room.roomId'));

console.log('Action fact recovery passed ' + passed + ' / failed ' + failed);
if (failed) process.exit(1);
