'use strict';

const fs = require('fs');
const path = require('path');
const { startTestServer, prepareTwoPlayerGame } = require('./helpers.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) { if (condition) { pass++; console.log('✓ ' + name); } else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); } }
async function main() {
  const control = { fail: false };
  const app = await startTestServer({ control: control });
  const game = await prepareTwoPlayerGame(app);
  let release;
  let startedResolve;
  const started = new Promise(function (resolve) { startedResolve = resolve; });
  control.blockPromise = new Promise(function (resolve) { release = resolve; });
  control.onCall = function () { startedResolve(); };
  try {
    await game.a.request('submit_action', { action: { custom: { text: '观察当前场景' } } });
    const lastSubmit = game.b.request('submit_action', { action: { custom: { text: '调查当前异常' } } });
    await started;
    // beforeNarration 持久化在 Provider 调用之前 await，因此此时磁盘快照已存在。
    const file = path.join(app.testDataDir, 'rooms', game.a.auth.roomId + '.json');
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8')).room;
    ok('AI 进行中快照已锁定回合', snapshot.turn.phase === 'resolving' || snapshot.turn.phase === 'locked', snapshot.turn.phase);
    ok('AI 进行中快照保留全部已提交行动', Object.keys(snapshot.turn.actionsByActorId || {}).length === 2, JSON.stringify(snapshot.turn.actionsByActorId));
    ok('AI 进行中快照已建立 pendingResolution', !!(snapshot.storySession && snapshot.storySession.story && snapshot.storySession.story.pendingResolution));
    release();
    await lastSubmit;
  } finally {
    control.blockPromise = null;
    game.a.close(); game.b.close();
    await app.stop();
  }
  console.log('\nserver persist-before-ai: ' + pass + ' passed / ' + fail + ' failed'); if (fail) process.exitCode = 1;
}
main().catch(function (error) { console.error(error); process.exitCode = 1; });
