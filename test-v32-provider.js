/* test-v32-provider.js — V3.2 Provider 行为测试
 * 验证：parseNarrationResponse 6 级回退、validateNarrationOnly（不拒越权字段）、
 *       narrate 禁用/启用、mock 重试协议（2 次）、越权字段剥离、_classifyError 映射。
 */
const Story = require('./story-core.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' — ' + detail : '')); }
}

var P = Story.Provider;

function makeState() {
  var s = Story.createEmptyState();
  s.api = { enabled: true, lastStatus: '', lastErrorCode: null };
  Story._activateState(s);
  return s;
}

// Provider._briefToCtx 需要 brief.world / brief.style，构造最小合规 brief
var BRIEF = {
  chapterIndex: 2,
  world: { name: '测试界', year: 1, toneTags: [] },
  scene: { locationName: '客栈', timeOfDay: '夜', weather: '雨', immediateConflict: '' },
  focalActors: [], narrationBeats: [], forbiddenLeaks: [],
  style: { proseLength: '450-850', paragraphCount: '3-5', focalConflictCount: 1,
    noSummaryTone: true, noGenericObserver: true, noUnjustifiedReward: true },
  _envelope: null
};
// ≥20 字符合规章节正文
var VALID_CH = '这是由模拟AI生成的合格章节正文内容长度超过二十个字符合规通过校验';

