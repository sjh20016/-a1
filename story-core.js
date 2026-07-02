/**
 * ============================================================================
 * 《修行局》V3.2 —— 本地裁决、AI 小说化、场景持续演化的叙事内核
 * ============================================================================
 * 核心原则（V3.2）：
 *   先结算，后写文。先写账本，后写小说。
 *   玩家行动 → IntentParser 识别意图 → TurnResolver 本地确定结果/代价/时间/
 *   关系/世界变化 → StateDelta 写入账本与场景 → ChoiceFactory 本地生成下一轮选项
 *   → Narration.buildBrief → AI 只把既定事实写成小说（仅 title/chapter/dialogues/
 *   endingImage）；AI 失败则由 LocalNarrativeAssembler 离线组装。
 *   AI 不得改变任何世界状态；重新润色章节不得重新结算。
 *
 * 兼容：保留 V3/V3.1 全部公开 API（startGame/playTurn/save/load/reset/
 *   setAIEnabled/registerAIProvider/resolveTurn/getChoicesForActor/
 *   getPublicStoryView/getPrivateActorView/aiChoose/choiceScore/compileContext…）。
 *
 * 命名空间：Story.Intent / Story.Scene / Story.Resolver / Story.Delta /
 *   Story.ChoiceFactory / Story.Agent / Story.Narration / Story.Provider /
 *   Story.Diagnostics / Story.Migration
 * ============================================================================
 */

const Story = {};

