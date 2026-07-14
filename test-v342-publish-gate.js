const Story = require('./story-core.js');

async function main() {
  const state = await Story.createSession({ seed: 'V342-PUBLISH', skipOpening: true, actors: [
    { id: 'a', name: '阿悟', seatId: 'seat_0', controller: 'human' },
  ] });
  state.story.currentScene = { sceneId: 's', locationId: 'yard', locationName: '测绘场', timeOfDay: '清晨', weather: '雾', pressure: 1, visibleEntities: [], availableAssets: [], exits: [] };
  state.story.currentChapter = { title: '上一章', chapter: '上一章正文', canonicalSummary: '上一章公共摘要。' };
  state.story.chapterIndex = 1;
  Story.setAIEnabled(true);
  Story.registerAIProvider({ narrate: async function () {
    return JSON.stringify({ title: '过短章节', chapter: '阿悟在灶边煮面，结果成功，面香飘过测绘场。', dialogues: [], endingImage: '' });
  } }, { provider: 'server-openai-compatible', model: 'test', enforcePublishGate: true });
  await Story.resolveTurn(state, { a: { custom: { text: '在灶边煮面' } } });
  const pending = state.story.pendingResolution;
  if (state.story.turnPhase !== 'narration_failed' || !pending || !pending.lastNarrationError || pending.lastNarrationError.code !== 'NARRATION_TOO_SHORT') {
    throw new Error('publish gate did not block short narration: ' + JSON.stringify(pending && pending.lastNarrationError));
  }
  if (state.story.chapterIndex !== 1) throw new Error('publish gate mutated chapter index');
  console.log('✓ 发布闸门拒绝过短章节并保留 pendingResolution');
  console.log('\nV3.4.2 publish gate: 1 passed / 0 failed');
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
