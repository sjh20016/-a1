const assert = require('assert');
const Story = require('./story-core.js');
const { callOpenAICompatible } = require('./server/ai-provider.js');

async function main() {
  const originalFetch = global.fetch;
  global.fetch = async function () {
    return {
      ok: true,
      status: 200,
      text: async function () { return JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"title":"截断","chapter":"正文"}' } }] }); },
    };
  };
  try {
    const result = await callOpenAICompatible({ aiBaseUrl: 'https://example.test', aiApiKey: 'test-only', aiModel: 'test', aiTimeoutMs: 1000 }, {}, Story);
    assert.strictEqual(result.content, '{"title":"截断","chapter":"正文"}');
    assert.strictEqual(result.finishReason, 'length');
    console.log('✓ Provider 保存 finish_reason');
    console.log('\nserver V3.4.2 provider: 1 passed / 0 failed');
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
