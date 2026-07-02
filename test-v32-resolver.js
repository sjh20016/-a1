/* test-v32-resolver.js — V3.2 TurnResolver 行为测试
 * 验证：回合推进、离线章节生成、provenance、章节长度、禁用词、可复现性、Resolver API。
 */
const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// PRESET_COMPANIONS 被 startGame 浅拷贝，其 agentArc 在 resolveTurn 中被 Agent.chooseAction
// 原地修改（lastChoiceFingerprints / lastChoiceCategories），会跨 run 互相污染。
// 为得到「同种子同选择 → 同章节」的确定性回放，每次 startGame 前重置同伴 agentArc。
var _origArcs = Story.PRESET_COMPANIONS.map(function (c) { return JSON.parse(JSON.stringify(c.agentArc || {})); });
function resetCompanionArcs() {
  Story.PRESET_COMPANIONS.forEach(function (c, i) { c.agentArc = JSON.parse(JSON.stringify(_origArcs[i])); });
}

var SETUP = {
  name: '陆知微', daoPath: '剑修',
  publicWish: '寻找失落剑经', hiddenFate: '残剑记得一个不存在的人名',
  personalityTags: ['谨慎', '执念']
};

async function runOnce(seed) {
  resetCompanionArcs();
  var state = await Story.startGame(seed, SETUP);
  var openingIndex = state.story.chapterIndex;
  var choices = Story.getChoicesForActor(state, 'lu');
  // 优先选休息；若无休息（如 RES-TEST），选首个选项
  var picked = choices.find(function (c) { return c.intentCategory === 'rest'; }) || choices[0];
  await Story.resolveTurn(state, { lu: { choiceId: picked.id } });
  return { state: state, picked: picked, openingIndex: openingIndex };
}

async function main() {
  // ---------- 1. 结构性检查 ----------
  var run = await runOnce('RES-TEST');
  var state = run.state;
  var s = state.story;

  ok('开局后 chapterIndex = 1', run.openingIndex === 1, 'got ' + run.openingIndex);
  ok('回合推进：chapterIndex 增加', s.chapterIndex === run.openingIndex + 1, 'got ' + s.chapterIndex + ' before ' + run.openingIndex);
  ok('生成了 currentChapter', !!s.currentChapter);
  ok('provenance = offline-resolved', s.currentChapter && s.currentChapter.provenance === 'offline-resolved',
    'got ' + (s.currentChapter && s.currentChapter.provenance));
  var chLen = String((s.currentChapter && s.currentChapter.chapter) || '').replace(/\s/g, '').length;
  ok('离线章节正文 180-400 字符', chLen >= 180 && chLen <= 400, 'got ' + chLen);

  // publicEvents 不得含「战斗」「交锋」
  var pubText = (state.ledger.publicEvents || []).join(' ');
  ok('publicEvents 不含「战斗」', pubText.indexOf('战斗') < 0);
  ok('publicEvents 不含「交锋」', pubText.indexOf('交锋') < 0);

  // ---------- 2. Resolver API 面 ----------
  ok('Story.Resolver.OUTCOMES 是数组', Array.isArray(Story.Resolver.OUTCOMES));
  ok('OUTCOMES 非空', Story.Resolver.OUTCOMES.length > 0, 'len=' + Story.Resolver.OUTCOMES.length);
  var env = Story.Resolver.buildOpeningEnvelope(state);
  ok('buildOpeningEnvelope 返回对象', !!env && typeof env === 'object');
  ok('buildOpeningEnvelope.actions 是数组', !!env && Array.isArray(env.actions));
  ok('buildOpeningEnvelope 有 provenance', !!env && typeof env.provenance === 'string');

  // ---------- 3. 可复现性：同种子 + 同选择 → 同章节哈希 ----------
  var a = await runOnce('RES-TEST');
  var b = await runOnce('RES-TEST');
  var ha = Story.hashSeed((a.state.story.currentChapter && a.state.story.currentChapter.chapter) || '');
  var hb = Story.hashSeed((b.state.story.currentChapter && b.state.story.currentChapter.chapter) || '');
  ok('同种子同选择：章节哈希一致', ha === hb, ha + ' vs ' + hb);
  ok('同种子同选择：标题一致',
    a.state.story.currentChapter.title === b.state.story.currentChapter.title,
    '"' + (a.state.story.currentChapter.title) + '" vs "' + (b.state.story.currentChapter.title) + '"');
  ok('同种子同选择：chapterIndex 一致',
    a.state.story.chapterIndex === b.state.story.chapterIndex);

  console.log('\nV3.2 Resolver 测试通过 ' + pass + ' / 失败 ' + fail);
  if (fail > 0) process.exitCode = 1;
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
