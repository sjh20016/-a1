const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('✓ ' + name); }
  else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function main() {
  const state = Story.createEmptyState();
  state.story.currentScene = { sceneId: 's', locationId: 'camp', locationName: '营地', timeOfDay: '夜', weather: '微雨', pressure: 1, deadline: null, visibleEntities: [], availableAssets: [], exits: [], activeThreadIds: [], sceneStatus: 'open' };
  state.actors = [
    { id: 'a', name: '甲', controller: 'human', presence: 'present', relationships: {}, hidden: { injury: 0 }, privateFacts: [] },
    { id: 'b', name: '乙', controller: 'human', presence: 'present', relationships: {}, hidden: { injury: 0 }, privateFacts: [] },
  ];
  const actions = [
    { actorId: 'a', category: 'observe', targetId: 'x', outcome: 'success', gains: [], costs: [], publicEffects: [], privateEffects: [], threadEffects: [], relationEffects: [], timePassed: { value: 1, unit: '片刻' } },
    { actorId: 'b', category: 'investigate', targetId: 'x', outcome: 'success', gains: [], costs: [], publicEffects: [], privateEffects: [], threadEffects: [], relationEffects: [], timePassed: { value: 3, unit: '日' } },
  ];
  const envelope = Story.Resolver.buildEnvelope(state, actions, []);
  ok('elapsedTime 取并行行动最大值', envelope.elapsedTime.unit === '日' && envelope.elapsedTime.value === 3, JSON.stringify(envelope.elapsedTime));
  const timeDelta = envelope.publicDelta.find(function (d) { return d.op === 'ADVANCE_TIME'; });
  ok('ADVANCE_TIME 与 elapsedTime 是同一事实', timeDelta && timeDelta.payload.unit === envelope.elapsedTime.unit && timeDelta.payload.value === envelope.elapsedTime.value);
  const night = { timeOfDay: '夜', weather: '微雨' };
  Story.Time.advanceSceneClock(night, { value: 1, unit: '夜' });
  ok('夜+一夜变为清晨', night.timeOfDay === '清晨', night.timeOfDay);
  Story.Time.advanceSceneClock(night, { value: 3, unit: '日' });
  ok('数日后显示黄昏', /日后·黄昏/.test(night.timeOfDay), night.timeOfDay);
  Story.Time.advanceSceneClock(night, { value: 3, unit: '月' });
  ok('数月后换季', night.timeOfDay === '数月之后' && night.weather === '换季');
  console.log('\nV3.4.1 unified time: ' + pass + ' passed / ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}
main();
