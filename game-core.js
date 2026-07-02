/**
 * ============================================================================
 * 《修行局》V2 —— 游戏核心引擎
 * ============================================================================
 * 从固定三幕 Demo 升级为「种子世界 + 并行修行 + 时间推进 + 可继承历史」的
 * 单人 AI 修仙模拟器。
 *
 * 设计原则（来自 V2 任务清单 §0）：
 *   - 规则 / 随机 / 地图 / 战斗 / 存档全部本地确定性执行。
 *   - AI 只决定「角色表达、候选行动、叙事润色、历史文本」，不直接改世界状态。
 *   - 所有状态变化写入事件日志；世界可由 worldSeed + eventLog 复现。
 *   - 无 API / 断网 / 模型报错时，游戏仍可完整运行（离线回退模板）。
 *
 * 文件结构（对应 V2 §1.1 目录布局，因无构建步骤而合并为单文件分区）：
 *   §1  core/     常量、类型、种子RNG、状态工厂、事件
 *   §2  world/    开界骰、世界生成、节点地图、势力、时间线、遗产
 *   §3  actors/   玩家、同伴、AI决策、关系、寿元
 *   §4  rules/    行动结算、合流相遇、危局战斗、时间推进、因果、天书批注
 *   §5  ai/       Provider 接口、回退模板、叙事/决策/纪元
 *   §6  storage/  本地存档、导入导出、迁移
 *   §7  便捷查询 API（供 UI 调用）
 *
 * 运行时状态只挂在 Game.state；模板（WorldTemplate/SceneTemplate/MonsterTemplate
 * /ItemTemplate）只读，重置不污染。
 * ============================================================================
 */

const Game = {};

/* ============================================================
 * §1.1 常量与配置 (core/constants)
 * ============================================================ */

Game.VERSION = '2.0.0';

/** 姿态修正：稳=降难度，争=正常，逆=难度升但奖励翻倍 */
Game.POSTURE_MOD = {
  '稳': { thresholdMod: -1, rewardMod: 1, speedMod: 0,  desc: '降低难度1点，稳健行事' },
  '争': { thresholdMod: 0,  rewardMod: 1, speedMod: 1,  desc: '正常难度，正常收益' },
  '逆': { thresholdMod: 2,  rewardMod: 2, speedMod: 1,  desc: '难度+2，但成功奖励翻倍' },
};

/** 行动类型 → 对应根性（术/识/心） */
Game.ACTION_ROOT = {
  travel: '识', cultivate: '心', explore: '识', battle: '术',
  social: '心', craft: '术', investigate: '识',
};

/** 行动类型中文名 */
Game.ACTION_LABEL = {
  travel: '行游', cultivate: '闭关', explore: '探查', battle: '争斗',
  social: '结缘', craft: '炼制', investigate: '查究',
};

/** 道途契合表 [道途][行动] → 0/1/2 */
Game.DAO_MATCH = {
  '剑修': { battle: 2, travel: 1, explore: 0, cultivate: 1, social: 0, craft: 0, investigate: 1 },
  '丹道': { craft: 2, explore: 1, cultivate: 1, investigate: 2, social: 1, battle: 0, travel: 0 },
  '阵法': { investigate: 2, craft: 1, explore: 2, battle: 0, travel: 1, cultivate: 1, social: 0 },
};

/** 境界阶梯与加值 */
Game.REALM_LADDER = [
  { name: '炼气六层', bonus: 1, tier: 1 },
  { name: '炼气七层', bonus: 2, tier: 1 },
  { name: '炼气八层', bonus: 3, tier: 1 },
  { name: '炼气九层', bonus: 4, tier: 1 },
  { name: '筑基初期', bonus: 6, tier: 2 },
  { name: '筑基中期', bonus: 8, tier: 2 },
  { name: '筑基后期', bonus: 10, tier: 2 },
  { name: '金丹初期', bonus: 14, tier: 3 },
  { name: '金丹中期', bonus: 18, tier: 3 },
  { name: '金丹后期', bonus: 22, tier: 3 },
  { name: '元婴', bonus: 30, tier: 4 },
];
Game.realmBonus = function (realm) {
  const r = Game.REALM_LADDER.find(function (x) { return x.name === realm; });
  return r ? r.bonus : 0;
};
Game.realmTier = function (realm) {
  const r = Game.REALM_LADDER.find(function (x) { return x.name === realm; });
  return r ? r.tier : 1;
};
Game.nextRealm = function (realm) {
  const i = Game.REALM_LADDER.findIndex(function (x) { return x.name === realm; });
  if (i < 0 || i >= Game.REALM_LADDER.length - 1) return null;
  return Game.REALM_LADDER[i + 1].name;
};

/** 结果等级（天机值 - 有效门槛 的差值门槛） */
Game.GRADES = {
  '大成':     { offset: 3,   desc: '超出门槛3点以上，完成目标并获额外奖励' },
  '成功':     { offset: 0,   desc: '达到门槛，完成目标' },
  '勉成有价': { offset: -2,  desc: '低于门槛1-2点，完成目标但承担代价' },
  '失势留痕': { offset: -99, desc: '低于门槛3点以上，目标未成但获线索/悟性/反转机会' },
};

/** 时间跳跃尺度 */
Game.TIME_JUMPS = ['当下', '一月', '一年', '十年', '百年', '千年'];
Game.TIME_JUMP_YEARS = { '当下': 0, '一月': 0.08, '一年': 1, '十年': 10, '百年': 100, '千年': 1000 };

/** 行动阶段顺序 */
Game.PHASE_ORDER = ['intent', 'resolve', 'narrate', 'time'];

/** 天书批注可用类型 */
Game.HEAVENLY_ANNOTATIONS = {
  '创设流派': '创建新修行流派，改变世界规则走向',
  '创设势力': '在地图新增一个势力与节点',
  '留痕': '留下遗迹/禁地/传闻/史书记载',
  '封存': '将秘密/人物/宝物压入未来',
};

/* ============================================================
 * §1.2 世界模板（只读）(world/templates)
 * ============================================================ */

/** 开界骰四枚 */
Game.ORIGIN_DICE = {
  era: ['盛世', '灵气衰世', '末法回潮', '天倾前夜'],
  terrain: ['山河大陆', '群岛海域', '妖域边荒', '塔海悬陆'],
  order: ['宗门割据', '皇朝统治', '妖族共治', '散修乱世'],
  heavenlyLaw: ['飞升受阻', '轮回紊乱', '契约具现', '法宝有灵'],
};

/** 各 era/terrain/order/heavenlyLaw 的世界规则文案与机制提示 */
Game.ORIGIN_EFFECT = {
  era: {
    '盛世':       { rule: '灵气充沛，修行加速，宗门鼎盛。', mod: { cultivate: 1 } },
    '灵气衰世':   { rule: '灵气渐稀，突破维艰，遗物频现。', mod: { cultivate: -1, relic: 1 } },
    '末法回潮':   { rule: '末法之气回潮，法宝有灵而修士难成。', mod: { cultivate: -2, relic: 2 } },
    '天倾前夜':   { rule: '天倾将至，灾劫频发，飞升者绝迹。', mod: { danger: 1, cultivate: -1 } },
  },
  terrain: {
    '山河大陆': { rule: '广袤大陆，宗门城池错落。', regions: ['宗门', '城池', '妖域', '秘境', '荒野', '禁地', '海域'] },
    '群岛海域': { rule: '群岛星罗，水路为主。', regions: ['宗门', '城池', '秘境', '荒野', '禁地', '海域', '海域'] },
    '妖域边荒': { rule: '边荒妖族横行。', regions: ['宗门', '城池', '妖域', '妖域', '秘境', '禁地', '荒野'] },
    '塔海悬陆': { rule: '悬陆浮空，塔林通天。', regions: ['宗门', '宗门', '城池', '秘境', '禁地', '荒野', '海域'] },
  },
  order: {
    '宗门割据': { rule: '宗门各据一方，争锋不断。', factions: ['青霄宗', '流云宗', '玄霄宗'] },
    '皇朝统治': { rule: '皇朝统御修界，律法严明。', factions: ['天枢皇朝', '青霄宗', '赤砂商会'] },
    '妖族共治': { rule: '人妖共治，盟约脆弱。', factions: ['黑风妖庭', '青霄宗', '药谷'] },
    '散修乱世': { rule: '散修乱世，群雄并起。', factions: ['赤砂商会', '顾家', '药谷'] },
  },
  heavenlyLaw: {
    '飞升受阻': { rule: '飞升之路受阻，大能滞留人间。', futureAbnormal: '滞留大能或夺舍转世' },
    '轮回紊乱': { rule: '轮回紊乱，前世记忆错位。', futureAbnormal: '前世因果觉醒' },
    '契约具现': { rule: '契约具现为实物，违背即遭反噬。', futureAbnormal: '契约道显化' },
    '法宝有灵': { rule: '法宝自有灵识，择主而栖。', futureAbnormal: '法宝择主/反噬' },
  },
};

/** 区域名池（按 kind） */
Game.REGION_NAMES = {
  '宗门': ['青霄宗', '流云宗', '玄霄宗', '落星宗', '苍梧宗'],
  '城池': ['赤砂边城', '苍梧城', '镇妖关', '云中城', '听涛城'],
  '妖域': ['黑风妖岭', '万妖谷', '血月原', '苍狼野', '幽冥泽'],
  '秘境': ['幽泉秘境', '落霞秘境', '残星秘境', '忘川秘境', '镜月秘境'],
  '荒野': ['断流古道', '枯骨荒原', '风沙古道', '寂灭荒原', '寒铁古道'],
  '禁地': ['天裂禁地', '埋剑渊', '焚天死地', '葬星渊', '陨神谷'],
  '海域': ['沧澜海域', '蜃楼海', '浮礁群岛', '沉星海', '碧落海'],
};

/** 区域传闻池 */
Game.REGION_RUMORS = {
  '宗门': ['近来有弟子失踪，传闻与外门试炼有关。', '宗门长老闭关已久，掌门代行事务。'],
  '城池': ['城中商队屡遭劫掠，悬赏捉拿。', '边城流民增多，似有妖族压境。'],
  '妖域': ['妖王心跳声渐频，妖兽躁动不安。', '有修士深入妖域，再未归来。'],
  '秘境': ['秘境将启，传承现世之兆。', '秘境崩塌征兆已现，黑水倒流。'],
  '荒野': ['古道夜半常有剑鸣，无人敢近。', '荒野中现古老阵纹残迹。'],
  '禁地': ['禁地裂隙扩大，禁制渐弱。', '有人见禁地深处有光，转瞬即逝。'],
  '海域': ['海面浮起沉船残骸，似有古宝。', '蜃楼海现幻城，引人迷失。'],
};

/** 区域资源池 */
Game.REGION_RESOURCES = {
  '宗门': ['灵石矿脉', '功法残卷', '丹药库'],
  '城池': ['商货', '情报网', '法器铺'],
  '妖域': ['妖兽材料', '血色兽牙', '妖丹'],
  '秘境': ['传承残卷', '阵眼碎片', '古宝'],
  '荒野': ['灵草', '陨铁', '古道遗物'],
  '禁地': ['禁制残片', '遗骨', '陨落之宝'],
  '海域': ['海灵珠', '珊瑚灵材', '沉船古物'],
};

/** 怪物池 V1（9 只，详见 V2 §6.3） */
Game.MONSTERS = [
  { id: 'wolf',  name: '赤瞳妖狼', realmTier: 2, vitality: 14, spirit: 6,  guard: 6,  speed: 7,  danger: 3,
    traits: ['妖王血脉', '残阵锁域'], weakness: '残阵锁域，离桥则弱', dangerMech: '妖王血脉反噬，伤人反伤己',
    nonCombat: '借残阵困之，或以丹香安抚令其让路', loot: ['妖狼血样'], haunt: '秘境' },
  { id: 'snake', name: '黑水蛟蛇', realmTier: 2, vitality: 18, spirit: 8,  guard: 8,  speed: 5,  danger: 3,
    traits: ['黑水毒沼'], weakness: '离水则钝', dangerMech: '黑水毒沼，缠缚中毒',
    nonCombat: '引离水域或以阵隔水', loot: ['蛟蛇胆'], haunt: '海域' },
  { id: 'crow',  name: '食魂鸦',   realmTier: 1, vitality: 9,  spirit: 10, guard: 3,  speed: 9,  danger: 2,
    traits: ['啖魂'], weakness: '惧强光雷法', dangerMech: '啖食神魂，损神耗灵',
    nonCombat: '以明光阵驱散', loot: ['鸦羽'], haunt: '荒野' },
  { id: 'puppet',name: '阵傀',     realmTier: 2, vitality: 22, spirit: 5,  guard: 12, speed: 3,  danger: 3,
    traits: ['不死不倦'], weakness: '阵眼被夺则僵', dangerMech: '不知疲倦，连击不休',
    nonCombat: '夺阵眼或破阵纹', loot: ['阵核'], haunt: '禁地' },
  { id: 'shan',  name: '山魈',     realmTier: 1, vitality: 11, spirit: 7,  guard: 5,  speed: 8,  danger: 2,
    traits: ['群啸乱神'], weakness: '贪宝易惑', dangerMech: '群啸乱神，幻听幻视',
    nonCombat: '以宝诱之，声东击西', loot: ['山魈骨'], haunt: '荒野' },
  { id: 'vine',  name: '血藤妖',   realmTier: 2, vitality: 20, spirit: 6,  guard: 7,  speed: 4,  danger: 3,
    traits: ['缠缚吸血'], weakness: '畏火', dangerMech: '缠缚吸血，越战越强',
    nonCombat: '火攻或断其根节', loot: ['血藤芯'], haunt: '秘境' },
  { id: 'spirit',name: '失控剑灵', realmTier: 3, vitality: 16, spirit: 14, guard: 9,  speed: 11, danger: 4,
    traits: ['剑气无差别'], weakness: '剑意同源可驯', dangerMech: '剑气肆虐，无差别伤人',
    nonCombat: '以剑经共鸣或封入残剑', loot: ['剑灵残片'], haunt: '秘境' },
  { id: 'mirage',name: '雾海蜃妖', realmTier: 2, vitality: 13, spirit: 12, guard: 6,  speed: 10, danger: 3,
    traits: ['迷幻'], weakness: '幻象有破绽', dangerMech: '迷幻致人迷失',
    nonCombat: '闭目听声或以神识破幻', loot: ['蜃珠'], haunt: '海域' },
  { id: 'cult',  name: '低阶邪修', realmTier: 2, vitality: 15, spirit: 9,  guard: 6,  speed: 6,  danger: 3,
    traits: ['邪术阴毒'], weakness: '贪生怕死', dangerMech: '邪术阴毒，暗算伤人',
    nonCombat: '谈判收买或借势威慑', loot: ['邪修令牌'], haunt: '城池' },
];
Game.monsterByHaunt = function (kind) {
  const list = Game.MONSTERS.filter(function (m) { return m.haunt === kind; });
  return list.length ? list : Game.MONSTERS;
};

/* ============================================================
 * §1.3 种子随机数 (core/rng)
 * ------------------------------------------------------------
 * 基于 mulberry32 + 字符串哈希。同一 seed 必产出同一序列。
 * 规则层禁止 Math.random / Date.now，全部经 RNG。
 * ============================================================ */

Game.hashSeed = function (str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h >>> 0);
};