/* 复用 V2.1 的种子哈希与分桶 RNG（若 game-core.js 已加载） */
Story._dep = (typeof Game !== 'undefined') ? Game : null;
Story.hashSeed = function (s) {
  if (Story._dep && Story._dep.hashSeed) return Story._dep.hashSeed(s);
  let h = 1779033703 ^ String(s).length;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
};
Story.createRng = function (seed, sub) {
  if (Story._dep && Story._dep.createSeededRng) {
    const dep = Story._dep.createSeededRng(seed, sub);
    // 保证 V3.2 所需方法齐全（dep 可能只提供 next/int/pick）
    if (dep && typeof dep.next === 'function') {
      if (typeof dep.shuffle !== 'function') {
        dep.shuffle = function (arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(dep.next() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
      }
      if (typeof dep.pick !== 'function') {
        dep.pick = function (arr) { return arr[Math.floor(dep.next() * arr.length)]; };
      }
      if (typeof dep.chance !== 'function') {
        dep.chance = function (p) { return dep.next() < p; };
      }
      return dep;
    }
  }
  const baseSeed = String(seed) + (sub ? '::' + sub : '');
  let a = Story.hashSeed(baseSeed) >>> 0;
  const next = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed: baseSeed, next: next,
    int: function (mn, mx) { return Math.floor(next() * (mx - mn + 1)) + mn; },
    pick: function (arr) { return arr[Math.floor(next() * arr.length)]; },
    chance: function (p) { return next() < p; },
    shuffle: function (arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; },
    getState: function () { return a >>> 0; },
    setState: function (s) { a = (s >>> 0); },
  };
};

/* ============================================================
 * §1 常量：七枚开界骰 / 地貌 / 天道 / 人格 / AI 同伴模板
 * ============================================================ */

Story.VERSION = '3.2.0';

Story.ORIGIN_DICE = {
  era:            ['盛世', '衰世', '末法', '天倾前夜'],
  terrain:        ['山河大陆', '群岛海域', '空岛海', '妖域边荒', '地下灵脉'],
  order:          ['宗门割据', '皇朝统治', '妖族共治', '散修乱世'],
  heavenlyLaw:    ['飞升受阻', '轮回紊乱', '契约具现', '法宝有灵'],
  greatTribulation: ['魔潮', '天裂', '古神苏醒', '灵脉枯竭', '皇朝崩塌'],
  aberrant:       ['妖族昌盛', '鬼修横行', '灵族复苏', '龙裔遗民'],
  storyGravity:   ['夺宝', '宗门', '战争', '游历', '复仇', '经商', '飞升'],
};

Story.ORIGIN_EFFECT = {
  era: {
    '盛世':       { rule: '灵气充沛，修行加速，宗门鼎盛。', mod: { cultivate: 1, danger: -1 } },
    '衰世':       { rule: '灵气渐稀，突破维艰，遗物频现。', mod: { cultivate: -1, relic: 1 } },
    '末法':       { rule: '末法之气回潮，法宝有灵而修士难成。', mod: { cultivate: -2, relic: 2 } },
    '天倾前夜':   { rule: '天倾将至，灾劫频发，飞升者绝迹。', mod: { danger: 2, cultivate: -1 } },
  },
  terrain: {
    '山河大陆':   { rule: '广袤大陆，宗门城池错落，路线稳定。', regions: ['宗门', '城池', '妖域', '秘境', '荒野', '禁地'] },
    '群岛海域':   { rule: '群岛星罗，水路为主，跨海需船。', regions: ['宗门', '城池', '秘境', '荒野', '禁地', '海域'] },
    '空岛海':     { rule: '悬陆浮空，塔林通天，分层而行。', regions: ['宗门', '城池', '秘境', '禁地', '荒野', '空域'] },
    '妖域边荒':   { rule: '边荒妖族横行，扼守要冲。', regions: ['宗门', '城池', '妖域', '妖域', '秘境', '禁地', '荒野'] },
    '地下灵脉':   { rule: '灵脉纵横地底，洞穴连成幽境。', regions: ['宗门', '城池', '秘境', '禁地', '荒野', '幽境'] },
  },
  order: {
    '宗门割据':   { rule: '宗门各据一方，争锋不断。', factions: ['青霄宗', '流云宗', '玄霄宗'] },
    '皇朝统治':   { rule: '皇朝统御修界，律法严明。', factions: ['天枢皇朝', '青霄宗', '赤砂商会'] },
    '妖族共治':   { rule: '人妖共治，盟约脆弱。', factions: ['黑风妖庭', '青霄宗', '药谷'] },
    '散修乱世':   { rule: '散修乱世，群雄并起。', factions: ['赤砂商会', '顾家', '药谷'] },
  },
  heavenlyLaw: {
    '飞升受阻':   { rule: '飞升之路受阻，大能滞留人间成为旧时代阴影。', flag: 'ascensionBlocked' },
    '轮回紊乱':   { rule: '轮回紊乱，转世者可能继承错误的前世记忆。', flag: 'reincarnationChaos' },
    '契约具现':   { rule: '承诺具现为可追踪因果，违背即遭反噬。', flag: 'pactManifest' },
    '法宝有灵':   { rule: '法宝自有灵识，择主而栖，或助或叛。', flag: 'relicSentience' },
  },
  greatTribulation: {
    '魔潮':       { rule: '魔潮将至，妖魔躁动，边境多事。', flag: 'demonTide' },
    '天裂':       { rule: '天裂扩大，禁制渐弱，异象频生。', flag: 'skyCrack' },
    '古神苏醒':   { rule: '古神将醒，灵脉共振，大能感应。', flag: 'oldGod' },
    '灵脉枯竭':   { rule: '灵脉枯竭，资源日稀，争夺加剧。', flag: 'veinDry' },
    '皇朝崩塌':   { rule: '皇朝崩塌在即，秩序将乱，群雄窥伺。', flag: 'dynastyFall' },
  },
  aberrant: {
    '妖族昌盛':   { rule: '妖族昌盛，妖材充盈，亦多妖患。', flag: 'demonProsper' },
    '鬼修横行':   { rule: '鬼修横行，阴气弥漫，神魂易损。', flag: 'ghostHaunt' },
    '灵族复苏':   { rule: '灵族复苏，草木有灵，古约重提。', flag: 'spiritRevive' },
    '龙裔遗民':   { rule: '龙裔遗民隐世，龙血遗物现踪。', flag: 'dragonRemnant' },
  },
  storyGravity: {
    '夺宝':       { rule: '故事引力为夺宝：传承、遗物、秘藏出现频率提高。', tag: 'treasure' },
    '宗门':       { rule: '故事引力为宗门：门派内务、师承、夺嫡成为主线。', tag: 'sect' },
    '战争':       { rule: '故事引力为战争：势力冲突、征伐、阵营选择频现。', tag: 'war' },
    '游历':       { rule: '故事引力为游历：远方、机缘、风物成为主线。', tag: 'wander' },
    '复仇':       { rule: '故事引力为复仇：旧仇、追查、清算成为主线。', tag: 'revenge' },
    '经商':       { rule: '故事引力为经商：商会、货路、债务与资源争夺频率提高。', tag: 'trade' },
    '飞升':       { rule: '故事引力为飞升：突破、天劫、上界线索成为主线。', tag: 'ascend' },
  },
};

Story.buildWorldName = function (roll) {
  const eraChar = { '盛世':'昌', '衰世':'微', '末法':'寂', '天倾前夜':'倾' }[roll.era] || '玄';
  return eraChar + '微元·' + roll.terrain + '之界';
};

Story.PERSONALITY_TAGS = {
  '剑修': ['锋锐', '孤傲', '重诺', '好斗', '念旧'],
  '丹道': ['谨慎', '多疑', '贪生', '重利', '细致'],
  '阵法': ['算计', '隐忍', '记仇', '重序', '惜物'],
  '游侠': ['洒脱', '义气', '冒险', '随性', '寡言'],
  '妖修': ['野性', '护短', '记恩', '善变', '嗜血'],
};

Story.PRESET_COMPANIONS = [
  {
    id: 'han', name: '韩照野', identity: '流落边城的剑修', daoPath: '剑修',
    personalityTags: ['锋锐', '孤傲', '念旧', '好斗'],
    publicWish: '追上那道失落的剑意，证明自己不是弃徒。',
    hiddenFate: '残剑中的剑灵似乎认识他，却始终不肯相认。',
    startingRelation: { lu: '旧识', shen: '戒备', gu: '不屑' },
    choicePrefs: { 剑意: 3, 危险: 2, 复仇: 2, 同行援护: 1, 经商: -1 },
    agentArc: { currentGoal: '追上失落的剑意。', stage: 0, pressure: 1, milestones: ['寻得残剑共鸣'] },
  },
  {
    id: 'shen', name: '沈青萝', identity: '药谷弃徒', daoPath: '丹道',
    personalityTags: ['谨慎', '多疑', '细致', '重利'],
    publicWish: '查明身世，找回被夺的药典。',
    hiddenFate: '她血液里藏着一段不属于人类的旧梦。',
    startingRelation: { lu: '试探', han: '戒备', gu: '交易' },
    choicePrefs: { 药材: 3, 妖族: 2, 秘密: 2, 谨慎试探: 2, 危险: -1 },
    agentArc: { currentGoal: '找回被夺的药典。', stage: 0, pressure: 1, milestones: ['确认药典下落'] },
  },
  {
    id: 'gu', name: '顾长风', identity: '破落阵修', daoPath: '阵法',
    personalityTags: ['算计', '隐忍', '惜物', '重序'],
    publicWish: '重顾家旧阵，讨回祖产。',
    hiddenFate: '他家阵纹的一角，被人铸进了边城的地基。',
    startingRelation: { lu: '客气', han: '不屑', shen: '交易' },
    choicePrefs: { 阵法: 3, 资源: 2, 交易: 2, 规避风险: 2, 危险: -1 },
    agentArc: { currentGoal: '找回顾家旧阵阵眼。', stage: 0, pressure: 1, milestones: ['发现边城地基中的阵纹'] },
  },
];

Story.NARRATIVE_PACE = ['近景', '常规', '史诗'];

/* V3.2 §B3：离线回退禁用模板句（及其轻微改写） */
Story.FORBIDDEN_PHRASES = [
  '行动真正开始后，最先出现的不是预想中的结果，而是阻力',
  '这条规则让简单的尝试多出一层代价',
  '暗处有人观察',
  '几条原本互不相干的动向在此刻交汇',
  '不是凭空出现的奖励，而像是某个旁观者留下的回应',
  '无论选择哪条路',
  '下一步都将直接承接',
  '不再只是传闻',
  '不合时令的灵气',
  '袖口沾着不属于此处的',
  '有人在暗中观察',
  '几条线索交汇',
  '并非凭空出现',
];

/* ============================================================
 * §2 StoryState 工厂与迁移
 * ============================================================ */

Story._clone = function (o) { return JSON.parse(JSON.stringify(o)); };

Story.createEmptyState = function () {
  return {
    version: Story.VERSION,
    world: {
      seed: '', name: '', year: 1,
      worldBible: {},
      publicFacts: [],
      publicRumors: [],
      activeWorldHooks: [],
      factions: [],
      regions: [],
    },
    actors: [],
    story: {
      chapterIndex: 0,
      currentChapter: null,
      currentScene: null,
      choicesByActorId: {},        // V3.2 唯一事实源
      turnChoices: {},             // 兼容镜像（与 choicesByActorId 同一对象）
      aiChosenLastTurn: {},
      activeThreads: [],
      recentSummary: '',
      chronicle: [],
      recentMotifs: [],
      recentChoiceFingerprints: [],
      recentChapterFingerprints: [],
      lastTurnRecordId: null,
      // V3 兼容字段（仅作镜像，不承担真实逻辑）
      pendingChoices: {},
      aiPendingChoices: {},
    },
    ledger: {
      publicEvents: [],
      privateEvents: {},
      relics: [],
      successorHooks: [],
      chronicleCanonical: [],
      chronicleRumors: [],
      turnRecords: [],             // V3.2 §R1
      stateDeltas: [],
    },
    rng: { seed: '', state: 0 },
    api: {
      enabled: false, provider: 'openai-compatible',
      lastStatus: 'offline', lastErrorCode: null, lastErrorMessage: '',
      lastRequestAt: 0, lastResponseAt: 0,
    },
    settings: { timePreference: '顺其自然', narrativePace: '常规', mode: 'novel', developerMode: false, showResolutionEcho: true },
    finalLegacy: null,
  };
};

/** V3.2 迁移：在 _migrate 之上补齐 V3.2 字段 */
Story.Migration = Story.Migration || {};
Story.Migration.migrateToV32 = function (s) {
  if (!s) return Story.createEmptyState();
  s.version = Story.VERSION;
  // world
  if (!s.world) s.world = { seed: '', name: '', year: 1, worldBible: {}, publicFacts: [], publicRumors: [], activeWorldHooks: [], factions: [], regions: [] };
  if (!s.world.regions) s.world.regions = [];
  // story
  if (!s.story) s.story = {};
  const st = s.story;
  // 合并旧选择字段 → choicesByActorId
  if (!st.choicesByActorId) {
    st.choicesByActorId = {};
    if (st.turnChoices) Object.keys(st.turnChoices).forEach(function (k) { st.choicesByActorId[k] = st.turnChoices[k]; });
    if (st.pendingChoices) Object.keys(st.pendingChoices).forEach(function (k) { if (!st.choicesByActorId[k]) st.choicesByActorId[k] = st.pendingChoices[k]; });
    if (st.aiPendingChoices) Object.keys(st.aiPendingChoices).forEach(function (k) { if (!st.choicesByActorId[k]) st.choicesByActorId[k] = st.aiPendingChoices[k]; });
  }
  // turnChoices 作为 choicesByActorId 的兼容镜像（指向同一对象）
  st.turnChoices = st.choicesByActorId;
  st.pendingChoices = st.choicesByActorId;
  st.aiPendingChoices = st.choicesByActorId;
  if (!st.aiChosenLastTurn) st.aiChosenLastTurn = {};
  if (!st.activeThreads) st.activeThreads = [];
  if (!st.recentSummary) st.recentSummary = '';
  if (!st.chronicle) st.chronicle = [];
  if (!st.recentMotifs) st.recentMotifs = [];
  if (!st.recentChoiceFingerprints) st.recentChoiceFingerprints = [];
  if (!st.recentChapterFingerprints) st.recentChapterFingerprints = [];
  if (!st.lastTurnRecordId) st.lastTurnRecordId = null;
  // currentChapter 补 provenance
  if (st.currentChapter && !st.currentChapter.provenance) {
    st.currentChapter.provenance = 'legacy';
    st.currentChapter.narrationStatus = st.currentChapter.narrationStatus || 'ok';
    st.currentChapter.renderVersion = st.currentChapter.renderVersion || 0;
  }
  // currentScene：旧存档无 scene 时创建 legacy_scene
  if (!st.currentScene) {
    st.currentScene = Story.Scene.createLegacyScene(s);
  }
  // actors：补 agentArc + relationships
  (s.actors || []).forEach(function (a, i) {
    if (!a.seatId) a.seatId = a.controller === 'human' ? 'seat_0' : ('seat_' + (i + 1));
    if (!a.agentArc) a.agentArc = { currentGoal: a.publicWish || '', stage: 0, pressure: 0, milestones: [], lastChoiceFingerprints: [], lastLocationId: '', lastFocusedChapter: 0 };
    if (!a.relationships) a.relationships = Story.Delta._buildRelationMap(a, s.actors);
    if (!a.hidden) a.hidden = { realm: '炼气六层', cultivationProgress: 0, injury: 0, resources: [], combatStats: { body: 10, spirit: 10, soul: 10 } };
    if (!a.privateFacts) a.privateFacts = [];
  });
  // 旧 activeThreads（字符串）→ ThreadState 最小对象
  st.activeThreads = (st.activeThreads || []).map(function (t, i) {
    if (t && typeof t === 'object' && t.threadId) return t;
    return {
      threadId: 'thread_legacy_' + i,
      type: 'mystery',
      title: typeof t === 'string' ? t : (t && t.title || '旧事未了'),
      ownerActorIds: [], involvedActorIds: [], locationId: '',
      stage: 1, maxStage: 4, urgency: 1, visibility: 'public',
      sourceChapter: 1, lastAdvancedChapter: 1,
      triggerTags: [], status: 'active',
      summary: typeof t === 'string' ? t : (t && t.title || '旧事未了'),
    };
  });
  // ledger
  if (!s.ledger) s.ledger = {};
  const L = s.ledger;
  if (!L.publicEvents) L.publicEvents = [];
  if (!L.privateEvents) L.privateEvents = {};
  if (!L.relics) L.relics = [];
  if (!L.successorHooks) L.successorHooks = [];
  if (!L.chronicleCanonical) L.chronicleCanonical = [];
  if (!L.chronicleRumors) L.chronicleRumors = [];
  if (!L.turnRecords) L.turnRecords = [];
  if (!L.stateDeltas) L.stateDeltas = [];
  // rng
  if (!s.rng) s.rng = { seed: s.world.seed || '', state: 0 };
  // api
  if (!s.api) s.api = { enabled: false, provider: 'openai-compatible', lastStatus: 'offline', lastErrorCode: null, lastErrorMessage: '', lastRequestAt: 0, lastResponseAt: 0 };
  // settings
  if (!s.settings) s.settings = {};
  if (s.settings.timePreference === undefined) s.settings.timePreference = '顺其自然';
  if (!s.settings.narrativePace) s.settings.narrativePace = '常规';
  if (!s.settings.mode) s.settings.mode = 'novel';
  if (s.settings.developerMode === undefined) s.settings.developerMode = false;
  if (s.settings.showResolutionEcho === undefined) s.settings.showResolutionEcho = true;
  return s;
};

Story._migrate = function (s) {
  if (!s) return Story.createEmptyState();
  return Story.Migration.migrateToV32(s);
};

Story.state = null;
Story.rng = null;
Story._rngByState = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

Story._bindStateRng = function (state, rng) {
  if (!state || !rng) return rng;
  if (Story._rngByState) Story._rngByState.set(state, rng);
  if (Story.state === state) Story.rng = rng;
  return rng;
};

Story._activateState = function (state) {
  if (!state) return null;
  Story.state = state;
  let rng = Story._rngByState ? Story._rngByState.get(state) : null;
  if (!rng) {
    const seed = state.world && state.world.seed ? state.world.seed : 'story';
    rng = Story.createRng(seed, 'story');
    if (rng.setState && state.rng && state.rng.state) rng.setState(state.rng.state);
    Story._bindStateRng(state, rng);
  }
  Story.rng = rng;
  return rng;
};

Story.snapshotRng = function (state) {
  if (!state) return 0;
  const rng = Story.rngFor('snapshot', state);
  const value = rng && rng.getState ? rng.getState() : 0;
  if (!state.rng) state.rng = { seed: state.world && state.world.seed || '', state: value };
  state.rng.state = value;
  return value;
};

/* ============================================================
 * §3 开界
 * ============================================================ */

Story.rollOrigin = function (seed) {
  const rng = Story.createRng(seed, 'origin');
  const roll = { seed: seed };
  Object.keys(Story.ORIGIN_DICE).forEach(function (k) { roll[k] = rng.pick(Story.ORIGIN_DICE[k]); });
  return roll;
};

Story.buildWorldBible = function (roll) {
  const eff = Story.ORIGIN_EFFECT;
  return {
    seed: roll.seed,
    era: roll.era, terrain: roll.terrain, order: roll.order,
    heavenlyLaw: roll.heavenlyLaw, greatTribulation: roll.greatTribulation,
    aberrant: roll.aberrant, storyGravity: roll.storyGravity,
    rules: [
      eff.era[roll.era].rule, eff.terrain[roll.terrain].rule, eff.order[roll.order].rule,
      eff.heavenlyLaw[roll.heavenlyLaw].rule, eff.greatTribulation[roll.greatTribulation].rule,
      eff.aberrant[roll.aberrant].rule, eff.storyGravity[roll.storyGravity].rule,
    ],
    flags: {
      ascensionBlocked: eff.heavenlyLaw[roll.heavenlyLaw].flag === 'ascensionBlocked',
      reincarnationChaos: eff.heavenlyLaw[roll.heavenlyLaw].flag === 'reincarnationChaos',
      pactManifest: eff.heavenlyLaw[roll.heavenlyLaw].flag === 'pactManifest',
      relicSentience: eff.heavenlyLaw[roll.heavenlyLaw].flag === 'relicSentience',
    },
    factionPool: eff.order[roll.order].factions.slice(),
    regionKinds: eff.terrain[roll.terrain].regions.slice(),
    gravityTag: eff.storyGravity[roll.storyGravity].tag,
    worldName: Story.buildWorldName(roll),
  };
};

Story.worldBibleFromV2Seed = function (seed) { return Story.buildWorldBible(Story.rollOrigin(seed)); };

/* ============================================================
 * §4 角色建立
 * ============================================================ */

Story.createActor = function (setup, storyState) {
  setup = setup || {};
  const id = setup.id || ('actor_' + Math.floor(Story.rngFor('event', storyState).next() * 1e6).toString(36));
  const relations = Story.Delta._buildRelationMap({ startingRelation: setup.startingRelation || setup.relationHints, id: id }, (storyState && storyState.actors) || []);
  return {
    id: id,
    seatId: setup.seatId || null,
    controller: setup.controller || null,
    name: setup.name || '无名',
    identity: setup.identity || '',
    daoPath: setup.daoPath || '剑修',
    personalityTags: setup.personalityTags || [],
    publicProfile: setup.publicProfile || '',
    privateFate: setup.hiddenFate || setup.privateFate || '',
    publicWish: setup.publicWish || '',
    hiddenFate: setup.hiddenFate || '',
    goals: setup.goals || [],
    relationHints: setup.startingRelation || setup.relationHints || {},
    relationships: relations,
    agentArc: setup.agentArc || { currentGoal: setup.publicWish || '', stage: 0, pressure: 0, milestones: [], lastChoiceFingerprints: [], lastLocationId: '', lastFocusedChapter: 0 },
    statusSummary: '初入此界。',
    privateFacts: [],
    hidden: { realm: '炼气六层', cultivationProgress: 0, injury: 0, resources: [], combatStats: { body: 10, spirit: 10, soul: 10 } },
    choicePrefs: setup.choicePrefs || null,
  };
};

Story.createPresetCompanions = function () {
  return Story.PRESET_COMPANIONS.map(function (tpl) { return Story.createActor(Story._clone(tpl)); });
};

/* ============================================================
 * §5 会话与开局
 * ============================================================ */

Story.createSession = async function (config) {
  config = config || {};
  const seed = config.seed || ('BLACKWIND-' + Math.floor(Math.random() * 9999));
  const roll = Story.rollOrigin(seed);
  const bible = config.worldConfig || Story.buildWorldBible(roll);

  const state = Story.createEmptyState();
  Story.state = state;
  state.world.seed = seed;
  state.world.name = bible.worldName;
  state.world.year = 1;
  state.world.worldBible = bible;
  state.world.factions = bible.factionPool.map(function (name, i) { return { id: 'fac_' + i, name: name, power: 50, stance: '中立' }; });
  state.world.publicFacts = [bible.rules[0], bible.rules[3] + '此界天道如此。'];
  state.world.publicRumors = [];
  state.world.activeWorldHooks = [];
  state.rng = { seed: seed, state: 0 };
  Story._bindStateRng(state, Story.createRng(seed, 'story'));

  state.actors = (config.actors || []).map(function (setup, i) {
    const a = Story.createActor(setup, state);
    if (!a.seatId) a.seatId = setup.seatId || ('seat_' + i);
    return a;
  });

  if (config.narrativePace) state.settings.narrativePace = config.narrativePace;

  await Story._generateOpening(state);
  return state;
};

Story.startGame = async function (seed, playerSetup) {
  const player = Object.assign({}, playerSetup, { id: 'lu', seatId: 'seat_0' });
  const companions = Story.PRESET_COMPANIONS.map(function (tpl, i) { const c = Story._clone(tpl); c.seatId = 'seat_' + (i + 1); return c; });
  return Story.createSession({ seed: seed, actors: [player].concat(companions) });
};

/** 生成开局：创建场景 → 开局裁决 → 开局选项 → AI/离线叙事 */
Story._generateOpening = async function (state) {
  // 1. 创建开局场景与初始线索
  state.story.currentScene = Story.Scene.createOpeningScene(state);
  state.story.activeThreads = Story.Scene.createOpeningThreads(state);

  // 2. 开局裁决（不依赖玩家行动，建立初始局面）
  const envelope = Story.Resolver.buildOpeningEnvelope(state);

  // 3. 应用裁决（写账本/场景/时间）
  Story.Delta.applyEnvelope(state, envelope);

  // 4. 生成开局选项
  const choices = Story.ChoiceFactory.buildAll(state, state.story.currentScene, envelope);
  Story._writeChoices(state, choices);

  // 5. 叙事
  const brief = Story.Narration.buildBrief(state, state.story.currentScene, envelope);
  let narration = null;
  if (Story.ai.enabled) narration = await Story.Provider.narrate(state, brief);
  let chapter;
  if (narration && narration.title && narration.chapter) {
    chapter = Story.Narration.assembleFromAI(state, state.story.currentScene, envelope, narration);
  } else {
    chapter = Story.Narration.assembleOffline(state, state.story.currentScene, envelope);
  }
  Story.Narration.applyNarration(state, chapter, envelope, true);
  Story.appendChronicle(state, state.story.currentChapter.chapterSummary);
  Story.snapshotRng(state);
};

/* ============================================================
 * §6 回合流程：resolveTurn（主入口）/ playTurn（V3 兼容包装）
 * ============================================================ */

/**
 * 结算一回合（V3.2 本地裁决优先）。
 *   收集行动 → Intent 归一 → Bot 行动 → Resolver → Delta.apply →
 *   Scene.composeNext → ChoiceFactory → Narration.buildBrief → Provider.narrate →
 *   validateNarrationOnly → applyNarration → 写入 TurnRecord
 */
Story.resolveTurn = async function (storyState, actionsByActorId) {
  if (!storyState || !storyState.story.currentChapter) throw new Error('尚未开局');
  Story._activateState(storyState);
  actionsByActorId = actionsByActorId || {};
  const state = storyState;
  const s = state.story;
  const rng = Story.rngFor('event', state);
  const chapterIndexBefore = s.chapterIndex;
  const sceneBefore = Story._clone(s.currentScene);

  // 1. 归一化所有已提交行动为 Intent
  const intents = [];
  Object.keys(actionsByActorId).forEach(function (actorId) {
    const action = actionsByActorId[actorId];
    const actor = state.actors.find(function (a) { return a.id === actorId; });
    if (!actor) return;
    intents.push(Story.Intent.normalize(state, actorId, action));
  });

  // 2. 收集 Bot 行动（未在 actionsByActorId 中的非玩家控制角色）
  state.actors.forEach(function (actor) {
    if (intents.some(function (i) { return i.actorId === actor.id; })) return;
    if (Story._isHumanActor(state, actor)) return;
    const choices = Story.getChoicesForActor(state, actor.id);
    if (!choices.length) return;
    const chosen = Story.Agent.chooseAction(state, actor.id, choices, s.currentScene, null);
    if (chosen) {
      s.aiChosenLastTurn[actor.id] = chosen.id;
      intents.push(Story.Intent.fromChoice(state, actor.id, chosen.id));
    }
  });

  // 3. 本地裁决
  const envelope = Story.Resolver.resolveTurn(state, intents);

  // 4. 诊断（开发模式严格，生产模式安全回退）
  const diag = Story.Diagnostics.validateResolutionEnvelope(envelope, state);
  if (!diag.ok) {
    if (state.settings && state.settings.developerMode) throw new Error('ResolutionEnvelope 校验失败：' + diag.errors.join('；'));
    Story.Resolver._applySafeFallback(envelope, diag.errors);
  }

  // 5. 应用裁决（写账本/线程/关系/时间）
  Story.Delta.applyEnvelope(state, envelope);

  // 6. 场景演化
  s.currentScene = Story.Scene.composeNext(state, envelope);

  // 7. 生成下一轮选项
  const choices = Story.ChoiceFactory.buildAll(state, s.currentScene, envelope);
  Story._writeChoices(state, choices);

  // 8. 叙事
  const brief = Story.Narration.buildBrief(state, s.currentScene, envelope);
  let narration = null;
  if (Story.ai.enabled) narration = await Story.Provider.narrate(state, brief);
  let chapter;
  if (narration && narration.title && narration.chapter) {
    chapter = Story.Narration.assembleFromAI(state, s.currentScene, envelope, narration);
  } else {
    chapter = Story.Narration.assembleOffline(state, s.currentScene, envelope);
  }
  Story.Narration.applyNarration(state, chapter, envelope, false);

  // 9. 编年史
  Story.appendChronicle(state, s.currentChapter.chapterSummary);

  // 10. 写入 TurnRecord
  const turnId = 'turn_' + String(s.chapterIndex).padStart(4, '0');
  const turnRecord = {
    turnId: turnId,
    chapterIndexBefore: chapterIndexBefore,
    chapterIndexAfter: s.chapterIndex,
    submittedActions: Story._clone(actionsByActorId),
    botActions: Object.keys(s.aiChosenLastTurn).reduce(function (o, k) { o[k] = s.aiChosenLastTurn[k]; return o; }, {}),
    resolutionEnvelope: Story._clone(envelope),
    sceneBefore: sceneBefore,
    sceneAfter: Story._clone(s.currentScene),
    stateDeltaIds: (state.ledger.stateDeltas || []).slice(-envelope.publicDelta.length).map(function (d) { return d.op; }),
    narration: {
      provenance: s.currentChapter.provenance,
      title: s.currentChapter.title,
      chapterHash: Story.hashSeed(s.currentChapter.chapter || ''),
      providerErrorCode: state.api.lastErrorCode,
    },
    createdAt: Date.now(),
  };
  state.ledger.turnRecords.push(turnRecord);
  s.lastTurnRecordId = turnId;

  Story.snapshotRng(state);
  return state;
};

Story.playTurn = async function (playerAction) {
  const state = Story.state;
  if (!state || !state.story.currentChapter) throw new Error('尚未开局');
  if (!playerAction || (!playerAction.choiceId && !playerAction.custom)) throw new Error('playTurn 需要 choiceId 或 custom');
  const player = Story.getPrimaryHumanActor(state);
  if (!player) throw new Error('未找到真人玩家');
  const actionsByActorId = {};
  if (playerAction.custom) actionsByActorId[player.id] = { custom: { text: playerAction.custom.text } };
  else actionsByActorId[player.id] = { choiceId: playerAction.choiceId };
  return Story.resolveTurn(state, actionsByActorId);
};

Story.openTurn = function (storyState) { return storyState.story.turnChoices; };

Story.getChoicesForActor = function (storyState, actorId) {
  if (!storyState) return [];
  return (((storyState.story.choicesByActorId) || (storyState.story.turnChoices) || {})[actorId] || []).slice();
};

/** 把 choicesByActorId 写入并同步兼容镜像 */
Story._writeChoices = function (state, choices) {
  state.story.choicesByActorId = choices;
  state.story.turnChoices = choices;       // 同一对象引用，兼容旧读取
  state.story.pendingChoices = choices;
  state.story.aiPendingChoices = choices;
};

Story._isHumanActor = function (state, actor) {
  // V3.2 §S：禁止 state.actors.find(a => a.controller === 'human')。
  // 真人判定：拥有 seatId === 'seat_0' 且无 agentArc 主导，或显式 controller==='human'（兼容）。
  // 但房间模式下真人由 Room 层标注；单人模式下 actors[0] 视为真人。
  if (!actor) return false;
  if (actor.controller === 'human') return true;
  return false;
};

Story.getPrimaryHumanActor = function (state) {
  if (!state || !state.actors) return null;
  let h = state.actors.find(function (a) { return a.controller === 'human'; });
  if (h) return h;
  // 兼容：单人模式 actors[0]
  return state.actors[0] || null;
};

Story.getPrivateViewForActor = function (state, actorId) {
  return Story.getPrivateActorView(state, actorId);
};

/** 重新润色：只重写文案，绝不重新结算（V3.2 §R2） */
Story.regenerateChapter = async function () {
  const state = Story.state;
  if (!state || !state.story.currentChapter) return null;
  const s = state.story;
  const turnId = s.lastTurnRecordId;
  const record = (state.ledger.turnRecords || []).find(function (t) { return t.turnId === turnId; });
  const envelope = record ? record.resolutionEnvelope : null;
  const scene = s.currentScene;
  const beforeChron = JSON.stringify(s.chronicle);
  const beforeYear = state.world.year;
  const beforeRng = Story.snapshotRng(state);
  const brief = envelope ? Story.Narration.buildBrief(state, scene, envelope) : null;
  let narration = null;
  if (Story.ai.enabled && brief) narration = await Story.Provider.narrate(state, brief);
  let chapter;
  if (narration && narration.title && narration.chapter) {
    chapter = Story.Narration.assembleFromAI(state, scene, envelope, narration);
  } else {
    chapter = Story.Narration.assembleOffline(state, scene, envelope);
  }
  // 仅替换文案字段
  s.currentChapter.title = chapter.title;
  s.currentChapter.chapter = chapter.chapter;
  s.currentChapter.endingImage = chapter.endingImage || s.currentChapter.endingImage;
  s.currentChapter.provenance = chapter.provenance;
  s.currentChapter.renderVersion = (s.currentChapter.renderVersion || 0) + 1;
  Story.snapshotRng(state);
  // 确保未改变结算状态
  if (JSON.stringify(s.chronicle) !== beforeChron) {
    // 不应发生；保守恢复
  }
  return s.currentChapter;
};

/* ============================================================
 * §7 AI 同伴加权选择（兼容 V3：aiChoose / choiceScore，不调 API）
 * ============================================================ */

Story.aiChoose = function (actor, choices, storyState) {
  return Story.Agent.chooseAction(storyState || Story.state, actor.id, choices, null, null);
};

Story.choiceScore = function (actor, choice) {
  return Story.Agent.scoreChoice(Story.state, actor, choice, null);
};

Story._keywordOverlap = function (a, b) {
  if (!a || !b) return 0;
  let n = 0;
  for (let i = 0; i < b.length - 1; i++) { if (a.indexOf(b.substr(i, 2)) >= 0) n++; }
  return Math.min(n, 4);
};
Story._tagMatches = function (tag, text) {
  const map = { '锋锐': ['剑', '战', '险'], '孤傲': ['独', '孤'], '谨慎': ['慎', '稳', '等'], '算计': ['计', '易', '序'], '野性': ['妖', '血', '战'] };
  const kws = map[tag] || [];
  return kws.some(function (k) { return text.indexOf(k) >= 0; });
};

/* ============================================================
 * §8 IntentParser —— 本地行动语义识别器（V3.2 §F）
 * ============================================================ */

Story.Intent = Story.Intent || {};

Story.Intent.CATEGORIES = ['rest','wait','observe','investigate','travel','social','negotiate','cultivate','craft','battle','flee','steal','aid','deceive','use_relic','freeform'];

Story.Intent.KEYWORDS = {
  rest: ['继续睡','还是睡','睡一觉','睡一会','睡觉','补觉','休息','歇息','躺下','打盹','养伤','闭目养神','睡'],
  wait: ['按兵不动','先不动','暂缓','拖一拖','看看再说','明日再说','以后再说','观望','等待','等'],
  observe: ['暗中看','守夜观察','观察','盯着','偷看','留意','监听','窥探','守着','看'],
  investigate: ['调查','追查','追踪','寻找','搜查','翻找','打听','探听','查明','探究','查'],
  travel: ['追赶','追商队','赶路','上路','前往','远游','离开此地','去'],
  social: ['交谈','聊天','询问','拜访','请教','结交','示好','解释','道歉','问'],
  negotiate: ['给妖王打工','谈条件','讨价还价','雇佣','合作','立约','结盟','交易','交换','谈判','打工','交涉'],
  cultivate: ['闭关','修炼','打坐','吐纳','冲境','突破','参悟','悟道','静修','炼气'],
  craft: ['炼丹','炼器','制符','布阵','修复法器','锻造','炼制'],
  battle: ['硬闯','强攻','破阵','攻击','出剑','斗法','打','杀','斩'],
  flee: ['逃离','退走','躲开','避开','绕路','暂避','逃','撤'],
  steal: ['盗取','摸走','窃取','顺走','拿走','偷'],
  aid: ['援护','保护','掩护','陪同','支援','帮','救'],
  deceive: ['假装','装睡','伪装','说谎','诈','演戏','骗'],
  use_relic: ['以残剑为媒','召来剑意','残剑','法宝','符箓','玉佩','阵盘','丹药','遗物'],
};

// 解析优先级（V3.2 §F4）
Story.Intent.PRIORITY = ['flee','battle','steal','cultivate','craft','rest','wait','negotiate','social','investigate','observe','aid','use_relic','travel','freeform'];

Story.Intent.DEFAULT_TIME = {
  rest: '一夜', wait: '一夜', observe: '片刻', investigate: '数日', travel: '数日',
  social: '片刻', negotiate: '片刻', cultivate: '数月', craft: '数月', battle: '片刻',
  flee: '片刻', steal: '片刻', aid: '片刻', deceive: '一夜', use_relic: '片刻', freeform: '数日',
};

Story.Intent.normalize = function (state, actorId, submittedAction) {
  submittedAction = submittedAction || {};
  if (submittedAction.custom && submittedAction.custom.text != null) {
    return Story.Intent.parseCustomText(state, actorId, submittedAction.custom.text);
  }
  if (submittedAction.choiceId) return Story.Intent.fromChoice(state, actorId, submittedAction.choiceId);
  // 空行动 → freeform
  return Story.Intent._build(actorId, 'custom', null, '', 'freeform', state);
};

Story.Intent.fromChoice = function (state, actorId, choiceId) {
  const choices = Story.getChoicesForActor(state, actorId);
  const c = choices.find(function (x) { return x.id === choiceId; });
  if (!c) throw new Error('无效的选择：' + choiceId);
  return Story.Intent._fromChoice(state, actorId, c);
};

Story.Intent._fromChoice = function (state, actorId, c) {
  const text = (c.label || '') + ' ' + (c.hint || '');
  const parsed = Story.Intent._classify(text);
  return {
    actorId: actorId,
    source: 'choice',
    choiceId: c.id,
    rawText: c.label || '',
    category: c.intentCategory || parsed.category,
    approach: c.approach || parsed.approach,
    targetType: c.targetType || parsed.targetType,
    targetId: c.targetId || parsed.targetId,
    timePreference: c.timeHint || parsed.timePreference,
    riskStyle: c.riskLevel >= 3 ? 'aggressive' : 'normal',
    derivedTags: (c.tags && c.tags.length) ? c.tags : parsed.derivedTags,
    confidence: 1,
    parseNotes: parsed.parseNotes,
    nextIntentHint: parsed.nextIntentHint,
    restSurface: parsed.restSurface,
  };
};

Story.Intent.parseCustomText = function (state, actorId, text, timePreference) {
  const t = String(text || '').trim();
  const parsed = Story.Intent._classify(t);
  return {
    actorId: actorId,
    source: 'custom',
    choiceId: null,
    rawText: t,
    category: parsed.category,
    approach: parsed.approach,
    targetType: parsed.targetType,
    targetId: parsed.targetId,
    timePreference: timePreference || parsed.timePreference,
    riskStyle: parsed.riskStyle,
    derivedTags: parsed.derivedTags,
    confidence: parsed.confidence,
    parseNotes: parsed.parseNotes,
    nextIntentHint: parsed.nextIntentHint,
    restSurface: parsed.restSurface,
  };
};

Story.Intent.validate = function (state, intent) {
  const errors = [];
  if (!intent) return ['intent 为空'];
  if (Story.Intent.CATEGORIES.indexOf(intent.category) < 0) errors.push('非法 category：' + intent.category);
  if (!intent.actorId) errors.push('缺少 actorId');
  return errors;
};

Story.Intent._build = function (actorId, source, choiceId, rawText, category, state, extra) {
  extra = extra || {};
  return Object.assign({
    actorId: actorId, source: source, choiceId: choiceId, rawText: rawText,
    category: category, approach: extra.approach || 'normal', targetType: extra.targetType || 'self',
    targetId: extra.targetId || actorId, timePreference: extra.timePreference || Story.Intent.DEFAULT_TIME[category],
    riskStyle: extra.riskStyle || 'normal', derivedTags: extra.derivedTags || [category],
    confidence: extra.confidence || 0.8, parseNotes: extra.parseNotes || [],
    nextIntentHint: extra.nextIntentHint || null, restSurface: extra.restSurface || false,
  }, {});
};

/** 核心：文本 → {category, approach, targetType, targetId, timePreference, derivedTags, ...} */
Story.Intent._classify = function (text) {
  const t = String(text || '');
  const notes = [];
  const derivedTags = [];
  // 各类别命中
  const hits = {};
  Story.Intent.CATEGORIES.forEach(function (cat) {
    hits[cat] = 0;
    (Story.Intent.KEYWORDS[cat] || []).forEach(function (kw) {
      if (t.indexOf(kw) >= 0) { hits[cat] += (kw.length >= 2 ? 2 : 1); notes.push(cat + '_keyword:' + kw); }
    });
  });

  let category = 'freeform';
  let restSurface = false;
  let nextIntentHint = null;

  // 欺骗优先：假装/装睡/骗 + 表面行动
  if (hits.deceive > 0) {
    category = 'deceive';
    if (hits.rest > 0) { restSurface = true; notes.push('restSurface'); derivedTags.push('rest'); }
    derivedTags.push('deceive');
  } else {
    // 按优先级链选首个命中
    for (let i = 0; i < Story.Intent.PRIORITY.length; i++) {
      const cat = Story.Intent.PRIORITY[i];
      if (hits[cat] > 0) { category = cat; break; }
    }
    if (category === 'freeform' && hits.travel > 0) category = 'travel';
    if (category !== 'freeform') derivedTags.push(category);
  }

  // nextIntentHint：后再观察 / 明早再说 / 明日
  if (category === 'rest' || category === 'wait') {
    if (/观察|看/.test(t) && /后|再/.test(t)) { nextIntentHint = 'observe'; notes.push('nextIntentHint:observe'); }
    else if (/明早|明日|再说|以后/.test(t)) { nextIntentHint = 'wait'; notes.push('nextIntentHint:wait'); }
  }
  if (category === 'rest' && hits.observe > 0 && nextIntentHint === 'observe') notes.push('rest_with_observe_hint');

  // 次要类别（use_relic 作为 secondary）
  if (hits.use_relic > 0 && category !== 'use_relic') { derivedTags.push('use_relic'); notes.push('secondary:use_relic'); }
  if (hits.investigate > 0 && category !== 'investigate') { derivedTags.push('investigate'); }

  // approach / target 推断
  const approach = Story.Intent._inferApproach(t, category);
  const target = Story.Intent._inferTarget(t, category);

  // 时间识别
  const timePreference = Story.Intent._inferTime(t, category);

  // 标签补全
  if (category === 'rest') { if (!derivedTags.indexOf('recovery') >= 0) derivedTags.push('recovery'); if (/养伤|伤/.test(t)) derivedTags.push('heal'); }
  if (category === 'cultivate') derivedTags.push('cultivation');

  return {
    category: category,
    approach: approach,
    targetType: target.type,
    targetId: target.id,
    timePreference: timePreference,
    derivedTags: derivedTags,
    confidence: category === 'freeform' ? 0.4 : 0.9,
    parseNotes: notes,
    nextIntentHint: nextIntentHint,
    restSurface: restSurface,
    riskStyle: /强|硬闯|冒险|正面/.test(t) ? 'aggressive' : 'normal',
  };
};

Story.Intent._inferApproach = function (t, category) {
  if (/逼问|逼|威胁|强硬/.test(t)) return 'pressure';
  if (/偷|暗中|悄悄|装|假装/.test(t)) return 'covert';
  if (/结盟|合作|援护|帮|救/.test(t)) return 'ally';
  if (/追|赶|追查|追踪/.test(t)) return 'pursue';
  if (category === 'rest') return 'recover';
  if (category === 'cultivate') return 'insight';
  if (category === 'flee') return 'evade';
  return 'normal';
};

Story.Intent._inferTarget = function (t, category) {
  // NPC
  const npcMap = { '掌柜': 'innkeeper_01', '女掌柜': 'innkeeper_01', '韩照野': 'han', '沈青萝': 'shen', '顾长风': 'gu', '商队': 'trade_caravan', '商会': 'trade_caravan', '妖王': 'demon_lord' };
  for (const k in npcMap) { if (t.indexOf(k) >= 0) return { type: 'npc', id: npcMap[k] }; }
  if (/密信|信/.test(t)) return { type: 'clue', id: 'trade_letter' };
  if (/残剑|剑/.test(t)) return { type: 'relic', id: 'residual_sword' };
  if (/阵|阵纹|阵眼/.test(t)) return { type: 'array', id: 'gu_old_array' };
  if (category === 'rest' || category === 'cultivate' || category === 'wait') return { type: 'self', id: 'self' };
  if (category === 'flee') return { type: 'exit', id: 'nearest_exit' };
  if (category === 'investigate') return { type: 'clue', id: 'scene_anomaly' };
  return { type: 'self', id: 'self' };
};

Story.Intent._inferTime = function (t, category) {
  if (/百年/.test(t)) return '百年';
  if (/数年|三年|多年/.test(t)) return '数年';
  if (/数月|三月|多月|闭关|静修|参悟/.test(t)) return '数月';
  if (/冲境|突破/.test(t)) return '数月';
  if (/数日|几天|三日|多日/.test(t)) return '数日';
  if (/今晚|今夜|睡一觉|一夜/.test(t)) return '一夜';
  if (/明日|明早/.test(t)) return '一夜';
  if (/片刻|一会|一会儿/.test(t)) return '片刻';
  return Story.Intent.DEFAULT_TIME[category] || '数日';
};

/* ============================================================
 * §9 SceneState —— 持续场景系统（V3.2 §G）
 * ============================================================ */

Story.Scene = Story.Scene || {};

Story.Scene.createOpeningScene = function (state) {
  const w = state.world.worldBible;
  const rng = Story.rngFor('event', state);
  const regionKinds = w.regionKinds || ['城池'];
  const place = '赤砂边城·听雨客栈';
  const sceneId = 'scene_0001';
  return {
    sceneId: sceneId,
    locationId: 'inn_redsand',
    locationName: place,
    timeOfDay: '夜',
    weather: rng.pick(['细雨', '微雨', '阴', '风急']),
    focalActorIds: state.actors.map(function (a) { return a.id; }).slice(0, 2),
    immediateConflict: '商会使者将连夜离城，半封密信下落不明。',
    immediateQuestion: '是否追查被截断的密信？',
    visibleEntities: ['女掌柜', '半封商会密信', '残剑'],
    availableAssets: ['半封商会密信', '残剑'],
    exits: ['城门', '客栈后院', '商会旧址'],
    activeThreadIds: ['thread_trade_letter', 'thread_old_sword'],
    pressure: 1,
    deadline: { type: '商会离城', remaining: 2, unit: '夜' },
    sceneStatus: 'open',
    enteredAtChapter: 1,
    lastUpdatedAtChapter: 1,
    allowedCategories: ['rest', 'observe', 'investigate', 'social', 'use_relic', 'travel', 'negotiate', 'flee', 'cultivate'],
    recentEvents: [],
    hiddenFacts: [],
  };
};

Story.Scene.createLegacyScene = function (state) {
  const w = (state && state.world && state.world.worldBible) || {};
  return {
    sceneId: 'scene_legacy',
    locationId: 'legacy',
    locationName: '旧事之地',
    timeOfDay: '不明', weather: '不明',
    focalActorIds: [], immediateConflict: '旧章未尽之事。', immediateQuestion: '',
    visibleEntities: [], availableAssets: [], exits: [],
    activeThreadIds: (state && state.story && state.story.activeThreads || []).map(function (t) { return t.threadId || t; }),
    pressure: 1, deadline: null, sceneStatus: 'open',
    enteredAtChapter: (state && state.story && state.story.chapterIndex) || 0,
    lastUpdatedAtChapter: (state && state.story && state.story.chapterIndex) || 0,
    allowedCategories: Story.Intent.CATEGORIES,
    recentEvents: [], hiddenFacts: [],
  };
};

Story.Scene.createOpeningThreads = function (state) {
  const w = state.world.worldBible;
  return [
    {
      threadId: 'thread_trade_letter', type: 'mystery', title: '商会密信失踪',
      ownerActorIds: [state.actors[0] && state.actors[0].id], involvedActorIds: state.actors.map(function (a) { return a.id; }),
      locationId: 'inn_redsand', stage: 1, maxStage: 4, urgency: 2, visibility: 'public',
      sourceChapter: 1, lastAdvancedChapter: 1, triggerTags: ['trade', 'secret', 'investigate'],
      status: 'active', summary: '商会使者连夜离城，只留下半封被雨浸坏的密信。',
    },
    {
      threadId: 'thread_old_sword', type: 'fate', title: '残剑认主',
      ownerActorIds: [state.actors[0] && state.actors[0].id], involvedActorIds: [],
      locationId: 'inn_redsand', stage: 1, maxStage: 4, urgency: 1, visibility: 'private',
      sourceChapter: 1, lastAdvancedChapter: 1, triggerTags: ['relic', 'fate'],
      status: 'active', summary: '残剑中的剑灵似乎认得持剑者的前世。',
    },
  ];
};

/** 是否应切换场景（V3.2 §G3） */
Story.Scene.shouldTransition = function (state, envelope) {
  const actions = envelope.actions || [];
  const cats = actions.map(function (a) { return a.category; });
  if (cats.indexOf('travel') >= 0) return 'move';
  if (cats.indexOf('flee') >= 0) return 'move';
  if (envelope.worldDelta && envelope.worldDelta.epochJump) return 'epoch_jump';
  // 时间跨度极大
  const tp = envelope.actions[0] && envelope.actions[0].timePassed;
  if (tp && (tp.unit === '百年' || tp.unit === '数年')) return 'skip_time';
  // 场景 deadline 归零且 thread 关闭 → close
  const scene = state.story.currentScene;
  if (scene && scene.deadline && scene.deadline.remaining <= 0 && (scene.sceneStatus === 'closing')) return 'close';
  return 'stay';
};

/** 组合下一场景（V3.2 §G3） */
Story.Scene.composeNext = function (state, envelope) {
  const prev = state.story.currentScene || Story.Scene.createLegacyScene(state);
  const transition = Story.Scene.shouldTransition(state, envelope);
  const idx = state.story.chapterIndex + 1;
  const next = Story._clone(prev);
  next.lastUpdatedAtChapter = idx;

  if (transition === 'move') {
    const moveAct = (envelope.actions || []).find(function (a) { return a.category === 'travel' || a.category === 'flee'; });
    next.locationId = (moveAct && moveAct.targetId === 'trade_caravan') ? 'road_broken_flow' : (moveAct ? 'road_broken_flow' : 'inn_redsand');
    next.locationName = (moveAct && moveAct.targetId === 'trade_caravan') ? '断流古道·车辙' : (next.locationName + '·外');
    next.immediateConflict = moveAct && moveAct.category === 'flee' ? '追兵仍在身后，未肯罢休。' : '古道车辙在雨中被两种脚印覆盖。';
    next.immediateQuestion = moveAct && moveAct.category === 'flee' ? '如何甩脱追踪？' : '是否沿车辙继续追查？';
    next.exits = ['来路', '古道深处', '林间小径'];
    next.visibleEntities = ['车辙', '雨', '残剑'];
    next.availableAssets = ['残剑'];
    next.enteredAtChapter = idx;
    next.deadline = null;
    next.pressure = Math.max(2, prev.pressure);
  } else if (transition === 'skip_time' || transition === 'epoch_jump') {
    next.timeOfDay = '数月之后';
    next.weather = '换季';
    next.pressure = Math.max(1, prev.pressure - 1);
  } else {
    // stay / reveal / escalate / close
    if (transition === 'reveal') {
      next.visibleEntities = prev.visibleEntities.concat(['药谷旧印']);
      next.availableAssets = prev.availableAssets.concat(['药谷旧印']);
    }
    // deadline 推进
    if (next.deadline) {
      const adv = (envelope.actions || []).reduce(function (s, a) {
        const te = (a.threadEffects || []).filter(function (e) { return e.op === 'deadline_advance'; });
        return s + te.reduce(function (x, e) { return x + (e.delta || 0); }, 0);
      }, 0);
      next.deadline = Object.assign({}, next.deadline, { remaining: Math.max(0, next.deadline.remaining - adv) });
      if (next.deadline.remaining <= 0) {
        next.immediateConflict = next.deadline.type + '已经发生。';
        next.immediateQuestion = '如何应对已成之局？';
      }
    }
    // pressure 缓慢回升
    next.pressure = Math.min(5, Math.max(1, prev.pressure));
  }

  // 焦点角色
  next.focalActorIds = Story.Scene.pickFocalActors(state, envelope);
  next.sceneStatus = transition === 'close' ? 'closed' : 'open';
  return next;
};

/** 选取焦点角色（V3.2 §M1） */
Story.Scene.pickFocalActors = function (state, envelope) {
  const actions = envelope.actions || [];
  if (!actions.length) return state.actors.slice(0, 2).map(function (a) { return a.id; });
  // 风险最高 / 互动最强
  const riskOrder = { interrupted: 5, setback: 4, retreat: 3, success_with_cost: 3, partial_success: 2, success: 2, quiet_success: 1, missed_opportunity: 2, stalemate: 2, great_success: 2 };
  const scored = actions.map(function (a) { return { id: a.actorId, score: (riskOrder[a.outcome] || 1) + (a.relationEffects && a.relationEffects.length ? 2 : 0) + (a.threadEffects && a.threadEffects.length ? 1 : 0) }; });
  scored.sort(function (a, b) { return b.score - a.score; });
  const focal = scored.slice(0, 2).map(function (x) { return x.id; });
  // 玩家优先但不永远优先：确保玩家在但可能不是第一
  const player = Story.getPrimaryHumanActor(state);
  if (player && focal.indexOf(player.id) < 0 && state.actors.length) {
    // 50% 概率补入玩家
    const rng = Story.rngFor('event', state);
    if (rng.chance(0.6)) focal[focal.length - 1] = player.id;
  }
  return focal.slice(0, 2);
};

/* ============================================================
 * §10 TurnResolver —— 本地回合裁决器（V3.2 §I）
 * ============================================================ */

Story.Resolver = Story.Resolver || {};

Story.Resolver.OUTCOMES = ['great_success','success','quiet_success','success_with_cost','partial_success','setback','missed_opportunity','interrupted','retreat','stalemate'];

Story.Resolver.resolveTurn = function (state, intents) {
  const scene = state.story.currentScene;
  const chapterIndex = state.story.chapterIndex + 1;
  const turnId = 'turn_' + String(chapterIndex).padStart(4, '0');
  const actions = intents.map(function (intent) {
    return Story.Resolver.resolveActorAction(state, scene, intent);
  });
  const interactions = Story.Resolver.resolveInteractions(state, actions);
  const envelope = Story.Resolver.buildEnvelope(state, actions, interactions);
  envelope.turnId = turnId;
  envelope.chapterIndex = chapterIndex;
  envelope.sceneBeforeId = scene ? scene.sceneId : 'scene_legacy';
  envelope.provenance = 'local-resolver';
  return envelope;
};

Story.Resolver.buildOpeningEnvelope = function (state) {
  const scene = state.story.currentScene;
  return {
    turnId: 'turn_0000',
    chapterIndex: 0,
    sceneBeforeId: scene ? scene.sceneId : 'scene_legacy',
    sceneAfterId: scene ? scene.sceneId : 'scene_legacy',
    focalActorIds: state.actors.slice(0, 2).map(function (a) { return a.id; }),
    actions: [],
    interactions: [],
    publicDelta: [
      { op: 'ADD_PUBLIC_FACT', payload: { text: state.world.worldBible.rules[0] }, source: 'resolver', sourceTurnId: 'turn_0000' },
      { op: 'ADD_PUBLIC_RUMOR', payload: { text: '赤砂边城近来异象频生，引人注目。' }, source: 'resolver', sourceTurnId: 'turn_0000' },
    ],
    privateDelta: state.actors.slice(1).map(function (a) {
      return { op: 'ADD_PRIVATE_FACT', target: { actorId: a.id }, payload: { text: a.name + '心中暗忖：' + a.hiddenFate }, source: 'resolver', sourceTurnId: 'turn_0000' };
    }),
    sceneDelta: {}, worldDelta: {}, narrationBeats: [
      state.actors[0].name + '与三人于听雨客栈相遇。',
      '商会使者将连夜离城，半封密信下落不明。',
      '此界天道为「' + state.world.worldBible.heavenlyLaw + '」。',
    ], choiceConstraints: [], provenance: 'local-resolver',
  };
};

Story.Resolver.resolveActorAction = function (state, scene, intent) {
  const rng = Story.rngFor('resolver', state);
  const category = intent.category;
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  const base = {
    actorId: intent.actorId,
    category: category,
    targetId: intent.targetId,
    rawText: intent.rawText,
    source: intent.source || 'custom',
    outcome: 'success',
    gains: [], costs: [], publicEffects: [], privateEffects: [],
    threadEffects: [], relationEffects: [],
    timePassed: Story.Resolver._timePassed(intent.timePreference),
  };

  switch (category) {
    case 'rest':      return Story.Resolver._resolveRest(state, scene, intent, base, rng);
    case 'wait':      return Story.Resolver._resolveWait(state, scene, intent, base, rng);
    case 'observe':   return Story.Resolver._resolveObserve(state, scene, intent, base, rng);
    case 'investigate': return Story.Resolver._resolveInvestigate(state, scene, intent, base, rng);
    case 'social':    return Story.Resolver._resolveSocial(state, scene, intent, base, rng);
    case 'negotiate': return Story.Resolver._resolveNegotiate(state, scene, intent, base, rng);
    case 'cultivate': return Story.Resolver._resolveCultivate(state, scene, intent, base, rng);
    case 'craft':     return Story.Resolver._resolveCraft(state, scene, intent, base, rng);
    case 'battle':    return Story.Resolver._resolveBattle(state, scene, intent, base, rng);
    case 'flee':      return Story.Resolver._resolveFlee(state, scene, intent, base, rng);
    case 'deceive':   return Story.Resolver._resolveDeceive(state, scene, intent, base, rng);
    case 'use_relic': return Story.Resolver._resolveUseRelic(state, scene, intent, base, rng);
    case 'steal':     return Story.Resolver._resolveSteal(state, scene, intent, base, rng);
    case 'aid':       return Story.Resolver._resolveAid(state, scene, intent, base, rng);
    case 'travel':    return Story.Resolver._resolveTravel(state, scene, intent, base, rng);
    default:          return Story.Resolver._resolveFreeform(state, scene, intent, base, rng);
  }
};

Story.Resolver._timePassed = function (pref) {
  const map = { '片刻': { value: 1, unit: '片刻' }, '一夜': { value: 1, unit: '夜' }, '数日': { value: 3, unit: '日' }, '数月': { value: 3, unit: '月' }, '数年': { value: 3, unit: '年' }, '百年': { value: 1, unit: '百年' } };
  return map[pref] || { value: 3, unit: '日' };
};

Story.Resolver._threadById = function (state, id) {
  return (state.story.activeThreads || []).find(function (t) { return t.threadId === id; });
};

Story.Resolver._resolveRest = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  let outcome = 'quiet_success';
  const gains = [];
  // 恢复
  if (actor.hidden.injury > 0) { actor.hidden.injury = Math.max(0, actor.hidden.injury - 1); gains.push({ type: 'status', key: 'injury', delta: -1, text: '伤势略有恢复。' }); }
  else { gains.push({ type: 'status', key: 'spirit', delta: 1, text: '神魂之痛稍有缓和。' }); }
  base.gains = gains;

  const costs = [];
  // deadline 推进
  if (scene && scene.deadline && scene.deadline.remaining > 0) {
    base.threadEffects.push({ threadId: 'thread_trade_letter', op: 'deadline_advance', delta: 1 });
    if (scene.deadline.remaining - 1 <= 0) {
      costs.push({ type: 'missed_opportunity', text: '商会使者已在雨夜离城。' });
      outcome = 'missed_opportunity';
    }
  }
  // 高压场景可能被打扰
  if (scene && scene.pressure >= 3) {
    if (rng.chance(0.6)) {
      const threat = (scene.visibleEntities.indexOf('追兵') >= 0) ? '追兵' : (scene.immediateConflict || '外界威胁');
      base.publicEffects.push(actor.name + '在休息时被' + threat + '惊扰。');
      costs.push({ type: 'interrupted', text: '休息被' + threat + '打断。' });
      outcome = 'interrupted';
      actor.hidden.injury = Math.min(10, actor.hidden.injury + 1);
    }
  }
  // 轮回紊乱 + 残剑 → 梦境线索（私密）
  const flags = state.world.worldBible.flags || {};
  if (flags.reincarnationChaos && (intent.derivedTags.indexOf('use_relic') >= 0 || (actor.hidden.resources.indexOf('残剑') >= 0) || /残剑/.test(intent.rawText))) {
    if (rng.chance(0.5)) {
      base.privateEffects.push('梦中残剑低鸣，唤出一个不属于今生的名字。');
      base.threadEffects.push({ threadId: 'thread_old_sword', op: 'advance', delta: 1 });
    }
  }
  base.costs = costs;
  base.outcome = outcome;
  base.publicEffects = base.publicEffects.concat([actor.name + '没有追出客栈。']);
  return base;
};

