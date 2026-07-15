'use strict';

const Story = require('./story-core.js');
const helpers = require('./test-helpers.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('✓ ' + name); }
  else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); }
}

async function main() {
  helpers.setupMockAI(Story);
  const state = await Story.createSession({ seed: 'ECHO', actors: [
    { id: 'actor', name: '陆知微', seatId: 'seat_0', controller: 'human', daoPath: '剑修' },
  ] });
  const provider = helpers.setupMockAI(Story, { delayMs: 60 });
  const choice = Story.getChoicesForActor(state, 'actor')[0];
  let echoAtBoundary = null;
  let providerCallsAtBoundary = -1;
  const startedAt = Date.now();
  await Story.resolveTurn(state, { actor: { choiceId: choice.id } }, {
    beforeNarration: async function (pending) {
      providerCallsAtBoundary = provider.calls();
      echoAtBoundary = Story.getPublicStoryView(state).resolutionEcho;
      ok('pendingResolution 在模型请求前已有裁决回响', pending && pending.resolutionEcho === state.story.pendingResolution.resolutionEcho);
    },
  });
  const boundaryElapsed = echoAtBoundary ? echoAtBoundary.readyAt - startedAt : 9999;
  ok('裁决回响早于 Provider 调用', providerCallsAtBoundary === 0, String(providerCallsAtBoundary));
  ok('裁决回响在 300ms 内可见', boundaryElapsed < 300, String(boundaryElapsed) + 'ms');
  ok('回响覆盖已提交真人行动', echoAtBoundary && echoAtBoundary.actions.length === 1 && echoAtBoundary.actions[0].actorId === 'actor');
  ok('回响包含目标、结果和代价字段', echoAtBoundary && Object.prototype.hasOwnProperty.call(echoAtBoundary.actions[0], 'targetId') && echoAtBoundary.actions[0].outcome && Array.isArray(echoAtBoundary.actions[0].costs));
  const serialized = JSON.stringify(echoAtBoundary);
  ok('回响不暴露 privateDelta 或私密收益', serialized.indexOf('privateDelta') < 0 && serialized.indexOf('privateEffects') < 0 && serialized.indexOf('ownHiddenFate') < 0);
  ok('正式章节提交后清除临时回响', Story.getPublicStoryView(state).resolutionEcho === null);
  console.log('\nResolutionEcho: ' + pass + ' passed / ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
