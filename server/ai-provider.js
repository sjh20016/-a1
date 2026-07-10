'use strict';

function endpointFor(baseUrl) {
  var base = String(baseUrl || '').replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
}

async function callOpenAICompatible(config, ctx) {
  if (!config.aiBaseUrl || !config.aiApiKey || !config.aiModel) {
    throw new Error('AI 服务端配置不完整：需要 AI_BASE_URL、AI_API_KEY、AI_MODEL');
  }
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, config.aiTimeoutMs || 60000);
  try {
    var response = await fetch(endpointFor(config.aiBaseUrl), {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + config.aiApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.aiModel,
        messages: [
          {
            role: 'system',
            content: '你是《修行局》的叙事 AI。只能返回严格 JSON：{title, chapter, dialogues, endingImage}。不得返回状态字段。正文必须落实 brief 中的 coverageAnchors/openingAnchors 与本地裁决结果。',
          },
          { role: 'user', content: JSON.stringify(ctx) },
        ],
        temperature: 0.8,
        max_tokens: 2400,
      }),
      signal: controller.signal,
    });
    var raw = await response.text();
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + raw.slice(0, 300));
    var payload;
    try { payload = JSON.parse(raw); }
    catch (error) { throw new Error('AI 响应不是 JSON'); }
    var content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
    if (!content) throw new Error('AI 响应缺少 choices[0].message.content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function registerServerAI(Story, config, logger, providerOverride) {
  Story.setAIEnabled(!!config.aiEnabled);
  if (config.aiEnabled && (!config.aiBaseUrl || !config.aiApiKey || !config.aiModel)) {
    logger.warn('AI_ENABLED=true，但服务端 AI 配置不完整；叙事请求将进入 narration_failed。');
  }
  var provider = providerOverride || {
    narrate: function (ctx) { return callOpenAICompatible(config, ctx); },
  };
  Story.registerAIProvider(provider, {
    provider: providerOverride ? 'server-injected' : 'server-openai-compatible',
    model: config.aiModel || 'unconfigured',
    base: config.aiBaseUrl || '',
  });
  return provider;
}

module.exports = {
  endpointFor: endpointFor,
  callOpenAICompatible: callOpenAICompatible,
  registerServerAI: registerServerAI,
};