/**
 * 创建种子 RNG（mulberry32）。可传入子流名以派生独立子序列。
 * V2.1 §0.1：支持 getState/setState 以便存档续玩确定性。
 */
Game.createSeededRng = function (seed, subStream) {
  const baseSeed = String(seed) + (subStream ? '::' + subStream : '');
  let a = Game.hashSeed(baseSeed) >>> 0;
  const next = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed: baseSeed,
    next: next,
    int: function (min, max) { return Math.floor(next() * (max - min + 1)) + min; },
    pick: function (arr) { return arr[Math.floor(next() * arr.length)]; },
    picks: function (arr, n) {
      const pool = arr.slice();
      const out = [];
      for (let i = 0; i < n && pool.length; i++) {
        out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]);
      }
      return out;
    },
    chance: function (p) { return next() < p; },
    rollDice: function (count) {
      const out = [];
      for (let i = 0; i < (count || 2); i++) out.push(Math.floor(next() * 6) + 1);
      return out;
    },
    /** 导出当前内部状态（用于存档） */
    getState: function () { return a >>> 0; },
    /** 从存档恢复内部状态 */
    setState: function (s) { a = (s >>> 0); },
  };
};

/**
 * V2.1 §0.1 分桶 RNG。四条独立子流，互不干扰，存档可完整恢复。
 *   action — 战斗、行动骰点
 *   agent  — AI 行动选择
 *   time   — 时间推进与世界变化
 *   event  — 事件 ID
 * Game.rng 为运行时桶集合；state.rng 仅保存可序列化的 {seed,state}。
 */
Game.RNG_BUCKETS = ['action', 'agent', 'time', 'event'];

Game.createRngBuckets = function (worldSeed) {
  const buckets = {};
  Game.RNG_BUCKETS.forEach(function (name) {
    buckets[name] = Game.createSeededRng(worldSeed, name);
  });
  return buckets;
};

/** 把运行时桶状态序列化进 state.rng（存档前调用） */
Game.snapshotRng = function () {
  const out = {};
  if (!Game.rng) return out;
  Game.RNG_BUCKETS.forEach(function (name) {
    if (Game.rng[name]) out[name] = { seed: Game.rng[name].seed, state: Game.rng[name].getState() };
  });
  return out;
};

/** 从 state.rng 恢复运行时桶（读档后调用） */
Game.restoreRng = function (savedRng) {
  const worldSeed = Game.state ? Game.state.meta.seed : '';
  Game.rng = Game.createRngBuckets(worldSeed);
  if (savedRng) {
    Game.RNG_BUCKETS.forEach(function (name) {
      const s = savedRng[name];
      if (s && Game.rng[name]) Game.rng[name].setState(s.state);
    });
  }
};

/** 兼容旧代码的统一取桶接口（按用途路由到正确子流） */
Game.rngFor = function (purpose) {
  if (Game.rng && Game.rng[purpose]) return Game.rng[purpose];
  // 兜底：不应到达此处
  if (!Game._fallbackRng) Game._fallbackRng = Game.createSeededRng('fallback', 'rng');
  return Game._fallbackRng;
};

/* ============================================================
 * §1.4 状态工厂 (core/stateFactory)
 * ============================================================ */

Game._clone = function (obj) { return JSON.parse(JSON.stringify(obj)); };

Game.state = null;

/**
 * 生成空运行状态骨架（不依赖世界生成）。
 * 模板只读，运行时独立，重置不残留。
 */
Game.createEmptyState = function () {
  return {
    meta: {
      version: Game.VERSION,
      seed: '',
      worldName: '',
      yearName: '',
      era: '', terrain: '', order: '', heavenlyLaw: '',
      mapProfile: '',           // V2.1 §1.1 地貌拓扑
      year: 0, round: 0, phase: 'intent',
      aiEnabled: false, createdAt: 0,
    },
    world: {
      rules: [], spiritualClimate: 0, futureAbnormal: [],
      truths: [], rumors: [],
      lawEffects: {},           // V2.1 §1.2 天道法则效果
    },
    map: { nodes: [], edges: [], profile: '' },
    factions: [],
    actors: [],
    ledger: {
      events: [], hooks: [], chronicle: { canonical: [], rumors: [], privateTruth: [] },
      memories: {}, // 四层记忆：worldTruth / charKnowledge / rumor / hook（此处合并到上）
    },
    currentRound: {
      intents: [], results: [], encounter: null,
      narration: null, timeJump: null, votes: {},
    },
    inventory: { heavenlyPages: 0, items: [] },
    historySeeds: [],
    gameEnded: false,
    finalLegacy: null,
    // V2.1 §0.1 分桶 RNG 状态（可序列化）
    rng: { action: null, agent: null, time: null, event: null },
    eventSeq: 0,               // V2.1 §0.1 事件 ID 计数器（取代模块级 _eventSeq）
    longTermPlans: {},         // V2.1 §3.1 角色长期计划 { actorId: LongTermPlan }
    heavenlyEchoes: [],        // V2.1 §3.3 飞升者回响
    soulImprints: [],          // V2.1 §3.3 转世灵印
  };
};

/* ============================================================
 * §1.5 事件日志 (core/events)
 * ------------------------------------------------------------
 * 统一 GameEvent 格式（V2 §8.1）。AI 文本不得直接创建事件。
 * ============================================================ */

// V2.1 §0.1：事件 ID 计数器移入 state.eventSeq，保证存档续玩一致
Game.newEvent = function (type, opts) {
  const s = Game.state;
  opts = opts || {};
  const seq = s ? (s.eventSeq = (s.eventSeq || 0) + 1) : 0;
  const evRng = Game.rngFor('event');
  return {
    id: 'ev_' + seq.toString(36) + '_' + Math.floor(evRng.next() * 1e9).toString(36),
    year: s ? s.meta.year : 0,
    round: s ? s.meta.round : 0,
    type: type,
    actorIds: opts.actorIds || [],
    regionId: opts.regionId || null,
    publicEffects: opts.publicEffects || [],
    privateEffects: opts.privateEffects || [],
    text: opts.text || '',
    source: opts.source || 'rule',
  };
};

Game.logEvent = function (type, opts) {
  if (!Game.state) return null;
  const ev = Game.newEvent(type, opts);
  Game.state.ledger.events.push(ev);
  return ev;
};

Game.getEvents = function (limit) {
  const log = Game.state ? Game.state.ledger.events : [];
  return limit ? log.slice(-limit) : log.slice();
};

/* ============================================================
 * §2.1 开界骰 (world/worldGenerator)
 * ============================================================ */

/** 由种子掷四枚开界骰。同一 seed 同一结果。 */
Game.rollOrigin = function (seed) {
  const rng = Game.createSeededRng(seed, 'origin');
  return {
    seed: seed,
    era: rng.pick(Game.ORIGIN_DICE.era),
    terrain: rng.pick(Game.ORIGIN_DICE.terrain),
    order: rng.pick(Game.ORIGIN_DICE.order),
    heavenlyLaw: rng.pick(Game.ORIGIN_DICE.heavenlyLaw),
  };
};

/** 由骰子结果拼装世界基础卡 */
Game.buildWorldCard = function (roll) {
  const eff = Game.ORIGIN_EFFECT;
  const rules = [
    eff.era[roll.era].rule,
    eff.terrain[roll.terrain].rule,
    eff.order[roll.order].rule,
    eff.heavenlyLaw[roll.heavenlyLaw].rule,
  ];
  const worldName = roll.era + '·' + roll.terrain + '之界';
  const yearName = Game._yearNameFromRoll(roll);
  return {
    roll: roll,
    worldName: worldName,
    yearName: yearName,
    rules: rules,
    eraMod: eff.era[roll.era].mod,
    futureAbnormal: eff.heavenlyLaw[roll.heavenlyLaw].futureAbnormal,
  };
};

Game._yearNameFromRoll = function (roll) {
  const prefix = { '盛世': '承平', '灵气衰世': '渐微', '末法回潮': '末法', '天倾前夜': '天倾' }[roll.era] || '开元';
  const suffix = { '宗门割据': '宗年', '皇朝统治': '朝年', '妖族共治': '盟年', '散修乱世': '乱年' }[roll.order] || '年';
  return prefix + '元' + suffix;
};

/* ============================================================
 * §2.2 世界生成 / 节点地图 / 势力 (world/mapGraph, regionGenerator, factionGenerator)
 * ============================================================ */

/**
 * V2.1 §1.1 地貌拓扑档案。每种地貌决定节点数、边集形态与旅行限制。
 * 不再使用统一固定环；地貌不同 → 路径形态、边数、旅行限制明显不同。
 */
Game.MAP_PROFILES = {
  // 山河大陆：中心辐射，宗门/城池为枢纽，路线稳定
  hub_spoke: {
    nodeCount: 7,
    buildEdges: function (n) {
      // 0 为中心枢纽，其余放射；外围再连一环保证多路径
      const e = [[0,1],[0,2],[0,3],[0,4],[0,5],[0,6],[1,2],[2,3],[3,4],[4,5],[5,6],[6,1]];
      return e.filter(function (x) { return x[0] < n && x[1] < n; });
    },
    centerKind: '城池',
    travelNote: '大陆通衢，路线稳定，商旅往来。',
    requiresVessel: false,
  },
  // 群岛海域：海岛链，部分路线需船只/法器
  island_chain: {
    nodeCount: 7,
    buildEdges: function (n) {
      // 链状为主，少量跨海捷径
      const e = [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[0,3],[2,6]];
      return e.filter(function (x) { return x[0] < n && x[1] < n; });
    },
    centerKind: '海域',
    travelNote: '群岛星罗，跨海需船或法器；海域事件更频繁。',
    requiresVessel: true,
  },
  // 妖域边荒：狭长走廊，妖域控制边境
  border_corridor: {
    nodeCount: 7,
    buildEdges: function (n) {
      // 走廊串行 + 妖域（中段）把守
      const e = [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[1,5]];
      return e.filter(function (x) { return x[0] < n && x[1] < n; });
    },
    centerKind: '荒野',
    travelNote: '边荒狭长走廊，妖族扼守要冲，旅行易触发势力检查。',
    requiresVessel: false,
  },
  // 塔海悬陆：纵向层级，低→高；筑基前只能走桥梁
  vertical_layers: {
    nodeCount: 7,
    buildEdges: function (n) {
      // 分三层：底(0,1) 桥(2,3) 顶(4,5,6)；纵向为主
      const e = [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[0,2],[3,5]];
      return e.filter(function (x) { return x[0] < n && x[1] < n; });
    },
    centerKind: '宗门',
    travelNote: '悬陆浮空分层，筑基前仅走桥梁；高处有坠落、风暴、飞行机缘。',
    requiresVessel: false,
    layered: true,
  },
};

/** 地貌 → 拓扑档案名 */
Game.TERRAIN_TO_PROFILE = {
  '山河大陆': 'hub_spoke',
  '群岛海域': 'island_chain',
  '妖域边荒': 'border_corridor',
  '塔海悬陆': 'vertical_layers',
};

/** 旧版固定拓扑（保留供测试/回退引用） */
Game.BASE_GRAPH = {
  edges: [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,0],[0,3],[1,5]],
};

/**
 * V2.1 §1.2 天道法则效果。开界骰 heavenlyLaw 决定哪一组规则进入玩法层。
 */
Game.WORLD_LAW_EFFECTS = {
  '飞升受阻': {
    desc: '飞升之路受阻，金丹以上突破需「天外凭证」；大能滞留人间干预势力。',
    onBreakthrough: function (actor, ctx) {
      if (Game.realmTier(actor.realm) >= 3 && !actor.flags) actor.flags = {};
      if (Game.realmTier(actor.realm) >= 3 && !(actor.flags && actor.flags.tianwaiCert)) {
        return { ok: false, reason: '飞升受阻：金丹以上突破需「天外凭证」' };
      }
      return { ok: true };
    },
    onTimeAdvance: function (years, summary) {
      // 高境界者更易滞留并影响势力
      Game.state.actors.forEach(function (a) {
        if (Game.realmTier(a.realm) >= 3 && Game.rngFor('time').chance(0.1 * years / 10)) {
          summary.changes.push(a.name + '滞留人间，暗中干预一桩势力走向。');
        }
      });
    },
  },
  '轮回紊乱': {
    desc: '轮回紊乱，转世者随机继承前世残响，可被旧人/旧物认出。',
    onReincarnate: function (soulImprint) {
      const traits = ['前世剑意残响', '断续记忆', '旧伤疤', '陌生灵识'];
      soulImprint.residualTrait = Game.rngFor('time').pick(traits);
      soulImprint.recognitionTags = ['旧债主', '旧弟子', '旧法宝'];
      return soulImprint;
    },
    onTimeAdvance: function (years, summary) {},
  },
  '契约具现': {
    desc: '承诺具现为契约钩子，违约直接增加因果或触发反噬。',
    onPromise: function (actor, target, content) {
      Game.addHook({ name: '契约·' + content, owner: actor.name, intensity: 2,
        trigger: ['违约', '到期'], reward: '履约得机缘', risk: '违约遭反噬' });
    },
    onTimeAdvance: function (years, summary) {
      // 检查是否有违约迹象
      Game.state.ledger.hooks.forEach(function (h) {
        if (h.name.indexOf('契约') >= 0 && Game.rngFor('time').chance(0.05 * years / 10)) {
          summary.changes.push('契约「' + h.name + '」具现显化，因果加压。');
          h.intensity += 1;
        }
      });
    },
  },
  '法宝有灵': {
    desc: '法宝自有灵识，择主而栖；可能拒绝、帮助或反噬持有者。',
    onTimeAdvance: function (years, summary) {
      Game.state.actors.forEach(function (a) {
        if (a.resources.length && Game.rngFor('time').chance(0.08 * years / 10)) {
          const item = Game.rngFor('time').pick(a.resources);
          const attitude = Game.rngFor('time').pick(['认可', '冷淡', '试探']);
          summary.changes.push(a.name + '所持「' + item + '」灵识' + attitude + '。');
          if (attitude === '试探') a.injury = (a.injury || 0) + 1;
        }
      });
    },
  },
};

/** 取当前世界法则效果（可能为空对象） */
Game.getLawEffect = function () {
  const law = Game.state && Game.state.meta.heavenlyLaw;
  return law ? (Game.WORLD_LAW_EFFECTS[law] || null) : null;
};

