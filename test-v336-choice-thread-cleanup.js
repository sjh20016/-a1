const fs = require('fs');
const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}

function makeState(recipeId) {
  const state = Story.createEmptyState('V336-CHOICE-' + recipeId);
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

function assertChoice(recipeId, targetId, expectedThread) {
  const state = makeState(recipeId);
  const choices = Story.ChoiceFactory._candidatePool(state, state.actors[0], state.story.currentScene, null);
  const found = choices.find(function (c) { return c.targetId === targetId; });
  ok(recipeId + ' 目标生成选项', !!found, targetId);
  ok(recipeId + ' 选项绑定正确线程', found && found.primaryThreadId === expectedThread, found && found.primaryThreadId);
}

console.log('\n=== test-v336-choice-thread-cleanup ===');
assertChoice('dynasty_pursuit', 'ent_imperial_arrester', 'thread_dynasty_warrant');
assertChoice('sealed_realm', 'ent_realm_crack', 'thread_sealed_realm');
assertChoice('spirit_vein_race', 'ent_vein_survey_map', 'thread_spirit_vein');

const source = fs.readFileSync(require.resolve('./story-core.js'), 'utf8');
const choiceSource = source.slice(source.indexOf('Story.ChoiceFactory ='), source.indexOf('Story.Narration ='));
ok('ChoiceFactory 不再硬编码 thread_trade_letter', choiceSource.indexOf("'thread_trade_letter'") < 0);

console.log('Choice thread cleanup passed ' + pass + ' / failed ' + fail);
if (fail) process.exit(1);
