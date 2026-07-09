/**
 * test-server/test-server-narration-failed.js — AI 失败与重试
 * ============================================================================
 * 使用可控 Mock AI：
 *   - A/B 提交行动后 AI 失败 → room.status = narration_failed
 *   - submittedActorIds / actionsByActorId 不清空（仍 submitted）
 *   - 普通玩家不能改行动（submit/cancel 被拒）
 *   - 非房主不能重试
 *   - 房主重试（仍失败时保持 narration_failed）
 *   - 切换成功 Mock 后房主重试 → 发布章节
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
  console.log('\n[AI 失败与重试测试]');

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

  // 开局（mock 成功）
  const startRes = await A.send('start_room_with_arc_voting', { roomId, seatId: aSeat, token: created.hostToken });
  const candidates = startRes.view.directorVote.candidates;
  await A.send('submit_arc_vote', { roomId, seatId: aSeat, token: created.seatToken, payload: { arcId: candidates[0].arcId } });
  await B.send('submit_arc_vote', { roomId, seatId: bSeat, token: joined.seatToken, payload: { arcId: candidates[0].arcId } });
  const finalizeRes = await A.send('finalize_arc_vote', { roomId, seatId: aSeat, token: created.hostToken });
  check('开局成功进入 collecting', finalizeRes.view.room.status === 'collecting');

  const choicesA = finalizeRes.view.ownActor.ownChoices;
  const choicesB = (await B.send('get_room_view', { roomId, seatId: bSeat, token: joined.seatToken })).view.ownActor.ownChoices;

  // 切换 Mock 为失败
  srv.mock.setMode('fail');

  // A/B 提交行动 → AI 失败
  await A.send('submit_action', { roomId, seatId: aSeat, token: created.seatToken, payload: { action: { choiceId: choicesA[0].id } } });
  // B 提交（B 的提交在 A 之后；B 提交后全员到齐 → 触发结算 → AI 失败）
  const bSubmitRes = await B.send('submit_action', { roomId, seatId: bSeat, token: joined.seatToken, payload: { action: { choiceId: choicesB[0].id } } }).catch(function (e) { return { error: e }; });
  // 等待 narration_failed 广播（B 的提交返回后服务端已广播）
  const failEvt = await A.waitFor(function (m) { return m.type === 'narration_failed'; }, 5000).catch(function () { return null; });
  const viewAfterFail = bSubmitRes && bSubmitRes.view ? bSubmitRes.view : (await B.send('get_room_view', { roomId, seatId: bSeat, token: joined.seatToken })).view;

  check('AI 失败后 room.status = narration_failed', viewAfterFail.room.status === 'narration_failed');
  check('narration_failed 广播已发出', !!failEvt || viewAfterFail.room.status === 'narration_failed');

  // submittedActorIds 未清空：两个席位仍 submitted
  const seatA = viewAfterFail.room.seats.find(function (s) { return s.seatId === aSeat; });
  const seatB = viewAfterFail.room.seats.find(function (s) { return s.seatId === bSeat; });
  check('A 席位仍 submitted（行动未清空）', seatA && seatA.submitted === true);
  check('B 席位仍 submitted（行动未清空）', seatB && seatB.submitted === true);

  // narration_failed 期间不能提交 / 撤回
  const submitBlocked = await A.send('submit_action', { roomId, seatId: aSeat, token: created.seatToken, payload: { action: { choiceId: choicesA[0].id } } }).catch(function (e) { return e; });
  check('narration_failed 期间 submit_action 被拒', submitBlocked && submitBlocked.code !== undefined);
  const cancelBlocked = await A.send('cancel_action', { roomId, seatId: aSeat, token: created.seatToken }).catch(function (e) { return e; });
  check('narration_failed 期间 cancel_action 被拒', cancelBlocked && cancelBlocked.code !== undefined);

  // 非房主不能重试
  const retryBlocked = await B.send('retry_narration', { roomId, seatId: bSeat, token: joined.seatToken }).catch(function (e) { return e; });
  check('非房主 retry_narration 被拒（NOT_HOST）', retryBlocked.code === 'NOT_HOST');

  // 房主重试（Mock 仍失败）→ 保持 narration_failed
  const retry1 = await A.send('retry_narration', { roomId, seatId: aSeat, token: created.hostToken });
  check('重试仍失败时保持 narration_failed', retry1.view && retry1.view.room.status === 'narration_failed');

  // 切换 Mock 为成功 → 房主重试 → 发布章节
  srv.mock.setMode('success');
  const retry2 = await A.send('retry_narration', { roomId, seatId: aSeat, token: created.hostToken });
  check('重试成功后进入 collecting round=2', retry2.view && retry2.view.room.status === 'collecting' && retry2.view.room.round === 2);
  check('重试后已发布章节标题', !!(retry2.view.publicStory && retry2.view.publicStory.title));

  // A/B 看到同一章节
  const viewBfinal = await B.send('get_room_view', { roomId, seatId: bSeat, token: joined.seatToken });
  check('A/B 重试后看到同一章节', retry2.view.publicStory.title === viewBfinal.view.publicStory.title);

  A.close(); B.close();
  await srv.close();
  const ok = summary('AI 失败与重试测试');
  process.exit(ok ? 0 : 1);
}

main().catch(function (e) {
  console.error('AI 失败测试异常:', e);
  process.exit(1);
});