/** 由种子生成完整世界（地图、势力、角色、初始传闻）。确定性。 */
Game.generateWorld = function (seed) {
  const roll = Game.rollOrigin(seed);
  const card = Game.buildWorldCard(roll);
  const worldRng = Game.createSeededRng(seed, 'world');

  const state = Game.createEmptyState();
  Game.state = state;
  // V2.1 §0.1：初始化分桶 RNG（世界生成仍用独立 worldRng，避免污染运行时桶）
  Game.rng = Game.createRngBuckets(seed);

  // —— meta
  state.meta.seed = seed;
  state.meta.worldName = card.worldName;
  state.meta.yearName = card.yearName;
  state.meta.era = roll.era;
  state.meta.terrain = roll.terrain;
  state.meta.order = roll.order;
  state.meta.heavenlyLaw = roll.heavenlyLaw;
  state.meta.mapProfile = Game.TERRAIN_TO_PROFILE[roll.terrain] || 'hub_spoke';
  state.meta.year = 1;
  state.meta.round = 1;
  state.meta.phase = 'intent';
  state.meta.createdAt = 0; // 浏览器侧写入 Date.now()

  // —— world 规则 / 真相 / 异常
  state.world.rules = card.rules.slice();
  state.world.futureAbnormal = [card.futureAbnormal];
  state.world.spiritualClimate = (card.eraMod.cultivate || 0);
  state.world.truths = [
    '此界由世界种子「' + seed + '」开启，开界骰已定其根。',
    card.rules.join(''),
  ];
  state.world.rumors = [];
  state.world.lawEffects = { law: roll.heavenlyLaw };

  // —— 区域节点（按 terrain 决定 kind 序列，保证至少含宗门/城池/妖域/秘境/荒野/禁地）
  const kinds = Game.ORIGIN_EFFECT.terrain[roll.terrain].regions.slice();
  // 强制补齐六类
  ['宗门','城池','妖域','秘境','荒野','禁地'].forEach(function (k) {
    if (kinds.indexOf(k) < 0) kinds[kinds.length - 1] = k;
  });

  const factionPool = Game.ORIGIN_EFFECT.order[roll.order].factions.slice();
  state.factions = factionPool.map(function (name, i) {
    return { id: 'fac_' + i, name: name, power: worldRng.int(40, 80), stance: '中立', controlled: [] };
  });

  const sectFaction = state.factions[0];
  const demonFaction = state.factions.find(function (f) { return f.name.indexOf('妖') >= 0; }) || state.factions[2];
  const merchantFaction = state.factions.find(function (f) { return f.name.indexOf('商') >= 0 || f.name.indexOf('家') >= 0; }) || state.factions[1];

  // V2.1 §1.1：按地貌拓扑决定节点数
  const profile = Game.MAP_PROFILES[state.meta.mapProfile];
  const nodeCount = profile ? profile.nodeCount : 7;
  const usedKinds = kinds.slice(0, nodeCount);
  // 补齐节点数
  while (usedKinds.length < nodeCount) usedKinds.push(worldRng.pick(['荒野', '海域', '宗门', '城池']));

  state.map.nodes = usedKinds.map(function (kind, i) {
    const name = Game.REGION_NAMES[kind][worldRng.int(0, Game.REGION_NAMES[kind].length - 1)];
    let controllerId = null;
    if (kind === '宗门') controllerId = sectFaction.id;
    else if (kind === '妖域') controllerId = demonFaction.id;
    else if (kind === '城池') controllerId = merchantFaction.id;
    const danger = { '宗门':1,'城池':1,'荒野':2,'海域':2,'妖域':3,'秘境':3,'禁地':4 }[kind] || 2;
    const resources = Game.REGION_RESOURCES[kind].slice(0, 1).concat(worldRng.picks(Game.REGION_RESOURCES[kind], 1));
    const rumor = worldRng.pick(Game.REGION_RUMORS[kind]);
    return {
      id: 'r_' + i, idx: i, name: name, kind: kind, danger: danger,
      aura: [kind], controllerFactionId: controllerId,
      resources: Array.from(new Set(resources)), rumors: [rumor], historyTags: [],
      connections: [], currentEvents: [], encounter: null, sealed: (kind === '禁地'),
      layer: profile && profile.layered ? Math.floor(i * 3 / nodeCount) : 0, // 塔海悬陆分层
    };
  });
  // V2.1 §1.1：按地貌拓扑生成边
  const edges = profile ? profile.buildEdges(nodeCount) : Game.BASE_GRAPH.edges;
  state.map.edges = edges.map(function (e) { return [e[0], e[1]]; });
  state.map.profile = state.meta.mapProfile;
  state.map.travelNote = profile ? profile.travelNote : '';
  state.map.requiresVessel = !!(profile && profile.requiresVessel);
  state.map.layered = !!(profile && profile.layered);
  state.map.edges.forEach(function (e) {
    state.map.nodes[e[0]].connections.push(state.map.nodes[e[1]].id);
    state.map.nodes[e[1]].connections.push(state.map.nodes[e[0]].id);
  });

  // 给秘境/禁地各放一只怪物遭遇（探索时触发）
  // V2.1 §4.1：encounter 持久化怪物状态，不再每次重置满血
  ['秘境', '禁地', '妖域', '海域'].forEach(function (kind) {
    const node = state.map.nodes.find(function (n) { return n.kind === kind; });
    if (!node) return;
    const pool = Game.monsterByHaunt(kind);
    const m = Game._clone(worldRng.pick(pool));
    node.encounter = {
      monsterId: m.id, resolved: false, escaped: false,
      vitality: m.vitality, maxVitality: m.vitality, spirit: m.spirit,
      guard: m.guard, hostility: 2, statuses: [],
    };
  });

  // 势力 controlled 汇总
  state.map.nodes.forEach(function (n) {
    if (n.controllerFactionId) {
      const f = state.factions.find(function (x) { return x.id === n.controllerFactionId; });
      if (f) f.controlled.push(n.id);
    }
  });

  // —— 角色（复用 Demo 四人设定，转为运行时结构）
  state.actors = Game._createActors(worldRng, state.map.nodes, state.factions);
  // V2.1 §2.1：初始化 AI 长期计划
  state.actors.forEach(function (a) {
    if (a.role === 'ai') Game._initAgentPlan(a);
  });

  // —— 初始传闻
  state.world.rumors = state.map.nodes.slice(0, 3).map(function (n) { return n.rumors[0]; });

  // —— 事件：开界
  Game.logEvent('world.origin', {
    text: '开界仪式完成。世界种子「' + seed + '」，' + card.worldName + '，' + card.yearName + '元年。地貌：' + (profile ? profile.travelNote : '') + '；天律：' + roll.heavenlyLaw + '。',
    publicEffects: ['世界开启'],
    source: 'rule',
  });
  state.actors.forEach(function (a) {
    Game.logEvent('actor.spawn', {
      actorIds: [a.id], regionId: a.locationId,
      text: a.name + '（' + a.identity + '）现于「' + Game.nodeById(a.locationId).name + '」。',
      source: 'rule',
    });
  });

  // 存档前先把桶状态写入 state.rng（首次生成时记录起点）
  state.rng = Game.snapshotRng();
  return state;
};

/** 创建四名角色并安置到不同地点 */
Game._createActors = function (rng, nodes, factions) {
  const base = [
    { id: 'lu',   name: '陆知微', role: 'player', identity: '青霄宗外门弟子', daoPath: '剑修',
      realm: '炼气七层', roots: { 术: 2, 识: 2, 心: 2 }, luck: 2, karma: 1,
      publicGoal: '夺得秘境传承，证明自己并非庸才', privateGoal: '残剑中的剑灵似乎认识他',
      personality: ['坚韧', '隐忍', '观察入微'],
      actionWeights: { travel: 2, explore: 2, cultivate: 2, battle: 2, social: 2, craft: 1, investigate: 2 },
      triggerRules: [], knownFacts: ['残剑中沉睡着一位剑灵'], resources: ['残剑（内含剑灵）'] },
    { id: 'han',  name: '韩照野', role: 'ai', identity: '流云宗剑修', daoPath: '剑修',
      realm: '炼气八层', roots: { 术: 3, 识: 1, 心: 1 }, luck: 2, karma: 1,
      publicGoal: '得到秘境剑经', privateGoal: '寻找杀死师父的异常剑意',
      personality: ['冲动', '护短', '嘴硬', '重承诺'],
      actionWeights: { battle: 5, travel: 2, social: 2, investigate: 1, cultivate: 1, explore: 2, craft: 0 },
      triggerRules: ['受伤时优先援护/强攻', '剑意线索出现时优先调查'],
      knownFacts: ['师父死于一道陌生剑意'], resources: [] },
    { id: 'shen', name: '沈青萝', role: 'ai', identity: '药谷弃徒', daoPath: '丹道',
      realm: '炼气七层', roots: { 术: 1, 识: 3, 心: 2 }, luck: 2, karma: 2,
      publicGoal: '寻找炼制筑基丹的关键材料', privateGoal: '验证体内陌生记忆是否与妖王有关',
      personality: ['冷静', '温和', '谨慎', '习惯隐瞒一半真相'],
      actionWeights: { investigate: 4, social: 3, craft: 3, explore: 3, cultivate: 2, travel: 2, battle: 1 },
      triggerRules: ['药草/血液/黑水出现时优先谋取', '妖族信息出现时优先收集或隐瞒'],
      knownFacts: ['体内有一段不属于自己的记忆'], resources: [] },
    { id: 'gu',   name: '顾长风', role: 'ai', identity: '破落顾家少主', daoPath: '阵法',
      realm: '炼气六层', roots: { 术: 1, 识: 3, 心: 2 }, luck: 1, karma: 0,
      publicGoal: '寻找可抵债的秘境遗物', privateGoal: '取回顾家旧阵的核心阵眼',
      personality: ['精明', '务实', '会算账'],
      actionWeights: { investigate: 4, craft: 4, explore: 3, social: 2, travel: 2, cultivate: 2, battle: 1 },
      triggerRules: ['阵法/机关出现时优先行动', '玩家拥有稀缺资源时可能交易或隐瞒'],
      knownFacts: ['顾家旧阵的核心阵眼流入了这座秘境'], resources: [] },
  ];

  // 安置：玩家→城池，韩→荒野，沈→妖域，顾→宗门（不同地点）
  const placement = { lu: '城池', han: '荒野', shen: '妖域', gu: '宗门' };
  return base.map(function (c) {
    const kind = placement[c.id];
    const node = nodes.find(function (n) { return n.kind === kind; }) || nodes[0];
    const a = Game._clone(c);
    a.locationId = node.id;
    a.injury = 0;
    a.status = '正常';
    a.age = rng.int(18, 26);
    a.lifespan = 120 + (Game.realmTier(a.realm) - 1) * 60;
    a.relationshipToPlayer = c.role === 'player' ? null
      : { trust: 1, respect: 1, suspicion: 0, debt: 0 };
    a.combatStats = Game._combatStatsFrom(a);
    a.privateIntent = null;
    a.lastPublicTrace = null;
    return a;
  });
};

/** 由根性/境界派生战斗属性（V2 §6.1） */
Game._combatStatsFrom = function (a) {
  const rb = Game.realmBonus(a.realm);
  return {
    body:   (a.roots.术 || 0) + rb,         // 命元
    spirit: (a.roots.识 || 0) + rb,         // 灵力
    soul:   (a.roots.心 || 0) + rb,         // 神魂
    guard:  Math.floor(rb / 2) + 2,         // 护持
    speed:  (a.roots.识 || 0) + 2,          // 身法
  };
};

Game.nodeById = function (id) {
  return Game.state.map.nodes.find(function (n) { return n.id === id; }) || null;
};

/* ============================================================
 * §2.1 + §2.2 AI 长期计划与路线规划 (actors/agentPlan, pathFinding)
 * ------------------------------------------------------------
 * V2.1：每个 AI 角色拥有 agentPlan（长期目标 + 里程碑 + 紧迫度）。
 *       决策评分加入“接近长期目标 / 沿路线前进 / 停滞惩罚”。
 * ============================================================ */

/** AI 长期目标定义（与角色身份/私愿绑定） */
Game.AGENT_GOALS = {
  han:  { goalId: 'hunt_sword_intent',   targetKinds: ['荒野', '秘境'], milestones: ['寻找剑意线索', '抵达秘境', '查证师父死夜剑意'] },
  shen: { goalId: 'verify_demon_blood',  targetKinds: ['妖域', '秘境'], milestones: ['深入妖域', '采集血脉', '验证妖王记忆'] },
  gu:   { goalId: 'recover_array_core',  targetKinds: ['秘境', '禁地'], milestones: ['寻找顾家阵纹', '抵达秘境', '取得阵眼碎片'] },
};

/** 为 AI 角色初始化长期计划 */
Game._initAgentPlan = function (agent) {
  const def = Game.AGENT_GOALS[agent.id];
  if (!def) { agent.agentPlan = null; return; }
  // 找到首个目标节点
  let target = null;
  for (let i = 0; i < def.targetKinds.length && !target; i++) {
    target = Game.state.map.nodes.find(function (n) { return n.kind === def.targetKinds[i]; });
  }
  agent.agentPlan = {
    goalId: def.goalId,
    targetRegionId: target ? target.id : null,
    targetKinds: def.targetKinds,
    milestones: def.milestones.slice(),
    currentMilestone: 0,
    urgency: 3,
    route: [],
    lastActionTypes: [],
    stalledRounds: 0,
  };
};

/** BFS 寻路：返回节点 id 数组（含起点与终点），不可达返回 null */
Game.findPath = function (startRegionId, targetRegionId) {
  if (!Game.state || startRegionId === targetRegionId) return startRegionId === targetRegionId ? [startRegionId] : null;
  const q = [[startRegionId, [startRegionId]]];
  const seen = {}; seen[startRegionId] = true;
  while (q.length) {
    const pair = q.shift();
    const cur = Game.nodeById(pair[0]);
    if (!cur) continue;
    const path = pair[1];
    if (cur.id === targetRegionId) return path;
    cur.connections.forEach(function (nid) {
      if (!seen[nid]) { seen[nid] = true; q.push([nid, path.concat([nid])]); }
    });
  }
  return null;
};

/** 取下一跳节点 id */
Game.getNextHop = function (path) {
  if (!path || path.length < 2) return null;
  return path[1];
};

/** AI 是否已抵达其长期目标节点 */
Game._atGoal = function (agent) {
  const p = agent.agentPlan;
  if (!p || !p.targetRegionId) return false;
  return agent.locationId === p.targetRegionId;
};

/** 推进里程碑（抵达目标或完成关键行动时调用） */
Game._advanceMilestone = function (agent) {
  const p = agent.agentPlan;
  if (!p) return;
  if (Game._atGoal(agent) && p.currentMilestone < p.milestones.length) {
    p.currentMilestone += 1;
    p.urgency = Math.max(1, p.urgency - 1);
    Game.logEvent('agent.milestone', { actorIds: [agent.id], regionId: agent.locationId,
      text: agent.name + '推进长期目标：「' + p.milestones[p.currentMilestone - 1] + '」达成。', source: 'rule' });
  }
};
Game.actorById = function (id) {
  return Game.state.actors.find(function (a) { return a.id === id; }) || null;
};
Game.factionById = function (id) {
  return Game.state.factions.find(function (f) { return f.id === id; }) || null;
};

/* ============================================================
 * §3.1 玩家与同伴 (actors/player, companions)
 * ============================================================ */

Game.getPlayer = function () { return Game.actorById('lu'); };

/** 取角色私密知识（四层记忆之「角色认知」） */
Game.getKnowledge = function (charId) {
  const a = Game.actorById(charId);
  return a ? a.knownFacts.slice() : [];
};
Game.addKnowledge = function (charId, fact) {
  const a = Game.actorById(charId);
  if (a && a.knownFacts.indexOf(fact) < 0) a.knownFacts.push(fact);
};

/* ============================================================
 * §3.2 AI 同伴决策 (actors/agentDecision)
 * ------------------------------------------------------------
 * 本地决策器：生成候选 → 打分 → 取最高。AI 只能从候选中选择。
 * 未来可由模型润色，但必须经 Zod 风格校验（见 §5）。
 * ============================================================ */

