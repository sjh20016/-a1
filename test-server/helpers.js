'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const Story = require('../story-core.js');
const Room = require('../room-core.js');
const { createServer } = require('../server/index.js');

function createNarrationProvider(control) {
  control = control || { fail: false };
  return {
    narrate: async function (ctx) {
      if (control.fail) throw new Error('mock ai unavailable');
      if (typeof control.onCall === 'function') control.onCall(ctx);
      if (control.blockPromise) await control.blockPromise;
      if (control.delayMs) await new Promise(function (resolve) { setTimeout(resolve, control.delayMs); });
      var anchors = ctx && ctx.brief && ctx.brief.openingAnchors || [];
      var turnFacts = ctx && ctx.turnContract && ctx.turnContract.mustRenderFacts || [];
      var chapterIndex = ctx && ctx.brief && ctx.brief.chapterIndex || 0;
      var contractParts = [];
      if (anchors.length) contractParts.push('开局锚点：' + anchors.slice(0, 10).join('、'));
      turnFacts.forEach(function (fact) {
        contractParts.push([fact.actorName, fact.actionText]
          .concat(fact.requiredMeaning || [], fact.gains || [], fact.costs || [])
          .filter(Boolean).join(' '));
      });
      var marker = '第' + chapterIndex + '章';
      contractParts.push(ctx && ctx.brief && ctx.brief.isOpening
        ? marker + '众人确认眼前环境。' + marker + '当前压力已经显露。' + marker + '首个抉择由此展开。'
        : marker + '既定行动逐一落定。' + marker + '所得与代价均可见。' + marker + '局势留下新的抉择。');
      return JSON.stringify({
        title: '联机验收章 ' + chapterIndex,
        chapter: contractParts.join('。'),
        dialogues: [],
        endingImage: '',
      });
    },
  };
}

async function startTestServer(options) {
  options = options || {};
  Room.coordinator._rooms.clear();
  var dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxingju-server-'));
  var control = options.control || { fail: false };
  var app = createServer({
    config: Object.assign({
      host: '127.0.0.1', port: 0, publicOrigin: '', roomSaveDir: path.join(dataDir, 'rooms'),
      aiEnabled: true, aiBaseUrl: 'http://mock.invalid', aiApiKey: 'test-only', aiModel: 'mock', aiTimeoutMs: 1000,
    }, options.config || {}),
    aiProvider: createNarrationProvider(control),
    logger: { info: function () {}, warn: function () {}, error: function () {} },
  });
  var address = await app.start();
  app.testDataDir = dataDir;
  app.control = control;
  app.wsUrl = 'ws://127.0.0.1:' + address.port + '/ws';
  app.httpUrl = 'http://127.0.0.1:' + address.port;
  return app;
}

class TestClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.pending = new Map();
    this.seq = 0;
    this.views = [];
    this.auth = {};
  }

  connect() {
    var self = this;
    return new Promise(function (resolve, reject) {
      self.socket = new WebSocket(self.url);
      self.socket.once('open', resolve);
      self.socket.once('error', reject);
      self.socket.on('message', function (raw) {
        var message = JSON.parse(raw.toString('utf8'));
        if (message.type === 'room_view') {
          self.views.push(message.payload.view);
          return;
        }
        var entry = self.pending.get(message.requestId);
        if (!entry) return;
        self.pending.delete(message.requestId);
        if (message.type === 'error') {
          var error = new Error(message.error.message);
          error.code = message.error.code;
          entry.reject(error);
        } else entry.resolve(message.payload || {});
      });
    });
  }

  request(type, payload, options) {
    options = options || {};
    var requestId = 'test_' + (++this.seq);
    var message = { requestId: requestId, type: type, payload: payload || {} };
    if (options.auth !== false) {
      message.roomId = options.roomId || this.auth.roomId;
      message.seatId = options.seatId || this.auth.seatId;
      message.token = options.token || this.auth.seatToken;
    }
    if (options.host) message.hostToken = options.hostToken || this.auth.hostToken;
    var self = this;
    return new Promise(function (resolve, reject) {
      self.pending.set(requestId, { resolve: resolve, reject: reject });
      self.socket.send(JSON.stringify(message));
    });
  }

  async createRoom(name, seed) {
    var result = await this.request('create_room', { hostName: name, seed: seed }, { auth: false });
    this.auth = {
      roomId: result.roomId, roomCode: result.roomCode, seatId: result.seatId,
      seatToken: result.seatToken, hostToken: result.hostToken,
    };
    return result;
  }

  async joinRoom(code, name) {
    var result = await this.request('join_room', { roomCode: code, displayName: name }, { auth: false });
    this.auth = { roomId: result.roomId, roomCode: result.roomCode, seatId: result.seatId, seatToken: result.seatToken };
    return result;
  }

  reconnect(authState) {
    this.auth = Object.assign({}, authState);
    return this.request('reconnect', {});
  }

  close() {
    if (this.socket) this.socket.terminate();
  }
}

function actorSetup(name, daoPath) {
  return {
    name: name, identity: '验收散修', daoPath: daoPath || '剑修',
    publicWish: '查明当前异变', hiddenFate: name + '的私密命数', personalityTags: ['谨慎'],
  };
}

async function prepareTwoPlayerGame(app) {
  var a = new TestClient(app.wsUrl);
  var b = new TestClient(app.wsUrl);
  await Promise.all([a.connect(), b.connect()]);
  var created = await a.createRoom('玩家A', 'SERVER-FLOW');
  await b.joinRoom(created.roomCode, '玩家B');
  await a.request('assign_actor', { actorSetup: actorSetup('陆知微', '剑修') });
  await b.request('assign_actor', { actorSetup: actorSetup('沈青萝', '阵修') });
  await a.request('set_ready', { ready: true });
  await b.request('set_ready', { ready: true });
  var started = await a.request('start_room_with_arc_voting', {}, { host: true });
  var candidates = started.view.arcVoting.candidates;
  var chosen = candidates.find(function (c) { return c.recipeId !== 'trade_contract' && c.recipeId !== 'relic_identity'; }) || candidates[0];
  await a.request('submit_arc_vote', { arcId: chosen.arcId });
  await b.request('submit_arc_vote', { arcId: chosen.arcId });
  var finalized = await a.request('finalize_arc_vote', {}, { host: true });
  return { a: a, b: b, chosen: chosen, finalized: finalized };
}

module.exports = {
  Story: Story,
  Room: Room,
  TestClient: TestClient,
  startTestServer: startTestServer,
  prepareTwoPlayerGame: prepareTwoPlayerGame,
  actorSetup: actorSetup,
};
