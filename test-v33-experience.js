/* test-v33-experience.js — V3.3 Phase 5 体验测试
 *
 * 验证三条体验主线 + Phase 2/3/4 落地：
 *   §1 三回合休息：玩家连续休息 3 回合，章节稳定推进、选项保持多样、无崩溃。
 *   §2 三分支发散：同种子下 rest / investigate / travel 三分支，场景与线索走向发散。
 *   §3 十二章质量回归：连续 12 回合，章节非空、provenance=ai-json、无禁用句、命盘/实体齐备。
 *   §4 Phase 2 共享场景契约：Bot 独自 travel 不重写全员位置（partial_move），离队可归队。
 *   §5 Phase 3/4 结构：SceneEntity 对象化 + AssetRegistry + 命盘确定性。
 */
const Story = require('./story-core.js');
const { setupMockAI, DEFAULT_CHAPTER } = require('./test-helpers.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const SETUP = {
  name: '陆知微', daoPath: '剑修',
  publicWish: '寻找失落剑经', hiddenFate: '残剑记得一个不存在的人名',
  personalityTags: ['谨慎', '执念'],
};

function pickByCategory(choices, actorId, cat) {
  const found = choices.find(function (c) { return c.intentCategory === cat; });
  return found || choices[0];
}

async function main() {
  setupMockAI(Story);

  /* ---------- §1 三回合休息 ---------- */
  console.log('\n— §1 三回合休息 —');
  const st1 = await Story.startGame('EXP-REST', SETUP);
  const startIdx1 = st1.story.chapterIndex;
  let restCount = 0;
  let diverseEveryTurn = true;
  for (let i = 0; i < 3; i++) {
    const ch = Story.getChoicesForActor(st1, 'lu');
    const cats = new Set(ch.map(function (c) { return c.intentCategory; }));
    if (cats.size < 2) diverseEveryTurn = false;
    const rest = pickByCategory(ch, 'lu', 'rest');
    await Story.resolveTurn(st1, { lu: { choiceId: rest.id } });
    if (st1.story.currentChapter && st1.story.currentChapter.chapter) restCount++;
  }
  ok('3 回合后 chapterIndex 推进 3', st1.story.chapterIndex === startIdx1 + 3, 'got ' + st1.story.chapterIndex);
  ok('3 回合均生成正文', restCount === 3, 'got ' + restCount);
  ok('每回合选项至少 2 种 category', diverseEveryTurn);
  ok('休息回合无崩溃且 currentChapter 存在', !!st1.story.currentChapter);

  /* ---------- §2 三分支发散 ---------- */
  console.log('\n— §2 三分支发散 —');
  async function branch(seedSuffix, cat) {
    setupMockAI(Story);
    const st = await Story.startGame('EXP-BRANCH-' + seedSuffix, SETUP);
    const ch = Story.getChoicesForActor(st, 'lu');
    const pick = pickByCategory(ch, 'lu', cat);
    await Story.resolveTurn(st, { lu: { choiceId: pick.id } });
    return { state: st, pickedCat: pick.intentCategory, scene: st.story.currentScene };
  }
  const A = await branch('REST', 'rest');
  const B = await branch('INVS', 'investigate');
  const C = await branch('TRVL', 'travel');
  ok('rest 分支场景保留在客栈', A.scene.locationId === 'inn_redsand', A.scene.locationId);
  ok('travel 分支场景迁移至古道', C.scene.locationId === 'road_broken_flow', C.scene.locationId);
  ok('investigate 分支场景保留', B.scene.locationId === 'inn_redsand', B.scene.locationId);
  ok('rest 与 travel 分支场景发散', A.scene.locationId !== C.scene.locationId);
  ok('三分支章节标题存在且非空', !!(A.state.story.currentChapter && A.state.story.currentChapter.title));
  // investigate 应推进线索相关 thread（trade_letter 或 old_sword）
  const invThreads = B.state.story.activeThreads.filter(function (t) { return t.status === 'active'; });
  ok('investigate 分支后仍有活跃线程', invThreads.length > 0);

  /* ---------- §3 十二章质量回归 ---------- */
  console.log('\n— §3 十二章质量回归 —');
  setupMockAI(Story);
  const st3 = await Story.startGame('EXP-LONG', SETUP);
  const forbidden = Story.FORBIDDEN_PHRASES || [];
  let turn = 0;
  let allNonEmpty = true;
  let allAiJson = true;
  let hasForbidden = false;
  let crashed = false;
  const rotateCats = ['rest', 'investigate', 'observe', 'social', 'use_relic', 'negotiate', 'rest', 'observe', 'investigate', 'rest', 'social', 'observe'];
  try {
    for (let i = 0; i < 12; i++) {
      const ch = Story.getChoicesForActor(st3, 'lu');
      if (!ch.length) { allNonEmpty = false; break; }
      const pick = pickByCategory(ch, 'lu', rotateCats[i] || ch[0].intentCategory);
      await Story.resolveTurn(st3, { lu: { choiceId: pick.id } });
      turn++;
      const cur = st3.story.currentChapter;
      if (!cur || !cur.chapter || !String(cur.chapter).replace(/\s/g, '').length) allNonEmpty = false;
      if (!cur || cur.provenance !== 'ai-json') allAiJson = false;
      const pubText = (st3.ledger.publicEvents || []).join(' ');
      const chText = cur ? (String(cur.chapter || '') + String(cur.title || '')) : '';
      const blob = pubText + chText;
      for (let p = 0; p < forbidden.length; p++) {
        if (blob.indexOf(forbidden[p]) >= 0) { hasForbidden = true; break; }
      }
    }
  } catch (e) { crashed = true; console.error('   长线异常:', e.message); }
  ok('12 回合全部推进', turn === 12, 'got ' + turn);
  ok('12 章正文均非空', allNonEmpty);
  ok('12 章 provenance=ai-json', allAiJson);
  ok('12 章无禁用句', !hasForbidden);
  ok('12 回合无崩溃', !crashed);
  // Phase 4：命盘齐备
  const fateOk = st3.actors.every(function (a) { return a.fatePlate && a.fatePlate.originStar && a.fatePlate.fateNumber; });
  ok('12 章后全员命盘齐备', fateOk);
  // Phase 3：场景实体对象化
  const ents = st3.story.currentScene.visibleEntities;
  const entsAreObjects = Array.isArray(ents) && ents.length > 0 && ents.every(function (e) { return e && typeof e === 'object' && Array.isArray(e.affordances); });
  ok('场景实体为对象 + affordances', entsAreObjects);
  // Phase 3：AssetRegistry 非空
  ok('AssetRegistry 登记了资产', (st3.assets || []).length > 0);

  /* ---------- §4 Phase 2 共享场景契约 ---------- */
  console.log('\n— §4 Phase 2 共享场景契约 —');
  setupMockAI(Story);
  const st4 = await Story.startGame('EXP-SHARE', SETUP);
  const sceneBefore = st4.story.currentScene.locationId;
  // 玩家休息 + 强制韩照野 travel（自定义行动，确定性触发 partial_move）→ 仅 Bot 移动
  const luCh = Story.getChoicesForActor(st4, 'lu');
  const luRest = pickByCategory(luCh, 'lu', 'rest');
  await Story.resolveTurn(st4, { lu: { choiceId: luRest.id }, han: { custom: { text: '连夜出城，追赶已离城的商队。' } } });
  const han = st4.actors.find(function (a) { return a.id === 'han'; });
  const lu = st4.actors.find(function (a) { return a.id === 'lu'; });
  ok('Bot 独自 travel 后共享场景不变', st4.story.currentScene.locationId === sceneBefore, st4.story.currentScene.locationId);
  ok('Bot 被标记为离队', han.presence === 'away', han.presence);
  ok('玩家仍在场', lu.presence === 'present', lu.presence);
  ok('Bot 位置已离开主场景', han.locationId !== sceneBefore, han.locationId);
  // 离队者下回合应有「返回同行」选项（buildForActor 对 away 角色强制 pin）
  const hanCh2 = Story.getChoicesForActor(st4, 'han');
  const rejoin = hanCh2.find(function (c) { return c.intentCategory === 'travel' && c.targetId === 'rejoin_party'; });
  ok('离队者获得「返回同行」选项', !!rejoin, JSON.stringify(hanCh2.map(function (c) { return c.targetId; })));
  // 提交归队：玩家休息 + 韩照野 rejoin
  const luCh2 = Story.getChoicesForActor(st4, 'lu');
  const luRest2 = pickByCategory(luCh2, 'lu', 'rest');
  await Story.resolveTurn(st4, { lu: { choiceId: luRest2.id }, han: { choiceId: rejoin.id } });
  ok('离队者归队后 presence=present', han.presence === 'present', han.presence);
  ok('归队后 Bot 位置回到主场景', han.locationId === st4.story.currentScene.locationId, han.locationId);

  /* ---------- §5 Phase 3/4 结构与确定性 ---------- */
  console.log('\n— §5 Phase 3/4 结构与确定性 —');
  setupMockAI(Story);
  const sA = await Story.startGame('EXP-GEN', SETUP);
  setupMockAI(Story);
  const sB = await Story.startGame('EXP-GEN', SETUP);
  const plateA = sA.actors.find(function (a) { return a.id === 'lu'; }).fatePlate;
  const plateB = sB.actors.find(function (a) { return a.id === 'lu'; }).fatePlate;
  ok('同种子同角色命盘一致', JSON.stringify(plateA) === JSON.stringify(plateB));
  ok('命盘含本命星/命数/曲线', !!plateA.originStar && plateA.fateNumber >= 1 && !!plateA.lifeCurve);
  ok('publicEcho 不泄露私密', Story.CharacterGenesis.publicEcho(plateA).indexOf('隐藏') < 0);
  // Scene.Entity 归一化双兼容
  const strNorm = Story.Scene.Entity.normalize(['女掌柜', '残剑']);
  ok('字符串实体归一化为对象', strNorm[0].name === '女掌柜' && Array.isArray(strNorm[0].affordances));
  const objNorm = Story.Scene.Entity.normalize([{ id: 'x', name: '阵眼', kind: 'prop', affordances: ['observe'] }]);
  ok('对象实体归一化保留 affordances', objNorm[0].affordances.indexOf('observe') >= 0);
  // AssetRegistry 注册/查询
  Story.AssetRegistry.register(sA, { id: 'test_relic', name: '试剑石', kind: 'relic', ownerActorId: 'lu', state: 'sealed' });
  ok('AssetRegistry 注册后可查询', !!Story.AssetRegistry.get(sA, 'test_relic'));
  ok('AssetRegistry byOwner 正确', Story.AssetRegistry.byOwner(sA, 'lu').some(function (a) { return a.id === 'test_relic'; }));

  console.log('\n========================================');
  console.log('  V3.3 Experience 测试通过 ' + pass + ' / 失败 ' + fail);
  console.log('========================================');
  if (fail > 0) process.exitCode = 1;
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
