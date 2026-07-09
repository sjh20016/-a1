/**
 * test-server/test-helpers.js — 联机后端测试公共工具
 * ============================================================================
 * 提供：
 *   - startTestServer(options)  启动测试服务器（随机端口 + 可控 Mock AI + 临时存档目录）
 *   - createClient(url)         WebSocket 客户端，带 requestId / 等待广播
 *   - createMockAI()            可控 Mock AI Provider（success / fail）
 * ============================================================================
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  ✓ ' + name); }
  else { failed += 1; console.error('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}
function summary(label) {
  console.log('\n' + label + ': ' + passed + ' passed, ' + failed + ' failed');
  return failed === 0;
}
function resetCounters() { passed = 0; failed = 0; }

/* ============================================================
 * 可控 Mock AI Provider
 * ============================================================ */
function createMockAI() {
  const state = { mode: 'success', callCount: 0, lastCtx: null };
  const provider = {
    narrate: async function (ctx) {
      state.callCount++;
      state.lastCtx = ctx;
      if (state.mode === 'fail') {
        throw new Error('MOCK_AI_FAIL');
      }
      // 返回合规章节对象（chapter ≥ 20 字）
      const round = (ctx && ctx.turn && ctx.turn.round) || 0;
      return {
        title: '测试章节·第' + (round + 1) + '回',
        chapter: '夜雨初歇，钟声远去。陆知微握紧残剑，与众人在月下对视，各自心事难平，前路未明。'.repeat(2),
        dialogues: [],
        endingImage: '',
      };
    },
  };
  return {
    provider: provider,
    controller: state,
    setMode: function (m) { state.mode = m; },
  };
}

/* ============================================================
 * 启动测试服务器
 * ============================================================ */
let portSeq = 9800;
function nextPort() { return ++portSeq; }

async function startTestServer(options) {
  options = options || {};
  const tmpDir = options.saveDir || fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxingju-test-'));
  // 清空 require 缓存中 server 模块（避免上次 server 实例残留）
  delete require.cache[require.resolve('../server/index.js')];
  // 也清掉 room-runtime / file-store / ai-provider / Story / Room，保证隔离
  ['../server/room-runtime.js', '../server/persistence/file-store.js',
   '../server/ai-provider.js', '../server/config.js', '../room-core.js', '../story-core.js']
    .forEach(function (m) {
      const k = require.resolve(m);
      if (require.cache[k]) delete require.cache[k];
    });

  const config = require('../server/config');
  // 临时存档目录
  process.env.ROOM_SAVE_DIR = tmpDir;
  config.ROOM_SAVE_DIR = tmpDir;

  const mock = createMockAI();
  const server = await require('../server/index.js').start({
    port: options.port || nextPort(),
    host: '127.0.0.1',
    saveDir: tmpDir,
    aiProviderOverride: mock.provider,
    restore: options.restore !== false,
  });

  const addr = server.address();
  const url = 'ws://127.0.0.1:' + addr.port + '/ws';
  return {
    server: server,
    url: url,
    mock: mock,
    tmpDir: tmpDir,
    close: function () {
      return new Promise(function (resolve) {
        // 清空房间运行时状态
        try {
          const runtime = require('../server/room-runtime');
          runtime.rooms.clear();
          runtime.roomCodes.clear();
          runtime.socketsByRoom.clear();
        } catch (e) {}
        server.close(function () {
          // 清理临时目录（除非调用方要求保留）
          if (!options.keepTmpDir) {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
          }
          resolve();
        });
      });
    },
  };
}

/* ============================================================
 * WebSocket 客户端
 * ============================================================ */
class Client {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this._reqId = 0;
    this._pending = new Map();       // requestId -> {resolve, reject}
    this._broadcasts = [];           // 收到的非响应广播
    this._listeners = [];            // 谓词监听
    this._closed = false;
  }

  connect() {
    const self = this;
    return new Promise(function (resolve, reject) {
      const ws = new WebSocket(self.url);
      self.ws = ws;
      ws.on('open', function () { resolve(self); });
      ws.on('error', function (e) { reject(e); });
      ws.on('close', function () { self._closed = true; });
      ws.on('message', function (raw) {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        // 响应（带 requestId 且 type 为 ok/error）
        if (msg.requestId && (msg.type === 'ok' || msg.type === 'error')) {
          const p = self._pending.get(msg.requestId);
          if (p) {
            self._pending.delete(msg.requestId);
            if (msg.type === 'ok') p.resolve(msg.payload);
            else p.reject(msg.error);
          }
        } else {
          // 广播
          self._broadcasts.push(msg);
          // 通知监听者
          for (let i = self._listeners.length - 1; i >= 0; i--) {
            const entry = self._listeners[i];
            try {
              if (entry.predicate(msg)) {
                self._listeners.splice(i, 1);
                entry.resolve(msg);
              }
            } catch (e) {}
          }
        }
      });
    });
  }

  /** 发送命令并等待 ok/error 响应 */
  send(type, extra) {
    const self = this;
    const requestId = 'req_' + (++this._reqId);
    const msg = Object.assign({ requestId: requestId, type: type }, extra || {});
    return new Promise(function (resolve, reject) {
      self._pending.set(requestId, { resolve: resolve, reject: reject });
      self.ws.send(JSON.stringify(msg), function (err) {
        if (err) { self._pending.delete(requestId); reject(err); }
      });
    });
  }

  /** 等待一条匹配谓词的广播消息 */
  waitFor(predicate, timeoutMs) {
    const self = this;
    timeoutMs = timeoutMs || 5000;
    // 先在已收到的广播里找
    for (let i = 0; i < self._broadcasts.length; i++) {
      try { if (predicate(self._broadcasts[i])) return Promise.resolve(self._broadcasts[i]); } catch (e) {}
    }
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        const idx = self._listeners.findIndex(function (e) { return e.predicate === predicate; });
        if (idx >= 0) self._listeners.splice(idx, 1);
        reject(new Error('等待广播超时'));
      }, timeoutMs);
      self._listeners.push({
        predicate: function (m) {
          try { return predicate(m); } catch (e) { return false; }
        },
        resolve: function (m) { clearTimeout(timer); resolve(m); },
      });
    });
  }

  /** 等待一条 room_view 广播 */
  waitForRoomView(timeoutMs) {
    return this.waitFor(function (m) { return m.type === 'room_view'; }, timeoutMs);
  }

  close() {
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
  }

  get lastView() {
    for (let i = this._broadcasts.length - 1; i >= 0; i--) {
      if (this._broadcasts[i].type === 'room_view') return this._broadcasts[i].payload.view;
    }
    return null;
  }
}

function createClient(url) { return new Client(url); }

module.exports = {
  check, summary, resetCounters,
  createMockAI,
  startTestServer,
  createClient,
};
