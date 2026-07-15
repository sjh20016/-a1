'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
const { SlidingWindowLimiter } = require('./rate-limit.js');

const ROOT = path.resolve(__dirname, '..');
const STATIC_ROUTES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/story-core.js': { file: 'story-core.js', type: 'text/javascript; charset=utf-8' },
  '/room-core.js': { file: 'room-core.js', type: 'text/javascript; charset=utf-8' },
  '/public/online-client.js': { file: 'public/online-client.js', type: 'text/javascript; charset=utf-8' },
};

function normalizeOrigin(value) {
  if (!value) return '';
  try {
    var url = new URL(String(value).trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch (error) { return ''; }
}

function firstForwarded(value) {
  return String(value || '').split(',')[0].trim();
}

function requestHost(request) {
  return firstForwarded(request.headers['x-forwarded-host']) || firstForwarded(request.headers.host);
}

function requestProtocol(request) {
  return firstForwarded(request.headers['x-forwarded-proto']) || (request.socket && request.socket.encrypted ? 'https' : 'http');
}

function originPolicy(request, config) {
  var origin = request.headers.origin;
  if (!origin) return { allowed: true, reason: 'missing_origin', normalizedOrigin: '' };
  var normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return { allowed: false, reason: 'invalid_origin', normalizedOrigin: '' };
  var configured = []
    .concat(String(config.publicOrigin || '').split(','))
    .concat(String(config.allowedOrigins || '').split(','))
    .concat(config.renderExternalHostname ? ['https://' + config.renderExternalHostname] : [])
    .map(normalizeOrigin)
    .filter(Boolean);
  if (configured.indexOf(normalizedOrigin) >= 0) return { allowed: true, reason: 'configured_origin', normalizedOrigin: normalizedOrigin };
  var actual = new URL(normalizedOrigin);
  var sameHost = actual.host === requestHost(request);
  var sameProtocol = actual.protocol === (requestProtocol(request) === 'https' ? 'https:' : 'http:');
  return {
    allowed: sameHost && sameProtocol,
    reason: sameHost && sameProtocol ? 'same_origin' : 'origin_not_allowed',
    normalizedOrigin: normalizedOrigin,
  };
}

function clientIp(request) {
  return firstForwarded(request.headers['x-forwarded-for']) || request.headers['x-real-ip'] || request.socket && request.socket.remoteAddress || 'unknown';
}

function id(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

function secretMatches(expected, provided) {
  var left = Buffer.from(String(expected || ''));
  var right = Buffer.from(String(provided || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function publicError(error) {
  var code = error && error.code || 'INTERNAL_ERROR';
  var messages = {
    ROOM_NOT_FOUND: '房间不存在或已经过期',
    ROOM_FULL: '房间已满，请联系房主新建房间',
    ROOM_ALREADY_STARTED: '房间已经开始，暂时不能加入',
    ORIGIN_FORBIDDEN: '当前访问地址不受支持',
    BETA_ACCESS_REQUIRED: '这是内测房间，请使用官方邀请链接',
    SERVER_RESTARTING: '服务正在更新，将自动恢复',
    AI_QUOTA_EXCEEDED: '今日测试额度已用尽，请稍后重试',
    RATE_LIMITED: '操作过于频繁，请稍后再试',
    ROUND_LIMIT_REACHED: '本局测试回合已结束',
    MAX_ROOMS_REACHED: '当前网络的建房次数已达上限，请稍后再试',
  };
  return { code: code, message: messages[code] || (error instanceof protocol.ProtocolError ? error.message : '服务器暂时无法完成该操作') };
}

function createServer(options) {
  options = options || {};
  var config = Object.assign({}, baseConfig, options.config || {});
  var logger = options.logger || createLogger(console);
  var store = options.store || new FileStore({ roomSaveDir: config.roomSaveDir });
  var aiProvider = options.skipAIRegistration ? null : registerServerAI(Story, config, logger, options.aiProvider);
  Story.Narration.setDebugSink(config.narrationDebug ? createNarrationDebugSink({ dataDir: config.dataDir }) : null);
  var runtime = options.runtime || new RoomRuntime({ Room: Room, Story: Story, store: store, logger: logger, config: config });
  var rateLimiter = new SlidingWindowLimiter();
  var metrics = {
    startedAt: Date.now(),
    wsUpgradeRejected: 0,
    commandCounts: {},
    commandErrors: {},
    roomsExpired: 0,
    lastDiagnosticId: '',
  };
  var ready = false;
  var shuttingDown = false;
  var stopPromise = null;

  function logStructured(level, event, fields) {
    var payload = Object.assign({ event: event }, fields || {});
    logger[level](JSON.stringify(payload));
  }

  function countCommand(type, errorCode) {
    metrics.commandCounts[type] = (metrics.commandCounts[type] || 0) + 1;
    if (errorCode) metrics.commandErrors[errorCode] = (metrics.commandErrors[errorCode] || 0) + 1;
  }

  function checkBetaAccess(socket, payload) {
    if (!config.betaAccessCode) return true;
    var provided = payload && payload.accessCode;
    if (provided && secretMatches(config.betaAccessCode, provided)) {
      socket.betaAuthorized = true;
      return true;
    }
    if (socket.betaAuthorized) return true;
    throw new protocol.ProtocolError('BETA_ACCESS_REQUIRED', '缺少内测通行令');
  }

  function rateLimitMessage(request, message) {
    if (message.type === 'ping') return;
    var ip = clientIp(request);
    if (message.type === 'create_room') {
      rateLimiter.consume('create:' + ip, config.createRoomsPerHour, 3600000);
    }
    var roomPart = message.roomId || 'lobby';
    rateLimiter.consume('command:' + ip + ':' + roomPart + ':' + message.type, config.commandRateLimit, config.commandRateWindowMs);
  }

  function metricSnapshot() {
    var ai = aiProvider && aiProvider.metrics ? Object.assign({}, aiProvider.metrics) : { inFlight: 0, queued: 0, callsToday: 0, quotaExceeded: 0, completed: 0 };
    return {
      version: config.version,
      uptimeSeconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
      ready: ready,
      shuttingDown: shuttingDown,
      activeConnections: wss.clients.size,
      activeRooms: runtime.roomCodes.size,
      queuedAiRequests: ai.queued,
      ai: ai,
      wsUpgradeRejected: metrics.wsUpgradeRejected,
      commandCounts: Object.assign({}, metrics.commandCounts),
      commandErrors: Object.assign({}, metrics.commandErrors),
      roomsExpired: metrics.roomsExpired,
      rateLimiterKeys: rateLimiter.size(),
    };
  }

  var server = http.createServer(function (request, response) {
    var requestId = firstForwarded(request.headers['x-request-id']).slice(0, 100) || id('req');
    var diagnosticId = id('diag');
    metrics.lastDiagnosticId = diagnosticId;
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('X-Diagnostic-Id', diagnosticId);
    var requestUrl = new URL(request.url, 'http://localhost');
    if (requestUrl.pathname === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('ok');
      return;
    }
    if (requestUrl.pathname === '/readyz') {
      var readyBody = JSON.stringify({ ready: ready, version: config.version, diagnosticId: diagnosticId });
      response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(readyBody);
      return;
    }
    if (requestUrl.pathname === '/api/bootstrap') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({
        version: config.version,
        websocketPath: '/ws',
        testMode: true,
        roomTtlMinutes: config.roomTtlMinutes,
        aiAvailable: !!(config.aiEnabled && config.aiBaseUrl && config.aiModel && config.aiApiKey),
        accessRequired: !!config.betaAccessCode,
      }));
      return;
    }
    if (requestUrl.pathname === '/admin/metrics') {
      var suppliedSecret = request.headers['x-server-secret'] || String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!config.serverSecret || !secretMatches(config.serverSecret, suppliedSecret)) {
        response.writeHead(config.serverSecret ? 401 : 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: config.serverSecret ? 'UNAUTHORIZED' : 'NOT_FOUND' }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(metricSnapshot()));
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
      response.writeHead(200, headers);
      response.end(request.method === 'HEAD' ? undefined : data);
    });
  });

  var wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', function (request, socket, head) {
    var requestId = firstForwarded(request.headers['x-request-id']).slice(0, 100) || id('req');
    var diagnosticId = id('diag');
    var requestUrl = new URL(request.url, 'http://localhost');
    function reject(status, code, reason) {
      metrics.wsUpgradeRejected++;
      logStructured('warn', 'ws_upgrade_rejected', { requestId: requestId, diagnosticId: diagnosticId, code: code, host: requestHost(request), normalizedOrigin: originPolicy(request, config).normalizedOrigin, reason: reason });
      socket.write('HTTP/1.1 ' + status + ' ' + (status === 403 ? 'Forbidden' : 'Service Unavailable') + '\r\nX-Request-Id: ' + requestId + '\r\nX-Diagnostic-Id: ' + diagnosticId + '\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    }
    if (requestUrl.pathname !== '/ws') { socket.destroy(); return; }
    if (shuttingDown || !ready) { reject(503, 'SERVER_RESTARTING', shuttingDown ? 'shutting_down' : 'not_ready'); return; }
    var policy = originPolicy(request, config);
    if (!policy.allowed) { reject(403, 'ORIGIN_FORBIDDEN', policy.reason); return; }
    try { rateLimiter.consume('upgrade:' + clientIp(request), 30, 60000); }
    catch (error) { reject(429, 'RATE_LIMITED', 'upgrade_rate_limited'); return; }
    request.__requestId = requestId;
    request.__diagnosticId = diagnosticId;
    request.__clientIp = clientIp(request);
    wss.handleUpgrade(request, socket, head, function (ws) { wss.emit('connection', ws, request); });
  });

  wss.on('connection', function (socket, request) {
    socket.isAlive = true;
    socket.__requestId = request.__requestId;
    socket.__diagnosticId = request.__diagnosticId;
    socket.__clientIp = request.__clientIp;
    socket.on('pong', function () { socket.isAlive = true; });
    socket.on('error', function () {});
    socket.on('message', async function (raw) {
      var message;
      try {
        message = protocol.parseMessage(raw);
        rateLimitMessage(request, message);
        if (message.type === 'create_room' || message.type === 'join_room') checkBetaAccess(socket, message.payload || {});
        countCommand(message.type);
        var payload = await runtime.handleCommand(socket, message);
        send(socket, { requestId: message.requestId || null, type: 'result', command: message.type, payload: payload || {} });
      } catch (error) {
        var errorInfo = publicError(error);
        countCommand(message && message.type || 'invalid', errorInfo.code);
        if (!(error instanceof protocol.ProtocolError)) {
          logStructured('error', 'ws_command_failed', { requestId: socket.__requestId, diagnosticId: socket.__diagnosticId, command: message && message.type || 'invalid', code: errorInfo.code });
        }
        var response = protocol.errorMessage(message && message.requestId, errorInfo);
        response.diagnosticId = socket.__diagnosticId;
        send(socket, response);
      }
    });
    socket.on('close', function () {
      runtime.disconnect(socket).catch(function (error) {
        logStructured('warn', 'socket_disconnect_failed', { requestId: socket.__requestId, diagnosticId: socket.__diagnosticId, code: error && error.code || 'DISCONNECT_FAILED' });
      });
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
  var maintenance = setInterval(async function () {
    try { metrics.roomsExpired += await runtime.cleanupExpiredRooms(); } catch (error) { logStructured('warn', 'room_cleanup_failed', { code: 'ROOM_CLEANUP_FAILED' }); }
    rateLimiter.prune();
  }, 60000);
  maintenance.unref();

  async function start() {
    ready = false;
    var loaded = await runtime.loadRooms();
    await new Promise(function (resolve, reject) {
      server.once('error', reject);
      server.listen(config.port, config.host, function () {
        server.removeListener('error', reject);
        resolve();
      });
    });
    ready = true;
    var address = server.address();
    logger.info('Xiuxingju server listening on ' + config.host + ':' + address.port);
    logger.info('Loaded rooms: ' + loaded.length);
    logger.info('AI enabled: ' + !!config.aiEnabled);
    return address;
  }

  async function stop(options) {
    options = options || {};
    if (stopPromise) return stopPromise;
    stopPromise = (async function () {
      ready = false;
      shuttingDown = !!options.graceful;
      clearInterval(heartbeat);
      clearInterval(maintenance);
      try { await runtime.persistAllRooms(); } catch (error) { logStructured('error', 'shutdown_persist_failed', { code: 'SHUTDOWN_PERSIST_FAILED' }); }
      if (options.graceful) {
        wss.clients.forEach(function (socket) {
          send(socket, { type: 'server_notice', payload: { code: 'SERVER_RESTARTING', message: '服务正在更新，将自动恢复' } });
          try { socket.close(1012, 'restarting'); } catch (error) { socket.terminate(); }
        });
      } else {
        wss.clients.forEach(function (socket) { socket.terminate(); });
      }
      await new Promise(function (resolve) {
        if (!server.listening) { resolve(); return; }
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          wss.clients.forEach(function (socket) { socket.terminate(); });
          resolve();
        }, options.graceful ? 25000 : 5000);
        server.close(function () {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        });
      });
    })();
    return stopPromise;
  }

  return {
    server: server, wss: wss, runtime: runtime, store: store, config: config,
    metrics: metrics, start: start, stop: stop,
    gracefulStop: function () { return stop({ graceful: true }); },
    getReady: function () { return ready; },
  };
}

if (require.main === module) {
  var app = createServer();
  var shuttingDown = false;
  function handleSignal() {
    if (shuttingDown) return;
    shuttingDown = true;
    app.gracefulStop().then(function () { process.exit(0); }).catch(function () { process.exit(1); });
  }
  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);
  app.start().catch(function (error) {
    console.error('Server failed to start:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { createServer: createServer, normalizeOrigin: normalizeOrigin, originPolicy: originPolicy };
