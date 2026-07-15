'use strict';

const fs = require('fs');
const helpers = require('./helpers.js');

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('  ✓' + name); }
  else { fail++; console.log('  ✗' + name + (detail ? ' :: ' + detail : '')); }
}

async function main() {
  console.log('\n=== test-server-graceful-shutdown ===');
  var app = await helpers.startTestServer();
  var client = new helpers.TestClient(app.wsUrl);
  await client.connect();
  var room = await client.createRoom('shutdown');
  var file = app.testDataDir + '/rooms/' + room.roomId + '.json';
  await app.gracefulStop();
  ok('优雅关停后 ready=false', app.getReady() === false);
  ok('优雅关停前保存房间文件', fs.existsSync(file));
  var restored = await helpers.startTestServer({ dataDir: app.testDataDir });
  ok('下一实例可以恢复房间', restored.runtime.roomCodes.get(room.roomCode) === room.roomId);
  await restored.stop();
  console.log('Graceful shutdown passed ' + pass + ' / failed ' + fail);
  if (fail) process.exit(1);
}
main().catch(function (error) { console.error(error); process.exit(1); });
