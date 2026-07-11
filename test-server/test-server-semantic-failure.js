'use strict';

const Story = require('../story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) { if (condition) { pass++; console.log('✓ ' + name); } else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); } }
async function main() {
  const state = await Story.createSession({ seed: 'SERVER-SEMANTIC', skipOpening: true, pvpMode: 'dramatic', actors: [
    { id: 'a', name: '飞猪', seatId: 'seat_0', controller: 'human' },
    { id: 'c', name: '江北客', seatId: 'seat_1', controller: 'human' },
  ] });
  state.story.currentScene = { sceneId: 's', locationId: 'yard', locationName: '旧祠', timeOfDay: '清晨', weather: '雾', pressure: 1, deadline: null, visibleEntities: [], availableAssets: [], exits: [], activeThreadIds: [], sceneStatus: 'open' };
  state.story.currentChapter = { title: '开局', chapter: '两人走进旧祠，清晨的雾尚未散去，眼前还没有发生战斗。', canonicalSummary: '两人抵达旧祠。' };
  state.story.chapterIndex = 1;
  let calls = 0;
  Story.setAIEnabled(true);
  Story.registerAIProvider({ narrate: async function () {
    calls++;
    return JSON.stringify({ title: '错误章节' + calls, chapter: '江北客攻击蒙面符修，并成功将他重创。一只三眼青狼又从深夜的树影里走出，加入了战斗。', dialogues: [], endingImage: '' });
  } }, { provider: 'server-openai-compatible', model: 'test' });
  await Story.resolveTurn(state, { c: { custom: { text: '试图攻击玩家A' } } });
  ok('语义校验仅生成+修复两次', calls === 2, String(calls));
  ok('第二次仍失败后进入 narration_failed', state.story.turnPhase === 'narration_failed', state.story.turnPhase);
  ok('失败后 pendingResolution 保留', !!state.story.pendingResolution);
  ok('错误码为语义协议错误', ['WRONG_ACTION_TARGET', 'WRONG_ACTION_OUTCOME', 'UNREGISTERED_ENTITY', 'TEMPORAL_CONTRADICTION'].indexOf(state.story.pendingResolution.lastNarrationError.code) >= 0, state.story.pendingResolution.lastNarrationError.code);
  console.log('\nserver semantic failure: ' + pass + ' passed / ' + fail + ' failed'); if (fail) process.exitCode = 1;
}
main().catch(function (error) { console.error(error); process.exitCode = 1; });
