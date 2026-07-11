const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) { if (condition) { pass++; console.log('✓ ' + name); } else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); } }
function main() {
  const contract = { elapsedTime: { value: 1, unit: '片刻' }, canonicalScene: { timeOfDay: '清晨' }, mustRenderFacts: [{ actionType: 'observe' }] };
  let v = Story.Narration.validateTemporalConsistency({ chapter: '清晨的雾气尚未散去，飞猪只观察了片刻。' }, contract);
  ok('片刻+清晨一致时通过', v === null, JSON.stringify(v));
  v = Story.Narration.validateTemporalConsistency({ chapter: '他们在此闭关数月，待到换季才醒来。' }, contract);
  ok('片刻被写成数月时拒绝', v && v.code === 'TEMPORAL_CONTRADICTION');
  v = Story.Narration.validateTemporalConsistency({ chapter: '夜色如墨，深夜的雨落在屋檐上。' }, contract);
  ok('清晨被写回深夜时拒绝', v && v.code === 'TEMPORAL_CONTRADICTION');
  console.log('\nV3.4.1 temporal: ' + pass + ' passed / ' + fail + ' failed'); if (fail) process.exitCode = 1;
}
main();