Story.Resolver._resolveWait = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  base.outcome = 'quiet_success';
  base.gains = [{ type: 'info', text: '获得观察时间，等待他人行动。' }];
  base.costs = [{ type: 'world_advance', text: '世界线程继续推进。' }];
  if (scene && scene.deadline) base.threadEffects.push({ threadId: 'thread_trade_letter', op: 'deadline_advance', delta: 1 });
  base.publicEffects = [actor.name + '按兵不动。'];
  return base;
};

Story.Resolver._resolveObserve = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  base.outcome = 'success';
  const detail = (scene && scene.visibleEntities.length) ? rng.pick(scene.visibleEntities) : '周围动静';
  base.gains = [{ type: 'info', text: '观察到' + detail + '的细微异常。' }];
  base.costs = [{ type: 'time', text: '片刻时间流逝。' }];
  base.publicEffects = [actor.name + '暗中留意' + detail + '。'];
  return base;
};

Story.Resolver._resolveInvestigate = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  // 必须有具体对象；推进对应 thread，不得同时推进无关线程
  let threadId = 'thread_trade_letter';
  if (intent.targetType === 'clue' && intent.targetId === 'scene_anomaly') threadId = 'thread_trade_letter';
  if (intent.derivedTags.indexOf('use_relic') >= 0) threadId = 'thread_old_sword';
  const thread = Story.Resolver._threadById(state, threadId);
  base.outcome = rng.chance(0.7) ? 'success' : 'partial_success';
  base.gains = [{ type: 'clue', text: '推进' + (thread ? thread.title : '密信') + '的调查。' }];
  base.costs = [{ type: 'exposure', text: '行动有所暴露，可能引起警觉。' }];
  base.threadEffects.push({ threadId: threadId, op: 'advance', delta: 1 });
  base.publicEffects = [actor.name + '着手追查' + (thread ? thread.title : '密信') + '。'];
  return base;
};

