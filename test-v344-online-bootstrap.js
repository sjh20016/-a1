'use strict';

const OnlineClient = require('./public/online-client.js');

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('  ✓' + name); }
  else { fail++; console.log('  ✗' + name + (detail ? ' :: ' + detail : '')); }
}

console.log('\n=== test-v344-online-bootstrap ===');
ok('single-flight 连接 API 可用', typeof OnlineClient.connect === 'function' && typeof OnlineClient.ensureConnected === 'function');
ok('邀请链接 API 可用', typeof OnlineClient.getInviteUrl === 'function' && typeof OnlineClient.getInviteRoomCode === 'function');
var diagnostics = OnlineClient.getDiagnostics();
ok('诊断包默认不含秘密字段', !('seatToken' in diagnostics) && !('hostToken' in diagnostics) && !('hiddenFate' in diagnostics));
ok('连接状态可读', typeof OnlineClient.getConnectionState() === 'string');
console.log('Online bootstrap passed ' + pass + ' / failed ' + fail);
if (fail) process.exit(1);