Game.generateCandidates = function (agent) {
  const node = Game.nodeById(agent.locationId);
  const candidates = [];
  const w = agent.actionWeights || {};
  let cid = 0;
  function add(c) { c._id = 'c' + (cid++); candidates.push(c); return c; }

  // 1. 在本节点可做的行动
  Game.AVAILABLE_LOCAL_ACTIONS(node).forEach(function (type) {
    if ((w[type] || 0) <= 0) return;
    add({
      actorId: agent.id, actionType: type, targetId: node.id,
      posture: '争', publicIntent: agent.name + '于「' + node.name + '」' + Game.ACTION_LABEL[type],
      privateIntent: null, _loc: node,
    });
  });
  // 2. 可前往的相邻节点（travel）
  node.connections.forEach(function (nid) {
    const nb = Game.nodeById(nid);
    add({
      actorId: agent.id, actionType: 'travel', targetId: nid,
      posture: '争', publicIntent: agent.name + '前往「' + nb.name + '」',
      privateIntent: null, _loc: nb,
    });
  });
  // 3. 触发规则增补高优先候选
  (agent.triggerRules || []).forEach(function (rule) {
    if (Game._triggerMatchRule(rule, node)) {
      const type = Game._preferredTypeByRule(rule);
      add({
        actorId: agent.id, actionType: type, targetId: node.id,
        posture: '争', publicIntent: '【触发】' + rule,
        privateIntent: agent.privateGoal, triggered: true, _loc: node,
      });
    }
  });
  return candidates;
};

Game.AVAILABLE_LOCAL_ACTIONS = function (node) {
  const acts = ['cultivate', 'investigate', 'social'];
  if (node.resources && node.resources.length) acts.push('craft'), acts.push('explore');
  if (node.encounter && !node.encounter.resolved) acts.push('battle');
  if (node.kind === '城池' || node.kind === '宗门') acts.push('social');
  return Array.from(new Set(acts));
};

Game._triggerMatchRule = function (rule, node) {
  if (!node) return false;
  if (rule.indexOf('阵法') >= 0 || rule.indexOf('机关') >= 0) return node.kind === '禁地' || node.kind === '秘境';
  if (rule.indexOf('剑意') >= 0) return node.kind === '秘境' || node.kind === '荒野';
  if (rule.indexOf('药草') >= 0 || rule.indexOf('血液') >= 0 || rule.indexOf('黑水') >= 0) return node.kind === '妖域' || node.kind === '秘境';
  if (rule.indexOf('妖族') >= 0) return node.kind === '妖域';
  if (rule.indexOf('援护') >= 0 || rule.indexOf('受伤') >= 0) return false;
  return false;
};
Game._preferredTypeByRule = function (rule) {
  if (rule.indexOf('调查') >= 0 || rule.indexOf('剑意') >= 0) return 'investigate';
  if (rule.indexOf('谋取') >= 0 || rule.indexOf('收集') >= 0) return 'explore';
  if (rule.indexOf('阵法') >= 0 || rule.indexOf('机关') >= 0) return 'investigate';
  return 'investigate';
};

Game.scoreCandidate = function (c, agent) {
  let score = agent.actionWeights[c.actionType] || 0;
  // 目标相关度
  const goals = (agent.publicGoal || '') + (agent.privateGoal || '');
  if (c.actionType === 'investigate' && c._loc.kind === '秘境') score += 3;
  if (c.actionType === 'explore' && (goals.indexOf('材料') >= 0 || goals.indexOf('遗物') >= 0)) score += 3;
  if (c.actionType === 'battle' && goals.indexOf('剑经') >= 0) score += 2;
  if (c.actionType === 'craft' && agent.daoPath === '丹道') score += 2;
  if (c.triggered) score += 4;
  // 风险规避：伤势越高越避战
  if (c.actionType === 'battle') score -= (agent.injury || 0) * 2;
  // 高危禁地谨慎
  if (c._loc && c._loc.danger >= 4 && c.actionType !== 'travel') score -= 2;
  // 关系压力：疑虑高时倾向隐瞒（investigate/explore）
  if (agent.relationshipToPlayer && agent.relationshipToPlayer.suspicion >= 2 &&
      (c.actionType === 'investigate' || c.actionType === 'explore')) score += 1;

  // —— V2.1 §2.2 长期目标与路线规划评分 ——
  const p = agent.agentPlan;
  if (p && p.targetRegionId) {
    // 抵达目标节点：优先做调查/争夺/谈判/战斗
    if (Game._atGoal(agent)) {
      if (['investigate', 'explore', 'battle'].indexOf(c.actionType) >= 0) score += 4;
    } else if (c.actionType === 'travel') {
      // 沿路线前进：下一跳是否在 BFS 路径上
      const path = Game.findPath(agent.locationId, p.targetRegionId);
      const nextHop = Game.getNextHop(path);
      if (nextHop && c.targetId === nextHop) {
        score += 3;                                   // 沿路线前进 +3
        score += p.urgency;                           // 紧迫度加成
      } else if (nextHop && c.targetId !== nextHop) {
        score -= 1;                                   // 偏离路线
      }
      // 越接近目标（路径变短）越受青睐
      if (path && path.length) score += Math.max(0, 3 - Math.floor(path.length / 2));
    }
    // 连续同类行动惩罚 -2
    if (p.lastActionTypes && p.lastActionTypes.length >= 2 &&
        p.lastActionTypes[p.lastActionTypes.length - 1] === c.actionType &&
        p.lastActionTypes[p.lastActionTypes.length - 2] === c.actionType) {
      score -= 2;
    }
    // 连续三回合未推进里程碑 -4
    if (p.stalledRounds >= 3 && c.actionType !== 'travel' && !Game._atGoal(agent)) score -= 4;
  }
  c.score = score;
  return score;
};

/** AI 决策主入口。返回结构化 Intent（含 publicIntent / privateIntent）。 */
Game.decideAgentAction = function (agent) {
  const agentRng = Game.rngFor('agent');
  const candidates = Game.generateCandidates(agent);
  if (!candidates.length) {
    return { actorId: agent.id, actionType: 'cultivate', targetId: agent.locationId, posture: '稳',
      publicIntent: agent.name + '就地闭关调息。', privateIntent: null };
  }
  candidates.forEach(function (c) { Game.scoreCandidate(c, agent); });
  candidates.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  let best = candidates[0];
  // V2.1 §2.2：不应连续两回合留在同一地点做同类行动（闭关/疗伤/经营/事件锁定除外）
  const p = agent.agentPlan;
  const allowStay = (['cultivate', 'craft', 'social'].indexOf(best.actionType) >= 0);
  if (p && p.lastActionTypes && p.lastActionTypes.length &&
      p.lastActionTypes[p.lastActionTypes.length - 1] === best.actionType &&
      best.actionType === 'travel' && best.targetId === agent.locationId) {
    // 不允许“原地 travel”，换次优
    best = candidates[1] || best;
  }
  if (p && !allowStay && p.lastActionTypes && p.lastActionTypes.length >= 2 &&
      p.lastActionTypes[p.lastActionTypes.length - 1] === best.actionType &&
      p.lastActionTypes[p.lastActionTypes.length - 2] === best.actionType &&
      best.targetId === agent.locationId) {
    // 连续两回合原地同类，强制换 travel 候选（若有）
    const travelAlt = candidates.find(function (c) { return c.actionType === 'travel'; });
    if (travelAlt) best = travelAlt;
  }
  // 私密行动：部分 investigate/explore/craft 带 privateIntent
  let privateIntent = null;
  if (best.actionType === 'investigate' || best.actionType === 'explore' || best.actionType === 'craft') {
    if (agentRng.chance(0.6)) privateIntent = agent.privateGoal;
  }
  // 记录行动类型用于停滞判定
  if (p) {
    p.lastActionTypes.push(best.actionType);
    if (p.lastActionTypes.length > 4) p.lastActionTypes.shift();
    // 是否推进：travel 沿路线 或 抵达目标做调查
    const advanced = (best.actionType === 'travel') ||
      (Game._atGoal(agent) && ['investigate', 'explore', 'battle'].indexOf(best.actionType) >= 0);
    if (advanced) p.stalledRounds = 0; else p.stalledRounds += 1;
  }
  return {
    actorId: agent.id, actionType: best.actionType, targetId: best.targetId, posture: best.posture,
    publicIntent: best.publicIntent, privateIntent: privateIntent,
  };
};

/* ============================================================
 * §4.1 行动结算 (rules/actionResolver)
 * ------------------------------------------------------------
 * 玩家 + 三名 AI 同时提交 Intent；统一结算。
 * 行动值 = 2D6 + 对应根性 + 境界加值 + 道途契合 + 地形 + 援助
 * ============================================================ */

Game.calcActionValue = function (intent, actor) {
  const rng = Game.rngFor('action');
  const dice = rng.rollDice(2);
  const diceSum = dice[0] + dice[1];
  const rootKey = Game.ACTION_ROOT[intent.actionType] || '心';
  const rootVal = actor.roots[rootKey] || 0;
  const realm = Game.realmBonus(actor.realm);
  const dao = (Game.DAO_MATCH[actor.daoPath] || {})[intent.actionType] || 0;
  const node = Game.nodeById(intent.actionType === 'travel' ? intent.targetId : actor.locationId);
  let terrain = 0;
  if (node) {
    if (intent.actionType === 'cultivate') terrain = node.kind === '宗门' ? 2 : 0;
    if (intent.actionType === 'investigate') terrain = (node.kind === '禁地' || node.kind === '秘境') ? 2 : 1;
    if (intent.actionType === 'explore') terrain = node.resources.length ? 2 : 1;
    if (intent.actionType === 'craft') terrain = node.kind === '城池' ? 2 : 1;
  }
  const aid = intent.aid || 0;
  const obstacle = intent.obstacle || 0;
  const value = diceSum + rootVal + realm + dao + terrain + aid - obstacle;
  return { dice: dice, value: value, breakdown: { 骰点: diceSum, 根性: rootVal, 境界: realm, 道途契合: dao, 地形: terrain, 援助: aid, 阻碍: obstacle } };
};

Game.judgeGrade = function (value, threshold) {
  const diff = value - threshold;
  if (diff >= Game.GRADES['大成'].offset) return '大成';
  if (diff >= Game.GRADES['成功'].offset) return '成功';
  if (diff >= Game.GRADES['勉成有价'].offset) return '勉成有价';
  return '失势留痕';
};

/** V2.1 §0.2 状态机校验。非法调用返回 {ok:false,reason} */
Game.requirePhase = function (allowed) {
  if (!Game.state) return { ok: false, reason: '尚未开启世界' };
  const ph = Game.state.meta.phase;
  if (allowed.indexOf(ph) < 0) return { ok: false, reason: '当前阶段（' + ph + '）不可执行此操作' };
  return { ok: true };
};

/** 提交玩家行动（intent 阶段） */
Game.submitPlayerIntent = function (intent) {
  const guard = Game.requirePhase(['intent']);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  const lu = Game.getPlayer();
  if (!lu) return { ok: false, reason: '无玩家角色' };
  Game.state.currentRound.intents = [];
  Game.state.currentRound.intents.push(Object.assign({ actorId: 'lu' }, intent));
  Game.logEvent('round.intent', { actorIds: ['lu'], regionId: lu.locationId,
    text: '陆知微意图：' + (intent.publicIntent || (Game.ACTION_LABEL[intent.actionType] + ' → ' + (Game.nodeById(intent.targetId)||{}).name)),
    source: 'rule' });
  return { ok: true };
};

/** 收集 AI 行动并入列（在玩家提交后调用） */
Game.collectAIIntents = function () {
  const state = Game.state;
  if (!state.actors.some(function (a) { return a.role === 'player'; })) {
    return { ok: false, reason: '需先提交玩家意图' };
  }
  const ais = state.actors.filter(function (a) { return a.role === 'ai'; });
  ais.forEach(function (agent) {
    const intent = Game.decideAgentAction(agent);
    state.currentRound.intents.push(intent);
    // 私密行动只记痕迹，不直接公开真相
    if (intent.privateIntent) {
      Game.logEvent('round.intent.private', { actorIds: [agent.id], regionId: agent.locationId,
        text: agent.name + '有所动作，但意图不明。', source: 'rule' });
    } else {
      Game.logEvent('round.intent', { actorIds: [agent.id], regionId: agent.locationId,
        text: agent.name + '意图：' + intent.publicIntent, source: 'rule' });
    }
  });
  return { ok: true };
};

/** 解算本回合所有 Intent（resolve 阶段）。成功返回结果数组，校验失败返回含 error 项的数组。 */
Game.resolveRound = function () {
  const state = Game.state;
  // V2.1 §0.2：需四人意图收集完整（玩家 + 3 AI）
  if (state.currentRound.intents.length < state.actors.length) {
    Game.lastError = { ok: false, reason: '四人意图尚未收集完整（当前 ' + state.currentRound.intents.length + '/' + state.actors.length + '）' };
    return [{ type: 'error', ok: false, reason: Game.lastError.reason, text: Game.lastError.reason }];
  }
  const intents = state.currentRound.intents;
  const results = [];

  intents.forEach(function (intent) {
    const actor = Game.actorById(intent.actorId);
    if (!actor) return;
    const res = Game._resolveIntent(intent, actor);
    results.push(res);
  });

  // 合流 / 相遇检测
  const encounters = Game._detectConvergence(intents, results);
  if (encounters.length) {
    encounters.forEach(function (e) { results.push(e); });
  }

  state.currentRound.results = results;
  state.currentRound.encounter = encounters.find(function (e) { return e.kind === 'combat'; }) || null;

  // 第一场战斗胜利或第一次结算后授予天书残页（重大事件）
  const won = results.some(function (r) { return r.type === 'combat' && r.outcome === '胜'; });
  if (won && state.inventory.heavenlyPages === 0) {
    state.inventory.heavenlyPages += 1;
    Game.logEvent('item.heavenly', { actorIds: ['lu'], text: '于危局之中，陆知微得一页「天书残页」，可批注改写世界。', source: 'rule' });
  }

  // 推进危机钟（以灵气潮汐表示）
  Game._advanceSpiritualClimate();

  // 生成叙事
  Game.generateNarration();

  // 阶段推进到 narrate → time
  state.meta.phase = 'time';
  return results;
};

/** 解算单个 Intent */
Game._resolveIntent = function (intent, actor) {
  const type = intent.actionType;
  if (type === 'travel') return Game._resolveTravel(intent, actor);
  if (type === 'cultivate') return Game._resolveCultivate(intent, actor);
  if (type === 'explore') return Game._resolveExplore(intent, actor);
  if (type === 'investigate') return Game._resolveInvestigate(intent, actor);
  if (type === 'social') return Game._resolveSocial(intent, actor);
  if (type === 'craft') return Game._resolveCraft(intent, actor);
  if (type === 'battle') return Game._resolveBattleIntent(intent, actor);
  return { actorId: actor.id, type: 'noop', grade: '失势留痕', text: '未知行动。' };
};

Game._resolveTravel = function (intent, actor) {
  const dest = Game.nodeById(intent.targetId);
  const from = Game.nodeById(actor.locationId);
  if (!dest || !from || from.connections.indexOf(dest.id) < 0) {
    return { actorId: actor.id, type: 'travel', grade: '失势留痕', text: actor.name + '无路可往，原地未动。', from: from.id, to: actor.locationId };
  }
  actor.locationId = dest.id;
  // 危险路线可能受伤
  let injury = 0;
  if (dest.danger >= 3 && Game.rngFor('action').chance(0.25)) injury = 1;
  if (injury) actor.injury += injury;
  Game.logEvent('actor.travel', { actorIds: [actor.id], regionId: dest.id,
    text: actor.name + '由「' + from.name + '」行至「' + dest.name + '」。' + (injury ? '途遇凶险，受了轻伤。' : ''),
    source: 'rule' });
  return { actorId: actor.id, type: 'travel', grade: injury ? '勉成有价' : '成功',
    from: from.id, to: dest.id, injury: injury,
    text: actor.name + '行至「' + dest.name + '」。' + (injury ? '途遇凶险，受了轻伤。' : '') };
};