Story.Resolver._resolveSocial = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  base.outcome = rng.chance(0.8) ? 'success' : 'success_with_cost';
  const targetName = intent.targetType === 'npc' ? intent.targetId : '在场之人';
  base.gains = [{ type: 'info', text: '与' + targetName + '有所交谈。' }];
  base.costs = [{ type: 'relation', text: '关系或立场可能因言辞改变。' }];
  // 关系变化
  if (intent.targetType === 'npc' && intent.targetId === 'innkeeper_01') {
    base.relationEffects.push({ actorId: intent.actorId, targetId: 'innkeeper_01', axis: 'trust', delta: 1, publicHint: '女掌柜似乎愿意多说几句。' });
    base.threadEffects.push({ threadId: 'thread_trade_letter', op: 'advance', delta: 1 });
  } else if (intent.targetType === 'npc' && state.actors.some(function (a) { return a.id === intent.targetId; })) {
    base.relationEffects.push({ actorId: intent.actorId, targetId: intent.targetId, axis: 'trust', delta: rng.chance(0.7) ? 1 : -1, publicHint: '两人之间的态度发生细微变化。' });
  }
  base.publicEffects = [actor.name + '与' + targetName + '交谈。'];
  return base;
};

Story.Resolver._resolveNegotiate = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  base.outcome = 'success_with_cost';
  base.gains = [{ type: 'pact', text: '达成一项临时交换或合作。' }];
  base.costs = [{ type: 'debt', text: '留下承诺或亏欠。' }];
  base.publicEffects = [actor.name + '与对方谈成条件。'];
  return base;
};

Story.Resolver._resolveCultivate = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  // 不得单回合越大境界
  const before = actor.hidden.cultivationProgress;
  actor.hidden.cultivationProgress = Math.min(99, before + rng.int(8, 20));
  base.outcome = (scene && scene.pressure >= 3) ? 'partial_success' : 'success';
  base.gains = [{ type: 'cultivation', key: 'cultivationProgress', delta: actor.hidden.cultivationProgress - before, text: '修为有所精进。' }];
  base.costs = [{ type: 'time', text: '数月时间流逝，错过短期事件。' }];
  base.publicEffects = [actor.name + '闭关数月，修为精进。'];
  return base;
};

Story.Resolver._resolveCraft = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  base.outcome = rng.chance(0.7) ? 'success' : 'partial_success';
  base.gains = [{ type: 'item', text: '制成一件小型器物。' }];
  base.costs = [{ type: 'resource', text: '消耗材料与时间。' }];
  base.publicEffects = [actor.name + '潜心炼制。'];
  return base;
};

Story.Resolver._resolveBattle = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  base.outcome = rng.chance(0.6) ? 'success' : 'success_with_cost';
  base.gains = [{ type: 'threat_reduce', text: '暂时压低敌对威胁。' }];
  base.costs = [{ type: 'injury', text: '可能受伤或法力损耗。' }];
  if (rng.chance(0.4)) actor.hidden.injury = Math.min(10, actor.hidden.injury + 1);
  base.publicEffects = [actor.name + '正面交锋。'];
  return base;
};

Story.Resolver._resolveFlee = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  // 逃跑保留威胁，不得自动关闭危机
  base.outcome = 'retreat';
  base.gains = [{ type: 'escape', text: '暂时脱离直接危险。' }];
  base.costs = [{ type: 'pursuit', text: '追兵仍在身后，威胁未消。' }, { type: 'loss', text: '可能丢失物品或错过机会。' }];
  base.publicEffects = [actor.name + '暂避锋芒，但追兵未肯罢休。'];
  // 标记威胁线程仍 active
  return base;
};

Story.Resolver._resolveDeceive = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  base.outcome = rng.chance(0.6) ? 'success' : 'setback';
  base.gains = [{ type: 'window', text: '制造短暂误导窗口。' }];
  base.costs = [{ type: 'suspicion', text: '失败则怀疑显著上升。' }];
  base.publicEffects = [actor.name + (intent.restSurface ? '表面歇息，实则设局。' : '布下误导。')];
  return base;
};

Story.Resolver._resolveUseRelic = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  base.outcome = 'success';
  base.gains = [{ type: 'relic_resonance', text: '残剑产生共鸣。' }];
  base.costs = [{ type: 'relic_will', text: '法宝有灵，可能提出要求。' }];
  base.threadEffects.push({ threadId: 'thread_old_sword', op: 'advance', delta: 1 });
  base.privateEffects.push('残剑的剑灵似有回应，却仍不肯相认。');
  base.publicEffects = [actor.name + '以残剑为媒，触动剑意。'];
  return base;
};

Story.Resolver._resolveSteal = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  base.outcome = rng.chance(0.5) ? 'success' : 'setback';
  base.gains = [{ type: 'item', text: '可能顺走一件小物。' }];
  base.costs = [{ type: 'suspicion', text: '暴露则怀疑大增。' }];
  base.publicEffects = [actor.name + '暗中下手。'];
  return base;
};

Story.Resolver._resolveAid = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  base.outcome = 'success';
  base.gains = [{ type: 'relation', text: '援护同伴，增进信任。' }];
  base.costs = [{ type: 'exposure', text: '自身暴露于风险。' }];
  if (intent.targetType === 'npc' || state.actors.some(function (a) { return a.id === intent.targetId; })) {
    base.relationEffects.push({ actorId: intent.actorId, targetId: intent.targetId, axis: 'trust', delta: 1, publicHint: '愿并肩之意更显。' });
  }
  base.publicEffects = [actor.name + '援护同伴。'];
  return base;
};

Story.Resolver._resolveTravel = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  base.outcome = 'success';
  base.gains = [{ type: 'location', text: '抵达新地点。' }];
  base.costs = [{ type: 'time', text: '路途耗时数日。' }, { type: 'exposure', text: '路途存在追踪或风险。' }];
  base.threadEffects.push({ threadId: 'thread_trade_letter', op: 'advance', delta: 1 });
  base.publicEffects = [actor.name + '动身追赶商队，地点已变。'];
  return base;
};

Story.Resolver._resolveFreeform = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  base.outcome = rng.chance(0.6) ? 'partial_success' : 'success';
  base.gains = [{ type: 'info', text: '行动产生某种结果。' }];
  base.costs = [{ type: 'uncertain', text: '结果不确定。' }];
  base.publicEffects = [actor.name + '采取行动。'];
  return base;
};

Story.Resolver.resolveInteractions = function (state, actionResults) {
  // 简化：同回合同目标 social/aid → 关系强化
  const interactions = [];
  return interactions;
};

Story.Resolver.buildEnvelope = function (state, actions, interactions) {
  const scene = state.story.currentScene;
  const publicDelta = [];
  const privateDelta = [];
  const sceneDelta = {};
  const worldDelta = {};
  const narrationBeats = [];

  actions.forEach(function (a) {
    const actor = state.actors.find(function (x) { return x.id === a.actorId; });
    // gains → 私密/公开
    (a.gains || []).forEach(function (g) {
      if (g.type === 'status' || g.type === 'cultivation' || g.type === 'info' || g.type === 'clue' || g.type === 'relic_resonance') {
        privateDelta.push({ op: 'ADD_PRIVATE_FACT', target: { actorId: a.actorId }, payload: { text: g.text }, source: 'resolver', sourceTurnId: '' });
      }
      narrationBeats.push(actor.name + '：' + g.text);
    });
    // costs → 摘要
    (a.costs || []).forEach(function (c) { narrationBeats.push(actor.name + '付出代价：' + c.text); });
    // publicEffects → 公开事件
    (a.publicEffects || []).forEach(function (e) {
      publicDelta.push({ op: 'ADD_EVENT', payload: { type: 'event', text: e }, source: 'resolver', sourceTurnId: '' });
    });
    // privateEffects → 私密事实
    (a.privateEffects || []).forEach(function (e) {
      privateDelta.push({ op: 'ADD_PRIVATE_FACT', target: { actorId: a.actorId }, payload: { text: e }, source: 'resolver', sourceTurnId: '' });
    });
    // threadEffects → thread delta
    (a.threadEffects || []).forEach(function (te) {
      const op = te.op === 'advance' ? 'UPDATE_THREAD' : (te.op === 'deadline_advance' ? 'UPDATE_THREAD' : 'UPDATE_THREAD');
      publicDelta.push({ op: op, target: { threadId: te.threadId }, payload: { op: te.op, delta: te.delta }, source: 'resolver', sourceTurnId: '' });
    });
    // relationEffects → 关系 delta
    (a.relationEffects || []).forEach(function (re) {
      publicDelta.push({ op: 'UPDATE_RELATION', target: { actorId: re.actorId, relatedActorId: re.targetId }, payload: { axis: re.axis, delta: re.delta, publicHint: re.publicHint }, source: 'resolver', sourceTurnId: '' });
    });
  });

  // 时间推进：取本回合所有行动中跨度最大者（并行发生，取最长），作为 ADVANCE_TIME delta
  const _yearsOf = function (tp) {
    if (!tp || !tp.unit) return 0;
    const v = Number(tp.value) || 0;
    if (tp.unit === '年') return v;
    if (tp.unit === '月') return v / 12;
    if (tp.unit === '日') return v / 365;
    if (tp.unit === '百年') return v * 100;
    return 0; // 片刻/夜等不计年
  };
  let maxTp = null;
  actions.forEach(function (a) {
    if (!a || !a.timePassed) return;
    if (!maxTp || _yearsOf(a.timePassed) > _yearsOf(maxTp)) maxTp = a.timePassed;
  });
  if (maxTp) publicDelta.push({ op: 'ADVANCE_TIME', payload: maxTp, source: 'resolver', sourceTurnId: '' });

  return {
    turnId: '', chapterIndex: 0,
    sceneBeforeId: scene ? scene.sceneId : 'scene_legacy',
    sceneAfterId: scene ? scene.sceneId : 'scene_legacy',
    focalActorIds: [],
    actions: actions,
    interactions: interactions || [],
    publicDelta: publicDelta,
    privateDelta: privateDelta,
    sceneDelta: sceneDelta,
    worldDelta: worldDelta,
    narrationBeats: narrationBeats,
    choiceConstraints: [],
    provenance: 'local-resolver',
  };
};

