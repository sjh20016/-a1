/**
 * ============================================================================
 * 《修行局》V3.4.0 —— 导演清污 + 权威 WebSocket 联机后端
 * ============================================================================
 * 核心原则（V3.4.0）：
 *   先结算，后写文。先写账本，后写小说。
 *   玩家行动 → IntentParser 识别意图 → TurnResolver 本地确定结果/代价/时间/
 *   关系/世界变化 → StateDelta 写入账本与场景 → ChoiceFactory 本地生成下一轮选项
 *   → Narration.buildBrief → AI 只把既定事实写成小说（仅 title/chapter/dialogues/
 *   endingImage）；AI 失败进入 narration_failed，不再使用玩家可见离线叙事。
 *   AI 不得改变任何世界状态；重新润色章节不得重新结算。
 *
 * 兼容：保留 V3/V3.1 全部公开 API（startGame/playTurn/save/load/reset/
 *   setAIEnabled/registerAIProvider/resolveTurn/getChoicesForActor/
 *   getPublicStoryView/getPrivateActorView/aiChoose/choiceScore/compileContext…）。
 *
 * 命名空间：Story.Intent / Story.Scene / Story.Resolver / Story.Delta /
 *   Story.ChoiceFactory / Story.Agent / Story.Narration / Story.Provider /
 *   Story.Diagnostics / Story.Migration / Story.Director
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

Story.VERSION = '3.4.0';

/** V3.3 回合状态机阶段（Narration Transaction） */
Story.TURN_PHASES = ['collecting', 'locked', 'resolving', 'awaiting_narration', 'narration_failed', 'published'];

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

/* V3.3.1 骰子阶段角色随机设定池 */
Story.RANDOM_SETUP = {
  maleNames: ['陆沉霄', '顾惊鸿', '韩霜刃', '沈墨渊', '谢长风', '裴孤云', '姜寒石', '苏断流', '叶无咎', '萧野禅', '林渡厄', '白剑鸣', '秦问天', '楚归尘', '温九渊'],
  femaleNames: ['陆知微', '沈青萝', '苏晚莺', '柳含烟', '叶清霜', '白素衣', '花落影', '云无心', '阮明珠', '谢流萤', '林疏桐', '姜雪涧', '裴月白', '顾念卿', '秦霜序'],
  identities: ['青霄宗外门弟子', '散修游医', '落魄剑客', '无名观道童', '边城铁匠', '流亡士族', '药谷弃徒', '叛逃阵修', '破落商队护卫', '守墓人'],
  daoPaths: ['剑修', '丹道', '阵法', '游侠'],
  wishes: [
    '夺得传承，证明自己不是庸才',
    '找回失落的师门信物',
    '查明身世，解开心结',
    '寻一处能安身立命的洞府',
    '还清欠下的因果债',
    '为故人讨回公道',
    '写出属于自己的修行之道',
    '活到下一个春天',
    '在边城站住脚，不再漂泊',
    '找到那个在梦中唤我名字的人',
    '修成金丹，脱离凡俗',
    '留下一段有人记得的故事',
  ],
  fates: [
    '残剑中的剑灵似乎认识我，却始终不肯相认',
    '血液里藏着一段不属于人类的旧梦',
    '家族阵纹的一角被人铸进了边城地基',
    '命盘上有一道被刻意抹去的痕迹',
    '曾在某个雨夜见过不该看见的东西',
    '体内有一缕不属于自己的气运',
    '每次濒死都能隐约听见有人在唤我',
    '我的影子偶尔会多做一件事',
    '出生时天降异象，被师门刻意隐瞒',
    '有一封从未拆开的信，发信人已不在世',
    '有人说我长得像两百年前的那个人',
    '我的修行瓶颈不是天资，是诅咒',
  ],
};

/**
 * 随机生成角色立命数据（骰子阶段使用）
 * @param {string} seed
 * @returns {{ name, identity, daoPath, publicWish, hiddenFate, personalityTags }}
 */
Story.randomizeCharacterSetup = function (seed) {
  var rng = Story.createRng(seed, 'randomize:setup');
  var genderIdx = rng.int(0, 1);
  var names = genderIdx === 0 ? Story.RANDOM_SETUP.maleNames : Story.RANDOM_SETUP.femaleNames;
  var dao = Story.RANDOM_SETUP.daoPaths[rng.int(0, Story.RANDOM_SETUP.daoPaths.length - 1)];
  return {
    name: names[rng.int(0, names.length - 1)],
    identity: Story.RANDOM_SETUP.identities[rng.int(0, Story.RANDOM_SETUP.identities.length - 1)],
    daoPath: dao,
    publicWish: Story.RANDOM_SETUP.wishes[rng.int(0, Story.RANDOM_SETUP.wishes.length - 1)],
    hiddenFate: Story.RANDOM_SETUP.fates[rng.int(0, Story.RANDOM_SETUP.fates.length - 1)],
    personalityTags: (Story.PERSONALITY_TAGS[dao] || []).slice(0, 2),
  };
};

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

Story.createEmptyState = function (seed) {
  return {
    version: Story.VERSION,
    world: {
      seed: seed || '', name: '', year: 1,
      worldBible: {},
      publicFacts: [],
      publicRumors: [],
      activeWorldHooks: [],
      factions: [],
      regions: [],
    },
    actors: [],
    assets: [],                       // V3.3 Phase 3：AssetRegistry 资产登记表
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
      // V3.3 Narration Transaction：回合状态机 + 待提交裁决包
      turnPhase: 'collecting',     // collecting|locked|resolving|awaiting_narration|published
      pendingResolution: null,     // {turnId,envelope,actionsByActorId,botActions,sceneBefore,chapterIndexBefore,createdAt,retryCount,lastNarrationError}
      // V3.3.2 Director：卷纲导演系统
      director: {
        phase: 'inactive',         // inactive | voting | active | completed
        candidates: [],
        votesByActorId: {},
        generatedRecipes: {},     // V3.3.6：测试/未来动态卷纲的房间级 Recipe
        activeArc: null,           // { arcId, recipeId, family, title, publicPitch, tags, status, startedAtChapter, currentBeatIndex, beats, pressureClocks, divergenceLog, revealLog }
        dormantArcs: [],
        completedArcs: [],
        lastDirectorEvent: null,
      },
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
  // V3.3 Narration Transaction 字段
  if (!st.turnPhase) st.turnPhase = 'collecting';
  if (!st.pendingResolution) st.pendingResolution = null;
  // V3.3.2 Director
  if (!st.director) st.director = {
    phase: 'inactive', candidates: [], votesByActorId: {},
    generatedRecipes: {}, activeArc: null, dormantArcs: [], completedArcs: [], lastDirectorEvent: null,
  };
  if (!st.director.generatedRecipes) st.director.generatedRecipes = {};
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
    // V3.3 Phase 2：每角色位置/在场状态
    if (a.locationId === undefined) a.locationId = (st.currentScene && st.currentScene.locationId) || null;
    if (!a.presence) a.presence = 'present';
    // V3.3 Phase 4：命盘（旧存档无则补，按种子确定性）
    if (!a.fatePlate && s.world && s.world.worldBible && s.world.seed) {
      a.fatePlate = Story.CharacterGenesis.rollFatePlate(s.world.seed, a, s.world.worldBible);
    }
  });
  // V3.3 Phase 3：AssetRegistry 资产登记表
  if (!s.assets) s.assets = [];
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
 * §3.5 CharacterGenesis —— 命盘（V3.3 Phase 4）
 * 世界骰只决定世界 bible；角色命盘由「种子 + 角色道途/性格」派生，
 * 写入 actor.fatePlate，供 UI 天机全览展示，不影响本地裁决与 RNG 主流。
 * ============================================================ */

Story.CharacterGenesis = Story.CharacterGenesis || {};

// 道途 → 本命星候选
Story.CharacterGenesis._DAO_STARS = {
  '剑修': ['破军', '七杀', '贪狼'],
  '丹道': ['天机', '太阴', '廉贞'],
  '阵法': ['武曲', '天府', '巨门'],
  '游侠': ['天相', '天梁', '擎羊'],
  '妖修': ['贪狼', '廉贞', '七杀'],
};

Story.CharacterGenesis._KARMIC = ['旧约未了', '残魂寄剑', '血契反噬', '前世寻人', '断缘重续', '债主临门'];
Story.CharacterGenesis._MERIDIAN = ['剑脉隐动', '药灵暗通', '阵骨自鸣', '魂脉残缺', '灵根含煞', '凡体藏锋'];
Story.CharacterGenesis._CURVE = ['先抑后扬', '先扬后抑', '平中见奇', '坎坷渐通', '晚成之相', '危中藏机'];

/** 掷出角色命盘（确定性：同 seed + 同 actor.id → 同命盘，独立 RNG 流不污染主流）。 */
Story.CharacterGenesis.rollFatePlate = function (seed, actor, worldBible) {
  const rng = Story.createRng(seed, 'genesis:' + (actor && (actor.id || actor.name) || 'x'));
  const dao = (actor && actor.daoPath) || '剑修';
  const stars = Story.CharacterGenesis._DAO_STARS[dao] || Story.CharacterGenesis._DAO_STARS['剑修'];
  const fateNumber = 1 + Math.floor(rng.next() * 9); // 1-9
  return {
    originStar:     rng.pick(stars),
    karmicThread:   rng.pick(Story.CharacterGenesis._KARMIC),
    hiddenMeridian: rng.pick(Story.CharacterGenesis._MERIDIAN),
    fateNumber:     fateNumber,
    lifeCurve:      rng.pick(Story.CharacterGenesis._CURVE),
    derivedAt:      (worldBible && worldBible.era) || '未知',
    gravityTag:     (worldBible && worldBible.gravityTag) || null,
  };
};

/** 命盘 → 公开可见的简短回响（不泄露私密，供 UI 角色卡展示）。 */
Story.CharacterGenesis.publicEcho = function (plate) {
  if (!plate) return '';
  return '本命' + plate.originStar + '·命数' + plate.fateNumber + '·' + plate.lifeCurve;
};

/* ============================================================
 * §4 角色建立
 * ============================================================ */

Story.createActor = function (setup, storyState) {
  setup = setup || {};
  const id = setup.id || ('actor_' + Math.floor(Story.rngFor('event', storyState).next() * 1e6).toString(36));
  const relations = Story.Delta._buildRelationMap({ startingRelation: setup.startingRelation || setup.relationHints, id: id }, (storyState && storyState.actors) || []);
  const sceneLoc = (storyState && storyState.story && storyState.story.currentScene && storyState.story.currentScene.locationId) || null;
  const actor = {
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
    // V3.3 Phase 2：每角色位置/在场状态（共享场景下 Bot 移动不重写全员位置）
    locationId: setup.locationId || sceneLoc || null,
    presence: setup.presence || 'present',   // 'present' | 'away'
    // V3.3 Phase 4：角色命盘
    fatePlate: setup.fatePlate || null,
  };
  // 命盘：若未提供且世界 bible 已就绪，则按种子确定性生成（独立 RNG 流）
  if (!actor.fatePlate && storyState && storyState.world && storyState.world.worldBible && storyState.world.seed) {
    actor.fatePlate = Story.CharacterGenesis.rollFatePlate(storyState.world.seed, actor, storyState.world.worldBible);
  }
  return actor;
};

Story.createPresetCompanions = function () {
  return Story.PRESET_COMPANIONS.map(function (tpl) { return Story.createActor(Story._clone(tpl)); });
};

/* ============================================================
 * §5 会话与开局
 * ============================================================ */

Story.createSession = async function (config) {
  config = config || {};
  var seed = config.seed || ('BLACKWIND-' + Math.floor(Math.random() * 9999));
  var roll = Story.rollOrigin(seed);
  var bible = config.worldConfig || Story.buildWorldBible(roll);

  var state = Story.createEmptyState();
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
    var a = Story.createActor(setup, state);
    if (!a.seatId) a.seatId = setup.seatId || ('seat_' + i);
    return a;
  });

  if (config.narrativePace) state.settings.narrativePace = config.narrativePace;

  // V3.3.2：若指定 skipOpening，跳过开局生成（等待 Director 投票后激活）
  if (!config.skipOpening) {
    await Story._generateOpening(state);
  }
  return state;
};

Story.startGame = async function (seed, playerSetup) {
  const player = Object.assign({}, playerSetup, { id: 'lu', seatId: 'seat_0' });
  const companions = Story.PRESET_COMPANIONS.map(function (tpl, i) { const c = Story._clone(tpl); c.seatId = 'seat_' + (i + 1); return c; });
  return Story.createSession({ seed: seed, actors: [player].concat(companions) });
};

/** 生成开局（V3.3 事务化）：创建场景 → 开局裁决 → 开局选项 → pendingResolution → awaiting_narration → AI → 提交。AI 失败停在 awaiting_narration，不调用离线兜底。 */
Story._generateOpening = async function (state) {
  // 1. 创建开局场景与初始线索
  state.story.currentScene = Story.Scene.createOpeningScene(state);
  state.story.activeThreads = Story.Scene.createOpeningThreads(state);
  if (state.story.director && state.story.director.activeArc) {
    Story.Director.applyArcOpeningScenePatch(state, state.story.director.activeArc);
    Story.Director.applyOpeningSeed(state, state.story.director.activeArc);
    Story.Director.applyArcAssets(state, state.story.director.activeArc);
  } else {
    Story.Director.applyDefaultOpeningAssets(state);
  }

  // 2. 开局裁决（不依赖玩家行动，建立初始局面）—— 纯计算，不应用
  const envelope = Story.Resolver.buildOpeningEnvelope(state);

  // 3. 诊断（生产安全回退，开发模式抛错）
  const diag = Story.Diagnostics.validateResolutionEnvelope(envelope, state);
  if (!diag.ok) {
    if (state.settings && state.settings.developerMode) throw new Error('开局 ResolutionEnvelope 校验失败：' + diag.errors.join('；'));
    Story.Resolver._applySafeFallback(envelope, diag.errors);
  }

  // 4. 进入 awaiting_narration：世界状态零变化，存 pendingResolution
  Story._setTurnPhase(state, 'awaiting_narration');
  state.story.pendingResolution = {
    turnId: 'turn_opening',
    envelope: envelope,
    actionsByActorId: {},
    botActions: {},
    sceneBefore: Story._clone(state.story.currentScene),
    chapterIndexBefore: state.story.chapterIndex,
    createdAt: Date.now(),
    retryCount: 0,
    lastNarrationError: null,
  };

  // 5. 调 AI 叙事
  const brief = Story.Narration.buildBrief(state, state.story.currentScene, envelope);
  const narration = Story.ai.enabled ? await Story.Provider.narrate(state, brief) : null;

  if (!narration || !narration.title || !narration.chapter) {
    // AI 失败：停在 narration_failed，不应用任何状态
    const errCode = state.api.lastErrorCode || 'NO_API_CONFIG';
    state.story.pendingResolution.lastNarrationError = {
      code: errCode,
      message: state.api.lastErrorMessage || 'AI 文本生成失败，本回合裁决已保留，等待重试。',
      rawPreview: '',
    };
    Story._setTurnPhase(state, 'narration_failed');
    return;
  }
  const directorViolation = Story.Narration.validateAgainstDirector(narration, brief.director);
  if (directorViolation) {
    Story.Narration.failPendingForDirectorViolation(state, directorViolation, false);
    return;
  }
  const coverageViolation = Story.Narration.validateCoverage(narration, brief);
  if (coverageViolation) {
    Story.Narration.failPendingForDirectorViolation(state, coverageViolation, false);
    return;
  }

  // 6. AI 成功：published —— 提交裁决 + 场景 + 选项 + 叙事
  Story._commitPendingResolution(state, narration, true);
};

/**
 * V3.3 提交 pendingResolution（开局/回合共用）。
 * 执行：applyEnvelope → composeNext → buildAll → assembleFromAI → applyNarration → chronicle → TurnRecord → 清空 pendingResolution → 回 collecting。
 */
Story._commitPendingResolution = function (state, narration, isOpening) {
  const s = state.story;
  const pr = s.pendingResolution;
  if (!pr) throw new Error('无 pendingResolution 可提交');
  const envelope = pr.envelope;
  Story._setTurnPhase(state, 'published');

  // 1. 应用裁决
  Story.Delta.applyEnvelope(state, envelope);
  // V3.3.1：应用 AgentArc 延迟提交（AI 失败时不提交，此处才写入 actor.agentArc）
  var agentArcDeltas = s._pendingAgentArcDeltas;
  if (agentArcDeltas) {
    Object.keys(agentArcDeltas).forEach(function (aid) {
      var d = agentArcDeltas[aid];
      var actor = state.actors.find(function (a) { return a.id === aid; });
      if (!actor) return;
      actor.agentArc = actor.agentArc || {};
      actor.agentArc.lastChoiceFingerprints = (actor.agentArc.lastChoiceFingerprints || []).concat([d.fingerprint]).slice(-4);
      actor.agentArc.lastChoiceCategories = (actor.agentArc.lastChoiceCategories || []).concat([d.category]).slice(-3);
      actor.agentArc.lastFocusedChapter = d.chapterIndex;
    });
    s._pendingAgentArcDeltas = null;
  }
  // V3.3.2：应用 DirectorPlan（AI 失败时不提交，此处才写入 activeArc）
  if (pr.directorPlan) {
    Story.Director.applyPlan(state, pr.directorPlan);
  }
  // 2. 场景演化（开局：sceneBefore 已是开局场景，沿用；回合：composeNext）
  if (isOpening) {
    // 开局场景在 _generateOpening 中已创建，这里不覆盖
  } else {
    s.currentScene = Story.Scene.composeNext(state, envelope);
  }
  // 3. 生成下一轮选项
  const choices = Story.ChoiceFactory.buildAll(state, s.currentScene, envelope);
  Story._writeChoices(state, choices);
  // 4. 叙事
  const chapter = Story.Narration.assembleFromAI(state, s.currentScene, envelope, narration);
  Story.Narration.applyNarration(state, chapter, envelope, !!isOpening);
  // 5. 编年史
  Story.appendChronicle(state, s.currentChapter.chapterSummary);
  // 6. 写入 TurnRecord
  const turnId = pr.turnId;
  const turnRecord = {
    turnId: turnId,
    chapterIndexBefore: pr.chapterIndexBefore,
    chapterIndexAfter: s.chapterIndex,
    submittedActions: Story._clone(pr.actionsByActorId),
    botActions: Story._clone(pr.botActions),
    resolutionEnvelope: Story._clone(envelope),
    sceneBefore: pr.sceneBefore,
    sceneAfter: Story._clone(s.currentScene),
    stateDeltaIds: (state.ledger.stateDeltas || []).slice(-envelope.publicDelta.length).map(function (d) { return d.op; }),
    narration: {
      provenance: s.currentChapter.provenance,
      title: s.currentChapter.title,
      chapterHash: Story.hashSeed(s.currentChapter.chapter || ''),
      providerErrorCode: state.api.lastErrorCode,
      retryCount: pr.retryCount,
    },
    directorPlan: pr.directorPlan ? { arcId: pr.directorPlan.arcId, beatId: pr.directorPlan.beatId, result: pr.directorPlan.result } : null,
    createdAt: Date.now(),
  };
  state.ledger.turnRecords.push(turnRecord);
  s.lastTurnRecordId = turnId;
  // 7. 清空 pendingResolution，回 collecting
  s.pendingResolution = null;
  Story._setTurnPhase(state, 'collecting');
  Story.snapshotRng(state);
  return state;
};

/**
 * V3.3.1 重试叙事（awaiting_narration 或 narration_failed 可调用）。
 * 复用同一 pendingResolution（envelope/botActions 不重算、不重选）。
 * options.modelOverride / options.providerOverride 可选（换模型重试）。
 * 软上限：retryCount >= 3 时 UI 提示但不阻止。
 */
Story.retryNarration = async function (storyState, options) {
  options = options || {};
  const state = storyState || Story.state;
  if (!state) throw new Error('无活动 StoryState');
  if (state.story.turnPhase !== 'awaiting_narration' && state.story.turnPhase !== 'narration_failed') {
    throw new Error('当前回合阶段不可重试叙事：' + state.story.turnPhase);
  }
  const pr = state.story.pendingResolution;
  if (!pr) throw new Error('无 pendingResolution，无法重试');
  Story._activateState(state);

  // 软上限提示（不阻止）
  if (pr.retryCount >= 3) {
    state.api.lastErrorMessage = (state.api.lastErrorMessage || '') + '（已重试 ' + pr.retryCount + ' 次，建议检查 API 配置或换模型。）';
  }

  // 换模型/Provider（可选）
  if (options.modelOverride && Story.ai.setModel) {
    try { Story.ai.setModel(options.modelOverride); } catch (e) {}
  }

  const isOpening = (pr.turnId === 'turn_opening');
  const scene = isOpening ? pr.sceneBefore : state.story.currentScene;
  const brief = Story.Narration.buildBrief(state, scene, pr.envelope);
  const narration = Story.ai.enabled ? await Story.Provider.narrate(state, brief) : null;

  if (!narration || !narration.title || !narration.chapter) {
    // 仍失败：retryCount++，停在 narration_failed
    pr.retryCount = (pr.retryCount || 0) + 1;
    const errCode = state.api.lastErrorCode || 'NO_API_CONFIG';
    pr.lastNarrationError = {
      code: errCode,
      message: state.api.lastErrorMessage || 'AI 文本生成失败。',
      rawPreview: '',
    };
    Story._setTurnPhase(state, 'narration_failed');
    return null;
  }
  const directorViolation = Story.Narration.validateAgainstDirector(narration, brief.director);
  if (directorViolation) {
    Story.Narration.failPendingForDirectorViolation(state, directorViolation, true);
    return null;
  }
  const coverageViolation = Story.Narration.validateCoverage(narration, brief);
  if (coverageViolation) {
    Story.Narration.failPendingForDirectorViolation(state, coverageViolation, true);
    return null;
  }

  // 成功：提交
  return Story._commitPendingResolution(state, narration, isOpening);
};