Game._resolveCultivate = function (intent, actor) {
  const node = Game.nodeById(actor.locationId);
  const climate = Game.state.world.spiritualClimate;
  const av = Game.calcActionValue(intent, actor);
  const threshold = 10 + (intent.posture === '逆' ? 2 : 0) + (intent.posture === '稳' ? -1 : 0) - climate;
  const grade = Game.judgeGrade(av.value, threshold);
  let progress = 0, insight = '';
  if (grade === '大成') { progress = 3; insight = '顿悟连连，道心通明。'; }
  else if (grade === '成功') { progress = 2; insight = '气机顺畅，修为精进。'; }
  else if (grade === '勉成有价') { progress = 1; insight = '有所得，亦有所耗。'; actor.injury = Math.max(actor.injury, 1); }
  else { progress = 0; insight = '走火入魔之兆，徒劳无功。'; actor.injury += 1; }
  actor.cultivationProgress = (actor.cultivationProgress || 0) + progress;
  Game.logEvent('actor.cultivate', { actorIds: [actor.id], regionId: node.id,
    text: actor.name + '于「' + node.name + '」闭关。' + insight, source: 'rule' });
  return { actorId: actor.id, type: 'cultivate', grade: grade, value: av.value, threshold: threshold,
    breakdown: av.breakdown, dice: av.dice, progress: progress, text: insight };
};

Game._resolveExplore = function (intent, actor) {
  const node = Game.nodeById(actor.locationId);
  const av = Game.calcActionValue(intent, actor);
  const threshold = 9 + node.danger;
  const grade = Game.judgeGrade(av.value, threshold);
  const rewards = [];
  let text = '';
  if (grade === '大成' || grade === '成功') {
    const loot = node.resources.length ? Game.rngFor('action').pick(node.resources) : '线索';
    if (actor.resources.indexOf(loot) < 0) actor.resources.push(loot);
    rewards.push(loot);
    const rumor = node.rumors[0] || ('「' + node.name + '」藏有古秘。');
    text = actor.name + '于「' + node.name + '」探得「' + loot + '」，并听闻：' + rumor;
    Game.addKnowledge(actor.id, '于「' + node.name + '」得「' + loot + '」');
  } else if (grade === '勉成有价') {
    text = actor.name + '于「' + node.name + '」险中探查，仅得只言片语。';
    actor.injury += 1;
    Game.addKnowledge(actor.id, '「' + node.name + '」似有古怪');
  } else {
    text = actor.name + '于「' + node.name + '」一无所获，反受惊扰。';
    actor.injury += 1;
  }
  Game.logEvent('actor.explore', { actorIds: [actor.id], regionId: node.id, text: text, source: 'rule' });
  return { actorId: actor.id, type: 'explore', grade: grade, value: av.value, threshold: threshold,
    breakdown: av.breakdown, dice: av.dice, rewards: rewards, text: text };
};

Game._resolveInvestigate = function (intent, actor) {
  const node = Game.nodeById(actor.locationId);
  const av = Game.calcActionValue(intent, actor);
  const threshold = 10 + node.danger;
  const grade = Game.judgeGrade(av.value, threshold);
  let fact = '';
  if (grade === '大成' || grade === '成功') {
    fact = Game._investigateFact(node, actor);
    Game.addKnowledge(actor.id, fact);
  } else if (grade === '勉成有价') {
    fact = '「' + node.name + '」隐有古怪，但证据不足。';
    actor.injury += 1;
  } else {
    fact = '查无所获，反引人注意。';
    actor.injury += 1;
  }
  const isPrivate = !!intent.privateIntent;
  const text = isPrivate
    ? actor.name + '暗中查究「' + node.name + '」，留有痕迹。'
    : actor.name + '于「' + node.name + '」查究：' + fact;
  actor.lastPublicTrace = isPrivate ? Game._privateTrace(node, actor) : null;
  Game.logEvent(isPrivate ? 'actor.investigate.private' : 'actor.investigate',
    { actorIds: [actor.id], regionId: node.id, text: text, source: 'rule' });
  return { actorId: actor.id, type: 'investigate', grade: grade, value: av.value, threshold: threshold,
    breakdown: av.breakdown, dice: av.dice, privateIntent: isPrivate, fact: isPrivate ? null : fact,
    publicTrace: actor.lastPublicTrace, text: text };
};

Game._investigateFact = function (node, actor) {
  const facts = {
    '秘境': ['秘境封印之物与妖王有关', '阵眼碎片带顾家印记', '剑经残卷藏剑灵残篇'],
    '禁地': ['禁地裂隙通向更深处的禁制', '禁地阵纹已现裂痕'],
    '妖域': ['妖域妖兽受妖王血脉驱使', '妖王心跳与黑水倒流同源'],
    '荒野': ['古道剑鸣来自一柄残剑', '荒野阵纹残迹指向顾家旧阵'],
    '宗门': ['宗门近期弟子失踪与秘境试炼有关', '宗门藏有剑经拓本'],
    '城池': ['城中邪修与境外势力勾结', '边城商队劫案系人为'],
    '海域': ['蜃楼海幻象下藏有古宝', '海域沉船与古修遗物有关'],
  };
  const pool = facts[node.kind] || ['「' + node.name + '」藏有未解之谜。'];
  return Game.rngFor('action').pick(pool);
};

Game._privateTrace = function (node, actor) {
  const traces = {
    '秘境': '「' + node.name + '」似有人逗留过久。',
    '禁地': '「' + node.name + '」禁制被人触动过。',
    '妖域': '「' + node.name + '」出现了不该出现的妖族药材。',
    '荒野': '「' + node.name + '」传来剑鸣。',
    '宗门': '「' + node.name + '」藏经阁外有异动。',
    '城池': '「' + node.name + '」暗处有人接头。',
    '海域': '「' + node.name + '」海面浮起不寻常的残骸。',
  };
  return traces[node.kind] || ('「' + node.name + '」有异动。');
};

Game._resolveSocial = function (intent, actor) {
  const node = Game.nodeById(actor.locationId);
  const av = Game.calcActionValue(intent, actor);
  const threshold = 9;
  const grade = Game.judgeGrade(av.value, threshold);
  let text = '';
  if (actor.relationshipToPlayer) {
    if (grade === '大成' || grade === '成功') { actor.relationshipToPlayer.trust += 1; text = actor.name + '与人结善，与陆知微关系转暖。'; }
    else if (grade === '勉成有价') { text = actor.name + '应酬一场，略有收获。'; }
    else { actor.relationshipToPlayer.suspicion += 1; text = actor.name + '言行失当，引人疑虑。'; }
  } else {
    text = '陆知微广结善缘，得一二消息。';
    if (grade === '大成' || grade === '成功') Game.addKnowledge('lu', '于「' + node.name + '」结交线人，得一条传闻。');
  }
  Game.logEvent('actor.social', { actorIds: [actor.id], regionId: node.id, text: text, source: 'rule' });
  return { actorId: actor.id, type: 'social', grade: grade, value: av.value, threshold: threshold,
    breakdown: av.breakdown, dice: av.dice, text: text };
};

Game._resolveCraft = function (intent, actor) {
  const node = Game.nodeById(actor.locationId);
  const av = Game.calcActionValue(intent, actor);
  const threshold = 11;
  const grade = Game.judgeGrade(av.value, threshold);
  let text = '';
  if (grade === '大成' || grade === '成功') {
    const item = actor.daoPath === '丹道' ? '一炉筑基丹（残）' : (actor.daoPath === '阵法' ? '一面顾家阵盘' : '一柄飞剑饰件');
    actor.resources.push(item);
    text = actor.name + '炼成「' + item + '」。';
  } else if (grade === '勉成有价') {
    text = actor.name + '炼制半成，材料有损。';
  } else {
    text = actor.name + '炼制失败，炉鼎倾覆。';
    actor.injury += 1;
  }
  Game.logEvent('actor.craft', { actorIds: [actor.id], regionId: node.id, text: text, source: 'rule' });
  return { actorId: actor.id, type: 'craft', grade: grade, value: av.value, threshold: threshold,
    breakdown: av.breakdown, dice: av.dice, text: text };
};

Game._resolveBattleIntent = function (intent, actor) {
  // 玩家或 AI 主动发起战斗 → 进入危局战斗
  return Game.runCombat(actor, intent.targetId, intent.posture);
};

/* ============================================================
 * §4.2 合流 / 相遇检测 (rules/conflictResolver)
 * ============================================================ */

Game._detectConvergence = function (intents, results) {
  const out = [];
  const state = Game.state;
  // 同地点多人
  const byLoc = {};
  state.actors.forEach(function (a) {
    (byLoc[a.locationId] = byLoc[a.locationId] || []).push(a.id);
  });
  Object.keys(byLoc).forEach(function (loc) {
    if (byLoc[loc].length > 1) {
      out.push({ type: 'encounter', kind: 'meeting', regionId: loc, actorIds: byLoc[loc],
        text: byLoc[loc].map(function (id) { return Game.actorById(id).name; }).join('、') + '于「' + Game.nodeById(loc).name + '」相遇。' });
    }
  });
  // 同目标争抢（同节点同类型 explore/craft）
  const grouped = {};
  results.forEach(function (r) {
    if (r.type === 'explore' || r.type === 'craft') {
      const k = r.type + '|' + (Game.actorById(r.actorId) || {}).locationId;
      (grouped[k] = grouped[k] || []).push(r);
    }
  });
  Object.keys(grouped).forEach(function (k) {
    const list = grouped[k];
    if (list.length > 1) {
      out.push({ type: 'encounter', kind: 'contest', actorIds: list.map(function (r) { return r.actorId; }),
        text: list.map(function (r) { return Game.actorById(r.actorId).name; }).join('与') + '争夺同一机缘，各有得失。' });
    }
  });
  // 玩家在秘境/禁地触发怪物遭遇 → 已在 battle/explore 中处理；此处补「探索触发遭遇」
  const lu = Game.getPlayer();
  const luNode = Game.nodeById(lu.locationId);
  if (luNode && luNode.encounter && !luNode.encounter.resolved) {
    const trig = results.find(function (r) { return r.actorId === 'lu' && (r.type === 'explore' || r.type === 'investigate' || r.type === 'battle'); });
    if (trig) {
      const combat = Game.runCombat(lu, luNode.id, '争');
      out.push(Object.assign({ type: 'encounter', kind: 'combat', regionId: luNode.id, actorIds: ['lu'] }, combat));
    }
  }
  out.forEach(function (e) {
    Game.logEvent('encounter', { actorIds: e.actorIds, regionId: e.regionId, text: e.text || e.outcomeText || '', source: 'rule' });
  });
  return out;
};

/* ============================================================
 * §4.3 危局战斗 (rules/combatResolver)
 * ------------------------------------------------------------
 * 2-3 轮「危局冲突」：行动值 vs 防御值 → 压制/命中/僵持/失手/溃败
 * ============================================================ */

Game.runCombat = function (actor, nodeId, posture) {
  const node = Game.nodeById(nodeId) || Game.nodeById(actor.locationId);
  if (!node.encounter) {
    return { actorId: actor.id, type: 'combat', outcome: '无事', text: '「' + node.name + '」并无凶险。' };
  }
  const enc = node.encounter;
  const monster = Game.MONSTERS.find(function (m) { return m.id === enc.monsterId; }) || Game.MONSTERS[0];
  const rng = Game.rngFor('action');
  posture = posture || '争';
  const rounds = 2 + (rng.chance(0.5) ? 1 : 0);
  const log = [];
  // V2.1 §4.1：使用持久化的遭遇状态，不再每次重置满血
  let mVit = enc.vitality;
  let mGuard = enc.guard;
  // V2.1 §4.3：命元取自持久化 combatStats，回合结束不重置
  let aBody = (actor.combatStats && actor.combatStats.body) || Game._combatStatsFrom(actor).body;
  const realmDiff = Game.realmBonus(actor.realm) - monster.realmTier * 4;
  // 束缚状态降低怪物护持
  const bound = (enc.statuses || []).indexOf('束缚') >= 0;
  if (bound) mGuard = Math.max(0, mGuard - 3);

  let totalTag = '僵持';
  for (let i = 0; i < rounds; i++) {
    const av = Game.calcActionValue({ actionType: 'battle', posture: posture }, actor);
    const atk = av.value + realmDiff + (posture === '逆' ? 4 : 0);
    const def = mGuard + (i === 0 ? 0 : 2);
    const diff = atk - def;
    let tag;
    if (diff >= 5) { tag = '压制'; mVit -= 6 + Game.realmTier(actor.realm); }
    else if (diff >= 1) { tag = '命中'; mVit -= 3 + Game.realmTier(actor.realm); }
    else if (diff >= -2) { tag = '僵持'; mVit -= 1; aBody -= 2; }
    else if (diff >= -6) { tag = '失手'; aBody -= 3; }
    else { tag = '溃败'; aBody -= 5; }
    log.push('第' + (i + 1) + '轮：' + tag + '（攻' + atk + ' / 守' + def + '）');
    if (mVit <= 0) { totalTag = '压制'; break; }
    if (aBody <= 0) { totalTag = '溃败'; break; }
    if (i === rounds - 1) totalTag = (mVit <= enc.maxVitality / 2) ? (aBody > 0 ? '命中' : '僵持') : '僵持';
  }

  // V2.1 §4.1/§4.3：写回持久化状态（怪物血量与角色命元均跨回合保留）
  enc.vitality = Math.max(0, mVit);
  enc.guard = mGuard;
  if (actor.combatStats) {
    actor.combatStats.body = Math.max(0, aBody);     // 命元不重置
    actor.combatStats.spirit = actor.combatStats.spirit; // 灵力/神魂亦持久
  }

  let outcome, text, costs = {}, rewards = [];
  if (mVit <= 0 && aBody > 0) {
    outcome = '胜';
    enc.resolved = true;
    monster.loot.forEach(function (l) { if (actor.resources.indexOf(l) < 0) actor.resources.push(l); rewards.push(l); });
    Game.addKnowledge(actor.id, '击退「' + monster.name + '」，知其弱点：' + monster.weakness);
    if (actor.injury > 0) { outcome = '惨胜'; actor.injury += 1; costs.injury = 1; }
    text = actor.name + '于「' + node.name + '」与「' + monster.name + '」交锋' + rounds + '轮，' + log.join('；') + '。终斩其锋，得「' + rewards.join('、') + '」。';
  } else if (aBody <= 0) {
    outcome = '溃';
    actor.injury += 3;
    costs.injury = 3;
    if (actor.resources.length > 1 && rng.chance(0.5)) {
      const lost = actor.resources.splice(actor.resources.length - 1, 1)[0];
      costs.lostItem = lost;
    }
    text = actor.name + '于「' + node.name + '」不敌「' + monster.name + '」，' + log.join('；') + '。重伤溃退' + (costs.lostItem ? '，失却「' + costs.lostItem + '」' : '') + '。';
  } else {
    outcome = '僵持';
    actor.injury += 1;
    costs.injury = 1;
    text = actor.name + '于「' + node.name + '」与「' + monster.name + '」相持不下，' + log.join('；') + '。可逃、可借势、可谈判——「' + monster.nonCombat + '」。';
  }
  Game.logEvent('combat', { actorIds: [actor.id], regionId: node.id, text: text, source: 'rule' });
  return { actorId: actor.id, type: 'combat', outcome: outcome, monster: monster.name, rounds: rounds,
    rewards: rewards, costs: costs, text: text, outcomeText: text,
    monsterVitality: enc.vitality, monsterMaxVitality: enc.maxVitality };
};

