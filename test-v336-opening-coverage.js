const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}

function makeOpening(recipeId) {
  const state = Story.createEmptyState('V336-OPEN-' + recipeId);
  state.world.name = '验收界';
  state.world.worldBible = { rules: ['规则一'], heavenlyLaw: '因果', storyGravity: '秘境', flags: {} };
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
  const envelope = Story.Resolver.buildOpeningEnvelope(state);
  return { state: state, brief: Story.Narration.buildBrief(state, state.story.currentScene, envelope) };
}

console.log('\n=== test-v336-opening-coverage ===');
const sealed = makeOpening('sealed_realm');
ok('开局 brief 标记 isOpening', sealed.brief.isOpening === true);
ok('开局 brief 含 openingAnchors', sealed.brief.openingAnchors.length >= 6);
const generic = Story.Narration.validateCoverage({ title: '夜行', chapter: '众人沉默地继续前行，夜色里风声渐紧，却无人知道下一步该去往何方。' }, sealed.brief);
ok('泛化秘境开局被拒绝', generic && generic.code === 'MISSING_OPENING_ANCHOR', JSON.stringify(generic));
const sealedGood = Story.Narration.validateCoverage({ title: '裂隙', chapter: '旧祠秘境裂隙前，残缺钥印骤然发烫。众人循着封印衰减的灵光探查秘境封印，必须赶在门槛彻底崩落前作出决定。' }, sealed.brief);
ok('落实秘境锚点的开局通过', sealedGood === null, JSON.stringify(sealedGood));

const dynasty = makeOpening('dynasty_pursuit');
const dynastyBad = Story.Narration.validateCoverage({ title: '夜行', chapter: '众人沿着长街继续前行，雨声遮住了脚步，也遮住了所有尚未说出口的打算。' }, dynasty.brief);
ok('泛化皇朝开局被拒绝', dynastyBad && dynastyBad.code === 'MISSING_OPENING_ANCHOR');
const dynastyGood = Story.Narration.validateCoverage({ title: '封城', chapter: '赤砂城门的铁索落下，缉仙榜文贴在封榜处。缉仙司校尉催动封城时限，皇朝追捕已从榜文封城这一节拍真正开始。' }, dynasty.brief);
ok('落实皇朝锚点的开局通过', dynastyGood === null, JSON.stringify(dynastyGood));
ok('Provider 注册 MISSING_OPENING_ANCHOR', Story.Provider.ERROR_CODES.indexOf('MISSING_OPENING_ANCHOR') >= 0);

console.log('Opening coverage passed ' + pass + ' / failed ' + fail);
if (fail) process.exit(1);