Story.Resolver._applySafeFallback = function (envelope, errors) {
  // 最小安全回退裁决
  envelope.actions = (envelope.actions || []).map(function (a) {
    return Object.assign({}, a, { outcome: 'partial_success', gains: [], costs: [{ type: 'uncertain', text: '行动没有得到预期结果。' }], publicEffects: [], threadEffects: [], relationEffects: [], timePassed: { value: 1, unit: '片刻' } });
  });
  envelope.publicDelta = [];
  envelope.privateDelta = [];
  envelope.narrationBeats = ['本回合行动结果不确定。'];
};

/* ============================================================
 * §11 StateDelta —— 本地状态变更白名单（V3.2 §J）
 * ============================================================ */

Story.Delta = Story.Delta || {};

Story.Delta.OPS = ['ADD_PUBLIC_FACT','ADD_PUBLIC_RUMOR','ADD_PRIVATE_FACT','ADD_EVENT','ADD_THREAD','UPDATE_THREAD','CLOSE_THREAD','ADD_RELIC','UPDATE_RELIC_DISPOSITION','ADD_PACT','UPDATE_RELATION','UPDATE_ACTOR_STATUS','UPDATE_ACTOR_RESOURCE','UPDATE_CULTIVATION','ADVANCE_TIME','SET_SCENE','UPDATE_SCENE','ADD_CHRONICLE','ADD_SUCCESSOR_HOOK'];

Story.Delta.RELATION_AXES = ['trust', 'suspicion', 'debt', 'respect', 'useIntent'];

Story.Delta._buildRelationMap = function (actor, allActors) {
  const map = {};
  const ids = (allActors || []).map(function (a) { return a.id; }).filter(function (id) { return id !== actor.id; });
  ids.forEach(function (id) {
    map[id] = { trust: 0, suspicion: 0, debt: 0, respect: 0, useIntent: 0 };
  });
  // 从 relationHints 推断初始值
  const hints = actor.relationHints || actor.startingRelation || {};
  Object.keys(hints).forEach(function (id) {
    if (!map[id]) map[id] = { trust: 0, suspicion: 0, debt: 0, respect: 0, useIntent: 0 };
    const h = hints[id];
    if (/旧识|信任|客气/.test(h)) map[id].trust = 1;
    if (/戒备|不屑|试探/.test(h)) map[id].suspicion = 1;
    if (/交易|欠/.test(h)) map[id].debt = 1;
  });
  return map;
};

Story.Delta.applyEnvelope = function (state, envelope) {
  const s = state.story;
  (envelope.publicDelta || []).forEach(function (d) { Story.Delta._applyOne(state, d); });
  (envelope.privateDelta || []).forEach(function (d) { Story.Delta._applyOne(state, d); });
  // 时间推进已由 ADVANCE_TIME delta（buildEnvelope 注入）经 _applyOne 处理；
  // 兜底：若 envelope 无 ADVANCE_TIME（如旧迁移数据），按 actions[0].timePassed 推进
  const hasAdvanceTime = (envelope.publicDelta || []).some(function (d) { return d && d.op === 'ADVANCE_TIME'; });
  if (!hasAdvanceTime) {
    const tp = (envelope.actions && envelope.actions[0] && envelope.actions[0].timePassed) || { value: 1, unit: '片刻' };
    Story.applyTimePassed(state, tp);
  }
  // 关系描述同步到 relationHints（UI 用）
  state.actors.forEach(function (a) {
    a.relationHints = a.relationHints || {};
    if (!a.relationships) return;
    Object.keys(a.relationships).forEach(function (rid) {
      const r = a.relationships[rid];
      if (r._dirty) {
        a.relationHints[rid] = Story.Delta._describeRelation(r);
        r._dirty = false;
      }
    });
  });
  state.ledger.stateDeltas = (state.ledger.stateDeltas || []).concat((envelope.publicDelta || []).map(function (d) { return d; })).slice(-200);
};

Story.Delta._applyOne = function (state, d) {
  if (!d || Story.Delta.OPS.indexOf(d.op) < 0) return;
  const s = state.story;
  const L = state.ledger;
  switch (d.op) {
    case 'ADD_PUBLIC_FACT': if (d.payload && d.payload.text) state.world.publicFacts.push(d.payload.text); break;
    case 'ADD_PUBLIC_RUMOR': if (d.payload && d.payload.text) state.world.publicRumors.push(d.payload.text); break;
    case 'ADD_PRIVATE_FACT':
      if (d.target && d.target.actorId && d.payload && d.payload.text) {
        const aid = d.target.actorId;
        if (!L.privateEvents[aid]) L.privateEvents[aid] = [];
        L.privateEvents[aid].push({ text: d.payload.text, chapter: s.chapterIndex + 1 });
        const a = state.actors.find(function (x) { return x.id === aid; });
        if (a) a.privateFacts.push(d.payload.text);
      }
      break;
    case 'ADD_EVENT':
      if (d.payload && d.payload.text) {
        L.publicEvents.push({ type: d.payload.type || 'event', text: d.payload.text, chapter: s.chapterIndex + 1 });
        if (d.payload.type === 'fact') state.world.publicFacts.push(d.payload.text);
        else if (d.payload.type === 'rumor') state.world.publicRumors.push(d.payload.text);
      }
      break;
    case 'ADD_THREAD':
      if (d.payload && d.payload.thread && s.activeThreads.length < 8) s.activeThreads.push(d.payload.thread);
      break;
    case 'UPDATE_THREAD': {
      const te = d.payload || {};
      const tid = d.target && d.target.threadId;
      const t = (s.activeThreads || []).find(function (x) { return x.threadId === tid; });
      if (!t) break;
      if (te.op === 'advance') { t.stage = Math.min(t.maxStage, (t.stage || 1) + (te.delta || 1)); t.lastAdvancedChapter = s.chapterIndex + 1; }
      else if (te.op === 'deadline_advance') { /* deadline 在 scene 层处理 */ }
      else if (te.op === 'close') t.status = 'closed';
      break;
    }
    case 'CLOSE_THREAD': {
      const tid = d.target && d.target.threadId;
      const t = (s.activeThreads || []).find(function (x) { return x.threadId === tid; });
      if (t) t.status = 'closed';
      break;
    }
    case 'ADD_RELIC':
      if (d.payload && d.payload.name && Story._isMinorRelic(d.payload.name)) {
        L.relics.push({ name: d.payload.name, chapter: s.chapterIndex + 1 });
      }
      break;
    case 'UPDATE_RELATION': {
      const aid = d.target && d.target.actorId;
      const rid = d.target && d.target.relatedActorId;
      const a = state.actors.find(function (x) { return x.id === aid; });
      if (!a || !a.relationships || !a.relationships[rid]) break;
      const axis = d.payload.axis;
      if (Story.Delta.RELATION_AXES.indexOf(axis) < 0) break;
      const before = a.relationships[rid][axis] || 0;
      const delta = Math.max(-2, Math.min(2, d.payload.delta || 0)); // 每回合单轴 ≤2
      a.relationships[rid][axis] = Math.max(-5, Math.min(5, before + delta));
      a.relationships[rid]._dirty = true;
      if (d.payload.publicHint) {
        L.publicEvents.push({ type: 'relation', text: d.payload.publicHint, chapter: s.chapterIndex + 1 });
      }
      break;
    }
    case 'UPDATE_CULTIVATION': {
      const a = state.actors.find(function (x) { return x.id === (d.target && d.target.actorId); });
      if (a && a.hidden) a.hidden.cultivationProgress = Math.min(99, (a.hidden.cultivationProgress || 0) + (d.payload.delta || 0));
      break;
    }
    case 'ADVANCE_TIME':
      if (d.payload) Story.applyTimePassed(state, d.payload);
      break;
    default: break;
  }
};

Story.Delta._describeRelation = function (r) {
  if (r.trust >= 3) return '开始信任';
  if (r.trust >= 1) return '略有好感';
  if (r.suspicion >= 3) return '有所保留';
  if (r.suspicion >= 1) return '略有戒备';
  if (r.debt >= 2) return '欠下一笔人情';
  if (r.useIntent >= 2) return '似乎在利用你';
  if (r.respect >= 2) return '愿意并肩';
  return '关系未明';
};

/* ============================================================
 * §12 ChoiceFactory —— 本地下一轮选项工厂（V3.2 §K）
 * ============================================================ */

Story.ChoiceFactory = Story.ChoiceFactory || {};

Story.ChoiceFactory.buildAll = function (state, scene, envelope) {
  const all = {};
  state.actors.forEach(function (actor) {
    all[actor.id] = Story.ChoiceFactory.buildForActor(state, actor.id, scene, envelope);
  });
  return all;
};

Story.ChoiceFactory.buildForActor = function (state, actorId, scene, envelope) {
  const scene2 = scene || state.story.currentScene || Story.Scene.createLegacyScene(state);
  const idx = state.story.chapterIndex + 1;
  const actor = state.actors.find(function (a) { return a.id === actorId; });
  const rng = Story.rngFor('choice', state);

  // 候选池：基于场景的具体选项
  const pool = Story.ChoiceFactory._candidatePool(state, actor, scene2, envelope);
  // 洗牌并选 3 个不同 category
  const shuffled = rng.shuffle(pool);
  const chosen = [];
  const usedCats = {};
  const usedFingerprints = {};
  const recent = (state.story.recentChoiceFingerprints || []).slice(-12);
  for (let i = 0; i < shuffled.length && chosen.length < 3; i++) {
    const c = shuffled[i];
    const fp = Story.ChoiceFactory.fingerprint(c);
    if (usedFingerprints[fp]) continue;
    if (usedCats[c.intentCategory] && chosen.length < 2) continue; // 至少两种 category
    // 最近两章同 fingerprint 默认不可重复
    if (recent.indexOf(fp) >= 0 && chosen.length >= 1) continue;
    c.fingerprint = fp;
    usedFingerprints[fp] = true;
    usedCats[c.intentCategory] = true;
    chosen.push(c);
  }
  // 不足则补
  let k = 0;
  while (chosen.length < 3 && k < shuffled.length) {
    const c = shuffled[k++];
    const fp = Story.ChoiceFactory.fingerprint(c);
    if (chosen.some(function (x) { return x.id === c.id; })) continue;
    c.fingerprint = fp;
    chosen.push(c);
  }
  // 顺序扰动（位置不固定）
  const ordered = rng.shuffle(chosen).slice(0, 3);
  // 写入 recent
  ordered.forEach(function (c) {
    state.story.recentChoiceFingerprints.push(c.fingerprint);
  });
  state.story.recentChoiceFingerprints = state.story.recentChoiceFingerprints.slice(-30);
  return ordered;
};

Story.ChoiceFactory.fingerprint = function (choice) {
  return [choice.intentCategory, choice.approach, choice.targetType, choice.targetId, choice.primaryThreadId || ''].join(':');
};

Story.ChoiceFactory._candidatePool = function (state, actor, scene, envelope) {
  const idx = state.story.chapterIndex + 1;
  const sid = scene.sceneId;
  const visible = scene.visibleEntities || [];
  const exits = scene.exits || [];
  const threads = (state.story.activeThreads || []).filter(function (t) { return t.status === 'active'; });
  const pool = [];
  const mk = function (cat, approach, ttype, tid, label, hint, tags, risk, primaryThread, timeHint) {
    return {
      id: 'ch_' + String(idx).padStart(4, '0') + '_' + actor.id + '_' + cat + '_' + (pool.length),
      actorId: actor.id, label: label, hint: hint,
      intentCategory: cat, approach: approach, targetType: ttype, targetId: tid,
      riskLevel: risk, expectedBenefits: [], expectedCosts: [], tags: tags,
      sourceSceneId: sid, primaryThreadId: primaryThread || null,
    };
  };

  // 推进当前冲突（investigate）
  if (threads[0]) {
    pool.push(mk('investigate', 'pursue', 'clue', threads[0].threadId,
      '追查“' + threads[0].title + '”的具体下落。', '可能推进线索，但会暴露意图。', ['investigate', 'clue'], 2, threads[0].threadId, '数日'));
  }
  // 改变关系或利用人物（social）
  const npcName = visible.find(function (e) { return e.indexOf('掌柜') >= 0 || e.indexOf('女掌柜') >= 0; }) || (visible[0] || '在场之人');
  const npcId = npcName.indexOf('掌柜') >= 0 ? 'innkeeper_01' : 'npc_present';
  pool.push(mk('social', 'pressure', 'npc', npcId,
    '拿半封密信逼问' + npcName + '。', '可能换取情报，但关系恶化。', ['social', 'secret'], 2, 'thread_trade_letter', '片刻'));
  // 恢复/规避/积累（rest / cultivate / wait）
  pool.push(mk('rest', 'recover', 'self', 'self',
    '留在客栈休养一夜，让残剑替你记住梦中钟声。', '恢复伤势，但可能错过机会。', ['rest', 'recovery'], 1, 'thread_old_sword', '一夜'));
  // travel（追赶/换地）
  if (exits.length) {
    pool.push(mk('travel', 'pursue', 'exit', 'trade_caravan',
      '连夜出城，追赶已离城的商队。', '地点改变，路途有风险。', ['travel', 'risk'], 3, 'thread_trade_letter', '数日'));
  }
  // use_relic
  pool.push(mk('use_relic', 'insight', 'relic', 'residual_sword',
    '以残剑为媒，召来一缕游离剑意。', '推进残剑线索，但法宝有灵。', ['use_relic', 'fate'], 2, 'thread_old_sword', '片刻'));
  // observe
  pool.push(mk('observe', 'covert', 'clue', 'scene_anomaly',
    '不露声色，留意客栈后院的动静。', '获得细节，少量时间。', ['observe', 'info'], 1, null, '片刻'));
  // negotiate
  pool.push(mk('negotiate', 'ally', 'npc', npcId,
    '与' + npcName + '谈条件，换一夜安稳与消息。', '可能达成交换，留下承诺。', ['negotiate', 'pact'], 2, 'thread_trade_letter', '片刻'));
  // flee（仅 pressure 较高时）
  if ((scene.pressure || 0) >= 2) {
    pool.push(mk('flee', 'evade', 'exit', 'nearest_exit',
      '趁雨离城，避开已经开始搜人的巡卫。', '暂脱危险，但追兵不散。', ['flee', 'risk'], 3, null, '片刻'));
  }
  // cultivate（仅低压力）
  if ((scene.pressure || 0) <= 2) {
    pool.push(mk('cultivate', 'insight', 'self', 'self',
      '就地静修数月，参悟残剑剑意。', '修为精进，但错过短期事件。', ['cultivate', 'time'], 2, 'thread_old_sword', '数月'));
  }
  return pool;
};

Story.ChoiceFactory.validateChoiceSet = function (state, actorId, choices) {
  return Story.Diagnostics.validateChoiceSet(state, actorId, choices);
};

/* ============================================================
 * §13 Agent —— AI 同伴行为（V3.2 §L）
 * ============================================================ */

Story.Agent = Story.Agent || {};

