'use strict';

const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('✓ ' + name); }
  else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function bibleWith(overrides) {
  return Story.buildWorldBible(Object.assign({
    seed: 'WORLD-RULES', era: '盛世', terrain: '山河大陆', order: '宗门割据',
    heavenlyLaw: '契约具现', greatTribulation: '魔潮', aberrant: '灵族复苏', storyGravity: '游历',
  }, overrides || {}));
}

async function stateWith(bible) {
  return Story.createSession({ seed: 'WORLD-RULES', worldConfig: bible, skipOpening: true, actors: [
    { id: 'actor', name: '试炼者', seatId: 'seat_0', controller: 'human', daoPath: '剑修' },
  ] });
}

async function main() {
  const state = await stateWith(bibleWith());
  const contracts = Story.WorldRules.compile(state.world.worldBible);
  ok('七维世界骰全部编译为规则契约', contracts.length === 7);
  ok('每维都有 resolver modifier', contracts.every(function (contract) { return Object.keys(contract.resolverModifiers).length > 0; }));
  ok('每维都有加权事件', contracts.every(function (contract) { return Object.keys(contract.eventWeights).length > 0; }));
  ok('每维都有长期 turn effect', contracts.every(function (contract) { return contract.turnEffect && contract.turnEffect.pressurePerTurn > 0; }));
  ok('每维都有玩家可读解释', contracts.every(function (contract) { return contract.explanation && contract.explanation.length > 5; }));

  const allCategories = Array.from(new Set(contracts.flatMap(function (contract) { return Object.keys(contract.resolverModifiers); })));
  Story.WorldRules.applyTurnEffects(state, { actions: allCategories.map(function (category) { return { category: category }; }) });
  const slots = Object.values(state.world.ruleState.dimensions);
  ok('七维长期状态随回合推进', slots.every(function (slot) { return slot.pressure > 0; }));
  ok('命中规则会记录 triggerCount', slots.every(function (slot) { return slot.triggerCount > 0; }));

  const prosperous = await stateWith(bibleWith({ era: '盛世' }));
  const depleted = await stateWith(bibleWith({ era: '末法' }));
  const intent = { actorId: 'actor', category: 'cultivate', targetType: 'self', targetId: 'actor', targetName: '试炼者', targetConfidence: 1, rawText: '静心修炼', source: 'custom', timePreference: '数月', longActionApproved: true, targetKnown: true, targetPresent: true, targetReachable: true };
  prosperous.story.currentScene = { pressure: 0 };
  depleted.story.currentScene = { pressure: 0 };
  const prosperousResult = Story.Resolver.resolveActorAction(prosperous, prosperous.story.currentScene, intent);
  const depletedResult = Story.Resolver.resolveActorAction(depleted, depleted.story.currentScene, intent);
  const progressOf = function (result) { return result.actorStatusDeltas.find(function (delta) { return delta.key === 'cultivationProgress'; }).delta; };
  ok('时代骰改变修炼数值结果', progressOf(prosperousResult) > progressOf(depletedResult), progressOf(prosperousResult) + ' vs ' + progressOf(depletedResult));
  ok('裁决结果保留可解释规则来源', prosperousResult.worldRuleModifiers.some(function (entry) { return entry.dimension === 'era'; }));

  const land = await stateWith(bibleWith({ terrain: '山河大陆', storyGravity: '夺宝' }));
  const landTravel = Story.WorldRules.applyToAction(land, { category: 'travel', outcome: 'success', gains: [], costs: [], timePassed: { value: 1, unit: '日' } });
  const sky = await stateWith(bibleWith({ terrain: '空岛海', storyGravity: '夺宝' }));
  const skyTravel = Story.WorldRules.applyToAction(sky, { category: 'travel', outcome: 'success', gains: [], costs: [], timePassed: { value: 1, unit: '日' } });
  ok('地形骰改变旅行成本', skyTravel.timePassed.value > landTravel.timePassed.value, landTravel.timePassed.value + ' vs ' + skyTravel.timePassed.value);

  for (let turn = 1; turn <= 12; turn++) {
    state.story.chapterIndex = turn;
    Story.FactionSystem.afterTurn(state);
  }
  ok('势力每回合执行一次本地行动', state.world.factionHistory.length === 12);
  ok('势力 power/control/resources 不再恒定', state.world.factions.some(function (faction) { return faction.power !== 50 || faction.control > 0 || faction.resources > 0; }));
  ok('势力行动可由 UI 解释', state.world.factions.some(function (faction) { return faction.lastAction && faction.lastAction.text; }));

  const view = Story.getPublicStoryView(state);
  ok('公共视图暴露七维规则解释', view.worldRules.length === 7 && Object.keys(view.worldEventWeights).length >= 7);
  console.log('\nWorldRules: ' + pass + ' passed / ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
