const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) { if (condition) { pass++; console.log('✓ ' + name); } else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); } }
function main() {
  const contract = { mustRenderFacts: [{ factId: 'attack', kind: 'action', actorName: '江北客', actionType: 'battle', actionText: '试图攻击玩家A', targetType: 'actor', targetName: '飞猪', outcome: 'partial_success', gains: [], costs: ['暴露敌意'] }] };
  let violation = Story.Narration.validateActionFacts({ chapter: '江北客主动攻击飞猪，攻势未完全命中，却已打断了飞猪的休息节奏。' }, contract);
  ok('正确行动/目标/结果通过', violation === null, JSON.stringify(violation));
  violation = Story.Narration.validateActionFacts({ chapter: '江北客攻击蒙面符修，攻势未完全命中。' }, contract);
  ok('攻击目标被替换返回 WRONG_ACTION_TARGET', violation && violation.code === 'WRONG_ACTION_TARGET', JSON.stringify(violation));
  violation = Story.Narration.validateActionFacts({ chapter: '江北客攻击飞猪，一击得手，成功重创对方。' }, contract);
  ok('部分成功被写成成功返回 WRONG_ACTION_OUTCOME', violation && violation.code === 'WRONG_ACTION_OUTCOME', JSON.stringify(violation));
  violation = Story.Narration.validateActionFacts({ chapter: '夜色安静，庭院里只有风声。' }, contract);
  ok('漏写真人行动返回 MISSING_ACTION_FACT', violation && violation.code === 'MISSING_ACTION_FACT', JSON.stringify(violation));
  console.log('\nV3.4.1 action facts: ' + pass + ' passed / ' + fail + ' failed'); if (fail) process.exitCode = 1;
}
main();
