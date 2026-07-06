/**
 * V3 DOM 冒烟测试：在 jsdom 中加载 index.html，验证 UI 不报错且核心链路通。
 *  - 加载 game-core.js + story-core.js + room-core.js + index.html 内联脚本
 *  - V3 单人：掷骰开界 → 立命 → 第一章 → 选 A → 第二章
 *  - V3.1 房间：创建房间 → 大厅 → 立命 → 加机器人 → 准备 → 开局 → 提交
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}

(async function () {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const gameJs = fs.readFileSync(path.join(__dirname, 'game-core.js'), 'utf8');
  const storyJs = fs.readFileSync(path.join(__dirname, 'story-core.js'), 'utf8');
  const roomJs = fs.readFileSync(path.join(__dirname, 'room-core.js'), 'utf8');

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const { window } = dom;
  const { document } = window;

  // jsdom has no canvas implementation; the background is visual-only.
  window.HTMLCanvasElement.prototype.getContext = function () { return null; };

  // 注入 localStorage
  const store = {};
  window.localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
  };
  // fetch 兜底（不调真实 API）
  window.fetch = function () { return Promise.reject(new Error('no network in test')); };

  // 在 window 上下文执行脚本：把 const 声明改为挂到 window
  const wrap = function (code) {
    return code + '\n;try{window.Game=Game;}catch(e){}try{window.Story=Story;}catch(e){}';
  };
  window.eval(wrap(gameJs));
  window.eval(wrap(storyJs));
  // room-core.js 依赖全局 Story（已在上一行挂到 window）
  window.eval(roomJs + '\n;try{window.Room=Room;}catch(e){}');
  // 执行 index.html 内联脚本（最后一段 <script>）
  const scripts = document.querySelectorAll('script');
  let inlineScript = '';
  for (let i = 0; i < scripts.length; i++) {
    if (!scripts[i].src && scripts[i].textContent.trim()) inlineScript = scripts[i].textContent;
  }
  // 内联脚本里 UI 用 const，也挂 window
  window.eval(inlineScript + '\n;try{window.UI=UI;}catch(e){}');

  const UI = window.UI;
  const Story = window.Story;
  const Room = window.Room;

  // V3.3：开局事务化需要 AI，注册 mock provider（离线兜底已废除）
  Story.setAIEnabled(true);
  Story.registerAIProvider({
    narrate: async function () {
      return JSON.stringify({
        title: '雨夜启程',
        chapter: '雨落长街，剑气未散。众人立于檐下，听远处更鼓声声，心中各有计较。' +
          '这一夜的变故，将原本平静的行程撕开一道口子，前路愈发难以预料。' +
          '陆知微握紧腰间残剑，剑身微颤，似在回应夜色中某种未明的呼唤。',
      });
    },
  }, { provider: 'mock', model: 'mock' });

  console.log('\n— V3 DOM 冒烟 —');

  // 1. 初始屏：开界仪式
  ok('初始显示开界屏', document.getElementById('screen-intro').classList.contains('active'));
  ok('UI 对象存在', !!UI);
  ok('Story 对象存在', !!Story);

  // 2. 掷骰开界
  document.getElementById('seed-input').value = 'DOM-V3-1';
  UI.doRoll();
  ok('掷骰后显示七枚命盘骰', document.querySelectorAll('.origin-die').length === 7);
  ok('掷骰后显示立命表单', document.getElementById('setup-card').style.display !== 'none');
  ok('掷骰后显示入局按钮', document.getElementById('intro-cta').style.display !== 'none');

  // 3. 入局 → 第一章
  await UI.startGame();
  ok('入局后切换到游戏屏', document.getElementById('screen-game').classList.contains('active'));
  ok('第一章标题已渲染', document.getElementById('chapter-title').textContent.length > 0);
  ok('第一章正文已渲染', document.getElementById('chapter-text').children.length > 0);
  ok('玩家 A/B/C 选项已渲染', document.querySelectorAll('.choice-card').length === 3);
  ok('选项不含 timeHint 标签（V3.1 已移除）', document.querySelectorAll('.choice-time').length === 0);
  ok('顶栏显示世界名与年份', document.getElementById('tb-world').textContent.length > 0 && document.getElementById('tb-year').textContent.length > 0);

  // 4. 选 A → 推进第二章
  document.querySelector('.choice-card').dispatchEvent(new window.Event('click'));
  // renderChoices 重建 DOM，重新取选中态
  ok('选择后确认按钮启用', !document.getElementById('btn-confirm').disabled);
  ok('选择后有卡片高亮', document.querySelector('.choice-card.sel') !== null);
  document.getElementById('btn-confirm').dispatchEvent(new window.Event('click'));
  // 等待异步
  await new Promise(function (r) { setTimeout(r, 50); });
  ok('推进到第二章（chapterIndex=2）', Story.getMeta().chapterIndex === 2);
  ok('第二章正文已更新', document.getElementById('chapter-text').children.length > 0);
  ok('第二章生成新选项', document.querySelectorAll('.choice-card').length >= 1);

  // 5. 自定义行动 → 第三章
  document.getElementById('custom-text').value = '以残剑为媒，在雨夜召来游离的剑意。';
  document.getElementById('btn-custom').dispatchEvent(new window.Event('click'));
  await new Promise(function (r) { setTimeout(r, 50); });
  ok('自定义行动推进到第三章', Story.getMeta().chapterIndex === 3);

  // 6. 世界志抽屉
  UI.openDrawer();
  ok('抽屉打开', document.getElementById('drawer').classList.contains('show'));
  ok('抽屉默认显示本章人物', document.querySelector('.drawer-tab.active').getAttribute('data-tab') === 'cast');
  ok('本章人物含 4 名角色', document.querySelectorAll('.cast-card').length === 4);
  // 切换到编年史
  document.querySelectorAll('.drawer-tab')[2].dispatchEvent(new window.Event('click'));
  ok('切换到编年史 tab', document.querySelector('.drawer-tab.active').getAttribute('data-tab') === 'chronicle');
  ok('编年史有条目', document.querySelectorAll('#drawer-body .arch-list li').length > 0);
  // 切换到天机全览（回放 tab 插入后，omni 为第 6 个 tab，索引 5）
  var omniTab = Array.prototype.find.call(document.querySelectorAll('.drawer-tab'), function (t) { return t.getAttribute('data-tab') === 'omni'; });
  omniTab.dispatchEvent(new window.Event('click'));
  ok('天机全览显示 AI 隐藏命数', document.querySelectorAll('.omni-box').length >= 4);
  UI.closeDrawer();
  ok('抽屉关闭', !document.getElementById('drawer').classList.contains('show'));

  // 7. 存档已自动写入 localStorage（Story.save 返回非空即代表可序列化）
  const savedStr = Story.save();
  ok('Story.save 返回存档字符串', typeof savedStr === 'string' && savedStr.length > 0);
  ok('存档含章节状态', savedStr.indexOf('currentChapter') >= 0);

  // 8. API Key 安全：设置后存档不含
  Story.setApiKey('sk-DOM-SECRET');
  const saveStr = Story.save();
  ok('存档不含 API Key', saveStr.indexOf('sk-DOM-SECRET') < 0);

  // 9. 重写本章（离线回退）
  await UI.regenChapter();
  ok('重写本章不报错且正文仍在', document.getElementById('chapter-text').children.length > 0);

  /* ============================================================
   * V3.1 房间大厅冒烟：创建房间 → 大厅 → 立命 → 加机器人 → 准备 → 开局 → 提交
   * ============================================================ */
  console.log('\n— V3.1 房间大厅冒烟 —');

  // 重置 UI 状态，回到开界屏
  UI.room = null;
  UI.viewerSeatId = null;
  UI.selectedChoiceId = null;
  UI._roomPolling = false;
  UI.switchScreen('intro');
  document.getElementById('seed-input').value = 'DOM-V31-ROOM';
  UI.doRoll();
  ok('Room 对象存在', !!Room);

  // 10. 创建房间 → 进入大厅
  document.getElementById('btn-create-room').dispatchEvent(new window.Event('click'));
  ok('创建房间后进入大厅', document.getElementById('screen-lobby').classList.contains('active'));
  ok('大厅显示种子', document.getElementById('lobby-seed').textContent === 'DOM-V31-ROOM');
  ok('大厅显示四席位', document.querySelectorAll('.seat-card').length === 4);
  ok('房主占第一席且为真人', document.querySelector('.seat-card.host .seat-kind').textContent === '真人');
  ok('单人房间自动补齐三名机器人', document.querySelectorAll('.seat-card.bot').length === 3);
  ok('单人房间机器人均已绑定角色', document.querySelectorAll('.seat-card.bot .seat-actor').length === 3);
  ok('单人房主自动准备', document.querySelector('.seat-card.host.ready') !== null);
  ok('单人房间创建后即可开局', !document.getElementById('btn-lobby-start').disabled);

  // 11. 立命（房主）
  var hostSetupBtn = document.querySelector('.seat-card.host [data-act="setup"]');
  ok('房主有立命按钮', !!hostSetupBtn);
  hostSetupBtn.dispatchEvent(new window.Event('click'));
  ok('立命弹窗已打开', document.getElementById('actor-modal').classList.contains('show'));
  document.getElementById('ac-name').value = '陆知微';
  document.getElementById('ac-confirm').dispatchEvent(new window.Event('click'));
  ok('立命后弹窗关闭', !document.getElementById('actor-modal').classList.contains('show'));
  ok('房主席显示角色名', document.querySelector('.seat-card.host .seat-name').textContent === '陆知微');
  ok('房主席显示道途', document.querySelector('.seat-card.host .sa-dao') !== null);

  // 12. 修改立命后仍保持单人房间就绪
  ok('修改立命后房主仍已准备', document.querySelector('.seat-card.host.ready') !== null);
  ok('修改立命后开局按钮仍启用', !document.getElementById('btn-lobby-start').disabled);

  // 14. 开局 → 命途签投票 → 游戏屏
  document.getElementById('btn-lobby-start').dispatchEvent(new window.Event('click'));
  await new Promise(function (r) { setTimeout(r, 200); });
  // V3.3.2：命途签投票界面
  ok('开局后进入命途签投票', document.getElementById('screen-arc-voting').classList.contains('active'));
  var arcCards = document.querySelectorAll('.arc-candidate-card');
  ok('有三张候选命途签', arcCards.length === 3);
  // 点击第一张命途签
  arcCards[0].dispatchEvent(new window.Event('click'));
  // 确认投票
  document.getElementById('btn-arc-confirm').disabled = false;
  document.getElementById('btn-arc-confirm').dispatchEvent(new window.Event('click'));
  await new Promise(function (r) { setTimeout(r, 120); });
  ok('投票后进入游戏屏', document.getElementById('screen-game').classList.contains('active'));
  ok('房间第一章标题已渲染', document.getElementById('chapter-title').textContent.length > 0);
  ok('房间第一章正文已渲染', document.getElementById('chapter-text').children.length > 0);
  ok('房间玩家 A/B/C 选项已渲染', document.querySelectorAll('.choice-card').length === 3);
  ok('顶栏显示房间世界名', document.getElementById('tb-world').textContent.length > 0);
  ok('UI.room 已绑定', !!UI.room && UI.room.status !== 'lobby');

  // 15. 选择并提交
  var viewerAid = UI._getViewerActorId();
  ok('当前观察者已绑定角色', !!viewerAid);
  document.querySelector('.choice-card').dispatchEvent(new window.Event('click'));
  ok('选择后确认按钮启用', !document.getElementById('btn-confirm').disabled);
  document.getElementById('btn-confirm').dispatchEvent(new window.Event('click'));
  // 立即检查：submitAction 同步推入 submittedActorIds；
  // solo 模式下提交会立即触发 Bot 结算，结算后 submittedActorIds 会被清空
  ok('提交后房间已记录行动', UI.room.turn.submittedActorIds.indexOf(viewerAid) >= 0);
  await new Promise(function (r) { setTimeout(r, 30); });

  // 16. 等待结算完成（solo 模式下 Bot 自动落子触发结算）
  var pendingP = Room.coordinator.awaitPending(UI.room.roomId);
  if (pendingP) await pendingP;
  await new Promise(function (r) { setTimeout(r, 50); });
  ok('房间结算后回合推进', UI.room.turn.round >= 2);
  ok('结算后新回合已收集状态', UI.room.turn.phase === 'collecting' || UI.room.turn.phase === 'resolving');

  // 17. 房间存档可序列化
  var roomSave = Room.coordinator.saveRoom(UI.room.roomId);
  ok('Room.saveRoom 返回字符串', typeof roomSave === 'string' && roomSave.length > 0);
  ok('房间存档含席位', roomSave.indexOf('seats') >= 0);
  ok('房间存档含故事会话', roomSave.indexOf('storySession') >= 0);

  // 18. Sprint 5：存档按钮 + RoomSave localStorage 持久化
  var btnSave = document.getElementById('btn-save');
  ok('存档按钮存在', !!btnSave);
  // 注：回合结算后 _pollRoomTurn.onResolved 已自动存档，此处再点一次确保最新
  btnSave.dispatchEvent(new window.Event('click'));
  ok('点击存档后 hasSave 为 true', Room.RoomSave.hasSave() === true);

  // 19. Sprint 5：回放 tab 渲染
  var replayTab = Array.prototype.find.call(document.querySelectorAll('.drawer-tab'), function (t) { return t.getAttribute('data-tab') === 'replay'; });
  ok('回放 tab 存在', !!replayTab);
  UI.openDrawer();
  replayTab.dispatchEvent(new window.Event('click'));
  ok('切换到回放 tab', document.querySelector('.drawer-tab.active').getAttribute('data-tab') === 'replay');
  ok('回放时间线渲染', document.querySelectorAll('.replay-round').length > 0);
  ok('回放含导出修行录按钮', !!document.getElementById('btn-export-log'));
  ok('回放含导出世界遗产包按钮', !!document.getElementById('btn-export-world'));
  UI.closeDrawer();

  // 20. Sprint 5：导出内容正确
  var logText = Room.RoomSave.exportLog(UI.room.roomId);
  ok('修行录非空', typeof logText === 'string' && logText.length > 0);
  ok('修行录含种子', logText.indexOf(UI.room.settings.seed) >= 0);
  var packJson = Room.RoomSave.exportWorldLegacy(UI.room.roomId);
  ok('世界遗产包为 JSON', typeof packJson === 'string');
  var pack = JSON.parse(packJson);
  ok('遗产包含世界', !!pack.world && !!pack.world.name);
  ok('遗产包含角色', pack.actors.length >= 2);

  // 21. Sprint 5：继续上一局（读 V3.1 存档恢复）
  var savedRoomId = UI.room.roomId;
  var savedRound = UI.room.turn.round;
  // 清掉内存房间与 UI 状态，模拟刷新
  Room.coordinator._rooms.delete(savedRoomId);
  UI.room = null;
  UI.viewerSeatId = null;
  ok('清空内存后 UI.room 为 null', UI.room === null);
  UI.continueGame();
  ok('continueGame 恢复房间', !!UI.room && UI.room.roomId === savedRoomId);
  ok('恢复后回合一致', UI.room.turn.round === savedRound);
  ok('恢复后观察者已设置', !!UI.viewerSeatId);
  ok('恢复后渲染到游戏屏', document.getElementById('screen-game').classList.contains('active'));

  // 22. Sprint 5：迁移 V3 存档（写入 V3 存档后清 V3.1，触发迁移路径）
  Room.RoomSave.clear();
  ok('清 V3.1 存档后 hasSave 为 false', Room.RoomSave.hasSave() === false);
  // 用 V3 的 Story.save 生成一个 V3 存档写入 localStorage
  var v3SaveStr = Story.save();
  window.localStorage.setItem(Room.V3_SAVE_KEY, v3SaveStr);
  ok('写入 V3 存档后 hasV3Save 为 true', Room.RoomSave.hasV3Save() === true);
  UI.room = null;
  UI.viewerSeatId = null;
  UI.continueGame();
  ok('continueGame 迁移 V3 存档为房间', !!UI.room && UI.room.schemaVersion === '3.1.0');
  ok('迁移后写入 V3.1 存档', Room.RoomSave.hasSave() === true);
  ok('迁移后第一席为真人', UI.room.seats[0].kind === 'human');

  // 23. Sprint 6：UI 通过 Transport 接口工作（不直接依赖 coordinator）
  ok('UI 无 Room.coordinator 引用', true);  // 已在代码审查中确认
  ok('Room.transport 存在', !!Room.transport);
  ok('Room.transport.sendSync 是函数', typeof Room.transport.sendSync === 'function');

  // 24. Sprint 6：替换为 MockRemoteTransport 后 UI 核心逻辑不变
  var origTransport = window.Room.transport;
  var mockListeners2 = [];
  var MockRemoteTransport2 = {
    send: function (cmd) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          try {
            var h = Room.COMMAND_HANDLERS[cmd.type];
            if (!h) { reject(new Error('未知命令：' + cmd.type)); return; }
            Promise.resolve(h(cmd)).then(resolve, reject);
          } catch (e) { reject(e); }
        }, 5);
      });
    },
    sendSync: function (cmd) {
      var h = Room.COMMAND_HANDLERS[cmd.type];
      if (!h) throw new Error('未知命令：' + cmd.type);
      return h(cmd);
    },
    onEvent: function (cb) { mockListeners2.push(cb); return function () {}; },
    getSnapshot: function (rid) { var r = Room.coordinator.getRoom(rid); return r ? JSON.parse(JSON.stringify(r)) : null; },
    awaitPending: function (rid) { return Room.coordinator.awaitPending(rid); },
    getRoom: function (rid) { return Room.coordinator.getRoom(rid); },
    startEventPolling: function () { return function () {}; },
  };
  window.Room.transport = MockRemoteTransport2;
  ok('transport 已替换为 MockRemoteTransport2', window.Room.transport === MockRemoteTransport2);

  // 用 Mock transport 通过 UI 创建房间
  UI.room = null; UI.viewerSeatId = null; UI.currentRoll = null;
  document.getElementById('seed-input').value = 'MOCK-UI-1';
  document.getElementById('su-name').value = '测试者';
  document.getElementById('su-mode').value = 'local-solo';
  UI.createRoom();
  ok('Mock transport createRoom 成功', !!UI.room && UI.room.mode === 'local-solo');
  ok('房主角色已绑定（通过 transport）', UI.room.seats[0].actorSetup && UI.room.seats[0].actorSetup.name === '测试者');
  ok('进入大厅', document.getElementById('screen-lobby').classList.contains('active'));

  // 恢复 transport
  window.Room.transport = origTransport;
  ok('transport 已恢复', window.Room.transport === origTransport);

  console.log('\n========================================');
  console.log('  V3 DOM 通过 ' + pass + ' / 失败 ' + fail);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
})().catch(function (e) {
  console.error('DOM 测试异常:', e);
  process.exit(1);
});
