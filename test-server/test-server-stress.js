'use strict';

/**
 * 《修行局》V3.4.0 真实联机后端 — 压力测试
 * ============================================================================
 * 覆盖五类场景，验证“实际联机效果”：
 *   S1 并发房间：N 个房间同时跑完整流程（创建→加入→立命→准备→卷纲投票→开局→多回合）
 *   S2 同房竞态：同一房间多名玩家同时提交行动，验证 withRoomLock 串行化与无双重结算
 *   S3 断线重连：对局中途断开客户端再 reconnect，验证状态一致
 *   S4 AI 失败风暴：AI 失败时 narration_failed 锁定行动，房主重试后恢复
 *   S5 持续吞吐与延迟：单房间连跑多回合，统计 p50/p95/p99 延迟
 *
 * 运行：
 *   node test-server/test-server-stress.js
 *   STRESS_ROOMS=40 STRESS_ROUNDS=5 node test-server/test-server-stress.js
 * ============================================================================
 */
const { performance } = require('perf_hooks');
const helpers = require('./helpers.js');
const { TestClient, actorSetup } = helpers;

// ---------- 可配置参数 ----------
const ROOMS = parseInt(process.env.STRESS_ROOMS || '24', 10);     // 并发房间数
const ROUNDS = parseInt(process.env.STRESS_ROUNDS || '3', 10);    // 每房间回合数
const RACE_ROOMS = parseInt(process.env.STRESS_RACE || '6', 10);  // 同房竞态房间数
const SUSTAIN_ROUNDS = parseInt(process.env.STRESS_SUSTAIN || '20', 10); // 持续吞吐回合数
const PLAYERS_PER_RACE_ROOM = 4;

// ---------- 指标 ----------
const stats = {
  roomsOk: 0, roomsFail: 0,
  roundsOk: 0, roundsFail: 0,
  raceOk: 0, raceFail: 0, doubleResolve: 0,
  reconnectOk: 0, reconnectFail: 0,
  aiStormOk: 0, aiStormFail: 0,
  roundLatencies: [],
  errors: [],
};
const memBefore = process.memoryUsage();

function pct(arr, p) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort(function (a, b) { return a - b; });
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
function fmtMs(ms) { return ms.toFixed(1) + 'ms'; }
function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1) + 'MB'; }

// ---------- 流水线：完整跑一局到 N 回合 ----------
async function runOneRoom(app, roomIndex) {
  const t0 = performance.now();
  const a = new TestClient(app.wsUrl);
  const b = new TestClient(app.wsUrl);
  await Promise.all([a.connect(), b.connect()]);

  const created = await a.createRoom('压测A' + roomIndex, 'STRESS-' + roomIndex);
  await b.joinRoom(created.roomCode, '压测B' + roomIndex);
  await a.request('assign_actor', { actorSetup: actorSetup('陆知微' + roomIndex, '剑修') });
  await b.request('assign_actor', { actorSetup: actorSetup('沈青萝' + roomIndex, '丹道') });
  await a.request('set_ready', { ready: true });
  await b.request('set_ready', { ready: true });

  const started = await a.request('start_room_with_arc_voting', {}, { host: true });
  const candidates = started.view.arcVoting.candidates;
  const chosen = candidates.find(function (c) {
    return c.recipeId !== 'trade_contract' && c.recipeId !== 'relic_identity';
  }) || candidates[0];
  await a.request('submit_arc_vote', { arcId: chosen.arcId });
  await b.request('submit_arc_vote', { arcId: chosen.arcId });
  const finalized = await a.request('finalize_arc_vote', {}, { host: true });
  if (finalized.view.room.status !== 'collecting') {
    throw new Error('开局后非 collecting：' + finalized.view.room.status);
  }

  for (let r = 0; r < ROUNDS; r++) {
    const rt0 = performance.now();
    const va = await a.request('get_room_view', {});
    const vb = await b.request('get_room_view', {});
    const ca = va.view.ownActor.ownChoices[0];
    const cb = vb.view.ownActor.ownChoices[0];
    await a.request('submit_action', { action: { choiceId: ca.id } });
    const resB = await b.request('submit_action', { action: { choiceId: cb.id } });
    const rt = performance.now() - rt0;
    stats.roundLatencies.push(rt);

    const fa = await a.request('get_room_view', {});
    const cidA = fa.view.publicStory.chapterId;
    const cidB = resB.view.publicStory.chapterId;
    if (cidA !== cidB) throw new Error('章节不一致 A=' + cidA + ' B=' + cidB);
    if (fa.view.room.round < r + 2) throw new Error('回合未推进：' + fa.view.room.round);
    stats.roundsOk++;
  }

  a.close(); b.close();
  stats.roomsOk++;
  return performance.now() - t0;
}