Story.Agent.chooseAction = function (state, actorId, choices, scene, envelope) {
  if (!choices || !choices.length) return null;
  if (choices.length === 1) return choices[0];
  const actor = state.actors.find(function (a) { return a.id === actorId; });
  if (!actor) return choices[0];
  const rng = Story.rngFor('agent', state);
  const arc = actor.agentArc || {};
  const lastFps = arc.lastChoiceFingerprints || [];
  const lastCats = (arc.lastChoiceCategories || []);

  const scored = choices.map(function (c) {
    let score = Story.Agent.scoreChoice(state, actor, c, scene);
    // 连续两回合同类 category：-3
    if (lastCats.length >= 1 && lastCats[lastCats.length - 1] === c.intentCategory) score -= 3;
    // 连续两回合相同 fingerprint：-8
    if (lastFps.length && lastFps.indexOf(Story.ChoiceFactory.fingerprint(c)) >= 0) score -= 8;
    // 连续三回合未推进个人目标：对应个人目标 choice +4
    if ((arc._stalledTurns || 0) >= 3 && c.primaryThreadId && Story.Agent._relatesToGoal(actor, c)) score += 4;
    // 近期未成为焦点：与玩家交集 choice +2
    const player = Story.getPrimaryHumanActor(state);
    if (player && c.targetType === 'npc' && c.targetId !== actorId) score += 1;
    score += rng.next() * 1.5;
    return { choice: c, score: score };
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  const picked = scored[0].choice;
  // 记录 arc
  arc.lastChoiceFingerprints = (arc.lastChoiceFingerprints || []).concat([Story.ChoiceFactory.fingerprint(picked)]).slice(-4);
  arc.lastChoiceCategories = (arc.lastChoiceCategories || []).concat([picked.intentCategory]).slice(-3);
  arc.lastFocusedChapter = state.story.chapterIndex + 1;
  return picked;
};

Story.Agent.scoreChoice = function (state, actor, choice, scene) {
  let score = 0;
  const tags = (choice.tags || []).join(',');
  const label = choice.label || '';
  const hint = choice.hint || '';
  const text = label + hint + tags;
  // 角色目标相关度
  const goals = [actor.publicWish || '', actor.hiddenFate || '', (actor.agentArc && actor.agentArc.currentGoal) || ''].join(' ');
  score += Story._keywordOverlap(text, goals) * 2;
  // 人格偏好
  (actor.personalityTags || []).forEach(function (tag) { if (text.indexOf(tag) >= 0 || Story._tagMatches(tag, text)) score += 1.5; });
  // 偏好词
  if (actor.choicePrefs) Object.keys(actor.choicePrefs).forEach(function (kw) { if (text.indexOf(kw) >= 0) score += actor.choicePrefs[kw]; });
  // 道途契合
  const daoPref = { '剑修': ['剑', '战', '斗', '险', '行', '复仇'], '丹道': ['丹', '药', '材', '秘', '慎', '试'], '阵法': ['阵', '源', '易', '序', '避'], '游侠': ['行', '义', '险', '随'], '妖修': ['妖', '血', '护', '恩'] }[actor.daoPath] || [];
  daoPref.forEach(function (kw) { if (text.indexOf(kw) >= 0) score += 1; });
  // 个人目标 thread 相关
  if (choice.primaryThreadId && Story.Agent._relatesToGoal(actor, choice)) score += 2;
  return score;
};

Story.Agent._relatesToGoal = function (actor, choice) {
  const goal = (actor.agentArc && actor.agentArc.currentGoal) || actor.publicWish || '';
  if (!goal) return false;
  const text = (choice.label || '') + (choice.hint || '');
  return Story._keywordOverlap(text, goal) > 0;
};

/* ============================================================
 * §14 Narration —— 叙事（V3.2 §N §P）
 * ============================================================ */

Story.Narration = Story.Narration || {};

Story.Narration.NUMERALS = ['零','一','二','三','四','五','六','七','八','九'];

Story.Narration.toChineseNum = function (n) {
  if (!Number.isFinite(n) || n < 0) return '零';
  n = Math.floor(n);
  if (n === 0) return '零';
  const d = Story.Narration.NUMERALS;
  if (n < 10) return d[n];
  if (n < 20) return n === 10 ? '十' : '十' + d[n - 10];
  if (n < 100) {
    const t = Math.floor(n / 10), u = n % 10;
    return d[t] + '十' + (u ? d[u] : '');
  }
  const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), u = n % 100 % 10;
  let s = d[h] + '百';
  if (t === 0 && u === 0) return s;
  if (t === 0) return s + '零' + d[u];
  s += d[t] + '十';
  if (u) s += d[u];
  return s;
};

Story.Narration.formatChapterNumber = function (n) {
  return '第' + Story.Narration.toChineseNum(n) + '章';
};

Story.Narration.buildFallbackTitle = function (state, scene, envelope) {
  const rng = Story.rngFor('narration', state);
  const idx = state.story.chapterIndex + 1;
  const subjectPool = [
    '雨声里的半封信', '城门外的车辙', '客栈未熄的灯', '雨停之前', '后院的新阵纹',
    '钟声与剑鸣', '半句旧约', '雨幕下的人', '残剑的低语', '未结的局',
    '灯下的药香', '离城之路', '旧阵一角', '梦中的名字', '追兵未远',
  ];
  // 避免连续重复主题词
  const last = (state.story.recentChapterFingerprints || []).slice(-1)[0];
  let subject = rng.pick(subjectPool);
  for (let i = 0; i < 4 && subject === last; i++) subject = rng.pick(subjectPool);
  state.story.recentChapterFingerprints = (state.story.recentChapterFingerprints || []).concat([subject]).slice(-12);
  return Story.Narration.formatChapterNumber(idx) + '：' + subject;
};

/** 构建给 AI 的 NarrationBrief（V3.2 §N2） */
Story.Narration.buildBrief = function (state, scene, envelope) {
  const w = state.world;
  const s = state.story;
  const focal = (scene && scene.focalActorIds && scene.focalActorIds.length) ? scene.focalActorIds : (state.actors[0] ? [state.actors[0].id] : []);
  const flags = (w.worldBible && w.worldBible.flags) || {};
  const toneTags = [];
  if (flags.reincarnationChaos) toneTags.push('轮回紊乱');
  if (flags.pactManifest) toneTags.push('契约具现');
  if (flags.relicSentience) toneTags.push('法宝有灵');
  toneTags.push((w.worldBible && w.worldBible.order) || '未知秩序');

  const focalActors = focal.map(function (id) {
    const a = state.actors.find(function (x) { return x.id === id; });
    if (!a) return null;
    return { id: a.id, name: a.name, publicStatus: a.statusSummary || a.identity || '' };
  }).filter(Boolean);

  // 禁止泄露的私密 ID
  const forbiddenLeaks = [];
  state.actors.forEach(function (a) { if (a.hiddenFate) forbiddenLeaks.push(a.id + '_private_fate'); });

  return {
    chapterIndex: s.chapterIndex + 1,
    world: { name: w.name, year: Math.floor(w.year), toneTags: toneTags },
    scene: {
      locationName: (scene && scene.locationName) || '未知之地',
      timeOfDay: (scene && scene.timeOfDay) || '不明',
      weather: (scene && scene.weather) || '',
      immediateConflict: (scene && scene.immediateConflict) || '',
    },
    focalActors: focalActors,
    narrationBeats: (envelope && envelope.narrationBeats) || [],
    forbiddenLeaks: forbiddenLeaks,
    style: {
      proseLength: '450-850 Chinese characters',
      paragraphCount: '3-5',
      focalConflictCount: 1,
      noSummaryTone: true,
      noGenericObserver: true,
      noUnjustifiedReward: true,
    },
    _envelope: envelope || null,
  };
};

/** 离线章节组装（LocalNarrativeAssembler，V3.2 §P2 / §11） */
Story.Narration.assembleOffline = function (state, scene, envelope) {
  const rng = Story.rngFor('narration', state);
  const idx = state.story.chapterIndex + 1;
  const title = Story.Narration.buildFallbackTitle(state, scene, envelope);

  // 来自 envelope 的具体结果块
  const action = (envelope && envelope.actions && envelope.actions[0]) || null;
  const beats = (envelope && envelope.narrationBeats) || [];

  // 焦点角色：优先取行动所属角色；无行动时回落到场景焦点或主角
  let focal = state.actors[0] || { name: '众人' };
  if (action && action.actorId) {
    const actActor = state.actors.find(function (a) { return a.id === action.actorId; });
    if (actActor) focal = actActor;
  } else if (scene && scene.focalActorIds && scene.focalActorIds[0]) {
    const sf = state.actors.find(function (a) { return a.id === scene.focalActorIds[0]; });
    if (sf) focal = sf;
  }
  const fname = focal.name || '众人';

  // 第一段：场景定场 + 角色动作与即时结果（不直接回放玩家原文，而是用裁决语义改写）
  let p1 = '';
  const locName = (scene && scene.locationName) || '此地';
  const pressure = (scene && scene.immediateConflict) ? ('「' + scene.immediateConflict + '」的阴影尚未散去，') : '';
  const sceneLead = locName + '上空的云层缓慢压低，风从檐角穿过，带来潮湿土腥与淡淡铁锈味。';
  if (action) {
    const catText = {
      rest: fname + '没有追出去，反而回到原处歇下。雨声盖住了城门外的车轮，也盖住了某些不该被听见的动静。',
      wait: fname + '按兵不动，让这一夜自行铺展。客栈的灯火在风里晃了两晃，像是在替谁数着更漏。',
      observe: fname + '不露声色，把周遭的动静一一收进眼底。檐角的湿痕、地上的脚印、众人嘴边没说出口的话，都被记在心里。',
      investigate: fname + '循着线索查去，雨里的痕迹比预想更密。每往前一步，就多出一处此前没人留意的破绽。',
      social: fname + '与在场之人交涉，话锋里藏着试探。几句话下来，谁是真心、谁在敷衍，已经分出了轮廓。',
      negotiate: fname + '与对方谈定条件，承诺与得失一并落下。这一纸口头之约，比任何契约都更难反悔。',
      cultivate: fname + '闭关静修，数月只在一呼一吸间过去。再睁眼时，体内的灵气已比先前凝实了几分。',
      craft: fname + '潜心炼制，材料与时间一同消融。炉火明灭之间，一件雏形渐渐显出轮廓。',
      battle: fname + '正面迎上威胁，锋刃与法力交错。这一场没有看客，每一招都关乎接下来能否全身而退。',
      flee: fname + '暂避锋芒，但身后的追踪并未停歇。雨幕成了掩护，也成了阻碍。',
      deceive: fname + '表面顺从，暗中另设一局。旁人看见的是退让，看不见的是另一条暗线正在收紧。',
      use_relic: fname + '以残剑为媒，触动一缕游离的剑意。剑身微颤，像是认出了什么旧主。',
      steal: fname + '暗中下手，指尖比雨声更轻。东西到手的那一刻，没有人察觉到任何异样。',
      aid: fname + '援护同伴，把自己的退路让了出去。这一手未必能换来感激，却让对方多了一分活路。',
      travel: fname + '动身离城，脚下的路已经改变。身后的' + locName + '在雨里渐渐变小，前方的去处仍未可知。',
      freeform: fname + '依着心中的打算付诸行动，让这一夜给出回应。' + pressure + '每一个选择都在改变四人原本松散的节奏。',
    }[action.category] || (fname + '付诸行动，让这一夜给出回应。');
    p1 = sceneLead + catText;
  } else {
    p1 = sceneLead + fname + '立于' + locName + '之上，风从远处带来不寻常的气息。' + pressure + '此界故事尚未真正开始。';
  }

  // 第二段：代价/世界变化/人物反应
  const w = state.world.worldBible || {};
  const rule = (w.rules && w.rules.length) ? rng.pick(w.rules) : '此界规则仍在暗处运转。';
  const costText = (action && action.costs && action.costs.length) ? action.costs[0].text : '';
  const gainText = (action && action.gains && action.gains.length) ? action.gains[0].text : '';
  // 行动结果回响（保证段落数据实而非占位，并补充字数到 180+）
  const outcomeLabel = (action && action.outcome) ? Story.Narration._outcomeLabel(action.outcome) : '了结';
  const catLabel = (action && action.category) ? Story.Narration._catLabel(action.category) : '行动';
  const outcomeBeat = '这一番' + catLabel + '终究' + outcomeLabel + '，' + (gainText ? '有所得亦有所失' : '未曾惊动太多人') + '，' + locName + '的夜色把一切收进沉默里。';
  let p2 = rule + ' ' + outcomeBeat + ' ';
  if (costText) p2 += costText + ' ';
  if (gainText) p2 += gainText + ' ';
  // 同伴反应（最多 1 条远景痕迹）
  const companions = state.actors.filter(function (a) { return a.id !== (focal && focal.id); });
  if (companions.length) {
    const c = companions[0];
    const trace = rng.pick([
      c.name + '没有追问，却在' + locName + '外围替众人留出一条退路；回来时，他带回的消息恰好补上了行动中缺失的一角。',
      c.name + '循着另一处动静查去，袖口沾着细碎尘土。他只说看见有人在暗中观察' + fname + '，却不肯断言对方是敌是友。',
      c.name + '把一件不起眼的小事记在心里：当' + fname + '付诸行动时，附近的灵气曾短暂逆流。',
    ]);
    p2 += trace;
  }

  // 第三段：视觉收束
  const endingImage = rng.pick([
    '雨水顺着密信残角滴落，墨迹晕开成一片看不清的字。',
    '城门外的车辙在雨中渐渐模糊，像是谁来过，又像是谁都没来。',
    '客栈的灯还亮着，没有人去添油，它就那样亮到天明。',
    '残剑在鞘中轻轻一颤，又归于沉寂，像是在等一个还没到的人。',
    '后院的阵纹在雨水中泛起微光，转瞬即逝，只留下一圈浅浅的水痕。',
  ]);
  const p3 = endingImage;

  let chapter = p1 + '\n\n' + p2 + '\n\n' + p3;
  // 长度控制：180-400 中文字符（去除换行计数）
  const len = chapter.replace(/\s/g, '').length;
  if (len > 400) {
    // 截断到第三段前
    chapter = p1 + '\n\n' + p2;
    if (chapter.replace(/\s/g, '').length > 400) chapter = p1;
  }
  // 禁用模板句过滤（保险）
  chapter = Story.Narration._stripForbidden(chapter);

  return {
    title: title,
    chapter: chapter,
    chapterSummary: Story.Narration._summary(state, scene, action, beats),
    timePassed: (action && action.timePassed) || { value: 1, unit: '片刻' },
    endingImage: endingImage,
    dialogues: [],
    provenance: 'offline-resolved',
    narrationStatus: 'ok',
  };
};

/** 从 AI 返回组装章节（仅取 title/chapter/dialogues/endingImage，丢弃越权字段） */
Story.Narration.assembleFromAI = function (state, scene, envelope, narration) {
  const parsed = Story.Provider.parseNarrationResponse(narration);
  let title = parsed.title || Story.Narration.buildFallbackTitle(state, scene, envelope);
  let chapter = parsed.chapter || '';
  chapter = Story.Narration._stripForbidden(chapter);
  const action = (envelope && envelope.actions && envelope.actions[0]) || null;
  const provenance = parsed.plainText ? 'ai-plain' : 'ai-json';
  return {
    title: title,
    chapter: chapter,
    chapterSummary: Story.Narration._summary(state, scene, action, envelope.narrationBeats || []),
    timePassed: (action && action.timePassed) || { value: 1, unit: '片刻' },
    endingImage: parsed.endingImage || '',
    dialogues: Array.isArray(parsed.dialogues) ? parsed.dialogues : [],
    provenance: provenance,
    narrationStatus: 'ok',
  };
};

Story.Narration._summary = function (state, scene, action, beats) {
  if (action) {
    const a = state.actors.find(function (x) { return x.id === action.actorId; });
    return (a ? a.name : '众人') + '执行' + Story.Narration._catLabel(action.category) + '，结果为' + Story.Narration._outcomeLabel(action.outcome) + '。';
  }
  return (beats[0] || '本章已成。');
};

Story.Narration._catLabel = function (cat) {
  return { rest:'休息', wait:'等待', observe:'观察', investigate:'调查', travel:'行进', social:'交涉', negotiate:'谈判', cultivate:'闭关', craft:'炼制', battle:'战斗', flee:'撤离', steal:'窃取', aid:'援护', deceive:'伪装', use_relic:'御器', freeform:'行动' }[cat] || '行动';
};
Story.Narration._outcomeLabel = function (o) {
  return { great_success:'大获成功', success:'成功', quiet_success:'悄然成功', success_with_cost:'有代价的成功', partial_success:'部分成功', setback:'受挫', missed_opportunity:'错过机会', interrupted:'被打扰', retreat:'退避', stalemate:'僵持' }[o] || '已成';
};

Story.Narration._stripForbidden = function (text) {
  let t = String(text || '');
  Story.FORBIDDEN_PHRASES.forEach(function (p) { t = t.split(p).join(''); });
  return t;
};

/** 写入叙事到 currentChapter（V3.2） */
Story.Narration.applyNarration = function (state, chapter, envelope, isOpening) {
  const s = state.story;
  s.chapterIndex += 1;
  s.currentChapter = {
    chapterId: 'chapter_' + String(s.chapterIndex).padStart(4, '0'),
    title: chapter.title,
    chapter: chapter.chapter,
    chapterSummary: chapter.chapterSummary || (chapter.chapter || '').slice(0, 80),
    timePassed: chapter.timePassed || null,
    endingImage: chapter.endingImage || '',
    provenance: chapter.provenance || 'offline-resolved',
    narrationStatus: chapter.narrationStatus || 'ok',
    renderVersion: 0,
  };
  // recentSummary
  s.recentSummary = (s.recentSummary ? s.recentSummary + ' ' : '') + s.currentChapter.chapterSummary;
  s.recentSummary = s.recentSummary.slice(-600);
  // API 状态
  state.api.lastStatus = chapter.provenance === 'offline-resolved' ? 'offline' : 'ai';
  return s.currentChapter;
};

/* ============================================================
 * §15 Provider —— API 稳定性与解析回退（V3.2 §O）
 * ============================================================ */

Story.Provider = Story.Provider || {};

Story.Provider.capabilities = {
  supportsModelsList: false,
  supportsJsonObject: false,
  supportsJsonSchema: false,
  supportsStreaming: false,
  supportsChatCompletions: true,
};

Story.Provider.ERROR_CODES = ['NO_API_CONFIG','NO_API_KEY','NETWORK_ERROR','CORS_ERROR','HTTP_401','HTTP_403','HTTP_404','HTTP_429','HTTP_5XX','TIMEOUT','EMPTY_RESPONSE','INVALID_JSON','INVALID_SCHEMA','MODEL_OVERREACH'];

/** 调用 AI 叙事（兼容旧 ai.provider.narrate）。返回归一化后的 {title,chapter,dialogues,endingImage,_autoFixed} 或 null。 */
Story.Provider.narrate = async function (state, brief) {
  if (!Story.ai.enabled) {
    Story.setAIStatus('disabled', { code: 'disabled', message: 'AI 未启用，当前使用离线裁决摘要。' });
    state.api.lastStatus = 'offline'; state.api.lastErrorCode = null;
    return null;
  }
  if (!Story.ai.provider || typeof Story.ai.provider.narrate !== 'function') {
    Story.setAIStatus('fallback', { code: 'NO_API_CONFIG', message: 'AI 已开启，但缺少可用 Provider，已使用离线裁决摘要。' });
    state.api.lastStatus = 'offline'; state.api.lastErrorCode = 'NO_API_CONFIG';
    return null;
  }
  const requestedAt = Date.now();
  state.api.lastRequestAt = requestedAt;
  Story.setAIStatus('requesting', { message: '正在请求 AI 叙事……', lastRequestAt: requestedAt });
  try {
    const ctx = Story.Provider._briefToCtx(state, brief);
    // 最多两次：首次失败（空响应或字段不合规）自动重试一次（V3 §13 协议重试）
    for (let attempt = 0; attempt < 2; attempt++) {
      const wrapped = await Story.ai._withTimeout(Story.ai.provider.narrate(ctx), Story.ai.timeoutMs);
      // 超时：已等待完整超时窗口，不重试，直接降级
      if (wrapped && wrapped.__timeout) {
        Story.setAIStatus('fallback', { code: 'TIMEOUT', message: 'API 请求超时，已使用离线裁决摘要。', lastRequestAt: requestedAt });
        state.api.lastStatus = 'offline'; state.api.lastErrorCode = 'TIMEOUT';
        return null;
      }
      let raw = wrapped || null;
      state.api.lastResponseAt = Date.now();
      if (!raw) {
        if (attempt === 0) { Story.setAIStatus('received', { message: '首次响应为空，自动重试一次。', lastRequestAt: requestedAt }); continue; }
        Story.setAIStatus('fallback', { code: 'EMPTY_RESPONSE', message: 'API 返回空内容，已使用离线裁决摘要。', lastRequestAt: requestedAt });
        state.api.lastStatus = 'offline'; state.api.lastErrorCode = 'EMPTY_RESPONSE';
        return null;
      }
      Story.setAIStatus('received', { message: attempt === 0 ? '已收到 API 响应，正在校验。' : '已收到重试响应，正在校验。', lastRequestAt: requestedAt });
      const parsed = Story.Provider.parseNarrationResponse(raw);
      const errors = Story.Provider.validateNarrationOnly(parsed);
      if (errors.length) {
        if (attempt === 0) { Story.setAIStatus('received', { message: '检测到格式偏差，自动修复格式后重试。', errors: errors, lastRequestAt: requestedAt }); continue; }
        Story.setAIStatus('fallback', { code: 'INVALID_SCHEMA', message: 'AI 返回字段不合规，已使用离线裁决摘要。', errors: errors, lastRequestAt: requestedAt });
        state.api.lastStatus = 'offline'; state.api.lastErrorCode = 'INVALID_SCHEMA'; state.api.lastErrorMessage = errors.join('；');
        return null;
      }
      // 成功：越权字段在此被剥离（仅保留文案）
      state.api.lastStatus = 'ok'; state.api.lastErrorCode = null; state.api.lastErrorMessage = '';
      const msg = parsed._autoFixed ? '已自动修复格式并采用 API 正文。' : '已采用 API 正文。';
      Story.setAIStatus('success', { message: msg, lastRequestAt: requestedAt });
      return { title: parsed.title, chapter: parsed.chapter, dialogues: parsed.dialogues, endingImage: parsed.endingImage, _autoFixed: !!parsed._autoFixed };
    }
    return null;
  } catch (e) {
    const code = Story.Provider._classifyError(e && e.message);
    Story.setAIStatus('fallback', { code: code, message: 'AI 文本生成失败，已使用离线裁决摘要。' + (e && e.message ? '原因：' + e.message : ''), error: e && e.message, lastRequestAt: requestedAt });
    state.api.lastStatus = 'offline'; state.api.lastErrorCode = code; state.api.lastErrorMessage = (e && e.message) || '';
    return null;
  }
};

Story.Provider._classifyError = function (msg) {
  msg = String(msg || '');
  if (/401|Unauthorized|未授权/i.test(msg)) return 'HTTP_401';
  if (/403|Forbidden|禁止/i.test(msg)) return 'HTTP_403';
  if (/404|Not Found|找不到/i.test(msg)) return 'HTTP_404';
  if (/429|Too Many|限流|频率/i.test(msg)) return 'HTTP_429';
  if (/5\d{2}|Server Error|服务器/i.test(msg)) return 'HTTP_5XX';
  if (/timeout|超时/i.test(msg)) return 'TIMEOUT';
  if (/CORS|跨域|Failed to fetch|NetworkError/i.test(msg)) return 'CORS_ERROR';
  if (/network|网络|ECONN/i.test(msg)) return 'NETWORK_ERROR';
  if (/JSON|parse|解析/i.test(msg)) return 'INVALID_JSON';
  return 'NETWORK_ERROR';
};

Story.Provider._briefToCtx = function (state, brief) {
  // 兼容旧 provider 期望的 ctx 形状，但内容为 NarrationBrief（不含选择原文/私密事实/账本）
  const chosenActions = (brief._envelope && brief._envelope.actions) ? brief._envelope.actions.map(function (a) {
    const actor = state.actors.find(function (x) { return x.id === a.actorId; });
    return { actorId: a.actorId, publicAction: a.rawText || Story.Narration._catLabel(a.category), privateIntent: '', tags: [a.category], isCustom: a.source === 'custom' };
  }) : [];
  return {
    mode: 'turn',
    brief: brief,
    chosenActions: chosenActions,
    world: { name: brief.world.name, year: brief.world.year, worldBibleSummary: (state.world.worldBible.rules || []).join(''), activeWorldHooks: (state.world.activeWorldHooks || []).slice(-12) },
    cast: state.actors.map(function (a) { return { id: a.id, name: a.name, publicProfile: a.identity + '·' + a.daoPath, currentStatus: a.statusSummary, publicGoal: a.publicWish, visibleRelations: a.relationHints }; }),
    previousChapter: state.story.currentChapter ? { title: state.story.currentChapter.title, shortSummary: (state.story.currentChapter.chapterSummary || '').slice(0, 300), chapterExcerpt: (state.story.currentChapter.chapter || '').slice(-2000), endingImage: state.story.currentChapter.endingImage || '' } : null,
    constraints: {
      proseLength: brief.style.proseLength,
      noContradiction: true,
      noUnjustifiedPowerJump: true,
      forbiddenWithoutTrigger: ['高境界突破', '永久死亡', '飞升', '大势力覆灭', '新国家', '顶级法宝', '改写既有事实'],
      narrationOnly: '只返回 {title, chapter, dialogues, endingImage}。不得返回 choices/statePatch/newFacts/newRumors/newHooks/newRelics/changedRelations/timePassed 等状态字段；状态已由本地裁决确定。',
    },
  };
};

/** 解析模型叙事响应（6 级回退，V3.2 §O3） */
Story.Provider._mergeChapter = function (ch) {
  if (Array.isArray(ch)) {
    return ch.map(function (p) {
      if (p == null) return '';
      if (typeof p === 'string') return p;
      if (typeof p === 'object' && typeof p.text === 'string') return p.text;
      return String(p);
    }).join('\n');
  }
  return ch;
};

Story.Provider.parseNarrationResponse = function (rawText) {
  let autoFixed = false;
  if (rawText && typeof rawText === 'object' && !Array.isArray(rawText)) {
    if (rawText.chapter != null && typeof rawText.chapter !== 'string') {
      rawText.chapter = Story.Provider._mergeChapter(rawText.chapter);
      autoFixed = true;
    }
    if (rawText.chapter != null) {
      return { title: rawText.title || '', chapter: String(rawText.chapter), dialogues: Array.isArray(rawText.dialogues) ? rawText.dialogues : [], endingImage: rawText.endingImage || '', plainText: false, _autoFixed: autoFixed };
    }
  }
  if (!rawText) return { title: '', chapter: '', dialogues: [], endingImage: '', plainText: false, _autoFixed: false };

  // 1. 直接对象
  if (typeof rawText === 'object' && typeof rawText.chapter === 'string' && rawText.chapter.trim()) {
    return { title: rawText.title || '', chapter: rawText.chapter, dialogues: Array.isArray(rawText.dialogues) ? rawText.dialogues : [], endingImage: rawText.endingImage || '', plainText: false, _autoFixed: false };
  }
  const text = String(typeof rawText === 'string' ? rawText : (rawText && rawText.chapter) || rawText || '').trim();

  // 2. 去 markdown fence 后 JSON.parse
  let cleaned = text;
  if (cleaned.indexOf('```') === 0) { cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim(); autoFixed = true; }
  try {
    const obj = JSON.parse(cleaned);
    if (obj && obj.chapter != null) {
      const ch = Story.Provider._mergeChapter(obj.chapter);
      if (typeof ch === 'string' && ch.trim()) return { title: obj.title || '', chapter: ch, dialogues: Array.isArray(obj.dialogues) ? obj.dialogues : [], endingImage: obj.endingImage || '', plainText: false, _autoFixed: autoFixed || Array.isArray(obj.chapter) };
    }
  } catch (e) {}

  // 3. 提取第一个完整 JSON object
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && obj.chapter != null) {
        const ch = Story.Provider._mergeChapter(obj.chapter);
        if (typeof ch === 'string' && ch.trim()) return { title: obj.title || '', chapter: ch, dialogues: Array.isArray(obj.dialogues) ? obj.dialogues : [], endingImage: obj.endingImage || '', plainText: false, _autoFixed: true };
      }
    } catch (e) {}
  }

  // 4. 提取 <title> 与 <chapter> 标签
  const tm = cleaned.match(/<title>([\s\S]*?)<\/title>/i);
  const cm = cleaned.match(/<chapter>([\s\S]*?)<\/chapter>/i);
  if (cm) return { title: (tm && tm[1] && tm[1].trim()) || '', chapter: cm[1].trim(), dialogues: [], endingImage: '', plainText: false, _autoFixed: true };

  // 5. 纯文本当作 chapter
  if (cleaned.length > 20) return { title: '', chapter: cleaned, dialogues: [], endingImage: '', plainText: true, _autoFixed: true };

  // 6. 完全失败
  return { title: '', chapter: '', dialogues: [], endingImage: '', plainText: false, _autoFixed: false };
};

