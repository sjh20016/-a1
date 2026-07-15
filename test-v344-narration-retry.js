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

function completeOpeningChapter(ctx) {
  const groups = ctx && ctx.brief && ctx.brief.openingAnchorGroups || {};
  const anchors = Object.keys(groups).reduce(function (all, key) {
    return all.concat(groups[key] || []);
  }, []).filter(Boolean);
  const anchorText = anchors.join('、') || '开局场景';
  const paragraph = anchorText + '就在众人眼前铺开。脚步、视线与近处器物的细微变化彼此牵连，所有人都先确认了所在位置，再判断眼前冲突会把局势推向何处。没有人凭空获得力量，也没有尚未发生的结果被提前写定。';
  return [paragraph, paragraph, paragraph, paragraph, paragraph].join('\n\n');
}

async function main() {
  console.log('\n=== test-v344-narration-retry ===');

  let calls = 0;
  let retryContext = null;
  Story.setAIEnabled(true);
  Story.registerAIProvider({
    narrate: async function (ctx) {
      calls++;
      if (calls === 1) {
        return JSON.stringify({ title: '过短开局', chapter: '众人抵达此地，先看清周围道路与近处器物，再谨慎判断眼前异象的来处。', dialogues: [], endingImage: '', audit: { mentionedEntities: [], coveredFactIds: [] } });
      }
      retryContext = ctx;
      return JSON.stringify({ title: '完整开局', chapter: completeOpeningChapter(ctx), dialogues: [], endingImage: '', audit: { mentionedEntities: [], coveredFactIds: [] } });
    },
  }, { provider: 'server-test', model: 'test', enforcePublishGate: true, skipSemanticValidation: true });

  const state = await Story.createSession({
    seed: 'V344-OPENING-RETRY',
    skipOpening: true,
    narrativeProfile: 'immersive',
    actors: [{ id: 'a', name: '试行者', identity: '散修', daoPath: '剑修', publicWish: '查明异象', hiddenFate: '旧约', seatId: 'seat_0', controller: 'human' }],
  });

  await Story._generateOpening(state);
  const firstPending = state.story.pendingResolution;
  const floor = firstPending && firstPending.qualityPlan && firstPending.qualityPlan.targetLength.publishFloorChars;
  check('过短开局被发布闸门拦截', state.story.turnPhase === 'narration_failed' && firstPending.lastNarrationError.code === 'NARRATION_TOO_SHORT', JSON.stringify(firstPending && firstPending.lastNarrationError));
  check('开局契约允许零真人提交行动', !!firstPending && Story.Narration.validateTurnContractCompleteness(Story.Narration.buildTurnContract(state, firstPending.envelope, null, state.story.currentScene)) === null);

  await Story.retryNarration(state);
  check('手动重试携带上次错误', retryContext && retryContext.protocolCorrection && retryContext.protocolCorrection.previousErrors[0].code === 'NARRATION_TOO_SHORT', JSON.stringify(retryContext && retryContext.protocolCorrection));
  check('手动重试携带最低字数修复要求', retryContext && retryContext.protocolCorrection.requiredRepairs[0].indexOf(String(floor)) >= 0);
  check('提示词明确硬性最低字数', Story.Narration.buildUserPrompt(retryContext).indexOf('不得少于 ' + floor + ' 字') >= 0);
  check('完整开局重试后成功提交', state.story.turnPhase === 'collecting' && !state.story.pendingResolution && state.story.currentChapter && state.story.currentChapter.chapter.replace(/\s/g, '').length >= floor);

  const incomplete = Story.Narration.validateTurnContractCompleteness({
    isOpening: false,
    turnId: 'turn_0002',
    humanActorIds: ['a', 'b'],
    submittedHumanActorIds: ['a'],
    mustRenderFacts: [{ kind: 'action', actorId: 'a', factId: 'fact_a' }],
  });
  check('普通回合缺少真人行动仍被拒绝', incomplete && incomplete.code === 'NARRATIVE_CONTRACT_INCOMPLETE', JSON.stringify(incomplete));

  console.log('Narration retry regression passed ' + passed + ' / failed ' + failed);
  if (failed) process.exit(1);
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