// ---------- S2 同房竞态：多人同时提交 ----------
async function runRaceRoom(app, roomIndex) {
  const clients = [];
  for (let i = 0; i < PLAYERS_PER_RACE_ROOM; i++) clients.push(new TestClient(app.wsUrl));
  await Promise.all(clients.map(function (c) { return c.connect(); }));

  const host = clients[0];
  const created = await host.createRoom('竞态房主' + roomIndex, 'RACE-' + roomIndex);
  for (let i = 1; i < clients.length; i++) {
    await clients[i].joinRoom(created.roomCode, '竞态玩家' + i);
  }
  for (let i = 0; i < clients.length; i++) {
    await clients[i].request('assign_actor', { actorSetup: actorSetup('竞态' + i, '剑修') });
    await clients[i].request('set_ready', { ready: true });
  }
  const started = await host.request('start_room_with_arc_voting', {}, { host: true });
  const candidates = started.view.arcVoting.candidates;
  const chosen = candidates[0];
  for (let i = 0; i < clients.length; i++) {
    await clients[i].request('submit_arc_vote', { arcId: chosen.arcId });
  }
  await host.request('finalize_arc_vote', {}, { host: true });

  // 收集每名玩家选项
  const views = await Promise.all(clients.map(function (c) { return c.request('get_room_view', {}); }));
  const choices = views.map(function (v) { return v.view.ownActor.ownChoices[0].id; });

  // 关键：所有人同一瞬间提交（不等待彼此）
  const roundBefore = views[0].view.room.round;
  const chapterBefore = views[0].view.publicStory.chapterId;
  await Promise.all(clients.map(function (c, i) {
    return c.request('submit_action', { action: { choiceId: choices[i] } });
  }));

  // 等待广播落定后取最终视图
  await new Promise(function (r) { setTimeout(r, 60); });
  const finals = await Promise.all(clients.map(function (c) { return c.request('get_room_view', {}); }));
  const chapterIds = finals.map(function (f) { return f.view.publicStory.chapterId; });
  const allSame = chapterIds.every(function (id) { return id === chapterIds[0]; });
  const advanced = finals[0].view.room.round > roundBefore;
  const newChapter = chapterIds[0] !== chapterBefore;

  // 双重结算检测：回合数只能 +1
  const roundDelta = finals[0].view.room.round - roundBefore;
  if (roundDelta > 1) stats.doubleResolve++;

  if (allSame && advanced && newChapter && roundDelta === 1) stats.raceOk++;
  else {
    stats.raceFail++;
    stats.errors.push('竞态房间 ' + roomIndex + ' 失败：same=' + allSame + ' adv=' + advanced + ' delta=' + roundDelta);
  }
  clients.forEach(function (c) { c.close(); });
}

