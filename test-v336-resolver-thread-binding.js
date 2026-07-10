const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}

function makeState(recipeId) {
  const state = Story.createEmptyState('V336-RESOLVER-' + recipeId);
  state.world.worldBible = { rules: ['规则一'], flags: {} };
  state.actors = [{
    id: 'p1', name: '陆知微', identity: '散修', daoPath: '剑修', publicWish: '查明真相',
    hiddenFate: '旧约', controller: 'human', personalityTags: [], presence: 'present', locationId: 'inn_redsand',
    hidden: { injury: 0, cultivationProgress: 0, resources: [], combatStats: {} },
  }];
  const recipe = Story.Director.getRecipe(state, recipeId);
  state.story.director.candidates = [{ arcId: 'arc_' + recipeId, recipeId: recipeId, family: recipe.family, title: recipe.title, publicPitch: recipe.publicPitch, tags: recipe.tags || [] }];
  state.story.director.phase = 'voting';
  const arc = Story.Director.activateArc(state, 'arc_' + recipeId);
  state.story.currentScene = Story.Scene.createOpeningScene(state);
  state.story.activeThreads = Story.Scene.createOpeningThreads(state);
  Story.Director.applyArcOpeningScenePatch(state, arc);
  Story.Director.applyOpeningSeed(state, arc);
  return state;
}

function intent(state, category, targetId, targetType) {
  return {
    actorId: 'p1', category: category, targetId: targetId, targetType: targetType || 'clue',
    rawText: '执行当前卷纲行动', source: 'custom', derivedTags: [], timePreference: '片刻',
  };
}

console.log('\n=== test-v336-resolver-thread-binding ===');
const sealed = makeState('sealed_realm');
const inv = Story.Resolver.resolveActorAction(sealed, sealed.story.currentScene, intent(sealed, 'investigate', 'ent_realm_crack'));
ok('秘境调查推进 thread_sealed_realm', inv.threadEffects.some(function (e) { return e.threadId === 'thread_sealed_realm'; }), JSON.stringify(inv.threadEffects));
ok('秘境调查不推进 thread_trade_letter', !inv.threadEffects.some(function (e) { return e.threadId === 'thread_trade_letter'; }));

const dynasty = makeState('dynasty_pursuit');
const rest = Story.Resolver.resolveActorAction(dynasty, dynasty.story.currentScene, intent(dynasty, 'rest', 'self', 'self'));
ok('皇朝追捕休息推进当前主线程', rest.threadEffects.some(function (e) { return e.threadId === 'thread_dynasty_warrant'; }), JSON.stringify(rest.threadEffects));
ok('皇朝追捕休息不推进 thread_trade_letter', !rest.threadEffects.some(function (e) { return e.threadId === 'thread_trade_letter'; }));

const vein = makeState('spirit_vein_race');
const veinInv = Story.Resolver.resolveActorAction(vein, vein.story.currentScene, intent(vein, 'investigate', 'ent_vein_survey_map'));
ok('灵脉调查收益不含密信', veinInv.gains.every(function (g) { return String(g.text).indexOf('密信') < 0; }), JSON.stringify(veinInv.gains));
ok('threadForTarget 读取实体 threadId', Story.Scene.threadForTarget(vein, vein.story.currentScene, 'ent_vein_survey_map') === 'thread_spirit_vein');

console.log('Resolver thread binding passed ' + pass + ' / failed ' + fail);
if (fail) process.exit(1);
