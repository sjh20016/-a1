const Story = require('./story-core.js');
const Room = require('./room-core.js');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  ✓ ' + name);
  } else {
    failed += 1;
    console.error('  ✗ ' + name + (detail ? ' :: ' + detail : ''));
  }
}

function expectThrow(name, fn) {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  check(name, !!error, error ? '' : '未抛出异常');
  return error;
}

function actorSetup(name) {
  return {
    id: 'human_' + name,
    name: name,
    identity: '散修',
    daoPath: '剑修',
    publicWish: '查清异象',
    hiddenFate: '旧约未了',
    personalityTags: ['谨慎'],
  };
}

async function createPlayableRoom(id, seed, allowCustomActions) {
  const room = Room.coordinator.createRoom({
    roomId: id,
    hostName: '房主',
    seed: seed,
    allowCustomActions: allowCustomActions,
  });
  Room.coordinator.assignActorToSeat(room.roomId, 'seat_0', actorSetup(id));
  Room.coordinator.setSeatReady(room.roomId, 'seat_0', true);
  Room.coordinator.addBotSeat(room.roomId, 1, { profileId: 'pursuer', presetIndex: 0 });
  await Room.coordinator.startRoom(room.roomId);
  return room;
}

async function main() {
  Story.setAIEnabled(false);

  console.log('\n— 房间行动输入边界 —');
  const room = await createPlayableRoom('reg_action', 'REG-ACTION', true);
  const submittedBefore = room.turn.submittedActorIds.slice();
  expectThrow('不存在的 choiceId 被同步拒绝', function () {
    Room.coordinator.submitAction(room.roomId, 'seat_0', { choiceId: 'not-a-choice' });
  });
  check('无效选择不会污染已提交列表',
    JSON.stringify(room.turn.submittedActorIds) === JSON.stringify(submittedBefore));
  check('无效选择不会写入行动表', !room.turn.actionsByActorId[room.seats[0].actorId]);

  expectThrow('空白自定义行动被拒绝', function () {
    Room.coordinator.submitAction(room.roomId, 'seat_0', { custom: { text: '   ' } });
  });
  expectThrow('超长自定义行动被拒绝', function () {
    Room.coordinator.submitAction(room.roomId, 'seat_0', { custom: { text: '甲'.repeat(501) } });
  });

  const fallbackRound = room.turn.round;
  Room.coordinator.submitAction(room.roomId, 'seat_0', { custom: { text: '继续睡觉，并留意梦境里反复出现的钟声' } });
  await Room.coordinator.awaitPending(room.roomId);
  const fallbackChObj = room.storySession.story.currentChapter;
  const fallbackChapter = fallbackChObj.chapter;
  const fallbackChoices = Story.getChoicesForActor(room.storySession, room.seats[0].actorId);
  const fbLen = fallbackChapter.replace(/\s/g, '').length;
  // V3.2 §P2：离线正文 180-400 字、provenance=offline-resolved、不得机械回放玩家原文超过 16 连续字符
  check('离线正文 provenance 为 offline-resolved', fallbackChObj.provenance === 'offline-resolved');
  check('离线正文长度落在 180-400 字符', fbLen >= 180 && fbLen <= 400);
  check('离线正文不得回放玩家原文超过 16 连续字符', fallbackChapter.indexOf('继续睡觉') < 0);
  check('离线正文落实自定义行动（回合推进）', room.turn.round === fallbackRound + 1);
  check('离线后续选项携带 intentCategory 指纹', fallbackChoices.length > 0 && fallbackChoices.every(function (c) { return !!c.intentCategory; }));

  const noCustomRoom = await createPlayableRoom('reg_no_custom', 'REG-NO-CUSTOM', false);
  expectThrow('关闭自定义行动后服务端仍会校验', function () {
    Room.coordinator.submitAction(noCustomRoom.roomId, 'seat_0', { custom: { text: '自行探路' } });
  });
  check('被拒绝后房间仍可正常收集', noCustomRoom.status === 'collecting');

  console.log('\n— 多房间 RNG 隔离 —');
  const roomA = await createPlayableRoom('reg_rng_a', 'REG-RNG-A', true);
  // Opening the turn lets bots choose, so compare against the live per-room
  // stream rather than the last serialized snapshot.
  const stateA = Story.rngFor('test', roomA.storySession).getState();
  const roomB = await createPlayableRoom('reg_rng_b', 'REG-RNG-B', true);
  Story.rngFor('test', roomB.storySession).next();
  Story.snapshotRng(roomB.storySession);
  const savedA = JSON.parse(Room.coordinator.saveRoom(roomA.roomId));
  check('保存房间 A 不会写入房间 B 的 RNG', savedA.room.storySession.rng.state === stateA,
    savedA.room.storySession.rng.state + ' !== ' + stateA);
  check('房间 A 内存中的 RNG 未被房间 B 改写', roomA.storySession.rng.state === stateA);
  check('不同房间持有不同 RNG 实例',
    Story.rngFor('test', roomA.storySession) !== Story.rngFor('test', roomB.storySession));

  console.log('\n— 开局失败恢复 —');
  const retryRoom = Room.coordinator.createRoom({ roomId: 'reg_retry', hostName: '房主', seed: 'REG-RETRY' });
  Room.coordinator.assignActorToSeat(retryRoom.roomId, 'seat_0', actorSetup('retry'));
  Room.coordinator.setSeatReady(retryRoom.roomId, 'seat_0', true);
  Room.coordinator.addBotSeat(retryRoom.roomId, 1, { presetIndex: 0 });
  const originalCreateSession = Story.createSession;
  Story.createSession = async function () { throw new Error('模拟生成失败'); };
  let startError = null;
  try { await Room.coordinator.startRoom(retryRoom.roomId); } catch (e) { startError = e; }
  finally { Story.createSession = originalCreateSession; }
  check('开局失败会向调用方返回错误', !!startError);
  check('开局失败后恢复为 lobby，可再次尝试', retryRoom.status === 'lobby');
  check('开局失败不会留下半成品故事', retryRoom.storySession === null);
  check('开局失败写入可诊断事件', retryRoom.eventLog.some(function (e) { return e.type === 'ROOM_START_FAILED'; }));

  console.log('\n— 机器人配置校验 —');
  const botRoom = Room.coordinator.createRoom({ roomId: 'reg_bot', hostName: '房主' });
  expectThrow('未知机器人策略被明确拒绝', function () {
    Room.coordinator.addBotSeat(botRoom.roomId, 1, { profileId: 'unknown-profile' });
  });
  check('机器人配置失败不会占用席位', botRoom.seats[1].kind === 'empty');

  console.log('\n— 叙事结算防卡死 —');
  const malformedRoom = await createPlayableRoom('reg_malformed_ai', 'REG-MALFORMED-AI', true);
  Story.registerAIProvider({
    narrate: async function () {
      return {
        title: '结构异常的模型响应',
        chapter: '这段正文足够长，但嵌套字段故意使用错误类型，以验证系统能够自动切换到本地叙事而不是卡死。',
        statePatch: { newFacts: '本应为数组' },
        choices: {},
      };
    },
  });
  Story.setAIEnabled(true);
  const malformedRound = malformedRoom.turn.round;
  const malformedChoices = Story.getChoicesForActor(malformedRoom.storySession, malformedRoom.seats[0].actorId);
  Room.coordinator.submitAction(malformedRoom.roomId, 'seat_0', { choiceId: malformedChoices[0].id });
  await Room.coordinator.awaitPending(malformedRoom.roomId);
  check('AI 嵌套结构异常时自动使用本地叙事', malformedRoom.turn.round === malformedRound + 1);
  check('AI 结构异常不会停在 resolving', malformedRoom.status === 'collecting');
  Story.setAIEnabled(false);
  Story.registerAIProvider(null);

  const protocolRetryRoom = await createPlayableRoom('reg_protocol_retry', 'REG-PROTOCOL-RETRY', true);
  let protocolCalls = 0;
  Story.registerAIProvider({
    narrate: async function (ctx) {
      protocolCalls += 1;
      if (protocolCalls === 1) return { title: '空响应', chapter: '' };
      return {
        title: '协议重试成功',
        chapter: '玩家的行动在第二次响应中被完整落实，场景、阻力与结果均已写入正文，并由此形成了可继续追查的新线索。'.repeat(3),
        chapterSummary: '协议修正后成功生成章节。',
        publicEvents: [], privateEvents: [], activeThreads: ['协议修正线索'],
        statePatch: {}, choices: {},
      };
    },
  });
  Story.setAIEnabled(true);
  const protocolRound = protocolRetryRoom.turn.round;
  const protocolChoices = Story.getChoicesForActor(protocolRetryRoom.storySession, protocolRetryRoom.seats[0].actorId);
  Room.coordinator.submitAction(protocolRetryRoom.roomId, 'seat_0', { choiceId: protocolChoices[0].id });
  await Room.coordinator.awaitPending(protocolRetryRoom.roomId);
  check('章节协议首次失败会自动重试一次', protocolCalls === 2);
  check('协议重试成功后使用 API 正文', protocolRetryRoom.storySession.story.currentChapter.title === '协议重试成功');
  check('协议重试后房间正常进入下一回合', protocolRetryRoom.turn.round === protocolRound + 1 && protocolRetryRoom.status === 'collecting');
  Story.setAIEnabled(false);
  Story.registerAIProvider(null);

  const timeoutRoom = await createPlayableRoom('reg_ai_timeout', 'REG-AI-TIMEOUT', true);
  const originalTimeout = Story.ai.timeoutMs;
  Story.ai.timeoutMs = 30;
  Story.registerAIProvider({ narrate: function () { return new Promise(function () {}); } });
  Story.setAIEnabled(true);
  const timeoutRound = timeoutRoom.turn.round;
  const timeoutChoices = Story.getChoicesForActor(timeoutRoom.storySession, timeoutRoom.seats[0].actorId);
  Room.coordinator.submitAction(timeoutRoom.roomId, 'seat_0', { choiceId: timeoutChoices[0].id });
  await Room.coordinator.awaitPending(timeoutRoom.roomId);
  check('AI 请求超时后自动进入本地下一章', timeoutRoom.turn.round === timeoutRound + 1);
  Story.ai.timeoutMs = originalTimeout;
  Story.setAIEnabled(false);
  Story.registerAIProvider(null);

  const recoveryRoom = await createPlayableRoom('reg_engine_recovery', 'REG-ENGINE-RECOVERY', true);
  const recoveryRound = recoveryRoom.turn.round;
  const recoveryChoices = Story.getChoicesForActor(recoveryRoom.storySession, recoveryRoom.seats[0].actorId);
  const originalResolveTurn = Story.resolveTurn;
  Story.resolveTurn = async function () { throw new Error('模拟引擎异常'); };
  Room.coordinator.submitAction(recoveryRoom.roomId, 'seat_0', { choiceId: recoveryChoices[0].id });
  await Room.coordinator.awaitPending(recoveryRoom.roomId);
  Story.resolveTurn = originalResolveTurn;
  check('引擎异常后房间解除锁定', recoveryRoom.status === 'collecting' && recoveryRoom.turn.phase === 'collecting');
  check('引擎异常后真人提交状态已清理',
    recoveryRoom.turn.submittedActorIds.indexOf(recoveryRoom.seats[0].actorId) < 0);
  check('引擎异常原因被记录供 UI 提示', recoveryRoom.turn.lastError === '模拟引擎异常');
  Room.coordinator.submitAction(recoveryRoom.roomId, 'seat_0', { choiceId: recoveryChoices[0].id });
  await Room.coordinator.awaitPending(recoveryRoom.roomId);
  check('解除锁定后重新选择可正常进入下一回合', recoveryRoom.turn.round === recoveryRound + 1);

  console.log('\n========================================');
  console.log('  回归测试通过 ' + passed + ' / 失败 ' + failed);
  console.log('========================================');
  if (failed) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
