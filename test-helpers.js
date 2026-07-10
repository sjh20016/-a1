/* test-helpers.js — V3.3 测试公共工具
 *
 * V3.3 废除离线叙事（assembleOffline 已删除），AI 成为必需组件。
 * 原先依赖 Story.setAIEnabled(false) 跑全程的测试，现在必须改用 mock provider：
 *
 *   const { setupMockAI, createMockProvider } = require('./test-helpers.js');
 *   setupMockAI(Story);                       // 启用 AI + 注册默认合法 mock
 *   const state = await Story.startGame(...); // 开局正常推进
 *
 * 可配置失败序列以测试事务化路径：
 *   const p = setupMockAI(Story, { failUntil: 1, failMode: 'null' }); // 首次失败
 *   // ... 触发 awaiting_narration ...
 *   ok(p.calls() === 1, '首次调用失败');
 *
 * mock provider.narrate(ctx) 返回 JSON 字符串（与真实 Provider 协议一致），
 * 经 Story.Provider.narrate 解析为 {title, chapter, ...} 对象。
 */

/** 默认合规章节正文（≥20 字通过 validateNarrationOnly；>100 字满足 V3 旧断言） */
var DEFAULT_CHAPTER =
  '雨落长街，剑气未散。众人立于檐下，听远处更鼓声声，心中各有计较。' +
  '这一夜的变故，将原本平静的行程撕开一道口子，前路愈发难以预料。' +
  '陆知微握紧腰间残剑，剑身微颤，似在回应夜色中某种未明的呼唤。' +
  '韩照野负手而立，目光如鹰隼般扫过街角暗影，低声道：此间有异，不可久留。' +
  '沈砚秋轻摇折扇，笑意不达眼底：异又如何，机缘常藏于险地。顾长青默然握紧药囊，' +
  '众人各怀心思，却都未肯先行退去。更鼓再响，雨势渐小，而暗流方才涌动。';

var DEFAULT_TITLE = '天机演章';

/**
 * 创建一个 mock AI Provider。
 * @param {object} opts
 *   - failUntil: 前N次调用返回失败（默认0，即永不失败）
 *   - failMode: 失败形态 'null'(返回null) | 'empty'(返回空串) | 'invalid'(字段不合规) | 'throw'(抛异常)
 *   - title: 成功时返回的标题（默认 '天机演章'）
 *   - chapter: 成功时返回的正文（默认 DEFAULT_CHAPTER）
 *   - delayMs: 每次调用前等待毫秒（默认0）
 * @returns {{narrate: Function, calls: Function, reset: Function}}
 */
function createMockProvider(opts) {
  opts = opts || {};
  var failUntil = opts.failUntil || 0;
  var failMode = opts.failMode || 'null';
  var title = opts.title || DEFAULT_TITLE;
  var chapter = opts.chapter || DEFAULT_CHAPTER;
  var delayMs = opts.delayMs || 0;
  var calls = 0;

  function fail() {
    if (failMode === 'throw') throw new Error('mock narrate fail #' + calls);
    if (failMode === 'empty') return '';
    if (failMode === 'invalid') return JSON.stringify({ title: 'T', chapter: '短' });
    return null; // 'null'
  }

  return {
    narrate: async function (ctx) {
      calls++;
      if (delayMs) await new Promise(function (r) { setTimeout(r, delayMs); });
      if (calls <= failUntil) return fail();
      var resolvedChapter = chapter;
      // V3.3.6：默认测试 Provider 应像合规模型一样落实开局锚点；显式传入 chapter 时不自动修补，便于覆盖失败测试。
      if (!opts.chapter && ctx && ctx.brief && ctx.brief.isOpening && Array.isArray(ctx.brief.openingAnchors)) {
        resolvedChapter += '开局锚点：' + ctx.brief.openingAnchors.slice(0, 8).join('、') + '。';
      }
      // 成功：返回 JSON 字符串，包含递增序号便于断言"重试确实再次调用"
      var payload = {
        title: title + '·第' + calls + '回',
        chapter: resolvedChapter,
        dialogues: [],
        endingImage: '',
      };
      return JSON.stringify(payload);
    },
    calls: function () { return calls; },
    reset: function () { calls = 0; },
  };
}

