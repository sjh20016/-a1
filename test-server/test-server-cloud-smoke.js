'use strict';

const http = require('http');
const helpers = require('./helpers.js');

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('  ✓' + name); }
  else { fail++; console.log('  ✗' + name + (detail ? ' :: ' + detail : '')); }
}
function get(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (response) {
      var body = '';
      response.on('data', function (chunk) { body += chunk; });
      response.on('end', function () { resolve({ status: response.statusCode, body: body }); });
    }).on('error', reject);
  });
}

async function main() {
  console.log('\n=== test-server-cloud-smoke ===');
  var app = await helpers.startTestServer({ config: { betaAccessCode: 'beta-smoke' } });
  var health = await get(app.httpUrl + '/healthz');
  var ready = await get(app.httpUrl + '/readyz');
  var bootstrap = await get(app.httpUrl + '/api/bootstrap');
  var parsed = JSON.parse(bootstrap.body);
  ok('/healthz 公开可用', health.status === 200 && health.body === 'ok');
  ok('/readyz ready=true', ready.status === 200 && JSON.parse(ready.body).ready === true);
  ok('/api/bootstrap 只返回公开配置', parsed.websocketPath === '/ws' && parsed.accessRequired === true && !('aiApiKey' in parsed) && !('aiBaseUrl' in parsed));
  var client = new helpers.TestClient(app.wsUrl);
  await client.connect();
  var denied = false;
  try { await client.request('create_room', { hostName: 'smoke' }, { auth: false }); }
  catch (error) { denied = error.code === 'BETA_ACCESS_REQUIRED'; }
  ok('没有内测通行令不能建房', denied);
  var room = await client.request('create_room', { hostName: 'smoke', accessCode: 'beta-smoke' }, { auth: false });
  ok('WebSocket 同源服务可以建房', /^\d{6}$/.test(room.roomCode) && room.seatToken && room.hostToken);
  client.close();
  await app.stop();
  console.log('Cloud smoke passed ' + pass + ' / failed ' + fail);
  if (fail) process.exit(1);
}
main().catch(function (error) { console.error(error); process.exit(1); });
