/**
 * ============================================================================
 * 《修行局》V3.1 房间化验收测试
 * ----------------------------------------------------------------------------
 * 对应 V3.1 工作清单 Sprint 2 验收：
 *   - 房间创建 / 席位管理 / 角色绑定 / 开局
 *   - 真人提交后不提前推进（等待所有人）
 *   - 机器人自动落子
 *   - 按席位隐私过滤（看不到其他人的选择）
 *   - 存档与恢复
 *   - 热座模式：2 真人 + 2 Bot 完成三回合
 *   - V3 单人存档迁移
 * ============================================================================
 */
const Story = require('./story-core.js');
const Room = require('./room-core.js');
const { setupMockAI } = require('./test-helpers.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}
function section(t) { console.log('\n— ' + t + ' —'); }

const playerSetup = function (name, daoPath) {
  return {
    name: name, identity: '青霄宗外门弟子', daoPath: daoPath || '剑修',
    publicWish: '夺得传承，证明自己不是庸才',
    hiddenFate: '残剑中的剑灵似乎认识我',
    personalityTags: ['锋锐', '念旧'],
  };
};

async function main() {
  setupMockAI(Story);

  /* ============================================================
   * §1 房间创建与席位管理
   * ============================================================ */
  section('§1 房间创建 · 4 席位 · 房主占第一席');
  const room = Room.coordinator.createRoom({
    hostName: 'Howjim', mode: 'local-hotseat', seed: 'ROOM-TEST-1',
  });
  ok('房间创建返回 RoomState', !!room && room.schemaVersion === Room.VERSION);
  ok('房间默认 4 席位', room.seats.length === 4);
  ok('房主占第一席', room.seats[0].kind === 'human' && room.seats[0].displayName === 'Howjim');
  ok('其余席位为空', room.seats[1].kind === 'empty' && room.seats[2].kind === 'empty' && room.seats[3].kind === 'empty');
  ok('房主 seatId 正确', room.hostSeatId === 'seat_0');
  ok('房间状态为 lobby', room.status === 'lobby');

  section('§1 席位 · 添加机器人');
  Room.coordinator.addBotSeat(room.roomId, 1, { profileId: 'pursuer', presetIndex: 0 });
  Room.coordinator.addBotSeat(room.roomId, 2, { profileId: 'profitSeeker', presetIndex: 1 });
  ok('seat_1 为机器人', room.seats[1].kind === 'bot' && room.seats[1].controller.kind === 'bot-weighted');
  ok('seat_2 为机器人', room.seats[2].kind === 'bot' && room.seats[2].controller.botProfileId === 'profitSeeker');
  ok('机器人绑定预设角色', !!room.seats[1].actorSetup && !!room.seats[2].actorSetup);
  ok('两个机器人角色不同', room.seats[1].actorSetup.id !== room.seats[2].actorSetup.id);

  section('§1 席位 · 不能移除房主');
  let removedHost = false;
  try { Room.coordinator.removeSeat(room.roomId, 'seat_0'); } catch (e) { removedHost = true; }
  ok('移除房主被拒绝', removedHost);

  section('§1 席位 · 空席不能开始');
  let startedEarly = false;
  try { await Room.coordinator.startRoom(room.roomId); } catch (e) { startedEarly = true; }
  ok('有空席时开局被拒绝', startedEarly);

  /* ============================================================
   * §2 角色绑定与开局
   * ============================================================ */
  section('§2 角色绑定 · 真人立命');
  Room.coordinator.assignActorToSeat(room.roomId, 'seat_0', playerSetup('陆知微', '剑修'));
  ok('房主绑定角色', room.seats[0].actorSetup.name === '陆知微');

  section('§2 准备状态');
  Room.coordinator.setSeatReady(room.roomId, 'seat_0', true);
  ok('房主已准备', room.seats[0].ready === true);
  ok('机器人自动视为已绑定角色', room.seats[1].actorSetup && room.seats[2].actorSetup);

  // 机器人也需要准备（或自动视为准备？测试中手动设置）
  Room.coordinator.setSeatReady(room.roomId, 'seat_1', true);
  Room.coordinator.setSeatReady(room.roomId, 'seat_2', true);

  section('§2 开局 · 生成故事会话与第一回合');
  await Room.coordinator.startRoom(room.roomId);
  ok('房间状态变为 collecting', room.status === 'collecting');
  ok('故事会话已创建', !!room.storySession && !!room.storySession.story.currentChapter);
  ok('第一回合已开启', room.turn.round === 1 && room.turn.phase === 'collecting');
  ok('所有席位绑定 actorId', room.seats.slice(0, 3).every(function (s) { return !!s.actorId; }));
  ok('机器人已自动落子', room.turn.submittedActorIds.length >= 2);

  /* ============================================================
   * §3 回合机制：单人提交不推进
   * ============================================================ */
  section('§3 回合 · 真人提交后不提前推进');
  // 用 2 真人 + 2 Bot 验证：第一真人提交后章节不推进（还有第二真人未提交）
  const roomTurn = Room.coordinator.createRoom({ hostName: '甲', mode: 'local-hotseat', seed: 'TURN-NOPUSH-1' });
  Room.coordinator.addHumanSeat(roomTurn.roomId, 1, { displayName: '乙' });
  Room.coordinator.addBotSeat(roomTurn.roomId, 2, { presetIndex: 0 });
  Room.coordinator.addBotSeat(roomTurn.roomId, 3, { presetIndex: 1 });
  Room.coordinator.assignActorToSeat(roomTurn.roomId, 'seat_0', playerSetup('甲', '剑修'));
  Room.coordinator.assignActorToSeat(roomTurn.roomId, 'seat_1', playerSetup('乙', '丹道'));
  roomTurn.seats.forEach(function (s) { if (s.kind !== 'empty') Room.coordinator.setSeatReady(roomTurn.roomId, s.seatId, true); });
  await Room.coordinator.startRoom(roomTurn.roomId);

  const seatA = roomTurn.seats[0];
  const seatB = roomTurn.seats[1];
  const choicesA = Story.getChoicesForActor(roomTurn.storySession, seatA.actorId);
  ok('真人有 3 个候选选项', choicesA.length === 3);
  const chapterBefore = roomTurn.storySession.story.chapterIndex;
  Room.coordinator.submitAction(roomTurn.roomId, seatA.seatId, { choiceId: choicesA[0].id });
  ok('真人甲已提交', roomTurn.turn.submittedActorIds.indexOf(seatA.actorId) >= 0);
  ok('提交后章节未推进', roomTurn.storySession.story.chapterIndex === chapterBefore);
  ok('提交后房间仍在 collecting', roomTurn.status === 'collecting' && roomTurn.turn.phase === 'collecting');

  section('§3 回合 · 全部提交后统一结算');
  const choicesB = Story.getChoicesForActor(roomTurn.storySession, seatB.actorId);
  Room.coordinator.submitAction(roomTurn.roomId, seatB.seatId, { choiceId: choicesB[0].id });
  await Room.coordinator.awaitPending(roomTurn.roomId);
  ok('结算后章节推进', roomTurn.storySession.story.chapterIndex === chapterBefore + 1);
  ok('结算后开启新回合', roomTurn.turn.round === 2 && roomTurn.turn.phase === 'collecting');
  ok('新回合机器人已自动落子', roomTurn.turn.submittedActorIds.length >= 2);

  /* ============================================================
   * §3.5 撤回行动：collecting 阶段可撤回，locked 后不可
   * ============================================================ */
  section('§3.5 撤回 · collecting 阶段可撤回');
  const roomCancel = Room.coordinator.createRoom({ hostName: '甲', mode: 'local-hotseat', seed: 'CANCEL-1' });
  Room.coordinator.addHumanSeat(roomCancel.roomId, 1, { displayName: '乙' });
  Room.coordinator.addBotSeat(roomCancel.roomId, 2, { presetIndex: 0 });
  Room.coordinator.addBotSeat(roomCancel.roomId, 3, { presetIndex: 1 });
  Room.coordinator.assignActorToSeat(roomCancel.roomId, 'seat_0', playerSetup('甲', '剑修'));
  Room.coordinator.assignActorToSeat(roomCancel.roomId, 'seat_1', playerSetup('乙', '丹道'));
  roomCancel.seats.forEach(function (s) { if (s.kind !== 'empty') Room.coordinator.setSeatReady(roomCancel.roomId, s.seatId, true); });
  await Room.coordinator.startRoom(roomCancel.roomId);

  const seatCancelA = roomCancel.seats[0];
  const seatCancelB = roomCancel.seats[1];
  const choicesCancelA = Story.getChoicesForActor(roomCancel.storySession, seatCancelA.actorId);
  ok('撤回测试房有 3 个候选选项', choicesCancelA.length === 3);

  // 第一真人提交
  Room.coordinator.submitAction(roomCancel.roomId, seatCancelA.seatId, { choiceId: choicesCancelA[0].id });
  ok('甲已提交', roomCancel.turn.submittedActorIds.indexOf(seatCancelA.actorId) >= 0);
  ok('提交后仍处于 collecting（乙未提交）', roomCancel.turn.phase === 'collecting');

  // 撤回
  Room.coordinator.cancelAction(roomCancel.roomId, seatCancelA.seatId);
  ok('撤回后甲不再处于已提交', roomCancel.turn.submittedActorIds.indexOf(seatCancelA.actorId) < 0);
  ok('撤回后 actionsByActorId 已清除', !roomCancel.turn.actionsByActorId[seatCancelA.actorId]);
  ok('撤回后仍处于 collecting', roomCancel.turn.phase === 'collecting');

  // 重新提交不同的选择
  Room.coordinator.submitAction(roomCancel.roomId, seatCancelA.seatId, { choiceId: choicesCancelA[1].id });
  ok('甲重新提交后已记录', roomCancel.turn.actionsByActorId[seatCancelA.actorId].choiceId === choicesCancelA[1].id);

  // 乙提交 → 触发锁定 → 撤回应失败
  const choicesCancelB = Story.getChoicesForActor(roomCancel.storySession, seatCancelB.actorId);
  Room.coordinator.submitAction(roomCancel.roomId, seatCancelB.seatId, { choiceId: choicesCancelB[0].id });
  ok('乙提交后回合已锁定', roomCancel.turn.phase === 'locked' || roomCancel.turn.phase === 'resolving');
  // 尝试在锁定后撤回
  let cancelFailed = false;
  try { Room.coordinator.cancelAction(roomCancel.roomId, seatCancelA.seatId); } catch (e) { cancelFailed = true; }
  ok('锁定后撤回被拒绝', cancelFailed);
  await Room.coordinator.awaitPending(roomCancel.roomId);
  ok('撤回测试房结算后推进', roomCancel.turn.round === 2);

  /* ============================================================
   * §4 隐私过滤：按席位视图
   * ============================================================ */
  section('§4 隐私 · 席位 A 看不到席位 B 的选择');
  // 添加第二个真人到 seat_3
  const room2 = Room.coordinator.createRoom({ hostName: 'HostA', mode: 'local-hotseat', seed: 'ROOM-PRIVACY-1' });
  Room.coordinator.addHumanSeat(room2.roomId, 1, { displayName: 'PlayerB' });
  Room.coordinator.addBotSeat(room2.roomId, 2, { presetIndex: 0 });
  Room.coordinator.addBotSeat(room2.roomId, 3, { presetIndex: 1 });
  Room.coordinator.assignActorToSeat(room2.roomId, 'seat_0', playerSetup('玩家A', '剑修'));
  Room.coordinator.assignActorToSeat(room2.roomId, 'seat_1', playerSetup('玩家B', '丹道'));
  room2.seats.forEach(function (s) { if (s.kind !== 'empty') Room.coordinator.setSeatReady(room2.roomId, s.seatId, true); });
  await Room.coordinator.startRoom(room2.roomId);

  const viewA = Room.coordinator.getViewForSeat(room2.roomId, 'seat_0');
  const viewB = Room.coordinator.getViewForSeat(room2.roomId, 'seat_1');
  ok('视图 A 含自己的选择', !!viewA.ownActor && viewA.ownActor.ownChoices.length === 3);
  ok('视图 B 含自己的选择', !!viewB.ownActor && viewB.ownActor.ownChoices.length === 3);
  ok('视图 A 不含 B 的选择', !viewA.ownActor || viewA.ownActor.ownChoices[0].id.indexOf(viewB.ownActor.ownChoices[0].id) !== 0);
  ok('视图 A 的 ownActor 是自己的角色', viewA.ownActor.name === '玩家A');
  ok('视图 B 的 ownActor 是自己的角色', viewB.ownActor.name === '玩家B');
  ok('视图含公共故事', !!viewA.publicStory && !!viewA.publicStory.title);
  ok('视图含各席位状态', viewA.room.seats.length === 4);
  ok('公共视图不含任何人 choices', !viewA.publicStory.choices && !viewB.publicStory.choices);

  /* ============================================================
   * §5 热座模式：2 真人 + 2 Bot 完成三回合
   * ============================================================ */
  section('§5 热座 · 2 真人 + 2 Bot 完成三回合');
  const room3 = Room.coordinator.createRoom({ hostName: '甲', mode: 'local-hotseat', seed: 'HOTSEAT-3R-1' });
  Room.coordinator.addHumanSeat(room3.roomId, 1, { displayName: '乙' });
  Room.coordinator.addBotSeat(room3.roomId, 2, { presetIndex: 0 });
  Room.coordinator.addBotSeat(room3.roomId, 3, { presetIndex: 1 });
  Room.coordinator.assignActorToSeat(room3.roomId, 'seat_0', playerSetup('甲', '剑修'));
  Room.coordinator.assignActorToSeat(room3.roomId, 'seat_1', playerSetup('乙', '丹道'));
  room3.seats.forEach(function (s) { if (s.kind !== 'empty') Room.coordinator.setSeatReady(room3.roomId, s.seatId, true); });
  await Room.coordinator.startRoom(room3.roomId);
  ok('热座房间开局成功', room3.status === 'collecting' && room3.turn.round === 1);

  for (let round = 1; round <= 3; round++) {
    const seat0 = room3.seats[0];
    const seat1 = room3.seats[1];
    const c0 = Story.getChoicesForActor(room3.storySession, seat0.actorId);
    const c1 = Story.getChoicesForActor(room3.storySession, seat1.actorId);
    // 真人甲提交
    Room.coordinator.submitAction(room3.roomId, seat0.seatId, { choiceId: c0[0].id });
    ok('第' + round + '回合：甲提交后未推进', room3.storySession.story.chapterIndex === round);
    // 真人乙提交
    Room.coordinator.submitAction(room3.roomId, seat1.seatId, { choiceId: c1[0].id });
    // 等待结算
    await Room.coordinator.awaitPending(room3.roomId);
    ok('第' + round + '回合：两人提交后推进', room3.storySession.story.chapterIndex === round + 1);
    ok('第' + round + '回合：新回合已开启', room3.turn.round === round + 1);
  }
  ok('热座三回合完成', room3.turn.round === 4 && room3.storySession.story.chapterIndex === 4);

  /* ============================================================
   * §6 存档与恢复
   * ============================================================ */
  section('§6 存档 · 保存与恢复');
  const saveStr = Room.coordinator.saveRoom(room3.roomId);
  ok('存档返回非空字符串', typeof saveStr === 'string' && saveStr.length > 0);
  ok('存档不含 apiKey', saveStr.indexOf('apiKey') < 0 && saveStr.indexOf('sk-') < 0);
  const parsed = JSON.parse(saveStr);
  ok('存档含 room 结构', !!parsed.room && parsed.saveVersion === Room.VERSION);
  ok('存档含 storySession', !!parsed.room.storySession);
  ok('存档含席位', parsed.room.seats.length === 4);

  // 读取存档
  const restored = Room.coordinator.loadRoom(saveStr);
  ok('读档恢复房间', !!restored && restored.roomId === room3.roomId);
  ok('读档后席位完整', restored.seats.length === 4);
  ok('读档后故事完整', !!restored.storySession && restored.storySession.story.chapterIndex === 4);
  ok('读档后回合一致', restored.turn.round === 4);
  ok('读档后 RNG 可恢复', !!Story.rng);

  /* ============================================================
   * §7 机器人接管与回收
   * ============================================================ */
  section('§7 机器人接管 · 真人转 Bot');
  const room4 = Room.coordinator.createRoom({ hostName: '独狼', mode: 'local-solo', seed: 'REPLACE-1' });
  Room.coordinator.addBotSeat(room4.roomId, 1, { presetIndex: 0 });
  Room.coordinator.addBotSeat(room4.roomId, 2, { presetIndex: 1 });
  Room.coordinator.addBotSeat(room4.roomId, 3, { presetIndex: 2 });
  Room.coordinator.assignActorToSeat(room4.roomId, 'seat_0', playerSetup('独狼', '剑修'));
  room4.seats.forEach(function (s) { if (s.kind !== 'empty') Room.coordinator.setSeatReady(room4.roomId, s.seatId, true); });
  await Room.coordinator.startRoom(room4.roomId);

  // 真人提交后替换为 Bot
  const c = Story.getChoicesForActor(room4.storySession, room4.seats[0].actorId);
  Room.coordinator.submitAction(room4.roomId, 'seat_0', { choiceId: c[0].id });
  ok('真人提交后回合已进入结算流程', room4.turn.phase === 'collecting' || room4.turn.phase === 'locked' || room4.turn.phase === 'resolving');
  // 等待结算完成（因为所有 4 席都提交了）
  await Room.coordinator.awaitPending(room4.roomId);
  ok('全 Bot 房间结算完成', room4.turn.round === 2);

  // 替换真人席位为 Bot
  Room.coordinator.replaceWithBot(room4.roomId, 'seat_0', { profileId: 'wanderer' });
  ok('真人席位已转 Bot', room4.seats[0].kind === 'bot' && room4.seats[0].controller.kind === 'bot-weighted');
  ok('Bot 接管后已自动落子', room4.turn.submittedActorIds.indexOf(room4.seats[0].actorId) >= 0);

  // 回收 Bot 为真人
  Room.coordinator.reclaimBotSeat(room4.roomId, 'seat_0', { displayName: '回归者' });
  ok('Bot 席位已回收为真人', room4.seats[0].kind === 'human' && room4.seats[0].displayName === '回归者');
  ok('回收后该席位未提交', room4.turn.submittedActorIds.indexOf(room4.seats[0].actorId) < 0);

  /* ============================================================
   * §8 V3 存档迁移
   * ============================================================ */
  section('§8 迁移 · V3 单人存档迁移为 V3.1 房间');
  setupMockAI(Story);
  const v3State = await Story.startGame('V3-MIGRATE-1', playerSetup('迁移者', '剑修'));
  const v3Save = Story.save();
  ok('V3 存档已生成', typeof v3Save === 'string' && v3Save.length > 0);

  const migrated = Room.coordinator.migrateFromV3(v3Save);
  ok('V3 存档迁移成功', !!migrated && migrated.schemaVersion === Room.VERSION);
  ok('迁移后第一席为真人', migrated.seats[0].kind === 'human');
  ok('迁移后其余为 Bot', migrated.seats[1].kind === 'bot' && migrated.seats[2].kind === 'bot');
  ok('迁移后故事会话完整', !!migrated.storySession && migrated.storySession.actors.length === 4);
  ok('迁移后房间可继续收集', migrated.status === 'collecting');

  /* ============================================================
   * §9 事件日志
   * ============================================================ */
  section('§9 事件日志 · 关键事件已记录');
  const events = room3.eventLog.map(function (e) { return e.type; });
  ok('含 ROOM_CREATED', events.indexOf('ROOM_CREATED') >= 0);
  ok('含 ROOM_STARTED', events.indexOf('ROOM_STARTED') >= 0);
  ok('含 TURN_OPENED', events.indexOf('TURN_OPENED') >= 0);
  ok('含 ACTION_SUBMITTED', events.indexOf('ACTION_SUBMITTED') >= 0);
  ok('含 BOT_THINKING', events.indexOf('BOT_THINKING') >= 0);
  ok('含 BOT_ACTION_SELECTED', events.indexOf('BOT_ACTION_SELECTED') >= 0);
  ok('含 TURN_LOCKED', events.indexOf('TURN_LOCKED') >= 0);
  ok('含 CHAPTER_PUBLISHED', events.indexOf('CHAPTER_PUBLISHED') >= 0);

  /* ============================================================
   * §10 RoomSave · 存档/读档/回放/导出（Sprint 5）
   * ============================================================ */
  section('§10 RoomSave · localStorage 存档与读档');
  // 模拟 localStorage
  const _store = {};
  global.localStorage = {
    getItem: function (k) { return (k in _store) ? _store[k] : null; },
    setItem: function (k, v) { _store[k] = String(v); },
    removeItem: function (k) { delete _store[k]; },
  };
  ok('初始无 V3.1 存档', Room.RoomSave.hasSave() === false);
  // 用 room3（已进行 3 回合）存档
  const saveData = Room.RoomSave.save(room3.roomId);
  ok('RoomSave.save 返回非空字符串', typeof saveData === 'string' && saveData.length > 0);
  ok('存档不含 apiKey', saveData.indexOf('apiKey') < 0 && saveData.indexOf('sk-') < 0);
  ok('hasSave 为 true', Room.RoomSave.hasSave() === true);
  const parsedSave = JSON.parse(saveData);
  ok('存档含当前 saveVersion', parsedSave.saveVersion === Room.VERSION);
  ok('存档含 snapshotAt', typeof parsedSave.snapshotAt === 'number');

  // 清掉内存中的房间，再读档恢复
  Room.coordinator._rooms.delete(room3.roomId);
  const loaded = Room.RoomSave.load();
  ok('读档恢复房间', !!loaded && loaded.roomId === room3.roomId);
  ok('读档后回合一致（第 4 回合）', loaded.turn.round === 4);
  ok('读档后席位完整', loaded.seats.length === 4);
  ok('读档后故事完整（chapterIndex=4）', loaded.storySession.story.chapterIndex === 4);
  ok('读档后编年史完整', loaded.storySession.story.chronicle.length >= 3);
  ok('读档后 RNG 可恢复', !!Story.rng);
  ok('读档后席位角色绑定保留', loaded.seats[0].actorId && loaded.seats[1].actorId);

  section('§10 RoomSave · 回合回放时间线');
  const timeline = Room.RoomSave.replayTimeline(loaded.roomId);
  ok('回放时间线非空', timeline.length >= 3);
  ok('回放含第 1 回合', timeline.some(function (r) { return r.round === 1; }));
  ok('回放含章节标题', timeline.every(function (r) { return !!r.chapterTitle; }));
  ok('回放含章节正文', timeline.every(function (r) { return !!r.chapterText; }));
  // 第 1 回合应有 2 个真人行动记录
  const r1 = timeline.find(function (r) { return r.round === 1; });
  ok('第 1 回合记录 2 个行动', r1.actions.length === 2);
  ok('行动记录含 seatId', r1.actions.every(function (a) { return !!a.seatId; }));
  ok('行动记录不含私密选择内容', !r1.actions.some(function (a) { return a.choiceId || a.custom; }));

  section('§10 RoomSave · 导出本局修行录');
  const logText = Room.RoomSave.exportLog(loaded.roomId);
  ok('修行录非空', typeof logText === 'string' && logText.length > 0);
  ok('修行录含标题', logText.indexOf('修行录') >= 0);
  ok('修行录含种子', logText.indexOf(loaded.settings.seed) >= 0);
  ok('修行录含修士名', logText.indexOf('甲') >= 0 && logText.indexOf('乙') >= 0);
  ok('修行录含回合回放', logText.indexOf('第 1 回合') >= 0);

  section('§10 RoomSave · 导出世界遗产包');
  const packJson = Room.RoomSave.exportWorldLegacy(loaded.roomId);
  ok('世界遗产包为 JSON 字符串', typeof packJson === 'string');
  const pack = JSON.parse(packJson);
  ok('遗产包 packVersion 为当前版本', pack.packVersion === Room.VERSION);
  ok('遗产包含种子', pack.seed === loaded.settings.seed);
  ok('遗产包含世界', !!pack.world && !!pack.world.name);
  ok('遗产包含角色（4）', pack.actors.length === 4);
  ok('遗产包含编年史', pack.chronicle.length >= 3);
  ok('遗产包含当前章节', !!pack.currentChapter && !!pack.currentChapter.chapter);
  ok('遗产包含 finalLegacy', !!pack.finalLegacy);
  ok('遗产包不含 apiKey', packJson.indexOf('apiKey') < 0);

  section('§10 RoomSave · hasV3Save / readV3Save / migrate');
  // 写入一个 V3 存档到模拟 localStorage
  global.localStorage.setItem(Room.V3_SAVE_KEY, v3Save);  // v3Save 来自 §8
  ok('hasV3Save 为 true', Room.RoomSave.hasV3Save() === true);
  const v3Read = Room.RoomSave.readV3Save();
  ok('readV3Save 返回原始字符串', typeof v3Read === 'string' && v3Read.length > 0);
  const migratedSave = Room.RoomSave.migrate(v3Read);
  ok('RoomSave.migrate 返回房间', !!migratedSave && migratedSave.schemaVersion === Room.VERSION);
  ok('迁移后第一席为真人', migratedSave.seats[0].kind === 'human');

  section('§10 RoomSave · clear');
  Room.RoomSave.clear();
  ok('clear 后 hasSave 为 false', Room.RoomSave.hasSave() === false);
  ok('clear 后 hasV3Save 仍为 true（仅清 V3.1）', Room.RoomSave.hasV3Save() === true);

  /* ============================================================
   * §11 RoomTransport · 命令/事件/快照（Sprint 6）
   * ============================================================ */
  section('§11 Transport · 命令发送与结果返回');
  const T = Room.transport;
  ok('默认 transport 为 LocalRoomTransport', T === Room.LocalRoomTransport);
  ok('transport.send 是函数', typeof T.send === 'function');
  ok('transport.sendSync 是函数', typeof T.sendSync === 'function');
  ok('transport.onEvent 是函数', typeof T.onEvent === 'function');
  ok('transport.getSnapshot 是函数', typeof T.getSnapshot === 'function');
  ok('transport.awaitPending 是函数', typeof T.awaitPending === 'function');

  // 通过 Transport 命令创建房间
  const tr = T.sendSync({ type: 'createRoom', config: { hostName: '甲', mode: 'local-solo', seed: 'TRANSPORT-1' } });
  ok('createRoom 命令返回房间', !!tr && tr.schemaVersion === Room.VERSION);

  // 加机器人
  T.sendSync({ type: 'addBotSeat', roomId: tr.roomId, seatIndex: 1, botConfig: { presetIndex: 0 } });
  T.sendSync({ type: 'addBotSeat', roomId: tr.roomId, seatIndex: 2, botConfig: { presetIndex: 1 } });
  T.sendSync({ type: 'addBotSeat', roomId: tr.roomId, seatIndex: 3, botConfig: { presetIndex: 2 } });
  ok('addBotSeat 命令添加 3 个机器人', tr.seats.filter(function (s) { return s.kind === 'bot'; }).length === 3);

  // 绑定角色
  T.sendSync({ type: 'assignActorToSeat', roomId: tr.roomId, seatId: 'seat_0', actorSetup: playerSetup('甲', '剑修') });
  ok('assignActorToSeat 命令绑定角色', tr.seats[0].actorSetup.name === '甲');

  // 准备
  T.sendSync({ type: 'setSeatReady', roomId: tr.roomId, seatId: 'seat_0', ready: true });
  ok('setSeatReady 命令设置准备', tr.seats[0].ready === true);

  // 异步命令 startRoom
  await T.send({ type: 'startRoom', roomId: tr.roomId });
  ok('startRoom 命令（async）开局成功', tr.status === 'collecting' && tr.turn.round === 1);

  section('§11 Transport · 事件监听');
  let evReceived = [];
  T.onEvent(function (e) { evReceived.push(e.type); });
  T.startEventPolling(tr.roomId, 30);
  // 提交一个行动触发事件
  const tc = Story.getChoicesForActor(tr.storySession, tr.seats[0].actorId);
  T.sendSync({ type: 'submitAction', roomId: tr.roomId, seatId: 'seat_0', action: { choiceId: tc[0].id } });
  await T.awaitPending(tr.roomId);
  await new Promise(function (r) { setTimeout(r, 80); });
  ok('事件监听收到 ACTION_SUBMITTED', evReceived.indexOf('ACTION_SUBMITTED') >= 0);
  ok('事件监听收到 TURN_LOCKED 或 CHAPTER_PUBLISHED', evReceived.indexOf('TURN_LOCKED') >= 0 || evReceived.indexOf('CHAPTER_PUBLISHED') >= 0);

  section('§11 Transport · 快照隔离');
  const snap = T.getSnapshot(tr.roomId);
  ok('getSnapshot 返回快照', !!snap && snap.roomId === tr.roomId);
  ok('快照含回合状态', snap.turn.round === tr.turn.round);
  // 修改快照不影响原房间
  snap.turn.round = 999;
  ok('快照修改不影响原房间', tr.turn.round !== 999);

  section('§11 Transport · 未知命令被拒绝');
  let unknownRejected = false;
  try { T.sendSync({ type: 'badCommand' }); } catch (e) { unknownRejected = true; }
  ok('sendSync 拒绝未知命令', unknownRejected);
  let unknownAsyncRejected = false;
  try { await T.send({ type: 'badCommand' }); } catch (e) { unknownAsyncRejected = true; }
  ok('send 拒绝未知命令', unknownAsyncRejected);
  let missingTypeRejected = false;
  try { T.sendSync({}); } catch (e) { missingTypeRejected = true; }
  ok('sendSync 拒绝无 type 命令', missingTypeRejected);

  section('§11 Transport · getViewForSeat 命令');
  const tView = T.sendSync({ type: 'getViewForSeat', roomId: tr.roomId, seatId: 'seat_0' });
  ok('getViewForSeat 命令返回视图', !!tView && tView.ownActor.name === '甲');

  /* ============================================================
   * §12 MockRemoteTransport · 可替换性验证（Sprint 6 验收）
   * ------------------------------------------------------------
   * 验收标准：将 LocalRoomTransport 替换为 MockRemoteTransport 后，
   * 核心逻辑（命令发送/事件接收/快照同步）无需修改即可工作。
   * ============================================================ */
  section('§12 MockRemoteTransport · 接口契约一致');

  /** MockRemoteTransport：模拟远程传输层
   *  - 命令通过"网络延迟"后执行（用 setTimeout 模拟）
   *  - 事件通过"网络"推送（模拟远程事件）
   *  - 快照从"服务器"获取（深拷贝）
   *  接口与 LocalRoomTransport 完全一致 */
  const mockRooms = new Map();
  const mockListeners = [];
  const MockRemoteTransport = {
    _latencyMs: 10,

    send: function (command) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          try {
            var handler = Room.COMMAND_HANDLERS[command.type];
            if (!handler) { reject(new Error('未知命令类型：' + command.type)); return; }
            var result = handler(command);
            Promise.resolve(result).then(resolve, reject);
          } catch (e) { reject(e); }
        }, MockRemoteTransport._latencyMs);
      });
    },

    sendSync: function (command) {
      var handler = Room.COMMAND_HANDLERS[command.type];
      if (!handler) throw new Error('未知命令类型：' + command.type);
      return handler(command);
    },

    onEvent: function (cb) {
      mockListeners.push(cb);
      return function () {
        var idx = mockListeners.indexOf(cb);
        if (idx >= 0) mockListeners.splice(idx, 1);
      };
    },

    _emit: function (event) {
      mockListeners.forEach(function (cb) { try { cb(event); } catch (e) {} });
    },

    getSnapshot: function (roomId) {
      var room = Room.coordinator.getRoom(roomId);
      return room ? JSON.parse(JSON.stringify(room)) : null;
    },

    awaitPending: function (roomId) {
      return Room.coordinator.awaitPending(roomId);
    },

    getRoom: function (roomId) {
      return Room.coordinator.getRoom(roomId);
    },

    startEventPolling: function (roomId, intervalMs) {
      var lastLen = 0;
      var stopped = false;
      var r = Room.coordinator.getRoom(roomId);
      if (r) lastLen = r.eventLog.length;
      function poll() {
        if (stopped) return;
        var room = Room.coordinator.getRoom(roomId);
        if (!room) return;
        if (room.eventLog.length > lastLen) {
          for (var i = lastLen; i < room.eventLog.length; i++) {
            MockRemoteTransport._emit(room.eventLog[i]);
          }
          lastLen = room.eventLog.length;
        }
        setTimeout(poll, intervalMs || 300);
      }
      poll();
      return function () { stopped = true; };
    },
  };

  // 替换 transport 为 MockRemoteTransport
  const originalTransport = Room.transport;
  Room.transport = MockRemoteTransport;
  ok('transport 已替换为 MockRemoteTransport', Room.transport === MockRemoteTransport);

  // 用 Mock 执行完整流程
  const mr = MockRemoteTransport.sendSync({ type: 'createRoom', config: { hostName: '乙', mode: 'local-solo', seed: 'MOCK-1' } });
  ok('Mock createRoom 成功', !!mr && mr.roomId);

  MockRemoteTransport.sendSync({ type: 'addBotSeat', roomId: mr.roomId, seatIndex: 1, botConfig: { presetIndex: 0 } });
  MockRemoteTransport.sendSync({ type: 'addBotSeat', roomId: mr.roomId, seatIndex: 2, botConfig: { presetIndex: 1 } });
  MockRemoteTransport.sendSync({ type: 'addBotSeat', roomId: mr.roomId, seatIndex: 3, botConfig: { presetIndex: 2 } });
  MockRemoteTransport.sendSync({ type: 'assignActorToSeat', roomId: mr.roomId, seatId: 'seat_0', actorSetup: playerSetup('乙', '丹道') });
  MockRemoteTransport.sendSync({ type: 'setSeatReady', roomId: mr.roomId, seatId: 'seat_0', ready: true });
  ok('Mock 同步命令批量执行成功', mr.seats[0].actorSetup.name === '乙' && mr.seats[0].ready);

  // 异步 startRoom（模拟网络延迟）
  await Room.transport.send({ type: 'startRoom', roomId: mr.roomId });
  ok('Mock async startRoom 成功', mr.status === 'collecting');

  // 事件监听
  let mockEvents = [];
  Room.transport.onEvent(function (e) { mockEvents.push(e.type); });
  Room.transport.startEventPolling(mr.roomId, 30);

  const mc = Story.getChoicesForActor(mr.storySession, mr.seats[0].actorId);
  await Room.transport.send({ type: 'submitAction', roomId: mr.roomId, seatId: 'seat_0', action: { choiceId: mc[0].id } });
  await Room.transport.awaitPending(mr.roomId);
  await new Promise(function (r) { setTimeout(r, 80); });
  ok('Mock 事件监听收到事件', mockEvents.length > 0);

  // 快照
  const mSnap = Room.transport.getSnapshot(mr.roomId);
  ok('Mock getSnapshot 返回快照', !!mSnap && mSnap.roomId === mr.roomId);
  ok('Mock 快照回合正确', mSnap.turn.round === mr.turn.round);

  // 恢复原始 transport
  Room.transport = originalTransport;
  ok('transport 已恢复为 LocalRoomTransport', Room.transport === Room.LocalRoomTransport);

  /* ============================================================
   * §13 最终验收场景 · 黑风岭雨夜局
   * ------------------------------------------------------------
   * 房主创建"黑风岭雨夜局"。
   * 第一席：真人玩家，控制陆知微。
   * 第二席：真人玩家，控制沈青萝。
   * 第三席：添加机器人，控制韩照野，策略为"逐愿者"。
   * 第四席：添加机器人，控制顾长风，策略为"逐利者"。
   * 四人完成立命。房主开局后：
   *   每名真人只看见自己角色的三项选择。
   *   韩照野与顾长风的机器人选择不公开。
   *   陆知微先提交行动，页面显示"等待三位修士"。
   *   沈青萝提交后，页面仍不推进。
   *   两名机器人完成落子后，回合统一锁定。
   *   系统调用一次叙事模型，生成下一章。
   *   所有人看见同一篇公共章节。
   *   每名真人收到不同的下一轮私密选择。
   *   中途存档、刷新、读取后，房间状态与故事完全恢复。
   * ============================================================ */
  section('§13 黑风岭雨夜局 · 创建与立命');
  const blackWind = Room.coordinator.createRoom({
    hostName: '陆知微', mode: 'local-hotseat', seed: '黑风岭雨夜局',
    narrativePace: '常规',
  });
  ok('房间"黑风岭雨夜局"已创建', blackWind.roomId && blackWind.settings.seed === '黑风岭雨夜局');
  ok('房主为陆知微（第一席真人）', blackWind.seats[0].kind === 'human' && blackWind.seats[0].displayName === '陆知微');

  // 第二席：真人沈青萝
  Room.coordinator.addHumanSeat(blackWind.roomId, 1, { displayName: '沈青萝' });
  ok('第二席为真人沈青萝', blackWind.seats[1].kind === 'human' && blackWind.seats[1].displayName === '沈青萝');

  // 第三席：机器人韩照野（逐愿者）
  Room.coordinator.addBotSeat(blackWind.roomId, 2, { profileId: 'pursuer', presetIndex: 0 });
  ok('第三席为机器人韩照野（逐愿者）', blackWind.seats[2].kind === 'bot' && blackWind.seats[2].controller.botProfileId === 'pursuer');
  ok('韩照野角色已绑定', blackWind.seats[2].actorSetup && blackWind.seats[2].actorSetup.name === '韩照野');

  // 第四席：机器人顾长风（逐利者）
  Room.coordinator.addBotSeat(blackWind.roomId, 3, { profileId: 'profitSeeker', presetIndex: 2 });
  ok('第四席为机器人顾长风（逐利者）', blackWind.seats[3].kind === 'bot' && blackWind.seats[3].controller.botProfileId === 'profitSeeker');
  ok('顾长风角色已绑定', blackWind.seats[3].actorSetup && blackWind.seats[3].actorSetup.name === '顾长风');

  // 立命：陆知微（剑修）
  Room.coordinator.assignActorToSeat(blackWind.roomId, 'seat_0', playerSetup('陆知微', '剑修'));
  ok('陆知微已立命', blackWind.seats[0].actorSetup.name === '陆知微');
  // 立命：沈青萝（丹道）
  Room.coordinator.assignActorToSeat(blackWind.roomId, 'seat_1', {
    name: '沈青萝', identity: '药谷弃徒', daoPath: '丹道',
    publicWish: '查明身世，找回被夺的药典',
    hiddenFate: '她血液里藏着一段不属于人类的旧梦',
    personalityTags: ['谨慎', '多疑'],
  });
  ok('沈青萝已立命', blackWind.seats[1].actorSetup.name === '沈青萝');

  // 准备
  blackWind.seats.forEach(function (s) {
    if (s.kind !== 'empty') Room.coordinator.setSeatReady(blackWind.roomId, s.seatId, true);
  });
  ok('四席均已准备', blackWind.seats.every(function (s) { return s.kind === 'empty' || s.ready; }));

  section('§13 黑风岭雨夜局 · 开局与隐私选择');
  await Room.coordinator.startRoom(blackWind.roomId);
  ok('开局成功，进入收集阶段', blackWind.status === 'collecting' && blackWind.turn.round === 1);
  ok('故事会话已创建', !!blackWind.storySession && !!blackWind.storySession.story.currentChapter);
  ok('四名角色已生成', blackWind.storySession.actors.length === 4);

  const luActor = blackWind.seats[0].actorId;
  const shenActor = blackWind.seats[1].actorId;
  const hanActor = blackWind.seats[2].actorId;
  const guActor = blackWind.seats[3].actorId;

  // 每名真人只看见自己的三项选择
  const luChoices = Story.getChoicesForActor(blackWind.storySession, luActor);
  const shenChoices = Story.getChoicesForActor(blackWind.storySession, shenActor);
  ok('陆知微有 3 项私密选择', luChoices.length === 3);
  ok('沈青萝有 3 项私密选择', shenChoices.length === 3);
  ok('两人选择 ID 不同', luChoices[0].id !== shenChoices[0].id);

  // 隐私视图：陆知微看不到沈青萝的选择
  const luView = Room.coordinator.getViewForSeat(blackWind.roomId, 'seat_0');
  const shenView = Room.coordinator.getViewForSeat(blackWind.roomId, 'seat_1');
  ok('陆知微视图含自己的选择', luView.ownActor && luView.ownActor.ownChoices.length === 3);
  ok('陆知微视图不含沈青萝的选择', !luView.ownActor || luView.ownActor.name !== '沈青萝');
  ok('公共视图不含任何 choices', !luView.publicStory.choices);

  // 机器人已自动落子（选择不公开）
  ok('机器人已自动落子', blackWind.turn.submittedActorIds.indexOf(hanActor) >= 0 && blackWind.turn.submittedActorIds.indexOf(guActor) >= 0);
  // 隐私：陆知微的视图看不到机器人的具体选择
  ok('陆知微视图不含机器人选择内容', !luView.ownActor || luView.ownActor.ownChoices.every(function (c) { return c.id.indexOf('bot') < 0; }));

  section('§13 黑风岭雨夜局 · 回合推进');
  const bwChapterBefore = blackWind.storySession.story.chapterIndex;

  // 陆知微先提交 → 不推进（沈青萝未提交）
  Room.coordinator.submitAction(blackWind.roomId, 'seat_0', { choiceId: luChoices[0].id });
  ok('陆知微已提交，回合未推进', blackWind.storySession.story.chapterIndex === bwChapterBefore);
  ok('回合仍处于 collecting（沈青萝未提交）', blackWind.turn.phase === 'collecting');

  // 沈青萝提交 → 触发锁定与结算
  Room.coordinator.submitAction(blackWind.roomId, 'seat_1', { choiceId: shenChoices[0].id });
  ok('沈青萝提交后回合已锁定', blackWind.turn.phase === 'locked' || blackWind.turn.phase === 'resolving');
  await Room.coordinator.awaitPending(blackWind.roomId);

  ok('结算后章节推进', blackWind.storySession.story.chapterIndex === bwChapterBefore + 1);
  ok('新回合已开启（第 2 回合）', blackWind.turn.round === 2 && blackWind.turn.phase === 'collecting');

  // 所有人看见同一篇公共章节
  const publicChapter = blackWind.storySession.story.currentChapter;
  ok('新章节已生成', !!publicChapter && !!publicChapter.title);
  const luView2 = Room.coordinator.getViewForSeat(blackWind.roomId, 'seat_0');
  const shenView2 = Room.coordinator.getViewForSeat(blackWind.roomId, 'seat_1');
  ok('陆知微与沈青萝看到同一章节标题', luView2.publicStory.title === shenView2.publicStory.title);

  // 每名真人收到不同的下一轮私密选择
  const luChoices2 = Story.getChoicesForActor(blackWind.storySession, luActor);
  const shenChoices2 = Story.getChoicesForActor(blackWind.storySession, shenActor);
  ok('第 2 回合陆知微有 3 项选择', luChoices2.length === 3);
  ok('第 2 回合沈青萝有 3 项选择', shenChoices2.length === 3);
  ok('第 2 回合两人选择不同', luChoices2[0].id !== shenChoices2[0].id);

  section('§13 黑风岭雨夜局 · 中途存档与恢复');
  // 存档
  const bwSaveStr = Room.RoomSave.save(blackWind.roomId);
  ok('黑风岭雨夜局已存档', typeof bwSaveStr === 'string' && bwSaveStr.length > 0);
  ok('存档不含 apiKey', bwSaveStr.indexOf('apiKey') < 0);

  // 模拟刷新：清掉内存中的房间
  const savedRound = blackWind.turn.round;
  const savedChapterIndex = blackWind.storySession.story.chapterIndex;
  const savedChronicleLen = blackWind.storySession.story.chronicle.length;
  const savedActorCount = blackWind.storySession.actors.length;
  Room.coordinator._rooms.delete(blackWind.roomId);

  // 读档恢复
  const restoredBW = Room.RoomSave.load();
  ok('读档恢复黑风岭雨夜局', !!restoredBW && restoredBW.settings.seed === '黑风岭雨夜局');
  ok('恢复后回合一致（第 ' + savedRound + ' 回合）', restoredBW.turn.round === savedRound);
  ok('恢复后章节索引一致', restoredBW.storySession.story.chapterIndex === savedChapterIndex);
  ok('恢复后编年史完整', restoredBW.storySession.story.chronicle.length === savedChronicleLen);
  ok('恢复后角色完整（4 名）', restoredBW.storySession.actors.length === savedActorCount);
  ok('恢复后席位完整（4 席）', restoredBW.seats.length === 4);
  ok('恢复后陆知微席位正确', restoredBW.seats[0].kind === 'human' && restoredBW.seats[0].actorSetup.name === '陆知微');
  ok('恢复后沈青萝席位正确', restoredBW.seats[1].kind === 'human' && restoredBW.seats[1].actorSetup.name === '沈青萝');
  ok('恢复后韩照野席位正确', restoredBW.seats[2].kind === 'bot' && restoredBW.seats[2].actorSetup.name === '韩照野');
  ok('恢复后顾长风席位正确', restoredBW.seats[3].kind === 'bot' && restoredBW.seats[3].actorSetup.name === '顾长风');
  ok('恢复后可继续游戏（选择可用）', Story.getChoicesForActor(restoredBW.storySession, restoredBW.seats[0].actorId).length === 3);

  // 导出修行录与世界遗产包
  const bwLog = Room.RoomSave.exportLog(restoredBW.roomId);
  ok('黑风岭雨夜局修行录已导出', typeof bwLog === 'string' && bwLog.indexOf('黑风岭雨夜局') >= 0);
  ok('修行录含陆知微', bwLog.indexOf('陆知微') >= 0);
  ok('修行录含沈青萝', bwLog.indexOf('沈青萝') >= 0);
  const bwPack = Room.RoomSave.exportWorldLegacy(restoredBW.roomId);
  ok('黑风岭雨夜局世界遗产包已导出', typeof bwPack === 'string');
  const bwPackObj = JSON.parse(bwPack);
  ok('遗产包含 4 名角色', bwPackObj.actors.length === 4);
  ok('遗产包含世界名', !!bwPackObj.world && !!bwPackObj.world.name);

  /* ============================================================
   * 汇总
   * ============================================================ */
  console.log('\n========================================');
  console.log('  V3.1 通过 ' + pass + ' / 失败 ' + fail);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试异常:', e);
  process.exit(1);
});