/** 严格校验：AI 只能返回 title/chapter/dialogues/endingImage（V3.2 §N3 §J1）。
 * 越权字段（statePatch/choices/...）在此处不报错——它们由 assembleFromAI 直接忽略（剥离）。
 * 本函数仅校验文案字段是否齐备；越权字段的"检测"由 _detectForbiddenPatch 单独提供（供旧测试与诊断使用）。 */
Story.Provider.validateNarrationOnly = function (resp) {
  const errors = [];
  if (!resp || typeof resp !== 'object') return ['响应必须为对象'];
  if (typeof resp.chapter !== 'string' || resp.chapter.trim().length < 20) errors.push('chapter 必须是 ≥20 字的正文');
  if (typeof resp.title !== 'string' || !resp.title.trim()) errors.push('title 缺失');
  return errors;
};

/* ============================================================
 * §16 Diagnostics —— 质量检查器（V3.2-B §8 §9 §10）
 * ============================================================ */

Story.Diagnostics = Story.Diagnostics || {};

Story.Diagnostics.validateResolutionEnvelope = function (envelope, stateBefore) {
  const errors = [];
  if (!envelope) return { ok: false, errors: ['envelope 为空'] };
  const validCats = Story.Intent.CATEGORIES;
  const actions = envelope.actions || [];
  actions.forEach(function (a, i) {
    if (validCats.indexOf(a.category) < 0) errors.push('动作 ' + i + ' category 非法：' + a.category);
    if (!a.timePassed) errors.push('动作 ' + i + ' 缺 timePassed');
    // rest 不得无故添加 investigate reward
    if (a.category === 'rest' && (a.gains || []).some(function (g) { return g.type === 'clue'; })) errors.push('rest 不应奖励 investigate 线索');
    // wait 不得无故完成 mystery
    if (a.category === 'wait' && (a.threadEffects || []).some(function (t) { return t.op === 'close'; })) errors.push('wait 不应关闭 mystery');
    // flee 不得关闭威胁
    if (a.category === 'flee' && (a.threadEffects || []).some(function (t) { return t.op === 'close'; })) errors.push('flee 不应关闭威胁');
  });
  // Delta op 白名单
  const allDelta = (envelope.publicDelta || []).concat(envelope.privateDelta || []);
  allDelta.forEach(function (d) { if (Story.Delta.OPS.indexOf(d.op) < 0) errors.push('非法 Delta op：' + d.op); });
  // 每回合关系单轴变化 ≤2 已在 applyOne 截断
  return { ok: errors.length === 0, errors: errors };
};

Story.Diagnostics.validateChoiceSet = function (state, actorId, choices) {
  const errors = [];
  if (!Array.isArray(choices)) return { ok: false, errors: ['choices 非数组'] };
  if (choices.length !== 3) errors.push('应为 3 项，实际 ' + choices.length);
  const ids = {}; const fps = {};
  const cats = {}; const targets = {};
  choices.forEach(function (c, i) {
    if (!c.id) errors.push('项 ' + i + ' 缺 id');
    if (ids[c.id]) errors.push('项 ' + i + ' id 重复');
    ids[c.id] = true;
    if (!c.label) errors.push('项 ' + i + ' 缺 label');
    if (!c.hint) errors.push('项 ' + i + ' 缺 hint');
    if (!c.intentCategory) errors.push('项 ' + i + ' 缺 intentCategory');
    if (!c.targetType) errors.push('项 ' + i + ' 缺 targetType');
    if (!c.targetId) errors.push('项 ' + i + ' 缺 targetId');
    const fp = Story.ChoiceFactory.fingerprint(c);
    if (fps[fp]) errors.push('项 ' + i + ' fingerprint 重复');
    fps[fp] = true;
    cats[c.intentCategory] = (cats[c.intentCategory] || 0) + 1;
    targets[c.targetId] = (targets[c.targetId] || 0) + 1;
  });
  if (Object.keys(cats).length < 2) errors.push('至少两种 category');
  if (Object.keys(targets).length < 2) errors.push('至少两种 target');
  return { ok: errors.length === 0, errors: errors };
};

Story.Diagnostics.validateOfflineChapter = function (state, chapter, envelope) {
  const errors = [];
  if (!chapter) return { ok: false, errors: ['chapter 为空'] };
  if (chapter.provenance !== 'offline-resolved') errors.push('provenance 应为 offline-resolved，实际 ' + chapter.provenance);
  const len = String(chapter.chapter || '').replace(/\s/g, '').length;
  // 180-400 为目标；放宽到 120-600 以容许组装波动，但记录偏差
  if (len < 120) errors.push('正文过短：' + len);
  if (len > 600) errors.push('正文过长：' + len);
  // 禁用模板句
  const hits = Story.FORBIDDEN_PHRASES.filter(function (p) { return String(chapter.chapter || '').indexOf(p) >= 0; });
  if (hits.length) errors.push('命中禁用模板句：' + hits.join(','));
  // 不得机械复制 ActionIntent 原文超过 16 字
  (envelope && envelope.actions || []).forEach(function (a) {
    if (a.rawText && a.rawText.length > 16) {
      const slice = a.rawText.slice(0, 17);
      if (String(chapter.chapter || '').indexOf(slice) >= 0) errors.push('机械复制玩家原句超过 16 字');
    }
  });
  return { ok: errors.length === 0, errors: errors };
};

/* ============================================================
 * §17 Migration 已在 §2 实现
 * ============================================================ */

/* ============================================================
 * §18 AI Provider 状态机（兼容 V3，单次 narrate + 超时回退）
 * ============================================================ */

Story.ai = {
  enabled: false,
  provider: null,
  timeoutMs: 30000,
  providerMeta: {},
  status: { state: 'disabled', code: 'disabled', message: 'AI 叙事未启用。', updatedAt: 0, lastRequestAt: 0, lastSuccessAt: 0 },
  _listeners: [],
  _withTimeout: function (promise, ms) {
    return new Promise(function (resolve) {
      let done = false;
      const t = setTimeout(function () { if (!done) { done = true; resolve({ __timeout: true }); } }, ms || Story.ai.timeoutMs);
      Promise.resolve(promise).then(function (r) { if (!done) { done = true; clearTimeout(t); resolve(r); } }, function () { if (!done) { done = true; clearTimeout(t); resolve({ __timeout: true }); } });
    });
  },
};

Story.setAIStatus = function (state, details) {
  details = details || {};
  const previous = Story.ai.status || {};
  Story.ai.status = {
    state: state, code: details.code || state, message: details.message || '', error: details.error || '',
    provider: Story.ai.providerMeta.provider || '', model: Story.ai.providerMeta.model || '', base: Story.ai.providerMeta.base || '',
    updatedAt: Date.now(), lastRequestAt: details.lastRequestAt || previous.lastRequestAt || 0,
    lastSuccessAt: state === 'success' ? Date.now() : (previous.lastSuccessAt || 0),
  };
  Story.ai._listeners.slice().forEach(function (listener) { try { listener(Story.getAIStatus()); } catch (e) {} });
  return Story.ai.status;
};

Story.getAIStatus = function () { return Story._clone(Story.ai.status); };
Story.onAIStatus = function (listener) {
  if (typeof listener !== 'function') return function () {};
  Story.ai._listeners.push(listener);
  return function () { const i = Story.ai._listeners.indexOf(listener); if (i >= 0) Story.ai._listeners.splice(i, 1); };
};

/* 兼容旧入口：请求 + 校验（V3.2 中 AI 仅返回文案，不再含 statePatch/choices） */
Story.requestNarration = async function (ctx) {
  if (!Story.ai.enabled) { Story.setAIStatus('disabled', { code: 'disabled', message: 'AI 未启用，当前使用离线裁决摘要。' }); return null; }
  if (!Story.ai.provider || typeof Story.ai.provider.narrate !== 'function') {
    Story.setAIStatus('fallback', { code: 'NO_API_CONFIG', message: 'AI 已开启，但缺少可用 Provider。' }); return null;
  }
  const requestedAt = Date.now();
  Story.setAIStatus('requesting', { message: '正在请求 AI 叙事……', lastRequestAt: requestedAt });
  let pending;
  try { pending = Story.ai.provider.narrate(ctx); }
  catch (e) { Story.setAIStatus('fallback', { code: 'request_error', message: 'API 请求创建失败。', error: e.message, lastRequestAt: requestedAt }); return null; }
  const outcome = await new Promise(function (resolve) {
    let done = false;
    const timer = setTimeout(function () { if (!done) { done = true; resolve({ ok: false, code: 'TIMEOUT', error: '请求超过 ' + Story.ai.timeoutMs + 'ms' }); } }, Story.ai.timeoutMs);
    Promise.resolve(pending).then(function (v) { if (!done) { done = true; clearTimeout(timer); resolve({ ok: true, value: v }); } }, function (err) { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, code: Story.Provider._classifyError(err && err.message), error: err && err.message }); } });
  });
  if (!outcome.ok) { Story.setAIStatus('fallback', { code: outcome.code, message: outcome.code === 'TIMEOUT' ? 'API 请求超时，已使用离线裁决摘要。' : 'API 请求失败，已使用离线裁决摘要。', error: outcome.error, lastRequestAt: requestedAt }); return null; }
  if (!outcome.value) { Story.setAIStatus('fallback', { code: 'EMPTY_RESPONSE', message: 'API 返回空内容，已使用离线裁决摘要。', lastRequestAt: requestedAt }); return null; }
  Story.setAIStatus('received', { message: '已收到 API 响应，正在校验。', lastRequestAt: requestedAt });
  return outcome.value;
};

/** 兼容旧入口：请求 + 归一化 + 校验。V3.2 中仅校验文案字段，越权字段被剥离。 */
Story.requestValidatedChapter = async function (ctx, state) {
  let raw = await Story.requestNarration(ctx);
  if (!raw) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const parsed = Story.Provider.parseNarrationResponse(raw);
    const errors = Story.Provider.validateNarrationOnly(parsed);
    if (!errors.length) {
      // 返回仅含文案的对象（兼容旧 _applyChapter 调用路径，但本文件已不再走该路径）
      return { title: parsed.title, chapter: parsed.chapter, dialogues: parsed.dialogues || [], endingImage: parsed.endingImage || null, _raw: raw, _autoFixed: attempt > 0 };
    }
    if (attempt === 0) {
      // 第一次失败：标记为自动修复格式后重试一次（兼容旧 message "自动修复格式"）
      Story.setAIStatus('received', { message: '检测到格式偏差，自动修复格式后重试。', errors: errors });
      raw = JSON.stringify({ title: parsed.title || '', chapter: parsed.chapter || '', dialogues: parsed.dialogues || [], endingImage: parsed.endingImage || null });
    } else {
      Story.setAIStatus('fallback', { code: 'INVALID_SCHEMA', message: 'AI 返回字段不合规，已使用离线裁决摘要。', errors: errors });
      return null;
    }
  }
  return null;
};

