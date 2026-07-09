/* test-v335-director-observability.js — V3.3.5 Director 可观测性验收
 *
 * 覆盖：
 *   1. Story.getDirectorSnapshot() 提供稳定只读快照。
 *   2. applyPlan 后快照包含 lastDivergence、directorScore、clockEvents。
 *   3. Room eventLog 记录 DIRECTOR_ARC_ACTIVATED 与 DIRECTOR_RESOLVED。
 */
const Story = require('./story-core.js');
const Room = require('./room-core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}

function setupEchoAI() {
  Story.setAIEnabled(true);
  Story.registerAIProvider({
    narrate: async function (ctx) {
      var actions = (ctx.chosenActions || []).map(function (a) {
        return [a.actorName, a.publicAction, a.targetName, (a.gains || []).join(' '), (a.costs || []).join(' ')].join(' ');
      }).join('。');
      var body = actions || 'Opening scene establishes the selected arc and all actors gather before the first decision.';
      body += ' The narration keeps the local ruling intact, shows pressure, consequence, and the next visible problem. '.repeat(8);
      return JSON.stringify({ title: 'Observable Director', chapter: body, dialogues: [], endingImage: '' });
    },
  }, { provider: 'echo', model: 'echo-director' });
}

function playerSetup(name) {
  return {
    name: name,
    identity: 'tester',
    daoPath: 'sword',
    publicWish: 'find truth',
    hiddenFate: 'old promise',
    personalityTags: ['careful'],
  };
}

function candidateFor(recipeId) {
  var r = Story.DirectorRecipes[recipeId];
  return {
    arcId: 'arc_' + recipeId,
    recipeId: recipeId,
    family: r.family,
    title: r.title,
    publicPitch: r.publicPitch,
    tags: (r.tags || []).slice(),
    openingHooks: [],
    voteScore: 0,
    voteBreakdown: {},
  };
}

function makeCoreState() {
  var state = Story.createEmptyState('V335-SNAPSHOT');
  state.world.seed = 'V335-SNAPSHOT';
  state.world.name = 'Observable Realm';
  state.world.year = 1;
  state.world.worldBible = {
    rules: ['rule-one', 'rule-two', 'rule-three', 'rule-four'],
    heavenlyLaw: 'contract law',
    storyGravity: 'intrigue',
    startLocation: 'inn_redsand',
  };
  state.actors.push(Object.assign({ id: 'p1', controller: 'human' }, playerSetup('Alice')));
  state.actors.push(Object.assign({ id: 'bot1', controller: 'bot' }, playerSetup('Cyan')));
  state.story.currentScene = Story.Scene.createOpeningScene(state);
  state.story.director.candidates = [candidateFor('trade_contract'), candidateFor('tower_expedition'), candidateFor('sealed_realm')];
  state.story.director.phase = 'voting';
  Story.Director.activateArc(state, 'arc_trade_contract');
  Story.Director.applyArcOpeningScenePatch(state, state.story.director.activeArc);
  Story.Director.applyOpeningSeed(state, state.story.director.activeArc);
  return state;
}

async function testCoreSnapshot() {
  var state = makeCoreState();
  var snap = Story.getDirectorSnapshot(state);
  ok('snapshot returns active arc', snap && snap.activeArc && snap.activeArc.arcId === 'arc_trade_contract');
  ok('snapshot exposes current beat', snap && snap.activeArc.currentBeat && !!snap.activeArc.currentBeat.beatId);
  ok('snapshot exposes clocks with percent', snap && snap.activeArc.pressureClocks[0].percent === 0);

  var arc = state.story.director.activeArc;
  var clock = arc.pressureClocks[0];
  clock.current = clock.max - 1;
  var plan = Story.Director.evaluate(state, {
    actions: [{ actorId: 'p1', category: 'rest', rawText: 'Alice waits and lets the caravan clock advance.' }],
  });
  Story.Director.applyPlan(state, plan);
  var after = Story.getDirectorSnapshot(state);
  ok('snapshot records last divergence result', after.lastDivergence && after.lastDivergence.result === 'stall',
    after.lastDivergence && after.lastDivergence.result);
  ok('snapshot records directorScore', after.lastDivergence && after.lastDivergence.directorScore && after.lastDivergence.directorScore.stall > 0);
  ok('snapshot records clockEvents', after.lastDivergence && after.lastDivergence.clockEvents && after.lastDivergence.clockEvents.length === 1);
  ok('clock snapshot marks full clock', after.activeArc.pressureClocks[0].isFull === true);
}

async function testRoomDirectorEvents() {
  setupEchoAI();
  var room = Room.coordinator.createRoom({ hostName: 'Host', mode: 'local-hotseat', seed: 'V335-ROOM' });
  Room.coordinator.addBotSeat(room.roomId, 1, { presetIndex: 0 });
  Room.coordinator.addBotSeat(room.roomId, 2, { presetIndex: 1 });
  Room.coordinator.addBotSeat(room.roomId, 3, { presetIndex: 2 });
  room.seats.filter(function (s) { return s.kind === 'human' || s.kind === 'bot'; }).forEach(function (seat, i) {
    Room.coordinator.assignActorToSeat(room.roomId, seat.seatId, playerSetup(seat.displayName || ('Seat' + i)));
    Room.coordinator.setSeatReady(room.roomId, seat.seatId, true);
  });
  await Room.coordinator.startRoomWithArcVoting(room.roomId);
  var humanSeat = room.seats.find(function (s) { return s.kind === 'human'; });
  Room.coordinator.submitArcVote(room.roomId, humanSeat.seatId, room.directorVote.candidates[0].arcId);
  await Room.coordinator.finalizeArcVote(room.roomId, humanSeat.seatId);
  ok('room logs director arc activation',
    room.eventLog.some(function (e) { return e.type === 'DIRECTOR_ARC_ACTIVATED' && e.payload && e.payload.arcId; }));

  var choices = Story.getChoicesForActor(room.storySession, humanSeat.actorId);
  Room.coordinator.submitAction(room.roomId, humanSeat.seatId, { choiceId: choices[0].id });
  await Room.coordinator.awaitPending(room.roomId);
  var resolved = room.eventLog.find(function (e) { return e.type === 'DIRECTOR_RESOLVED'; });
  ok('room logs director resolution', !!resolved);
  ok('director resolution payload includes result', resolved && !!resolved.payload.result, JSON.stringify(resolved && resolved.payload));
  ok('director resolution payload includes clocks', resolved && Array.isArray(resolved.payload.clocks) && resolved.payload.clocks.length > 0);
}

async function main() {
  console.log('\n=== test-v335-director-observability ===');
  await testCoreSnapshot();
  await testRoomDirectorEvents();

  console.log('\n' + '  Director V3.3.5 observability tests passed ' + pass + ' / failed ' + fail);
  if (fail) process.exitCode = 1;
}

main().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
