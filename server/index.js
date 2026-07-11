'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const Story = require('../story-core.js');
const Room = require('../room-core.js');
const baseConfig = require('./config.js');
const protocol = require('./protocol.js');
const { RoomRuntime, send } = require('./room-runtime.js');
const { FileStore } = require('./persistence/file-store.js');
const { createLogger } = require('./utils/logger.js');
const { registerServerAI } = require('./ai-provider.js');
const { createNarrationDebugSink } = require('./narration-debug.js');

const ROOT = path.resolve(__dirname, '..');
const STATIC_ROUTES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/story-core.js': { file: 'story-core.js', type: 'text/javascript; charset=utf-8' },
  '/room-core.js': { file: 'room-core.js', type: 'text/javascript; charset=utf-8' },
  '/public/online-client.js': { file: 'public/online-client.js', type: 'text/javascript; charset=utf-8' },
};

function createServer(options) {
  options = options || {};
  var config = Object.assign({}, baseConfig, options.config || {});
  var logger = options.logger || createLogger(console);
  var store = options.store || new FileStore({ roomSaveDir: config.roomSaveDir });
  if (!options.skipAIRegistration) registerServerAI(Story, config, logger, options.aiProvider);
  Story.Narration.setDebugSink(config.narrationDebug ? createNarrationDebugSink({ dataDir: config.dataDir }) : null);
  var runtime = options.runtime || new RoomRuntime({ Room: Room, Story: Story, store: store, logger: logger, config: config });

  var server = http.createServer(function (request, response) {
    var requestUrl = new URL(request.url, 'http://localhost');
    if (requestUrl.pathname === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('ok');
      return;
    }
    var route = STATIC_ROUTES[requestUrl.pathname];
    if (!route || (request.method !== 'GET' && request.method !== 'HEAD')) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    var file = path.join(ROOT, route.file);
    fs.readFile(file, function (error, data) {
      if (error) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('not found');
        return;
      }
      var headers = { 'Content-Type': route.type, 'Cache-Control': 'no-cache' };
      if (config.publicOrigin) headers['Access-Control-Allow-Origin'] = config.publicOrigin;
      response.writeHead(200, headers);
      response.end(request.method === 'HEAD' ? undefined : data);
    });
  });

  var wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', function (request, socket, head) {
    var requestUrl = new URL(request.url, 'http://localhost');
    if (requestUrl.pathname !== '/ws') { socket.destroy(); return; }
    if (config.publicOrigin && request.headers.origin && request.headers.origin !== config.publicOrigin) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, function (ws) { wss.emit('connection', ws, request); });
  });

  wss.on('connection', function (socket) {
    socket.isAlive = true;
    socket.on('pong', function () { socket.isAlive = true; });
    socket.on('message', async function (raw) {
      var message;
      try {
        message = protocol.parseMessage(raw);
        var payload = await runtime.handleCommand(socket, message);
        send(socket, { requestId: message.requestId || null, type: 'result', command: message.type, payload: payload || {} });
      } catch (error) {
        if (!(error instanceof protocol.ProtocolError)) logger.error('WebSocket command failed:', error && error.message);
        send(socket, protocol.errorMessage(message && message.requestId, error));
      }
    });
    socket.on('close', function () {
      runtime.disconnect(socket).catch(function (error) { logger.warn('断线状态保存失败：', error.message); });
    });
  });

  var heartbeat = setInterval(function () {
    wss.clients.forEach(function (socket) {
      if (socket.isAlive === false) { socket.terminate(); return; }
      socket.isAlive = false;
      socket.ping();
    });
  }, 30000);
  heartbeat.unref();

  async function start() {
    var loaded = await runtime.loadRooms();
    await new Promise(function (resolve, reject) {
      server.once('error', reject);
      server.listen(config.port, config.host, function () {
        server.removeListener('error', reject);
        resolve();
      });
    });
    var address = server.address();
    logger.info('Xiuxingju server listening on ' + config.host + ':' + address.port);
    logger.info('Loaded rooms: ' + loaded.length);
    logger.info('AI enabled: ' + !!config.aiEnabled);
    return address;
  }

  async function stop() {
    clearInterval(heartbeat);
    wss.clients.forEach(function (socket) { socket.terminate(); });
    await new Promise(function (resolve) {
      if (!server.listening) { resolve(); return; }
      server.close(function () { resolve(); });
    });
  }

  return { server: server, wss: wss, runtime: runtime, store: store, config: config, start: start, stop: stop };
}

if (require.main === module) {
  var app = createServer();
  app.start().catch(function (error) {
    console.error('Server failed to start:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { createServer: createServer };
