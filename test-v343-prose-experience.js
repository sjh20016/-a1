const Story = require('./story-core.js');

let passed = 0;
function ok(name, condition, detail) {
  if (!condition) throw new Error(name + (detail ? ': ' + detail : ''));
  passed++;
  console.log('✓ ' + name);
}

async function main() {
  const state = await Story.createSession({ seed: 'V343-PROSE', skipOpening: true, narrativeProfile: 'balanced', actors: [
    { id: 'a', name: '阿悟', seatId: 'seat_0', controller: 'human' },
    { id: 'b', name: '阿萝', seatId: 'seat_1', controller: 'human' },
    { id: 'c', name: '阿客', seatId: 'seat_2', controller: 'human' },
  ] });
  state.story.currentScene = {
    sceneId: 'survey', locationId: 'survey_yard', locationName: '灵脉测绘场', timeOfDay: '清晨', weather: '薄雾', pressure: 2,
    visibleEntities: [{ id: 'map', name: '灵脉测绘图', kind: 'clue' }], availableAssets: [], exits: [],
  };
  state.actors.forEach(function (actor) { actor.locationId = 'survey_yard'; actor.presence = 'present'; });
  const envelope = {
    turnId: 'turn_0002', sceneBeforeId: 'survey', elapsedTime: { value: 1, unit: '片刻' },
    actions: [
      { actorId: 'a', category: 'investigate', source: 'choice', rawText: '调查灵脉测绘图', targetId: 'map', targetName: '灵脉测绘图', outcome: 'success', gains: [], costs: [], publicEffects: ['阿悟确认一处可公开的刻度偏差。'] },
      { actorId: 'b', category: 'battle', source: 'custom', rawText: '攻击阿悟', targetType: 'actor', targetId: 'a', targetName: '阿悟', outcome: 'setback', gains: [], costs: [{ type: 'relation', text: '双方戒备上升。' }], publicEffects: ['阿萝的攻击没有替阿悟作出选择。'] },
      { actorId: 'c', category: 'freeform', source: 'custom', rawText: '在地上画一只云猪', targetType: 'self', targetId: 'c', targetName: '阿客', outcome: 'success', gains: [], costs: [{ type: 'time', text: '浪费少量时间。' }], publicEffects: ['纸上只留下普通墨迹。'] },
    ],
    interactions: [{ interactionId: 'pvp_1', type: 'pvp_attack', actorIds: ['b', 'a'], targetId: 'a', requiredNarrativeFacts: ['阿萝攻击阿悟，但阿悟仍保有自身选择'] }],
    publicDelta: [], privateDelta: [{ actorId: 'a', secret: '不应公开' }], narrationBeats: [],
  };
  const contract = Story.Narration.buildTurnContract(state, envelope, null, state.story.currentScene);
  contract.mustRenderFacts[0].privateGains = ['隐藏刻度'];
  const projected = Story.Narration.buildProjectedState(state, state, envelope, state.story.currentScene);

  state.settings.narrativeProfile = 'concise';
  const concise = Story.Narration.buildQualityPlan(state, contract, projected);
  state.settings.narrativeProfile = 'balanced';
  const balanced = Story.Narration.buildQualityPlan(state, contract, projected);
  state.settings.narrativeProfile = 'immersive';
  const immersive = Story.Narration.buildQualityPlan(state, contract, projected);

  ok('文案档位采用版本化标识', immersive.proseProfile.id === 'immersive-v1' && immersive.qualityPlanVersion === '1.1');
  ok('沉浸档理想篇幅高于均衡与凝练', immersive.targetLength.idealChars > balanced.targetLength.idealChars && balanced.targetLength.idealChars > concise.targetLength.idealChars);
  ok('沉浸档规划更多段落', immersive.desiredParagraphCount > concise.desiredParagraphCount);
  ok('动态发布底线低于目标但高于旧三人底线', immersive.targetLength.publishFloorChars >= 600 && immersive.targetLength.publishFloorChars < immersive.targetLength.minChars);

  const packet = Story.Narration.buildNarrativePacket(state, contract, immersive, projected);
  const serializedPacket = JSON.stringify(packet);
  ok('NarrativePacket 覆盖全部行动和互动 ID', packet.facts.length === 3 && packet.interactions.length === 1);
  ok('NarrativePacket 不携带私密收益和 Delta', serializedPacket.indexOf('privateGains') < 0 && serializedPacket.indexOf('隐藏刻度') < 0 && serializedPacket.indexOf('不应公开') < 0);
  ok('NarrativePacket 明确篇幅和段落职责', packet.targetLength.idealChars === immersive.targetLength.idealChars && packet.paragraphPlan.length >= 4);

  const brief = Story.Narration.buildBrief(state, state.story.currentScene, envelope, null, state.story.currentScene);
  const ctx = Story.Provider._briefToCtx(state, brief);
  const prompt = Story.Narration.buildUserPrompt(ctx);
  ok('公共上下文以 NarrativePacket 为首要写作输入', ctx.narrativePacket && ctx.narrativePacket.facts.length === 3 && prompt.indexOf('NarrativePacket') >= 0);
  ok('提示词明确理想字数而非只给最低线', prompt.indexOf(String(brief.qualityPlan.targetLength.idealChars)) >= 0 && Story.Narration.buildSystemPrompt().indexOf('动作→即时反应→具体后果') >= 0);

  const seedSentence = '铜线在木桩之间轻轻震动，阿悟先按住图纸，再抬眼确认剑锋与同伴的距离。阿萝收势后仍站在原位，阿客把墨迹擦去一半，现场只留下能够复查的动作与后果。';
  const perParagraph = Math.ceil(immersive.targetLength.idealChars / immersive.desiredParagraphCount / seedSentence.length);
  const goodChapter = Array.from({ length: immersive.desiredParagraphCount }, function (_, index) {
    return '第' + (index + 1) + '段，' + seedSentence.repeat(perParagraph);
  }).join('\n\n');
  const metrics = Story.Narration.measureProseExperience({ chapter: goodChapter }, immersive);
  ok('体验指标记录长度、段落与句式变化', metrics.charCount > 0 && metrics.paragraphCount === immersive.desiredParagraphCount && typeof metrics.sentenceLengthVariation === 'number');
  ok('达到目标的章节获得可发布体验等级', metrics.lengthStatus === 'target' && ['A', 'B'].indexOf(metrics.grade) >= 0, JSON.stringify(metrics));
  const shortMetrics = Story.Narration.measureProseExperience({ chapter: '阿悟看了一眼图纸。' }, immersive);
  ok('过短章节产生明确体验告警', shortMetrics.lengthStatus === 'below_floor' && shortMetrics.warnings.indexOf('BELOW_PUBLISH_FLOOR') >= 0);

  const blocked = Story.Narration.validateChapterCompleteness({ chapter: '短句。\n\n仍然太短。\n\n到此结束。' }, contract, { qualityPlan: immersive });
  ok('发布闸门采用档位化长度底线', blocked && blocked.code === 'NARRATION_TOO_SHORT' && blocked.details.minimum === immersive.targetLength.publishFloorChars);
  const complete = Story.Narration.validateChapterCompleteness({ chapter: goodChapter }, contract, { qualityPlan: immersive });
  ok('达到档位底线和段落底线的章节可继续语义验收', complete === null, complete && complete.message);

  state.story.pendingResolution = { qualityPlan: immersive, directorPlan: null };
  const chapter = Story.Narration.assembleFromAI(state, state.story.currentScene, envelope, { title: '测绘场余波', chapter: goodChapter, dialogues: [], endingImage: '' });
  Story.Narration.applyNarration(state, chapter, envelope, false);
  ok('章节提交保存体验指标', state.story.currentChapter.narrativeMetrics && state.story.currentChapter.narrativeMetrics.charCount === metrics.charCount);
  ok('质量历史保留最近章节指标', state.story.narrativeQualityHistory.length === 1 && state.story.narrativeQualityHistory[0].grade === metrics.grade);

  console.log('\nV3.4.3 prose experience: ' + passed + ' passed');
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
