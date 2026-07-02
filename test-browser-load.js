/**
 * Browser-like loader regression: unlike test-v3-dom.js, this test does not
 * inject Game/Story/Room onto window. The three external scripts must expose
 * themselves exactly as they do in a real browser.
 */
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ✓ ' + name); }
  else { failed += 1; console.error('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}

async function main() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', function (e) { errors.push(e.message); });
  vc.on('error', function () { errors.push(Array.from(arguments).join(' ')); });

  const dom = await JSDOM.fromFile(path.join(__dirname, 'index.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse: function (window) {
      window.HTMLCanvasElement.prototype.getContext = function () { return null; };
    },
  });
  await new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(new Error('页面加载超时')); }, 5000);
    dom.window.addEventListener('load', function () { clearTimeout(timer); resolve(); });
  });

  const window = dom.window;
  const document = window.document;
  console.log('\n— 浏览器原生脚本加载 —');
  check('Game 暴露到 window', !!window.Game);
  check('Story 暴露到 window', !!window.Story);
  check('Room 暴露到 window', !!window.Room);
  check('Room 成功取得 Story 依赖', window.Room && window.Room.PRESET_BOT_ACTORS.length === 3,
    window.Room ? '预设角色数=' + window.Room.PRESET_BOT_ACTORS.length : 'Room 未加载');

  document.getElementById('seed-input').value = 'BROWSER-LOAD-REGRESSION';
  document.getElementById('btn-roll').click();
  document.getElementById('btn-create-room').click();
  const room = window.eval('UI.room');
  check('真实脚本加载后可创建单人房间', !!room);
  check('三名机器人都有立命数据', room && room.seats.slice(1).every(function (s) { return !!s.actorSetup; }));
  check('开局按钮已启用', document.getElementById('btn-lobby-start').disabled === false);
  document.getElementById('btn-lobby-start').click();
  await new Promise(function (resolve) { setTimeout(resolve, 80); });
  check('点击开局后进入游戏屏', document.getElementById('screen-game').classList.contains('active'));
  check('点击开局后生成第一章', !!room.storySession && !!room.storySession.story.currentChapter);
  check('页面无脚本加载错误', errors.length === 0, errors.join(' | '));

  dom.window.close();
  console.log('\n========================================');
  console.log('  浏览器加载测试通过 ' + passed + ' / 失败 ' + failed);
  console.log('========================================');
  if (failed) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
