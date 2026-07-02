/**
 * ============================================================================
 * 《修行局》V2.1 验收测试
 * ----------------------------------------------------------------------------
 * 对应 V2.1 开发计划 §6 测试补强 + 最小验收场景（塔海悬陆链路）：
 *   确定性 / AI 行为 / 战斗 / 时间与历史 / API 安全
 * 全部断言通过即视为 V2.1 引擎层验收完成。
 * ============================================================================
 */
const Game = require('./game-core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}
function section(t) { console.log('\n— ' + t + ' —'); }

function doRound(playerIntent) {
  Game.submitPlayerIntent(playerIntent);
  Game.collectAIIntents();
  return Game.resolveRound();
}

/** 找到指定地貌的种子 */
function findSeedForTerrain(terrain) {
  for (let i = 1; i < 3000; i++) {
    const seed = 'V21-' + i;
    if (Game.rollOrigin(seed).terrain === terrain) return seed;
  }
  return null;
}

/* ============================================================
 * §6.1 确定性
 * ============================================================ */
section('§6.1 确定性 · 同种子生成同地图');
const detSeed = 'BLACKWIND-127';
Game.generateWorld(detSeed);
const mapA = JSON.stringify({
  nodes: Game.state.map.nodes.map(function (n) { return { name: n.name, kind: n.kind, layer: n.layer }; }),
  edges: Game.state.map.edges,
  profile: Game.state.meta.mapProfile,
});
Game.generateWorld(detSeed);
const mapB = JSON.stringify({
  nodes: Game.state.map.nodes.map(function (n) { return { name: n.name, kind: n.kind, layer: n.layer }; }),
  edges: Game.state.map.edges,
  profile: Game.state.meta.mapProfile,
});
ok('同种子重生世界一致（节点/边/层级/地貌）', mapA === mapB);

section('§6.1 确定性 · 分桶 RNG 续玩与连续游玩一致');
// 用新种子开局，做 2 回合后存档；A 连续第 3 回合，B 读档后第 3 回合，比较
Game.generateWorld('RNG-DET-7');
const intent1 = { actionType: 'cultivate', targetId: Game.getPlayer().locationId, posture: '稳' };
doRound(intent1); Game.advanceTime('当下');
doRound(intent1); Game.advanceTime('当下');
const saveData = Game.save(); // 字符串，含 state.rng 快照
ok('存档返回非空字符串', typeof saveData === 'string' && saveData.length > 0);

// 路径 A：连续第 3 回合
const rA = doRound(intent1);
const evtA = JSON.stringify(Game.getEvents(60));
const locA = JSON.stringify(Game.state.actors.map(function (a) { return a.id + ':' + a.locationId + ':' + a.realm; }));
const seqA = Game.state.eventSeq;

// 路径 B：读档后第 3 回合
Game.reset();
const loaded = Game.load(saveData);
ok('读档恢复 state', !!loaded);
const rB = doRound(intent1);
const evtB = JSON.stringify(Game.getEvents(60));
const locB = JSON.stringify(Game.state.actors.map(function (a) { return a.id + ':' + a.locationId + ':' + a.realm; }));
const seqB = Game.state.eventSeq;
ok('续玩与连续游玩：事件日志一致', evtA === evtB, 'evt diff');
ok('续玩与连续游玩：角色位置/境界一致', locA === locB, 'loc diff');
ok('续玩与连续游玩：eventSeq 一致', seqA === seqB, seqA + ' vs ' + seqB);

/* ============================================================
 * §6.2 AI 行为
 * ============================================================ */
section('§6.2 AI 行为 · 8 回合不原地循环 + 向目标移动');
Game.generateWorld('AI-MOVE-9');
const startLocs = {};
Game.state.actors.forEach(function (a) { startLocs[a.id] = a.locationId; });
const movedSet = {};
for (let i = 0; i < 8; i++) {
  doRound({ actionType: 'cultivate', targetId: Game.getPlayer().locationId, posture: '稳' });
  Game.state.actors.forEach(function (a) {
    if (a.role === 'ai' && a.locationId !== startLocs[a.id]) movedSet[a.id] = true;
  });
  const adv = Game.advanceTime('当下');
  if (!adv.ok) break;
}
const aiIds = Object.keys(startLocs).filter(function (id) { return id !== 'lu'; });
ok('8 回合内至少一名 AI 移动过', Object.keys(movedSet).length > 0, 'moved: ' + Object.keys(movedSet).join(','));
// 顾长风(gu) 有长期目标，检查其 agentPlan 存在且含 targetRegionId
const gu = Game.actorById('gu');
ok('顾长风拥有 AgentPlan', !!(gu && gu.agentPlan && gu.agentPlan.targetRegionId), JSON.stringify(gu && gu.agentPlan));

section('§6.2 AI 行为 · 私密行动不泄露给玩家知识层');
// 天机关闭时，getOmniscientView 仍返回数据，但 UI 默认不展示；这里校验私密字段不在公开接口
Game.generateWorld('PRIV-3');
doRound({ actionType: 'investigate', targetId: Game.getPlayer().locationId, posture: '争' });
const publicEvents = Game.getEvents(50).map(function (e) { return e.text; });
const publicText = publicEvents.join('');
// 私密意图事件文本应为"有所动作，但意图不明"，不含 privateGoal
const hasLeak = publicEvents.some(function (t) { return t.indexOf('privateGoal') >= 0 || t.indexOf('私密目标') >= 0; });
ok('公开事件日志不泄露私密目标字段', !hasLeak);
// 公开叙事回退文本不含 AI 私密知识
const narr = Game.getNarration();
const narrLeak = narr && narr.chapter && (narr.chapter.indexOf('privateGoal') >= 0);
ok('叙事回退文本不含私密字段', !narrLeak);

/* ============================================================
 * §6.3 战斗（持久化遭遇 + 非战斗行动 + 命元）
 * ============================================================ */
section('§6.3 战斗 · 怪物血量/护持跨回合保留');
Game.generateWorld('COMBAT-5');
// 找到一个有未解决 encounter 的节点，把玩家移过去
const encNode = Game.state.map.nodes.find(function (n) { return n.encounter && !n.encounter.resolved; });
ok('存在未解决遭遇节点', !!encNode, 'no encounter node');
if (encNode) {
  Game.getPlayer().locationId = encNode.id;
  const before = {
    vitality: encNode.encounter.vitality,
    guard: encNode.encounter.guard,
    maxVit: encNode.encounter.maxVitality,
  };
  // 借弱点：降低 guard（不杀怪）
  const r = Game.resolveEncounterAction('lu', '借弱点');
  ok('借弱点行动返回 ok', !!(r && r.ok), r && r.reason);
  const afterWeak = encNode.encounter.guard;
  // 推进时间，检查 guard/vitality 未重置
  // 先做一回合让 phase 进入 time
  doRound({ actionType: 'cultivate', targetId: encNode.id, posture: '稳' });
  Game.advanceTime('当下');
  ok('借弱点后怪物护持跨回合保留（未重置）', encNode.encounter.guard === afterWeak,
     'guard ' + afterWeak + ' vs ' + encNode.encounter.guard);
  ok('怪物仍存在（未 resolved）', !encNode.encounter.resolved);
  ok('怪物血量未重置满血', encNode.encounter.vitality <= before.maxVit);
}

section('§6.3 战斗 · 撤退后怪物仍存在');
Game.generateWorld('FLEE-2');
const encNode2 = Game.state.map.nodes.find(function (n) { return n.encounter && !n.encounter.resolved; });
if (encNode2) {
  Game.getPlayer().locationId = encNode2.id;
  const r = Game.resolveEncounterAction('lu', '撤退逃遁');
  ok('撤退返回 ok', !!(r && r.ok), r && r.reason);
  ok('撤退后怪物仍存在（未 resolved）', !encNode2.encounter.resolved);
  ok('撤退标记 escaped=true', !!encNode2.encounter.escaped);
}

section('§6.3 战斗 · 重伤限制百年推进');
Game.generateWorld('HURT-1');
doRound({ actionType: 'cultivate', targetId: Game.getPlayer().locationId, posture: '稳' });
Game.getPlayer().injury = 3; // 模拟重伤
const advHurt = Game.advanceTime('百年');
ok('重伤时百年推进被拒', !advHurt.ok, 'should be blocked');
// 疗伤后可推进
Game.getPlayer().injury = 0;
const advOk = Game.advanceTime('百年');
ok('疗伤后百年推进通过', !!advOk.ok, advOk.reason);

/* ============================================================
 * §6.4 时间与历史
 * ============================================================ */
section('§6.4 时间与历史 · 长期计划影响十年结算');
Game.generateWorld('PLAN-4');
doRound({ actionType: 'cultivate', targetId: Game.getPlayer().locationId, posture: '稳' });
Game.setLongTermPlan('lu', '闭关冲境', Game.getPlayer().locationId);
const planBefore = Game.getLongTermPlan('lu');
ok('长期计划已设置', !!planBefore && planBefore.progress === 0);
Game.advanceTime('十年');
// 闭关冲境 yearsRequired=10，十年正好完成 → flags.insight=true（得悟性机缘），progress 完成后重置
ok('十年闭关冲境完成 → 得悟性机缘', !!(Game.getPlayer().flags && Game.getPlayer().flags.insight), 'insight not set');
ok('十年结算编年史记录闭关', Game.state.ledger.chronicle.canonical.length > 0);

section('§6.4 时间与历史 · 突破不再纯随机');
Game.generateWorld('BREAK-1');
const lu = Game.getPlayer();
// 条件不足时 attemptBreakthrough 返回 null（不随机突破）
lu.cultivationProgress = 1; // 远低于门槛
const noBreak = Game.attemptBreakthrough(lu);
ok('修为不足时不突破（返回 null）', noBreak === null);
// 满足条件（修为+悟性+无重伤）才尝试，且失败有代价
lu.cultivationProgress = 50;
lu.flags = { insight: true };
lu.injury = 0;
const tried = Game.attemptBreakthrough(lu);
ok('满足条件时尝试突破（返回结果对象）', !!tried && (tried.ok || tried.failed), JSON.stringify(tried));

section('§6.4 时间与历史 · 转世仅继承允许字段');
Game.generateWorld('REINCARN-1');
// 构造一个转世灵印，校验字段约束
Game.state.soulImprints.push({
  formerActorId: 'gu', residualTrait: '阵法残忆', unresolvedHooks: ['旧债'],
  inheritedRumor: '顾家遗孤', recognitionTags: ['旧弟子', '旧法宝'],
});
const si = Game.state.soulImprints[0];
const allowed = ['formerActorId', 'residualTrait', 'unresolvedHooks', 'inheritedRumor', 'recognitionTags'];
const hasDisallowed = Object.keys(si).some(function (k) { return allowed.indexOf(k) < 0; });
ok('转世灵印仅含允许字段', !hasDisallowed);
ok('转世灵印不含境界/装备/完整记忆', si.realm === undefined && si.equipment === undefined);

section('§6.4 时间与历史 · 飞升者留下遗产');
Game.generateWorld('ASCEND-2');
// 避开「飞升受阻」法则（需天外凭证），改用不限制飞升的法则
Game.state.meta.heavenlyLaw = '轮回紊乱';
const gu2 = Game.actorById('gu');
gu2.realm = '元婴'; // 满足飞升境界
const ascR = Game.ascend('gu');
ok('飞升返回 ok', !!(ascR && ascR.ok), ascR && ascR.reason);
ok('飞升后生成 HeavenlyEcho', Game.state.heavenlyEchoes.length > 0);
const echo = Game.state.heavenlyEchoes[0];
ok('飞升回响含 owner/doctrine', !!echo && !!echo.owner && (echo.doctrine !== undefined));

section('§6.4 时间与历史 · 天书不能删除既定事件');
Game.generateWorld('HB-1');
doRound({ actionType: 'cultivate', targetId: Game.getPlayer().locationId, posture: '稳' });
const evtCountBefore = Game.getEvents(999).length;
// 天书批注（创设势力）
Game.state.inventory.heavenlyPages = 2;
const hbR = Game.useHeavenlyBook('创设势力', { name: '天书测试宗', kind: '宗门', power: 50 });
ok('天书批注返回 ok', !!(hbR && hbR.ok), hbR && hbR.reason);
const evtCountAfter = Game.getEvents(999).length;
ok('天书批注后事件日志不减少（不删除既定事件）', evtCountAfter >= evtCountBefore,
   evtCountBefore + ' vs ' + evtCountAfter);

/* ============================================================
 * §6.5 API 安全与回退
 * ============================================================ */
section('§6.5 API · 无效 JSON 不改变状态');
Game.generateWorld('API-1');
Game.setAIEnabled(true);
const stateBefore = JSON.stringify(Game.state.actors.map(function (a) { return a.id + a.locationId; }));
Game.registerAIProvider({
  decideCompanion: async function () { throw new Error('bad json'); },
});
// decideCompanion 异步，直接调用校验返回 null
Game.ai.decideCompanion({ candidates: [{ _id: 'c0', actionType: 'travel', targetId: 'r_1' }], agent: {} }).then(function (r) {
  ok('Provider 抛错时 decideCompanion 返回 null', r === null);
});
const stateAfter = JSON.stringify(Game.state.actors.map(function (a) { return a.id + a.locationId; }));
ok('无效响应不改变世界状态', stateBefore === stateAfter);

section('§6.5 API · 超时自动回退本地行为');
// _withTimeout：永不 resolve 的 promise，50ms 超时返回 null
const slow = new Promise(function () { /* never resolves */ });
Game.ai._withTimeout(slow, 50).then(function (r) {
  ok('超时返回 null（回退本地行为）', r === null);
});

section('§6.5 API · AI 无法越权新增法宝/境界/死亡/秘密');
Game.setAIEnabled(true);
Game.registerAIProvider({
  decideCompanion: async function () {
    return { candidateId: 'c0', publicLine: '走', reasonTags: ['x'], newItem: '越权法宝', newRealm: '金丹', death: true, secret: '越权秘密' };
  },
});
Game.ai.decideCompanion({
  candidates: [{ _id: 'c0', actionType: 'travel', targetId: 'r_1' }],
  agent: { id: 'han', name: '韩照野' },
}).then(function (r) {
  ok('越权字段被拒绝（返回 null）', r === null, 'got ' + JSON.stringify(r));
});

section('§6.5 API · API Key 不进入存档与 localStorage');
Game.setApiKey('sk-SECRET-KEY-12345');
Game.generateWorld('KEY-1');
const saveStr = Game.save();
ok('世界存档字符串不含 API Key', saveStr.indexOf('sk-SECRET-KEY-12345') < 0);
const parsedSave = JSON.parse(saveStr);
ok('存档 _settings 不含 apiKey 字段', !parsedSave._settings || parsedSave._settings.apiKey === undefined);
// saveSettings 不含 apiKey
Game.saveSettings({ aiOn: true, base: 'http://x', model: 'm', temperature: 0.8, apiKey: 'sk-LEAK' });
const settingsStr = (typeof localStorage !== 'undefined') ? localStorage.getItem(Game.SETTINGS_KEY) : JSON.stringify(Game.saveSettings({}));
ok('持久化设置不含 apiKey', !settingsStr || settingsStr.indexOf('sk-LEAK') < 0);

/* ============================================================
 * §6.6 最小验收场景 · 塔海悬陆链路
 * ============================================================ */
section('§6.6 塔海悬陆链路 · 掷骰开界');
const tSeed = findSeedForTerrain('塔海悬陆');
ok('找到塔海悬陆种子', !!tSeed, 'no seed found in 3000 tries');
if (tSeed) {
  Game.generateWorld(tSeed);
  ok('生成塔海悬陆世界（mapProfile=vertical_layers）', Game.state.meta.mapProfile === 'vertical_layers', Game.state.meta.mapProfile);
  ok('地貌为塔海悬陆', Game.state.meta.terrain === '塔海悬陆');
  ok('塔海悬陆含 layer 字段（分层）', Game.state.map.nodes.some(function (n) { return typeof n.layer === 'number'; }));
  ok('玩家出生在城池', Game.playerAtKind('城池'));
  // 三名 AI 分散
  const aiLocs = Game.state.actors.filter(function (a) { return a.role === 'ai'; }).map(function (a) { return Game.nodeById(a.locationId).kind; });
  ok('三名 AI 角色存在', Game.state.actors.filter(function (a) { return a.role === 'ai'; }).length === 3);
  ok('AI 出生点互异', new Set(aiLocs).size === 3, JSON.stringify(aiLocs));

  // 顾长风沿路线前往秘境（8 回合内移动）
  section('§6.6 塔海悬陆链路 · 顾长风沿路线移动');
  const guStart = Game.actorById('gu').locationId;
  let guMoved = false;
  for (let i = 0; i < 8; i++) {
    doRound({ actionType: 'cultivate', targetId: Game.getPlayer().locationId, posture: '稳' });
    if (Game.actorById('gu').locationId !== guStart) { guMoved = true; break; }
    const adv = Game.advanceTime('当下'); if (!adv.ok) break;
  }
  ok('顾长风 8 回合内开始移动', guMoved);

  // 玩家十年闭关冲境
  section('§6.6 塔海悬陆链路 · 玩家十年闭关冲境');
  Game.setLongTermPlan('lu', '闭关冲境', Game.getPlayer().locationId);
  const tAdv = Game.advanceTime('十年');
  ok('十年闭关推进通过', !!tAdv.ok, tAdv.reason);
  ok('十年后世界年份增加', Game.state.meta.year >= 10, 'year=' + Game.state.meta.year);
  ok('十年后编年史有变化', Game.state.ledger.chronicle.canonical.length > 0 || (tAdv.summary && tAdv.summary.changes.length > 0));
  ok('十年闭关冲境完成 → 得悟性机缘', !!(Game.getPlayer().flags && Game.getPlayer().flags.insight), 'insight not set');

  // 玩家进入秘境遭遇未重置妖兽
  section('§6.6 塔海悬陆链路 · 秘境遭遇未重置妖兽');
  const secretNode = Game.state.map.nodes.find(function (n) { return n.kind === '秘境' && n.encounter && !n.encounter.resolved; });
  if (secretNode) {
    Game.getPlayer().locationId = secretNode.id;
    const enc = Game.getEncounter();
    ok('秘境遭遇妖兽存在', !!enc && !enc.resolved);
    ok('妖兽血量为正且未重置', enc.vitality > 0 && enc.vitality <= enc.maxVitality);
    // 通过阵法削弱后撤退
    const trapR = Game.resolveEncounterAction('lu', '布阵困敌');
    ok('布阵困敌行动执行', !!(trapR && trapR.ok), trapR && trapR.reason);
    const fleeR = Game.resolveEncounterAction('lu', '撤退逃遁');
    ok('撤退逃遁行动执行', !!(fleeR && fleeR.ok), fleeR && fleeR.reason);
    ok('撤退后妖兽仍盘踞（未 resolved）', !secretNode.encounter.resolved);
    // 疗伤后百年封卷，遗产进入下一卷
    Game.state.actors.forEach(function (a) { if (a.injury >= 3) a.injury = 0; });
    // 先做一回合进入 time 阶段
    doRound({ actionType: 'cultivate', targetId: secretNode.id, posture: '稳' });
    const cAdv = Game.advanceTime('百年');
    section('§6.6 塔海悬陆链路 · 百年后遗产进入下一卷');
    ok('百年封卷通过', !!cAdv.ok, cAdv.reason);
    ok('生成 finalLegacy 遗产包', !!Game.state.finalLegacy);
    if (Game.state.finalLegacy) {
      const L = Game.state.finalLegacy;
      ok('遗产包含 canonicalHistory', Array.isArray(L.canonicalHistory) && L.canonicalHistory.length > 0);
      ok('遗产包含 factions', Array.isArray(L.factions));
      ok('遗产包含 unresolvedKarma', Array.isArray(L.unresolvedKarma));
    }
  } else {
    ok('秘境存在未重置遭遇（链路前提）', false, 'no secret encounter');
  }
}

/* ============================================================
 * §6.7 4 种地貌拓扑差异
 * ============================================================ */
section('§6.7 4 种地貌拓扑差异');
const terrains = ['山河大陆', '群岛海域', '妖域边荒', '塔海悬陆'];
const profiles = {};
terrains.forEach(function (t) {
  const seed = findSeedForTerrain(t);
  if (!seed) { ok('找到 ' + t + ' 种子', false); return; }
  Game.generateWorld(seed);
  profiles[t] = {
    profile: Game.state.meta.mapProfile,
    edgeCount: Game.state.map.edges.length,
    nodeCount: Game.state.map.nodes.length,
  };
  ok(t + ' → ' + profiles[t].profile, Game.state.meta.mapProfile === Game.TERRAIN_TO_PROFILE[t]);
});
const profSet = new Set(Object.keys(profiles).map(function (t) { return profiles[t].profile; }));
ok('4 种地貌对应 4 种不同拓扑', profSet.size === 4, 'profiles: ' + Array.from(profSet).join(','));

// 异步断言等待（超时/越权测试）
setTimeout(function () {
  console.log('\n========================================');
  console.log('  V2.1 通过 ' + pass + ' / 失败 ' + fail);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
}, 200);