// ---------- S3 断线重连 ----------
async function runReconnectTest(app, roomIndex) {
  const a = new TestClient(app.wsUrl);
  const b = new TestClient(app.wsUrl);
  await Promise.all([a.connect(), b.connect()]);
  const created = await a.createRoom('重连房主' + roomIndex, 'RECONN-' + roomIndex);
  const savedAuth = Object.assign({}, a.auth);
  await b.joinRoom(created.roomCode, '重连陪练B');
  await a.request('assign_actor', { actorSetup: actorSetup('重连者', '剑修') });
  await b.request('assign_actor', { actorSetup: actorSetup('重连B', '丹道') });
  await a.request('set_ready', { ready: true });
  await b.request('set_ready', { ready: true });
  const started = await a.request('start_room_with_arc_voting', {}, { host: true });
  const chosen = started.view.arcVoting.candidates[0];
  await a.request('submit_arc_vote', { arcId: chosen.arcId });
  await b.request('submit_arc_vote', { arcId: chosen.arcId });
  await a.request('finalize_arc_vote', {}, { host: true });
  const before = await a.request('get_room_view', {});
  const roundBefore = before.view.room.round;
  const chapterBefore = before.view.publicStory.chapterId;

  // 断开 A（房主）
  a.close();
  await new Promise(function (r) { setTimeout(r, 80); });

  // 用保存的 token 重连
  const a2 = new TestClient(app.wsUrl);
  await a2.connect();
  await a2.reconnect(savedAuth);
  const after = await a2.request('get_room_view', {});
  if (after.view.room.round === roundBefore && after.view.publicStory.chapterId === chapterBefore) {
    stats.reconnectOk++;
  } else {
    stats.reconnectFail++;
    stats.errors.push('重连房间 ' + roomIndex + ' 状态不一致');
  }
  a2.close(); b.close();
}

// ---------- S4 AI 失败风暴 + 重试 ----------
async function runAIStorm(app, roomIndex) {
  const a = new TestClient(app.wsUrl);
  const b = new TestClient(app.wsUrl);
  await Promise.all([a.connect(), b.connect()]);
  const created = await a.createRoom('风暴房主' + roomIndex, 'STORM-' + roomIndex);
  await b.joinRoom(created.roomCode, '风暴玩家B');
  await a.request('assign_actor', { actorSetup: actorSetup('风暴A', '剑修') });
  await b.request('assign_actor', { actorSetup: actorSetup('风暴B', '丹道') });
  await a.request('set_ready', { ready: true });
  await b.request('set_ready', { ready: true });
  const started = await a.request('start_room_with_arc_voting', {}, { host: true });
  const chosen = started.view.arcVoting.candidates[0];
  await a.request('submit_arc_vote', { arcId: chosen.arcId });
  await b.request('submit_arc_vote', { arcId: chosen.arcId });
  await a.request('finalize_arc_vote', {}, { host: true });

  // 开启 AI 失败
  app.control.fail = true;
  const va = await a.request('get_room_view', {});
  const vb = await b.request('get_room_view', {});
  await a.request('submit_action', { action: { choiceId: va.view.ownActor.ownChoices[0].id } });
  let failedStatus = 'unknown';
  try {
    await b.request('submit_action', { action: { choiceId: vb.view.ownActor.ownChoices[0].id } });
  } catch (e) {
    // 期望失败
  }
  await new Promise(function (r) { setTimeout(r, 60); });
  const failView = await a.request('get_room_view', {});
  failedStatus = failView.view.room.status;

  // narration_failed 期间不能改行动
  let blocked = false;
  try { await a.request('cancel_action'); } catch (e) { blocked = true; }

  // 切回成功 AI，房主重试
  app.control.fail = false;
  let retryOk = false;
  try {
    await a.request('retry_narration', {}, { host: true });
    await new Promise(function (r) { setTimeout(r, 60); });
    const after = await a.request('get_room_view', {});
    retryOk = after.view.room.status === 'collecting';
  } catch (e) { /* ignore */ }

  if (failedStatus === 'narration_failed' && blocked && retryOk) stats.aiStormOk++;
  else {
    stats.aiStormFail++;
    stats.errors.push('AI风暴房间 ' + roomIndex + ' 失败：status=' + failedStatus + ' blocked=' + blocked + ' retryOk=' + retryOk);
  }
  a.close(); b.close();
}

