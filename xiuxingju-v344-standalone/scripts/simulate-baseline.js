#!/usr/bin/env node
'use strict';

const Story = require('../story-core.js');

function readArg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function adaptiveChapter(ctx, callIndex) {
  const packet = ctx.narrativePacket || ctx.brief && ctx.brief.narrativePacket || {};
  const plan = ctx.qualityPlan || ctx.brief && ctx.brief.qualityPlan || {};
  const target = plan.targetLength || packet.targetLength || {};
  const ideal = target.idealChars || 900;
  const paragraphCount = plan.desiredParagraphCount || packet.desiredParagraphCount || 5;
  const facts = packet.facts || [];
  const factLine = facts.length ? facts.map(function (fact) {
    return fact.actorName + '执行“' + fact.actionText + '”，目标限定为' + (fact.targetName || '自身') + '，结果为' + (fact.outcomeLabel || fact.outcome || '已裁决');
  }).join('；') : '众人在当前场景站定，开局事实与位置均以本地裁决为准';
  const openings = ['石阶上传来短促的脚步声', '桌角的灯焰忽然偏向一侧', '一枚铜扣落在木案边缘', '门外的风把纸页掀起半寸', '远处钟声刚落下最后一拍', '檐下积水被鞋尖划开'];
  const textures = [
    '动作先改变了眼前的距离，随后才引出旁人的反应；所有人都保留自己的判断，没有谁替同伴完成选择。',
    '可见的变化落在手势、脚步与物件位置上，未被裁决的线索、奖赏和异象都没有借旁白出现。',
    '场面沿着同一处空间继续推进，前一个动作留下的阻力成为下一个动作必须面对的具体条件。',
    '短暂的对视没有被解释成命运暗示，真正能被记录的只有结果、代价、站位与公开关系。',
    '余波没有扩张成新的势力或人物，下一轮可操作的局面仍来自现场已经存在的门、路与物件。',
    '结尾停在一项具体后果上：有人收手，有人继续观察，尚未完成的决定重新交还给玩家。',
  ];
  const targetPerParagraph = Math.ceil(ideal / paragraphCount);
  const paragraphs = [];
  for (let i = 0; i < paragraphCount; i++) {
    let paragraph = (i === 0 ? openings[(callIndex + i) % openings.length] + '。' : '') + factLine + '。' + textures[(callIndex + i) % textures.length];
    let expansion = 0;
    while (paragraph.replace(/\s/g, '').length < targetPerParagraph) {
      paragraph += textures[(callIndex + i + expansion + 1) % textures.length];
      expansion++;
    }
    paragraphs.push(paragraph);
  }
  return paragraphs.join('\n\n');
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

async function simulate(seed, turns) {
  let providerCalls = 0;
  Story.setAIEnabled(true);
  Story.registerAIProvider({ narrate: async function (ctx) {
    providerCalls++;
    return JSON.stringify({
      title: '基线演章·' + providerCalls,
      chapter: adaptiveChapter(ctx, providerCalls),
      dialogues: [],
      endingImage: '',
      audit: { coveredFactIds: [], coveredInteractionIds: [], mentionedEntities: [], mentionedLocations: [], assertedPersistentClaims: [], openingMode: 'action' },
    });
  } }, { provider: 'mock-simulation', model: 'deterministic-prose-baseline', skipSemanticValidation: true });

  const startedAt = Date.now();
  const state = await Story.createSession({ seed: seed, narrativeProfile: 'immersive', pvpMode: 'dramatic', skipOpening: true, actors: [
    { id: 'normal', name: '阿悟', seatId: 'seat_0', controller: 'human', identity: '谨慎调查者', daoPath: '阵修' },
    { id: 'aggressive', name: '阿萝', seatId: 'seat_1', controller: 'human', identity: '好战行者', daoPath: '剑修' },
    { id: 'imaginative', name: '阿客', seatId: 'seat_2', controller: 'human', identity: '跳脱散修', daoPath: '杂学' },
  ] });
  const candidates = Story.Director.generateCandidates(state);
  state.story.director.candidates = candidates;
  state.story.director.phase = 'voting';
  Story.Director.activateArc(state, candidates[0].arcId);
  await Story._generateOpening(state);

  const actorIds = ['normal', 'aggressive', 'imaginative'];
  const chapterMetrics = [];
  const categoryCounts = {};
  let actionCount = 0;
  let interactionCount = 0;
  let narrationFailures = 0;
  let arcIdleTurns = 0;
  let currentIdleStreak = 0;
  let longestArcIdleStreak = 0;
  const activatedArcIds = new Set([state.story.director.activeArc.arcId]);
  for (let turn = 0; turn < turns; turn++) {
    const submissions = {};
    actorIds.forEach(function (actorId, actorIndex) {
      const choices = Story.getChoicesForActor(state, actorId);
      if (choices.length) submissions[actorId] = { choiceId: choices[(turn + actorIndex) % choices.length].id };
      else submissions[actorId] = { custom: { text: actorIndex === 0 ? '观察当前场景' : (actorIndex === 1 ? '警戒四周' : '在地上画下本轮路线') } };
    });
    await Story.resolveTurn(state, submissions);
    if (state.story.turnPhase !== 'collecting') {
      narrationFailures++;
      throw new Error('simulation stopped at turn ' + (turn + 1) + ': ' + JSON.stringify(state.story.pendingResolution && state.story.pendingResolution.lastNarrationError));
    }
    const record = state.ledger.turnRecords[state.ledger.turnRecords.length - 1];
    const envelope = record && record.resolutionEnvelope || { actions: [], interactions: [] };
    actionCount += (envelope.actions || []).length;
    interactionCount += (envelope.interactions || []).length;
    (envelope.actions || []).forEach(function (action) { categoryCounts[action.category] = (categoryCounts[action.category] || 0) + 1; });
    if (state.story.currentChapter && state.story.currentChapter.narrativeMetrics) chapterMetrics.push(state.story.currentChapter.narrativeMetrics);
    const director = state.story.director;
    if (director.activeArc) activatedArcIds.add(director.activeArc.arcId);
    if (director.phase !== 'active' && director.phase !== 'campaign_completed') {
      arcIdleTurns++;
      currentIdleStreak++;
      longestArcIdleStreak = Math.max(longestArcIdleStreak, currentIdleStreak);
    } else currentIdleStreak = 0;
    if (director.phase === 'campaign_completed') break;
  }

  const lengths = chapterMetrics.map(function (metrics) { return metrics.charCount; });
  const scores = chapterMetrics.map(function (metrics) { return metrics.score; });
  const paragraphs = chapterMetrics.map(function (metrics) { return metrics.paragraphCount; });
  const grades = {};
  const lengthStatuses = {};
  chapterMetrics.forEach(function (metrics) {
    grades[metrics.grade] = (grades[metrics.grade] || 0) + 1;
    lengthStatuses[metrics.lengthStatus] = (lengthStatuses[metrics.lengthStatus] || 0) + 1;
  });
  const average = function (values) { return values.length ? Number((values.reduce(function (sum, value) { return sum + value; }, 0) / values.length).toFixed(1)) : 0; };
  const result = {
    simulationVersion: '2.0',
    storyVersion: Story.VERSION,
    seed: seed,
    narrativeProfile: state.settings.narrativeProfile,
    turnsRequested: turns,
    turnsCompleted: chapterMetrics.length,
    providerCalls: providerCalls,
    elapsedMs: Date.now() - startedAt,
    actionCount: actionCount,
    interactionCount: interactionCount,
    categoryCounts: categoryCounts,
    narrationFailures: narrationFailures,
    director: {
      activatedArcCount: activatedArcIds.size,
      completedArcCount: (state.story.director.completedArcs || []).length,
      arcIdleTurns: arcIdleTurns,
      longestArcIdleStreak: longestArcIdleStreak,
      campaignStatus: state.story.director.campaign && state.story.director.campaign.status || 'inactive',
      campaignEnding: state.story.director.campaign && state.story.director.campaign.ending || null,
      campaignClock: state.story.director.campaign && state.story.director.campaign.clock || null,
    },
    worldRules: {
      triggeredRuleCount: Story.WorldRules.explain(state).filter(function (rule) { return rule.triggerCount > 0; }).length,
      totalTriggers: Story.WorldRules.explain(state).reduce(function (sum, rule) { return sum + rule.triggerCount; }, 0),
      eventWeightCount: Object.keys(Story.WorldRules.eventWeights(state)).length,
    },
    factions: {
      actionCount: (state.world.factionHistory || []).length,
      changedFactionCount: (state.world.factions || []).filter(function (faction) { return faction.power !== 50 || faction.control > 0 || faction.resources > 0; }).length,
    },
    prose: {
      averageChapterLength: average(lengths),
      p50ChapterLength: percentile(lengths, 0.5),
      p90ChapterLength: percentile(lengths, 0.9),
      averageParagraphCount: average(paragraphs),
      averageQualityScore: average(scores),
      grades: grades,
      lengthStatuses: lengthStatuses,
    },
    finalState: {
      chapterIndex: state.story.chapterIndex,
      directorPhase: state.story.director && state.story.director.phase || '',
      activeThreadCount: (state.story.activeThreads || []).filter(function (thread) { return thread.status === 'active'; }).length,
      qualityHistorySize: (state.story.narrativeQualityHistory || []).length,
    },
  };
  return result;
}

async function main() {
  const baseSeed = readArg('seed', 'V343-BASELINE');
  const turns = Math.max(1, Number(readArg('turns', '30')) || 30);
  const seedCount = Math.max(1, Number(readArg('seeds', '1')) || 1);
  const quiet = process.argv.indexOf('--quiet') >= 0;
  const results = [];
  for (let index = 0; index < seedCount; index++) {
    results.push(await simulate(seedCount === 1 ? baseSeed : baseSeed + '-' + String(index + 1).padStart(3, '0'), turns));
  }
  if (seedCount === 1) {
    if (quiet) console.log(JSON.stringify(results[0]));
    else console.log('V3.4.3 deterministic baseline\n' + JSON.stringify(results[0], null, 2));
    return;
  }
  const summary = {
    simulationVersion: '2.0',
    seedPrefix: baseSeed,
    seedCount: seedCount,
    turnsPerSeed: turns,
    totalTurnsCompleted: results.reduce(function (sum, result) { return sum + result.turnsCompleted; }, 0),
    campaignEndings: results.reduce(function (counts, result) {
      const type = result.director.campaignEnding && result.director.campaignEnding.type || 'none';
      counts[type] = (counts[type] || 0) + 1;
      return counts;
    }, {}),
    maxArcIdleStreak: Math.max.apply(Math, results.map(function (result) { return result.director.longestArcIdleStreak; })),
    averageActivatedArcs: Number((results.reduce(function (sum, result) { return sum + result.director.activatedArcCount; }, 0) / seedCount).toFixed(2)),
    narrationFailures: results.reduce(function (sum, result) { return sum + result.narrationFailures; }, 0),
    averageWorldRuleTriggers: Number((results.reduce(function (sum, result) { return sum + result.worldRules.totalTriggers; }, 0) / seedCount).toFixed(2)),
    averageFactionActions: Number((results.reduce(function (sum, result) { return sum + result.factions.actionCount; }, 0) / seedCount).toFixed(2)),
    results: quiet ? undefined : results,
  };
  console.log(JSON.stringify(summary, null, quiet ? 0 : 2));
}

main().catch(function (error) { console.error(error && error.stack || error); process.exitCode = 1; });

module.exports = { simulate: simulate };
