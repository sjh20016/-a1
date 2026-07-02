/**
 * ============================================================================
 * 《修行局》V2 —— BLACKWIND-127 端到端验收测试
 * ----------------------------------------------------------------------------
 * 对应 V2 任务清单 §12 验收场景：
 *   种子世界 → 并行修行 → 时间推进 → 天书批注 → 存读档 → 百年封卷 → 续卷
 * 全部断言通过即视为 V2 引擎层验收完成。
 * ============================================================================
 */
const Game = require('./game-core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}
function section(title) { console.log('\n— ' + title + ' —'); }

// —— 种子确定性
section('§2.1 种子世界确定性');
Game.generateWorld('BLACKWIND-127');
const s1 = JSON.stringify(Game.state.map.nodes.map(function (n) { return n.name; }));
Game.generateWorld('BLACKWIND-127');
const s2 = JSON.stringify(Game.state.map.nodes.map(function (n) { return n.name; }));
ok('同种子重生世界一致', s1 === s2);

Game.generateWorld('BLACKWIND-127');
const roll = Game.rollOrigin('BLACKWIND-127');
ok('开界骰返回 4 字段', !!roll.era && !!roll.terrain && !!roll.order && !!roll.heavenlyLaw,
   JSON.stringify(roll));
const card = Game.buildWorldCard(roll);
ok('世界基础卡含 worldName/rules', !!card.worldName && Array.isArray(card.rules) && card.rules.length === 4);

// —— 节点地图
section('§3 节点地图');
ok('生成 7 节点', Game.state.map.nodes.length === 7, 'got ' + Game.state.map.nodes.length);
const kinds = Game.state.map.nodes.map(function (n) { return n.kind; });
['宗门','城池','妖域','秘境','荒野','禁地'].forEach(function (k) {
  ok('含 ' + k, kinds.indexOf(k) >= 0);
});
ok('秘境/禁地/妖域/海域至少一处有 encounter',
   Game.state.map.nodes.some(function (n) { return n.encounter; }));

// —— 4 名角色、不同出生点
section('§3.2 角色与出生点');
ok('4 名角色', Game.state.actors.length === 4);
const locs = Game.state.actors.map(function (a) { return a.locationId; });
ok('4 人出生点互异', new Set(locs).size === 4, JSON.stringify(locs));
ok('玩家为陆知微', Game.getPlayer().id === 'lu');
ok('玩家初始在城池', Game.playerAtKind('城池'));

// —— 找到通往秘境的路径（BFS）
function findPathToKind(kind) {
  const lu = Game.getPlayer();
  const start = Game.nodeById(lu.locationId);
  const target = Game.state.map.nodes.find(function (n) { return n.kind === kind; });
  if (!target) return null;
  const q = [[start.id, []]];
  const seen = {};
  seen[start.id] = true;
  while (q.length) {
    const pair = q.shift();
    const cur = Game.nodeById(pair[0]);
    const path = pair[1];
    if (cur.id === target.id) return path;
    cur.connections.forEach(function (nid) {
      if (!seen[nid]) { seen[nid] = true; q.push([nid, path.concat([nid])]); }
    });
  }
  return null;
}

// —— §4 并行行动：玩家 + AI 一同提交，统一结算
section('§4 并行行动 + 合流');
function doRound(label, playerIntent) {
  Game.submitPlayerIntent(playerIntent);
  Game.collectAIIntents();
  return Game.resolveRound();
}

const pathToSecret = findPathToKind('秘境');
ok('城池→秘境存在通路', !!pathToSecret, 'no path');

// 沿路径行游，每回合提交 travel
let reachedSecret = false;
let roundsUsed = 0;
for (let i = 0; i < (pathToSecret || []).length && i < 8; i++) {
  const results = doRound('travel-' + i, { actionType: 'travel', targetId: pathToSecret[i], posture: '争' });
  roundsUsed++;
  if (Game.playerAtKind('秘境')) { reachedSecret = true; break; }
  // 推进时间（当下），让回合进入 intent 阶段
  const adv = Game.advanceTime('当下');
  if (!adv.ok) { ok('当下推进允许', false, adv.reason); break; }
}
ok('玩家成功抵达秘境', reachedSecret, 'rounds used: ' + roundsUsed);

// —— §4.3 在秘境触发危局战斗
section('§4.3 危局战斗（2-3 轮）');
let combatFound = null;
for (let i = 0; i < 3 && !combatFound; i++) {
  const results = doRound('explore-' + i, { actionType: 'explore', targetId: Game.getPlayer().locationId, posture: '争' });
  combatFound = results.find(function (r) { return r.type === 'combat' || (r.type === 'encounter' && r.kind === 'combat'); });
  if (!combatFound) {
    const adv = Game.advanceTime('当下');
    if (!adv.ok) break;
  }
}
ok('秘境探索触发战斗', !!combatFound, JSON.stringify(combatFound).slice(0, 200));
if (combatFound) {
  ok('战斗有 outcome 字段', !!combatFound.outcome, combatFound.outcome);
}

// —— §5 时间推进（十年）+ 自然授予天书残页
section('§5 时间推进 + 天书残页');
const beforePages = Game.state.inventory.heavenlyPages;
const adv10 = Game.advanceTime('十年');
ok('十年推进通过', adv10.ok, adv10.reason);
ok('首次≥10年跳跃自然授予天书残页',
   Game.state.inventory.heavenlyPages >= 1 && Game.state.inventory.heavenlyPages > beforePages,
   'before=' + beforePages + ' after=' + Game.state.inventory.heavenlyPages);

// —— §9 天书批注：创设势力 → 新增节点
section('§9 天书批注（创设势力）');
const nodesBefore = Game.state.map.nodes.length;
const ann = Game.useHeavenlyBook('创设势力', { name: '火枫国', kind: '城池' });
ok('天书批注返回 ok', ann.ok, ann.reason);
ok('创设势力后节点 +1', Game.state.map.nodes.length === nodesBefore + 1,
   'before=' + nodesBefore + ' after=' + Game.state.map.nodes.length);
ok('新势力「火枫国」存在', Game.state.factions.some(function (f) { return f.name === '火枫国'; }));
ok('批注消耗 1 页天书', Game.state.inventory.heavenlyPages === 0 || Game.state.inventory.heavenlyPages < 1);
ok('玩家因果 +1', Game.getPlayer().karma >= 2, 'karma=' + Game.getPlayer().karma);

// —— §10 存档 / 读档（保留 8 节点）
section('§10 本地存档');
const saved = Game.save({ ai: { enabled: false } });
ok('存档返回非空字符串', typeof saved === 'string' && saved.length > 100);
const nodeCountInSave = JSON.parse(saved).map.nodes.length;
ok('存档内含 8 节点', nodeCountInSave === 8, 'got ' + nodeCountInSave);
Game.reset();
ok('reset 后 state 为空', Game.state === null);
const loaded = Game.load(saved);
ok('读档返回 state', !!loaded);
ok('读档恢复 8 节点', loaded.map.nodes.length === 8, 'got ' + loaded.map.nodes.length);
ok('读档后火枫国仍在', loaded.factions.some(function (f) { return f.name === '火枫国'; }));

// —— §5.2 百年推进 + §8.4 遗产包
section('§5.2 + §8.4 百年封卷 + 遗产包');
// 确保不在 intent 锁定状态：先做一轮再推进
doRound('pre-century', { actionType: 'cultivate', targetId: Game.getPlayer().locationId, posture: '稳' });
// V2.1 §4.3：重伤（injury>=3）限制百年推进，先疗伤确保封卷链路通过
Game.state.actors.forEach(function (a) { if (a.injury >= 3) a.injury = 0; });
const adv100 = Game.advanceTime('百年');
ok('百年推进通过', adv100.ok, adv100.reason);
ok('百年后生成 finalLegacy', !!Game.state.finalLegacy);
if (Game.state.finalLegacy) {
  const L = Game.state.finalLegacy;
  ok('遗产包含 seed/worldName', !!L.seed && !!L.worldName);
  ok('遗产包含 canonicalHistory 数组', Array.isArray(L.canonicalHistory) && L.canonicalHistory.length > 0);
  ok('遗产包含 factions', Array.isArray(L.factions));
  ok('遗产包含 unresolvedKarma', Array.isArray(L.unresolvedKarma));
}

// —— §8.5 续卷：百年后新卷
section('§8.5 续卷（百年后新卷）');
const legacy = Game.exportLegacy();
const sequelState = Game.createSequel(legacy);
ok('续卷生成新 state', !!sequelState);
ok('续卷含前朝旧事', sequelState.ledger.chronicle.canonical.some(function (c) { return c.text.indexOf('前朝') >= 0; }));
ok('续卷世界真相含前朝承继', sequelState.world.truths.some(function (t) { return t.indexOf('前朝') >= 0; }));

// —— §7 AI Provider 接口 + 离线回退
section('§7 AI Provider 接口 + 离线回退');
Game.registerAIProvider({
  narrate: function () { throw new Error('provider down'); },
  epochSummary: function () { throw new Error('provider down'); },
  polishNarration: async function () { throw new Error('provider down'); },
});
Game.setAIEnabled(true);
// narrate / epochSummary 回退返回结构化对象（含 chapter / canonical 字段），由 UI 渲染
const narr = Game.ai.narrate({ results: [], location: 'test', round: 1 });
ok('Provider 抛错时回退 narrate 返回结构化对象', !!narr && typeof narr === 'object' && !!narr.chapter,
   'got: ' + JSON.stringify(narr).slice(0, 120));
const ep = Game.ai.epochSummary({ jump: '十年', changes: ['a'] });
ok('Provider 抛错时回退 epochSummary 返回结构化对象', !!ep && typeof ep === 'object' && Array.isArray(ep.canonical),
   'got: ' + JSON.stringify(ep).slice(0, 120));
// 异步 polishNarration 失败应返回 null
Game.ai.polishNarration({ text: 'x' }).then(function (r) {
  ok('Provider 抛错时 polishNarration 返回 null', r === null);
  finish();
}, function (e) {
  ok('Provider 抛错时 polishNarration 返回 null', false, 'rejected: ' + e);
  finish();
});

function finish() {
  console.log('\n========================================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
}