// ---------- S5 持续吞吐 ----------
async function runSustain(app) {
  const a = new TestClient(app.wsUrl);
  const b = new TestClient(app.wsUrl);
  await Promise.all([a.connect(), b.connect()]);
  const created = await a.createRoom('吞吐房主', 'SUSTAIN');
  await b.joinRoom(created.roomCode, '吞吐B');
  await a.request('assign_actor', { actorSetup: actorSetup('吞吐A', '剑修') });
  await b.request('assign_actor', { actorSetup: actorSetup('吞吐B', '丹道') });
  await a.request('set_ready', { ready: true });
  await b.request('set_ready', { ready: true });
  const started = await a.request('start_room_with_arc_voting', {}, { host: true });
  const chosen = started.view.arcVoting.candidates[0];
  await a.request('submit_arc_vote', { arcId: chosen.arcId });
  await b.request('submit_arc_vote', { arcId: chosen.arcId });
  await a.request('finalize_arc_vote', {}, { host: true });

  for (let r = 0; r < SUSTAIN_ROUNDS; r++) {
    const rt0 = performance.now();
    const va = await a.request('get_room_view', {});
    const ca = va.view.ownActor.ownChoices[0].id;
    await a.request('submit_action', { action: { choiceId: ca } });
    const vb = await b.request('get_room_view', {});
    await b.request('submit_action', { action: { choiceId: vb.view.ownActor.ownChoices[0].id } });
    stats.roundLatencies.push(performance.now() - rt0);
    stats.roundsOk++;
  }
  a.close(); b.close();
}

