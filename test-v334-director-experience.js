/* test-v334-director-experience.js — V3.3.4 导演体验收口验收
 *
 * 覆盖：
 *   1. 选中的卷纲会真正改写开局场景，而不是只追加线索。
 *   2. Director.evaluate 聚合多名真人行动，能识别方向冲突与打碎主线。
 *   3. 压力时钟满格后会产生真实场景/Beat 后果。
 *   4. AI 叙事校验会检查真人行动覆盖，而不只检查禁泄露。
 *   5. Provider 上下文读取 actor.relationships，不再只读旧字段 relations。
 */
const Story = require('./story-core.js');
const helpers = require('./test-helpers.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}

function actor(id, name, controller) {
  return {
    id: id,
    name: name,
    identity: controller === 'human' ? 'player' : 'bot',
    daoPath: 'sword',
    publicWish: 'find truth',
    hiddenFate: 'old debt',
    controller: controller,
    personalityTags: ['careful'],
    hidden: { injury: 0, cultivationProgress: 0, spirit: 10 },
    presence: 'present',
    locationId: 'inn_redsand',
  };
}

function candidateFor(recipeId) {
  var r = Story.DirectorRecipes[recipeId];
  return {
    arcId: 'arc_' + recipeId,
    recipeId: recipeId,
    family: r.family,
    title: r.title,
    publicPitch: r.publicPitch,
    tags: (r.tags || []).slice(),
    openingHooks: [],
    voteScore: 0,
    voteBreakdown: {},
  };
}

function makeBaseState(seed) {
  var state = Story.createEmptyState(seed || 'V334');
  state.world.name = 'Test Realm';
  state.world.year = 1;
  state.world.worldBible = {
    rules: ['law-one', 'law-two', 'law-three', 'law-four'],
    heavenlyLaw: 'contract law',
    storyGravity: 'intrigue',
    startLocation: 'inn_redsand',
  };
  state.actors.push(actor('p1', 'Alice', 'human'));
  state.actors.push(actor('p2', 'Borin', 'human'));
  state.actors.push(actor('bot1', 'Cyan', 'bot'));
  state.story.currentScene = {
    sceneId: 'scene_test',
    locationId: 'inn_redsand',
    locationName: 'Test Inn',
    visibleEntities: [
      { id: 'ent_trade_letter', name: 'trade-letter', kind: 'clue', affordances: ['investigate', 'observe'] },
      { id: 'ent_innkeeper', name: 'innkeeper', kind: 'npc', affordances: ['social', 'negotiate'] },
      { id: 'ent_trade_caravan', name: 'trade-caravan', kind: 'npc', affordances: ['social', 'travel'] },
    ],
    exits: [
      { id: 'exit_locked_gate', name: 'city-gate', kind: 'exit', affordances: ['travel', 'flee'] },
    ],
    focalActorIds: ['p1', 'p2', 'bot1'],
    recentEvents: [],
    pressure: 0,
  };
  return state;
}

function activateRecipe(state, recipeId) {
  state.story.director.candidates = [
    candidateFor(recipeId),
    candidateFor(recipeId === 'trade_contract' ? 'tower_expedition' : 'trade_contract'),
    candidateFor(recipeId === 'sealed_realm' ? 'dynasty_pursuit' : 'sealed_realm'),
  ];
  state.story.director.phase = 'voting';
  return Story.Director.activateArc(state, 'arc_' + recipeId);
}

async function testOpeningScenePatch() {
  helpers.setupMockAI(Story);
  var actors = [
    { id: 'p1', name: 'Alice', identity: 'player', daoPath: 'sword', publicWish: 'find tower', hiddenFate: 'old key', controller: 'human' },
    { id: 'bot1', name: 'Cyan', identity: 'bot', daoPath: 'array', publicWish: 'draw map', hiddenFate: 'lost map', controller: 'bot' },
  ];

  var tower = await Story.createSession({ seed: 'V334-TOWER', actors: actors, skipOpening: true });
  tower.story.director.candidates = [candidateFor('tower_expedition'), candidateFor('trade_contract'), candidateFor('sealed_realm')];
  tower.story.director.phase = 'voting';
  await Story.Director.finalizeSessionWithArc(tower, 'arc_tower_expedition');

  var sceneIds = (tower.story.currentScene.visibleEntities || []).map(function (e) { return e.id; });
  var threadIds = (tower.story.activeThreads || []).map(function (t) { return t.threadId; });
  ok('tower arc rewrites opening location', tower.story.currentScene.locationId === 'tower_shadow_station',
    'locationId=' + tower.story.currentScene.locationId);
  ok('tower opening contains tower map', sceneIds.indexOf('ent_tower_map') >= 0, 'entities=' + sceneIds.join(','));
  ok('tower opening removes default trade letter', sceneIds.indexOf('ent_trade_letter') < 0, 'entities=' + sceneIds.join(','));
  ok('tower opening activates tower thread', threadIds.indexOf('thread_tower_expedition') >= 0, 'threads=' + threadIds.join(','));

  var dynasty = await Story.createSession({ seed: 'V334-DYNASTY', actors: actors, skipOpening: true });
  dynasty.story.director.candidates = [candidateFor('dynasty_pursuit'), candidateFor('trade_contract'), candidateFor('sealed_realm')];
  dynasty.story.director.phase = 'voting';
  await Story.Director.finalizeSessionWithArc(dynasty, 'arc_dynasty_pursuit');
  ok('different arc gets different opening location',
    dynasty.story.currentScene.locationId !== tower.story.currentScene.locationId,
    'tower=' + tower.story.currentScene.locationId + ' dynasty=' + dynasty.story.currentScene.locationId);

  var trade = await Story.createSession({ seed: 'V334-TRADE', actors: actors, skipOpening: true });
  trade.story.director.candidates = [candidateFor('trade_contract'), candidateFor('tower_expedition'), candidateFor('sealed_realm')];
  trade.story.director.phase = 'voting';
  await Story.Director.finalizeSessionWithArc(trade, 'arc_trade_contract');
  var tradeEntityIds = (trade.story.currentScene.visibleEntities || []).map(function (e) { return e.id; });
  ok('trade opening exposes caravan entity for clock consequences',
    tradeEntityIds.indexOf('ent_trade_caravan') >= 0,
    'entities=' + tradeEntityIds.join(','));
}

function testMultiActionAggregation() {
  var state1 = makeBaseState('V334-MULTI-SHATTER');
  var arc1 = activateRecipe(state1, 'trade_contract');
  var shatterText = arc1.beats[0].shatterKeywords[0] || 'destroy the letter';
  var plan1 = Story.Director.evaluate(state1, {
    actions: [
      { actorId: 'p1', category: 'investigate', targetId: 'ent_trade_letter', rawText: 'Alice investigates the letter' },
      { actorId: 'p2', category: 'freeform', targetId: 'ent_trade_letter', rawText: shatterText },
    ],
  });
  ok('multi-human shatter wins over first action', plan1 && plan1.result === 'shatter', 'got=' + (plan1 && plan1.result));
  ok('multi-human direction conflict is recorded',
    plan1 && plan1.directorScore && plan1.directorScore.conflicts.some(function (c) { return c.type === 'playerConflict'; }));

  var state2 = makeBaseState('V334-MULTI-BEND');
  activateRecipe(state2, 'trade_contract');
  var plan2 = Story.Director.evaluate(state2, {
    actions: [
      { actorId: 'p1', category: 'investigate', targetId: 'ent_trade_letter', rawText: 'Alice investigates the letter' },
      { actorId: 'p2', category: 'social', targetId: 'ent_innkeeper', rawText: 'Borin questions the innkeeper' },
    ],
  });
  ok('advance + bend from different humans resolves as bend', plan2 && plan2.result === 'bend', 'got=' + (plan2 && plan2.result));
  ok('advance/bend conflict is visible in directorScore',
    plan2 && plan2.directorScore && plan2.directorScore.conflicts.some(function (c) {
      return c.directions && c.directions.advance && c.directions.bend;
    }));
}

function testClockConsequences() {
  var state = makeBaseState('V334-CLOCK');
  var arc = activateRecipe(state, 'trade_contract');
  var clock = arc.pressureClocks.find(function (c) { return c.clockId === 'clock_caravan_departure'; });
  clock.current = clock.max - 1;
  var plan = Story.Director.evaluate(state, {
    actions: [
      { actorId: 'p1', category: 'rest', rawText: 'Alice rests and lets time pass' },
    ],
  });
  Story.Director.applyPlan(state, plan);
  var scene = state.story.currentScene;
  var activeBeat = arc.beats[arc.currentBeatIndex];
  var entityIds = (scene.visibleEntities || []).map(function (e) { return e.id; });
  var exitIds = (scene.exits || []).map(function (e) { return e.id; });
  var lastLog = arc.divergenceLog[arc.divergenceLog.length - 1];

  ok('clock reaches full', clock.current === clock.max, 'clock=' + clock.current + '/' + clock.max);
  ok('clock full diverts current beat', activeBeat && activeBeat.beatId.indexOf('_diverted_' + clock.clockId) >= 0,
    'beat=' + (activeBeat && activeBeat.beatId));
  ok('caravan leaves visible scene', entityIds.indexOf('ent_trade_caravan') < 0, 'entities=' + entityIds.join(','));
  ok('caravan trail exit is added', exitIds.indexOf('exit_caravan_trail') >= 0, 'exits=' + exitIds.join(','));
  ok('clock event is logged',
    lastLog && lastLog.clockEvents && lastLog.clockEvents.some(function (e) { return e.op === 'DIVERT_BEAT'; }));
}

function testCoverageValidation() {
  var brief = {
    director: { beatResult: 'advance' },
    coverageAnchors: [{
      actorId: 'p1',
      actorName: 'Alice',
      controller: 'human',
      category: 'investigate',
      rawText: 'investigate trade-letter secret',
      targetId: 'ent_trade_letter',
      targetName: 'trade-letter',
      gains: ['ledger-clue'],
      costs: [],
    }],
  };
  var bad = {
    title: 'Bad',
    chapter: 'Rain falls. Everyone waits. The street is quiet. Nothing specific happens. '.repeat(3),
  };
  var good = {
    title: 'Good',
    chapter: 'Alice investigates the trade-letter and notices the ledger-clue hidden inside the fold. '.repeat(3),
  };
  var violation = Story.Narration.validateCoverage(bad, brief);
  ok('coverage validator rejects generic narration',
    violation && violation.code === 'MISSING_REQUIRED_BEAT',
    'code=' + (violation && violation.code));
  ok('coverage validator accepts narration mentioning action anchors',
    Story.Narration.validateCoverage(good, brief) === null);
}

function testRelationshipsInProviderContext() {
  var state = makeBaseState('V334-REL');
  state.actors[0].relationships = {
    p2: { trust: 3, suspicion: 1, debt: 0, respect: 2 },
  };
  var brief = Story.Narration.buildBrief(state, state.story.currentScene, { actions: [] });
  var ctx = Story.Provider._briefToCtx(state, brief);
  var alice = ctx.cast.find(function (c) { return c.id === 'p1'; });
  var rel = alice && alice.visibleRelations && alice.visibleRelations.Borin;
  ok('Provider ctx reads actor.relationships',
    rel && rel.trust === 3 && rel.suspicion === 1 && rel.respect === 2,
    JSON.stringify(rel));
}

async function main() {
  console.log('\n=== test-v334-director-experience ===');
  await testOpeningScenePatch();
  testMultiActionAggregation();
  testClockConsequences();
  testCoverageValidation();
  testRelationshipsInProviderContext();

  console.log('\n' + '  Director V3.3.4 experience tests passed ' + pass + ' / failed ' + fail);
  if (fail) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
