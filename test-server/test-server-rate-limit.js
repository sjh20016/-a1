'use strict';

const helpers = require('./helpers.js');

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('  ✓' + name); }
  else { fail++; console.log('  ✗' + name + (detail ? ' :: ' + detail : '')); }
}

async function main() {
  console.log('\n=== test-server-rate-limit ===');
  var app = await helpers.startTestServer({ config: { createRoomsPerHour: 1, commandRateLimit: 100 } });
  var client = new helpers.TestClient(app.wsUrl);
  await client.connect();
  await client.request('create_room', { hostName: 'one' }, { auth: false });
  var code = '';
  try { await client.request('create_room', { hostName: 'two' }, { auth: false }); }
  catch (error) { code = error.code; }
  ok('同一 IP 建房超过小时上限返回稳定错误码', code === 'RATE_LIMITED');
  client.close();
  await app.stop();

  var roundsApp = await helpers.startTestServer({ config: { maxRounds: 1 } });
  var game = await helpers.prepareTwoPlayerGame(roundsApp);
  var viewA = (await game.a.request('get_room_view', {})).view;
  var viewB = (await game.b.request('get_room_view', {})).view;
  await game.a.request('submit_action', { action: { choiceId: viewA.ownActor.ownChoices[0].id } });
  var finalRound = await game.b.request('submit_action', { action: { choiceId: viewB.ownActor.ownChoices[0].id } });
  ok('单局回合上限结束时不再开启下一回合', finalRound.view.room.status === 'ended');
  game.a.close(); game.b.close(); await roundsApp.stop();
  console.log('Rate limit passed ' + pass + ' / failed ' + fail);
  if (fail) process.exit(1);
}
main().catch(function (error) { console.error(error); process.exit(1); });