/**
 * V2.1 §4.2 非战斗遭遇行动。改变持久化遭遇状态而非直接战斗。
 *   借弱点   — 降低怪物护持（guard），便于后续战斗
 *   布阵困敌 — 增加「束缚」状态，降低怪物护持与行动
 *   以物换路 — 消耗一件物品换取通过，怪物保留
 *   结缘谈判 — 降低敌意，但生成契约/因果钩子
 *   撤退逃遁 — 保留怪物状态（不 resolved），增加追踪风险
 */
Game.resolveEncounterAction = function (actorId, action, opts) {
  const actor = Game.actorById(actorId);
  if (!actor) return { ok: false, reason: '无此角色' };
  const node = Game.nodeById(actor.locationId);
  if (!node || !node.encounter || node.encounter.resolved) {
    return { ok: false, reason: '此处无可应对的凶险' };
  }
  const enc = node.encounter;
  const monster = Game.MONSTERS.find(function (m) { return m.id === enc.monsterId; }) || Game.MONSTERS[0];
  const rng = Game.rngFor('action');
  const av = Game.calcActionValue({ actionType: 'investigate', posture: (opts && opts.posture) || '争' }, actor);
  let text = '', effects = {};

  if (action === '借弱点') {
    const grade = Game.judgeGrade(av.value, 9 + (enc.guard || 0));
    if (grade === '大成' || grade === '成功') {
      enc.guard = Math.max(0, (enc.guard || 0) - 3);
      text = actor.name + '窥破「' + monster.name + '」弱点「' + monster.weakness + '」，其护持大降。';
      effects.guardReduced = 3;
    } else {
      text = actor.name + '试图窥破弱点未果，反被其势所慑。';
      actor.injury += 1;
    }
  } else if (action === '布阵困敌') {
    const grade = Game.judgeGrade(av.value, 10 + (enc.guard || 0));
    if (grade !== '失势留痕') {
      if ((enc.statuses || []).indexOf('束缚') < 0) enc.statuses.push('束缚');
      enc.guard = Math.max(0, (enc.guard || 0) - 2);
      text = actor.name + '布下阵法困住「' + monster.name + '」，其行动受限。';
      effects.bound = true;
    } else {
      text = actor.name + '布阵未成，反耗心神。';
      actor.injury += 1;
    }
  } else if (action === '以物换路') {
    if (!actor.resources.length) return { ok: false, reason: '无物可舍' };
    const offer = actor.resources.pop();
    enc.hostility = Math.max(0, (enc.hostility || 0) - 1);
    text = actor.name + '舍去「' + offer + '」换取通过，「' + monster.name + '」让出一条路。';
    effects.lostItem = offer;
    // 怪物仍存在，未 resolved
  } else if (action === '结缘谈判') {
    const grade = Game.judgeGrade(av.value, 11);
    if (grade === '大成' || grade === '成功') {
      enc.hostility = Math.max(0, (enc.hostility || 0) - 2);
      // V2.1 §1.2 契约具现：承诺转化为契约钩子
      const law = Game.getLawEffect();
      if (law && law.onPromise) law.onPromise(actor, monster.name, '不侵之约');
      else Game.addHook({ name: '约定·' + monster.name, owner: actor.name, intensity: 1, trigger: ['违约'], reward: '相安', risk: '反噬' });
      text = actor.name + '与「' + monster.name + '」立约，敌意大减，然因果已结。';
      effects.pact = true;
    } else {
      text = actor.name + '试图谈判未果，「' + monster.name + '」不为所动。';
    }
  } else if (action === '撤退逃遁') {
    // 撤退：怪物保留（不 resolved），增加追踪风险
    enc.escaped = true;
    enc.hostility = Math.min(3, (enc.hostility || 0) + 1);
    text = actor.name + '从「' + monster.name + '」前撤退脱身，怪物仍在「' + node.name + '」盘踞，或记仇追踪。';
    effects.escaped = true;
    if (rng.chance(0.4)) {
      actor.injury += 1;
      text += '撤退仓促，受了些轻伤。';
    }
  } else {
    return { ok: false, reason: '未知遭遇行动：' + action };
  }
  Game.logEvent('encounter.action', { actorIds: [actorId], regionId: node.id, text: text, source: 'rule' });
  return { ok: true, action: action, actorId: actorId, regionId: node.id, text: text,
    effects: effects, monsterVitality: enc.vitality, monsterMaxVitality: enc.maxVitality,
    encounterResolved: enc.resolved };
};

/* ============================================================
 * §4.4 时间推进 (rules/timeAdvanceResolver)
 * ------------------------------------------------------------
 * 岁月议决：玩家选尺度，AI 投票；满足条件则推进。
 * 推进后运行 advanceRegions/Factions/Actors/Rumors/Hooks/SpiritualClimate
 * ============================================================ */

Game.canAdvanceTime = function (jump) {
  const state = Game.state;
  // 危局战斗在本引擎内一回合内完结（2-3 轮危局），回合间不存在“进行中”的战斗锁。
  // 仅在角色重伤时限制超长跳跃（V2 §5.1：角色未被囚禁/重伤/心魔缠身）。
  const hurt = state.actors.find(function (a) { return a.injury >= 3 && a.status !== '陨落'; });
  if (hurt && (jump === '百年' || jump === '千年')) return { ok: false, reason: hurt.name + '伤重，难以承受漫长岁月。' };
  return { ok: true };
};

/** AI 投票：依据目标对时间跳跃的态度 */
Game.castVotes = function (jump) {
  const state = Game.state;
  const rng = Game.rngFor('time');
  const votes = {};
  state.actors.filter(function (a) { return a.role === 'ai'; }).forEach(function (a) {
    let agree = true;
    if (jump === '百年' || jump === '千年') {
      // 执念深者不愿跳跃
      if (a.knownFacts.join('').indexOf('剑意') >= 0 || a.privateGoal.indexOf('查') >= 0) agree = rng.chance(0.4);
    }
    if (jump === '一年' || jump === '十年') agree = rng.chance(0.85);
    votes[a.id] = agree ? '赞成' : '反对';
  });
  state.currentRound.votes = votes;
  return votes;
};

/** 推进时间，结算世界 */
Game.advanceTime = function (jump) {
  const state = Game.state;
  // V2.1 §0.2：只能在 time 阶段推进
  const guard = Game.requirePhase(['time']);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  const check = Game.canAdvanceTime(jump);
  if (!check.ok) return { ok: false, reason: check.reason };

  const votes = Object.keys(state.currentRound.votes).length
    ? state.currentRound.votes
    : Game.castVotes(jump);
  const agreeCount = Object.keys(votes).filter(function (k) { return votes[k] === '赞成'; }).length;
  const totalAI = Object.keys(votes).length;
  // 多数赞成 或 玩家强行推进（当下/一月总允许；长跳需多数或玩家坚持）
  const forcePlayer = (jump === '当下' || jump === '一月');
  if (!forcePlayer && agreeCount < Math.ceil(totalAI / 2)) {
    return { ok: false, reason: '同行者多不赞同，岁月议决未通过。', votes: votes };
  }

  const years = Game.TIME_JUMP_YEARS[jump] || 0;
  state.meta.year += Math.floor(years);
  if (years > 0) state.meta.round = 1;

  const summary = { jump: jump, years: years, changes: [] };

  if (years > 0) {
    Game._advanceRegions(years, summary);
    Game._advanceFactions(years, summary);
    Game._advanceActors(years, summary);
    Game._advanceRumors(years, summary);
    Game._advanceHooks(years, summary);
    Game._advanceSpiritualClimateSettle(years, summary);
    // V2.1 §1.2 天道法则 onTimeAdvance
    const law = Game.getLawEffect();
    if (law && law.onTimeAdvance) law.onTimeAdvance(years, summary);
    // V2.1 §3.1 长期计划推进
    Game._advanceLongTermPlans(years, summary);
    Game._chronicleFromSummary(summary);
  }

  // 进入下一回合
  state.meta.round += 1;
  state.meta.phase = 'intent';
  state.currentRound = { intents: [], results: [], encounter: null, narration: null, timeJump: jump, votes: votes };
  Game.logEvent('time.advance', { text: '岁月议决通过，推进「' + jump + '」（约' + (years || 0) + '年）。' + summary.changes.length + '项世界变化。', source: 'rule' });

  // 百年/千年 → 生成世界遗产，可封卷
  if (jump === '百年' || jump === '千年') {
    state.finalLegacy = Game.generateLegacy();
  }
  // 首次重大时间跳跃（≥十年）授予天书残页（V2 §9：重大事件中获得）
  if (years >= 10 && state.inventory.heavenlyPages === 0) {
    state.inventory.heavenlyPages += 1;
    Game.logEvent('item.heavenly', { actorIds: ['lu'], text: '岁月激荡，陆知微于一桩变故中得一页「天书残页」，可批注改写世界。', source: 'rule' });
  }
  return { ok: true, summary: summary, votes: votes, legacy: state.finalLegacy };
};

Game._advanceRegions = function (years, summary) {
  const rng = Game.rngFor('time');
  Game.state.map.nodes.forEach(function (n) {
    if (rng.chance(Math.min(0.6, 0.1 * years / 10 + 0.1))) {
      n.danger = Math.max(1, Math.min(5, n.danger + (rng.chance(0.5) ? 1 : -1)));
      summary.changes.push('「' + n.name + '」凶险程度变为' + n.danger + '。');
    }
    if (rng.chance(0.15) && n.resources.length) {
      const res = n.resources.pop();
      summary.changes.push('「' + n.name + '」的「' + res + '」枯竭。');
    }
    if (rng.chance(0.1)) {
      n.rumors.push(rng.pick(Game.REGION_RUMORS[n.kind]));
    }
  });
};

Game._advanceFactions = function (years, summary) {
  const rng = Game.rngFor('time');
  Game.state.factions.forEach(function (f) {
    const delta = rng.int(-3, 5) * Math.max(1, Math.floor(years / 10));
    f.power = Math.max(10, Math.min(100, f.power + delta));
    if (delta !== 0) summary.changes.push('势力「' + f.name + '」势力的盛衰指数变动' + (delta > 0 ? '+' : '') + delta + '。');
  });
};

/**
 * V2.1 §3.2 可控突破。删除“纯随机直接突破”。
 * 突破条件：修为进度达门槛 + 悟性/机缘/材料之一 + 主动选择 + 完成判定。
 * 时间推进期间自动尝试已有资格者（仅当满足条件），失败产生代价而非无事发生。
 */
Game._advanceActors = function (years, summary) {
  const rng = Game.rngFor('time');
  Game.state.actors.forEach(function (a) {
    if (a.status === '陨落') return;
    a.age += years;
    // 修为积累：每 10 年积累进度（受灵气潮汐与长期计划影响）
    const climate = Game.state.world.spiritualClimate;
    const planBonus = (state_longTermPlanBonus(a));
    const gain = Math.max(1, Math.floor(years / 5)) * (1 + climate) + planBonus;
    a.cultivationProgress = (a.cultivationProgress || 0) + gain;

    // V2.1 §3.2 可控突破判定（自动尝试满足资格者）
    const br = Game.attemptBreakthrough(a);
    if (br && br.ok) {
      summary.changes.push(a.name + '突破至「' + br.newRealm + '」。');
    } else if (br && br.failed) {
      summary.changes.push(a.name + '尝试突破未成：' + br.note);
    }

    // 伤势恢复（V2.1 §4.3：仅疗伤/闭关/丹药/时间推进可恢复）
    if (a.injury > 0 && rng.chance(0.5)) a.injury = Math.max(0, a.injury - 1);
    // V2.1 §4.3 命元缓慢恢复
    if (a.combatStats && a.combatStats.body < Game._combatStatsFrom(a).body && rng.chance(0.3)) {
      a.combatStats.body += 1;
    }
    // 寿元 → 转世/陨落（V2.1 §3.3）
    if (a.age > a.lifespan) {
      const reincarnate = rng.chance(0.3);
      if (reincarnate) {
        Game._reincarnate(a, summary);
      } else {
        a.status = '陨落';
        summary.changes.push(a.name + '寿元已尽，陨落。');
        // V2.1 §3.3 留下灵印
        Game.state.soulImprints.push({
          formerActorId: a.id, name: a.name, unresolvedHooks: a.knownFacts.slice(),
          inheritedRumor: a.privateGoal, recognitionTags: [],
        });
      }
    }
  });
  function state_longTermPlanBonus(a) {
    const p = Game.state.longTermPlans && Game.state.longTermPlans[a.id];
    return (p && p.type === '闭关冲境') ? 2 : 0;
  }
};

Game._advanceRumors = function (years, summary) {
  const rng = Game.rngFor('time');
  // 传闻失真：随机替换一字或追加
  if (Game.state.world.rumors.length && rng.chance(0.5)) {
    summary.changes.push('一些传闻在岁月里失真，真相愈发模糊。');
  }
};

Game._advanceHooks = function (years, summary) {
  const rng = Game.rngFor('time');
  Game.state.ledger.hooks.slice().forEach(function (h) {
    if (rng.chance(0.2 * (years / 10))) {
      summary.changes.push('因果「' + h.name + '」于岁月中回响，' + (rng.chance(0.5) ? '得一机缘。' : '招一祸患。'));
      if (rng.chance(0.3)) h.intensity += 1;
    }
  });
};

Game._advanceSpiritualClimate = function () {
  // 每回合微调（timeRng 保持确定性）
  Game.state.world.spiritualClimate += Game.rngFor('time').chance(0.5) ? 0 : 0;
};
Game._advanceSpiritualClimateSettle = function (years, summary) {
  const delta = Game.rngFor('time').int(-1, 1);
  Game.state.world.spiritualClimate += delta;
  if (delta !== 0) summary.changes.push('灵气潮汐' + (delta > 0 ? '回升' : '衰退') + '。');
};

Game._chronicleFromSummary = function (summary) {
  const s = Game.state;
  summary.changes.forEach(function (c) {
    s.ledger.chronicle.canonical.push({ year: s.meta.year, text: c });
  });
};

/* ============================================================
 * §3.1 + §3.2 + §3.3 修炼、长寿与岁月议决
 * ------------------------------------------------------------
 * V2.1：长期计划系统 / 可控突破 / 飞升与转世雏形
 * ============================================================ */

/** V2.1 §3.1 长期计划类型 */
Game.LONG_TERM_PLAN_TYPES = ['闭关冲境', '游历寻机缘', '炼器炼丹', '经营势力', '追查因果', '收徒传承', '疗伤归隐'];

