const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) { if (condition) { pass++; console.log('✓ ' + name); } else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); } }
async function main() {
  const state = await Story.createSession({ seed: 'V341-PRIVACY', skipOpening: true, actors: [{ id: 'a', name: '甲', seatId: 'seat_0', controller: 'human' }] });
  state.story.currentScene = { sceneId: 's', locationId: 'inn', locationName: '旧祠', timeOfDay: '夜', weather: '', pressure: 1, visibleEntities: [], availableAssets: [], exits: [] };
  state.story.activeThreads = [
    { threadId: 'public', title: '公开线索', visibility: 'public', status: 'active' },
    { threadId: 'private', title: '私密命运', visibility: 'private', status: 'active' },
    { threadId: 'dormant', title: '沉睡卷纲', visibility: 'public', status: 'dormant' },
  ];
  const envelope = { turnId: 'turn_1', actions: [], interactions: [], narrationBeats: [], publicDelta: [], elapsedTime: { value: 1, unit: '片刻' } };
  const ctx = Story.Provider._briefToCtx(state, Story.Narration.buildBrief(state, state.story.currentScene, envelope));
  ok('公开 active 线索进入 AI ctx', ctx.activeThreads.some(function (t) { return t.threadId === 'public'; }));
  ok('私密线索不进入 AI ctx', !ctx.activeThreads.some(function (t) { return t.threadId === 'private'; }));
  ok('dormant 线索不进入 AI ctx', !ctx.activeThreads.some(function (t) { return t.threadId === 'dormant'; }));
  state.story.currentChapter = { title: '旧章', chapter: '这段完整旧正文不应当再被发给模型。', canonicalSummary: '甲在旧祠观察。' };
  const ctx2 = Story.Provider._briefToCtx(state, Story.Narration.buildBrief(state, state.story.currentScene, envelope));
  ok('previousChapter 只保留 canonicalSummary', ctx2.previousChapter.canonicalSummary === '甲在旧祠观察。' && !Object.prototype.hasOwnProperty.call(ctx2.previousChapter, 'chapterExcerpt'));
  console.log('\nV3.4.1 privacy: ' + pass + ' passed / ' + fail + ' failed'); if (fail) process.exitCode = 1;
}
main().catch(function (error) { console.error(error); process.exitCode = 1; });
