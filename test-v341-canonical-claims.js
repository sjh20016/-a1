const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) { if (condition) { pass++; console.log('✓ ' + name); } else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); } }
function main() {
  const contract = { actorWhitelist: [{ id: 'a', name: '飞猪' }, { id: 'c', name: '江北客' }], entityWhitelist: [{ id: 'rift', name: '秘境裂隙' }], optionalAtmosphere: ['风声'], canonicalScene: { locationName: '旧祠', timeOfDay: '清晨' }, mustRenderFacts: [{ requiredMeaning: ['江北客攻击飞猪'] }] };
  let v = Story.Narration.validateCanonicalClaims({ chapter: '江北客攻击飞猪，风声从旧祠门缝里穿过。' }, contract);
  ok('白名单内事实通过', v === null, JSON.stringify(v));
  v = Story.Narration.validateCanonicalClaims({ chapter: '一名蒙面符修突然现身，江北客转而攻击他。' }, contract);
  ok('未登记敌人被拒绝', v && v.code === 'UNREGISTERED_ENTITY', JSON.stringify(v));
  v = Story.Narration.validateCanonicalClaims({ chapter: '飞猪在这一击中当场陨落，再也没有醒来。' }, contract);
  ok('未裁决永久死亡被拒绝', v && v.code === 'UNAUTHORIZED_EVENT', JSON.stringify(v));
  console.log('\nV3.4.1 canonical claims: ' + pass + ' passed / ' + fail + ' failed'); if (fail) process.exitCode = 1;
}
main();
