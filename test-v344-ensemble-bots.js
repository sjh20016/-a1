const fs = require('fs');
const path = require('path');
const Story = require('./story-core.js');
const Room = require('./room-core.js');

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('  OK ' + name); }
  else { fail++; console.error('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

async function main() {
  console.log('\n=== test-v344-ensemble-bots ===');
  const state = await Story.createSession({
    seed: 'V344-ENSEMBLE',
    skipOpening: true,
    actors: [
      { id: 'player', name: '大胡子洛夫斯基', controller: 'human', seatId: 'seat_0', daoPath: '散修' },
      { id: 'han', name: '韩照野', controller: 'bot', seatId: 'seat_1', daoPath: '剑修' },
      { id: 'shen', name: '沈青萝', controller: 'bot', seatId: 'seat_2', daoPath: '丹道' },
      { id: 'gu', name: '顾长风', controller: 'bot', seatId: 'seat_3', daoPath: '阵法' },
    ],
  });
  const scene = {
    sceneId: 'trial_gate', locationId: 'trial_gate', locationName: '青霄别院·试炼门前',
    timeOfDay: '黄昏', weather: '阴云', pressure: 2,
    visibleEntities: [{ id: 'trial_token', name: '试炼令牌', kind: 'prop' }],
    exits: [], availableAssets: [], activeThreadIds: [],
  };
  state.story.currentScene = scene;
  const envelope = {
    turnId: 'turn_0001', elapsedTime: { value: 1, unit: '刻' }, publicDelta: [], interactions: [],
    actions: [
      { actorId: 'player', category: 'rest', source: 'custom', rawText: '在火盆边稍作休息', targetType: 'self', targetId: 'player', targetName: '大胡子洛夫斯基', outcome: 'quiet_success', gains: [], costs: [], publicEffects: [] },
      { actorId: 'han', category: 'observe', source: 'choice', rawText: '观察试炼令牌', targetType: 'prop', targetId: 'trial_token', targetName: '试炼令牌', outcome: 'success', gains: [], costs: [], publicEffects: [] },
      { actorId: 'shen', category: 'aid', source: 'choice', rawText: '帮助大胡子洛夫斯基', targetType: 'actor', targetId: 'player', targetName: '大胡子洛夫斯基', outcome: 'success', gains: [], costs: [], publicEffects: [] },
      { actorId: 'gu', category: 'investigate', source: 'choice', rawText: '调查试炼令牌', targetType: 'prop', targetId: 'trial_token', targetName: '试炼令牌', outcome: 'success', gains: [], costs: [], publicEffects: [] },
    ],
  };

  const brief = Story.Narration.buildBrief(state, scene, envelope, null, scene);
  const contract = brief.turnContract;
  ok('真人行动仍单独进入硬事实契约', contract.mustRenderFacts.filter(f => f.kind === 'action').length === 1);
  ok('三名机器人行动进入同伴行动层', contract.supportingActionFacts.length === 3);
  ok('段落规划包含全部机器人存在感', brief.qualityPlan.presencePlan.length === 3 && brief.qualityPlan.paragraphPlan.some(p => p.role === 'ensemble'));
  ok('NarrativePacket 暴露机器人行动', brief.narrativePacket.supportingActions.length === 3);

  const ctx = Story.Narration.buildPublicContext(state, brief, brief.projectedState, brief.qualityPlan);
  ok('公共 AI 上下文包含四名角色行动', ctx.chosenActions.length === 4);
  ok('机器人行动标记为 companion', ctx.chosenActions.filter(a => a.narrativeRole === 'companion').length === 3);

  const omitted = { title: '独行', chapter: '大胡子洛夫斯基在火盆边坐下休息，呼吸渐渐平稳，片刻后又睁开眼。' };
  const missing = Story.Narration.validateSupportingActionFacts(omitted, contract);
  ok('遗漏机器人时返回专用存在感错误', missing && missing.code === 'MISSING_BOT_PRESENCE');
  ok('机器人存在感属于一次修复项而非硬阻断', Story.Narration.ValidationPolicy.level(missing) === 'repair');

  const ensemble = {
    title: '门前众生',
    chapter: '大胡子洛夫斯基在火盆边坐下休息，呼吸渐渐平稳。韩照野俯身观察试炼令牌的铜纹。沈青萝走来帮助大胡子洛夫斯基稳住气息。顾长风则接过令牌仔细调查边缘的阵纹。',
  };
  ok('每名机器人有行动或反应时通过存在感校验', Story.Narration.validateSupportingActionFacts(ensemble, contract) === null);

  const room = Room.coordinator.createRoom({ hostName: '房主', mode: 'local-hotseat', seed: 'BOT-CUSTOM' });
  const bot = Room.coordinator.addBotSeat(room.roomId, 1, {
    profileId: 'wanderer',
    actorTemplate: {
      id: 'dreamer', name: '闻梦生', identity: '梦境行脚医', daoPath: '梦修',
      personalityTags: ['温和', '警觉'], appearance: '银发，眼下有淡青梦纹',
      publicWish: '找到失落的清醒之梦', background: '曾替一座城的人保管梦境。',
      speechStyle: '声音很轻，常以梦境作比', hiddenFate: '每次入梦都会忘记一个名字',
    },
  });
  ok('添加机器人可保存自由道途', bot.actorSetup.daoPath === '梦修');
  ok('添加机器人可保存外貌、背景与说话风格', bot.actorSetup.appearance.indexOf('银发') >= 0 && bot.actorSetup.background.indexOf('保管梦境') >= 0 && bot.actorSetup.speechStyle.indexOf('梦境') >= 0);
  ok('机器人席位显示自定义角色名', bot.displayName === '闻梦生');

  const edited = Room.coordinator.configureBotSeat(room.roomId, bot.seatId, {
    profileId: 'guardian',
    actorTemplate: Object.assign({}, bot.actorSetup, { daoPath: '机关道', personalityTags: ['寡言', '护短'] }),
  });
  ok('大厅可再次修改机器人完整立命', edited.actorSetup.daoPath === '机关道' && edited.controller.botProfileId === 'guardian');

  const customState = await Story.createSession({ seed: 'CUSTOM-DAO', skipOpening: true, actors: [Object.assign({}, edited.actorSetup, { controller: 'bot', seatId: edited.seatId })] });
  ok('自定义角色细节进入 StoryState', customState.actors[0].appearance.indexOf('银发') >= 0 && customState.actors[0].background.indexOf('保管梦境') >= 0);
  ok('未知道途不会被改写成内置道途', customState.actors[0].daoPath === '机关道' && Story.CharacterGenesis._GENERIC_STARS.indexOf(customState.actors[0].fatePlate.originStar) >= 0);

  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  ok('机器人弹窗提供自由道途和细节字段', /id="bot-dao"/.test(html) && /id="bot-appearance"/.test(html) && /id="bot-background"/.test(html));
  ok('自动补齐机器人可在大厅继续自定义', /data-act="editbot"/.test(html) && /configureBotSeat/.test(html));

  console.log('Ensemble/bot customization passed ' + pass + ' / failed ' + fail);
  if (fail) process.exitCode = 1;
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
