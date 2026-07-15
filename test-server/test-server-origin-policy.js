'use strict';

const WebSocket = require('ws');
const helpers = require('./helpers.js');

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('  ✓' + name); }
  else { fail++; console.log('  ✗' + name + (detail ? ' :: ' + detail : '')); }
}

function openWithOrigin(url, origin) {
  return new Promise(function (resolve) {
    var socket = new WebSocket(url, { origin: origin });
    var done = false;
    function finish(value) { if (done) return; done = true; try { socket.terminate(); } catch (error) {} resolve(value); }
    socket.once('open', function () { finish(true); });
    socket.once('unexpected-response', function () { finish(false); });
    socket.once('error', function () { setTimeout(function () { finish(false); }, 10); });
    socket.once('close', function () { finish(false); });
  });
}

async function main() {
  console.log('\n=== test-server-origin-policy ===');
  var app = await helpers.startTestServer({ config: { publicOrigin: 'https://demo.example.com/' } });
  var port = new URL(app.wsUrl).port;
  ok('配置 Origin 尾斜杠标准化后通过', await openWithOrigin(app.wsUrl, 'https://demo.example.com'));
  ok('反向代理同源 Host 通过', await openWithOrigin(app.wsUrl, 'http://127.0.0.1:' + port));
  ok('恶意 Origin 被拒绝', !(await openWithOrigin(app.wsUrl, 'https://evil.example')));
  await app.stop();
  console.log('Origin policy passed ' + pass + ' / failed ' + fail);
  if (fail) process.exit(1);
}
main().catch(function (error) { console.error(error); process.exit(1); });
