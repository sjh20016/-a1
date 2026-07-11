/* V3.4.1：自定义行动必须指向当前状态中的真实目标。 */
const Story = require('./story-core.js');

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('✓ ' + name); }
  else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function target(state, actorId, text) {
  return Story.Intent.parseCustomText(state, actorId, text);
}

function main() {
  const state = Story.createEmptyState();
  state.actors = [
    { id: 'actor_a', seatId: 'seat_0', controller: 'human', name: '飞猪', displayName: '阿飞' },
    { id: 'actor_b', seatId: 'seat_1', controller: 'human', name: '沈青萝', displayName: '青萝玩家' },
    { id: 'actor_c', seatId: 'seat_2', controller: 'human', name: '江北客', displayName: '老江' },
  ];
  state.story.currentScene = {
    sceneId: 'scene_test', locationId: 'secret_realm', locationName: '秘境入口',
    visibleEntities: [
      { id: 'ent_rift', name: '秘境裂隙', kind: 'clue' },
      { id: 'ent_innkeeper', name: '女掌柜', kind: 'npc' },
    ],
    exits: [{ id: 'exit_deep', name: '秘境深处', kind: 'exit' }],
    availableAssets: [{ id: 'asset_broken_key', name: '残缺钥印', kind: 'relic' }],
  };
  state.story.activeThreads = [
    { threadId: 'thread_public', title: '失踪商队', status: 'active', visibility: 'public' },
    { threadId: 'thread_secret', title: '密室真相', status: 'active', visibility: 'private' },
  ];
  Story._activateState(state);

  let intent = target(state, 'actor_c', '试图攻击玩家A');
  ok('攻击玩家A 指向飞猪', intent.targetType === 'actor' && intent.targetId === 'actor_a', JSON.stringify(intent));
  intent = target(state, 'actor_c', '攻击飞猪');
  ok('攻击真实姓名指向同一 actor', intent.targetId === 'actor_a', JSON.stringify(intent));
  intent = target(state, 'actor_a', '询问沈青萝');
  ok('询问沈青萝命中角色', intent.targetId === 'actor_b', JSON.stringify(intent));
  intent = target(state, 'actor_a', '调查秘境裂隙');
  ok('调查秘境裂隙命中可见实体', intent.targetId === 'ent_rift', JSON.stringify(intent));
  intent = target(state, 'actor_a', '观察残缺钥印');
  ok('观察残缺钥印命中当前资产', intent.targetId === 'asset_broken_key', JSON.stringify(intent));
  intent = target(state, 'actor_a', '询问掌柜');
  ok('掌柜使用 canonical ID', intent.targetId === 'ent_innkeeper', JSON.stringify(intent));
  intent = target(state, 'actor_a', '追查失踪商队');
  ok('公开 active thread 可命中', intent.targetId === 'thread_public', JSON.stringify(intent));
  intent = target(state, 'actor_a', '调查密室真相');
  ok('私密 thread 不会泄漏为目标', intent.targetId !== 'thread_secret', JSON.stringify(intent));
  intent = target(state, 'actor_a', '找青萝玩家交谈');
  ok('房间 displayName 可命中', intent.targetId === 'actor_b', JSON.stringify(intent));

  console.log('\nV3.4.1 targets: ' + pass + ' passed / ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}

main();