/**
 * V3.3 放弃当前裁决（边界 1A：resolving 异常时调用）。
 * 回 collecting，保留 actionsByActorId + botActions，不清空 submittedActorIds。
 * 玩家可"重试结算"（重新调 resolveTurn 重算 envelope）。
 * 注意：bug 是确定性的会无限失败，但这是 bug，应被诊断。
 */
Story.abortResolution = function (storyState) {
  const state = storyState || Story.state;
  if (!state) return;
  state.story.pendingResolution = null;
  state.story._pendingAgentArcDeltas = null;
  Story._setTurnPhase(state, 'collecting');
};

/* ============================================================
 * §6 回合流程：resolveTurn（主入口）/ playTurn（V3 兼容包装）
 * ============================================================ */

/**
 * 结算一回合（V3.3 Narration Transaction）。
 *   collecting → locked → resolving（纯计算 envelope + Bot 决策）→ awaiting_narration（调 AI）→ published（提交）
 *   AI 失败：停在 awaiting_narration，世界状态零变化，由 retryNarration 复用 pendingResolution 重试。
 *   resolving 异常：调 abortResolution 回 collecting，保留 actionsByActorId + botActions，玩家可重试结算。
 */
Story.resolveTurn = async function (storyState, actionsByActorId) {
  if (!storyState || !storyState.story.currentChapter) throw new Error('尚未开局');
  Story._activateState(storyState);
  actionsByActorId = actionsByActorId || {};
  const state = storyState;
  const s = state.story;
  const chapterIndexBefore = s.chapterIndex;
  const sceneBefore = Story._clone(s.currentScene);

  // locked → resolving
  Story._setTurnPhase(state, 'resolving');

  let envelope, botActions;
  try {
    // 1. 归一化所有已提交行动为 Intent
    const intents = [];
    Object.keys(actionsByActorId).forEach(function (actorId) {
      const action = actionsByActorId[actorId];
      const actor = state.actors.find(function (a) { return a.id === actorId; });
      if (!actor) return;
      intents.push(Story.Intent.normalize(state, actorId, action));
    });

    // 2. 收集 Bot 行动（未在 actionsByActorId 中的非玩家控制角色）—— 一次锁定，不重选
    botActions = {};
    state.actors.forEach(function (actor) {
      if (intents.some(function (i) { return i.actorId === actor.id; })) return;
      if (Story._isHumanActor(state, actor)) return;
      const choices = Story.getChoicesForActor(state, actor.id);
      if (!choices.length) return;
      const chosen = Story.Agent.chooseAction(state, actor.id, choices, s.currentScene, null);
      if (chosen) {
        s.aiChosenLastTurn[actor.id] = chosen.id;
        botActions[actor.id] = chosen.id;
        intents.push(Story.Intent.fromChoice(state, actor.id, chosen.id));
      }
    });

    // 3. 本地裁决（纯计算，不应用）
    envelope = Story.Resolver.resolveTurn(state, intents);

    // 4. 诊断（开发模式严格，生产模式安全回退）
    const diag = Story.Diagnostics.validateResolutionEnvelope(envelope, state);
    if (!diag.ok) {
      if (state.settings && state.settings.developerMode) throw new Error('ResolutionEnvelope 校验失败：' + diag.errors.join('；'));
      Story.Resolver._applySafeFallback(envelope, diag.errors);
    }
  } catch (e) {
    // resolving 异常：边界 1A —— 回 collecting，保留提交状态，玩家可重试结算
    Story.abortResolution(state);
    throw e;
  }

  // 5. V3.3.2 Director.evaluate：评估卷纲推进（纯计算，不应用）
  var directorPlan = null;
  try {
    directorPlan = Story.Director.evaluate(state, envelope);
  } catch (e) {
    // Director 失败不应阻塞回合，仅记录日志
    if (state.settings && state.settings.developerMode) console.error('Director.evaluate 失败：', e.message);
  }

  // 6. awaiting_narration：世界状态冻结，存 pendingResolution
  Story._setTurnPhase(state, 'awaiting_narration');
  const turnId = 'turn_' + String(chapterIndexBefore + 1).padStart(4, '0');
  state.story.pendingResolution = {
    turnId: turnId,
    envelope: envelope,
    actionsByActorId: Story._clone(actionsByActorId),
    botActions: botActions,
    sceneBefore: sceneBefore,
    chapterIndexBefore: chapterIndexBefore,
    createdAt: Date.now(),
    retryCount: 0,
    lastNarrationError: null,
    directorPlan: directorPlan,
  };

  // 6. 调 AI 叙事
  const brief = Story.Narration.buildBrief(state, s.currentScene, envelope);
  const narration = Story.ai.enabled ? await Story.Provider.narrate(state, brief) : null;

  if (!narration || !narration.title || !narration.chapter) {
    // AI 失败：停在 narration_failed，不应用任何状态
    const errCode = state.api.lastErrorCode || 'NO_API_CONFIG';
    state.story.pendingResolution.lastNarrationError = {
      code: errCode,
      message: state.api.lastErrorMessage || 'AI 文本生成失败。',
      rawPreview: '',
    };
    Story._setTurnPhase(state, 'narration_failed');
    return state;
  }
  const directorViolation = Story.Narration.validateAgainstDirector(narration, brief.director);
  if (directorViolation) {
    Story.Narration.failPendingForDirectorViolation(state, directorViolation, false);
    return state;
  }
  const coverageViolation = Story.Narration.validateCoverage(narration, brief);
  if (coverageViolation) {
    Story.Narration.failPendingForDirectorViolation(state, coverageViolation, false);
    return state;
  }

  // 7. AI 成功：published —— 提交裁决 + 场景 + 选项 + 叙事
  Story._commitPendingResolution(state, narration, false);
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

/** V3.3 设置回合阶段并同步快照 */
Story._setTurnPhase = function (state, phase) {
  if (Story.TURN_PHASES.indexOf(phase) < 0) throw new Error('非法回合阶段：' + phase);
  state.story.turnPhase = phase;
};

/** V3.3 查询当前回合阶段 */
Story.getTurnPhase = function (storyState) {
  const s = storyState || Story.state;
  return (s && s.story && s.story.turnPhase) || 'collecting';
};

/** V3.3.1 是否处于待重试叙事状态（AI 失败 / 等待 AI 响应） */
Story.isAwaitingNarration = function (storyState) {
  var phase = Story.getTurnPhase(storyState);
  return phase === 'awaiting_narration' || phase === 'narration_failed';
};

/** V3.3 获取待提交裁决包（诊断/UI 用，返回副本） */
Story.getPendingResolution = function (storyState) {
  const s = storyState || Story.state;
  const pr = s && s.story && s.story.pendingResolution;
  return pr ? Story._clone(pr) : null;
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

/** 重新润色：只重写文案，绝不重新结算（V3.3 §R2）。AI 失败返回 null，不调用离线兜底。 */
Story.regenerateChapter = async function () {
  const state = Story.state;
  if (!state || !state.story.currentChapter) return null;
  const s = state.story;
  const turnId = s.lastTurnRecordId;
  const record = (state.ledger.turnRecords || []).find(function (t) { return t.turnId === turnId; });
  const envelope = record ? record.resolutionEnvelope : null;
  const scene = s.currentScene;
  const brief = envelope ? Story.Narration.buildBrief(state, scene, envelope) : null;
  let narration = null;
  if (Story.ai.enabled && brief) narration = await Story.Provider.narrate(state, brief);
  if (!narration || !narration.title || !narration.chapter) {
    // AI 失败：保留原章节，不替换文案
    return null;
  }
  const chapter = Story.Narration.assembleFromAI(state, scene, envelope, narration);
  // 仅替换文案字段
  s.currentChapter.title = chapter.title;
  s.currentChapter.chapter = chapter.chapter;
  s.currentChapter.endingImage = chapter.endingImage || s.currentChapter.endingImage;
  s.currentChapter.provenance = chapter.provenance;
  s.currentChapter.renderVersion = (s.currentChapter.renderVersion || 0) + 1;
  Story.snapshotRng(state);
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

/* ---------- V3.3 Phase 3：SceneEntity 归一化（字符串/对象双兼容） ---------- */
Story.Scene.Entity = {
  /** 把任意条目数组归一为 SceneEntity 对象数组。字符串 → 推断 kind + 默认 affordances。 */
  normalize: function (arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function (e, i) {
      if (e && typeof e === 'object') {
        return {
          id: e.id || ('ent_' + i),
          name: e.name || e.id || ('事物' + i),
          kind: e.kind || 'prop',
          affordances: Array.isArray(e.affordances) ? e.affordances.slice() : [],
          state: e.state || null,
          threadId: e.threadId || '',
          sourceThreadId: e.sourceThreadId || '',
          sourceArcId: e.sourceArcId || '',
        };
      }
      const name = String(e);
      const kind = Story.Scene.Entity._guessKind(name);
      return { id: 'ent_' + i + '_' + name, name: name, kind: kind, affordances: Story.Scene.Entity._defaultAffordances(kind), state: null };
    });
  },
  _guessKind: function (name) {
    if (/(剑|符|印|鼎|镜|珠|令|残剑)/.test(name)) return 'relic';
    if (/(信|图|卷|册|契|密信)/.test(name)) return 'clue';
    if (/(掌柜|掌门|弟子|使者|老者|女子|男子|童子|掌柜)/.test(name)) return 'npc';
    if (/(门|路|径|院|道|口|来路|深处|小径|旧址)/.test(name)) return 'exit';
    return 'prop';
  },
  _defaultAffordances: function (kind) {
    const map = { relic: ['use_relic', 'investigate'], clue: ['investigate', 'observe'], npc: ['social', 'negotiate'], exit: ['travel', 'flee'], prop: ['observe'] };
    return map[kind] || ['observe'];
  },
  /** 该实体是否支持某类行动 */
  affordance: function (entity, category) {
    return !!(entity && Array.isArray(entity.affordances) && entity.affordances.indexOf(category) >= 0);
  },
  /** 取名字数组（便于旧逻辑 rng.pick / indexOf 兼容） */
  names: function (arr) {
    return Story.Scene.Entity.normalize(arr).map(function (e) { return e.name; });
  },
  /** 按类型筛选 */
  byKind: function (arr, kind) {
    return Story.Scene.Entity.normalize(arr).filter(function (e) { return e.kind === kind; });
  },
};

/* ---------- V3.3 Phase 3：AssetRegistry —— 资产登记表 ---------- */
Story.AssetRegistry = {
  register: function (state, asset) {
    if (!state || !asset || !asset.id) return null;
    if (!state.assets) state.assets = [];
    const existing = state.assets.find(function (a) { return a.id === asset.id; });
    if (existing) { Object.assign(existing, asset); return existing; }
    const a = {
      id: asset.id,
      name: asset.name || asset.id,
      kind: asset.kind || 'relic',          // relic | clue | item | resource
      ownerActorId: asset.ownerActorId || null,
      locationId: asset.locationId || null,
      state: asset.state || 'intact',        // intact | attuned | depleted | sealed
      uses: asset.uses || 0,
      publicHint: asset.publicHint || '',
      source: asset.source || '',
      sourceArcId: asset.sourceArcId || '',
      threadId: asset.threadId || '',
    };
    state.assets.push(a);
    return a;
  },
  get: function (state, id) {
    if (!state || !state.assets) return null;
    return state.assets.find(function (a) { return a.id === id; }) || null;
  },
  byOwner: function (state, actorId) {
    if (!state || !state.assets) return [];
    return state.assets.filter(function (a) { return a.ownerActorId === actorId; });
  },
  byLocation: function (state, locId) {
    if (!state || !state.assets) return [];
    return state.assets.filter(function (a) { return a.locationId === locId; });
  },
  all: function (state) { return (state && state.assets) || []; },
};

/* ============================================================
 * V3.3.2 Director：卷纲导演系统
 * 职责：候选剧情生成 → 投票 → 激活 → Beat 推进/偏转/拖延/打碎
 * 不直接修改状态，通过 DirectorPlan 写入 pendingResolution
 * ============================================================ */

/* ---------- ArcRecipe 配方库（4 条，每局随机抽 3 条） ---------- */
Story.DirectorRecipes = {
  relic_identity: {
    id: 'relic_identity',
    family: 'mystery',
    title: '残剑照旧城',
    publicPitch: '一柄残剑在雨夜认错了主人，而追逐它的人已在路上。',
    tags: ['遗物', '身份', '前世', '剑修'],
    weightRules: {
      heavenlyLaw: { '遗物共鸣': 4, '因果具现': 3 },
      storyGravity: { '剑修': 3, '遗物': 3 },
      daoPath: { '剑修': 3 },
    },
    openingSeed: {
      addEntities: [
        { id: 'ent_residual_sword', name: '残剑', kind: 'relic', affordances: ['use_relic', 'investigate', 'observe'] },
        { id: 'ent_sword_echo', name: '剑中残响', kind: 'clue', affordances: ['investigate', 'observe'] },
      ],
      addThreads: [
        { threadId: 'thread_old_sword', type: 'mystery', title: '残剑低语', stage: 1, maxStage: 4, status: 'active', urgency: 2, visibility: 'public' },
        { threadId: 'thread_sword_pursuer', type: 'threat', title: '追剑之人', stage: 1, maxStage: 3, status: 'dormant', urgency: 1, visibility: 'hidden' },
      ],
      addClock: {
        clockId: 'clock_sword_pursuer',
        label: '追剑者逼近',
        current: 0, max: 4,
        onFull: 'divert',
      },
    },
    beats: [
      {
        beatId: 'relic_01', title: '剑鸣之夜',
        dramaticGoal: '让残剑的异常真正进入玩家视野。',
        advanceSignals: { categories: ['investigate', 'use_relic'], targets: ['ent_residual_sword', 'thread_old_sword'] },
        bendSignals: { categories: ['social', 'observe'], targets: ['ent_innkeeper', 'inn_redsand'] },
        stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
        shatterKeywords: ['毁掉残剑', '丢弃残剑', '卖掉残剑', '交出残剑'],
        allowedReveals: ['残剑中有不属于此世的剑意', '残剑曾在某个雨夜认错主人'],
        forbiddenReveals: ['剑灵的真实身份', '残剑的完整来历', '追剑者的真实身份'],
        nextOnAdvance: 'relic_02', nextOnBend: 'relic_02', nextOnStall: 'relic_01', nextOnShatter: 'relic_01_shattered',
      },
      {
        beatId: 'relic_02', title: '追剑之人',
        dramaticGoal: '残剑的持有者不是唯一追逐它的人。',
        advanceSignals: { categories: ['investigate', 'social'], targets: ['thread_sword_pursuer', 'ent_sword_echo'] },
        bendSignals: { categories: ['negotiate', 'travel', 'flee'], targets: ['road_broken_flow'] },
        stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
        shatterKeywords: ['与追剑者结盟', '将残剑交给追剑者'],
        allowedReveals: ['追剑者并非敌人', '残剑不止一把'],
        forbiddenReveals: ['追剑者的真实身份', '残剑的最终形态'],
        nextOnAdvance: 'relic_03', nextOnBend: 'relic_03', nextOnStall: 'relic_02', nextOnShatter: 'relic_02_shattered',
      },
      {
        beatId: 'relic_03', title: '残剑择主',
        dramaticGoal: '残剑终于做出选择，或永远沉默。',
        advanceSignals: { categories: ['use_relic', 'cultivate'], targets: ['ent_residual_sword'] },
        bendSignals: { categories: ['social', 'negotiate'], targets: ['thread_sword_pursuer'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['拒绝残剑', '封印残剑', '永不再用'],
        allowedReveals: ['残剑选择了你', '剑灵的记忆碎片'],
        forbiddenReveals: ['剑灵的完整身世', '残剑的终极力量'],
        nextOnAdvance: null, nextOnBend: null, nextOnStall: null, nextOnShatter: null,
      },
    ],
  },

  trade_contract: {
    id: 'trade_contract',
    family: 'intrigue',
    title: '商路与血契',
    publicPitch: '一封密信牵出商会、宗门与一笔不能违背的契约。',
    tags: ['商会', '契约', '交易', '势力博弈'],
    weightRules: {
      heavenlyLaw: { '契约具现': 4 },
      storyGravity: { '经商': 4, '势力': 2 },
      daoPath: { '丹道': 1, '游侠': 2 },
    },
    openingSeed: {
      addEntities: [
        { id: 'ent_trade_letter', name: '半封商会密信', kind: 'clue', affordances: ['investigate', 'observe'] },
        { id: 'ent_caravan_ledger', name: '商会账册残页', kind: 'clue', affordances: ['investigate'] },
      ],
      addThreads: [
        { threadId: 'thread_trade_letter', type: 'mystery', title: '商会密信失踪', stage: 1, maxStage: 4, status: 'active', urgency: 2, visibility: 'public' },
        { threadId: 'thread_contract_secret', type: 'intrigue', title: '血契真相', stage: 1, maxStage: 3, status: 'dormant', urgency: 1, visibility: 'hidden' },
      ],
      addClock: {
        clockId: 'clock_caravan_departure',
        label: '商队离城',
        current: 0, max: 3,
        onFull: 'divert',
      },
    },
    beats: [
      {
        beatId: 'trade_01', title: '被截断的密信',
        dramaticGoal: '让商会的异常真正进入玩家视野。',
        advanceSignals: { categories: ['investigate'], targets: ['ent_trade_letter', 'thread_trade_letter'] },
        bendSignals: { categories: ['social', 'negotiate'], targets: ['ent_innkeeper', 'ent_trade_caravan'] },
        stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
        shatterKeywords: ['烧掉密信', '撕毁密信', '卖掉密信', '交给商会'],
        allowedReveals: ['密信不是普通账目', '商会有人试图掩盖某件事'],
        forbiddenReveals: ['幕后主使真实身份', '最终契约内容', '完整黑账'],
        nextOnAdvance: 'trade_02', nextOnBend: 'trade_02', nextOnStall: 'trade_01', nextOnShatter: 'trade_01_shattered',
      },
      {
        beatId: 'trade_02', title: '契约的代价',
        dramaticGoal: '发现契约不是交易，而是束缚。',
        advanceSignals: { categories: ['investigate', 'social'], targets: ['thread_contract_secret', 'ent_caravan_ledger'] },
        bendSignals: { categories: ['negotiate', 'deceive', 'travel'], targets: ['road_broken_flow'] },
        stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
        shatterKeywords: ['公开契约', '撕毁契约', '向宗门告发'],
        allowedReveals: ['契约并非自愿签署', '商会中有人被困'],
        forbiddenReveals: ['契约的最终受益人', '背后宗门的完整计划'],
        nextOnAdvance: 'trade_03', nextOnBend: 'trade_03', nextOnStall: 'trade_02', nextOnShatter: 'trade_02_shattered',
      },
      {
        beatId: 'trade_03', title: '商路抉择',
        dramaticGoal: '选择站队、撕毁、利用或背叛契约。',
        advanceSignals: { categories: ['social', 'negotiate'], targets: ['thread_contract_secret'] },
        bendSignals: { categories: ['travel', 'flee', 'battle'], targets: ['road_broken_flow'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['摧毁商会', '背叛契约', '永不再回'],
        allowedReveals: ['契约的最终代价', '有人因此获救'],
        forbiddenReveals: ['契约的终极秘密'],
        nextOnAdvance: null, nextOnBend: null, nextOnStall: null, nextOnShatter: null,
      },
    ],
  },

  sect_trial: {
    id: 'sect_trial',
    family: 'conflict',
    title: '宗门试炼',
    publicPitch: '边城宗门设下三道试炼，通过者可得一枚破境丹，但其中暗藏派系之争。',
    tags: ['宗门', '试炼', '派系', '破境'],
    weightRules: {
      heavenlyLaw: { '试炼之路': 3 },
      storyGravity: { '宗门': 3, '战斗': 2 },
      daoPath: { '剑修': 2, '丹道': 1 },
    },
    openingSeed: {
      addEntities: [
        { id: 'ent_trial_token', name: '试炼令牌', kind: 'prop', affordances: ['observe', 'investigate'] },
        { id: 'ent_sect_elder', name: '宗门执事', kind: 'npc', affordances: ['social', 'negotiate', 'observe'] },
      ],
      addThreads: [
        { threadId: 'thread_sect_trial', type: 'quest', title: '三重试炼', stage: 1, maxStage: 3, status: 'active', urgency: 2, visibility: 'public' },
        { threadId: 'thread_sect_faction', type: 'intrigue', title: '派系暗流', stage: 1, maxStage: 3, status: 'dormant', urgency: 1, visibility: 'hidden' },
      ],
      addClock: {
        clockId: 'clock_trial_deadline',
        label: '试炼截止',
        current: 0, max: 4,
        onFull: 'divert',
      },
    },
    beats: [
      {
        beatId: 'sect_01', title: '试炼之门',
        dramaticGoal: '了解试炼规则，选择参与方式。',
        advanceSignals: { categories: ['social', 'investigate'], targets: ['ent_sect_elder', 'thread_sect_trial'] },
        bendSignals: { categories: ['negotiate', 'observe'], targets: ['ent_trial_token'] },
        stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
        shatterKeywords: ['拒绝试炼', '离开宗门', '攻击执事'],
        allowedReveals: ['试炼有三道关卡', '派系之争已渗透试炼'],
        forbiddenReveals: ['破境丹的真实效果', '派系首领的身份'],
        nextOnAdvance: 'sect_02', nextOnBend: 'sect_02', nextOnStall: 'sect_01', nextOnShatter: 'sect_01_shattered',
      },
      {
        beatId: 'sect_02', title: '派系暗流',
        dramaticGoal: '在试炼中看清宗门内的权力博弈。',
        advanceSignals: { categories: ['battle', 'cultivate'], targets: ['thread_sect_trial'] },
        bendSignals: { categories: ['social', 'negotiate', 'deceive'], targets: ['thread_sect_faction'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['公开挑战宗门', '退出试炼', '投靠对立派系'],
        allowedReveals: ['派系之一在操控试炼', '破境丹被动了手脚'],
        forbiddenReveals: ['操控者的真实身份'],
        nextOnAdvance: 'sect_03', nextOnBend: 'sect_03', nextOnStall: 'sect_02', nextOnShatter: 'sect_02_shattered',
      },
      {
        beatId: 'sect_03', title: '破境丹的代价',
        dramaticGoal: '决定是否接受破境丹及其背后的代价。',
        advanceSignals: { categories: ['cultivate', 'social'], targets: ['thread_sect_trial'] },
        bendSignals: { categories: ['negotiate', 'deceive'], targets: ['thread_sect_faction'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['拒绝破境丹', '摧毁试炼', '摧毁宗门'],
        allowedReveals: ['破境丹的真实代价'],
        forbiddenReveals: [],
        nextOnAdvance: null, nextOnBend: null, nextOnStall: null, nextOnShatter: null,
      },
    ],
  },

  tower_expedition: {
    id: 'tower_expedition',
    family: 'exploration',
    title: '古塔遗踪',
    publicPitch: '荒漠深处有一座倒悬的古塔，每深入一层，时间便倒流一分。',
    tags: ['遗迹', '古塔', '探索', '时间'],
    weightRules: {
      heavenlyLaw: { '时空紊乱': 3 },
      storyGravity: { '探索': 3, '秘境': 2 },
      daoPath: { '阵法': 2, '游侠': 2 },
    },
    openingSeed: {
      addEntities: [
        { id: 'ent_tower_map', name: '古塔残图', kind: 'clue', affordances: ['investigate', 'observe'] },
        { id: 'ent_tower_guide', name: '向导老者', kind: 'npc', affordances: ['social', 'negotiate', 'observe'] },
      ],
      addThreads: [
        { threadId: 'thread_tower_expedition', type: 'quest', title: '古塔深处', stage: 1, maxStage: 3, status: 'active', urgency: 2, visibility: 'public' },
        { threadId: 'thread_tower_time', type: 'mystery', title: '倒流的时间', stage: 1, maxStage: 3, status: 'dormant', urgency: 1, visibility: 'hidden' },
      ],
      addClock: {
        clockId: 'clock_tower_collapse',
        label: '古塔崩塌',
        current: 0, max: 5,
        onFull: 'divert',
      },
    },
    beats: [
      {
        beatId: 'tower_01', title: '倒悬之塔',
        dramaticGoal: '找到古塔入口，决定是否深入。',
        advanceSignals: { categories: ['investigate', 'travel'], targets: ['ent_tower_map', 'thread_tower_expedition'] },
        bendSignals: { categories: ['social', 'negotiate'], targets: ['ent_tower_guide'] },
        stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
        shatterKeywords: ['放弃古塔', '摧毁入口', '封住塔门'],
        allowedReveals: ['古塔不止一层', '塔内时间流速异常'],
        forbiddenReveals: ['塔底的真相', '古塔的建造者'],
        nextOnAdvance: 'tower_02', nextOnBend: 'tower_02', nextOnStall: 'tower_01', nextOnShatter: 'tower_01_shattered',
      },
      {
        beatId: 'tower_02', title: '时间逆流',
        dramaticGoal: '在塔中面对时间逆流带来的危险与机遇。',
        advanceSignals: { categories: ['battle', 'cultivate', 'investigate'], targets: ['thread_tower_time'] },
        bendSignals: { categories: ['use_relic', 'social'], targets: ['thread_tower_expedition'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['逃离古塔', '摧毁塔层', '破坏时间法则'],
        allowedReveals: ['时间逆流可以修复旧伤', '塔中困着前人'],
        forbiddenReveals: ['古塔的真正用途'],
        nextOnAdvance: 'tower_03', nextOnBend: 'tower_03', nextOnStall: 'tower_02', nextOnShatter: 'tower_02_shattered',
      },
      {
        beatId: 'tower_03', title: '塔底之秘',
        dramaticGoal: '到达塔底，面对古塔的最终真相。',
        advanceSignals: { categories: ['investigate', 'use_relic'], targets: ['thread_tower_time'] },
        bendSignals: { categories: ['battle', 'negotiate'], targets: ['thread_tower_expedition'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['拒绝真相', '离开塔底', '摧毁塔底'],
        allowedReveals: ['古塔的建造目的', '时间逆流的源头'],
        forbiddenReveals: [],
        nextOnAdvance: null, nextOnBend: null, nextOnStall: null, nextOnShatter: null,
      },
    ],
  },
};

Object.assign(Story.DirectorRecipes, {
  demon_accord: {
    id: 'demon_accord',
    family: 'alliance',
    title: '妖域盟约',
    publicPitch: '边荒妖庭递来半枚骨盟，求援与陷阱只隔一层血誓。',
    tags: ['妖族', '盟约', '边荒', '血誓'],
    weightRules: {
      aberrant: { '妖族': 4, '妖': 2 },
      terrain: { '妖域': 3, '边荒': 2 },
      storyGravity: { '游历': 2, '战争': 2 },
    },
    openingSeed: {
      addEntities: [
        { id: 'ent_demon_bone_oath', name: '半枚骨盟', kind: 'clue', affordances: ['investigate', 'observe'] },
        { id: 'ent_border_envoy', name: '妖庭使者', kind: 'npc', affordances: ['social', 'negotiate', 'observe'] },
      ],
      addThreads: [
        { threadId: 'thread_demon_accord', type: 'intrigue', title: '妖域盟约', stage: 1, maxStage: 3, status: 'active', urgency: 2, visibility: 'public' },
        { threadId: 'thread_blood_oath_cost', type: 'mystery', title: '血誓代价', stage: 1, maxStage: 3, status: 'dormant', urgency: 1, visibility: 'hidden' },
      ],
      addClock: { clockId: 'clock_envoy_patience', label: '妖使耐心', current: 0, max: 3, onFull: 'divert' },
    },
    beats: [
      {
        beatId: 'demon_01', title: '骨盟入城',
        dramaticGoal: '确认妖庭使者来意，分辨求援与试探。',
        advanceSignals: { categories: ['social', 'investigate'], targets: ['ent_border_envoy', 'ent_demon_bone_oath'] },
        bendSignals: { categories: ['negotiate', 'observe'], targets: ['thread_demon_accord'] },
        stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
        shatterKeywords: ['杀死妖使', '撕毁骨盟', '交给宗门'],
        allowedReveals: ['骨盟来自边荒妖庭', '妖使身上有旧伤'],
        forbiddenReveals: ['骨盟真正受益者', '妖庭内乱真相'],
        nextOnAdvance: 'demon_02', nextOnBend: 'demon_02', nextOnStall: 'demon_01', nextOnShatter: 'demon_01_shattered',
      },
      {
        beatId: 'demon_02', title: '血誓裂痕',
        dramaticGoal: '发现盟约的代价，并判断是否仍可合作。',
        advanceSignals: { categories: ['investigate', 'negotiate'], targets: ['thread_blood_oath_cost', 'ent_demon_bone_oath'] },
        bendSignals: { categories: ['social', 'deceive'], targets: ['ent_border_envoy'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['公开血誓', '背叛妖使', '献祭骨盟'],
        allowedReveals: ['血誓会牵动双方气运', '盟约并非妖使一人能决定'],
        forbiddenReveals: ['妖庭内乱主谋', '血誓完整仪式'],
        nextOnAdvance: 'demon_03', nextOnBend: 'demon_03', nextOnStall: 'demon_02', nextOnShatter: 'demon_02_shattered',
      },
      {
        beatId: 'demon_03', title: '盟或猎',
        dramaticGoal: '决定与妖庭结盟、反制或借势脱身。',
        advanceSignals: { categories: ['negotiate', 'travel'], targets: ['thread_demon_accord'] },
        bendSignals: { categories: ['battle', 'deceive'], targets: ['ent_border_envoy'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['永绝妖域', '毁掉血誓', '屠灭使团'],
        allowedReveals: ['盟约会改变边荒格局'],
        forbiddenReveals: [],
        nextOnAdvance: null, nextOnBend: null, nextOnStall: null, nextOnShatter: null,
      },
    ],
  },
  old_debt_revenge: {
    id: 'old_debt_revenge',
    family: 'revenge',
    title: '旧债复仇',
    publicPitch: '一张旧欠契从灰烬中现身，债主却早已死过一次。',
    tags: ['旧债', '复仇', '欠契', '灰烬'],
    weightRules: {
      storyGravity: { '复仇': 4, '因果': 2 },
      heavenlyLaw: { '因果': 3, '契约': 2 },
      daoPath: { '剑修': 1, '游侠': 2 },
    },
    openingSeed: {
      addEntities: [
        { id: 'ent_ash_debt_note', name: '灰烬欠契', kind: 'clue', affordances: ['investigate', 'observe'] },
        { id: 'ent_one_eyed_creditor', name: '独眼债使', kind: 'npc', affordances: ['social', 'negotiate', 'observe'] },
      ],
      addThreads: [
        { threadId: 'thread_old_debt', type: 'mystery', title: '旧债未清', stage: 1, maxStage: 3, status: 'active', urgency: 2, visibility: 'public' },
        { threadId: 'thread_dead_creditor', type: 'threat', title: '死过一次的债主', stage: 1, maxStage: 3, status: 'dormant', urgency: 1, visibility: 'hidden' },
      ],
      addClock: { clockId: 'clock_debt_collector', label: '债使逼近', current: 0, max: 4, onFull: 'divert' },
    },
    beats: [
      {
        beatId: 'debt_01', title: '灰契重现',
        dramaticGoal: '弄清旧欠契为何落到众人手里。',
        advanceSignals: { categories: ['investigate', 'social'], targets: ['ent_ash_debt_note', 'ent_one_eyed_creditor'] },
        bendSignals: { categories: ['negotiate', 'observe'], targets: ['thread_old_debt'] },
        stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
        shatterKeywords: ['烧掉欠契', '杀债使', '拒绝旧债'],
        allowedReveals: ['欠契上有旧时代印记', '债使并非真正债主'],
        forbiddenReveals: ['债主复生原因', '欠契完整名单'],
        nextOnAdvance: 'debt_02', nextOnBend: 'debt_02', nextOnStall: 'debt_01', nextOnShatter: 'debt_01_shattered',
      },
      {
        beatId: 'debt_02', title: '债主已死',
        dramaticGoal: '发现债主死亡与复仇链条有关。',
        advanceSignals: { categories: ['investigate', 'travel'], targets: ['thread_dead_creditor', 'ent_ash_debt_note'] },
        bendSignals: { categories: ['social', 'deceive'], targets: ['ent_one_eyed_creditor'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['公布债主死讯', '投靠债使', '撕毁契书'],
        allowedReveals: ['债主曾被同门背弃', '欠契会寻找见证人'],
        forbiddenReveals: ['幕后复仇者身份', '旧债最终对象'],
        nextOnAdvance: 'debt_03', nextOnBend: 'debt_03', nextOnStall: 'debt_02', nextOnShatter: 'debt_02_shattered',
      },
      {
        beatId: 'debt_03', title: '还债或断债',
        dramaticGoal: '选择清偿、转移、公开或斩断旧债因果。',
        advanceSignals: { categories: ['negotiate', 'battle'], targets: ['thread_old_debt'] },
        bendSignals: { categories: ['deceive', 'use_relic'], targets: ['ent_ash_debt_note'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['永不还债', '毁掉债主遗物'],
        allowedReveals: ['旧债会牵连新的同盟'],
        forbiddenReveals: [],
        nextOnAdvance: null, nextOnBend: null, nextOnStall: null, nextOnShatter: null,
      },
    ],
  },
  dynasty_pursuit: {
    id: 'dynasty_pursuit',
    family: 'law',
    title: '皇朝追捕',
    publicPitch: '皇朝缉仙司封城搜捕，榜文上的画像却像极了同行者。',
    tags: ['皇朝', '追捕', '缉仙司', '封城'],
    weightRules: {
      order: { '皇朝': 4, '律法': 2 },
      storyGravity: { '战争': 2, '游历': 2 },
      daoPath: { '游侠': 2 },
    },
    openingSeed: {
      addEntities: [
        { id: 'ent_wanted_edict', name: '缉仙榜文', kind: 'clue', affordances: ['investigate', 'observe'] },
        { id: 'ent_imperial_arrester', name: '缉仙司校尉', kind: 'npc', affordances: ['social', 'negotiate', 'observe'] },
      ],
      addThreads: [
        { threadId: 'thread_dynasty_warrant', type: 'threat', title: '皇朝缉捕', stage: 1, maxStage: 3, status: 'active', urgency: 3, visibility: 'public' },
        { threadId: 'thread_false_portrait', type: 'mystery', title: '错像画像', stage: 1, maxStage: 3, status: 'dormant', urgency: 1, visibility: 'hidden' },
      ],
      addClock: { clockId: 'clock_city_lockdown', label: '封城时限', current: 0, max: 3, onFull: 'divert' },
    },
    beats: [
      {
        beatId: 'dynasty_01', title: '榜文封城',
        dramaticGoal: '确定缉仙榜文为何与同行者相似。',
        advanceSignals: { categories: ['investigate', 'social'], targets: ['ent_wanted_edict', 'ent_imperial_arrester'] },
        bendSignals: { categories: ['negotiate', 'deceive'], targets: ['thread_dynasty_warrant'] },
        stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
        shatterKeywords: ['撕毁榜文', '袭击校尉', '强闯城门'],
        allowedReveals: ['榜文来自缉仙司', '画像并不完全准确'],
        forbiddenReveals: ['真正被追捕者', '皇朝密令来源'],
        nextOnAdvance: 'dynasty_02', nextOnBend: 'dynasty_02', nextOnStall: 'dynasty_01', nextOnShatter: 'dynasty_01_shattered',
      },
      {
        beatId: 'dynasty_02', title: '错像疑云',
        dramaticGoal: '追查画像错位背后的身份替换。',
        advanceSignals: { categories: ['investigate', 'deceive'], targets: ['thread_false_portrait', 'ent_wanted_edict'] },
        bendSignals: { categories: ['social', 'negotiate'], targets: ['ent_imperial_arrester'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['自首', '嫁祸同伴', '烧毁画像'],
        allowedReveals: ['有人故意改过画像', '缉仙司内部也有分歧'],
        forbiddenReveals: ['画像替换者身份', '皇朝最终目标'],
        nextOnAdvance: 'dynasty_03', nextOnBend: 'dynasty_03', nextOnStall: 'dynasty_02', nextOnShatter: 'dynasty_02_shattered',
      },
      {
        beatId: 'dynasty_03', title: '破围出城',
        dramaticGoal: '决定洗清嫌疑、借榜脱身或正面对抗。',
        advanceSignals: { categories: ['travel', 'negotiate'], targets: ['thread_dynasty_warrant'] },
        bendSignals: { categories: ['battle', 'flee'], targets: ['ent_imperial_arrester'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['投敌', '屠城', '永不解释'],
        allowedReveals: ['封城只是更大追捕的一环'],
        forbiddenReveals: [],
        nextOnAdvance: null, nextOnBend: null, nextOnStall: null, nextOnShatter: null,
      },
    ],
  },
  sealed_realm: {
    id: 'sealed_realm',
    family: 'seal',
    title: '秘境封印',
    publicPitch: '旧秘境的封印忽明忽暗，像在等一个错误的人开启。',
    tags: ['秘境', '封印', '钥印', '遗迹'],
    weightRules: {
      storyGravity: { '夺宝': 3, '秘境': 4, '游历': 2 },
      heavenlyLaw: { '法宝': 2, '轮回': 2 },
      daoPath: { '阵法': 3 },
    },
    openingSeed: {
      addEntities: [
        { id: 'ent_seal_keymark', name: '残缺钥印', kind: 'prop', affordances: ['observe', 'investigate'] },
        { id: 'ent_realm_crack', name: '秘境裂隙', kind: 'clue', affordances: ['investigate', 'observe'] },
      ],
      addThreads: [
        { threadId: 'thread_sealed_realm', type: 'quest', title: '秘境封印', stage: 1, maxStage: 3, status: 'active', urgency: 2, visibility: 'public' },
        { threadId: 'thread_wrong_opener', type: 'mystery', title: '错误开门者', stage: 1, maxStage: 3, status: 'dormant', urgency: 1, visibility: 'hidden' },
      ],
      addClock: { clockId: 'clock_seal_decay', label: '封印衰减', current: 0, max: 4, onFull: 'divert' },
    },
    beats: [
      {
        beatId: 'seal_01', title: '裂隙初明',
        dramaticGoal: '确认秘境裂隙与钥印的关系。',
        advanceSignals: { categories: ['investigate', 'observe'], targets: ['ent_realm_crack', 'ent_seal_keymark'] },
        bendSignals: { categories: ['cultivate', 'use_relic'], targets: ['thread_sealed_realm'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['强开秘境', '砸碎钥印', '封死裂隙'],
        allowedReveals: ['封印正在衰减', '钥印只剩一半'],
        forbiddenReveals: ['秘境核心宝物', '错误开门者身份'],
        nextOnAdvance: 'seal_02', nextOnBend: 'seal_02', nextOnStall: 'seal_01', nextOnShatter: 'seal_01_shattered',
      },
      {
        beatId: 'seal_02', title: '门后回声',
        dramaticGoal: '分辨秘境主动召唤的是人、血脉还是法器。',
        advanceSignals: { categories: ['investigate', 'use_relic'], targets: ['thread_wrong_opener', 'ent_seal_keymark'] },
        bendSignals: { categories: ['negotiate', 'social'], targets: ['thread_sealed_realm'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['献祭钥印', '独吞秘境', '转卖消息'],
        allowedReveals: ['门后有回应', '封印会辨认气息'],
        forbiddenReveals: ['门后存在的完整身份', '封印真正用途'],
        nextOnAdvance: 'seal_03', nextOnBend: 'seal_03', nextOnStall: 'seal_02', nextOnShatter: 'seal_02_shattered',
      },
      {
        beatId: 'seal_03', title: '开门之误',
        dramaticGoal: '选择开启、延后、转移或重封秘境。',
        advanceSignals: { categories: ['cultivate', 'travel'], targets: ['thread_sealed_realm'] },
        bendSignals: { categories: ['deceive', 'negotiate'], targets: ['ent_realm_crack'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['毁掉秘境入口', '永封秘境'],
        allowedReveals: ['开门会改变一条旧因果'],
        forbiddenReveals: [],
        nextOnAdvance: null, nextOnBend: null, nextOnStall: null, nextOnShatter: null,
      },
    ],
  },
  spirit_vein_race: {
    id: 'spirit_vein_race',
    family: 'resource',
    title: '灵脉争夺',
    publicPitch: '城下灵脉忽然改道，几方势力都说自己才是天命所归。',
    tags: ['灵脉', '资源', '争夺', '城池'],
    weightRules: {
      storyGravity: { '经商': 2, '战争': 3, '宗门': 2 },
      era: { '盛世': 2, '衰世': 2 },
      daoPath: { '丹道': 1, '阵法': 2 },
    },
    openingSeed: {
      addEntities: [
        { id: 'ent_vein_survey_map', name: '灵脉测绘图', kind: 'clue', affordances: ['investigate', 'observe'] },
        { id: 'ent_mine_broker', name: '矿脉掮客', kind: 'npc', affordances: ['social', 'negotiate', 'observe'] },
      ],
      addThreads: [
        { threadId: 'thread_spirit_vein', type: 'intrigue', title: '灵脉改道', stage: 1, maxStage: 3, status: 'active', urgency: 2, visibility: 'public' },
        { threadId: 'thread_hidden_claimant', type: 'threat', title: '暗中索脉者', stage: 1, maxStage: 3, status: 'dormant', urgency: 1, visibility: 'hidden' },
      ],
      addClock: { clockId: 'clock_mine_auction', label: '灵脉竞价', current: 0, max: 3, onFull: 'divert' },
    },
    beats: [
      {
        beatId: 'vein_01', title: '测绘图失真',
        dramaticGoal: '查出灵脉测绘图为何与现状不符。',
        advanceSignals: { categories: ['investigate', 'social'], targets: ['ent_vein_survey_map', 'ent_mine_broker'] },
        bendSignals: { categories: ['negotiate', 'observe'], targets: ['thread_spirit_vein'] },
        stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
        shatterKeywords: ['偷卖测绘图', '毁掉灵脉', '杀掮客'],
        allowedReveals: ['灵脉确实改道', '有人提前知道变化'],
        forbiddenReveals: ['暗中索脉者身份', '灵脉最终归属'],
        nextOnAdvance: 'vein_02', nextOnBend: 'vein_02', nextOnStall: 'vein_01', nextOnShatter: 'vein_01_shattered',
      },
      {
        beatId: 'vein_02', title: '众口夺脉',
        dramaticGoal: '在多方争夺中找到可验证的真实权属。',
        advanceSignals: { categories: ['negotiate', 'investigate'], targets: ['thread_hidden_claimant', 'ent_vein_survey_map'] },
        bendSignals: { categories: ['social', 'deceive'], targets: ['ent_mine_broker'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['宣布独占灵脉', '卖给最高价', '引爆矿脉'],
        allowedReveals: ['灵脉关系一座旧阵', '几方证据都不完整'],
        forbiddenReveals: ['旧阵主人身份', '灵脉深处秘密'],
        nextOnAdvance: 'vein_03', nextOnBend: 'vein_03', nextOnStall: 'vein_02', nextOnShatter: 'vein_02_shattered',
      },
      {
        beatId: 'vein_03', title: '定脉成局',
        dramaticGoal: '决定护脉、分脉、夺脉或弃脉。',
        advanceSignals: { categories: ['cultivate', 'negotiate'], targets: ['thread_spirit_vein'] },
        bendSignals: { categories: ['battle', 'travel'], targets: ['thread_hidden_claimant'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['毁掉整条灵脉', '永不插手'],
        allowedReveals: ['灵脉会牵动地区格局'],
        forbiddenReveals: [],
        nextOnAdvance: null, nextOnBend: null, nextOnStall: null, nextOnShatter: null,
      },
    ],
  },
  ghost_case: {
    id: 'ghost_case',
    family: 'haunting',
    title: '鬼修旧案',
    publicPitch: '城隍旧卷忽然翻页，一个被判魂飞魄散的鬼修留下新证。',
    tags: ['鬼修', '旧案', '城隍', '冤魂'],
    weightRules: {
      aberrant: { '鬼修': 4, '幽': 2 },
      storyGravity: { '复仇': 2, '游历': 2 },
      heavenlyLaw: { '轮回': 3 },
    },
    openingSeed: {
      addEntities: [
        { id: 'ent_ghost_case_scroll', name: '城隍旧卷', kind: 'clue', affordances: ['investigate', 'observe'] },
        { id: 'ent_white_lantern', name: '无风白灯', kind: 'prop', affordances: ['observe', 'investigate'] },
      ],
      addThreads: [
        { threadId: 'thread_ghost_case', type: 'mystery', title: '鬼修旧案', stage: 1, maxStage: 3, status: 'active', urgency: 2, visibility: 'public' },
        { threadId: 'thread_wrong_judgement', type: 'intrigue', title: '错判之夜', stage: 1, maxStage: 3, status: 'dormant', urgency: 1, visibility: 'hidden' },
      ],
      addClock: { clockId: 'clock_lantern_extinguish', label: '白灯将灭', current: 0, max: 4, onFull: 'divert' },
    },
    beats: [
      {
        beatId: 'ghost_01', title: '旧卷翻页',
        dramaticGoal: '确认旧卷为何自行翻到鬼修旧案。',
        advanceSignals: { categories: ['investigate', 'observe'], targets: ['ent_ghost_case_scroll', 'ent_white_lantern'] },
        bendSignals: { categories: ['social', 'cultivate'], targets: ['thread_ghost_case'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['烧掉旧卷', '熄灭白灯', '驱散冤魂'],
        allowedReveals: ['旧案判词有涂改', '白灯只照见魂痕'],
        forbiddenReveals: ['真正凶手身份', '鬼修为何未灭'],
        nextOnAdvance: 'ghost_02', nextOnBend: 'ghost_02', nextOnStall: 'ghost_01', nextOnShatter: 'ghost_01_shattered',
      },
      {
        beatId: 'ghost_02', title: '错判之夜',
        dramaticGoal: '还原判案当夜被隐藏的一段证词。',
        advanceSignals: { categories: ['investigate', 'use_relic'], targets: ['thread_wrong_judgement', 'ent_ghost_case_scroll'] },
        bendSignals: { categories: ['negotiate', 'social'], targets: ['ent_white_lantern'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['公开召鬼', '伪造证词', '卖给鬼修'],
        allowedReveals: ['当夜有人替换证词', '鬼修可能是替罪者'],
        forbiddenReveals: ['替换证词的人', '城隍旧卷真正来源'],
        nextOnAdvance: 'ghost_03', nextOnBend: 'ghost_03', nextOnStall: 'ghost_02', nextOnShatter: 'ghost_02_shattered',
      },
      {
        beatId: 'ghost_03', title: '翻案或镇魂',
        dramaticGoal: '决定翻案、镇魂、借鬼修之力或彻底放下。',
        advanceSignals: { categories: ['social', 'negotiate'], targets: ['thread_ghost_case'] },
        bendSignals: { categories: ['battle', 'deceive'], targets: ['thread_wrong_judgement'] },
        stallSignals: { categories: ['rest', 'wait'] },
        shatterKeywords: ['永镇鬼修', '毁掉全部证据'],
        allowedReveals: ['翻案会牵动城隍体系'],
        forbiddenReveals: [],
        nextOnAdvance: null, nextOnBend: null, nextOnStall: null, nextOnShatter: null,
      },
    ],
  },
});

Story.DirectorOpeningScenePatches = {
  relic_identity: {
    locationId: 'inn_redsand', locationName: '赤砂边城·听雨客栈',
    immediateConflict: '一柄残剑在雨夜认错主人，剑中残响像在呼唤旧名。',
    immediateQuestion: '是否追查残剑为何认主？',
    deadline: { type: '追剑者逼近', remaining: 4, unit: '刻' },
    replaceDefaultEntities: true, replaceDefaultThreads: true,
    baseEntities: [
      { id: 'ent_innkeeper', name: '女掌柜', kind: 'npc', affordances: ['social', 'negotiate', 'observe'] },
    ],
    baseExits: [
      { id: 'exit_gate', name: '城门', kind: 'exit', affordances: ['travel', 'flee'] },
      { id: 'exit_backyard', name: '客栈后院', kind: 'exit', affordances: ['travel', 'observe'] },
    ],
  },
  trade_contract: {
    locationId: 'inn_redsand', locationName: '赤砂边城·听雨客栈',
    immediateConflict: '商会使者将连夜离城，半封密信与残账指向一纸血契。',
    immediateQuestion: '是否追查被截断的密信？',
    deadline: { type: '商队离城', remaining: 3, unit: '刻' },
    replaceDefaultEntities: true, replaceDefaultThreads: true,
    baseEntities: [
      { id: 'ent_innkeeper', name: '女掌柜', kind: 'npc', affordances: ['social', 'negotiate', 'observe'] },
      { id: 'ent_trade_caravan', name: '待发商队车队', kind: 'npc', affordances: ['social', 'negotiate', 'travel', 'observe'] },
    ],
    baseExits: [
      { id: 'exit_gate', name: '城门', kind: 'exit', affordances: ['travel', 'flee'] },
      { id: 'exit_guild', name: '商会旧址', kind: 'exit', affordances: ['travel', 'investigate'] },
    ],
  },
  sect_trial: {
    locationId: 'sect_trial_gate', locationName: '青霄别院·试炼门',
    immediateConflict: '宗门执事封住山门，试炼令牌只在今夜发放。',
    immediateQuestion: '是否接下三重试炼？',
    deadline: { type: '试炼截止', remaining: 4, unit: '刻' },
    replaceDefaultEntities: true, replaceDefaultThreads: true,
    baseEntities: [],
    baseExits: [
      { id: 'exit_trial_path', name: '试炼山道', kind: 'exit', affordances: ['travel', 'investigate'] },
      { id: 'exit_outer_court', name: '外院广场', kind: 'exit', affordances: ['travel', 'observe'] },
    ],
  },
  tower_expedition: {
    locationId: 'tower_shadow_station', locationName: '塔影驿站',
    immediateConflict: '倒悬古塔的影子落在驿站屋脊，塔钥地图只剩半幅。',
    immediateQuestion: '是否趁塔门未合前寻找入口？',
    deadline: { type: '古塔入口闭合', remaining: 5, unit: '刻' },
    replaceDefaultEntities: true, replaceDefaultThreads: true,
    baseEntities: [],
    baseExits: [
      { id: 'exit_tower_ruins', name: '古塔废墟', kind: 'exit', affordances: ['travel', 'investigate'] },
      { id: 'exit_dune_road', name: '沙丘旧路', kind: 'exit', affordances: ['travel', 'flee'] },
    ],
  },
  demon_accord: {
    locationId: 'border_oath_camp', locationName: '边荒盟帐',
    immediateConflict: '妖庭使者带着半枚骨盟入帐，血誓纹路尚未冷却。',
    immediateQuestion: '是否与妖庭使者谈判？',
    deadline: { type: '妖使耐心', remaining: 3, unit: '刻' },
    replaceDefaultEntities: true, replaceDefaultThreads: true,
    baseEntities: [],
    baseExits: [
      { id: 'exit_border_wilds', name: '边荒妖径', kind: 'exit', affordances: ['travel', 'flee'] },
      { id: 'exit_human_pass', name: '人族关隘', kind: 'exit', affordances: ['travel', 'negotiate'] },
    ],
  },
  old_debt_revenge: {
    locationId: 'ash_debt_hall', locationName: '灰契旧堂',
    immediateConflict: '灰烬欠契自行显字，独眼债使说债主已死却债未清。',
    immediateQuestion: '是否查清旧债源头？',
    deadline: { type: '债使逼近', remaining: 4, unit: '刻' },
    replaceDefaultEntities: true, replaceDefaultThreads: true,
    baseEntities: [],
    baseExits: [
      { id: 'exit_debt_alley', name: '债巷', kind: 'exit', affordances: ['travel', 'investigate'] },
      { id: 'exit_burnt_archive', name: '焚毁档库', kind: 'exit', affordances: ['travel', 'observe'] },
    ],
  },
  dynasty_pursuit: {
    locationId: 'sealed_city_gate', locationName: '赤砂城门·封榜处',
    immediateConflict: '缉仙司校尉张贴榜文，城门铁索正一寸寸落下。',
    immediateQuestion: '是否在封城前洗清嫌疑或脱身？',
    deadline: { type: '封城时限', remaining: 3, unit: '刻' },
    replaceDefaultEntities: true, replaceDefaultThreads: true,
    baseEntities: [],
    baseExits: [
      { id: 'exit_locked_gate', name: '将闭城门', kind: 'exit', affordances: ['travel', 'flee'] },
      { id: 'exit_yamen_lane', name: '缉仙司巷口', kind: 'exit', affordances: ['travel', 'observe'] },
    ],
  },
  sealed_realm: {
    locationId: 'realm_crack_shrine', locationName: '旧祠秘境裂隙',
    immediateConflict: '残缺钥印在旧祠中发烫，秘境裂隙像一扇正在变薄的门。',
    immediateQuestion: '是否探查秘境封印为何松动？',
    deadline: { type: '封印衰减', remaining: 4, unit: '刻' },
    replaceDefaultEntities: true, replaceDefaultThreads: true,
    baseEntities: [],
    baseExits: [
      { id: 'exit_realm_threshold', name: '秘境门槛', kind: 'exit', affordances: ['travel', 'investigate'] },
      { id: 'exit_old_shrine', name: '旧祠外林', kind: 'exit', affordances: ['travel', 'flee'] },
    ],
  },
  spirit_vein_race: {
    locationId: 'vein_survey_yard', locationName: '灵脉测绘场',
    immediateConflict: '灵脉测绘图与地脉流向相反，矿脉掮客正等各方出价。',
    immediateQuestion: '是否查出灵脉为何改道？',
    deadline: { type: '灵脉竞价', remaining: 3, unit: '刻' },
    replaceDefaultEntities: true, replaceDefaultThreads: true,
    baseEntities: [],
    baseExits: [
      { id: 'exit_vein_mouth', name: '灵脉入口', kind: 'exit', affordances: ['travel', 'investigate'] },
      { id: 'exit_market_yard', name: '竞价场', kind: 'exit', affordances: ['travel', 'negotiate'] },
    ],
  },
  ghost_case: {
    locationId: 'city_god_archive', locationName: '城隍旧卷阁',
    immediateConflict: '城隍旧卷无风自翻，无风白灯照出一行未干的魂字。',
    immediateQuestion: '是否重查鬼修旧案？',
    deadline: { type: '白灯将灭', remaining: 4, unit: '刻' },
    replaceDefaultEntities: true, replaceDefaultThreads: true,
    baseEntities: [],
    baseExits: [
      { id: 'exit_archive_depth', name: '旧卷深处', kind: 'exit', affordances: ['travel', 'investigate'] },
      { id: 'exit_temple_court', name: '城隍院落', kind: 'exit', affordances: ['travel', 'observe'] },
    ],
  },
};

Object.keys(Story.DirectorOpeningScenePatches).forEach(function (id) {
  if (Story.DirectorRecipes[id]) {
    var recipe = Story.DirectorRecipes[id];
    var patch = Story.DirectorOpeningScenePatches[id];
    var primaryThread = (recipe.openingSeed && recipe.openingSeed.addThreads || []).find(function (t) {
      return t && t.status !== 'dormant';
    }) || (recipe.openingSeed && recipe.openingSeed.addThreads || [])[0];
    var primaryThreadId = primaryThread && primaryThread.threadId;
    (recipe.openingSeed && recipe.openingSeed.addEntities || []).forEach(function (ent) {
      if (!ent.threadId && primaryThreadId) ent.threadId = primaryThreadId;
    });
    patch.replaceDefaultAssets = true;
    patch.baseAssets = (recipe.openingSeed && recipe.openingSeed.addEntities || [])
      .filter(function (ent) { return ent && ['clue', 'relic', 'prop'].indexOf(ent.kind) >= 0; })
      .map(function (ent) {
        var assetId = ent.id.replace(/^ent_/, '');
        if (id === 'sealed_realm' && ent.id === 'ent_seal_keymark') assetId = 'realm_key_shard';
        return {
          id: assetId,
          name: ent.name,
          kind: ent.kind === 'prop' ? 'item' : ent.kind,
          state: id === 'sealed_realm' ? 'warm' : 'intact',
          publicHint: ent.name + '与当前卷纲的异动相互呼应。',
          threadId: ent.threadId || primaryThreadId || '',
        };
      });
    recipe.openingScenePatch = patch;
  }
});

/* ---------- Director 核心模块 ---------- */
Story.Director = {};

/** 房间级动态 Recipe 优先于静态 Recipe。所有运行时读取统一走此入口。 */
Story.Director.getRecipe = function (state, recipeId) {
  var d = state && state.story && state.story.director;
  if (d && d.generatedRecipes && d.generatedRecipes[recipeId]) {
    return d.generatedRecipes[recipeId];
  }
  return Story.DirectorRecipes[recipeId] || null;
};

Story.Director.listRecipes = function (state) {
  var all = {};
  Object.keys(Story.DirectorRecipes).forEach(function (id) { all[id] = Story.DirectorRecipes[id]; });
  var generated = state && state.story && state.story.director && state.story.director.generatedRecipes || {};
  Object.keys(generated).forEach(function (id) { all[id] = generated[id]; });
  return Object.keys(all).map(function (id) { return all[id]; }).filter(Boolean);
};

/** 推断当前卷纲的主线程，不再假设商会线存在。 */
Story.Director.getPrimaryThreadId = function (state) {
  if (!state || !state.story) return null;
  var threads = state.story.activeThreads || [];
  var d = state.story.director || {};
  var arc = d.activeArc;
  var beat = arc && (arc.beats || [])[arc.currentBeatIndex];
  var targets = beat && beat.advanceSignals && beat.advanceSignals.targets || [];
  for (var i = 0; i < targets.length; i++) {
    var direct = threads.find(function (t) { return t && t.threadId === targets[i] && t.status !== 'completed'; });
    if (direct) return direct.threadId;
    var viaTarget = Story.Scene && Story.Scene.threadForTarget
      ? Story.Scene.threadForTarget(state, state.story.currentScene, targets[i]) : null;
    if (viaTarget) return viaTarget;
  }
  var recipe = arc && Story.Director.getRecipe(state, arc.recipeId);
  var seeded = recipe && recipe.openingSeed && recipe.openingSeed.addThreads || [];
  var seededActive = seeded.find(function (t) { return t && t.threadId && t.status !== 'dormant'; }) || seeded[0];
  if (seededActive && threads.some(function (t) { return t.threadId === seededActive.threadId; })) return seededActive.threadId;
  var sceneIds = state.story.currentScene && state.story.currentScene.activeThreadIds || [];
  var sceneThread = sceneIds.find(function (id) {
    return threads.some(function (t) { return t.threadId === id && t.status !== 'completed'; });
  });
  return sceneThread || null;
};

Story.Director._actionCategory = function (action) {
  return (action && (action.intentCategory || action.category)) || 'freeform';
};

Story.Director._actionTarget = function (action) {
  return (action && (action.targetId || (action.target && action.target.id))) || null;
};

Story.Director._actionRawText = function (action) {
  if (!action) return '';
  return action.rawText || (action.custom && action.custom.text) || action.publicAction || '';
};

/**
 * 计算单个 Recipe 在当前世界与角色配置下的权重。
 * 权重来源：天道、故事引力、角色道途、角色愿望关键词。
 * 返回 0~100 的整数，同分时用 RNG 打破平局。
 */
Story.Director.scoreRecipe = function (state, recipe) {
  var score = 5; // 基础分
  var rules = recipe.weightRules || {};
  var bible = state.world.worldBible || {};
  // 天道匹配
  var hl = bible.heavenlyLaw || '';
  var hlRules = rules.heavenlyLaw || {};
  Object.keys(hlRules).forEach(function (k) {
    if (hl.indexOf(k) >= 0) score += hlRules[k];
  });
  // 故事引力匹配
  var sg = (bible.storyGravity || bible.storyFocus || '');
  var sgRules = rules.storyGravity || {};
  Object.keys(sgRules).forEach(function (k) {
    if (sg.indexOf(k) >= 0) score += sgRules[k];
  });
  // 角色道途匹配
  var daoRules = rules.daoPath || {};
  state.actors.forEach(function (a) {
    var dp = a.daoPath || '';
    Object.keys(daoRules).forEach(function (k) {
      if (dp.indexOf(k) >= 0) score += daoRules[k];
    });
  });
  // 角色愿望关键词匹配
  state.actors.forEach(function (a) {
    var wish = a.publicWish || '';
    (recipe.tags || []).forEach(function (tag) {
      if (wish.indexOf(tag) >= 0) score += 1;
    });
  });
  return Math.min(100, Math.max(1, score));
};

/**
 * 生成三张候选命途签。
 * 规则：
 *   - 同种子必然生成相同三张。
 *   - 三张不得来自同一 family。
 *   - 三张至少覆盖 mystery、intrigue/conflict、exploration 中的两类。
 *   - 权重影响但不锁死结果。
 */
Story.Director.generateCandidates = function (state) {
  var recipes = Story.Director.listRecipes(state);
  var rng = Story.rngFor('director', state);
  // 计算权重
  var scored = recipes.map(function (r) {
    var score = Story.Director.scoreRecipe(state, r);
    return { recipe: r, score: score, rankScore: score + rng.next() * 1.5 };
  });
  // 按 family 分组，取每组最高分
  var byFamily = {};
  scored.forEach(function (s) {
    var f = s.recipe.family;
    if (!byFamily[f] || byFamily[f].rankScore < s.rankScore) byFamily[f] = s;
  });
  var families = Object.keys(byFamily);
  // 按权重排序
  var ranked = families.map(function (f) { return byFamily[f]; }).sort(function (a, b) { return b.rankScore - a.rankScore; });
  var picked = [];
  var drawPool = ranked.slice();
  while (picked.length < 3 && drawPool.length) {
    var total = drawPool.reduce(function (sum, s) { return sum + Math.max(1, s.rankScore || s.score || 1); }, 0);
    var roll = rng.next() * total;
    var chosenIndex = 0;
    for (var di = 0; di < drawPool.length; di++) {
      roll -= Math.max(1, drawPool[di].rankScore || drawPool[di].score || 1);
      if (roll <= 0) { chosenIndex = di; break; }
    }
    picked.push(drawPool.splice(chosenIndex, 1)[0].recipe);
  }
  // 转换为候选卡结构
  var candidates = picked.slice(0, 3).map(function (r) {
    return {
      arcId: 'arc_' + r.id,
      recipeId: r.id,
      family: r.family,
      title: r.title,
      publicPitch: r.publicPitch,
      tags: r.tags.slice(),
      openingHooks: (r.openingSeed.addThreads || []).map(function (t) { return t.threadId; }).concat(
        (r.openingSeed.addEntities || []).map(function (e) { return e.id; })
      ),
      voteScore: 0,
      voteBreakdown: {},
    };
  });
  return candidates;
};

/**
 * 激活选中卷纲。
 * 写入 activeArc，未选中的写入 dormantArcs。
 * 按 openingSeed 创建线程、实体、时钟。
 * 注意：不修改 currentScene（由调用方在 activateArc 之后创建场景）。
 */
Story.Director.activateArc = function (state, arcId) {
  var d = state.story.director;
  var candidate = d.candidates.find(function (c) { return c.arcId === arcId; });
  if (!candidate) throw new Error('未找到候选卷纲：' + arcId);
  var recipe = Story.Director.getRecipe(state, candidate.recipeId);
  if (!recipe) throw new Error('未找到 Recipe：' + candidate.recipeId);
  // 构造 activeArc
  var arc = {
    arcId: candidate.arcId,
    recipeId: candidate.recipeId,
    family: candidate.family,
    title: candidate.title,
    publicPitch: candidate.publicPitch,
    tags: candidate.tags.slice(),
    status: 'active',
    startedAtChapter: state.story.chapterIndex || 0,
    currentBeatIndex: 0,
    beats: (recipe.beats || []).map(function (b, i) {
      return {
        beatId: b.beatId,
        title: b.title,
        dramaticGoal: b.dramaticGoal,
        status: i === 0 ? 'active' : 'pending',
        advanceSignals: b.advanceSignals,
        bendSignals: b.bendSignals,
        stallSignals: b.stallSignals,
        shatterKeywords: b.shatterKeywords || [],
        allowedReveals: b.allowedReveals || [],
        forbiddenReveals: b.forbiddenReveals || [],
        nextOnAdvance: b.nextOnAdvance,
        nextOnBend: b.nextOnBend,
        nextOnStall: b.nextOnStall,
        nextOnShatter: b.nextOnShatter,
      };
    }),
    pressureClocks: [],
    divergenceLog: [],
    revealLog: [],
  };
  // 创建压力时钟
  if (recipe.openingSeed && recipe.openingSeed.addClock) {
    var c = recipe.openingSeed.addClock;
    arc.pressureClocks.push({
      clockId: c.clockId,
      label: c.label,
      current: c.current || 0,
      max: c.max || 3,
      onFull: c.onFull || 'divert',
    });
  }
  d.activeArc = arc;
  d.phase = 'active';
  // 未选中的放入 dormantArcs
  d.candidates.forEach(function (c) {
    if (c.arcId === arcId) return;
    d.dormantArcs.push({
      arcId: c.arcId,
      recipeId: c.recipeId,
      family: c.family,
      title: c.title,
      status: 'dormant',
      wakeConditions: ['chapterIndex >= 8', 'arc ' + arcId + ' completed'],
    });
  });
  return arc;
};

Story.Director.applyOpeningSeed = function (state, activeArc) {
  if (!state || !activeArc) return;
  var recipe = Story.Director.getRecipe(state, activeArc.recipeId);
  if (!recipe || !recipe.openingSeed) return;
  state.story.activeThreads = state.story.activeThreads || [];
  var existingThreads = {};
  state.story.activeThreads.forEach(function (t) { if (t && t.threadId) existingThreads[t.threadId] = true; });
  if (recipe.openingSeed.addThreads) {
    recipe.openingSeed.addThreads.forEach(function (t) {
      if (!t || !t.threadId || existingThreads[t.threadId]) return;
      existingThreads[t.threadId] = true;
      state.story.activeThreads.push({
        threadId: t.threadId,
        type: t.type || 'mystery',
        title: t.title || t.threadId,
        stage: t.stage || 1,
        maxStage: t.maxStage || 4,
        urgency: t.urgency || 1,
        visibility: t.visibility || 'public',
        status: t.status || 'active',
        sourceArcId: activeArc.arcId,
        ownerActorIds: [],
        involvedActorIds: [],
        summary: t.title || '',
        triggerTags: [],
        lastAdvancedChapter: 0,
        sourceChapter: state.story.chapterIndex || 0,
      });
    });
  }
  var scene = state.story.currentScene;
  if (!scene) return;
  scene.visibleEntities = Story.Scene.Entity.normalize(scene.visibleEntities);
  var existingEntities = {};
  scene.visibleEntities.forEach(function (e) { if (e && e.id) existingEntities[e.id] = true; });
  if (recipe.openingSeed.addEntities) {
    recipe.openingSeed.addEntities.forEach(function (e) {
      if (!e || !e.id || existingEntities[e.id]) return;
      existingEntities[e.id] = true;
      scene.visibleEntities.push({
        id: e.id,
        name: e.name,
        kind: e.kind,
        affordances: (e.affordances || []).slice(),
        threadId: e.threadId || '',
        sourceThreadId: e.sourceThreadId || '',
        sourceArcId: activeArc.arcId,
      });
    });
  }
  scene.activeThreadIds = (state.story.activeThreads || [])
    .filter(function (t) { return t && (t.status === 'active' || t.status === 'dormant'); })
    .map(function (t) { return t.threadId; });
  Story.Scene._syncActorsToScene(state, scene);
};

Story.Director.applyArcOpeningScenePatch = function (state, activeArc) {
  if (!state || !activeArc || !state.story) return;
  var recipe = Story.Director.getRecipe(state, activeArc.recipeId);
  var patch = recipe && recipe.openingScenePatch;
  var scene = state.story.currentScene;
  if (!patch || !scene) return;
  if (patch.locationId) scene.locationId = patch.locationId;
  if (patch.locationName) scene.locationName = patch.locationName;
  if (patch.timeOfDay) scene.timeOfDay = patch.timeOfDay;
  if (patch.weather) scene.weather = patch.weather;
  if (patch.immediateConflict) scene.immediateConflict = patch.immediateConflict;
  if (patch.immediateQuestion) scene.immediateQuestion = patch.immediateQuestion;
  if (patch.deadline !== undefined) scene.deadline = patch.deadline ? Story._clone(patch.deadline) : null;
  if (patch.pressure != null) scene.pressure = patch.pressure;
  if (patch.replaceDefaultEntities) {
    scene.visibleEntities = Story.Scene.Entity.normalize(patch.baseEntities || []);
    scene.availableAssets = [];
  } else if (patch.baseEntities && patch.baseEntities.length) {
    var current = Story.Scene.Entity.normalize(scene.visibleEntities);
    var byId = {};
    current.forEach(function (e) { byId[e.id] = true; });
    patch.baseEntities.forEach(function (e) {
      if (e && e.id && !byId[e.id]) current.push(Story._clone(e));
    });
    scene.visibleEntities = Story.Scene.Entity.normalize(current);
  }
  if (patch.baseExits) scene.exits = Story.Scene.Entity.normalize(patch.baseExits);
  if (patch.replaceDefaultThreads) state.story.activeThreads = [];
  scene.activeThreadIds = [];
  scene.recentEvents = scene.recentEvents || [];
  scene.recentEvents.push('卷纲开局：' + activeArc.title);
  Story.Scene._syncActorsToScene(state, scene);
};

/** 注册无卷纲 fallback 的开局资产。 */
Story.Director.applyDefaultOpeningAssets = function (state) {
  if (!state || !state.story || !state.story.currentScene) return;
  var scene = state.story.currentScene;
  var ownerId = state.actors[0] && state.actors[0].id || null;
  Story.AssetRegistry.register(state, {
    id: 'residual_sword', name: '残剑', kind: 'relic', ownerActorId: ownerId,
    locationId: scene.locationId, state: 'attuned', publicHint: '剑身微颤，似有灵识。',
    source: 'default_opening', threadId: 'thread_old_sword',
  });
  Story.AssetRegistry.register(state, {
    id: 'trade_letter', name: '半封商会密信', kind: 'clue', ownerActorId: null,
    locationId: scene.locationId, state: 'intact', publicHint: '雨水浸坏了一半字迹。',
    source: 'default_opening', threadId: 'thread_trade_letter',
  });
};

/** 用当前卷纲资产替换 fallback 资产，并同步场景可用资产。 */
Story.Director.applyArcAssets = function (state, activeArc) {
  if (!state || !activeArc || !state.story) return;
  var recipe = Story.Director.getRecipe(state, activeArc.recipeId);
  var patch = recipe && recipe.openingScenePatch || {};
  var seed = recipe && recipe.openingSeed || {};
  if (patch.replaceDefaultAssets) {
    state.assets = (state.assets || []).filter(function (asset) {
      return asset && asset.source !== 'default_opening' && asset.id !== 'trade_letter' && asset.id !== 'residual_sword';
    });
  }
  var scene = state.story.currentScene;
  var assets = (patch.baseAssets || []).concat(seed.addAssets || []);
  assets.forEach(function (asset) {
    if (!asset || !asset.id) return;
    Story.AssetRegistry.register(state, Object.assign({}, Story._clone(asset), {
      locationId: asset.locationId || (scene && scene.locationId) || null,
      source: asset.source || 'arc_opening',
      sourceArcId: activeArc.arcId,
    }));
  });
  if (scene) {
    scene.availableAssets = assets.map(function (asset) {
      return {
        id: asset.id, name: asset.name || asset.id, kind: asset.kind || 'item',
        affordances: asset.kind === 'relic' ? ['use_relic', 'investigate'] : ['investigate', 'observe'],
        threadId: asset.threadId || '', sourceArcId: activeArc.arcId,
      };
    });
  }
};

/* ---------- DirectorVote 投票模块 ---------- */
Story.DirectorVote = {};

/**
 * 投票结算 → 激活卷纲 → 生成开局场景与叙事。
 * 这是 createSession(skipOpening=true) 之后调用的收尾函数。
 */
Story.Director.finalizeSessionWithArc = async function (state, arcId) {
  var d = state.story.director;
  if (d.phase !== 'voting') throw new Error('当前不在投票阶段');
  var arc = Story.Director.activateArc(state, arcId);
  // 激活后生成开局场景与叙事
  await Story._generateOpening(state);
  return arc;
};

/* ---------- Director.evaluate：Beat 推进判断 ---------- */

/** 检测是否触发了打碎（shatter）条件 */
Story.Director._detectShatter = function (beat, action, rawText) {
  if (!beat || !beat.shatterKeywords || !beat.shatterKeywords.length) return false;
  var text = Story.Director._actionRawText(action) || rawText || '';
  var cat = Story.Director._actionCategory(action);
  for (var i = 0; i < beat.shatterKeywords.length; i++) {
    if (text.indexOf(beat.shatterKeywords[i]) >= 0) return true;
  }
  if (cat === 'flee' || cat === 'travel') {
    var kw = ['离开', '不再', '放弃', '告别'];
    for (var j = 0; j < kw.length; j++) {
      if (text.indexOf(kw[j]) >= 0) return true;
    }
  }
  return false;
};

/**
 * 评估本回合行动对当前 Beat 的影响。返回 DirectorPlan（不直接修改状态）。
 */
Story.Director.evaluate = function (state, envelope) {
  var d = state.story.director;
  if (d.phase !== 'active' || !d.activeArc) return null;
  var arc = d.activeArc;
  var beat = (arc.beats || [])[arc.currentBeatIndex];
  if (!beat || beat.status !== 'active') return null;
  var actions = [];
  if (envelope.actions) {
    envelope.actions.forEach(function (a) {
      actions.push({
        actorId: a.actorId,
        intentCategory: a.intentCategory,
        category: a.category,
        targetId: a.targetId,
        custom: a.custom,
        rawText: a.rawText,
      });
    });
  }
  var directorScore = { advance: 0, bend: 0, stall: 0, shatter: 0, conflicts: [] };
  var humanDirections = {};
  var reasons = [];
  actions.forEach(function (action) {
    var actor = state.actors.find(function (ac) { return ac.id === action.actorId; });
    var isHuman = actor && actor.controller === 'human';
    var actorName = actor ? actor.name : action.actorId;
    var cat = Story.Director._actionCategory(action);
    var targetId = Story.Director._actionTarget(action);
    var direction = null;
    var shatter = Story.Director._detectShatter(beat, action, Story.Director._actionRawText(action));
    if (shatter) {
      directorScore.shatter += 4;
      direction = 'shatter';
      reasons.push(actorName + '触发打碎信号');
    } else if (beat.advanceSignals &&
      ((beat.advanceSignals.categories || []).indexOf(cat) >= 0 ||
       (targetId && (beat.advanceSignals.targets || []).indexOf(targetId) >= 0))) {
      directorScore.advance += isHuman ? 2 : 1;
      direction = 'advance';
      reasons.push(actorName + '匹配推进信号');
    } else if (beat.bendSignals &&
      ((beat.bendSignals.categories || []).indexOf(cat) >= 0 ||
       (targetId && (beat.bendSignals.targets || []).indexOf(targetId) >= 0))) {
      directorScore.bend += isHuman ? 2 : 1;
      direction = 'bend';
      reasons.push(actorName + '匹配偏转信号');
    } else if (beat.stallSignals && (beat.stallSignals.categories || []).indexOf(cat) >= 0) {
      directorScore.stall += isHuman ? 1 : 0.5;
      direction = 'stall';
      reasons.push(actorName + '未触碰主线压力');
    } else {
      directorScore.stall += isHuman ? 1 : 0;
      direction = 'stall';
    }
    if (isHuman && direction) humanDirections[direction] = (humanDirections[direction] || 0) + 1;
  });
  var result = 'stall';
  var humanDirectionCount = Object.keys(humanDirections).filter(function (k) { return humanDirections[k] > 0; }).length;
  if (humanDirectionCount > 1) {
    directorScore.conflicts.push({
      type: 'playerConflict',
      directions: Story._clone(humanDirections),
    });
    reasons.push('多人行动方向冲突');
  }
  // 1. shatter 优先
  if (directorScore.shatter >= 4) {
    result = 'shatter';
  } else {
    var closeAdvanceBend = directorScore.advance > 0 && directorScore.bend > 0 &&
      Math.abs(directorScore.advance - directorScore.bend) <= 1;
    if (closeAdvanceBend || (humanDirectionCount > 1 && (humanDirections.advance || humanDirections.bend))) {
      result = 'bend';
    } else if (directorScore.advance >= directorScore.bend && directorScore.advance > directorScore.stall && directorScore.advance > 0) {
      result = 'advance';
    } else if (directorScore.bend > 0 && directorScore.bend >= directorScore.stall) {
      result = 'bend';
    } else {
      result = 'stall';
      if (!reasons.length) reasons.push('本回合没有有效推进卷纲');
    }
  }
  // 时钟
  var clockDeltas = [];
  (arc.pressureClocks || []).forEach(function (c) {
    if (result === 'stall' || result === 'shatter') {
      clockDeltas.push({ clockId: c.clockId, delta: 1 });
    }
  });
  // arcDeltas
  var arcDeltas = [];
  if (result === 'advance' || result === 'bend') {
    var nextBeatId = result === 'advance' ? beat.nextOnAdvance : beat.nextOnBend;
    if (nextBeatId) {
      arcDeltas.push({ op: 'ADVANCE_BEAT', beatId: beat.beatId, nextBeatId: nextBeatId, result: result });
    } else {
      arcDeltas.push({ op: 'COMPLETE_ARC', beatId: beat.beatId, result: result });
    }
  } else if (result === 'shatter') {
    var shatterBeatId = beat.nextOnShatter || (beat.beatId + '_shattered');
    arcDeltas.push({ op: 'SHATTER_ARC', beatId: beat.beatId, shatterBeatId: shatterBeatId, result: result });
  }
  var narrativeGuide = {
    currentArcTitle: arc.title,
    beatGoal: beat.dramaticGoal || '',
    beatTitle: beat.title,
    result: result,
    allowedReveals: beat.allowedReveals || [],
    forbiddenReveals: beat.forbiddenReveals || [],
    directorScore: Story._clone(directorScore),
  };
  return {
    arcId: arc.arcId,
    beatId: beat.beatId,
    result: result,
    reasons: reasons,
    directorScore: directorScore,
    clockDeltas: clockDeltas,
    arcDeltas: arcDeltas,
    sceneDeltas: [],
    threadDeltas: [],
    narrativeGuide: narrativeGuide,
  };
};

/**
 * 应用 DirectorPlan 到状态（仅在 _commitPendingResolution 中调用）。
 */
Story.Director.resolveClockFull = function (state, arc, clock) {
  if (!state || !arc || !clock) return null;
  var scene = state.story.currentScene;
  var pressureText = (clock.label || clock.clockId) + '已满，局势不再等待玩家。';
  if (scene) {
    scene.pressure = Math.max(scene.pressure || 0, 3);
    scene.sceneStatus = 'pressured';
    scene.recentEvents = scene.recentEvents || [];
    scene.recentEvents.push(pressureText);
    if (scene.deadline && (scene.deadline.type === clock.label || String(scene.deadline.type || '').indexOf(clock.label) >= 0)) {
      scene.deadline.remaining = 0;
    }
    if (clock.clockId === 'clock_caravan_departure') {
      scene.visibleEntities = Story.Scene.Entity.normalize(scene.visibleEntities).filter(function (e) { return e.id !== 'ent_trade_caravan'; });
      scene.exits = Story.Scene.Entity.normalize(scene.exits);
      if (!scene.exits.some(function (e) { return e.id === 'exit_caravan_trail'; })) {
        scene.exits.push({ id: 'exit_caravan_trail', name: '商队车辙', kind: 'exit', affordances: ['travel', 'investigate'] });
      }
      pressureText = '商队已经离城，只剩车辙与被雨水冲淡的灵砂。';
      scene.recentEvents.push(pressureText);
    } else if (clock.clockId === 'clock_city_lockdown') {
      scene.exits = Story.Scene.Entity.normalize(scene.exits).map(function (e) {
        if (e.id === 'exit_locked_gate') e.state = 'locked';
        return e;
      });
      pressureText = '城门已经落锁，缉仙司的搜捕转入明面。';
      scene.recentEvents.push(pressureText);
    } else if (clock.clockId === 'clock_seal_decay') {
      pressureText = '封印衰减到危险边缘，秘境裂隙开始主动吞吐灵光。';
      scene.recentEvents.push(pressureText);
    }
  }
  var currentBeat = (arc.beats || [])[arc.currentBeatIndex];
  var divertedId = currentBeat ? (currentBeat.beatId + '_diverted_' + clock.clockId) : ('diverted_' + clock.clockId);
  if (currentBeat && !arc.beats.some(function (b) { return b.beatId === divertedId; })) {
    currentBeat.status = 'diverted';
    arc.beats.push({
      beatId: divertedId,
      title: '时限已至',
      dramaticGoal: pressureText,
      status: 'active',
      advanceSignals: { categories: ['investigate', 'travel', 'social'], targets: [] },
      bendSignals: { categories: ['negotiate', 'deceive', 'use_relic'], targets: [] },
      stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
      shatterKeywords: [],
      allowedReveals: [pressureText],
      forbiddenReveals: [],
      nextOnAdvance: null, nextOnBend: null, nextOnStall: null, nextOnShatter: null,
    });
    arc.currentBeatIndex = arc.beats.length - 1;
  }
  return {
    op: 'DIVERT_BEAT',
    clockId: clock.clockId,
    narrativePressure: pressureText,
  };
};

Story.Director.applyPlan = function (state, plan) {
  if (!plan) return;
  var d = state.story.director;
  var arc = d.activeArc;
  if (!arc || arc.arcId !== plan.arcId) return;
  var clockEvents = [];
  (plan.clockDeltas || []).forEach(function (cd) {
    var clock = (arc.pressureClocks || []).find(function (c) { return c.clockId === cd.clockId; });
    if (clock) {
      var before = clock.current || 0;
      clock.current = Math.min(clock.max, before + (cd.delta || 0));
      if (before < clock.max && clock.current >= clock.max) {
        var clockEvent = Story.Director.resolveClockFull(state, arc, clock);
        if (clockEvent) clockEvents.push(clockEvent);
      }
    }
  });
  (plan.arcDeltas || []).forEach(function (ad) {
    if (ad.op === 'ADVANCE_BEAT') {
      var curBeat = (arc.beats || []).find(function (b) { return b.beatId === ad.beatId; });
      if (curBeat) curBeat.status = 'completed';
      var nextIdx = (arc.beats || []).findIndex(function (b) { return b.beatId === ad.nextBeatId; });
      if (nextIdx >= 0) { arc.currentBeatIndex = nextIdx; arc.beats[nextIdx].status = 'active'; }
    } else if (ad.op === 'COMPLETE_ARC') {
      var cb = (arc.beats || []).find(function (b) { return b.beatId === ad.beatId; });
      if (cb) cb.status = 'completed';
      arc.status = 'completed';
      d.phase = 'completed';
      d.completedArcs.push({ arcId: arc.arcId, title: arc.title, completedAtChapter: state.story.chapterIndex });
    } else if (ad.op === 'SHATTER_ARC') {
      var sb = (arc.beats || []).find(function (b) { return b.beatId === ad.beatId; });
      if (sb) sb.status = 'shattered';
      arc.status = 'shattered';
      var shatteredBeat = {
        beatId: ad.shatterBeatId, title: '碎片',
        dramaticGoal: '原有路线已毁，新的威胁正在逼近。',
        status: 'active',
        advanceSignals: { categories: ['investigate', 'social', 'travel'], targets: [] },
        bendSignals: { categories: ['negotiate', 'observe'], targets: [] },
        stallSignals: { categories: ['rest', 'wait', 'cultivate'] },
        shatterKeywords: [], allowedReveals: [], forbiddenReveals: [],
        nextOnAdvance: null, nextOnBend: null, nextOnStall: null, nextOnShatter: null,
      };
      arc.beats.push(shatteredBeat);
      arc.currentBeatIndex = arc.beats.length - 1;
    }
  });
  arc.divergenceLog = arc.divergenceLog || [];
  arc.divergenceLog.push({
    chapterIndex: state.story.chapterIndex, beatId: plan.beatId,
    result: plan.result, reasons: plan.reasons || [], clockEvents: clockEvents,
    directorScore: plan.directorScore ? Story._clone(plan.directorScore) : null,
    timestamp: Date.now(),
  });
  arc.revealLog = arc.revealLog || [];
  if (plan.narrativeGuide && plan.narrativeGuide.allowedReveals) {
    plan.narrativeGuide.allowedReveals.forEach(function (r) {
      if (arc.revealLog.indexOf(r) < 0) arc.revealLog.push(r);
    });
  }
  d.lastDirectorEvent = {
    arcId: plan.arcId, beatId: plan.beatId,
    result: plan.result, chapterIndex: state.story.chapterIndex,
  };
};

/**
 * 获取当前 Beat 的叙事引导（供 Narration.buildBrief 调用）。
 */
Story.Director.buildNarrativeGuide = function (state) {
  var d = state.story.director;
  if (d.phase !== 'active' || !d.activeArc) return null;
  var arc = d.activeArc;
  var beat = (arc.beats || [])[arc.currentBeatIndex];
  if (!beat) return null;
  var clocks = (arc.pressureClocks || []).map(function (c) {
    return { label: c.label, current: c.current, max: c.max };
  });
  // V3.3.2 修复：从 pendingResolution.directorPlan 取本回合 result
  var beatResult = null;
  var pr = state.story.pendingResolution;
  if (pr && pr.directorPlan && pr.directorPlan.result) {
    beatResult = pr.directorPlan.result;
  }
  return {
    arcTitle: arc.title,
    arcPromise: arc.publicPitch || '',
    currentBeatTitle: beat.title,
    dramaticGoal: beat.dramaticGoal || '',
    beatResult: beatResult,
    allowedReveals: beat.allowedReveals || [],
    forbiddenReveals: beat.forbiddenReveals || [],
    beatStatus: beat.status,
    pressureClocks: clocks,
  };
};

/**
 * 提交投票（真人或 Bot）。
 * 玩家可改票，Bot 不改票。
 */
Story.DirectorVote.submitVote = function (state, actorId, arcId) {
  var d = state.story.director;
  if (d.phase !== 'voting') throw new Error('当前不在投票阶段');
  var candidate = d.candidates.find(function (c) { return c.arcId === arcId; });
  if (!candidate) throw new Error('无效的候选卷纲：' + arcId);
  d.votesByActorId[actorId] = arcId;
};

/**
 * Bot 自动投票：根据角色道途/愿望/偏好计算权重。
 */
Story.DirectorVote.autoVoteForBot = function (state, actorId) {
  var d = state.story.director;
  if (d.phase !== 'voting') return null;
  var actor = state.actors.find(function (a) { return a.id === actorId; });
  if (!actor) return null;
  var rng = Story.rngFor('director', state);
  // 简单权重：道途偏好 + 标签匹配
  var scored = d.candidates.map(function (c) {
    var recipe = Story.Director.getRecipe(state, c.recipeId);
    var s = Story.Director.scoreRecipe(state, recipe);
    // 角色个人偏好
    if (actor.choicePrefs) {
      (c.tags || []).forEach(function (tag) {
        if (actor.choicePrefs[tag]) s += actor.choicePrefs[tag] * 2;
      });
    }
    // 已投票的角色选择（理论上 Bot 不应参考其他投票，此处仅按自身偏好）
    return { arcId: c.arcId, score: s };
  });
  // 加权随机选择（制造"Bot 似乎有自己偏好"的感觉）
  var total = scored.reduce(function (sum, s) { return sum + Math.max(0, s.score); }, 0);
  if (total <= 0) {
    // 全部同分，随机
    return d.candidates[Math.floor(rng.next() * d.candidates.length)].arcId;
  }
  var roll = rng.next() * total;
  var acc = 0;
  for (var i = 0; i < scored.length; i++) {
    acc += Math.max(0, scored[i].score);
    if (roll <= acc) return scored[i].arcId;
  }
  return scored[scored.length - 1].arcId;
};

/**
 * 结算投票：统计票数，同票时用导演 RNG 决定。
 * 返回胜出 arcId。
 */
Story.DirectorVote.finalizeVote = function (state) {
  var d = state.story.director;
  if (d.phase !== 'voting') throw new Error('当前不在投票阶段');
  var rng = Story.rngFor('director', state);
  // 统计票数
  var tally = {};
  d.candidates.forEach(function (c) { tally[c.arcId] = 0; });
  Object.keys(d.votesByActorId).forEach(function (aid) {
    var arcId = d.votesByActorId[aid];
    if (tally[arcId] !== undefined) tally[arcId]++;
  });
  // 找最高票
  var maxVotes = 0;
  var winners = [];
  Object.keys(tally).forEach(function (arcId) {
    if (tally[arcId] > maxVotes) { maxVotes = tally[arcId]; winners = [arcId]; }
    else if (tally[arcId] === maxVotes) winners.push(arcId);
  });
  // 同票时用 RNG 决定
  var winner = winners.length === 1 ? winners[0] : winners[Math.floor(rng.next() * winners.length)];
  // 更新候选卡上的投票记录
  d.candidates.forEach(function (c) { c.voteScore = tally[c.arcId] || 0; });
  return winner;
};

/* ---------- V3.3 Phase 2：共享场景下的角色在场状态 ---------- */
Story.Scene.getActorPresence = function (state, actorId) {
  const a = state.actors.find(function (x) { return x.id === actorId; });
  return a ? { locationId: a.locationId, presence: a.presence || 'present' } : { locationId: null, presence: 'absent' };
};
Story.Scene.actorsPresent = function (state) {
  const loc = state.story.currentScene && state.story.currentScene.locationId;
  return state.actors.filter(function (a) { return a.presence !== 'away' && (!a.locationId || !loc || a.locationId === loc); });
};
/** 把角色位置同步到指定场景（开局或全员迁移时调用） */
Story.Scene._syncActorsToScene = function (state, scene) {
  if (!scene) return;
  (state.actors || []).forEach(function (a) {
    a.locationId = scene.locationId;
    a.presence = 'present';
  });
};

Story.Scene.createOpeningScene = function (state) {
  const w = state.world.worldBible;
  const rng = Story.rngFor('event', state);
  const place = '赤砂边城·听雨客栈';
  const sceneId = 'scene_0001';
  const scene = {
    sceneId: sceneId,
    locationId: 'inn_redsand',
    locationName: place,
    timeOfDay: '夜',
    weather: rng.pick(['细雨', '微雨', '阴', '风急']),
    focalActorIds: state.actors.map(function (a) { return a.id; }).slice(0, 2),
    immediateConflict: '商会使者将连夜离城，半封密信下落不明。',
    immediateQuestion: '是否追查被截断的密信？',
    // V3.3 Phase 3：对象化实体 + affordances
    visibleEntities: [
      { id: 'ent_innkeeper', name: '女掌柜', kind: 'npc', affordances: ['social', 'negotiate', 'observe'] },
      { id: 'ent_trade_letter', name: '半封商会密信', kind: 'clue', affordances: ['investigate', 'observe'] },
      { id: 'ent_residual_sword', name: '残剑', kind: 'relic', affordances: ['use_relic', 'investigate'] },
    ],
    availableAssets: [
      { id: 'asset_trade_letter', name: '半封商会密信', kind: 'clue', affordances: ['investigate'] },
      { id: 'asset_residual_sword', name: '残剑', kind: 'relic', affordances: ['use_relic'] },
    ],
    exits: [
      { id: 'exit_gate', name: '城门', kind: 'exit', affordances: ['travel', 'flee'] },
      { id: 'exit_backyard', name: '客栈后院', kind: 'exit', affordances: ['travel', 'observe'] },
      { id: 'exit_guild', name: '商会旧址', kind: 'exit', affordances: ['travel', 'investigate'] },
    ],
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
  // V3.3 Phase 2：角色同步到开局场景
  Story.Scene._syncActorsToScene(state, scene);
  return scene;
};

Story.Scene.createLegacyScene = function (state) {
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

/** 是否应切换场景（V3.3 Phase 2 共享场景版）。
 *  travel/flee 不再无条件重写全员位置：
 *    - 玩家(主人类角色)移动，或半数以上活跃角色同时移动 → 'move'（整队迁移，重写共享场景）
 *    - 仅少数（如单个 Bot）移动 → 'partial_move'（共享场景保留，移动者标记 away）
 *  其余逻辑同 V3.2。 */
Story.Scene.shouldTransition = function (state, envelope) {
  const actions = envelope.actions || [];
  const movers = actions.filter(function (a) { return a.category === 'travel' || a.category === 'flee'; });
  if (movers.length > 0) {
    const player = Story.getPrimaryHumanActor(state);
    const playerMoves = player && movers.some(function (m) { return m.actorId === player.id; });
    const active = (state.actors || []).filter(function (a) { return a.presence !== 'away'; });
    const majority = active.length > 0 && (movers.length * 2 > active.length);
    // 单人/独游：默认整队迁移（保留 V3.2 行为，避免破坏单人体验）
    const solo = active.length <= 1;
    if (playerMoves || majority || solo) return 'move';
    return 'partial_move';
  }
  if (envelope.worldDelta && envelope.worldDelta.epochJump) return 'epoch_jump';
  // 时间跨度极大
  const tp = envelope.actions[0] && envelope.actions[0].timePassed;
  if (tp && (tp.unit === '百年' || tp.unit === '数年')) return 'skip_time';
  // 场景 deadline 归零且 thread 关闭 → close
  const scene = state.story.currentScene;
  if (scene && scene.deadline && scene.deadline.remaining <= 0 && (scene.sceneStatus === 'closing')) return 'close';
  return 'stay';
};

/** 组合下一场景（V3.3 Phase 2 + 3） */
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
    // V3.3 Phase 3：对象化出口/实体
    next.exits = [
      { id: 'exit_back', name: '来路', kind: 'exit', affordances: ['travel', 'flee'] },
      { id: 'exit_deep', name: '古道深处', kind: 'exit', affordances: ['travel', 'investigate'] },
      { id: 'exit_path', name: '林间小径', kind: 'exit', affordances: ['travel', 'flee'] },
    ];
    next.visibleEntities = [
      { id: 'ent_rut', name: '车辙', kind: 'clue', affordances: ['investigate', 'observe'] },
      { id: 'ent_rain', name: '雨', kind: 'prop', affordances: ['observe'] },
      { id: 'ent_residual_sword', name: '残剑', kind: 'relic', affordances: ['use_relic', 'investigate'] },
    ];
    next.availableAssets = [{ id: 'asset_residual_sword', name: '残剑', kind: 'relic', affordances: ['use_relic'] }];
    next.enteredAtChapter = idx;
    next.deadline = null;
    next.pressure = Math.max(2, prev.pressure);
    // V3.3 Phase 2：整队迁移 → 全员同步到新场景，离队者归队
    Story.Scene._syncActorsToScene(state, next);
  } else if (transition === 'partial_move') {
    // V3.3 Phase 2：少数移动 → 共享场景不变；离队者归队(targetId=rejoin_party)则回到 present
    const movers = (envelope.actions || []).filter(function (a) { return a.category === 'travel' || a.category === 'flee'; });
    movers.forEach(function (m) {
      const a = state.actors.find(function (x) { return x.id === m.actorId; });
      if (!a) return;
      if (m.targetId === 'rejoin_party') {
        a.presence = 'present';
        a.locationId = next.locationId;
      } else {
        a.presence = 'away';
        a.locationId = (m.targetId === 'trade_caravan') ? 'road_broken_flow' : (m.targetId || 'road_broken_flow');
      }
    });
    next.pressure = Math.min(5, Math.max(1, prev.pressure));
  } else if (transition === 'skip_time' || transition === 'epoch_jump') {
    next.timeOfDay = '数月之后';
    next.weather = '换季';
    next.pressure = Math.max(1, prev.pressure - 1);
  } else {
    // stay / reveal / escalate / close
    if (transition === 'reveal') {
      next.visibleEntities = prev.visibleEntities.concat([{ id: 'ent_yaogu_seal', name: '药谷旧印', kind: 'clue', affordances: ['investigate', 'observe'] }]);
      next.availableAssets = prev.availableAssets.concat([{ id: 'asset_yaogu_seal', name: '药谷旧印', kind: 'clue', affordances: ['investigate'] }]);
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
  const sceneThreads = (state.story.activeThreads || []).filter(function (t) {
    return !scene || !scene.activeThreadIds || scene.activeThreadIds.indexOf(t.threadId) >= 0;
  }).slice(0, 2);
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
      { op: 'ADD_PUBLIC_RUMOR', payload: { text: (scene ? scene.locationName : '此地') + '近来异象频生，引人注目。' }, source: 'resolver', sourceTurnId: 'turn_0000' },
    ],
    privateDelta: state.actors.slice(1).map(function (a) {
      return { op: 'ADD_PRIVATE_FACT', target: { actorId: a.id }, payload: { text: a.name + '心中暗忖：' + a.hiddenFate }, source: 'resolver', sourceTurnId: 'turn_0000' };
    }),
    sceneDelta: {}, worldDelta: {}, narrationBeats: [
      state.actors[0].name + '与众人抵达' + (scene ? scene.locationName : '未知之地') + '。',
      scene ? (scene.immediateConflict || scene.immediateQuestion || '此地旧事未尽。') : '此地旧事未尽。',
      sceneThreads.length ? ('当前线索：' + sceneThreads.map(function (t) { return t.title; }).join('、') + '。') : ('此界天道为「' + state.world.worldBible.heavenlyLaw + '」。'),
    ], choiceConstraints: [], provenance: 'local-resolver',
  };
};

/** 从线程、场景实体或资产目标反查其所属线程。 */
Story.Scene.threadForTarget = function (state, scene, targetId) {
  if (!state || !state.story || !targetId) return null;
  var threads = state.story.activeThreads || [];
  var direct = threads.find(function (t) { return t && t.threadId === targetId; });
  if (direct) return direct.threadId;
  scene = scene || state.story.currentScene;
  var entities = Story.Scene.Entity.normalize(scene && scene.visibleEntities)
    .concat(Story.Scene.Entity.normalize(scene && scene.availableAssets))
    .concat(Story.Scene.Entity.normalize(scene && scene.exits));
  var ent = entities.find(function (e) { return e.id === targetId; });
  var linked = ent && (ent.threadId || ent.sourceThreadId);
  if (!linked) {
    var asset = Story.AssetRegistry.get(state, targetId) || Story.AssetRegistry.get(state, String(targetId).replace(/^ent_/, ''));
    linked = asset && asset.threadId;
  }
  return linked && threads.some(function (t) { return t.threadId === linked; }) ? linked : null;
};

/**
 * 导演可观测快照：供 UI、房间事件、测试与导出层读取。
 * 只读汇总，不暴露隐藏 dormant 细节，不修改状态。
 */
Story.Director.getSnapshot = function (state) {
  state = state || Story.state;
  var d = state && state.story && state.story.director;
  if (!d) return null;
  var arc = d.activeArc || null;
  var beat = arc && (arc.beats || [])[arc.currentBeatIndex];
  var lastDivergence = arc && arc.divergenceLog && arc.divergenceLog.length
    ? arc.divergenceLog[arc.divergenceLog.length - 1] : null;
  var pendingPlan = state.story.pendingResolution && state.story.pendingResolution.directorPlan
    ? state.story.pendingResolution.directorPlan : null;
  return {
    phase: d.phase,
    activeArc: arc ? {
      arcId: arc.arcId,
      recipeId: arc.recipeId,
      family: arc.family,
      title: arc.title,
      status: arc.status,
      tags: (arc.tags || []).slice(),
      currentBeatIndex: arc.currentBeatIndex,
      currentBeat: beat ? {
        beatId: beat.beatId,
        title: beat.title,
        status: beat.status,
        dramaticGoal: beat.dramaticGoal || '',
      } : null,
      beats: (arc.beats || []).map(function (b) {
        return {
          beatId: b.beatId,
          title: b.title,
          status: b.status,
          dramaticGoal: b.dramaticGoal || '',
        };
      }),
      pressureClocks: (arc.pressureClocks || []).map(function (c) {
        return {
          clockId: c.clockId,
          label: c.label,
          current: c.current || 0,
          max: c.max || 1,
          percent: Math.round(((c.current || 0) / Math.max(1, c.max || 1)) * 100),
          isFull: (c.current || 0) >= (c.max || 1),
          onFull: c.onFull || '',
        };
      }),
    } : null,
    dormantArcCount: (d.dormantArcs || []).length,
    completedArcCount: (d.completedArcs || []).length,
    lastEvent: d.lastDirectorEvent ? Story._clone(d.lastDirectorEvent) : null,
    lastDivergence: lastDivergence ? Story._clone(lastDivergence) : null,
    pendingPlan: pendingPlan ? {
      arcId: pendingPlan.arcId,
      beatId: pendingPlan.beatId,
      result: pendingPlan.result,
      reasons: (pendingPlan.reasons || []).slice(),
      directorScore: pendingPlan.directorScore ? Story._clone(pendingPlan.directorScore) : null,
    } : null,
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

Story.Resolver._threadForIntent = function (state, scene, intent) {
  if (!intent) return Story.Director.getPrimaryThreadId(state);
  return Story.Scene.threadForTarget(state, scene, intent.targetId)
    || Story.Director.getPrimaryThreadId(state)
    || null;
};

Story.Resolver._resolveRest = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  let outcome = 'quiet_success';
  const gains = [];
  // V3.3.1：不直接改写 actor.hidden，改为写入 actorStatusDeltas，由 Delta 统一提交
  base.actorStatusDeltas = base.actorStatusDeltas || [];
  if (actor.hidden.injury > 0) { base.actorStatusDeltas.push({ key: 'injury', delta: -1 }); gains.push({ type: 'status', key: 'injury', delta: -1, text: '伤势略有恢复。' }); }
  else { gains.push({ type: 'status', key: 'spirit', delta: 1, text: '神魂之痛稍有缓和。' }); }
  base.gains = gains;

  const costs = [];
  // deadline 推进
  if (scene && scene.deadline && scene.deadline.remaining > 0) {
    var pressureThreadId = Story.Resolver._threadForIntent(state, scene, intent);
    if (pressureThreadId) base.threadEffects.push({ threadId: pressureThreadId, op: 'deadline_advance', delta: 1 });
    if (scene.deadline.remaining - 1 <= 0) {
      costs.push({ type: 'missed_opportunity', text: (scene.deadline.type || '当前时限') + '已经耗尽。' });
      outcome = 'missed_opportunity';
    }
  }
  // 高压场景可能被打扰
  if (scene && scene.pressure >= 3) {
    if (rng.chance(0.6)) {
      const _visNames = Story.Scene.Entity.names(scene.visibleEntities);
      const threat = (_visNames.indexOf('追兵') >= 0) ? '追兵' : (scene.immediateConflict || '外界威胁');
      base.publicEffects.push(actor.name + '在休息时被' + threat + '惊扰。');
      costs.push({ type: 'interrupted', text: '休息被' + threat + '打断。' });
      outcome = 'interrupted';
      base.actorStatusDeltas.push({ key: 'injury', delta: +1 });
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
  if (scene && scene.deadline) {
    var pressureThreadId = Story.Resolver._threadForIntent(state, scene, intent);
    if (pressureThreadId) base.threadEffects.push({ threadId: pressureThreadId, op: 'deadline_advance', delta: 1 });
  }
  base.publicEffects = [actor.name + '按兵不动。'];
  return base;
};

Story.Resolver._resolveObserve = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  base.outcome = 'success';
  const _obsNames = (scene && scene.visibleEntities && scene.visibleEntities.length) ? Story.Scene.Entity.names(scene.visibleEntities) : [];
  const detail = _obsNames.length ? rng.pick(_obsNames) : '周围动静';
  base.gains = [{ type: 'info', text: '观察到' + detail + '的细微异常。' }];
  base.costs = [{ type: 'time', text: '片刻时间流逝。' }];
  base.publicEffects = [actor.name + '暗中留意' + detail + '。'];
  return base;
};

Story.Resolver._resolveInvestigate = function (state, scene, intent, base, rng) {
  const actor = state.actors.find(function (a) { return a.id === intent.actorId; });
  // 必须有具体对象；推进对应 thread，不得同时推进无关线程
  let threadId = Story.Resolver._threadForIntent(state, scene, intent);
  const thread = Story.Resolver._threadById(state, threadId);
  const threadTitle = thread ? thread.title : '当前线索';
  base.outcome = rng.chance(0.7) ? 'success' : 'partial_success';
  base.gains = [{ type: 'clue', text: '推进' + threadTitle + '的调查。' }];
  base.costs = [{ type: 'exposure', text: '行动有所暴露，可能引起警觉。' }];
  if (threadId) base.threadEffects.push({ threadId: threadId, op: 'advance', delta: 1 });
  base.publicEffects = [actor.name + '着手追查' + threadTitle + '。'];
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
    var socialThreadId = Story.Resolver._threadForIntent(state, scene, intent);
    if (socialThreadId) base.threadEffects.push({ threadId: socialThreadId, op: 'advance', delta: 1 });
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
  // V3.3.1：不直接改写 actor.hidden，改为写入 actorStatusDeltas，由 Delta 统一提交
  const before = actor.hidden.cultivationProgress || 0;
  const delta = rng.int(8, 20);
  base.actorStatusDeltas = base.actorStatusDeltas || [];
  base.actorStatusDeltas.push({ key: 'cultivationProgress', delta: delta });
  base.outcome = (scene && scene.pressure >= 3) ? 'partial_success' : 'success';
  base.gains = [{ type: 'cultivation', key: 'cultivationProgress', delta: delta, text: '修为有所精进。' }];
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
  // V3.3.1：不直接改写 actor.hidden，改为写入 actorStatusDeltas
  if (rng.chance(0.4)) { base.actorStatusDeltas = base.actorStatusDeltas || []; base.actorStatusDeltas.push({ key: 'injury', delta: +1 }); }
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
  const visible = Story.Scene.Entity.normalize(scene && scene.visibleEntities)
    .concat(Story.Scene.Entity.normalize(scene && scene.availableAssets));
  const relic = visible.find(function (ent) { return ent.id === intent.targetId; });
  const relicName = relic ? relic.name : '眼前法器';
  const threadId = Story.Resolver._threadForIntent(state, scene, intent);
  base.outcome = 'success';
  base.gains = [{ type: 'relic_resonance', text: relicName + '产生共鸣。' }];
  base.costs = [{ type: 'relic_will', text: '法宝有灵，可能提出要求。' }];
  if (threadId) base.threadEffects.push({ threadId: threadId, op: 'advance', delta: 1 });
  base.privateEffects.push(relicName + '传来若有若无的灵性回应。');
  base.publicEffects = [actor.name + '以' + relicName + '为媒，触动其中灵性。'];
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
  var threadId = Story.Resolver._threadForIntent(state, scene, intent);
  if (threadId) base.threadEffects.push({ threadId: threadId, op: 'advance', delta: 1 });
  base.publicEffects = [actor.name + '动身前往' + ((intent.targetId && intent.targetId !== 'nearest_exit') ? intent.targetId : '下一处地点') + '。'];
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
    // V3.3.1：actorStatusDeltas → UPDATE_ACTOR_STATUS delta（不直接改写 actor，由 _commitPendingResolution 统一应用）
    (a.actorStatusDeltas || []).forEach(function (sd) {
      publicDelta.push({ op: 'UPDATE_ACTOR_STATUS', target: { actorId: a.actorId }, payload: { key: sd.key, delta: sd.delta }, source: 'resolver', sourceTurnId: '' });
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
    case 'UPDATE_ACTOR_STATUS': {
      const a2 = state.actors.find(function (x) { return x.id === (d.target && d.target.actorId); });
      if (!a2 || !a2.hidden) break;
      const key = d.payload.key;
      if (key === 'injury') a2.hidden.injury = Math.max(0, Math.min(10, (a2.hidden.injury || 0) + (d.payload.delta || 0)));
      else if (key === 'cultivationProgress') a2.hidden.cultivationProgress = Math.min(99, (a2.hidden.cultivationProgress || 0) + (d.payload.delta || 0));
      else if (key === 'spirit') a2.hidden.spirit = Math.max(0, (a2.hidden.spirit || 0) + (d.payload.delta || 0));
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
  // V3.3 Phase 2：离队者强制保留「返回同行」选项（确定性，不交由洗牌）
  const pinned = [];
  let restPool = pool;
  if (actor && actor.presence === 'away') {
    const rejoin = pool.find(function (c) { return c.intentCategory === 'travel' && c.targetId === 'rejoin_party'; });
    if (rejoin) {
      pinned.push(rejoin);
      restPool = pool.filter(function (c) { return c !== rejoin; });
    }
  } else {
    const arcBeat = Story.ChoiceFactory._activeDirectorBeat(state);
    const arcChoice = Story.ChoiceFactory.buildArcChoice(state, actor, scene2, arcBeat);
    if (arcChoice) {
      pinned.push(arcChoice);
      const arcFp = Story.ChoiceFactory.fingerprint(arcChoice);
      restPool = restPool.filter(function (c) { return Story.ChoiceFactory.fingerprint(c) !== arcFp; });
    }
    // V3.3.1：在场角色始终保证 rest 选项可用（不交由洗牌随机）
    const restChoice = restPool.find(function (c) { return c.intentCategory === 'rest'; });
    if (restChoice) {
      pinned.push(restChoice);
      restPool = restPool.filter(function (c) { return c !== restChoice; });
    }
  }
  // 洗牌并选 3 个不同 category
  const shuffled = rng.shuffle(restPool);
  const chosen = [];
  const usedCats = {};
  const usedFingerprints = {};
  const recent = (state.story.recentChoiceFingerprints || []).slice(-12);
  // 先放入 pinned（离队者归队选项），其 category 视为已用
  pinned.forEach(function (c) {
    const fp = Story.ChoiceFactory.fingerprint(c);
    c.fingerprint = fp;
    usedFingerprints[fp] = true;
    usedCats[c.intentCategory] = true;
    chosen.push(c);
  });
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
  // V3.3.2：分配 directorRole（每回合最多一项 arc 选项）
  var arc = state.story.director && state.story.director.activeArc;
  var beat = arc && (arc.beats || [])[arc.currentBeatIndex];
  var arcAssigned = false;
  ordered.forEach(function (c) {
    if (!arcAssigned && beat && arc.status === 'active' && beat.status === 'active') {
      var isArc = false;
      if (beat.advanceSignals) {
        isArc = (beat.advanceSignals.categories || []).indexOf(c.intentCategory) >= 0 ||
                (beat.advanceSignals.targets || []).indexOf(c.targetId) >= 0;
      }
      if (!isArc && beat.bendSignals) {
        isArc = (beat.bendSignals.categories || []).indexOf(c.intentCategory) >= 0 ||
                (beat.bendSignals.targets || []).indexOf(c.targetId) >= 0;
      }
      if (isArc) { c.directorRole = 'arc'; arcAssigned = true; return; }
    }
    // 角色个人目标或命盘相关
    if (c.targetType === 'npc' || c.intentCategory === 'social' || c.intentCategory === 'cultivate') {
      c.directorRole = 'character';
    } else {
      c.directorRole = 'scene';
    }
  });
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

Story.ChoiceFactory._activeDirectorBeat = function (state) {
  var arc = state.story.director && state.story.director.activeArc;
  if (!arc || arc.status !== 'active') return null;
  var beat = (arc.beats || [])[arc.currentBeatIndex];
  if (!beat || beat.status !== 'active') return null;
  return beat;
};

Story.ChoiceFactory._threadForEntity = function (state, ent) {
  if (!state || !ent) return null;
  if (ent.threadId) return ent.threadId;
  if (ent.sourceThreadId) return ent.sourceThreadId;
  var arc = state.story && state.story.director && state.story.director.activeArc;
  if (ent.sourceArcId && arc && ent.sourceArcId === arc.arcId) return Story.Director.getPrimaryThreadId(state);
  var beat = Story.ChoiceFactory._activeDirectorBeat(state);
  var targets = beat && beat.advanceSignals && beat.advanceSignals.targets || [];
  for (var i = 0; i < targets.length; i++) {
    var linked = Story.Scene.threadForTarget(state, state.story.currentScene, targets[i]);
    if (linked) return linked;
  }
  return Story.Scene.threadForTarget(state, state.story.currentScene, ent.id)
    || Story.Director.getPrimaryThreadId(state)
    || null;
};

Story.ChoiceFactory.buildArcChoice = function (state, actor, scene, beat) {
  if (!state || !actor || !scene || !beat) return null;
  var signals = beat.advanceSignals || {};
  var categories = (signals.categories || []).slice();
  var targets = (signals.targets || []).slice();
  if (!categories.length && beat.bendSignals) categories = (beat.bendSignals.categories || []).slice();
  if (!targets.length && beat.bendSignals) targets = (beat.bendSignals.targets || []).slice();
  if (!categories.length) return null;
  var visible = Story.Scene.Entity.normalize(scene.visibleEntities).concat(Story.Scene.Entity.normalize(scene.exits));
  var threads = state.story.activeThreads || [];
  var target = null;
  var targetType = 'scene';
  for (var i = 0; i < targets.length && !target; i++) {
    var tid = targets[i];
    var ent = visible.find(function (e) { return e.id === tid; });
    if (ent) { target = ent; targetType = ent.kind || 'scene'; break; }
    var thread = threads.find(function (t) { return t.threadId === tid; });
    if (thread) { target = { id: thread.threadId, name: thread.title || thread.threadId, kind: 'thread' }; targetType = 'thread'; break; }
  }
  if (!target) {
    for (var c = 0; c < categories.length && !target; c++) {
      var cat = categories[c];
      target = visible.find(function (e) { return Story.Scene.Entity.affordance(e, cat); });
      if (target) targetType = target.kind || 'scene';
    }
  }
  if (!target) return null;
  var category = categories.find(function (cat) { return Story.Scene.Entity.affordance(target, cat); }) || categories[0];
  var actionLabel = {
    investigate: '调查',
    observe: '探看',
    social: '接触',
    negotiate: '谈判',
    travel: '前往',
    battle: '迎战',
    cultivate: '参悟',
    use_relic: '御使',
    deceive: '试探',
    flee: '脱身',
  }[category] || '推进';
  var idx = state.story.chapterIndex + 1;
  var targetName = target.name || target.id;
  return {
    id: 'ch_' + String(idx).padStart(4, '0') + '_' + actor.id + '_arc_' + beat.beatId,
    actorId: actor.id,
    label: actionLabel + targetName,
    hint: '顺着当前卷纲节拍推进：' + (beat.dramaticGoal || beat.title || '主线因果'),
    intentCategory: category,
    approach: 'arc',
    targetType: targetType,
    targetId: target.id,
    riskLevel: 2,
    expectedBenefits: [],
    expectedCosts: [],
    tags: ['arc', 'director', category],
    sourceSceneId: scene.sceneId,
    primaryThreadId: targetType === 'thread' ? target.id : Story.ChoiceFactory._threadForEntity(state, target),
    directorRole: 'arc',
  };
};

// V3.3.1：实体行为生成器 —— 每种实体负责生成自己的合法行为
// ChoiceFactory 不再硬编码"客栈/密信/残剑/掌柜"，而是从当前场景实体中派生
Story.ChoiceFactory._ENTITY_BUILDERS = {
  npc: function (ent, actor, state, scene, mk) {
    var name = ent.name; var id = ent.id; var acts = [];
    var threadId = Story.ChoiceFactory._threadForEntity(state, ent);
    if (Story.Scene.Entity.affordance(ent, 'social'))   acts.push(mk('social',    'pressure', 'npc', id, '逼问' + name + '。', '可能换取情报，但关系恶化。', ['social', 'secret'], 2, threadId, '片刻'));
    if (Story.Scene.Entity.affordance(ent, 'negotiate')) acts.push(mk('negotiate', 'ally',     'npc', id, '与' + name + '谈条件。', '可能达成交换，留下承诺。', ['negotiate', 'pact'], 2, threadId, '片刻'));
    if (Story.Scene.Entity.affordance(ent, 'observe'))   acts.push(mk('observe',   'covert',   'npc', id, '留意' + name + '的举动。', '观察中获取细节。', ['observe', 'info'], 1, null, '片刻'));
    return acts;
  },
  clue: function (ent, actor, state, scene, mk) {
    var name = ent.name; var id = ent.id; var acts = [];
    var threadId = Story.ChoiceFactory._threadForEntity(state, ent);
    if (Story.Scene.Entity.affordance(ent, 'investigate')) acts.push(mk('investigate', 'pursue', 'clue', id, '调查' + name + '。', '可能推进线索，但会暴露意图。', ['investigate', 'clue'], 2, threadId, '数日'));
    if (Story.Scene.Entity.affordance(ent, 'observe'))     acts.push(mk('observe',     'covert', 'clue', id, '小心探查' + name + '。', '获得细节，少量时间。', ['observe', 'info'], 1, threadId, '片刻'));
    return acts;
  },
  relic: function (ent, actor, state, scene, mk) {
    var name = ent.name; var id = ent.id; var acts = [];
    var threadId = Story.ChoiceFactory._threadForEntity(state, ent);
    if (Story.Scene.Entity.affordance(ent, 'use_relic'))   acts.push(mk('use_relic',  'insight', 'relic', id, '以' + name + '为媒，触动灵性。', '推进遗物线索，但法宝有灵。', ['use_relic', 'fate'], 2, threadId, '片刻'));
    if (Story.Scene.Entity.affordance(ent, 'investigate')) acts.push(mk('investigate', 'pursue', 'relic', id, '研究' + name + '的来历。', '可能揭示遗物秘密。', ['investigate', 'clue'], 2, threadId, '数日'));
    return acts;
  },
  exit: function (ent, actor, state, scene, mk) {
    var name = ent.name; var id = ent.id; var acts = [];
    var threadId = Story.ChoiceFactory._threadForEntity(state, ent);
    if (Story.Scene.Entity.affordance(ent, 'travel')) acts.push(mk('travel', 'pursue', 'exit', id, '前往' + name + '。', '地点改变，路途有风险。', ['travel', 'risk'], 3, threadId, '数日'));
    if (Story.Scene.Entity.affordance(ent, 'flee') && (scene.pressure || 0) >= 2)
      acts.push(mk('flee', 'evade', 'exit', id, '从' + name + '撤离。', '暂脱危险，但追兵不散。', ['flee', 'risk'], 3, threadId, '片刻'));
    return acts;
  },
  prop: function (ent, actor, state, scene, mk) {
    var name = ent.name; var id = ent.id; var acts = [];
    if (Story.Scene.Entity.affordance(ent, 'observe')) acts.push(mk('observe', 'covert', 'prop', id, '观察' + name + '。', '获得细节，少量时间。', ['observe', 'info'], 1, Story.ChoiceFactory._threadForEntity(state, ent), '片刻'));
    return acts;
  },
};

Story.ChoiceFactory._candidatePool = function (state, actor, scene, envelope) {
  const idx = state.story.chapterIndex + 1;
  const sid = scene.sceneId;
  // V3.3 Phase 3：归一化为 SceneEntity（字符串/对象双兼容）
  const visible = Story.Scene.Entity.normalize(scene.visibleEntities);
  const exits = Story.Scene.Entity.normalize(scene.exits);
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

  // V3.3.1：离队角色拥有受限行动空间，不从主场景候选池生成
  if (actor.presence === 'away') {
    return Story.ChoiceFactory._awayPool(state, actor, scene, mk);
  }

  // 1. 从场景实体生成行为（核心：实体驱动，不硬编码）
  visible.forEach(function (ent) {
    var builder = Story.ChoiceFactory._ENTITY_BUILDERS[ent.kind];
    if (builder) {
      pool.push.apply(pool, builder(ent, actor, state, scene, mk));
    }
  });
  // 出口实体也生成行为（travel/flee）
  exits.forEach(function (ent) {
    var builder = Story.ChoiceFactory._ENTITY_BUILDERS[ent.kind];
    if (builder) {
      pool.push.apply(pool, builder(ent, actor, state, scene, mk));
    }
  });

  // 2. 通用行动（rest / cultivate），与场景无关
  var sceneName = (scene && scene.locationName) || '此处';
  pool.push(mk('rest', 'recover', 'self', 'self',
    '在' + sceneName + '休养片刻。', '恢复伤势，但可能错过机会。', ['rest', 'recovery'], 1, null, '片刻'));
  if ((scene.pressure || 0) <= 2) {
    pool.push(mk('cultivate', 'insight', 'self', 'self',
      '就地静修，参悟心法。', '修为精进，但错过短期事件。', ['cultivate', 'time'], 2, null, '数月'));
  }

  return pool;
};

// V3.3.1：离队角色受限行动空间
Story.ChoiceFactory._awayPool = function (state, actor, scene, mk) {
  var pool = [];
  var homeLoc = (scene && scene.locationName) || '同行之处';
  // 1. 归队（始终可用）
  pool.push(mk('travel', 'rejoin', 'exit', 'rejoin_party',
    '返回' + homeLoc + '，与同行者会合。', '离队者归队，重新加入共同场景。', ['travel', 'rejoin'], 2, null, '片刻'));
  // 2. 推进离队计划（基于离队时的目标地点）
  var locName = actor.locationId || '前方';
  var primaryThreadId = Story.Director.getPrimaryThreadId(state);
  if (locName === 'road_broken_flow') {
    pool.push(mk('travel', 'pursue', 'exit', 'offscreen_pursue',
      '沿古道继续追踪车辙。', '独行追迹，风险自负。', ['travel', 'risk'], 3, primaryThreadId, '数日'));
    pool.push(mk('investigate', 'pursue', 'clue', 'offscreen_clue',
      '在古道岔路设伏，等待目标折返。', '可能截获线索，但耗时。', ['investigate', 'clue'], 3, primaryThreadId, '数日'));
  } else {
    pool.push(mk('investigate', 'pursue', 'clue', 'offscreen_clue',
      '在' + locName + '搜寻线索。', '独行探索，风险自负。', ['investigate', 'clue'], 3, null, '数日'));
  }
  // 3. 传回痕迹（让同行者知道自己的状态）
  pool.push(mk('observe', 'covert', 'clue', 'offscreen_trace',
    '在岔路口留下标记，通知同行者自己的去向。', '留下线索，方便会合。', ['observe', 'info'], 1, null, '片刻'));
  // 4. 离队风险遭遇
  pool.push(mk('flee', 'evade', 'exit', 'offscreen_evade',
    '察觉异动，躲入隐蔽处。', '避开潜在危险，但浪费时机。', ['flee', 'risk'], 3, null, '片刻'));
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
  // V3.3.1：不直接改写 actor.agentArc，改为写入 _pendingAgentArcDeltas，
  // 由 _commitPendingResolution 统一应用（AI 失败时不提交）
  const fp = Story.ChoiceFactory.fingerprint(picked);
  state.story._pendingAgentArcDeltas = state.story._pendingAgentArcDeltas || {};
  state.story._pendingAgentArcDeltas[actorId] = {
    fingerprint: fp,
    category: picked.intentCategory,
    chapterIndex: state.story.chapterIndex + 1,
  };
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

  const coverageAnchors = [];
  if (envelope && envelope.actions) {
    const visible = Story.Scene.Entity.normalize(scene && scene.visibleEntities).concat(Story.Scene.Entity.normalize(scene && scene.exits));
    envelope.actions.forEach(function (act) {
      const actor = state.actors.find(function (x) { return x.id === act.actorId; });
      const target = visible.find(function (e) { return e.id === act.targetId; }) ||
        (state.story.activeThreads || []).find(function (t) { return t.threadId === act.targetId; });
      coverageAnchors.push({
        actorId: act.actorId,
        actorName: actor ? actor.name : act.actorId,
        controller: actor ? actor.controller : '',
        category: act.category || act.intentCategory || '',
        rawText: act.rawText || '',
        targetId: act.targetId || '',
        targetName: target ? (target.name || target.title || target.id || target.threadId) : '',
        gains: (act.gains || []).map(function (g) { return g.text || ''; }),
        costs: (act.costs || []).map(function (c) { return c.text || ''; }),
      });
    });
  }

  var directorGuide = Story.Director.buildNarrativeGuide(state) || null;
  var isOpening = !!(envelope && envelope.turnId === 'turn_0000');
  var openingAnchorGroups = { location: [], arc: [], pressure: [] };
  if (isOpening) {
    openingAnchorGroups.location.push((scene && scene.locationName) || '');
    Story.Scene.Entity.normalize(scene && scene.visibleEntities).slice(0, 3).forEach(function (ent) {
      openingAnchorGroups.location.push(ent.name || '');
    });
    if (directorGuide) {
      openingAnchorGroups.arc.push(directorGuide.arcTitle || '', directorGuide.currentBeatTitle || '', directorGuide.dramaticGoal || '');
      (directorGuide.pressureClocks || []).forEach(function (clock) {
        openingAnchorGroups.pressure.push(clock.label || '');
      });
    }
    openingAnchorGroups.pressure.push(
      (scene && scene.immediateConflict) || '',
      (scene && scene.immediateQuestion) || '',
      (scene && scene.deadline && scene.deadline.type) || ''
    );
    (state.story.activeThreads || []).filter(function (t) {
      return t && (t.status === 'active' || t.status === 'dormant');
    }).slice(0, 2).forEach(function (thread) {
      openingAnchorGroups.pressure.push(thread.title || '');
    });
    Object.keys(openingAnchorGroups).forEach(function (key) {
      openingAnchorGroups[key] = openingAnchorGroups[key].filter(Boolean);
    });
  }
  var openingAnchors = [];
  Object.keys(openingAnchorGroups).forEach(function (key) {
    openingAnchorGroups[key].forEach(function (anchor) {
      if (openingAnchors.indexOf(anchor) < 0) openingAnchors.push(anchor);
    });
  });

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
    coverageAnchors: coverageAnchors,
    isOpening: isOpening,
    openingAnchors: openingAnchors,
    openingAnchorGroups: openingAnchorGroups,
    forbiddenLeaks: forbiddenLeaks,
    // V3.3.2：Director 叙事引导——告知 AI 当前卷纲与节拍目标
    director: directorGuide,
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


/** 从 AI 返回组装章节（仅取 title/chapter/dialogues/endingImage，丢弃越权字段） */
Story.Narration.assembleFromAI = function (state, scene, envelope, narration) {
  const parsed = Story.Provider.parseNarrationResponse(narration);
  let title = parsed.title || Story.Narration.buildFallbackTitle(state, scene, envelope);
  let chapter = parsed.chapter || '';
  // V3.3.2 修复：AI 路径信任 AI 文笔，不强制 _stripForbidden（仅离线兜底路径需要）
  const action = (envelope && envelope.actions && envelope.actions[0]) || null;
  const provenance = parsed.plainText ? 'ai-plain' : 'ai-json';
  // V3.3.2 修复：优先用 AI 正文前 80 字作为摘要，而非机械拼接
  var chapterSummary = '';
  if (chapter) {
    chapterSummary = chapter.replace(/\n+/g, ' ').slice(0, 80);
  } else {
    chapterSummary = Story.Narration._summary(state, scene, action, envelope.narrationBeats || []);
  }
  return {
    title: title,
    chapter: chapter,
    chapterSummary: chapterSummary,
    timePassed: (action && action.timePassed) || { value: 1, unit: '片刻' },
    endingImage: parsed.endingImage || '',
    dialogues: Array.isArray(parsed.dialogues) ? parsed.dialogues : [],
    provenance: provenance,
    narrationStatus: 'ok',
  };
};

Story.Narration.validateAgainstDirector = function (narration, directorGuide) {
  if (!directorGuide || !directorGuide.forbiddenReveals || !directorGuide.forbiddenReveals.length) return null;
  var parsed = Story.Provider.parseNarrationResponse(narration);
  var text = String((parsed && parsed.chapter) || '');
  for (var i = 0; i < directorGuide.forbiddenReveals.length; i++) {
    var reveal = String(directorGuide.forbiddenReveals[i] || '').trim();
    if (!reveal) continue;
    if (text.indexOf(reveal) >= 0) {
      return {
        code: 'FORBIDDEN_REVEAL',
        reveal: reveal,
        message: 'AI 提前揭露了当前 Beat 禁止揭露的信息：' + reveal,
        rawPreview: text.slice(0, 240),
      };
    }
  }
  return null;
};

Story.Narration._coverageTokens = function (items) {
  var source = Array.isArray(items) ? items.join(' ') : String(items || '');
  var stop = {
    '行动': true, '结果': true, '可能': true, '成功': true, '失败': true,
    '获得': true, '代价': true, '众人': true, '本回合': true, '推进': true,
    '线索': false,
  };
  return (source.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) || [])
    .map(function (x) { return x.trim(); })
    .filter(function (x, i, arr) { return x && !stop[x] && arr.indexOf(x) === i; })
    .slice(0, 8);
};

Story.Narration._openingTokens = function (items) {
  var stop = ['是否', '当前', '正在', '为何', '一个', '已经', '进入', '开始', '真正', '玩家', '卷纲', '开局'];
  var source = Array.isArray(items) ? items.join(' ') : String(items || '');
  var words = source.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) || [];
  var tokens = [];
  words.forEach(function (word) {
    if (stop.indexOf(word) < 0) tokens.push(word);
    if (/^[\u4e00-\u9fa5]+$/.test(word)) {
      for (var i = 0; i < word.length - 1; i++) {
        var pair = word.slice(i, i + 2);
        if (stop.indexOf(pair) < 0) tokens.push(pair);
      }
    }
  });
  return tokens.filter(function (token, i, arr) { return token && arr.indexOf(token) === i; }).slice(0, 40);
};

Story.Narration.validateCoverage = function (narration, brief) {
  if (!brief) return null;
  var parsed = Story.Provider.parseNarrationResponse(narration);
  var text = String((parsed && parsed.chapter) || '');
  if (brief.isOpening || (brief._envelope && brief._envelope.turnId === 'turn_0000')) {
    var groups = brief.openingAnchorGroups || {};
    var labels = { location: '地点或核心实体', arc: '卷纲或当前节拍', pressure: '冲突、时限或线程' };
    var missingGroups = [];
    ['location', 'arc', 'pressure'].forEach(function (key) {
      var tokens = Story.Narration._openingTokens(groups[key] || []);
      if (tokens.length && !tokens.some(function (token) { return text.indexOf(token) >= 0; })) {
        missingGroups.push(labels[key]);
      }
    });
    if (missingGroups.length) {
      return {
        code: 'MISSING_OPENING_ANCHOR',
        message: 'AI 开局正文没有落实当前卷纲开局锚点：' + missingGroups.join('、'),
        rawPreview: text.slice(0, 240),
      };
    }
  }
  if (!brief.director || !brief.director.beatResult) return null;
  var anchors = (brief.coverageAnchors || []).filter(function (a) { return a && a.controller === 'human'; });
  if (!anchors.length) return null;
  var missing = [];
  anchors.forEach(function (a) {
    var tokens = Story.Narration._coverageTokens([
      a.actorName,
      a.targetName,
      a.rawText,
      a.gains.join(' '),
      a.costs.join(' '),
    ]);
    if (!tokens.length) return;
    var hit = tokens.some(function (tok) { return text.indexOf(tok) >= 0; });
    if (!hit) missing.push(a.actorName || a.actorId);
  });
  if (missing.length) {
    return {
      code: 'MISSING_REQUIRED_BEAT',
      message: 'AI 正文没有覆盖本回合真人行动、目标或关键得失：' + missing.join('、'),
      rawPreview: text.slice(0, 240),
    };
  }
  var result = brief.director.beatResult;
  var resultTokens = {
    advance: ['推进', '发现', '查', '深入', '进展'],
    bend: ['转', '绕', '谈', '另', '偏'],
    stall: ['拖', '缓', '压力', '错过', '未能'],
    shatter: ['碎', '毁', '断', '破裂', '烧'],
  }[result] || [];
  var hasResultTone = resultTokens.some(function (tok) { return text.indexOf(tok) >= 0; });
  if (!hasResultTone && text.length < 180) {
    return {
      code: 'MISSING_REQUIRED_BEAT',
      message: 'AI 正文过短且没有体现 Director beatResult：' + result,
      rawPreview: text.slice(0, 240),
    };
  }
  return null;
};

Story.Narration.failPendingForDirectorViolation = function (state, violation, countRetry) {
  if (!state || !state.story || !state.story.pendingResolution || !violation) return;
  if (countRetry) state.story.pendingResolution.retryCount = (state.story.pendingResolution.retryCount || 0) + 1;
  state.story.pendingResolution.lastNarrationError = {
    code: violation.code || 'FORBIDDEN_REVEAL',
    message: violation.message || 'AI 提前揭露了当前 Beat 禁止揭露的信息',
    rawPreview: violation.rawPreview || '',
  };
  state.api.lastStatus = 'offline';
  state.api.lastErrorCode = violation.code || 'FORBIDDEN_REVEAL';
  state.api.lastErrorMessage = violation.message || '';
  Story.setAIStatus('fallback', {
    code: violation.code || 'FORBIDDEN_REVEAL',
    message: violation.message || 'AI 提前揭露了当前 Beat 禁止揭露的信息',
    error: violation.reveal || '',
  });
  Story._setTurnPhase(state, 'narration_failed');
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
    dialogues: Array.isArray(chapter.dialogues) ? chapter.dialogues : [],
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

Story.Provider.ERROR_CODES = ['NO_API_CONFIG','NO_API_KEY','NETWORK_ERROR','CORS_ERROR','HTTP_401','HTTP_403','HTTP_404','HTTP_429','HTTP_5XX','TIMEOUT','EMPTY_RESPONSE','INVALID_JSON','INVALID_SCHEMA','MODEL_OVERREACH','FORBIDDEN_REVEAL','MISSING_REQUIRED_BEAT','MISSING_OPENING_ANCHOR'];

/** 调用 AI 叙事（兼容旧 ai.provider.narrate）。返回归一化后的 {title,chapter,dialogues,endingImage,_autoFixed} 或 null。 */
Story.Provider.narrate = async function (state, brief) {
  if (!Story.ai.enabled) {
    Story.setAIStatus('disabled', { code: 'disabled', message: 'AI 未启用，本回合裁决已保留，等待重试。' });
    state.api.lastStatus = 'offline'; state.api.lastErrorCode = null;
    return null;
  }
  if (!Story.ai.provider || typeof Story.ai.provider.narrate !== 'function') {
    Story.setAIStatus('fallback', { code: 'NO_API_CONFIG', message: 'AI 已开启，但缺少可用 Provider，本回合裁决已保留，等待重试。' });
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
        Story.setAIStatus('fallback', { code: 'TIMEOUT', message: 'API 请求超时，本回合裁决已保留，等待重试。', lastRequestAt: requestedAt });
        state.api.lastStatus = 'offline'; state.api.lastErrorCode = 'TIMEOUT';
        return null;
      }
      let raw = wrapped || null;
      state.api.lastResponseAt = Date.now();
      if (!raw) {
        if (attempt === 0) { Story.setAIStatus('received', { message: '首次响应为空，自动重试一次。', lastRequestAt: requestedAt }); continue; }
        Story.setAIStatus('fallback', { code: 'EMPTY_RESPONSE', message: 'API 返回空内容，本回合裁决已保留，等待重试。', lastRequestAt: requestedAt });
        state.api.lastStatus = 'offline'; state.api.lastErrorCode = 'EMPTY_RESPONSE';
        return null;
      }
      Story.setAIStatus('received', { message: attempt === 0 ? '已收到 API 响应，正在校验。' : '已收到重试响应，正在校验。', lastRequestAt: requestedAt });
      const parsed = Story.Provider.parseNarrationResponse(raw);
      const errors = Story.Provider.validateNarrationOnly(parsed);
      if (errors.length) {
        if (attempt === 0) { Story.setAIStatus('received', { message: '检测到格式偏差，自动修复格式后重试。', errors: errors, lastRequestAt: requestedAt }); continue; }
        Story.setAIStatus('fallback', { code: 'INVALID_SCHEMA', message: 'AI 返回字段不合规，本回合裁决已保留，等待重试。', errors: errors, lastRequestAt: requestedAt });
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
    Story.setAIStatus('fallback', { code: code, message: 'AI 文本生成失败，本回合裁决已保留，等待重试。' + (e && e.message ? '原因：' + e.message : ''), error: e && e.message, lastRequestAt: requestedAt });
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
  // V3.3.2 修复：传入完整 action 详情与 publicDelta，让 AI 知道本回合"既定事实"
  var env = brief._envelope;
  var chosenActions = (env && env.actions) ? env.actions.map(function (a) {
    var actor = state.actors.find(function (x) { return x.id === a.actorId; });
    var scene = state.story.currentScene || {};
    var visible = Story.Scene.Entity.normalize(scene.visibleEntities).concat(Story.Scene.Entity.normalize(scene.exits));
    var target = visible.find(function (e) { return e.id === a.targetId; }) ||
      (state.story.activeThreads || []).find(function (t) { return t.threadId === a.targetId; });
    return {
      actorId: a.actorId,
      actorName: actor ? actor.name : a.actorId,
      publicAction: a.rawText || Story.Narration._catLabel(a.category),
      privateIntent: a.custom ? (a.custom.text || '') : '',
      category: a.category,
      targetId: a.targetId || '',
      targetName: target ? (target.name || target.title || target.id || target.threadId) : '',
      outcome: a.outcome || 'success',
      outcomeLabel: Story.Narration._outcomeLabel(a.outcome),
      gains: (a.gains || []).map(function (g) { return g.text; }),
      costs: (a.costs || []).map(function (c) { return c.text; }),
      timePassed: a.timePassed || null,
      tags: [a.category],
      isCustom: a.source === 'custom',
    };
  }) : [];

  // 从 publicDelta 提取本回合公开事件供 AI 参考
  var turnEvents = [];
  if (env && env.publicDelta) {
    env.publicDelta.forEach(function (d) {
      if (d.op === 'ADD_EVENT' && d.payload && d.payload.text) {
        turnEvents.push(d.payload.text);
      } else if (d.op === 'UPDATE_THREAD' && d.payload) {
        turnEvents.push('线索推进：' + (d.target && d.target.threadId ? d.target.threadId : '未知') + '（' + (d.payload.op || 'advance') + '）');
      } else if (d.op === 'UPDATE_RELATION' && d.payload && d.payload.publicHint) {
        turnEvents.push(d.payload.publicHint);
      } else if (d.op === 'UPDATE_ACTOR_STATUS' && d.payload) {
        turnEvents.push('状态变化：' + (d.payload.key || '') + (d.payload.delta > 0 ? '+' : '') + d.payload.delta);
      } else if (d.op === 'ADVANCE_TIME' && d.payload) {
        turnEvents.push('时间流逝：' + (d.payload.value || 1) + ' ' + (d.payload.unit || '片刻'));
      }
    });
  }

  // 从 narrationBeats 提取既定事实摘要
  var narrationBeats = (env && env.narrationBeats) || [];

  // 活跃线索/威胁
  var activeThreads = (state.story.activeThreads || []).filter(function (t) {
    return t.status === 'active' || t.status === 'dormant';
  }).map(function (t) {
    return {
      threadId: t.threadId, title: t.title, type: t.type,
      stage: t.stage, maxStage: t.maxStage,
      urgency: t.urgency, status: t.status, summary: t.summary || '',
    };
  });

  // 公开事实与传闻（最近 N 条）
  var publicFacts = (state.world.publicFacts || []).slice(-8);
  var publicRumors = (state.world.publicRumors || []).slice(-8);

  // 编年史（最近 5 条，供 AI 回顾前情）
  var chronicleRecent = (state.story.chronicle || []).slice(-5).map(function (c) { return c.text; });

  // 角色动态关系（而非静态 relationHints）
  var cast = state.actors.map(function (a) {
    var dynRelations = {};
    var relationMap = a.relationships || a.relations || {};
    if (relationMap) {
      Object.keys(relationMap).forEach(function (rid) {
        var r = relationMap[rid];
        var other = state.actors.find(function (x) { return x.id === rid; });
        if (other && (r.trust || r.suspicion || r.debt || r.respect)) {
          dynRelations[other.name] = { trust: r.trust || 0, suspicion: r.suspicion || 0, debt: r.debt || 0, respect: r.respect || 0 };
        }
      });
    }
    return {
      id: a.id, name: a.name,
      publicProfile: a.identity + '·' + a.daoPath,
      currentStatus: a.statusSummary || '',
      publicGoal: a.publicWish || '',
      visibleRelations: Object.keys(dynRelations).length ? dynRelations : (a.relationHints || {}),
    };
  });

  return {
    mode: 'turn',
    brief: brief,
    chosenActions: chosenActions,
    turnEvents: turnEvents,
    narrationBeats: narrationBeats,
    activeThreads: activeThreads,
    world: {
      name: brief.world.name, year: brief.world.year,
      worldBibleSummary: (state.world.worldBible.rules || []).join(''),
      activeWorldHooks: (state.world.activeWorldHooks || []).slice(-12),
      publicFacts: publicFacts, publicRumors: publicRumors,
    },
    cast: cast,
    previousChapter: state.story.currentChapter ? {
      title: state.story.currentChapter.title,
      shortSummary: (state.story.currentChapter.chapterSummary || '').slice(0, 300),
      chapterExcerpt: (state.story.currentChapter.chapter || '').slice(-2000),
      endingImage: state.story.currentChapter.endingImage || '',
    } : null,
    recentSummary: (state.story.recentSummary || '').slice(-600) || null,
    chronicleRecent: chronicleRecent.length ? chronicleRecent : null,
    constraints: {
      proseLength: brief.style.proseLength,
      noContradiction: true,
      noUnjustifiedPowerJump: true,
      forbiddenWithoutTrigger: ['高境界突破', '永久死亡', '飞升', '大势力覆灭', '新国家', '顶级法宝', '改写既有事实'],
      narrationOnly: '只返回 {title, chapter, dialogues, endingImage}。不得返回 choices/statePatch/newFacts/newRumors/newHooks/newRelics/changedRelations/timePassed 等状态字段；状态已由本地裁决确定。chapter 必须严格依据 chosenActions 的 outcome/gains/costs 和 turnEvents 来写，不得忽略既定事实。',
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
  // V3.3.1：plainText 路径允许 title 为空，由 assembleFromAI 本地补标题
  if (!resp.plainText && (typeof resp.title !== 'string' || !resp.title.trim())) errors.push('title 缺失');
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
  if (!Story.ai.enabled) { Story.setAIStatus('disabled', { code: 'disabled', message: 'AI 未启用，本回合裁决已保留，等待重试。' }); return null; }
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
  if (!outcome.ok) { Story.setAIStatus('fallback', { code: outcome.code, message: outcome.code === 'TIMEOUT' ? 'API 请求超时，本回合裁决已保留，等待重试。' : 'API 请求失败，本回合裁决已保留，等待重试。', error: outcome.error, lastRequestAt: requestedAt }); return null; }
  if (!outcome.value) { Story.setAIStatus('fallback', { code: 'EMPTY_RESPONSE', message: 'API 返回空内容，本回合裁决已保留，等待重试。', lastRequestAt: requestedAt }); return null; }
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
      Story.setAIStatus('fallback', { code: 'INVALID_SCHEMA', message: 'AI 返回字段不合规，本回合裁决已保留，等待重试。', errors: errors });
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
Story.getDirectorSnapshot = function (state) { return Story.Director.getSnapshot(state || Story.state); };
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
  const scene = Story.state.story.currentScene;
  return {
    cast: Story.state.actors.map(function (a) {
      return {
        id: a.id, name: a.name, identity: a.identity, daoPath: a.daoPath, status: a.statusSummary,
        publicWish: a.publicWish, relationHints: a.relationHints,
        // V3.3 Phase 4：命盘公开回响 + Phase 2 在场状态
        fateEcho: Story.CharacterGenesis.publicEcho(a.fatePlate),
        presence: a.presence || 'present',
        locationId: a.locationId || null,
      };
    }),
    rumors: Story.state.world.publicRumors.slice(-10),
    chronicle: Story.state.story.chronicle.slice(-15),
    activeHooks: Story.state.world.activeWorldHooks.slice(-12),
    factions: Story.state.world.factions.slice(),
    relics: Story.state.ledger.relics.slice(),
    // V3.3 Phase 3：场景实体/出口（对象化）
    scene: scene ? {
      locationName: scene.locationName,
      entities: Story.Scene.Entity.normalize(scene.visibleEntities),
      exits: Story.Scene.Entity.normalize(scene.exits),
      pressure: scene.pressure,
      deadline: scene.deadline ? Story._clone(scene.deadline) : null,
    } : null,
    // V3.3 Phase 3：资产登记表
    assets: Story.AssetRegistry.all(Story.state).slice(),
  };
};

/** 天机全览（开发者模式：含私密信息）。 */
Story.getOmniscientView = function () {
  if (!Story.state) return null;
  const scene = Story.state.story.currentScene;
  return {
    actors: Story.state.actors.map(function (a) {
      return {
        id: a.id, name: a.name, hiddenFate: a.hiddenFate,
        privateFacts: (a.privateFacts || []).slice(),
        hidden: Story._clone(a.hidden),
        aiChosenLastTurn: Story.state.story.aiChosenLastTurn[a.id],
        // V3.3 Phase 4：完整命盘
        fatePlate: a.fatePlate ? Story._clone(a.fatePlate) : null,
        // V3.3 Phase 2：在场状态
        presence: a.presence || 'present', locationId: a.locationId || null,
      };
    }),
    turnChoices: Story._clone(Story.state.story.turnChoices),
    privateEvents: Story._clone(Story.state.ledger.privateEvents),
    chronicleRumors: (Story.state.ledger.chronicleRumors || []).slice(),
    // V3.3 Phase 3：场景实体 + 资产
    scene: scene ? {
      locationName: scene.locationName, locationId: scene.locationId,
      entities: Story.Scene.Entity.normalize(scene.visibleEntities),
      exits: Story.Scene.Entity.normalize(scene.exits),
    } : null,
    assets: Story.AssetRegistry.all(Story.state).slice(),
  };
};

/* ============================================================
 * §21 V3.1 房间视图 API（供 Room 层按席位过滤）
 * ============================================================ */

/** 公共故事视图（所有席位可见）。 */
Story.getPublicStoryView = function (storyState) {
  if (!storyState) return null;
  const ch = storyState.story.currentChapter;
  const scene = storyState.story.currentScene;
  return {
    chapterId: ch ? ch.chapterId : null,
    chapterIndex: storyState.story.chapterIndex || 0,
    title: ch ? ch.title : '',
    chapter: ch ? ch.chapter : '',
    chapterSummary: ch ? (ch.chapterSummary || '') : '',
    dialogues: ch && Array.isArray(ch.dialogues) ? Story._clone(ch.dialogues) : [],
    endingImage: ch ? (ch.endingImage || '') : '',
    turnPhase: storyState.story.turnPhase || 'collecting',
    year: storyState.world.year,
    worldName: storyState.world.name,
    worldBible: Story._clone(storyState.world.worldBible),
    publicFacts: (storyState.world.publicFacts || []).slice(-8),
    publicRumors: (storyState.world.publicRumors || []).slice(-6),
    chronicleEntries: (storyState.story.chronicle || []).slice(-15),
    factions: (storyState.world.factions || []).slice(),
    relics: (storyState.ledger.relics || []).slice(),
    activeThreads: (storyState.story.activeThreads || []).slice(-8),
    scene: scene ? {
      sceneId: scene.sceneId,
      locationId: scene.locationId,
      locationName: scene.locationName,
      timeOfDay: scene.timeOfDay,
      weather: scene.weather,
      immediateConflict: scene.immediateConflict,
      immediateQuestion: scene.immediateQuestion,
      deadline: scene.deadline ? Story._clone(scene.deadline) : null,
      entities: Story.Scene.Entity.normalize(scene.visibleEntities),
      availableAssets: Story.Scene.Entity.normalize(scene.availableAssets),
      exits: Story.Scene.Entity.normalize(scene.exits),
    } : null,
    assets: Story.AssetRegistry.all(storyState).map(function (asset) {
      return {
        id: asset.id, name: asset.name, kind: asset.kind, locationId: asset.locationId,
        state: asset.state, publicHint: asset.publicHint || '', threadId: asset.threadId || '',
      };
    }),
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
