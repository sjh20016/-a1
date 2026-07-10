'use strict';

const protocol = require('../server/protocol.js');
const helpers = require('./helpers.js');
const OnlineClient = require('../public/online-client.js');
const { endpointFor } = require('../server/ai-provider.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}
function throwsCode(name, fn, code) {
  try { fn(); ok(name, false, '未抛错'); }
  catch (error) { ok(name, error.code === code, error.code); }
}
async function rejectsCode(name, promise, code) {
  try { await promise; ok(name, false, '未拒绝'); }
  catch (error) { ok(name, error.code === code, error.code); }
}

async function main() {
  console.log('\n=== test-server-protocol ===');
  throwsCode('非法 JSON → BAD_JSON', function () { protocol.parseMessage('{bad'); }, 'BAD_JSON');
  throwsCode('未知 type → INVALID_COMMAND', function () { protocol.parseMessage(JSON.stringify({ type: 'hack', payload: {} })); }, 'INVALID_COMMAND');
  throwsCode('缺 token → UNAUTHORIZED', function () { protocol.parseMessage(JSON.stringify({ type: 'get_room_view', roomId: 'room_x', seatId: 'seat_0', payload: {} })); }, 'UNAUTHORIZED');
  throwsCode('超长 custom → INVALID_ACTION', function () {
    protocol.parseMessage(JSON.stringify({ type: 'submit_action', roomId: 'room_x', seatId: 'seat_0', token: 'x', payload: { action: { custom: { text: '甲'.repeat(501) } } } }));
  }, 'INVALID_ACTION');
  var clientMethods = ['connect','createRoom','joinRoom','reconnect','assignActor','setReady','startRoomWithArcVoting','submitArcVote','finalizeArcVote','submitAction','cancelAction','retryNarration','getRoomView'];
  ok('OnlineClient 暴露完整联机命令 API', clientMethods.every(function (name) { return typeof OnlineClient[name] === 'function'; }));
  ok('DeepSeek Base URL 正确补全 chat/completions', endpointFor('https://api.deepseek.com') === 'https://api.deepseek.com/chat/completions');

  var app = await helpers.startTestServer();
  var game = await helpers.prepareTwoPlayerGame(app);
  await rejectsCode('非房主 finalize_arc_vote → FORBIDDEN', game.b.request('finalize_arc_vote', {}, { host: true, hostToken: 'fake' }), 'FORBIDDEN');
  await rejectsCode('非房主 retry_narration → FORBIDDEN', game.b.request('retry_narration', {}, { host: true, hostToken: 'fake' }), 'FORBIDDEN');
  game.a.close(); game.b.close(); await app.stop();
  console.log('Server protocol passed ' + pass + ' / failed ' + fail);
  if (fail) process.exit(1);
}
main().catch(function (error) { console.error(error); process.exit(1); });