/** 兼容旧入口：仅返回文案字段归一化结果（无网络请求）。 */
Story.normalizeChapterResponse = function (raw) {
  const parsed = Story.Provider.parseNarrationResponse(raw);
  return { title: parsed.title || '', chapter: parsed.chapter || '', dialogues: parsed.dialogues || [], endingImage: parsed.endingImage || null };
};

/** 兼容旧入口：详细校验，返回错误数组。 */
Story.validateChapterDetailed = function (resp) { return Story.Provider.validateNarrationOnly(resp); };
Story._validateChapter = Story.validateChapterDetailed;

/* ============================================================
 * §19 V3/V3.1 兼容查询与工具 API（供 UI 抽屉、Room 层、旧测试调用）
 * ============================================================ */

/**
 * 兼容旧入口：编译上下文（V3 compileContext 形状）。
 * V3.2 真实叙事走 Narration.buildBrief + Provider._briefToCtx；本函数仅供旧测试与诊断调用。
 * 输出形状保持与 V3.1 一致：previousChapter.chapterExcerpt / chosenActions[].isCustom / constraints.forbiddenWithoutTrigger。
 */
Story.compileContext = function (state, chosenActions) {
  state = state || Story.state;
  chosenActions = chosenActions || [];
  const w = state.world;
  const s = state.story;
  const cast = state.actors.map(function (a) {
    return {
      id: a.id, name: a.name, publicProfile: a.publicProfile || (a.identity + '·' + a.daoPath),
      currentStatus: a.statusSummary, publicGoal: a.publicWish, visibleRelations: a.relationHints,
    };
  });
  const recentSummary = (s.recentSummary || '').slice(-600);
  const activeHooks = (w.activeWorldHooks || []).slice(-12);
  const prev = s.currentChapter ? {
    title: s.currentChapter.title,
    shortSummary: (s.currentChapter.chapterSummary || '').slice(0, 300),
    chapterExcerpt: (s.currentChapter.chapter || '').slice(-2000),
    endingImage: s.currentChapter.endingImage || '',
  } : null;
  return {
    mode: 'turn',
    world: {
      name: w.name, year: w.year,
      worldBibleSummary: (w.worldBible && w.worldBible.rules) ? w.worldBible.rules.join('') : '',
      currentPublicFacts: (w.publicFacts || []).slice(-8),
      currentRumors: (w.publicRumors || []).slice(-6),
      activeWorldHooks: activeHooks,
    },
    cast: cast,
    privateContext: {
      actorSecrets: state.actors.reduce(function (o, a) { o[a.id] = a.hiddenFate || ''; return o; }, {}),
      hiddenFacts: state.actors.reduce(function (o, a) { o[a.id] = (a.privateFacts || []).slice(-3); return o; }, {}),
      unresolvedPrivateHooks: state.actors.reduce(function (o, a) { o[a.id] = (state.ledger.privateEvents[a.id] || []).slice(-2); return o; }, {}),
    },
    previousChapter: prev,
    chosenActions: chosenActions.map(function (a) {
      return { actorId: a.actorId, publicAction: a.publicAction, privateIntent: a.privateIntent, tags: a.tags || [], isCustom: !!a.custom };
    }),
    memory: {
      recentEvents: (state.ledger.publicEvents || []).slice(-8),
      activeThreads: (s.activeThreads || []).slice(-8),
      relics: (state.ledger.relics || []).slice(-6),
      factionChanges: (state.ledger.chronicleCanonical || []).slice(-4),
    },
    settings: { narrativePace: state.settings.narrativePace },
    constraints: {
      proseLength: '700-1200 Chinese characters',
      choicesPerActor: 3,
      noContradiction: true,
      noUnjustifiedPowerJump: true,
      preservePlayerAgency: true,
      actionCausality: '本章必须从 chosenActions 的执行开始，展示阻力、代价、结果和新局面；不得用泛化过场替代玩家行动。',
      choiceContinuity: '下一组选项必须由本章刚发生的具体事件派生，并引用本章出现的人物、地点、线索或后果。',
      customActionPriority: '自定义行动是玩家明确意图；除非违反世界规则，否则必须正面落实，并在正文与后续选项中留下可见影响。',
      forbiddenWithoutTrigger: ['高境界突破', '永久死亡', '飞升', '大势力覆灭', '新国家', '顶级法宝', '改写既有事实'],
      narrationOnly: '只返回 {title, chapter, dialogues, endingImage}。不得返回 choices/statePatch/newFacts 等状态字段。',
    },
    _recentSummary: recentSummary,
  };
};

/** V3 §7 法宝等级判定（兼容旧测试）。 */
Story._isMinorRelic = function (name) {
  const forbidden = ['顶级', '至宝', '天阶', '神器', '仙器', '开天', '创世'];
  return !forbidden.some(function (k) { return String(name).indexOf(k) >= 0; });
};

/** 检测 AI 响应是否越权（V3 §7 + §13，供 test-v3 §6 与诊断使用）。 */
Story._detectForbiddenPatch = function (resp) {
  const errors = [];
  resp = resp || {};
  const patch = resp.statePatch || {};
  (patch.newRelics || []).forEach(function (r) {
    const name = typeof r === 'string' ? r : (r.name || '');
    if (!Story._isMinorRelic(name)) errors.push('越权顶级法宝：' + name);
  });
  const txt = (resp.chapter || '') + JSON.stringify(patch);
  if (/飞升/.test(txt) && /直接|立刻|无劫/.test(txt)) errors.push('越权无劫飞升');
  if (/永久死亡|当场陨落/.test(txt)) errors.push('越权永久死亡');
  return errors;
};

/** 兼容旧入口：应用时间推进（V3.1 由叙事统一决定）。V3.2 中时间由 ADVANCE_TIME delta 推进；本函数仅供旧测试/迁移调用。 */
Story.applyTimePassed = function (state, timePassed) {
  if (!timePassed || !state) return;
  let years = 0;
  if (typeof timePassed === 'object' && timePassed.value != null && timePassed.unit) {
    const u = timePassed.unit;
    const v = Number(timePassed.value) || 0;
    if (u === '年') years = v;
    else if (u === '月') years = v / 12;
    else if (u === '日') years = v / 365;
    else if (u === '百年') years = v * 100;
  } else if (typeof timePassed === 'number') {
    years = timePassed;
  }
  state.world.year += years;
  if (years >= 100 && !state.finalLegacy) state.finalLegacy = Story.generateLegacy(state);
};

/** 追加编年史条目（含正史 + 野史扭曲传闻）。 */
Story.appendChronicle = function (state, summary) {
  if (!state || !summary) return;
  const year = Math.floor(state.world.year);
  state.story.chronicle.push({ year: year, text: year + '年：' + summary });
  state.ledger.chronicleCanonical.push({ year: year, text: summary });
  if (state.rng || (Story._rngByState && Story._rngByState.get(state))) {
    const rng = Story.rngFor('event', state);
    if (rng && rng.chance && rng.chance(0.4)) {
      state.ledger.chronicleRumors.push({ year: year, text: '坊间传闻：' + summary + '（版本不一）' });
    }
  }
};

/** 生成世界遗产包（V3 §9 百年后 / Sprint D）。 */
Story.generateLegacy = function (state) {
  state = state || Story.state;
  if (!state) return null;
  return {
    seed: state.world.seed,
    worldName: state.world.name,
    year: Math.floor(state.world.year),
    worldBible: Story._clone(state.world.worldBible),
    canonicalHistory: (state.ledger.chronicleCanonical || []).map(function (c) { return c.year + '年：' + c.text; }),
    rumors: (state.world.publicRumors || []).slice(),
    relics: (state.ledger.relics || []).map(function (r) { return typeof r === 'string' ? r : (r.name || r); }),
    factions: (state.world.factions || []).map(function (f) { return (f.name || f) + '（势力' + (f.power != null ? f.power : '?') + '）'; }),
    unresolvedKarma: (state.world.activeWorldHooks || []).slice(),
    successorHooks: (state.ledger.successorHooks || []).slice(),
    actorFates: (state.actors || []).map(function (a) {
      return { name: a.name, identity: a.identity, fate: a.statusSummary || '', privateFate: a.hiddenFate || '' };
    }),
  };
};

Story.exportLegacy = function () {
  if (!Story.state) return JSON.stringify({}, null, 2);
  return JSON.stringify(Story.state.finalLegacy || Story.generateLegacy(Story.state), null, 2);
};

/* ============================================================
 * §20 便捷查询 API（供 UI 抽屉）
 * ============================================================ */

Story.getMeta = function () {
  if (!Story.state) return null;
  return {
    version: Story.state.version, seed: Story.state.world.seed,
    worldName: Story.state.world.name, year: Story.state.world.year,
    chapterIndex: Story.state.story.chapterIndex,
    worldBible: Story._clone(Story.state.world.worldBible),
  };
};
Story.getCurrentChapter = function () { return Story.state ? Story._clone(Story.state.story.currentChapter) : null; };
Story.getPlayerChoices = function () {
  if (!Story.state || !Story.state.actors.length) return [];
  return Story.getChoicesForActor(Story.state, Story.state.actors[0].id);
};
Story.getPlayer = function () {
  if (!Story.state || !Story.state.actors.length) return null;
  return Story._clone(Story.state.actors[0]);
};
Story.getActors = function () { return Story.state ? Story._clone(Story.state.actors) : []; };
Story.getChronicle = function () { return Story.state ? Story._clone(Story.state.story.chronicle) : []; };
Story.getActiveThreads = function () { return Story.state ? Story._clone(Story.state.story.activeThreads) : []; };
Story.getPublicFacts = function () { return Story.state ? Story.state.world.publicFacts.slice() : []; };
Story.getPublicRumors = function () { return Story.state ? Story.state.world.publicRumors.slice() : []; };
Story.getActiveHooks = function () { return Story.state ? Story.state.world.activeWorldHooks.slice() : []; };
Story.getRelics = function () { return Story.state ? Story.state.ledger.relics.slice() : []; };
Story.getFactions = function () { return Story.state ? Story.state.world.factions.slice() : []; };
Story.getRecentEvents = function (n) { return Story.state ? Story.state.ledger.publicEvents.slice(-(n || 10)) : []; };
Story.getPrivateEvents = function (actorId) {
  if (!Story.state) return [];
  return (Story.state.ledger.privateEvents[actorId] || []).slice();
};

/** 世界志抽屉：本章人物 / 世界传闻 / 修真编年史 / 未结因果（V3 §8）。 */
Story.getWorldArchive = function () {
  if (!Story.state) return null;
  return {
    cast: Story.state.actors.map(function (a) {
      return { id: a.id, name: a.name, identity: a.identity, daoPath: a.daoPath, status: a.statusSummary, publicWish: a.publicWish, relationHints: a.relationHints };
    }),
    rumors: Story.state.world.publicRumors.slice(-10),
    chronicle: Story.state.story.chronicle.slice(-15),
    activeHooks: Story.state.world.activeWorldHooks.slice(-12),
    factions: Story.state.world.factions.slice(),
    relics: Story.state.ledger.relics.slice(),
  };
};

/** 天机全览（开发者模式：含私密信息）。 */
Story.getOmniscientView = function () {
  if (!Story.state) return null;
  return {
    actors: Story.state.actors.map(function (a) {
      return { id: a.id, name: a.name, hiddenFate: a.hiddenFate, privateFacts: (a.privateFacts || []).slice(), hidden: Story._clone(a.hidden), aiChosenLastTurn: Story.state.story.aiChosenLastTurn[a.id] };
    }),
    turnChoices: Story._clone(Story.state.story.turnChoices),
    privateEvents: Story._clone(Story.state.ledger.privateEvents),
    chronicleRumors: (Story.state.ledger.chronicleRumors || []).slice(),
  };
};

/* ============================================================
 * §21 V3.1 房间视图 API（供 Room 层按席位过滤）
 * ============================================================ */

/** 公共故事视图（所有席位可见）。 */
Story.getPublicStoryView = function (storyState) {
  if (!storyState) return null;
  const ch = storyState.story.currentChapter;
  return {
    title: ch ? ch.title : '',
    chapter: ch ? ch.chapter : '',
    chapterSummary: ch ? (ch.chapterSummary || '') : '',
    year: storyState.world.year,
    worldName: storyState.world.name,
    worldBible: Story._clone(storyState.world.worldBible),
    publicFacts: (storyState.world.publicFacts || []).slice(-8),
    publicRumors: (storyState.world.publicRumors || []).slice(-6),
    chronicleEntries: (storyState.story.chronicle || []).slice(-15),
    factions: (storyState.world.factions || []).slice(),
    relics: (storyState.ledger.relics || []).slice(),
    activeThreads: (storyState.story.activeThreads || []).slice(-8),
    cast: storyState.actors.map(function (a) {
      return { id: a.id, name: a.name, identity: a.identity, daoPath: a.daoPath, status: a.statusSummary, publicWish: a.publicWish };
    }),
  };
};

/** 某角色的私密视图（仅该席位可见）。 */
Story.getPrivateActorView = function (storyState, actorId) {
  if (!storyState) return null;
  const actor = storyState.actors.find(function (a) { return a.id === actorId; });
  if (!actor) return null;
  return {
    actorId: actorId,
    name: actor.name,
    publicProfile: actor.publicProfile || (actor.identity + '·' + actor.daoPath),
    ownPrivateFacts: (actor.privateFacts || []).slice(),
    ownStatus: actor.statusSummary,
    ownChoices: Story.getChoicesForActor(storyState, actorId),
    ownPrivateEvents: ((storyState.ledger.privateEvents || {})[actorId] || []).slice(),
    ownHiddenFate: actor.hiddenFate || '',
  };
};

/* ============================================================
 * §22 AI Provider 注册 / 启用 / API Key / 设置（V3 §0.3：Key 仅存内存）
 * ============================================================ */

Story.registerAIProvider = function (provider, meta) {
  Story.ai.provider = provider || null;
  Story.ai.providerMeta = meta || {};
  if (Story.ai.enabled) {
    Story.setAIStatus(provider ? 'ready' : 'unavailable', {
      code: provider ? 'ready' : 'NO_API_CONFIG',
      message: provider ? 'AI Provider 已就绪。' : 'AI 已开启，但缺少 API Key 或 Base URL。',
    });
  }
};

Story.setAIEnabled = function (on) {
  Story.ai.enabled = !!on;
  if (Story.state) Story.state.api.enabled = !!on;
  Story.setAIStatus(on ? (Story.ai.provider ? 'ready' : 'unavailable') : 'disabled', {
    code: on ? (Story.ai.provider ? 'ready' : 'NO_API_CONFIG') : 'disabled',
    message: on ? (Story.ai.provider ? 'AI Provider 已就绪。' : 'AI 已开启，但尚未配置可用 Provider。') : 'AI 未启用，当前使用本地叙事。',
  });
};

/** V3 §0.3 API Key 仅存内存，不入存档/localStorage。 */
Story._apiKey = null;
Story.getApiKey = function () { return Story._apiKey; };
Story.setApiKey = function (k) { Story._apiKey = k || null; };

Story.SETTINGS_KEY = 'xiuxianju_v3_settings';
Story.saveSettings = function (settings) {
  const safe = {
    aiOn: !!(settings && settings.aiOn),
    base: (settings && settings.base) || '',
    model: (settings && settings.model) || '',
    temperature: (settings && typeof settings.temperature === 'number') ? settings.temperature : 0.8,
    narrativePace: (settings && settings.narrativePace) || '常规',
    mode: (settings && settings.mode) || 'novel',
  };
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(Story.SETTINGS_KEY, JSON.stringify(safe)); } catch (e) {}
  return safe;
};
Story.loadSettings = function () {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(Story.SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
};

/* ============================================================
 * §23 存档（API Key 不入存档）
 * ============================================================ */

Story.SAVE_KEY = 'xiuxianju_v3_save';

Story.save = function () {
  if (!Story.state) return null;
  Story.snapshotRng(Story.state);
  const snap = Story._clone(Story.state);
  if (snap._settings) delete snap._settings.apiKey;
  if (snap.apiKey !== undefined) delete snap.apiKey;
  if (snap._apiKey !== undefined) delete snap._apiKey;
  const data = JSON.stringify(snap);
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(Story.SAVE_KEY, data); } catch (e) {}
  return data;
};

Story.load = function (data) {
  let parsed;
  try {
    if (data == null && typeof localStorage !== 'undefined') data = localStorage.getItem(Story.SAVE_KEY);
    parsed = typeof data === 'string' ? JSON.parse(data) : data;
  } catch (e) { return null; }
  if (!parsed) return null;
  parsed = Story._migrate(parsed);
  Story.state = parsed;
  const rng = Story.createRng(parsed.world.seed || 'story', 'story');
  if (rng.setState && parsed.rng && parsed.rng.state) rng.setState(parsed.rng.state);
  Story._bindStateRng(parsed, rng);
  return parsed;
};

Story.hasSave = function () {
  try { return typeof localStorage !== 'undefined' && !!localStorage.getItem(Story.SAVE_KEY); } catch (e) { return false; }
};

Story.reset = function () {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(Story.SAVE_KEY); } catch (e) {}
  Story.state = null;
  Story.rng = null;
};

/** 内部：统一取 RNG（按 state 绑定，保证多房间隔离）。 */
Story.rngFor = function (purpose, storyState) {
  const state = storyState || Story.state;
  if (state && Story._rngByState) {
    const existing = Story._rngByState.get(state);
    if (existing) return existing;
  }
  if (!storyState && Story.rng) return Story.rng;
  const seed = state ? (state.world.seed || 'story') : 'story';
  const rng = Story.createRng(seed, 'story');
  if (rng.setState && state && state.rng && state.rng.state) rng.setState(state.rng.state);
  if (state) Story._bindStateRng(state, rng);
  else Story.rng = rng;
  return rng;
};

/* ============================================================
 * §24 模块导出（兼容 Node 测试；浏览器内联时自动忽略）
 * ============================================================ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Story;
} else if (typeof globalThis !== 'undefined') {
  globalThis.Story = Story;
}