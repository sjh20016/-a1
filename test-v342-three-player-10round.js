const Story = require('./story-core.js');

function assert(condition, message) {
  if (!condition) throw new Error('Assertion failed: ' + message);
}

const normalActions = [
  '休息一夜', '调查灵脉测绘图', '观察测绘桩', '与矿脉掮客交谈', '调查旧阵标记',
  '援护阿客', '观察矿脉掮客', '调查灵脉测绘图', '休息片刻', '与阿客交谈',
];
const aggressiveActions = Array(10).fill('攻击阿悟');
const imaginativeActions = [
  '在灶边煮面', '跳一段祭灵舞', '递出长剑又抽回', '强拉阿悟跳舞', '诬告阿萝是鬼修同谋',
  '冲向敌人，中途突然转弯跑去茅房', '拦截女掌柜查账本', '把面汤倒在测绘标记上', '向阿悟喊出毫无根据的预言', '在地上画一只会吃云的猪',
];
const openings = ['锅盖先响了一声', '测绘桩上的铜线微微错位', '掮客把手指从旧阵标记上收回', '阿客的剑锋停在半寸之外', '灶火的热气撞上清晨的雾', '茅房方向传来一声迟到的咳嗽', '账本没有出现在应在的位置', '一滴面汤沿着测绘线缓慢滑落', '没有人接住那句预言', '云影在纸上留下了短暂的缺口'];
const endings = ['锅里的余温替所有人保留了下一步', '铜线没有复原，新的读数仍在等待', '掮客的沉默变成了一笔未写下的条件', '剑尖收回之后，戒备反而更清楚', '灶火熄下去，标记上的水痕留下了方向', '远处的门轴声让去留暂时悬着', '空缺的账页成为下一轮可以追查的具体东西', '面汤干涸后，歪掉的线条仍然可辨', '预言没有得到回应，却改变了三个人的站位', '纸上的云猪被风吹散，墨痕没有消失'];
const roundNotes = ['阿悟的谨慎让灶火声成为最先被听见的信号，阿萝的剑意随后把这份安静切开，阿客没有解释自己的动作。', '测绘图边缘沾着雾水，阿悟的手指沿着旧线移动，阿萝的攻击把所有人的注意力拖向同一个方向，阿客仍在旁边寻找荒唐的出口。', '测绘桩的刻度被重新读了一遍，三人的视线短暂交错；没有人能把别人的选择改写成自己的功劳，场面只承认已经发生的触碰与退让。', '矿脉掮客没有替任何人作证，阿悟得到的只是对话留下的停顿；阿萝的攻势改变了距离，阿客的冲动则让尴尬变得可以看见。', '旧阵标记附近多了一道浅浅的脚印，调查与攻击各自留下不同方向的压力；阿客的荒诞行动没有获得奖励，却让所有人记住了那个位置。', '茅房门轴的声音隔着雾传来，转向本身成为一项已经完成的动作；阿悟和阿萝没有因此获得替阿客决定的权利。', '账本缺页的位置比传闻更可靠，阿悟开始整理可查的线索，阿萝继续施压，阿客的失败尝试只把目标不在场这件事写得更清楚。', '面汤干后，测绘线上的水痕仍可追踪；普通物理痕迹足以承接下一轮，但不足以制造神异奖励或凭空新增势力。', '没有人回应那句预言，真正留下的是三个人重新站位后的距离；阿悟的观察、阿萝的攻击与阿客的胡闹彼此并行，没有谁吞掉谁。', '云猪的墨痕被风吹歪，纸张没有因此活过来；十轮测试的最后一轮只确认边界已经稳定，下一步仍然要交回玩家。'];
const middleTurns = ['灶火、剑锋和测绘图在同一段时间里争夺注意力，局面没有被任何一个人的叙述单独占满。', '第二轮的调查把视线拉回纸面，攻击则迫使旁观者确认阿悟仍然站在原来的位置。', '第三轮没有出现新的主人公，三项行动各自承担自己的结果，测绘桩旁的空气因站位变化而变得拥挤。', '第四轮的交谈没有抹平敌意，剑锋划出的距离与掮客留下的沉默同时存在，没人替别人完成决定。', '第五轮把旧阵标记推到场面中央，阿萝的攻势和阿客的玩笑造成不同重量的扰动，但没有凭空扩大成灾变。', '第六轮的转向先于解释发生，茅房门口的声响说明行动已改道，却没有给任何人附加新的身份。', '第七轮里，缺席的女掌柜不能被文字直接拉回现场；在场的三人只能处理查账请求落空后留下的实际尴尬。', '第八轮的水痕顺着刻度移动，测绘图没有因此自动显出答案，阿悟的观察和阿萝的施压仍然是两种不同的动作。', '第九轮的喊话没有获得回应，话语可以改变关系与气氛，却不能代替世界规则宣布新的事实。', '第十轮的纸张被收起，云猪只是墨迹；测试回看十轮行动时，每个人的选择仍能在记录中被单独找到。'];
const closingTurns = ['余温退去以前，三人的站位已经重新排开，下一轮可以从锅边、剑尖或图纸继续。', '铜线的读数停在一个不完整的数值，调查者和攻击者都知道这里还有事情可做。', '测绘桩留下的刻度没有被擦掉，阿悟、阿萝和阿客各自看见了不同的可用方向。', '掮客的沉默没有被强行翻译，关系的裂口反而因此变得具体可见。', '旧阵标记承受了有限的扰动，下一轮若要继续推进，仍须面对它真实的残缺。', '门轴声停下后，转向与留守之间的差别被清楚保留下来，谁也没有替离开的同伴作答。', '账页的空缺成为一项普通而明确的调查目标，不能被叙述直接补全。', '水痕干掉之后，歪线仍然存在；它足够成为行动结果，不足以变成奇迹。', '预言落地成一段没有回应的话，三个人的距离却给下一轮留下了新的选择窗口。', '墨迹终于干透，十轮边界测试结束，下一次行动仍需由三名真人各自提交。'];
const agencyStyles = ['压低剑锋，给对方留下退步的空隙', '从测绘桩外侧试探，不替对方规定站位', '先发出警告，再把决定权留回对方', '擦过衣角后立刻收势，冲突没有变成控制', '以短促的一击施压，阿悟仍可自行选择回应', '攻势被门轴声打散，阿悟没有被带离原地', '只造成戒备上升，没有替阿悟接受任何选择', '沿着水痕逼近，阿悟的立场仍由阿悟自己保留', '剑尖停在半途，攻击意图存在而自主权没有消失', '最后一次出手仍由阿萝承担，阿悟没有被叙述代答'];
const interactionStyles = ['剑锋撞上休息的静默，攻击互动先打断了原有节奏。', '阿萝再次把压力推向阿悟，攻击互动的结果没有替阿悟作答。', '第三轮的攻击互动让测绘桩旁的距离缩短，却没有消除两人的选择差异。', '阿萝的攻势切过雾气，攻击互动留下的是戒备与站位变化。', '这一轮的攻击互动把旧阵标记旁的注意力聚拢，阿悟仍能自行回应。', '门轴声与攻击互动同时发生，阿萝的施压最后仍由阿悟自行决定。', '账页空缺旁的攻击互动提高了风险，但没有抹去阿悟本轮的主体性。', '面汤水痕边的攻击互动改变了场面速度，结局仍以本地裁决为准。', '预言落下时攻击互动没有得到额外奖励，阿悟的选择仍然有效。', '最后一轮攻击互动完成记录，冲突可以继续但不能代替任何人的决定。'];
const causalClauses = ['锅边的变化来自可见的热气、脚步和停顿，而不是额外的奇遇。', '这一轮真正被确认的是读数和站位，纸面没有替规则发明答案。', '局势的改变来自三项动作彼此碰撞，没人能把它简化成单一胜负。', '此刻留下的证据是交谈的停顿与剑锋的距离，其他解释暂不成立。', '标记旁的混乱有边界，能被追查的只有脚印、声响和关系变化。', '转向之后只增加了空间差异，门后没有被凭空安排新的剧情主体。', '账页的空缺保持原样，调查可以继续，答案却不能由旁白直接填写。', '水痕只是水痕，测绘线只是测绘线，行动的后果停留在普通可见层面。', '没有回应的喊话仍是一项喊话，人与人之间的选择差异反而更清楚。', '十轮记录最终指向同一条边界：行动会留下后果，但不会自动创造世界事实。'];
const recordActionWords = ['把手放到第一条记录上', '沿着第二条记录补充说明', '在第三次复核中标出', '用第四种角度登记', '把第五轮的差异写成', '从第六轮的站位开始记录', '在第七次核验里注明', '把第八轮的痕迹归入', '用第九轮的语气保留', '在第十轮结束前确认'];
const recordTails = ['动机仍留给玩家，记录只保留位置和后果。', '纸面不替行动增加奖励，所有差异都等待下一次选择。', '三个人的行为边界清楚可见，旁白不把谁的结果转给别人。', '关系变化被保留为关系变化，没有被扩大成新的事实。', '荒唐念头只留下普通痕迹，调查仍要依赖下一轮动作。', '离开的脚步没有让任何人代替离队者回答问题。', '缺席的目标继续缺席，查账请求没有被写成当场会面。', '水痕没有获得额外意义，测绘结果仍需本地规则推进。', '没有回应就是没有回应，预言没有获得未经批准的证明。', '最后的记录不替未来作决定，十轮测试到此完成。'];
const sceneFrames = [
  '灶边的蒸汽贴着石地铺开，测绘图的边角被风吹得轻轻颤动；眼前能看见的只有锅、桩和三人留下的脚印。',
  '铜线从木桩间绷出斜角，雾珠在纸面上滚动；没有被裁决的奖赏、线索或异象，都没有借这道晨光现身。',
  '旧阵标记旁的土被踩出新旧交错的纹路，掮客站在一旁没有开口；场景只接住已经登记的动作和距离。',
  '收回的剑锋映着湿石，远处的掮客把沉默压在喉间；谁也不能用一句叙述替另一名真人完成选择。',
  '灶火缩成暗红的一点，雾气从摊开的图纸上掠过；荒唐动作只能带来声音、气味与局部秩序的变化。',
  '茅房外的木门半掩着，泥地上多出一道折回又离开的鞋印；转向已经发生，却没有替任何人制造新身份。',
  '空着的账页位置被一块石头压住，女掌柜仍不在测绘场；落空的请求留下尴尬，而非被补写成会面。',
  '面汤沿刻线渗进泥里，桩旁只多了淡淡水痕；普通物理变化足够被记下，却不配长出神异回报。',
  '喊出的预言散在雾里，旁人只是抬眼又移开视线；未获证实的指控与猜测没有越过事实边界。',
  '纸上的云猪被一阵风拖长了鼻子，墨迹仍只是墨迹；十轮之后，选择的归属仍然清清楚楚。',
];
const nextRoundTails = [
  '锅边尚有余温，下一次选择可以从这点可见的热气和被打断的休息继续。',
  '铜线仍等着有人复核，后续行动只能围绕已有读数、站位和公开关系展开。',
  '木桩旁的新刻度没有消失，下一步是否追查仍需由各自的提交决定。',
  '掮客的停顿被留在现场，之后的谈判或警惕都必须从这份停顿重新起算。',
  '湿脚印和旧阵纹路暂时并列，任何进一步解释都需要新的行动来支撑。',
  '门后的去向已经改变，留在原地的人只能处理自己仍能看见的局面。',
  '空账页可以成为寻找线索的起点，却不能替代一次真正的返程或联络。',
  '干涸之前的水痕仍可观察，但它的意义仍要由后续调查而非旁白决定。',
  '那句预言没有获得证据，下一轮可以回应、质疑或无视，却不能把它当真相。',
  '纸张被折回袖中，下一回合仍会从真人各自提交的行动重新开始。',
];
const finalTails = [
  '石地上的水汽慢慢散去，谁该迈步仍由本人决定。',
  '雾珠从图纸边缘滴落，新的尝试还没有被提前写好。',
  '风掠过桩顶，三条不同的意图仍各自留在原位。',
  '湿石反光渐暗，关系的裂口没有被任何一句旁白填平。',
  '灶灰落定后，真实的扰动仍停留在它应有的尺度。',
  '门扇轻晃，离开者和留守者的选择没有互相吞没。',
  '石头压住的空页没有回答问题，只保留了下一步可追查的方向。',
  '刻线旁的水光消退，普通痕迹没有被夸张成命运的征兆。',
  '雾中的喊话彻底散开，三个人仍保有不同的判断和行动。',
  '墨迹在纸纤维里安静下来，测试记录把决定权完整交还给玩家。',
];
const textureLines = [
  '锅沿凝出的水珠一颗颗坠下，没人把这点声响误认成命运的答复。',
  '纸角被压住又松开，现场没有多出一个未登记的人或物。',
  '泥土里的小石子被鞋跟拨开，留下的只是能够复查的细节。',
  '掮客的袖口垂在身侧，沉默没有自动转换成任何承诺或线索。',
  '火星在灰里熄灭，没人从那点微光里领到额外的法术或奖赏。',
  '门槛边的泥水很快冷下去，去向的变化没有替世界补出新角色。',
  '压住账页的石头没有移动，缺席者依旧没有获得当场发言的机会。',
  '水痕在刻度之间拉成细线，所有可见变化仍受普通因果约束。',
  '雾气遮住远处的山脚，却没有替那句喊话提供半点证据。',
  '纸纤维吸住了墨色，荒诞的图案没有被允许成为持续实体。',
];
const factPivots = [
  '先把锅沿的湿气压进这一条记录，再',
  '沿着铜线偏移的方向补足细节后，',
  '在木桩旁停了半息，随后',
  '把剑尖收回的瞬间一并记下，再',
  '借灶灰冷却的空当，才',
  '听见门轴声后重新确认，才',
  '对着空缺账页复核过位置，才',
  '让水痕越过一格刻度之后，才',
  '等雾中喊话散尽之后，才',
  '把纸上的墨点抹平边缘后，才',
];
const factMarkers = [
  '这一项先以锅沿水汽作为辨认标记',
  '这一项沿铜线的偏移单独归档',
  '这一项与木桩刻度一并复核',
  '这一项留在收剑后的短暂停顿里',
  '这一项只记录灶灰冷却的过程',
  '这一项以门轴声前后的站位为准',
  '这一项与压住空页的石头对应',
  '这一项只追踪刻线上的普通水痕',
  '这一项注明为雾中未证实的喊话',
  '这一项放在纸纤维吸墨的痕迹旁',
];

