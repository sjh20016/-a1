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
      // 成功：返回 JSON 字符串，包含递增序号便于断言"重试确实再次调用"
      var payload = {
        title: title + '·第' + calls + '回',
        chapter: chapter,
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

module.exports = {
  DEFAULT_CHAPTER: DEFAULT_CHAPTER,
  DEFAULT_TITLE: DEFAULT_TITLE,
  createMockProvider: createMockProvider,
  setupMockAI: setupMockAI,
};
