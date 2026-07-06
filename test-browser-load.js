/**
 * Browser-like loader regression: loads story-core.js and room-core.js
 * via JSDOM to verify they expose themselves correctly in a browser environment.
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
  check('Story 暴露到 window', !!window.Story);
  check('Room 暴露到 window', !!window.Room);
  check('Room 成功取得 Story 依赖', window.Room && window.Room.PRESET_BOT_ACTORS.length === 3,
    window.Room ? '预设角色数=' + window.Room.PRESET_BOT_ACTORS.length : 'Room 未加载');

  // V3.3：开局事务化需要 AI，注册 mock provider（离线兜底已废除）
  window.Story.setAIEnabled(true);
  window.Story.registerAIProvider({
    narrate: async function () {
      return JSON.stringify({
        title: '雨夜启程',
        chapter: '雨落长街，剑气未散。众人立于檐下，听远处更鼓声声，心中各有计较。' +
          '这一夜的变故，将原本平静的行程撕开一道口子，前路愈发难以预料。' +
          '陆知微握紧腰间残剑，剑身微颤，似在回应夜色中某种未明的呼唤。',
      });
    },
  }, { provider: 'mock', model: 'mock' });

  document.getElementById('seed-input').value = 'BROWSER-LOAD-REGRESSION';
  document.getElementById('btn-roll').click();
  document.getElementById('btn-create-room').click();
  const room = window.eval('UI.room');
  check('真实脚本加载后可创建单人房间', !!room);
  check('三名机器人都有立命数据', room && room.seats.slice(1).every(function (s) { return !!s.actorSetup; }));
  check('开局按钮已启用', document.getElementById('btn-lobby-start').disabled === false);
  document.getElementById('btn-lobby-start').click();
  await new Promise(function (resolve) { setTimeout(resolve, 500); });
  // V3.3.2：开局后进入命途签投票界面
  check('点击开局后进入命途签投票', document.getElementById('screen-arc-voting').classList.contains('active'));
  // 点击第一张候选卡
  var arcCards = document.querySelectorAll('.arc-candidate-card');
  check('命途签有三张候选卡', arcCards.length === 3, '实际=' + arcCards.length);
  if (arcCards.length > 0) {
    arcCards[0].click();
    await new Promise(function (resolve) { setTimeout(resolve, 100); });
    // 确认投票
    document.getElementById('btn-arc-confirm').click();
    await new Promise(function (resolve) { setTimeout(resolve, 500); });
  }
  check('投票后进入游戏屏', document.getElementById('screen-game').classList.contains('active'));
  check('投票后生成第一章', !!room.storySession && !!room.storySession.story.currentChapter);
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
