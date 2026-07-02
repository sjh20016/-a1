/* test-v32-intent.js — V3.2 IntentParser 行为测试
 * 验证玩家自然语言输入被正确分类为意图（休息不被误判为调查/战斗/旅行）。
 */
const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function hasAll(arr, required) { return required.every(function (r) { return (arr || []).indexOf(r) >= 0; }); }
function hasNone(arr, forbidden) { return forbidden.every(function (f) { return (arr || []).indexOf(f) < 0; }); }

async function main() {
  // 构建最小可用状态：空状态 + 手动添加人类角色 + 激活
  const state = Story.createEmptyState();
  state.actors.push({
    id: 'lu', name: '陆知微', controller: 'human', seatId: 'seat_0',
    personalityTags: ['谨慎'], daoPath: '剑修'
  });
  Story._activateState(state);

  // ---------- 1. Story.Intent._classify 直接测试 ----------
  var classifyCases = [
    { text: '继续睡觉',             expect: 'rest' },
    { text: '还是睡觉',             expect: 'rest' },
    { text: '睁一只眼闭一只眼睡觉', expect: 'rest' },
    { text: '追赶商队',             expectAny: ['travel', 'flee'] },
    { text: '闭关数月',             expect: 'cultivate' },
    { text: '逃离妖兽',             expect: 'flee' }
  ];
  classifyCases.forEach(function (c) {
    var r = Story.Intent._classify(c.text);
    if (c.expect) {
      ok('_classify "' + c.text + '" => ' + c.expect, r.category === c.expect, 'got ' + r.category);
    } else {
      ok('_classify "' + c.text + '" => ' + c.expectAny.join('/'),
        c.expectAny.indexOf(r.category) >= 0, 'got ' + r.category);
    }
  });

  // ---------- 2. Story.Intent.parseCustomText 测试 ----------
  var parseCases = [
    { text: '继续睡觉',             expect: { category: 'rest',           requiredTags: ['rest', 'recovery'], forbiddenTags: ['investigate', 'battle', 'travel'] } },
    { text: '还是睡觉',             expect: { category: 'rest',           requiredTags: ['rest', 'recovery'], forbiddenTags: ['investigate', 'battle', 'travel'] } },
    { text: '睁一只眼闭一只眼睡觉', expect: { category: 'rest',           requiredTags: ['rest', 'recovery'], forbiddenTags: ['investigate', 'battle', 'travel'] } },
    { text: '追赶商队',             expect: { categoryAny: ['travel', 'flee'] } },
    { text: '与掌柜交涉',           expect: { categoryAny: ['social', 'negotiate', 'freeform'] } },
    { text: '闭关数月',             expect: { category: 'cultivate',      requiredTags: ['cultivate'] } },
    { text: '逃离妖兽',             expect: { category: 'flee' } }
  ];
  parseCases.forEach(function (c) {
    var intent = Story.Intent.parseCustomText(state, 'lu', c.text);
    ok('parseCustomText "' + c.text + '" 返回对象', !!intent && typeof intent === 'object');
    if (!intent) return;
    if (c.expect.category) {
      ok('"' + c.text + '" category = ' + c.expect.category, intent.category === c.expect.category, 'got ' + intent.category);
    }
    if (c.expect.categoryAny) {
      ok('"' + c.text + '" category ∈ ' + JSON.stringify(c.expect.categoryAny),
        c.expect.categoryAny.indexOf(intent.category) >= 0, 'got ' + intent.category);
    }
    if (c.expect.requiredTags) {
      ok('"' + c.text + '" 含必要标签 ' + c.expect.requiredTags.join(','),
        hasAll(intent.derivedTags, c.expect.requiredTags), JSON.stringify(intent.derivedTags));
    }
    if (c.expect.forbiddenTags) {
      ok('"' + c.text + '" 不含禁用标签 ' + c.expect.forbiddenTags.join(','),
        hasNone(intent.derivedTags, c.expect.forbiddenTags), JSON.stringify(intent.derivedTags));
    }
    ok('"' + c.text + '" confidence > 0', typeof intent.confidence === 'number' && intent.confidence > 0);
    ok('"' + c.text + '" 有 timePreference', typeof intent.timePreference === 'string' && intent.timePreference.length > 0);
  });

  // ---------- 3. 休息类输入不得被识别为 investigate/battle/travel ----------
  ['继续睡觉', '还是睡觉', '睁一只眼闭一只眼睡觉'].forEach(function (t) {
    var intent = Story.Intent.parseCustomText(state, 'lu', t);
    ok('"' + t + '" 不得识别为 investigate', intent.category !== 'investigate', 'got ' + intent.category);
    ok('"' + t + '" 不得识别为 battle',      intent.category !== 'battle',      'got ' + intent.category);
    ok('"' + t + '" 不得识别为 travel',      intent.category !== 'travel',      'got ' + intent.category);
  });

  console.log('\nV3.2 Intent 测试通过 ' + pass + ' / 失败 ' + fail);
  if (fail > 0) process.exitCode = 1;
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