/**
 * 一行启用 mock AI：setAIEnabled(true) + registerAIProvider。
 * 返回 mock provider 实例（含 calls() 计数器）。
 */
function setupMockAI(Story, opts) {
  Story.setAIEnabled(true);
  var p = createMockProvider(opts);
  Story.registerAIProvider(p, { provider: 'mock', model: (opts && opts.model) || 'mock-model' });
  return p;
}

/** 变体章节文本（用于长线质量测试，避免 Mock 返回完全相同文本） */
var VARIANT_CHAPTERS = [
  '雨落长街，剑气未散。众人立于檐下，听远处更鼓声声，心中各有计较。',
  '风起古道，尘沙扑面。韩照野勒马回望，眼角掠过一丝不易察觉的锐光。',
  '客栈后院，柴门半掩。沈青萝蹲身拾起一枚沾血的铜钱，指尖微微发颤。',
  '夜色如墨，边城更鼓敲过三响。顾长风独自立在城墙残垣上，手中阵盘轻颤。',
  '翌日清晨，薄雾未散。陆知微推开窗扉，院中石桌上多了一封未署名的信笺。',
  '商队远去，辙痕在黄沙中渐渐模糊，只余几缕烟尘在风中盘旋不散。',
  '密室深处，烛火摇曳。残剑在黑暗中发出低微的嗡鸣，似在回应某种古老的呼唤。',
  '山道崎岖，松涛阵阵。一行人沿着石阶拾级而上，雾中隐约可见一座破败的山门。',
  '暴雨倾盆，雷声滚滚。众人躲进路边废弃的庙宇，却见供桌上放着三盏未灭的油灯。',
  '晨光熹微，露水沾衣。陆知微盘膝坐于石上，丹田中一缕气机缓缓流转，渐入佳境。',
  '集市喧嚣，人来人往。一个戴着斗笠的身影从人群中穿过，腰间佩剑与残剑隐隐共鸣。',
  '夜深人静，星河低垂。众人围坐篝火旁，各怀心事，只有柴火噼啪声打破寂静。',
];

var VARIANT_TITLES = [
  '天机演章', '古道尘烟', '后院惊变', '边城残垣', '无名信笺',
  '商队远影', '密室低语', '山门残照', '破庙孤灯', '晨修悟道',
  '斗笠过客', '星河夜话',
];

/**
 * 创建变体 Mock Provider（每章返回不同文本，用于长线质量测试）
 */
function createVariantMockProvider(opts) {
  opts = opts || {};
  var calls = 0;
  return {
    narrate: async function (ctx) {
      calls++;
      var idx = (calls - 1) % VARIANT_CHAPTERS.length;
      var anchors = ctx && ctx.brief && ctx.brief.openingAnchors || [];
      var payload = {
        title: VARIANT_TITLES[idx] + '·第' + calls + '回',
        chapter: VARIANT_CHAPTERS[idx] + '这一夜变故横生，前路愈发难以预料。众人各怀心思，却都未肯先行退去。更鼓再响，而暗流方才涌动。' +
          (anchors.length ? '开局锚点：' + anchors.slice(0, 8).join('、') + '。' : ''),
        dialogues: [],
        endingImage: '',
      };
      return JSON.stringify(payload);
    },
    calls: function () { return calls; },
    reset: function () { calls = 0; },
  };
}

/**
 * 一行启用变体 mock AI（每章不同文本）
 */
function setupVariantMockAI(Story) {
  Story.setAIEnabled(true);
  var p = createVariantMockProvider();
  Story.registerAIProvider(p, { provider: 'mock-variant', model: 'mock-variant' });
  return p;
}

module.exports = {
  DEFAULT_CHAPTER: DEFAULT_CHAPTER,
  DEFAULT_TITLE: DEFAULT_TITLE,
  createMockProvider: createMockProvider,
  setupMockAI: setupMockAI,
  createVariantMockProvider: createVariantMockProvider,
  setupVariantMockAI: setupVariantMockAI,
};
