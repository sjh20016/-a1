const Story = require('./story-core.js');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  OK ' + name);
    return;
  }
  failed++;
  console.error('  FAIL ' + name + (detail ? ' :: ' + detail : ''));
}

function validate(mentionedEntities, contract) {
  return Story.Narration.validateEntityAudit({
    title: '审计回归',
    chapter: '众人检查了残缺钥印。',
    audit: {
      mentionedEntities: mentionedEntities,
      coveredFactIds: [],
    },
  }, contract);
}

const contract = {
  entityWhitelist: [
    { id: 'ent_seal_keymark', name: '残缺钥印', type: 'prop' },
  ],
  actorWhitelist: [
    { id: 'actor_1', name: '云游修士', displayName: '云游修士' },
  ],
  mustRenderFacts: [],
};

console.log('\n=== test-v344-entity-audit ===');

let violation = validate(['ent_seal_keymark'], contract);
check('已登记实体 ID 可以通过 audit', violation === null, JSON.stringify(violation));

violation = validate(['残缺钥印', 'actor_1'], contract);
check('已登记实体名称和角色 ID 可以通过 audit', violation === null, JSON.stringify(violation));

violation = validate([{ id: 'ent_seal_keymark', name: '残缺钥印' }], contract);
check('对象格式的已登记实体可以通过 audit', violation === null, JSON.stringify(violation));

violation = validate(['innkeeper_01'], {
  entityWhitelist: [{ id: 'ent_innkeeper', name: '女掌柜', type: 'npc' }],
  actorWhitelist: [],
  mustRenderFacts: [],
});
check('旧实体 ID 可以通过规范 ID 匹配', violation === null, JSON.stringify(violation));

violation = validate(['ent_unregistered_intruder'], contract);
check('真正未登记的实体 ID 仍被拒绝', violation && violation.code === 'UNREGISTERED_ENTITY', JSON.stringify(violation));

console.log('Entity audit regression passed ' + passed + ' / failed ' + failed);
if (failed) process.exit(1);
