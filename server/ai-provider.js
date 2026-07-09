/**
 * server/ai-provider.js — 服务端 AI Provider（OpenAI 兼容）
 * ============================================================================
 * 服务器启动时注册到 Story.registerAIProvider，narrate(ctx) 调用外部模型 API。
 * API Key 仅存服务端，绝不发送给浏览器、不写入存档。
 *
 * 协议：
 *   POST {AI_BASE_URL}/chat/completions
 *   Authorization: Bearer {AI_API_KEY}
 *   body: { model, messages:[{system},{user:JSON.stringify(ctx)}], temperature }
 *   期望返回：{ choices:[{ message:{ content: JSON字符串 } }] }
 *   content 解析后应为 { title, chapter, dialogues?, endingImage? }
 * ============================================================================
 */
const config = require('./config');
const logger = require('./utils/logger');

const SYSTEM_PROMPT =
  '你是《修行局》的叙事 AI，只能根据既定事实写章节。' +
  '严格返回 JSON，字段：title(标题,字符串), chapter(正文,字符串或段落数组), ' +
  'dialogues(对白数组,可空), endingImage(画面描述,可空)。' +
  '不要返回任何额外字段，不要返回 statePatch/choices，不要返回解释性文字。';

/** 调用 OpenAI 兼容接口；返回归一化后的对象（{title,chapter,dialogues,endingImage}） */
async function callOpenAICompatible(ctx) {
  if (!config.AI_API_KEY) {
    throw new Error('NO_API_KEY');
  }
  const url = config.AI_BASE_URL + '/chat/completions';
  const body = {
    model: config.AI_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(ctx) },
    ],
    temperature: config.AI_TEMPERATURE,
  };

  let resp;
  try {
    resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.AI_API_KEY,
      },
      body: JSON.stringify(body),
    }, config.AI_TIMEOUT_MS);
  } catch (e) {
    if (e && e.message === 'TIMEOUT') throw new Error('TIMEOUT');
    throw e;
  }

  if (!resp.ok) {
    // 401/403 等鉴权失败统一归类
    throw new Error('HTTP_' + resp.status);
  }

  let data;
  try { data = await resp.json(); } catch (e) { throw new Error('BAD_JSON'); }

  const content = data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;
  if (!content) throw new Error('EMPTY_RESPONSE');

  // content 可能是 JSON 字符串，也可能是带 markdown 围栏的 JSON
  return parseContent(content);
}

/** 解析模型返回内容为对象 */
function parseContent(content) {
  if (typeof content === 'object' && content !== null) return content;
  let s = String(content).trim();
  // 去除 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    // 兜底：返回纯文本作为 chapter
    return { title: '天机残篇', chapter: s };
  }
}

/** 带超时的 fetch（Node 18+ 内置 fetch） */
function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, ms);
  return fetch(url, Object.assign({}, options, { signal: controller.signal }))
    .then(function (r) { clearTimeout(timer); return r; })
    .catch(function (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('TIMEOUT');
      throw e;
    });
}

/**
 * 构建并注册服务端 AI Provider 到 Story。
 * @param Story story-core 模块
 * @param {object} override 可选覆盖：{ provider: function(ctx) } 用于测试注入 Mock
 */
function register(Story, override) {
  const provider = (override && typeof override.narrate === 'function')
    ? override
    : { narrate: callOpenAICompatible };

  Story.registerAIProvider(provider, {
    provider: (override && override.narrate ? 'test-mock' : 'server-openai-compatible'),
    model: config.AI_MODEL,
    base: config.AI_BASE_URL,
  });
  Story.setAIEnabled(config.AI_ENABLED);
  // 服务端调高默认超时
  if (Story.ai && config.AI_TIMEOUT_MS) {
    Story.ai.timeoutMs = config.AI_TIMEOUT_MS;
  }
  logger.info('ai-provider', '已注册 AI Provider', {
    enabled: config.AI_ENABLED,
    model: config.AI_MODEL,
    hasKey: !!config.AI_API_KEY,
    mock: !!(override && override.narrate),
  });
}

module.exports = {
  register,
  callOpenAICompatible,
  parseContent,
};
