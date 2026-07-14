'use strict';

const StoryEngine = require('./src/application/story-engine.js');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('✓ ' + name); }
  else { fail++; console.error('✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function providerContext(label, tracker) {
  return {
    enabled: true,
    timeoutMs: 1000,
    providerMeta: { provider: 'mock-engine-' + label, model: label, skipSemanticValidation: true },
    provider: {
      narrate: async function () {
        tracker.active++;
        tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
        await new Promise(function (resolve) { setTimeout(resolve, 60); });
        tracker.active--;
        return {
          title: '引擎' + label,
          chapter: ('引擎' + label + '只渲染自己的确定性事实。').repeat(40),
          dialogues: [], endingImage: '',
        };
      },
    },
  };
}

async function main() {
  const tracker = { active: 0, maxActive: 0 };
  const a = StoryEngine.create({ id: 'engine_a', providerContext: providerContext('甲', tracker) });
  const b = StoryEngine.create({ id: 'engine_b', providerContext: providerContext('乙', tracker) });
  const startedAt = Date.now();
  const states = await Promise.all([
    a.createSession({ seed: 'ENGINE-A', actors: [{ id: 'a', name: '甲', controller: 'human' }] }),
    b.createSession({ seed: 'ENGINE-B', actors: [{ id: 'b', name: '乙', controller: 'human' }] }),
  ]);
  const elapsed = Date.now() - startedAt;
  ok('每个引擎持有独立 StoryState', a.state === states[0] && b.state === states[1] && a.state !== b.state);
  ok('每个引擎使用自己的 Provider 上下文', states[0].story.currentChapter.title === '引擎甲' && states[1].story.currentChapter.title === '引擎乙');
  ok('两个引擎可并发等待 Provider', tracker.maxActive === 2, String(tracker.maxActive));
  ok('并发耗时接近一次 Provider 等待', elapsed < 150, String(elapsed) + 'ms');
  ok('不同 seed 未发生 RNG/世界状态泄漏', states[0].world.seed === 'ENGINE-A' && states[1].world.seed === 'ENGINE-B');
  const chapterBefore = states[0].story.chapterIndex;
  const choice = states[0].story.turnChoices.a[0];
  let staleError = null;
  try {
    await a.resolveTurn({ a: { choiceId: choice.id } }, {
      beforeNarration: async function () { states[0].story.stateVersion += 1; },
    });
  } catch (error) { staleError = error; }
  ok('迟到响应被 pending version 拒绝', staleError && staleError.code === 'STALE_PENDING_TURN', staleError && staleError.message);
  ok('过期响应不会提交章节', states[0].story.chapterIndex === chapterBefore && !!states[0].story.pendingResolution);
  console.log('\nStoryEngine: ' + pass + ' passed / ' + fail + ' failed');
  if (fail) process.exitCode = 1;
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