Game.setLongTermPlan = function (actorId, type, targetRegionId) {
  if (Game.LONG_TERM_PLAN_TYPES.indexOf(type) < 0) return { ok: false, reason: '未知长期计划类型' };
  const a = Game.actorById(actorId);
  if (!a) return { ok: false, reason: '无此角色' };
  const plan = {
    type: type, targetRegionId: targetRegionId || a.locationId,
    yearsRequired: { '闭关冲境': 10, '游历寻机缘': 5, '炼器炼丹': 5, '经营势力': 10, '追查因果': 8, '收徒传承': 10, '疗伤归隐': 5 }[type] || 5,
    progress: 0, risks: [], possibleRewards: [],
  };
  Game.state.longTermPlans[actorId] = plan;
  Game.logEvent('plan.set', { actorIds: [actorId], text: a.name + '立下长期计划：「' + type + '」。', source: 'rule' });
  return { ok: true, plan: plan };
};

Game.getLongTermPlan = function (actorId) {
  return Game.state.longTermPlans[actorId] || null;
};

/** 时间推进时推进长期计划进度 */
Game._advanceLongTermPlans = function (years, summary) {
  Object.keys(Game.state.longTermPlans).forEach(function (aid) {
    const p = Game.state.longTermPlans[aid];
    const a = Game.actorById(aid);
    if (!a || a.status === '陨落') return;
    p.progress += years;
    // 计划完成效果
    if (p.progress >= p.yearsRequired) {
      if (p.type === '闭关冲境') {
        // 增加突破资格（悟性/机缘）
        a.flags = a.flags || {};
        a.flags.insight = true;
        summary.changes.push(a.name + '十年闭关圆满，得悟性机缘，可尝试突破。');
      } else if (p.type === '疗伤归隐') {
        a.injury = 0;
        if (a.combatStats) a.combatStats.body = Game._combatStatsFrom(a).body;
        summary.changes.push(a.name + '疗伤归隐圆满，伤势尽复。');
      } else if (p.type === '经营势力') {
        summary.changes.push(a.name + '经营有成，名下势力渐成气候。');
      }
      p.progress = 0; // 可继续累积
    }
  });
};

/**
 * V2.1 §3.2 可控突破判定。
 * 炼气九层→筑基：修为进度>=8 且 拥有材料或悟道事件 且 伤势<2。
 * 自动尝试仅当条件满足；失败产生代价（轻伤/心魔/材料损耗/推迟）。
 * @returns {ok, newRealm} 或 {failed, note} 或 null（条件不满足）
 */
Game.attemptBreakthrough = function (actor) {
  const cur = actor.realm;
  const next = Game.nextRealm(cur);
  if (!next) return null;
  const rng = Game.rngFor('time');
  // 修为进度门槛：境界越高门槛越高
  const tier = Game.realmTier(cur);
  const progNeed = 6 + tier * 4; // 炼气:6/筑基:10/金丹:14 ...
  if ((actor.cultivationProgress || 0) < progNeed) return null;
  // 须有悟性/机缘/材料之一
  const hasInsight = actor.flags && (actor.flags.insight || actor.flags.epiphany);
  const hasMaterial = (actor.resources || []).some(function (r) { return r.indexOf('丹') >= 0 || r.indexOf('材料') >= 0 || r.indexOf('玉') >= 0; });
  if (!hasInsight && !hasMaterial) return null;
  // 伤势限制
  if ((actor.injury || 0) >= 2) return null;

  // V2.1 §1.2 飞升受阻：金丹以上需天外凭证
  const law = Game.getLawEffect();
  if (law && law.onBreakthrough && tier >= 2) {
    const lawCheck = law.onBreakthrough(actor);
    if (!lawCheck.ok) return { failed: true, note: lawCheck.reason };
  }

  // 突破判定：境界越高越难
  const threshold = 12 + tier * 3;
  const av = Game.calcActionValue({ actionType: 'cultivate', posture: '争' }, actor);
  const grade = Game.judgeGrade(av.value, threshold);
  if (grade === '大成' || grade === '成功') {
    actor.realm = next;
    actor.cultivationProgress = 0;
    actor.combatStats = Game._combatStatsFrom(actor);
    actor.lifespan += 60 + tier * 40;
    if (actor.flags) actor.flags.insight = false;
    return { ok: true, newRealm: next };
  }
  // 失败产生代价（V2.1 §3.2）
  const costs = ['轻伤', '心魔缠身', '材料损耗', '推迟突破', '得新悟性线索'];
  const cost = rng.pick(costs);
  if (cost === '轻伤') actor.injury = (actor.injury || 0) + 1;
  if (cost === '心魔缠身') { actor.flags = actor.flags || {}; actor.flags.heartDemon = true; actor.injury = (actor.injury || 0) + 1; }
  if (cost === '材料损耗' && actor.resources.length) actor.resources.pop();
  if (cost === '推迟突破') actor.cultivationProgress = Math.floor((actor.cultivationProgress || 0) / 2);
  if (cost === '得新悟性线索') { actor.flags = actor.flags || {}; actor.flags.epiphany = true; Game.addKnowledge(actor.id, '突破中得一缕悟性线索'); }
  return { failed: true, note: cost + '，突破未成' };
};

/** V2.1 §3.3 转世：寿元尽时生成 SoulImprint，仅继承允许字段 */
Game._reincarnate = function (actor, summary) {
  const law = Game.getLawEffect();
  const imprint = {
    formerActorId: actor.id, name: actor.name,
    residualTrait: '', unresolvedHooks: actor.knownFacts.slice(0, 1),
    inheritedRumor: actor.privateGoal, recognitionTags: [],
  };
  if (law && law.onReincarnate) law.onReincarnate(imprint);
  Game.state.soulImprints.push(imprint);
  // 转世重修：仅继承一项残响 + 一条因果，不继承境界/装备/全部记忆
  actor.realm = '炼气六层';
  actor.age = 16;
  actor.injury = 0;
  actor.cultivationProgress = 0;
  actor.combatStats = Game._combatStatsFrom(actor);
  actor.status = '正常';
  actor.flags = actor.flags || {};
  actor.flags.residualTrait = imprint.residualTrait;
  summary.changes.push(actor.name + '寿尽转世，携「' + imprint.residualTrait + '」重修。');
};

/** V2.1 §3.3 飞升：元婴且满足世界法则可飞升，化为 HeavenlyEcho */
Game.ascend = function (actorId) {
  const a = Game.actorById(actorId);
  if (!a) return { ok: false, reason: '无此角色' };
  if (Game.realmTier(a.realm) < 4) return { ok: false, reason: '境界不足，未达元婴' };
  const law = Game.getLawEffect();
  if (law && law.onBreakthrough) {
    const c = law.onBreakthrough(a);
    if (!c.ok) return { ok: false, reason: c.reason };
  }
  const echo = {
    owner: a.name, doctrine: a.daoPath + '道统',
    relics: a.resources.slice(0, 2), occasionalInterventions: [],
    worldInfluence: a.knownFacts.slice(0, 2),
  };
  Game.state.heavenlyEchoes.push(echo);
  a.status = '飞升';
  Game.logEvent('actor.ascend', { actorIds: [a.id], text: a.name + '飞升，留「' + echo.doctrine + '」道统于人间。', source: 'rule' });
  return { ok: true, echo: echo };
};

/* ============================================================
 * §4.5 因果钩子与天书批注 (rules/karmaResolver, metaRewriteResolver)
 * ============================================================ */

Game.addHook = function (hook) {
  const h = {
    name: hook.name, owner: hook.owner, intensity: hook.intensity || 1,
    trigger: hook.trigger || [], reward: hook.reward || '', risk: hook.risk || '',
    year: Game.state.meta.year,
  };
  Game.state.ledger.hooks.push(h);
  Game.state.historySeeds.push({ type: 'hook', name: h.name, owner: h.owner });
  Game.logEvent('hook.add', { actorIds: [hook.owner], text: '新增因果：' + h.name, source: 'rule' });
  return h;
};
Game.getHooks = function () { return Game.state.ledger.hooks.slice(); };

/**
 * 天书批注：元叙事改写（V2 §9）。
 * 每次消耗一页天书残页，增加因果，限定区域/势力，不能删除既定事实，必产生未来代价。
 * @param {string} kind - 创设流派/创设势力/留痕/封存
 */
Game.useHeavenlyBook = function (kind, params) {
  const state = Game.state;
  if (state.inventory.heavenlyPages <= 0) return { ok: false, reason: '无天书残页可用。' };
  params = params || {};
  state.inventory.heavenlyPages -= 1;
  const lu = Game.getPlayer();
  lu.karma = (lu.karma || 0) + 1;
  let text = '';
  const futureCost = '此番改写必于未来生出一桩代价。';

  if (kind === '创设势力') {
    const name = params.name || '火枫国';
    const newNode = {
      id: 'r_' + state.map.nodes.length, idx: state.map.nodes.length, name: name,
      kind: params.kind || '城池', danger: 2, aura: ['新立'], controllerFactionId: null,
      resources: ['新朝气运'], rumors: ['新势力初立，四方观望。'], historyTags: ['天书批注'],
      connections: [], currentEvents: [], encounter: null, sealed: false,
    };
    // 连接到玩家当前所在节点
    const here = Game.nodeById(lu.locationId);
    newNode.connections.push(here.id);
    here.connections.push(newNode.id);
    state.map.nodes.push(newNode);
    state.map.edges.push([here.idx, newNode.idx]);
    const fac = { id: 'fac_' + state.factions.length, name: name, power: 50, stance: '新立', controlled: [newNode.id] };
    state.factions.push(fac);
    newNode.controllerFactionId = fac.id;
    text = '陆知微以天书残页批注，于「' + here.name + '」之畔创设「' + name + '」，地图生新节点，势力关系随之而变。';
    Game.addHook({ name: name + '之兴', owner: '陆知微', intensity: 2, trigger: [name + '遭危', '周边势力反扑'], reward: name + '可作后盾', risk: futureCost });
  } else if (kind === '创设流派') {
    const name = params.name || '剑灵道';
    lu.knownFacts.push('开创新修行流派「' + name + '」');
    state.world.rules.push('新流派「' + name + '」显化于世，' + (params.rule || '以剑灵共鸣为旨。'));
    text = '陆知微以天书残页批注，开创新修行流派「' + name + '」，世界规则为之改写。';
    Game.addHook({ name: name + '之传', owner: '陆知微', intensity: 2, trigger: ['传人现世', '流派遭劫'], reward: '传人可继其道', risk: futureCost });
  } else if (kind === '留痕') {
    const name = params.name || '剑冢遗迹';
    const here = Game.nodeById(lu.locationId);
    here.rumors.push('「' + name + '」之传说不胫而走。');
    here.historyTags.push('天书留痕');
    text = '陆知微以天书残页留痕「' + name + '」，遗迹传闻载入年表。';
    Game.addHook({ name: name, owner: '陆知微', intensity: 1, trigger: ['后人寻迹'], reward: '后人可获机缘', risk: futureCost });
  } else { // 封存
    const name = params.name || '一段秘辛';
    Game.addHook({ name: '封存·' + name, owner: '陆知微', intensity: 2, trigger: ['封印松动'], reward: '秘密压入未来', risk: futureCost });
    text = '陆知微以天书残页将「' + name + '」封存于未来，待时而动。';
  }

  state.ledger.chronicle.canonical.push({ year: state.meta.year, text: text + '（' + futureCost + '）' });
  Game.logEvent('heavenly.annotate', { actorIds: ['lu'], text: text, source: 'player-meta' });
  return { ok: true, text: text, futureCost: futureCost };
};

/* ============================================================
 * §5 AI 接口 (ai/provider, fallbackTemplates, narration)
 * ------------------------------------------------------------
 * Provider 接口（V2 §7.1）。默认 FallbackProvider，离线可用。
 * 真实接入时替换 Game.ai.provider 即可，签名保持不变。
 * ============================================================ */

/**
 * V2.1 §5 AI 接口。统一 4 方法 Provider，全部异步，失败/超时自动回退本地规则。
 *   decideCompanion(context) — §5.2 AI 同伴从候选中选择
 *   narrateRound(context)    — §5.3 公共叙事（仅文本，不改状态）
 *   summarizeEpoch(context)  — 时间跳跃摘要
 *   polishNarration(context) — 重新润色
 * 关键：AI 永不直接修改世界状态，只返回文本/候选Id，由规则引擎校验后落地。
 */
