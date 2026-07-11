'use strict';

const Room = require('../room-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) { if (condition) { pass++; console.log('✓ ' + name); } else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); } }
async function main() {
  let active = 0;
  let maxActive = 0;
  const order = [];
  function task(roomId, delay) {
    return Room.storyExecutionQueue.run(async function () {
      active++; maxActive = Math.max(maxActive, active); order.push(roomId + ':start');
      await new Promise(function (resolve) { setTimeout(resolve, delay); });
      order.push(roomId + ':end'); active--;
    });
  }
  await Promise.all([task('room_a', 30), task('room_b', 5), task('room_c', 1)]);
  ok('不同房间不会并发进入全局 Story', maxActive === 1, String(maxActive));
  ok('全局队列保持提交顺序', order.join(',') === 'room_a:start,room_a:end,room_b:start,room_b:end,room_c:start,room_c:end', order.join(','));
  console.log('\nserver concurrent rooms: ' + pass + ' passed / ' + fail + ' failed'); if (fail) process.exitCode = 1;
}
main().catch(function (error) { console.error(error); process.exitCode = 1; });
