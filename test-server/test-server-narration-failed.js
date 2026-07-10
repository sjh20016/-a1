'use strict';

const helpers = require('./helpers.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}
async function rejectsCode(name, promise, codes) {
  try { await promise; ok(name, false, '未拒绝'); }
  catch (error) { ok(name, codes.indexOf(error.code) >= 0, error.code); }
}

async function main() {
  console.log('\n=== test-server-narration-failed ===');
  var control = { fail: false };
  var app = await helpers.startTestServer({ control: control });
  var game = await helpers.prepareTwoPlayerGame(app);
  var viewA = (await game.a.request('get_room_view', {})).view;
  var viewB = (await game.b.request('get_room_view', {})).view;
  control.fail = true;
  await game.a.request('submit_action', { action: { choiceId: viewA.ownActor.ownChoices[0].id } });
  var failed = await game.b.request('submit_action', { action: { choiceId: viewB.ownActor.ownChoices[0].id } });
  var room = app.runtime.getRoom(game.a.auth.roomId);
  ok('AI 失败后 room.status=narration_failed', failed.view.room.status === 'narration_failed', failed.view.room.status);
  ok('AI 失败不清空 actionsByActorId', Object.keys(room.turn.actionsByActorId).length === 2);
  ok('AI 失败不清空 submittedActorIds', room.turn.submittedActorIds.length === 2);
  ok('pendingResolution 保留', !!room.storySession.story.pendingResolution);
  await rejectsCode('普通玩家不能修改锁定行动', game.b.request('cancel_action', {}), ['COMMAND_REJECTED']);
  await rejectsCode('普通玩家不能 retry_narration', game.b.request('retry_narration', {}, { host: true, hostToken: 'fake' }), ['FORBIDDEN']);
  control.fail = false;
  var retried = await game.a.request('retry_narration', {}, { host: true });
  ok('房主重试成功后回到 collecting', retried.view.room.status === 'collecting', retried.view.room.status);
  ok('重试成功发布新章节', retried.view.publicStory.chapterId === 'chapter_0002');
  game.a.close(); game.b.close(); await app.stop();
  console.log('Server narration_failed passed ' + pass + ' / failed ' + fail);
  if (fail) process.exit(1);
}
main().catch(function (error) { console.error(error); process.exit(1); });
