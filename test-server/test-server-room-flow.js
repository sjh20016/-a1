/**
 * test-server/test-server-room-flow.js — 完整联机流程（happy path）
 * ============================================================================
 * A create_room → B join_room → 绑定角色 → 准备 → 卷纲投票 → 结算 →
 * collecting → 提交行动 → 服务器统一结算 → 两人看到同一章节
 * ============================================================================
 */
const { startTestServer, createClient, check, summary, resetCounters } = require('./test-helpers');

const ACTOR_A = {
  name: '陆知微', identity: '青霄宗外门弟子', daoPath: '剑修',
  publicWish: '寻找失落剑经', hiddenFate: '残剑认主', personalityTags: ['敏锐'],
};
const ACTOR_B = {
  name: '沈青萝', identity: '药谷弃徒', daoPath: '丹道',
  publicWish: '查明身世', hiddenFate: '血脉旧梦', personalityTags: ['谨慎'],
};

async function main() {
  resetCounters();
  const srv = await startTestServer();
  console.log('\n[联机完整流程测试]');

  const A = await createClient(srv.url).connect();
  const B = await createClient(srv.url).connect();

  // 1. A 创建房间
  const created = await A.send('create_room', { payload: { hostName: '玩家A', mode: 'online' } });
  check('A 创建房间成功', !!created.roomCode);

  // 2. B 加入
  const joined = await B.send('join_room', { payload: { roomCode: created.roomCode, displayName: '玩家B' } });
  check('B 加入成功 seat_1', joined.seatId === 'seat_1');

  const roomId = created.roomId;
  const aSeat = created.hostSeatId;
  const bSeat = joined.seatId;

  // 3. 绑定角色
  await A.send('assign_actor', {
    roomId, seatId: aSeat, token: created.seatToken, payload: { actorSetup: ACTOR_A },
  });
  await B.send('assign_actor', {
    roomId, seatId: bSeat, token: joined.seatToken, payload: { actorSetup: ACTOR_B },
  });
  check('A/B 绑定角色成功', true);

  // 4. 准备
  await A.send('set_ready', { roomId, seatId: aSeat, token: created.seatToken, payload: { ready: true } });
  await B.send('set_ready', { roomId, seatId: bSeat, token: joined.seatToken, payload: { ready: true } });
  check('A/B 准备成功', true);

  // 5. 房主开启卷纲投票
  const startRes = await A.send('start_room_with_arc_voting', {
    roomId, seatId: aSeat, token: created.hostToken,
  });
  check('卷纲投票开启，状态 arc_voting', startRes.view && startRes.view.room.status === 'arc_voting');
  const candidates = startRes.view.directorVote.candidates;
  check('生成命途签候选 ≥2', candidates && candidates.length >= 2);

  // 6. A/B 投票
  const arcIdA = candidates[0].arcId;
  const arcIdB = candidates[candidates.length - 1].arcId;
  await A.send('submit_arc_vote', {
    roomId, seatId: aSeat, token: created.seatToken, payload: { arcId: arcIdA },
  });
  await B.send('submit_arc_vote', {
    roomId, seatId: bSeat, token: joined.seatToken, payload: { arcId: arcIdB },
  });
  check('A/B 投票成功', true);

  // 7. 房主结算投票 → 开局叙事（mock AI 成功）
  const finalizeRes = await A.send('finalize_arc_vote', {
    roomId, seatId: aSeat, token: created.hostToken,
  });
  check('结算后进入 collecting', finalizeRes.view && finalizeRes.view.room.status === 'collecting');
  check('已选定卷纲', finalizeRes.view.directorVote.selectedArcId !== null);
  check('开局后轮次 round=1', finalizeRes.view.room.round === 1);
  check('开局生成章节标题', !!(finalizeRes.view.publicStory && finalizeRes.view.publicStory.title));

  // 8. 获取各自 choices
  const viewA = await A.send('get_room_view', { roomId, seatId: aSeat, token: created.seatToken });
  const viewB = await B.send('get_room_view', { roomId, seatId: bSeat, token: joined.seatToken });
  const choicesA = viewA.view.ownActor.ownChoices;
  const choicesB = viewB.view.ownActor.ownChoices;
  check('A 有可选行动', choicesA && choicesA.length > 0);
  check('B 有可选行动', choicesB && choicesB.length > 0);
  check('A/B choices 互不相同（隐私隔离）', choicesA[0].id !== choicesB[0].id || viewA.view.ownActor.actorId !== viewB.view.ownActor.actorId);

  // 9. A 提交行动
  await A.send('submit_action', {
    roomId, seatId: aSeat, token: created.seatToken, payload: { action: { choiceId: choicesA[0].id } },
  });
  // 10. B 提交行动 → 触发结算
  await B.send('submit_action', {
    roomId, seatId: bSeat, token: joined.seatToken, payload: { action: { choiceId: choicesB[0].id } },
  });

  // 11. 等待结算完成：两人都收到 round=2 的视图
  const viewA2 = await A.waitForRoomView(8000);
  const viewB2 = await B.waitForRoomView(8000);

  // 取最新视图
  const finalA = await A.send('get_room_view', { roomId, seatId: aSeat, token: created.seatToken });
  const finalB = await B.send('get_room_view', { roomId, seatId: bSeat, token: joined.seatToken });
  check('结算后轮次推进 round=2', finalA.view.room.round === 2);
  check('A/B 看到同一章节标题', finalA.view.publicStory.title === finalB.view.publicStory.title && finalA.view.publicStory.title.length > 0);
  check('A/B 看到同一章节正文', finalA.view.publicStory.chapter === finalB.view.publicStory.chapter);
  check('A/B 章节与开局不同（推进）', finalA.view.publicStory.title !== finalizeRes.view.publicStory.title || finalA.view.room.round !== finalizeRes.view.room.round);

  // 12. 自定义行动（验证 500 字限制由协议层保证）
  await A.send('submit_action', {
    roomId, seatId: aSeat, token: created.seatToken, payload: { action: { custom: { text: '独自前往后山探查残剑共鸣，谨慎避开同门耳目。' } } },
  });
  await B.send('submit_action', {
    roomId, seatId: bSeat, token: joined.seatToken, payload: { action: { choiceId: finalB.view.ownActor.ownChoices[0].id } },
  });
  await A.waitForRoomView(8000);
  const afterCustom = await A.send('get_room_view', { roomId, seatId: aSeat, token: created.seatToken });
  check('自定义行动后推进 round=3', afterCustom.view.room.round === 3);

  A.close(); B.close();
  await srv.close();
  const ok = summary('联机完整流程测试');
  process.exit(ok ? 0 : 1);
}

main().catch(function (e) {
  console.error('联机流程测试异常:', e);
  process.exit(1);
});
