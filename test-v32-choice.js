/* test-v32-choice.js — V3.2 ChoiceFactory 行为测试
 * 验证：恰好 3 选项、无 timeHint、有 intentCategory、fingerprint 非空且唯一、
 *       至少 2 种 category、validateChoiceSet 通过。
 */
const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' — ' + detail : '')); }
}

async function main() {
  var state = await Story.startGame('CH-TEST', {
    name: '陆知微', daoPath: '剑修',
    publicWish: '寻找失落剑经', hiddenFate: '残剑记得一个不存在的人名',
    personalityTags: ['谨慎', '执念']
  });
  var choices = Story.getChoicesForActor(state, 'lu');

  ok('选项数组非空', Array.isArray(choices) && choices.length > 0);
  ok('恰好 3 个选项', choices.length === 3, 'got ' + choices.length);

  // V3.2 已移除 timeHint 字段
  var noTimeHint = choices.every(function (c) { return c.timeHint === undefined; });
  ok('所有选项无 timeHint 字段（V3.2 已移除）', noTimeHint,
    JSON.stringify(choices.map(function (c) { return c.timeHint; })));

  // 每项都有 intentCategory
  ok('每项都有 intentCategory', choices.every(function (c) {
    return typeof c.intentCategory === 'string' && c.intentCategory.length > 0;
  }), JSON.stringify(choices.map(function (c) { return c.intentCategory; })));

  // 每项都有非空 fingerprint
  var fps = choices.map(function (c) { return Story.ChoiceFactory.fingerprint(c); });
  ok('每项 fingerprint 非空', fps.every(function (fp) { return typeof fp === 'string' && fp.length > 0; }),
    JSON.stringify(fps));

  // 至少 2 种不同 intentCategory
  var catSet = new Set(choices.map(function (c) { return c.intentCategory; }));
  ok('至少 2 种不同 intentCategory', catSet.size >= 2, 'got ' + catSet.size + ' : ' + JSON.stringify(Array.from(catSet)));

  // 3 项 fingerprint 互不重复
  ok('3 项 fingerprint 互不重复', new Set(fps).size === fps.length, JSON.stringify(fps));

  // validateChoiceSet 返回 ok
  var diag = Story.ChoiceFactory.validateChoiceSet(state, 'lu', choices);
  ok('validateChoiceSet 返回 ok', !!diag && diag.ok === true, JSON.stringify(diag && diag.errors));

  // 每项有 label / hint / targetType / targetId（V3.2 选项必备字段）
  ok('每项有非空 label',  choices.every(function (c) { return typeof c.label === 'string' && c.label.length > 0; }));
  ok('每项有非空 hint',   choices.every(function (c) { return typeof c.hint === 'string' && c.hint.length > 0; }));
  ok('每项有 targetType', choices.every(function (c) { return typeof c.targetType === 'string' && c.targetType.length > 0; }));
  ok('每项有 targetId',   choices.every(function (c) { return typeof c.targetId === 'string' && c.targetId.length > 0; }));

  console.log('\nV3.2 Choice 测试通过 ' + pass + ' / 失败 ' + fail);
  if (fail > 0) process.exitCode = 1;
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