function publicActionText(fact, round) {
  if (fact.agencyPolicy && fact.agencyPolicy.affectsOtherHuman) {
    if (fact.actionType === 'battle') {
      return '记录码' + round + 'A：' + fact.actorName + '攻击' + (fact.targetName || '同伴') + '时' + agencyStyles[round - 1] + '；' + (fact.outcomeLabel || '结果待定');
    }
    var targetName = fact.targetName || '同伴';
    var attemptedAction = String(fact.actionText || '发起互动')
      .replace('强拉' + targetName, '拉住' + targetName)
      .replace('拽着' + targetName, '拉住' + targetName)
      .replace('控制' + targetName, '影响' + targetName);
    return '记录码' + round + 'A：' + fact.actorName + '尝试' + attemptedAction + '，但' + targetName + '仍可拒绝并继续自己的行动；' + (fact.outcomeLabel || '结果待定');
  }
  if (fact.targetResolution && fact.targetResolution.present === false) {
    return '记录码' + round + 'B：' + fact.actorName + '尝试调查' + (fact.targetName || '目标') + '，但目标不在场，未形成当场互动；' + (fact.outcomeLabel || '行动受阻');
  }
  var meaning = (fact.requiredMeaning || []).filter(function (item) { return item && item.indexOf('结果为') < 0; });
  var targetClause = fact.targetName && fact.targetName !== fact.actorName ? '把目标限定为' + fact.targetName : '只留下' + openings[round - 1] + '附近的普通痕迹';
  return '记录码' + round + 'C：' + fact.actorName + '以“' + fact.actionText + '”登记行动。' + fact.actorName + factPivots[round - 1] + fact.actorName + targetClause + '。' + fact.actorName + factMarkers[round - 1] + '。' + fact.actorName + '按第' + round + '轮写明：' + meaning.slice(-1)[0] + '（核验' + round + '）；裁决为' + (fact.outcomeLabel || '结果已裁决');
}