// ---------- 主流程 ----------
async function main() {
  console.log('=== 《修行局》V3.4.0 联机后端压力测试 ===');
  console.log('参数：并发房间=' + ROOMS + ' 每房间回合=' + ROUNDS +
    ' 竞态房间=' + RACE_ROOMS + ' 持续吞吐回合=' + SUSTAIN_ROUNDS);
  console.log('');

  const app = await helpers.startTestServer();
  const memServerStart = process.memoryUsage();
  const totalT0 = performance.now();

  // S1 并发房间（分批并行，控制并发度避免句柄爆炸）
  console.log('— S1 并发房间（' + ROOMS + ' 个，各 ' + ROUNDS + ' 回合）—');
  const BATCH = 8;
  const s1T0 = performance.now();
  for (let i = 0; i < ROOMS; i += BATCH) {
    const batch = [];
    for (let j = 0; j < BATCH && i + j < ROOMS; j++) {
      batch.push((async function () {
        try { await runOneRoom(app, i + j); }
        catch (e) { stats.roomsFail++; stats.errors.push('S1 房间失败：' + e.message); }
      })());
    }
    await Promise.all(batch);
    process.stdout.write('\r  已完成 ' + Math.min(i + BATCH, ROOMS) + '/' + ROOMS + ' 房间');
  }
  const s1Dur = performance.now() - s1T0;
  console.log('\n  耗时 ' + fmtMs(s1Dur) + '，成功 ' + stats.roomsOk + '，失败 ' + stats.roomsFail);

  // S2 同房竞态
  console.log('— S2 同房竞态（' + RACE_ROOMS + ' 个房间 × ' + PLAYERS_PER_RACE_ROOM + ' 人同时提交）—');
  const s2T0 = performance.now();
  await Promise.all(Array.from({ length: RACE_ROOMS }, function (_, i) {
    return runRaceRoom(app, i).catch(function (e) {
      stats.raceFail++; stats.errors.push('S2 异常：' + e.message);
    });
  }));
  console.log('  耗时 ' + fmtMs(performance.now() - s2T0) + '，成功 ' + stats.raceOk +
    '，失败 ' + stats.raceFail + '，双重结算 ' + stats.doubleResolve);

  // S3 断线重连
  console.log('— S3 断线重连 —');
  const s3T0 = performance.now();
  await Promise.all(Array.from({ length: 4 }, function (_, i) {
    return runReconnectTest(app, i).catch(function (e) {
      stats.reconnectFail++; stats.errors.push('S3 异常：' + e.message);
    });
  }));
  console.log('  耗时 ' + fmtMs(performance.now() - s3T0) + '，成功 ' + stats.reconnectOk + '，失败 ' + stats.reconnectFail);

  // S4 AI 失败风暴（串行，因为共享 app.control.fail 开关）
  console.log('— S4 AI 失败风暴 + 房主重试 —');
  const s4T0 = performance.now();
  for (let i = 0; i < 3; i++) {
    try { await runAIStorm(app, i); }
    catch (e) { stats.aiStormFail++; stats.errors.push('S4 异常：' + e.message); }
  }
  console.log('  耗时 ' + fmtMs(performance.now() - s4T0) + '，成功 ' + stats.aiStormOk + '，失败 ' + stats.aiStormFail);

  // S5 持续吞吐
  console.log('— S5 持续吞吐（单房间连跑 ' + SUSTAIN_ROUNDS + ' 回合）—');
  const s5T0 = performance.now();
  await runSustain(app);
  console.log('  耗时 ' + fmtMs(performance.now() - s5T0));

  const totalDur = performance.now() - totalT0;
  const memAfter = process.memoryUsage();

  // ---------- 报告 ----------
  console.log('\n========================================');
  console.log('  压力测试报告');
  console.log('========================================');
  console.log('总耗时：' + fmtMs(totalDur));
  console.log('');
  console.log('【S1 并发房间】');
  console.log('  房间成功/失败：' + stats.roomsOk + ' / ' + stats.roomsFail);
  console.log('  房间吞吐：' + (stats.roomsOk / (s1Dur / 1000)).toFixed(2) + ' 房间/秒');
  console.log('  回合成功：' + stats.roundsOk + '（含 S5）');
  console.log('');
  console.log('【S2 同房竞态】');
  console.log('  成功/失败：' + stats.raceOk + ' / ' + stats.raceFail);
  console.log('  双重结算事故：' + stats.doubleResolve + '（应为 0）');
  console.log('');
  console.log('【S3 断线重连】');
  console.log('  成功/失败：' + stats.reconnectOk + ' / ' + stats.reconnectFail);
  console.log('');
  console.log('【S4 AI 失败风暴】');
  console.log('  成功/失败：' + stats.aiStormOk + ' / ' + stats.aiStormFail);
  console.log('');
  console.log('【回合延迟】（n=' + stats.roundLatencies.length + '）');
  console.log('  平均：' + fmtMs(stats.roundLatencies.reduce(function (a, b) { return a + b; }, 0) / Math.max(1, stats.roundLatencies.length)));
  console.log('  p50：' + fmtMs(pct(stats.roundLatencies, 50)));
  console.log('  p95：' + fmtMs(pct(stats.roundLatencies, 95)));
  console.log('  p99：' + fmtMs(pct(stats.roundLatencies, 99)));
  console.log('  max：' + fmtMs(pct(stats.roundLatencies, 100)));
  console.log('');
  console.log('【内存】');
  console.log('  测试前 heapUsed：' + mb(memBefore.heapUsed));
  console.log('  服务器启动后：' + mb(memServerStart.heapUsed));
  console.log('  全部跑完：' + mb(memAfter.heapUsed));
  console.log('  增量：' + mb(memAfter.heapUsed - memBefore.heapUsed));
  console.log('  rss：' + mb(memAfter.rss));
  console.log('');
  if (stats.errors.length) {
    console.log('【错误明细】（前 10 条）');
    stats.errors.slice(0, 10).forEach(function (e) { console.log('  - ' + e); });
  } else {
    console.log('【错误明细】无');
  }
  console.log('');

  const allOk = stats.roomsFail === 0 && stats.raceFail === 0 && stats.doubleResolve === 0 &&
    stats.reconnectFail === 0 && stats.aiStormFail === 0;
  console.log('========================================');
  console.log('  结论：' + (allOk ? '✓ 全部通过，真实联机稳定' : '✗ 存在失败项，需排查'));
  console.log('========================================');

  await app.stop();
  process.exit(allOk ? 0 : 1);
}

main().catch(function (e) { console.error('压力测试崩溃：', e); process.exit(1); });
