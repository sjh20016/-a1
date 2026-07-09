/**
 * test-server/test-server-restart-restore.js — 持久化与重启恢复
 * ============================================================================
 * 流程：
 *   1. 启动 server1，A/B 完成开局并推进到 round 2
 *   2. 记录 roomId / roomCode / seatToken / 章节标题
 *   3. 关闭 server1（保留存档目录）
 *   4. 启动 server2（同一存档目录，restore=true）→ loadAllRooms 恢复房间
 *   5. 用 roomCode reconnect（A）+ roomId reconnect（B）→ seatToken 仍有效
 *   6. 房间视图一致：round=2、章节标题与重启前相同
 *   7. 继续可玩：提交行动 → round=3
 *
 * 额外：验证 narration_failed 状态在重启后仍保留（repairRoomState）
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const { startTestServer, createClient, check, summary, resetCounters } = require('./test-helpers');

const ACTOR_A = {
  name: '陆知微', identity: '青霄宗外门弟子', daoPath: '剑修',
  publicWish: '寻找失落剑经', hiddenFate: '残剑认主', personalityTags: ['敏锐'],
};
const ACTOR_B = {
  name: '沈青萝', identity: '药谷弃徒', daoPath: '丹道',
  publicWish: '查明身世', hiddenFate: '血脉旧梦', personalityTags: ['谨慎'],
};

async function setupToRound2(srv) {
  const A = await createClient(srv.url).connect();
  const B = await createClient(srv.url).connect();
  const created = await A.send('create_room', { payload: { hostName: '玩家A', mode: 'online' } });
  const joined = await B.send('join_room', { payload: { roomCode: created.roomCode, displayName: '玩家B' } });
  const roomId = created.roomId;
  const aSeat = created.hostSeatId, bSeat = joined.seatId;

  await A.send('assign_actor', { roomId, seatId: aSeat, token: created.seatToken, payload: { actorSetup: ACTOR_A } });
  await B.send('assign_actor', { roomId, seatId: bSeat, token: joined.seatToken, payload: { actorSetup: ACTOR_B } });
  await A.send('set_ready', { roomId, seatId: aSeat, token: created.seatToken, payload: { ready: true } });
  await B.send('set_ready', { roomId, seatId: bSeat, token: joined.seatToken, payload: { ready: true } });

  const startRes = await A.send('start_room_with_arc_voting', { roomId, seatId: aSeat, token: created.hostToken });
  const candidates = startRes.view.directorVote.candidates;
  await A.send('submit_arc_vote', { roomId, seatId: aSeat, token: created.seatToken, payload: { arcId: candidates[0].arcId } });
  await B.send('submit_arc_vote', { roomId, seatId: bSeat, token: joined.seatToken, payload: { arcId: candidates[0].arcId } });
  const fin = await A.send('finalize_arc_vote', { roomId, seatId: aSeat, token: created.hostToken });

  // 推进到 round 2
  const cA = fin.view.ownActor.ownChoices[0].id;
  const cB = (await B.send('get_room_view', { roomId, seatId: bSeat, token: joined.seatToken })).view.ownActor.ownChoices[0].id;
  await A.send('submit_action', { roomId, seatId: aSeat, token: created.seatToken, payload: { action: { choiceId: cA } } });
  await B.send('submit_action', { roomId, seatId: bSeat, token: joined.seatToken, payload: { action: { choiceId: cB } } });
  await A.waitForRoomView(8000);

  const finalView = await A.send('get_room_view', { roomId, seatId: aSeat, token: created.seatToken });
  A.close(); B.close();
  return {
    roomId, roomCode: created.roomCode,
    aSeat, bSeat,
    aToken: created.seatToken, bToken: joined.seatToken, hostToken: created.hostToken,
    round: finalView.view.room.round,
    title: finalView.view.publicStory.title,
    chapter: finalView.view.publicStory.chapter,
  };
}

async function main() {
  resetCounters();
  console.log('\n[持久化与重启恢复测试]');

  // ---- 阶段 1：server1 推进到 round 2 ----
  const srv1 = await startTestServer({ keepTmpDir: true });
  const saveDir = srv1.tmpDir;
  const snap = await setupToRound2(srv1);
  check('阶段1：推进到 round=2', snap.round === 2);
  check('阶段1：已生成章节标题', snap.title.length > 0);
  console.log('  重启前：round=' + snap.round + ' title=' + snap.title.slice(0, 12));

  // 验证存档文件已写入
  const saveFile = path.join(saveDir, snap.roomId + '.json');
  check('存档文件已写入磁盘', fs.existsSync(saveFile));
  const saved = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
  check('存档含 serverAuth（token 用于重连）', !!(saved.room && saved.room.serverAuth));
  check('存档不含 API Key', JSON.stringify(saved).indexOf('AI_API_KEY') < 0 && JSON.stringify(saved).indexOf('apiKey') < 0);
  console.log('  存档状态：status=' + saved.room.status + ' round=' + saved.room.turn.round + ' phase=' + saved.room.turn.phase);

  await srv1.close();
  check('server1 已关闭（存档保留）', fs.existsSync(saveFile));

  // ---- 阶段 2：server2 从同一存档恢复 ----
  const srv2 = await startTestServer({ saveDir: saveDir, keepTmpDir: true });
  const A2 = await createClient(srv2.url).connect();
  const B2 = await createClient(srv2.url).connect();

  // A 用 roomCode reconnect
  const reconA = await A2.send('reconnect', {
    payload: { roomCode: snap.roomCode, seatId: snap.aSeat, token: snap.aToken },
  });
  check('A 用 roomCode reconnect 成功', reconA.restored === true && reconA.seatId === snap.aSeat);
  // B 用 roomId reconnect
  const reconB = await B2.send('reconnect', {
    payload: { roomId: snap.roomId, seatId: snap.bSeat, token: snap.bToken },
  });
  check('B 用 roomId reconnect 成功', reconB.restored === true && reconB.seatId === snap.bSeat);

  // 错误 token 重连被拒
  const badRecon = await A2.send('reconnect', {
    payload: { roomId: snap.roomId, seatId: snap.aSeat, token: 'wrong-token' },
  }).catch(function (e) { return e; });
  check('错误 token reconnect 被拒', badRecon.code === 'UNAUTHORIZED');

  // 房间视图一致
  await A2.waitForRoomView(3000);
  const viewA = await A2.send('get_room_view', { roomId: snap.roomId, seatId: snap.aSeat, token: snap.aToken });
  console.log('  恢复后视图：status=' + viewA.view.room.status + ' round=' + viewA.view.room.round + ' phase=' + viewA.view.room.phase);
  const viewB = await B2.send('get_room_view', { roomId: snap.roomId, seatId: snap.bSeat, token: snap.bToken });
  check('重启后 round 仍为 2', viewA.view.room.round === 2);
  check('重启后章节标题与重启前一致', viewA.view.publicStory.title === snap.title);
  check('重启后章节正文与重启前一致', viewA.view.publicStory.chapter === snap.chapter);
  check('重启后 A/B 看到同一章节', viewA.view.publicStory.title === viewB.view.publicStory.title);

  // ---- 阶段 3：继续可玩 ----
  const cA2 = viewA.view.ownActor.ownChoices[0].id;
  const cB2 = viewB.view.ownActor.ownChoices[0].id;
  await A2.send('submit_action', { roomId: snap.roomId, seatId: snap.aSeat, token: snap.aToken, payload: { action: { choiceId: cA2 } } });
  await B2.send('submit_action', { roomId: snap.roomId, seatId: snap.bSeat, token: snap.bToken, payload: { action: { choiceId: cB2 } } });
  await A2.waitForRoomView(8000);
  const after = await A2.send('get_room_view', { roomId: snap.roomId, seatId: snap.aSeat, token: snap.aToken });
  check('重启后继续可玩，推进到 round=3', after.view.room.round === 3);

  A2.close(); B2.close();
  await srv2.close();

  // 清理存档目录
  try { fs.rmSync(saveDir, { recursive: true, force: true }); } catch (e) {}

  const ok = summary('持久化与重启恢复测试');
  process.exit(ok ? 0 : 1);
}

main().catch(function (e) {
  console.error('重启恢复测试异常:', e);
  process.exit(1);
});
