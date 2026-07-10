const Story = require('./story-core.js');
const Room = require('./room-core.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}

console.log('\n=== test-v336-room-view-director ===');
const room = Room.coordinator.createRoom({ hostName: '房主', mode: 'online', seed: 'V336-VIEW' });
Room.coordinator.addHumanSeat(room.roomId, 1, { displayName: '玩家乙' });
const state = Story.createEmptyState('V336-VIEW');
state.world.name = '验收界';
state.world.worldBible = { rules: ['规则一'], flags: {} };
state.actors = [
  { id: 'p1', seatId: 'seat_0', name: '甲', identity: '散修', daoPath: '剑修', controller: 'human', hiddenFate: '甲秘命', privateFacts: [], hidden: {} },
  { id: 'p2', seatId: 'seat_1', name: '乙', identity: '散修', daoPath: '阵修', controller: 'human', hiddenFate: '乙秘命', privateFacts: [], hidden: {} },
];
room.seats[0].actorId = 'p1'; room.seats[1].actorId = 'p2';
room.storySession = state;
state.story.director.activeArc = {
  arcId: 'arc_sealed_realm', recipeId: 'sealed_realm', family: 'seal', title: '秘境封印', status: 'active', tags: ['秘境'],
  currentBeatIndex: 0, beats: [{ beatId: 'sealed_01', title: '裂隙门槛', status: 'active', dramaticGoal: '查明封印' }],
  pressureClocks: [{ clockId: 'clock_seal_decay', label: '封印衰减', current: 1, max: 4 }], divergenceLog: [], revealLog: [],
};
state.story.director.phase = 'active';
room.eventLog.push(
  { type: 'PUBLIC_TEST', visibility: 'public', payload: { text: '公开' } },
  { type: 'HOST_SECRET', visibility: 'host', payload: { error: '房主诊断' } },
  { type: 'SEAT_SECRET', visibility: 'seat', seatId: 'seat_1', payload: { text: '乙私密' } }
);

const host = Room.RoomView.getForSeat(room, 'seat_0');
const guest = Room.RoomView.getForSeat(room, 'seat_1');
ok('RoomView 包含 publicDirector', guest.publicDirector && guest.publicDirector.activeArc.title === '秘境封印');
ok('RoomView 包含压力时钟', guest.publicDirector.activeArc.pressureClocks[0].label === '封印衰减');
ok('publicEvents 仅含公开事件', guest.publicEvents.some(function (e) { return e.type === 'PUBLIC_TEST'; }) && !guest.publicEvents.some(function (e) { return e.type === 'HOST_SECRET'; }));
ok('普通玩家看不到 hostEvents', !Object.prototype.hasOwnProperty.call(guest, 'hostEvents'));
ok('房主能看到 hostEvents', host.hostEvents.some(function (e) { return e.type === 'HOST_SECRET'; }));
ok('当前席位能看到 ownEvents', guest.ownEvents.some(function (e) { return e.type === 'SEAT_SECRET'; }));
ok('其他席位看不到 seat 私密事件', !host.ownEvents.some(function (e) { return e.type === 'SEAT_SECRET'; }));
ok('RoomView 不包含 serverAuth', JSON.stringify(guest).indexOf('serverAuth') < 0);

console.log('RoomView director passed ' + pass + ' / failed ' + fail);
if (fail) process.exit(1);