Game.ai = {
  enabled: false,
  provider: null,
  timeoutMs: 12000,

  /** 带超时的异步执行；超时/异常均回退 */
  _withTimeout: function (promise, ms) {
    return new Promise(function (resolve) {
      let done = false;
      const t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms || Game.ai.timeoutMs);
      Promise.resolve(promise).then(function (r) {
        if (!done) { done = true; clearTimeout(t); resolve(r); }
      }, function () { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    });
  },

  /**
   * §5.2 AI 同伴决策。context = { agent, candidates, worldBrief, privateContext }
   * 返回 { candidateId, publicLine, reasonTags } 或 null（回退本地最高分）。
   * 校验：candidateId 必须在候选列表中；AI 不得越权新增法宝/境界/死亡/秘密。
   */
  decideCompanion: async function (context) {
    if (Game.ai.provider && Game.ai.enabled && Game.ai.provider.decideCompanion) {
      try {
        const r = await Game.ai._withTimeout(Game.ai.provider.decideCompanion(context));
        if (!r || typeof r !== 'object') return null;
        // 校验 candidateId 在候选中
        const valid = (context.candidates || []).some(function (c) { return c._id === r.candidateId; });
        if (!valid) return null;
        // 不得携带越权字段
        if (r.newRealm || r.death || r.newItem || r.secret) return null;
        return { candidateId: r.candidateId, publicLine: String(r.publicLine || '').slice(0, 120), reasonTags: Array.isArray(r.reasonTags) ? r.reasonTags.slice(0, 5) : [] };
      } catch (e) { return null; }
    }
    return null;
  },

  /** §5.3 公共叙事。返回 {title, chapter, dialogues, rumor} 或 null（回退） */
  narrateRound: async function (context) {
    if (Game.ai.provider && Game.ai.enabled && Game.ai.provider.narrateRound) {
      try {
        const r = await Game.ai._withTimeout(Game.ai.provider.narrateRound(context));
        if (!r || typeof r !== 'object' || typeof r.chapter !== 'string') return null;
        return r;
      } catch (e) { return null; }
    }
    return null;
  },

  /** 时间跳跃摘要。返回 {canonical, rumors, futureHook} 或 null */
  summarizeEpoch: async function (context) {
    if (Game.ai.provider && Game.ai.enabled && Game.ai.provider.summarizeEpoch) {
      try {
        const r = await Game.ai._withTimeout(Game.ai.provider.summarizeEpoch(context));
        if (!r || !Array.isArray(r.canonical)) return null;
        return r;
      } catch (e) { return null; }
    }
    return null;
  },

  /** 重新润色（V2 §7.3）。异步、仅文本。失败返回 null */
  polishNarration: async function (context) {
    if (Game.ai.provider && Game.ai.enabled && Game.ai.provider.polishNarration) {
      try {
        const r = await Game.ai._withTimeout(Game.ai.provider.polishNarration(context));
        if (!r || typeof r !== 'object' || typeof r.chapter !== 'string') return null;
        return r;
      } catch (e) { return null; }
    }
    return null;
  },

  /** 兼容旧调用名（同步回退，供确定性测试与离线） */
  narrate: function (context) { return Game._fallbackNarrate(context); },
  epochSummary: function (context) { return Game._fallbackEpochSummary(context); },
};

/** 注册真实 Provider（OpenAI Compatible 等） */
Game.registerAIProvider = function (provider) { Game.ai.provider = provider; };
Game.setAIEnabled = function (on) { Game.ai.enabled = !!on; if (Game.state) Game.state.meta.aiEnabled = !!on; };

/**
 * 叙事生成主入口（resolve 后调用）。
 * 同步生成规则回退文本（保证 UI 立刻有内容、确定性不受 AI 影响）；
 * 若 AI 已启用，UI 可再异步调用 Game.ai.narrateRound 覆盖。
 */
Game.generateNarration = function () {
  const state = Game.state;
  const results = state.currentRound.results || [];
  const ctx = {
    worldName: state.meta.worldName, year: state.meta.year, round: state.meta.round,
    location: (Game.nodeById(Game.getPlayer().locationId) || {}).name,
    results: results.map(function (r) { return { actor: (Game.actorById(r.actorId) || {}).name, type: r.type, grade: r.grade, outcome: r.outcome, text: r.text }; }),
    publicTruths: state.world.truths.slice(-3),
  };
  const n = Game._fallbackNarrate(ctx);
  state.currentRound.narration = n;
  state.currentRound._narrationCtx = ctx; // 供 UI 异步润色
  Game.logEvent('round.narrate', { text: n.chapter, source: 'rule' });
  return n;
};

Game._fallbackNarrate = function (ctx) {
  const lines = (ctx.results || []).map(function (r) { return r.text; }).filter(Boolean);
  const chapter = (lines.join(' ') || '风过无痕。').slice(0, 400);
  const dialogues = {};
  Game.state.actors.filter(function (a) { return a.role === 'ai'; }).forEach(function (a) {
    dialogues[a.id] = Game._aiLine(a, ctx);
  });
  return {
    chapter: chapter,
    title: '第' + ctx.round + '回 · ' + (ctx.location || '') + '风云',
    dialogues: dialogues,
    rumor: Game.rngFor('agent').pick(Game.state.world.rumors.length ? Game.state.world.rumors : ['江湖又起一阵风声。']),
  };
};

Game._aiLine = function (a, ctx) {
  const lines = {
    han: ['哼，这种程度的凶险，还压不住我。', '那道剑意……我迟早要追上它。', '别磨蹭，前路还长。'],
    shen: ['此处……似有古怪，且慢些。', '我需要一份样本，莫要惊动它。', '一半真话，足以保命。'],
    gu: ['这笔账，划算。', '阵纹归我，其余好说。', '算清楚了再动不迟。'],
  };
  return Game.rngFor('agent').pick(lines[a.id] || ['……']);
};

Game._fallbackEpochSummary = function (ctx) {
  return {
    canonical: ctx.changes || [],
    rumors: ['岁月流转，旧事化作传闻。'],
    futureHook: '新卷之中，旧因果将再度回响。',
  };
};

/* ============================================================
 * §6 账本 / 年表 / 遗产 (storage/exports, legacyGenerator)
 * ============================================================ */

Game.getChronicle = function () {
  return Game._clone(Game.state.ledger.chronicle);
};
Game.getPublicTruths = function () {
  return Game.state.world.truths.slice();
};
Game.getRumors = function () {
  return Game.state.world.rumors.slice();
};

/** 生成世界遗产包（V2 §8.4） */
Game.generateLegacy = function () {
  const s = Game.state;
  const legacy = {
    seed: s.meta.seed,
    worldName: s.meta.worldName,
    year: s.meta.year,
    era: s.meta.era, terrain: s.meta.terrain, order: s.meta.order, heavenlyLaw: s.meta.heavenlyLaw,
    canonicalHistory: s.ledger.chronicle.canonical.map(function (c) { return c.text; }),
    rumors: s.world.rumors.slice(),
    relics: [],
    ruins: [],
    factions: s.factions.map(function (f) { return f.name + '（势力' + f.power + '）'; }),
    unresolvedKarma: s.ledger.hooks.map(function (h) { return h.name + '（' + h.owner + '，强度' + h.intensity + '）'; }),
    successorHooks: s.historySeeds.map(function (h) { return '新角色可继承「' + h.name + '」之余绪。'; }),
  };
  // 遗物 / 遗迹
  s.actors.forEach(function (a) {
    a.resources.forEach(function (r) { legacy.relics.push(r + '（' + a.name + '所持）'); });
  });
  s.map.nodes.forEach(function (n) {
    if (n.kind === '禁地' || n.historyTags.indexOf('天书留痕') >= 0) legacy.ruins.push(n.name);
  });
  s.ledger.chronicle.canonical.push({ year: s.meta.year, text: '世界遗产包封卷，留待后世开卷。' });
  Game.logEvent('legacy.seal', { text: '世界遗产包已生成，可导出或开创新卷。', source: 'rule' });
  return legacy;
};

Game.exportLegacy = function () {
  return JSON.stringify(Game.state.finalLegacy || Game.generateLegacy(), null, 2);
};

/** 导入旧世界遗产包作为新世界背景（百年后新卷） */
Game.createSequel = function (legacy) {
  legacy = typeof legacy === 'string' ? JSON.parse(legacy) : legacy;
  const newSeed = (legacy.seed || 'BLACKWIND') + '-II-' + Math.floor(Game.rngFor('time').next() * 1000);
  Game.generateWorld(newSeed);
  const s = Game.state;
  // 将旧世界遗产注入为背景
  legacy.canonicalHistory.forEach(function (t) { s.ledger.chronicle.canonical.push({ year: 0, text: '前朝旧事：' + t }); });
  legacy.rumors.forEach(function (r) { s.world.rumors.push('前朝传闻：' + r); });
  legacy.unresolvedKarma.forEach(function (k) {
    s.ledger.hooks.push({ name: k, owner: '前朝', intensity: 1, trigger: [], reward: '', risk: '前朝因果回响', year: 0 });
  });
  legacy.successorHooks.forEach(function (h) { s.historySeeds.push({ type: 'successor', name: h }); });
  s.world.truths.unshift('此界承自前朝「' + legacy.worldName + '」之遗产。');
  Game.logEvent('world.sequel', { text: '百年后新卷开启，承前朝遗产。', source: 'rule' });
  return s;
};

/* ============================================================
 * §6.2 本地存档 (storage/saves)
 * ------------------------------------------------------------
 * 使用 localStorage（demo 简化；V2 规划为 IndexedDB/Dexie，接口一致）。
 * API Key 不存入世界存档。
 * ============================================================ */

Game.SAVE_KEY = 'xiuxianju_v2_save';
/** V2.1 §0.3：设置单独存储，且 API Key 绝不入 localStorage/存档 */
Game.SETTINGS_KEY = 'xiuxianju_v2_settings';

/**
 * V2.1 §0.3 安全设置对象。apiKey 仅存内存（Game._apiKey），不持久化。
 * localStorage 只保存：是否开启 AI / Endpoint / 模型名 / 温度。
 */
Game._apiKey = null; // 内存中，刷新即失
Game.getApiKey = function () { return Game._apiKey; };
Game.setApiKey = function (k) { Game._apiKey = k || null; };

/** 持久化设置（不含 apiKey） */
Game.saveSettings = function (settings) {
  const safe = {
    aiOn: !!(settings && settings.aiOn),
    base: (settings && settings.base) || '',
    model: (settings && settings.model) || '',
    temperature: (settings && typeof settings.temperature === 'number') ? settings.temperature : 0.8,
    omniscient: !!(settings && settings.omniscient), // V2.1 §2.3 天机全览模式
  };
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(Game.SETTINGS_KEY, JSON.stringify(safe)); } catch (e) {}
  return safe;
};
Game.loadSettings = function () {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(Game.SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
};

/**
 * 存档。V2.1 §0.1：完整保存分桶 RNG 状态；§0.3：API Key 不入存档。
 */
Game.save = function (settings) {
  if (!Game.state) return null;
  // 先把运行时桶状态同步进 state.rng
  Game.state.rng = Game.snapshotRng();
  const snapshot = Game._clone(Game.state);
  // 设置独立保存（且剥离 apiKey），不污染世界确定性
  if (settings) Game.saveSettings(settings);
  snapshot._settings = settings ? Game.saveSettings(settings) : null;
  // 显式剔除任何可能混入的 apiKey
  if (snapshot._settings) delete snapshot._settings.apiKey;
  const data = JSON.stringify(snapshot);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(Game.SAVE_KEY, data);
  } catch (e) { /* 非浏览器环境 */ }
  return data;
};

/**
 * 读档。V2.1 §0.1：从 state.rng 恢复分桶 RNG，保证续玩确定性。
 */
Game.load = function (data) {
  let parsed;
  try {
    if (data == null && typeof localStorage !== 'undefined') data = localStorage.getItem(Game.SAVE_KEY);
    parsed = typeof data === 'string' ? JSON.parse(data) : data;
  } catch (e) { return null; }
  if (!parsed) return null;
  parsed = Game._migrate(parsed);
  Game.state = parsed;
  // 恢复分桶 RNG：用世界种子重建桶，再用存档里的 state 复位
  Game.restoreRng(parsed.rng);
  return parsed;
};

/** 存档迁移：补齐字段以兼容旧结构（V2 §10.1 + V2.1 新字段） */
Game._migrate = function (s) {
  if (!s.meta) s.meta = {};
  s.meta.version = s.meta.version || '2.0.0';
  if (!s.currentRound) s.currentRound = { intents: [], results: [], encounter: null, narration: null, timeJump: null, votes: {} };
  if (!s.inventory) s.inventory = { heavenlyPages: 0, items: [] };
  if (!s.ledger) s.ledger = { events: [], hooks: [], chronicle: { canonical: [], rumors: [], privateTruth: [] }, memories: {} };
  if (!s.ledger.chronicle) s.ledger.chronicle = { canonical: [], rumors: [], privateTruth: [] };
  if (!s.world) s.world = { rules: [], spiritualClimate: 0, futureAbnormal: [], truths: [], rumors: [] };
  if (!s.world.lawEffects) s.world.lawEffects = {};
  if (!s.map) s.map = { nodes: [], edges: [] };
  // V2.1 新字段
  if (!s.rng) s.rng = { action: null, agent: null, time: null, event: null };
  if (typeof s.eventSeq !== 'number') s.eventSeq = 0;
  if (!s.longTermPlans) s.longTermPlans = {};
  if (!s.heavenlyEchoes) s.heavenlyEchoes = [];
  if (!s.soulImprints) s.soulImprints = [];
  // 节点 encounter 补齐持久化字段（V2.1 §4.1）
  (s.map.nodes || []).forEach(function (n) {
    if (n.encounter && typeof n.encounter.maxVitality !== 'number') {
      n.encounter.maxVitality = n.encounter.vitality;
      n.encounter.guard = n.encounter.guard || 0;
      n.encounter.statuses = n.encounter.statuses || [];
      n.encounter.escaped = !!n.encounter.escaped;
    }
  });
  return s;
};

Game.hasSave = function () {
  try { return typeof localStorage !== 'undefined' && !!localStorage.getItem(Game.SAVE_KEY); }
  catch (e) { return false; }
};

Game.reset = function () {
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem(Game.SAVE_KEY); } catch (e) {}
  }
  Game.state = null;
};

/* ============================================================
 * §7 便捷查询 API（供 UI 调用）
 * ============================================================ */

Game.getMeta = function () { return Game._clone(Game.state.meta); };
Game.getMap = function () { return Game._clone(Game.state.map); };
Game.getActors = function () {
  // 公开信息（剔除私密目标/私密知识等敏感字段）
  return Game.state.actors.map(function (a) {
    return {
      id: a.id, name: a.name, role: a.role, identity: a.identity, daoPath: a.daoPath,
      realm: a.realm, roots: a.roots, age: a.age, lifespan: a.lifespan,
      publicGoal: a.publicGoal, personality: a.personality, resources: a.resources,
      injury: a.injury, status: a.status, locationId: a.locationId,
      relationshipToPlayer: a.relationshipToPlayer, lastPublicTrace: a.lastPublicTrace,
      combatStats: a.combatStats,
    };
  });
};
Game.getFactions = function () { return Game._clone(Game.state.factions); };
Game.getPhase = function () { return Game.state.meta.phase; };
Game.getRoundResults = function () { return Game._clone(Game.state.currentRound.results); };
Game.getNarration = function () { return Game._clone(Game.state.currentRound.narration); };
Game.getInventory = function () { return Game._clone(Game.state.inventory); };
Game.getVotes = function () { return Game._clone(Game.state.currentRound.votes); };

/** 取玩家可执行行动（供 UI 渲染候选） */
Game.getPlayerOptions = function () {
  const lu = Game.getPlayer();
  const node = Game.nodeById(lu.locationId);
  const opts = [];
  Game.AVAILABLE_LOCAL_ACTIONS(node).forEach(function (type) {
    opts.push({ actionType: type, targetId: node.id, label: Game.ACTION_LABEL[type] + '·' + node.name });
  });
  node.connections.forEach(function (nid) {
    const nb = Game.nodeById(nid);
    opts.push({ actionType: 'travel', targetId: nid, label: '行游·前往' + nb.name });
  });
  return opts;
};

/** 玩家是否在秘境（验收用） */
Game.playerAtKind = function (kind) {
  const lu = Game.getPlayer();
  const n = Game.nodeById(lu.locationId);
  return n && n.kind === kind;
};

/** V2.1 §4.2 取玩家当前地点可用的遭遇行动（若有未解决遭遇） */
Game.getEncounterActions = function () {
  const lu = Game.getPlayer();
  if (!lu) return [];
  const node = Game.nodeById(lu.locationId);
  if (!node || !node.encounter || node.encounter.resolved) return [];
  return ['正面争斗', '借弱点', '布阵困敌', '以物换路', '结缘谈判', '撤退逃遁'].map(function (a) {
    return { action: a, label: a };
  });
};

/** V2.1 §2.3 天机全览模式：返回所有 AI 私密知识/隐藏目标/真实事件（仅开发者模式） */
Game.getOmniscientView = function () {
  if (!Game.state) return null;
  return {
    actors: Game.state.actors.map(function (a) {
      return {
        id: a.id, name: a.name, privateGoal: a.privateGoal, knownFacts: a.knownFacts,
        agentPlan: a.agentPlan, privateIntent: a.privateIntent,
      };
    }),
    hooks: Game.state.ledger.hooks,
    soulImprints: Game.state.soulImprints,
    heavenlyEchoes: Game.state.heavenlyEchoes,
    privateTruth: Game.state.ledger.chronicle.privateTruth,
  };
};

/** V2.1 §3.1 取角色长期计划（供 UI 渲染） */
Game.getAllLongTermPlans = function () {
  return Game._clone(Game.state.longTermPlans);
};

/** V2.1 取当前地点遭遇状态（供 UI 显示怪物血条） */
Game.getEncounter = function () {
  const lu = Game.getPlayer();
  if (!lu) return null;
  const node = Game.nodeById(lu.locationId);
  if (!node || !node.encounter) return null;
  const enc = node.encounter;
  const monster = Game.MONSTERS.find(function (m) { return m.id === enc.monsterId; }) || {};
  return {
    monsterId: enc.monsterId, monsterName: monster.name,
    vitality: enc.vitality, maxVitality: enc.maxVitality,
    guard: enc.guard, hostility: enc.hostility, statuses: enc.statuses || [],
    resolved: enc.resolved, escaped: enc.escaped, weakness: monster.weakness, nonCombat: monster.nonCombat,
  };
};

/* ============================================================
 * 模块导出（兼容 Node 测试；浏览器内联时自动忽略）
 * ============================================================ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Game;
} else if (typeof globalThis !== 'undefined') {
  globalThis.Game = Game;
}