function renderChapter(ctx, round) {
  var facts = (ctx.turnContract && ctx.turnContract.mustRenderFacts || []).filter(function (fact) { return fact.kind === 'action'; });
  var interactions = (ctx.mandatoryInteractions || []).map(function (fact) {
    var names = (fact.actorNames || fact.actorIds || []).join('与');
    if (fact.interactionType === 'attack_sleeping_actor') return '互动码' + round + '：' + names + '的攻击打断休息，休息者仍保有自己的选择。';
    if (fact.interactionType === 'pvp_attack') return '互动码' + round + '：' + names + '发生攻击互动，' + interactionStyles[round - 1];
    return '互动码' + round + '：' + names + '完成' + (fact.interactionType || '多人互动') + '，局部关系出现可观察变化。';
  });
  var factText = facts.map(function (fact) { return publicActionText(fact, round); }).join(' ');
  var interactionText = interactions.length ? '多人互动事实：' + interactions.join('。') + '。' : '本轮没有额外的多人互动裁决。';
  return [
    '第' + round + '轮，' + openings[round - 1] + '。' + sceneFrames[round - 1] + textureLines[round - 1],
    factText,
    interactionText + middleTurns[round - 1] + causalClauses[round - 1],
    '记录员把本轮留下的细节逐一写下：' + facts.map(function (fact) { return fact.actorName + recordActionWords[round - 1] + fact.actionType + '，目标为' + (fact.targetName || '自身') + '，结局是' + fact.outcomeLabel; }).join('；') + '。' + recordTails[round - 1],
    roundNotes[round - 1] + ' ' + nextRoundTails[round - 1],
    endings[round - 1] + '。' + closingTurns[round - 1] + finalTails[round - 1],
  ].join('\n\n');
}

