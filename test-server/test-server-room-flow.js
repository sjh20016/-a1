'use strict';

const http = require('http');
const helpers = require('./helpers.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}
function get(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (response) {
      var body = ''; response.on('data', function (chunk) { body += chunk; });
      response.on('end', function () { resolve({ status: response.statusCode, body: body }); });
    }).on('error', reject);
  });
}

async function main() {
  console.log('\n=== test-server-room-flow ===');
  var app = await helpers.startTestServer();
  var health = await get(app.httpUrl + '/healthz');
  ok('/healthz 返回 ok', health.status === 200 && health.body === 'ok');
  var game = await helpers.prepareTwoPlayerGame(app);
  var openingView = game.finalized.view;
  ok('投票结算后进入 collecting', openingView.room.status === 'collecting', openingView.room.status);
  ok('两名真人均已绑定角色', openingView.room.seats.filter(function (s) { return s.kind === 'human' && s.actorName; }).length === 2);
  ok('RoomView 暴露已选卷纲', openingView.publicDirector.activeArc.arcId === game.chosen.arcId);
  if (game.chosen.recipeId !== 'trade_contract' && game.chosen.recipeId !== 'relic_identity') {
    var serialized = JSON.stringify(openingView.publicStory);
    ok('非商会卷纲公共开局无半封商会密信', serialized.indexOf('半封商会密信') < 0, game.chosen.recipeId);
  }
  var viewA = (await game.a.request('get_room_view', {})).view;
  var viewB = (await game.b.request('get_room_view', {})).view;
  var choiceA = viewA.ownActor.ownChoices[0];
  var choiceB = viewB.ownActor.ownChoices[0];
  await game.a.request('submit_action', { action: { choiceId: choiceA.id } });
  var resolvedB = await game.b.request('submit_action', { action: { choiceId: choiceB.id } });
  var finalA = (await game.a.request('get_room_view', {})).view;
  var chapterA = finalA.publicStory.chapterId;
  var chapterB = resolvedB.view.publicStory.chapterId;
  ok('双人行动由服务器统一结算', finalA.room.status === 'collecting');
  ok('A/B 收到相同 chapterId', chapterA === chapterB, chapterA + ' / ' + chapterB);
  ok('结算后开启下一回合', finalA.room.round >= 2, String(finalA.room.round));
  game.a.close(); game.b.close(); await app.stop();
  console.log('Server room flow passed ' + pass + ' / failed ' + fail);
  if (fail) process.exit(1);
}
main().catch(function (error) { console.error(error); process.exit(1); });
