'use strict';

const fs = require('fs');
const path = require('path');

function endpointFor(baseUrl) {
  var base = String(baseUrl || '').replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
}

function quotaError(code, message) {
  var error = new Error(message || code);
  error.code = code;
  return error;
}

function createAiGate(config, logger) {
  var globalLimit = Math.max(1, Number(config.aiGlobalConcurrency) || 3);
  var roomLimit = Math.max(1, Number(config.aiRoomConcurrency) || 1);
  var dailyLimit = Math.max(1, Number(config.aiDailyBudget) || 200);
  var inFlight = 0;
  var roomInFlight = new Map();
  var queue = [];
  var day = new Date().toISOString().slice(0, 10);
  var callsToday = 0;
  var budgetFile = config.aiBudgetFile || path.join(path.dirname(config.roomSaveDir || './data/rooms'), 'ai-budget.json');
  try {
    var saved = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
    if (saved && saved.day === day) callsToday = Number(saved.calls) || 0;
  } catch (error) {}
  var stats = { inFlight: 0, queued: 0, callsToday: 0, quotaExceeded: 0, completed: 0, failed: 0 };

  function resetDayIfNeeded() {
    var nextDay = new Date().toISOString().slice(0, 10);
    if (nextDay !== day) { day = nextDay; callsToday = 0; saveBudget(); }
    stats.callsToday = callsToday;
  }

  function saveBudget() {
    try {
      fs.mkdirSync(path.dirname(budgetFile), { recursive: true });
      fs.writeFileSync(budgetFile, JSON.stringify({ day: day, calls: callsToday }), 'utf8');
    } catch (error) { if (logger && logger.warn) logger.warn('AI budget counter could not be persisted'); }
  }

  function roomKeyFor(ctx) {
    return String(ctx && (ctx.roomId || ctx.room && ctx.room.roomId || ctx.brief && ctx.brief.roomId) || 'shared');
  }

  function canRun(roomKey) {
    return inFlight < globalLimit && (roomInFlight.get(roomKey) || 0) < roomLimit;
  }

  function pump() {
    resetDayIfNeeded();
    for (var i = 0; i < queue.length; i++) {
      let item = queue[i];
      if (!canRun(item.roomKey)) continue;
      queue.splice(i, 1);
      inFlight++;
      roomInFlight.set(item.roomKey, (roomInFlight.get(item.roomKey) || 0) + 1);
      stats.inFlight = inFlight;
      stats.queued = queue.length;
      callsToday++;
      stats.callsToday = callsToday;
      saveBudget();
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(function () {
        inFlight--;
        var current = (roomInFlight.get(item.roomKey) || 1) - 1;
        if (current <= 0) roomInFlight.delete(item.roomKey); else roomInFlight.set(item.roomKey, current);
        stats.inFlight = inFlight;
        stats.completed++;
        pump();
      });
      i--;
    }
  }

  function run(ctx, task) {
    resetDayIfNeeded();
    if (callsToday + queue.length >= dailyLimit) {
      stats.quotaExceeded++;
      return Promise.reject(quotaError('AI_QUOTA_EXCEEDED', 'AI 测试额度已用尽'));
    }
    var roomKey = roomKeyFor(ctx);
    return new Promise(function (resolve, reject) {
      queue.push({ roomKey: roomKey, task: task, resolve: resolve, reject: reject });
      stats.queued = queue.length;
      pump();
    });
  }

  return { run: run, stats: stats, limits: { global: globalLimit, room: roomLimit, daily: dailyLimit } };
}

async function callOpenAICompatible(config, ctx, Story) {
  if (!config.aiBaseUrl || !config.aiApiKey || !config.aiModel) {
    throw new Error('AI 服务端配置不完整：需要 AI_BASE_URL、AI_API_KEY、AI_MODEL');
  }
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, config.aiTimeoutMs || 60000);
  try {
    Story = Story || require('../story-core.js');
    var requestBody = {
      model: config.aiModel,
      messages: [
        { role: 'system', content: Story.Narration.buildSystemPrompt(ctx) },
        { role: 'user', content: Story.Narration.buildUserPrompt(ctx) },
      ],
      temperature: config.aiTemperature == null ? 0.6 : config.aiTemperature,
      max_tokens: config.aiMaxTokens || 4096,
    };
    if (config.aiJsonMode) requestBody.response_format = { type: config.aiJsonMode };
    var response = await fetch(endpointFor(config.aiBaseUrl), {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + config.aiApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    var raw = await response.text();
    if (!response.ok) {
      var providerError = new Error('HTTP ' + response.status);
      providerError.code = response.status === 429 ? 'AI_QUOTA_EXCEEDED' : 'HTTP_' + response.status;
      throw providerError;
    }
    var payload;
    try { payload = JSON.parse(raw); }
    catch (error) { throw new Error('AI 响应不是 JSON'); }
    var choice = payload && payload.choices && payload.choices[0];
    var content = choice && choice.message && choice.message.content;
    if (!content) throw new Error('AI 响应缺少 choices[0].message.content');
    return { content: content, finishReason: choice.finish_reason || '' };
  } finally {
    clearTimeout(timer);
  }
}

function registerServerAI(Story, config, logger, providerOverride) {
  Story.setAIEnabled(!!config.aiEnabled);
  Story.ai.timeoutMs = config.aiTimeoutMs || 60000;
  if (config.aiEnabled && (!config.aiBaseUrl || !config.aiApiKey || !config.aiModel)) {
    logger.warn('AI_ENABLED=true，但服务端 AI 配置不完整；叙事请求将进入 narration_failed。');
  }
  var gate = createAiGate(config, logger);
  var rawProvider = providerOverride || {
    narrate: function (ctx) { return callOpenAICompatible(config, ctx, Story); },
  };
  var provider = {
    narrate: function (ctx) { return gate.run(ctx, function () { return rawProvider.narrate(ctx); }); },
  };
  Story.registerAIProvider(provider, {
    provider: providerOverride ? 'server-injected' : 'server-openai-compatible',
    model: config.aiModel || 'unconfigured',
    base: config.aiBaseUrl || '',
    enforcePublishGate: !providerOverride,
    testMode: !!providerOverride,
  });
  provider.metrics = gate.stats;
  provider.limits = gate.limits;
  return provider;
}

module.exports = {
  endpointFor: endpointFor,
  callOpenAICompatible: callOpenAICompatible,
  registerServerAI: registerServerAI,
};
