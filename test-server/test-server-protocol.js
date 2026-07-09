/**
 * test-server/test-server-protocol.js — 协议白名单与字段校验
 * ============================================================================
 * 测试：
 *   - 非法 JSON 返回 error
 *   - 未知 type 返回 error
 *   - 缺 roomId 返回 error
 *   - 缺 token 返回 error
 *   - 非房主调用 finalize_arc_vote 失败
 *   - create_room 返回 roomId / roomCode / hostToken / seatToken
 * ============================================================================
 */
const WebSocket = require('ws');
const { startTestServer, createClient, check, summary, resetCounters } = require('./test-helpers');

async function main() {
  resetCounters();
  const srv = await startTestServer();
  const url = srv.url;
  console.log('\n[协议测试]');

  // 1. 非法 JSON
  await new Promise(function (resolve) {
    const ws = new WebSocket(url);
    ws.on('open', function () { ws.send('this is not json'); });
    ws.on('message', function (raw) {
      const msg = JSON.parse(raw.toString());
      check('非法 JSON 返回 error', msg.type === 'error' && msg.error.code === 'INVALID_JSON');
      ws.close();
      resolve();
    });
    ws.on('error', function () { resolve(); });
  });

  // 2. 未知 type
  const c1 = await createClient(url).connect();
  await new Promise(function (resolve) {
    const reqId = 'req_unknown';
    c1.ws.send(JSON.stringify({ requestId: reqId, type: 'totally_unknown_type' }));
    c1.ws.once('message', function (raw) {
      const msg = JSON.parse(raw.toString());
      check('未知 type 返回 error', msg.type === 'error' && msg.error.code === 'UNKNOWN_TYPE');
      resolve();
    });
  });

  // 3. ping 正常
  const pong = await c1.send('ping');
  check('ping 返回 pong', !!pong.pong);

  // 4. create_room 返回完整字段
  const created = await c1.send('create_room', { payload: { hostName: '主机玩家', mode: 'online' } });
  check('create_room 返回 roomId', !!created.roomId);
  check('create_room 返回 roomCode（6位数字）', /^\d{6}$/.test(created.roomCode));
  check('create_room 返回 hostSeatId', created.hostSeatId === 'seat_0');
  check('create_room 返回 hostToken', typeof created.hostToken === 'string' && created.hostToken.length >= 24);
  check('create_room 返回 seatToken', typeof created.seatToken === 'string' && created.seatToken.length >= 24);

  // 5. 缺 roomId（submit_arc_vote 不带 roomId）
  await new Promise(function (resolve) {
    c1.ws.send(JSON.stringify({
      requestId: 'req_noroom', type: 'submit_arc_vote',
      seatId: 'seat_0', token: created.hostToken, payload: { arcId: 'arc_1' },
    }));
    c1.ws.once('message', function (raw) {
      const msg = JSON.parse(raw.toString());
      check('缺 roomId 返回 MISSING_FIELD', msg.type === 'error' && msg.error.code === 'MISSING_FIELD');
      resolve();
    });
  });

  // 6. 缺 token
  await new Promise(function (resolve) {
    c1.ws.send(JSON.stringify({
      requestId: 'req_notoken', type: 'submit_arc_vote',
      roomId: created.roomId, seatId: 'seat_0', payload: { arcId: 'arc_1' },
    }));
    c1.ws.once('message', function (raw) {
      const msg = JSON.parse(raw.toString());
      check('缺 token 返回 MISSING_FIELD', msg.type === 'error' && msg.error.code === 'MISSING_FIELD');
      resolve();
    });
  });

  // 7. 非房主调用 finalize_arc_vote
  // 玩家 B 加入
  const c2 = await createClient(url).connect();
  const joined = await c2.send('join_room', { payload: { roomCode: created.roomCode, displayName: '玩家B' } });
  check('玩家B 加入成功', joined.seatId === 'seat_1' && !!joined.seatToken);

  const failRes = await c2.send('finalize_arc_vote', {
    roomId: created.roomId, seatId: joined.seatId, token: joined.seatToken,
  }).catch(function (e) { return e; });
  check('非房主调用 finalize_arc_vote 返回 NOT_HOST', failRes.code === 'NOT_HOST');

  // 8. 错误 token 被拒
  const badToken = await c2.send('get_room_view', {
    roomId: created.roomId, seatId: joined.seatId, token: 'totally-wrong-token',
  }).catch(function (e) { return e; });
  check('错误 token 返回 UNAUTHORIZED', badToken.code === 'UNAUTHORIZED');

  c1.close(); c2.close();
  await srv.close();
  const ok = summary('协议测试');
  process.exit(ok ? 0 : 1);
}

main().catch(function (e) {
  console.error('协议测试异常:', e);
  process.exit(1);
});