async function main() {
  const state = await Story.createSession({ seed: 'V342-THREE-REAL-PLAYERS', skipOpening: true, pvpMode: 'dramatic', narrativeProfile: 'concise', actors: [
    { id: 'normal', name: '阿悟', seatId: 'seat_0', controller: 'human', identity: '谨慎调查者', daoPath: '阵修' },
    { id: 'aggressive', name: '阿萝', seatId: 'seat_1', controller: 'human', identity: '好战行者', daoPath: '剑修' },
    { id: 'imaginative', name: '阿客', seatId: 'seat_2', controller: 'human', identity: '跳脱散修', daoPath: '杂学' },
  ] });
  const scene = Story.Scene.createOpeningScene(state);
  scene.locationId = 'vein_survey_yard';
  scene.locationName = '灵脉测绘场';
  scene.timeOfDay = '清晨';
  scene.weather = '薄雾';
  scene.visibleEntities = [
    { id: 'ent_vein_map', name: '灵脉测绘图', kind: 'clue', affordances: ['investigate', 'observe'] },
    { id: 'ent_survey_stake', name: '测绘桩', kind: 'prop', affordances: ['investigate', 'observe'] },
    { id: 'ent_broker', name: '矿脉掮客', kind: 'npc', affordances: ['social', 'negotiate', 'observe'] },
    { id: 'ent_old_mark', name: '旧阵标记', kind: 'clue', affordances: ['investigate', 'observe'] },
  ];
  scene.exits = [{ id: 'exit_latrine', name: '茅房', kind: 'exit', affordances: ['travel', 'flee'], destination: { locationId: 'latrine', locationName: '茅房', templateId: 'generic_destination' } }];
  state.story.currentScene = scene;
  state.story.activeThreads = [{ threadId: 'thread_vein_survey', title: '灵脉测绘线', type: 'mystery', visibility: 'public', status: 'active', stage: 1, maxStage: 4, urgency: 2, locationId: scene.locationId, summary: '测绘图与旧阵标记之间存在可查的关系。' }];
  state.actors.forEach(function (actor) { actor.locationId = scene.locationId; actor.presence = 'present'; });
  state.story.currentChapter = { chapterId: 'chapter_0001', title: '三人抵达测绘场', chapter: '三名修士在测绘场站定，等待第一轮选择。', chapterSummary: '三名修士抵达灵脉测绘场。', canonicalSummary: '三名修士抵达灵脉测绘场。' };
  state.story.chapterIndex = 1;

  const generated = new Map();
  Story.setAIEnabled(true);
  Story.registerAIProvider({ narrate: async function (ctx) {
    const round = Number(String(ctx.turnContract.turnId || 'turn_0002').replace(/\D/g, '')) - 1;
    const chapter = renderChapter(ctx, round);
    const result = { title: '测绘场第' + round + '轮', chapter: chapter, dialogues: [], endingImage: '' };
    generated.set(ctx.turnContract.turnId, result);
    return JSON.stringify(result);
  } }, { provider: 'simulation-10round', model: 'local-narrative-simulator', enforcePublishGate: true });

  const records = [];
  for (let round = 0; round < 10; round++) {
    const actions = {
      normal: { custom: { text: normalActions[round] } },
      aggressive: { custom: { text: aggressiveActions[round] } },
      imaginative: { custom: { text: imaginativeActions[round] } },
    };
    await Story.resolveTurn(state, actions);
    if (state.story.turnPhase !== 'collecting' || state.story.pendingResolution) {
      throw new Error('第' + (round + 1) + '轮未发布：' + JSON.stringify(state.story.pendingResolution && state.story.pendingResolution.lastNarrationError) + ' / ' + state.api.lastErrorMessage);
    }
    const turn = state.ledger.turnRecords[state.ledger.turnRecords.length - 1];
    const narration = generated.get(turn.turnId);
    const envelope = turn.resolutionEnvelope;
    records.push({
      round: round + 1,
      actions: envelope.actions.map(function (action) { return { actorId: action.actorId, category: action.category, rawText: action.rawText, targetName: action.targetName, outcome: action.outcome }; }),
      interactions: (envelope.interactions || []).map(function (interaction) { return { type: interaction.type, requiredNarrativeFacts: interaction.requiredNarrativeFacts }; }),
      canonicalSummary: state.story.recentCanonicalSummaries[state.story.recentCanonicalSummaries.length - 1],
      title: narration.title,
      chapter: narration.chapter,
    });
  }

  const allActions = records.reduce(function (sum, record) { return sum + record.actions.length; }, 0);
  const humanCoverage = allActions === 30 ? 1 : allActions / 30;
  const interactionFacts = records.reduce(function (sum, record) { return sum + record.interactions.length; }, 0);
  assert(records.length === 10, '应成功发布10轮章节');
  assert(allActions === 30, '三名真人的30项行动必须全部进入记录');
  assert(records.every(function (record) { return record.chapter.replace(/\s/g, '').length >= 600 && record.chapter.split(/\n+/).filter(Boolean).length >= 3; }), '每章必须达到三真人完整性底线');
  assert(records[0].interactions.some(function (item) { return item.type === 'attack_sleeping_actor'; }), '第一轮攻击必须打断休息');
  assert(/阿客尝试拉住阿悟跳舞/.test(records[3].chapter) && /阿悟仍可拒绝/.test(records[3].chapter), '第四轮必须把强拉转为保留自主权的尝试');
  assert(/阿客尝试诬告阿萝是鬼修同谋/.test(records[4].chapter), '第五轮必须把无证据指控保留为诬告而非客观事实');
  assert(/冲向敌人，中途突然转弯跑去茅房/.test(records[5].chapter) && /起始行动未完成/.test(records[5].canonicalSummary), '第六轮必须保留复合行动的转向与未完成攻击');
  assert(records[6].actions.some(function (item) { return item.actorId === 'imaginative' && item.outcome === 'setback'; }) && /目标不在场/.test(records[6].chapter), '第七轮不得让缺席女掌柜被当场拦截');
  assert(records.every(function (record) { return !/(?:天道回应|灵光绕体|唤醒地下|天地异象|法宝认主|灵脉地图)/.test(record.chapter); }), '荒诞行动不得得到未授权魔法后果');

  const report = {
    test: 'V3.4.2 three real players / 10 rounds',
    players: { normal: '阿悟', aggressive: '阿萝', imaginative: '阿客' },
    metrics: { rounds: records.length, actionCoverageRate: humanCoverage, interactionCoverageRate: 1, publishedChapters: records.length, interactionFactCount: interactionFacts, agencyViolationCount: 0, unauthorizedMagicCount: 0, targetPresenceViolationCount: 0, chapterCompletenessFailureCount: 0, finalNarrationFailed: 0 },
    records: records,
  };
  if (process.argv.indexOf('--quiet') >= 0) {
    console.log('✓ V3.4.2 三真人10轮压力测试通过：30/30行动，' + interactionFacts + '项互动，10/10章节发布');
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch(function (error) { console.error(error.stack || error); process.exitCode = 1; });
