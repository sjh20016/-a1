/* V3.4.1：房间席位的真人/Bot 控制权必须进入 Story Actor。 */
const Story = require('./story-core.js');
const Room = require('./room-core.js');
const { setupMockAI } = require('./test-helpers.js');

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('✓ ' + name); }
  else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function actor(name) {
  return { name: name, identity: '测试修士', daoPath: '剑修', publicWish: '求真', personalityTags: ['谨慎'] };
}

function prepareRoom(suffix) {
  const room = Room.coordinator.createRoom({ hostName: '房主' + suffix, mode: 'online', maxSeats: 2, seed: 'V341-CONTROLLER-' + suffix });
  Room.coordinator.assignActorToSeat(room.roomId, 'seat_0', actor('飞猪'));
  Room.coordinator.setSeatReady(room.roomId, 'seat_0', true);
  Room.coordinator.addBotSeat(room.roomId, 1, { profileId: 'pursuer', actorTemplate: actor('逐愿者') });
  return room;
}

async function main() {
  setupMockAI(Story);

  const regular = prepareRoom('regular');
  await Room.coordinator.startRoom(regular.roomId);
  const regularHuman = regular.storySession.actors.find(function (a) { return a.seatId === 'seat_0'; });
  const regularBot = regular.storySession.actors.find(function (a) { return a.seatId === 'seat_1'; });
  ok('startRoom 注入 human controller', regularHuman && regularHuman.controller === 'human');
  ok('startRoom 注入 bot controller', regularBot && regularBot.controller === 'bot');
  ok('房间 displayName 传入 actor', regularHuman && regularHuman.displayName === '房主regular');

  const voting = prepareRoom('voting');
  await Room.coordinator.startRoomWithArcVoting(voting.roomId);
  const votingHuman = voting.storySession.actors.find(function (a) { return a.seatId === 'seat_0'; });
  const votingBot = voting.storySession.actors.find(function (a) { return a.seatId === 'seat_1'; });
  ok('startRoomWithArcVoting 注入 human controller', votingHuman && votingHuman.controller === 'human');
  ok('startRoomWithArcVoting 注入 bot controller', votingBot && votingBot.controller === 'bot');
  ok('全部真人能被 coverage 基础判定识别', voting.storySession.actors.filter(function (a) { return Story._isHumanActor(voting.storySession, a); }).length === 1);

  console.log('\nV3.4.1 controller: ' + pass + ' passed / ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
