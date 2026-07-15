'use strict';

const Room = require('../room-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) { if (condition) { pass++; console.log('✓ ' + name); } else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); } }
async function main() {
  let active = 0;
  let maxActive = 0;
  function delayed(engine, delay) {
    return engine.run(async function () {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(function (resolve) { setTimeout(resolve, delay); });
      active--;
    });
  }
  const rooms = Array.from({ length: 10 }, function (_, index) {
    return Room.createRoomState({ roomId: 'room_parallel_' + index });
  });
  const startedAt = Date.now();
  await Promise.all(rooms.map(function (room) { return delayed(Room.getStoryEngine(room), 50); }));
  const elapsed = Date.now() - startedAt;
  ok('不同房间拥有不同 StoryEngine', new Set(rooms.map(function (room) { return Room.getStoryEngine(room); })).size === 10);
  ok('不同房间 Provider 等待可并行', maxActive === 10, String(maxActive));
  ok('10 房间耗时接近一次等待', elapsed < 180, String(elapsed) + 'ms');

  active = 0; maxActive = 0;
  const oneEngine = Room.getStoryEngine(rooms[0]);
  const serialStartedAt = Date.now();
  await Promise.all([delayed(oneEngine, 35), delayed(oneEngine, 35), delayed(oneEngine, 35)]);
  const serialElapsed = Date.now() - serialStartedAt;
  ok('同一房间仍严格串行', maxActive === 1, String(maxActive));
  ok('同房间三项等待按队列累计', serialElapsed >= 90, String(serialElapsed) + 'ms');
  console.log('\nserver concurrent rooms: ' + pass + ' passed / ' + fail + ' failed'); if (fail) process.exitCode = 1;
}
main().catch(function (error) { console.error(error); process.exitCode = 1; });