async function main() {
  // ---------- 1. parseNarrationResponse ----------
  // 直接 JSON 对象
  var r1 = P.parseNarrationResponse(JSON.stringify({ title: '直接标题', chapter: VALID_CH }));
  ok('parseNarrationResponse 直接JSON: title 正确', r1.title === '直接标题', r1.title);
  ok('parseNarrationResponse 直接JSON: chapter 非空字符串', typeof r1.chapter === 'string' && r1.chapter.length > 0);

  // 数组 chapter 被合并为字符串
  var r2 = P.parseNarrationResponse(JSON.stringify({ title: '数组章', chapter: ['第一段内容', '第二段内容'] }));
  ok('parseNarrationResponse 数组chapter: 合并为字符串', typeof r2.chapter === 'string' && r2.chapter.length > 0, typeof r2.chapter);

  // null
  var r3 = P.parseNarrationResponse(null);
  ok('parseNarrationResponse null: 空 title', r3.title === '');
  ok('parseNarrationResponse null: 空 chapter', r3.chapter === '');

  // 空串
  var r4 = P.parseNarrationResponse('');
  ok('parseNarrationResponse 空串: 空 title', r4.title === '');
  ok('parseNarrationResponse 空串: 空 chapter', r4.chapter === '');

  // 纯文本 >20 字符 → plainText / autoFixed
  var r5 = P.parseNarrationResponse('一段超过二十个字符的纯文本输入用于触发纯文本回退路径测试');
  ok('parseNarrationResponse 长文本: plainText=true', r5.plainText === true);
  ok('parseNarrationResponse 长文本: _autoFixed=true', r5._autoFixed === true);

  // ---------- 2. validateNarrationOnly ----------
  var v1 = P.validateNarrationOnly({ title: 'T', chapter: VALID_CH });
  ok('validateNarrationOnly 合法: 无错误', Array.isArray(v1) && v1.length === 0, JSON.stringify(v1));

  var v2 = P.validateNarrationOnly({ title: '', chapter: VALID_CH });
  ok('validateNarrationOnly 空 title: 报错', v2.length > 0 && v2.some(function (e) { return e.indexOf('title') >= 0; }), JSON.stringify(v2));

  var v3 = P.validateNarrationOnly({ title: 'T', chapter: '短' });
  ok('validateNarrationOnly 短 chapter: 报错', v3.length > 0, JSON.stringify(v3));

  // 越权字段不被拒绝（仅校验文案字段）
  var v4 = P.validateNarrationOnly({ title: 'T', chapter: VALID_CH, monster: '妖兽', reward: '顶级法宝', statePatch: { x: 1 }, choices: [] });
  ok('validateNarrationOnly 不拒绝越权字段', v4.length === 0, JSON.stringify(v4));

  // ---------- 3. Provider.narrate AI 禁用 ----------
  Story.setAIEnabled(false);
  var s0 = makeState();
  var n0 = await Story.Provider.narrate(s0, BRIEF);
  ok('narrate AI 禁用: 返回 null', n0 === null);
  ok('narrate AI 禁用: lastStatus=offline', s0.api.lastStatus === 'offline', s0.api.lastStatus);

  // ---------- 4. Provider.narrate mock 合法响应 ----------
  Story.setAIEnabled(true);
  var calls1 = 0;
  Story.registerAIProvider({ narrate: async function (ctx) {
    calls1++;
    return JSON.stringify({ title: 'AI第一章', chapter: VALID_CH });
  } });
  var s1 = makeState();
  var n1 = await Story.Provider.narrate(s1, BRIEF);
  ok('narrate mock 合法: 调用 1 次', calls1 === 1, 'calls=' + calls1);
  ok('narrate mock 合法: 返回对象', !!n1 && typeof n1 === 'object');
  ok('narrate mock 合法: title 正确', !!n1 && n1.title === 'AI第一章', n1 && n1.title);
  ok('narrate mock 合法: lastStatus=ok', s1.api.lastStatus === 'ok', s1.api.lastStatus);

  // ---------- 5. Provider.narrate 重试协议（首次空，二次合法 → 共 2 次） ----------
  var calls2 = 0;
  Story.registerAIProvider({ narrate: async function (ctx) {
    calls2++;
    if (calls2 === 1) return null;
    return JSON.stringify({ title: 'AI重试章', chapter: VALID_CH });
  } });
  var s2 = makeState();
  var n2 = await Story.Provider.narrate(s2, BRIEF);
  ok('narrate 重试: protocolCalls === 2', calls2 === 2, 'calls=' + calls2);
  ok('narrate 重试: 第二次成功返回', !!n2 && n2.title === 'AI重试章', n2 && n2.title);
  ok('narrate 重试: lastStatus=ok', s2.api.lastStatus === 'ok', s2.api.lastStatus);

  // ---------- 6. Provider.narrate 越权字段被剥离 ----------
  var calls3 = 0;
  Story.registerAIProvider({ narrate: async function (ctx) {
    calls3++;
    return JSON.stringify({ title: 'AI越权章', chapter: VALID_CH, monster: '妖兽', reward: '顶级法宝', statePatch: { x: 1 } });
  } });
  var s3 = makeState();
  var n3 = await Story.Provider.narrate(s3, BRIEF);
  ok('narrate 越权: 仍成功', !!n3 && n3.title === 'AI越权章', n3 && n3.title);
  ok('narrate 越权: monster 被剥离', !n3 || n3.monster === undefined);
  ok('narrate 越权: statePatch 被剥离', !n3 || n3.statePatch === undefined);
  ok('narrate 越权: reward 被剥离', !n3 || n3.reward === undefined);

  // ---------- 7. _classifyError 映射 ----------
  var errCases = [
    { msg: '401 Unauthorized',          expect: 'HTTP_401' },
    { msg: '403 Forbidden',             expect: 'HTTP_403' },
    { msg: '404 Not Found',             expect: 'HTTP_404' },
    { msg: '429 Too Many Requests',     expect: 'HTTP_429' },
    { msg: '500 Internal Server Error', expect: 'HTTP_5XX' },
    { msg: '503 Service Unavailable',   expect: 'HTTP_5XX' },
    { msg: 'timeout of 30000ms exceeded', expect: 'TIMEOUT' },
    { msg: 'CORS policy blocked',       expect: 'CORS_ERROR' },
    { msg: 'Failed to fetch',           expect: 'CORS_ERROR' },
    { msg: 'network error',             expect: 'NETWORK_ERROR' },
    { msg: 'JSON parse unexpected token', expect: 'INVALID_JSON' }
  ];
  errCases.forEach(function (c) {
    var got = P._classifyError(c.msg);
    ok('_classifyError "' + c.msg + '" => ' + c.expect, got === c.expect, 'got ' + got);
  });

  // 清理：恢复禁用状态，避免影响其他进程
  Story.setAIEnabled(false);

  console.log('\nV3.2 Provider 测试通过 ' + pass + ' / 失败 ' + fail);
  if (fail > 0) process.exitCode = 1;
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
