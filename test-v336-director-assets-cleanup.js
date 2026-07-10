const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}

function actor() {
  return {
    id: 'p1', seatId: 'seat_0', name: '陆知微', identity: '散修', daoPath: '剑修',
    publicWish: '查明真相', hiddenFate: '旧约', controller: 'human', personalityTags: [],
    hidden: { injury: 0, cultivationProgress: 0, resources: [], combatStats: {} },
    presence: 'present', locationId: 'inn_redsand',
  };
}

function candidate(recipeId, recipe) {
  return {
    arcId: 'arc_' + recipeId, recipeId: recipeId, family: recipe.family,
    title: recipe.title, publicPitch: recipe.publicPitch, tags: (recipe.tags || []).slice(),
  };
}

function openArc(recipeId) {
  const state = Story.createEmptyState('V336-ASSET-' + recipeId);
  state.world.name = '验收界';
  state.world.worldBible = { rules: ['规则一'], heavenlyLaw: '因果', storyGravity: '秘境', flags: {} };
  state.actors = [actor()];
  state.story.currentScene = Story.Scene.createOpeningScene(state);
  state.story.activeThreads = Story.Scene.createOpeningThreads(state);
  const recipe = Story.Director.getRecipe(state, recipeId);
  state.story.director.candidates = [candidate(recipeId, recipe)];
  state.story.director.phase = 'voting';
  const arc = Story.Director.activateArc(state, 'arc_' + recipeId);
  Story.Director.applyArcOpeningScenePatch(state, arc);
  Story.Director.applyOpeningSeed(state, arc);
  Story.Director.applyArcAssets(state, arc);
  return state;
}

console.log('\n=== test-v336-director-assets-cleanup ===');
const trade = openArc('trade_contract');
const relic = openArc('relic_identity');
const sealed = openArc('sealed_realm');
const dynasty = openArc('dynasty_pursuit');

ok('trade_contract 保留 trade_letter', !!Story.AssetRegistry.get(trade, 'trade_letter'));
ok('relic_identity 保留 residual_sword', !!Story.AssetRegistry.get(relic, 'residual_sword'));
ok('sealed_realm 清除 trade_letter', !Story.AssetRegistry.get(sealed, 'trade_letter'));
ok('sealed_realm 清除 residual_sword', !Story.AssetRegistry.get(sealed, 'residual_sword'));
ok('sealed_realm 注册 realm_key_shard', !!Story.AssetRegistry.get(sealed, 'realm_key_shard'));
ok('dynasty_pursuit 不含商会默认资产', !Story.AssetRegistry.get(dynasty, 'trade_letter'));
ok('卷纲资产标记 sourceArcId', sealed.assets.every(function (a) { return a.sourceArcId === 'arc_sealed_realm'; }));

const dynamicState = Story.createEmptyState('V336-DYNAMIC');
dynamicState.world.worldBible = { rules: ['规则一'], flags: {} };
dynamicState.actors = [actor()];
const dynamic = Story._clone(Story.DirectorRecipes.sealed_realm);
dynamic.id = 'test_arc'; dynamic.title = '测试动态卷纲';
dynamicState.story.director.generatedRecipes.test_arc = dynamic;
dynamicState.story.director.candidates = [candidate('test_arc', dynamic)];
dynamicState.story.director.phase = 'voting';
const dynamicArc = Story.Director.activateArc(dynamicState, 'arc_test_arc');
ok('getRecipe 优先读取 generatedRecipes', Story.Director.getRecipe(dynamicState, 'test_arc') === dynamic);
ok('动态 Recipe 可被 activateArc 使用', dynamicArc.recipeId === 'test_arc' && dynamicArc.beats.length > 0);

console.log('Director assets cleanup passed ' + pass + ' / failed ' + fail);
if (fail) process.exit(1);
