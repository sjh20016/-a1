const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) { if (condition) { pass++; console.log('✓ ' + name); } else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); } }
function main() {
  const oldText = '旧祠的风穿过断梁，地上的灰尘被吹成一道弯曲的线。沈青萝俯身检查封印，指尖停在裂纹之上。';
  let violation = Story.Narration.validateNovelty({ title: '新回声', chapter: '江北客收起剑，退到石门另一侧。\n飞猪按住伤口，确认自己仍能站立。\n沈青萝则重新核对了钥印的缺口。' }, [{ title: '旧章', chapter: oldText }]);
  ok('新内容通过重复度校验', violation === null, JSON.stringify(violation));
  violation = Story.Narration.validateNovelty({ title: '旧章', chapter: '完全不同的内容也不应当使用与最近两章完全一致的标题。' }, [{ title: '旧章', chapter: oldText }]);
  ok('重复标题被拒绝', violation && violation.code === 'REPETITIVE_NARRATION');
  violation = Story.Narration.validateNovelty({ title: '复述', chapter: oldText + '\n' + oldText }, [{ title: '旧章', chapter: oldText }]);
  ok('连续长原句重复被拒绝', violation && violation.code === 'REPETITIVE_NARRATION');
  console.log('\nV3.4.1 novelty: ' + pass + ' passed / ' + fail + ' failed'); if (fail) process.exitCode = 1;
}
main();
