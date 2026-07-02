const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ✓ ' + name); }
  else { failed += 1; console.error('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}

async function loadApp() {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', function (e) { errors.push(e.message); });
  const dom = await JSDOM.fromFile(path.join(__dirname, 'index.html'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse: function (window) { window.HTMLCanvasElement.prototype.getContext = function () { return null; }; },
  });
  await new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(new Error('页面加载超时')); }, 5000);
    dom.window.addEventListener('load', function () { clearTimeout(timer); resolve(); });
  });
  return { dom: dom, errors: errors };
}

async function main() {
  const loaded = await loadApp();
  const window = loaded.dom.window;
  const Story = window.Story;
  const UI = window.eval('UI');

  Story.setAIEnabled(false);
  await Story.startGame('AI-INTEGRATION', {
    name: '陆知微', identity: '外门弟子', daoPath: '剑修',
    publicWish: '查明钟声来源', hiddenFate: '残剑认主', personalityTags: ['敏锐'],
  });

  let captured = null;
  window.fetch = async function (url, options) {
    if (String(url).endsWith('/models')) {
      return { ok: true, status: 200, json: async function () { return { data: [{ id: 'deepseek-v4-flash' }] }; }, text: async function () { return ''; } };
    }
    captured = { url: String(url), body: JSON.parse(options.body) };
    const choices = {};
    Story.state.actors.forEach(function (actor) {
      // Deliberately use actor names, action instead of label, and scalar tags
      // to mirror common DeepSeek JSON deviations.
      choices[actor.name] = [0, 1, 2].map(function (i) {
        return { action: '承接梦中钟声的后果' + i, description: '与刚才的行动直接相关', tags: 'continuity' };
      });
    });
    const chapter = {
      title: '梦钟之后',
      chapter: [
        '陆知微继续睡觉，却在梦境中追上了反复回荡的钟声。'.repeat(3),
        { text: '醒来时，他掌心多出一道具体可查的符痕；这一行动改变了同伴的判断，也让下一步追索有了明确方向。'.repeat(3) },
      ],
      chapterSummary: '继续睡觉引出了梦钟符痕。',
      timePassed: { value: '1', unit: '日', reason: '梦中追索' },
      publicEvents: '梦钟符痕已经显现', privateEvents: [], activeThreads: '梦钟符痕',
      statePatch: { newFacts: '梦境会留下实体符痕', newHooks: '查明梦钟符痕' },
      choices: choices,
    };
    return {
      ok: true, status: 200,
      json: async function () { return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(chapter) } }] }; },
      text: async function () { return ''; },
    };
  };

  UI.settings.aiOn = 1;
  UI.settings.base = 'https://api.deepseek.com';
  UI.settings.model = 'deepseek-v4-flash';
  UI.settings.temperature = 0.8;
  Story.setApiKey('sk-test-only');
  UI.syncAI();

  const ctx = Story.compileContext(Story.state, [{ actorId: 'lu', publicAction: '继续睡觉并追逐梦中钟声', privateIntent: '确认梦境真伪', tags: ['custom'], custom: true }]);
  check('上下文包含上一章正文摘录', !!ctx.previousChapter.chapterExcerpt && ctx.previousChapter.chapterExcerpt.length > 20);
  check('上下文保留自定义行动标记', ctx.chosenActions[0].isCustom === true);

  await Story.playTurn({ custom: { text: '继续睡觉并追逐梦中钟声' } });
  check('API 请求发送到正确端点', captured && captured.url === 'https://api.deepseek.com/chat/completions');
  check('请求设置足够的最大输出', captured && captured.body.max_tokens === 4096);
  check('DeepSeek 叙事请求关闭思考以降低延迟', captured && captured.body.thinking && captured.body.thinking.type === 'disabled');
  check('系统提示强制落实 chosenActions', captured && captured.body.messages[0].content.indexOf('chosenActions') >= 0);
  check('用户消息包含自定义行动原文', captured && captured.body.messages[1].content.indexOf('继续睡觉并追逐梦中钟声') >= 0);
  check('成功使用 API 正文而非离线模板', Story.state.story.currentChapter.title === '梦钟之后');
  check('chapter 段落数组被合并为正文', typeof Story.state.story.currentChapter.chapter === 'string' && Story.state.story.currentChapter.chapter.indexOf('掌心多出') >= 0);
  check('API 成功状态可观察', Story.getAIStatus().state === 'success');
  check('DeepSeek 常见格式偏差被自动修复', Story.getAIStatus().message.indexOf('自动修复格式') >= 0);
  check('角色名 choices 键被映射为角色 ID', Story.getChoicesForActor(Story.state, 'lu').length > 0 && Story.getChoicesForActor(Story.state, 'lu').every(function (c) { return !!c.intentCategory; }));

  const testResult = await Story.ai.provider.test();
  check('连接测试能确认所选模型', testResult.selectedModelFound === true);
  window.document.getElementById('set-ai-on').value = '1';
  window.document.getElementById('set-base').value = 'https://api.deepseek.com';
  window.document.getElementById('set-model').value = 'deepseek-v4-flash';
  window.document.getElementById('set-key').value = '';
  await UI.testAIConnection();
  check('设置面板连接测试更新为就绪', Story.getAIStatus().state === 'ready');
  check('顶栏展示 AI 状态', window.document.getElementById('ai-status').textContent.indexOf('就绪') >= 0);
  const keyBeforeBlankSave = Story.getApiKey();
  UI.saveSettings();
  check('设置中留空不会误删当前 Key', Story.getApiKey() === keyBeforeBlankSave);
  check('页面无脚本加载错误', loaded.errors.length === 0, loaded.errors.join(' | '));

  loaded.dom.window.close();
  console.log('\n========================================');
  console.log('  AI 集成测试通过 ' + passed + ' / 失败 ' + failed);
  console.log('========================================');
  if (failed) process.exitCode = 1;
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
