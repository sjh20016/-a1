'use strict';

const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('✓ ' + name); }
  else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); }
}

async function campaignState(seed) {
  const state = await Story.createSession({ seed: seed, skipOpening: true, actors: [
    { id: 'actor_a', name: '甲', seatId: 'seat_0', controller: 'human', daoPath: '剑修' },
    { id: 'actor_b', name: '乙', seatId: 'seat_1', controller: 'human', daoPath: '阵法' },
  ] });
  state.story.currentScene = Story.Scene.createOpeningScene(state);
  const candidates = Story.Director.generateCandidates(state);
  state.story.director.candidates = candidates;
  state.story.director.phase = 'voting';
  const arc = Story.Director.activateArc(state, candidates[0].arcId);
  Story.Director.applyArcOpeningScenePatch(state, arc);
  Story.Director.applyOpeningSeed(state, arc);
  Story.Director.applyArcAssets(state, arc);
  return state;
}

function completeActiveArc(state) {
  const arc = state.story.director.activeArc;
  const finalIndex = arc.beats.length - 1;
  arc.beats.forEach(function (beat, index) { beat.status = index === finalIndex ? 'active' : 'completed'; });
  arc.currentBeatIndex = finalIndex;
  const beat = arc.beats[finalIndex];
  beat.progress = Math.max(0, (beat.progressTarget || arc.beatProgressTarget || 1) - 1);
  Story.Director.applyPlan(state, {
    arcId: arc.arcId, beatId: beat.beatId, result: 'advance', reasons: ['测试推进'],
    directorScore: { advance: 2, bend: 0, stall: 0, shatter: 0, conflicts: [] },
    clockDeltas: [], arcDeltas: [{ op: 'COMPLETE_ARC', beatId: beat.beatId, result: 'advance' }],
    narrativeGuide: { allowedReveals: [] },
  });
  Story.ArcScheduler.afterTurn(state, { arcCompletedThisTurn: true });
  return arc;
}

async function main() {
  const state = await campaignState('ARC-SCHEDULER');
  const first = state.story.director.activeArc;
  ok('初始投票形成三幕候选', state.story.director.campaign.maxActs === 3 && state.story.director.dormantArcs.length === 2);
  ok('休眠篇章使用结构化 wakeWhen', !!state.story.director.dormantArcs[0].wakeWhen && Array.isArray(state.story.director.dormantArcs[0].wakeWhen.all));

  completeActiveArc(state);
  ok('首篇完成后进入一回合幕间', state.story.director.phase === 'interlude' && state.story.director.campaign.interludeTurnsRemaining === 1);
  ok('完成篇章不再留下 active thread', !(state.story.activeThreads || []).some(function (thread) { return thread.sourceArcId === first.arcId && thread.status === 'active'; }));
  Story.ArcScheduler.afterTurn(state, {});
  ok('结构化条件在幕间后唤醒第二篇', state.story.director.phase === 'active' && state.story.director.activeArc.arcId !== first.arcId);
  ok('第二幕编号同步推进', state.story.director.campaign.actIndex === 2);

  const second = completeActiveArc(state);
  Story.ArcScheduler.afterTurn(state, {});
  ok('第二篇完成后唤醒终幕', state.story.director.phase === 'active' && state.story.director.activeArc.arcId !== second.arcId && state.story.director.campaign.actIndex === 3);
  completeActiveArc(state);
  ok('三篇完成后进入 campaign_completed', state.story.director.phase === 'campaign_completed' && state.story.director.campaign.status === 'completed');
  ok('成功终局有结构化 ending', state.story.director.campaign.ending && state.story.director.campaign.ending.type === 'success');

  const crisis = await campaignState('ARC-CRISIS');
  for (let turn = 0; turn < 30; turn++) Story.ArcScheduler.afterTurn(crisis, {});
  ok('世界危机时钟会推进', crisis.story.director.campaign.clock.current === crisis.story.director.campaign.clock.max);
  ok('危机走尽产生代价型终局', crisis.story.director.phase === 'campaign_completed' && crisis.story.director.campaign.ending.type === 'cost');

  const snapshot = Story.Director.getSnapshot(state);
  ok('公共导演快照解释幕次、时钟和终局', snapshot.campaign && snapshot.campaign.actIndex === 3 && snapshot.campaign.clock && snapshot.campaign.ending);
  console.log('\nArcScheduler: ' + pass + ' passed / ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
