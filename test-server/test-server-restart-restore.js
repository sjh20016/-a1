'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const helpers = require('./helpers.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}

async function main() {
  console.log('\n=== test-server-restart-restore ===');
  var dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxingju-restart-'));
  var first = await helpers.startTestServer({ dataDir: dataDir });
  var game = await helpers.prepareTwoPlayerGame(first);
  var before = (await game.a.request('get_room_view', {})).view;
  var authA = Object.assign({}, game.a.auth);
  var authB = Object.assign({}, game.b.auth);
  var roomId = authA.roomId;
  game.a.close(); game.b.close();
  await first.stop();

  var second = await helpers.startTestServer({ dataDir: dataDir });
  ok('重启后加载房间', second.runtime.roomCodes.get(authA.roomCode) === roomId);
  var a2 = new helpers.TestClient(second.wsUrl);
  var b2 = new helpers.TestClient(second.wsUrl);
  await Promise.all([a2.connect(), b2.connect()]);
  var restoredA = await a2.reconnect(authA);
  var restoredB = await b2.reconnect(authB);
  ok('原 seatToken 仍可 reconnect', restoredA.view.ownSeat.seatId === authA.seatId && restoredB.view.ownSeat.seatId === authB.seatId);
  ok('重启后 chapterId 一致', restoredA.view.publicStory.chapterId === before.publicStory.chapterId);
  ok('重启后回合状态一致', restoredA.view.room.round === before.room.round && restoredA.view.room.status === before.room.status);
  ok('重启后 roomCode 保持不变', restoredA.view.room.roomCode === authA.roomCode);
  a2.close(); b2.close(); await second.stop();
  console.log('Server restart restore passed ' + pass + ' / failed ' + fail);
  if (fail) process.exit(1);
}
main().catch(function (error) { console.error(error); process.exit(1); });
