/* test-v332-director-room.js — V3.3.2 房间层投票验收测试
 *
 * 验证：
 *   1. startRoomWithArcVoting 创建房间并进入 arc_voting。
 *   2. Bot 自动投票。
 *   3. 真人 submitArcVote 投票。
 *   4. 全员投票后 finalizeArcVote 进入游戏。
 *   5. 非投票阶段投票被拒绝。
 *   6. 非真人席位投票被拒绝。
 */
const Room = require('./room-core.js');
const Story = require('./story-core.js');
const helpers = require('./test-helpers.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}

function playerSetup(name, daoPath) {
  return {
    name: name, identity: '青霄宗外门弟子', daoPath: daoPath || '剑修',
    publicWish: '夺得传承，证明自己不是庸才',
    hiddenFate: '残剑中的剑灵似乎认识我',
    personalityTags: ['锋锐', '念旧'],
  };
}

async function main() {
  console.log('\n=== test-v332-director-room ===');

  helpers.setupMockAI(Story);
  Story.setAIEnabled(true);

  // ---- 1. 创建房间 ----
  var room = Room.coordinator.createRoom({
    hostName: '房主', mode: 'local-hotseat', seed: 'DIRECTOR-ROOM',
  });
  ok('房间创建成功', !!room);
  ok('room.status = lobby', room.status === 'lobby');
  ok('房主占第一席', room.seats[0].kind === 'human');
  var humanSeatId = room.seats[0].seatId;

  // 添加 3 个 bot 席位
  Room.coordinator.addBotSeat(room.roomId, 1, { presetIndex: 0 });
  Room.coordinator.addBotSeat(room.roomId, 2, { presetIndex: 1 });
  Room.coordinator.addBotSeat(room.roomId, 3, { presetIndex: 2 });
  ok('Bot 席位已添加', room.seats.filter(function (s) { return s.kind === 'bot'; }).length === 3);

  // 绑定角色
  var occupied = room.seats.filter(function (s) { return s.kind === 'human' || s.kind === 'bot'; });
  occupied.forEach(function (s) {
    var setup = playerSetup(s.displayName, s.actorSetup ? s.actorSetup.daoPath : '剑修');
    Room.coordinator.assignActorToSeat(room.roomId, s.seatId, setup);
    Room.coordinator.setSeatReady(room.roomId, s.seatId, true);
  });
  ok('所有席位已准备', occupied.every(function (s) { return s.ready && s.actorSetup; }));

  // ---- 2. startRoomWithArcVoting ----
  await Room.coordinator.startRoomWithArcVoting(room.roomId);
  ok('开局后 room.status = arc_voting', room.status === 'arc_voting');
  ok('directorVote.phase = voting', room.directorVote.phase === 'voting');
  ok('directorVote.candidates 有 3 张', room.directorVote.candidates.length === 3);
  ok('storySession 已创建', !!room.storySession);

  // ---- 3. Bot 已自动投票 ----
  var botSeats = room.seats.filter(function (s) { return s.kind === 'bot'; });
  botSeats.forEach(function (s) {
    ok('Bot ' + s.displayName + ' 已自动投票',
      room.directorVote.votesBySeatId[s.seatId] !== undefined);
  });
  ok('botVotesBySeatId 已记录', Object.keys(room.directorVote.botVotesBySeatId).length > 0);

  // ---- 4. 真人投票 ----
  var candidates = room.directorVote.candidates;
  Room.coordinator.submitArcVote(room.roomId, humanSeatId, candidates[0].arcId);
  ok('真人投票后记录存在', room.directorVote.votesBySeatId[humanSeatId] === candidates[0].arcId);

  // ---- 5. 真人改票 ----
  Room.coordinator.submitArcVote(room.roomId, humanSeatId, candidates[1].arcId);
  ok('真人改票后记录更新', room.directorVote.votesBySeatId[humanSeatId] === candidates[1].arcId);

  // ---- 6. finalizeArcVote ----
  await Room.coordinator.finalizeArcVote(room.roomId, humanSeatId);
  ok('结算后 directorVote.phase = finalized', room.directorVote.phase === 'finalized');
  ok('selectedArcId 已设置', room.directorVote.selectedArcId !== null);
  ok('selectedArcId 是候选之一', candidates.some(function (c) { return c.arcId === room.directorVote.selectedArcId; }));
  ok('storySession 已有 currentChapter', !!room.storySession && !!room.storySession.story.currentChapter);
  var selected = candidates.find(function (c) { return c.arcId === room.directorVote.selectedArcId; });
  var selectedRecipe = selected && Story.DirectorRecipes[selected.recipeId];
  var sceneEntityIds = (room.storySession.story.currentScene.visibleEntities || []).map(function (e) { return e.id; });
  var seedEntityIds = selectedRecipe.openingSeed.addEntities.map(function (e) { return e.id; });
  ok('选中卷纲 openingSeed 实体已进入开局场景',
    seedEntityIds.every(function (id) { return sceneEntityIds.indexOf(id) >= 0; }),
    'seed=' + seedEntityIds.join(',') + ' scene=' + sceneEntityIds.join(','));
  var threadIds = (room.storySession.story.activeThreads || []).map(function (t) { return t.threadId; });
  var seedThreadIds = selectedRecipe.openingSeed.addThreads.map(function (t) { return t.threadId; });
  ok('选中卷纲 openingSeed 线程已进入 activeThreads',
    seedThreadIds.every(function (id) { return threadIds.indexOf(id) >= 0; }),
    'seed=' + seedThreadIds.join(',') + ' threads=' + threadIds.join(','));

  // ---- 7. 非投票阶段投票被拒绝 ----
  var room2 = Room.coordinator.createRoom({
    hostName: '房主2', mode: 'local-hotseat', seed: 'DIRECTOR-ROOM2',
  });
  Room.coordinator.addBotSeat(room2.roomId, 1, { presetIndex: 0 });
  Room.coordinator.addBotSeat(room2.roomId, 2, { presetIndex: 1 });
  Room.coordinator.addBotSeat(room2.roomId, 3, { presetIndex: 2 });
  var occ2 = room2.seats.filter(function (s) { return s.kind === 'human' || s.kind === 'bot'; });
  occ2.forEach(function (s) {
    Room.coordinator.assignActorToSeat(room2.roomId, s.seatId, playerSetup(s.displayName, '剑修'));
    Room.coordinator.setSeatReady(room2.roomId, s.seatId, true);
  });
  await Room.coordinator.startRoomWithArcVoting(room2.roomId);
  var humanSeatId2 = room2.seats[0].seatId;
  Room.coordinator.submitArcVote(room2.roomId, humanSeatId2, room2.directorVote.candidates[0].arcId);
  await Room.coordinator.finalizeArcVote(room2.roomId, humanSeatId2);

  var rejected = false;
  try {
    Room.coordinator.submitArcVote(room2.roomId, humanSeatId2, room2.directorVote.candidates[0].arcId);
  } catch (e) {
    rejected = true;
  }
  ok('非投票阶段投票被拒绝', rejected);

  // ---- 8. 非真人席位投票被拒绝 ----
  var room3 = Room.coordinator.createRoom({
    hostName: '房主3', mode: 'local-hotseat', seed: 'DIRECTOR-ROOM3',
  });
  Room.coordinator.addBotSeat(room3.roomId, 1, { presetIndex: 0 });
  Room.coordinator.addBotSeat(room3.roomId, 2, { presetIndex: 1 });
  Room.coordinator.addBotSeat(room3.roomId, 3, { presetIndex: 2 });
  var occ3 = room3.seats.filter(function (s) { return s.kind === 'human' || s.kind === 'bot'; });
  occ3.forEach(function (s) {
    Room.coordinator.assignActorToSeat(room3.roomId, s.seatId, playerSetup(s.displayName, '剑修'));
    Room.coordinator.setSeatReady(room3.roomId, s.seatId, true);
  });
  await Room.coordinator.startRoomWithArcVoting(room3.roomId);
  var botSeatId = room3.seats.find(function (s) { return s.kind === 'bot'; }).seatId;
  var botRejected = false;
  try {
    Room.coordinator.submitArcVote(room3.roomId, botSeatId, room3.directorVote.candidates[0].arcId);
  } catch (e) {
    botRejected = true;
  }
  ok('非真人席位投票被拒绝', botRejected);

  console.log('\n' + '  Director Room 测试通过 ' + pass + ' / 失败 ' + fail);
  if (fail) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
