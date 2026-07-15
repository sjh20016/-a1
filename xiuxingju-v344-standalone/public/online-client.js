(function (root) {
  'use strict';

  var STORAGE_KEY = 'xiuxingju-online-session-v1';
  var ACCESS_KEY = 'xiuxingju-beta-access-v1';
  var socket = null;
  var socketUrl = '';
  var requestSeq = 0;
  var pending = new Map();
  var flights = new Map();
  var view = null;
  var session = readSession();
  var bootstrap = null;
  var viewListeners = [];
  var statusListeners = [];
  var reconnectTimer = null;
  var connectPromise = null;
  var reconnectAttempt = 0;
  var manualClose = false;
  var connectionState = 'idle';
  var lastError = null;
  var lastDiagnosticId = '';
  var accessCode = readAccessCode();

  function storage() {
    try { return root.localStorage || null; } catch (error) { return null; }
  }

  function sessionStorage() {
    try { return root.sessionStorage || null; } catch (error) { return null; }
  }

  function readSession() {
    try {
      var s = storage();
      return s ? JSON.parse(s.getItem(STORAGE_KEY) || '{}') : {};
    } catch (error) { return {}; }
  }

  function saveSession() {
    var s = storage();
    if (s) s.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function readAccessCode() {
    var value = '';
    try {
      var s = sessionStorage();
      value = s && s.getItem(ACCESS_KEY) || '';
      if (root.location && root.location.href) {
        var url = new URL(root.location.href);
        var fromUrl = url.searchParams.get('access');
        if (fromUrl) {
          value = fromUrl;
          if (s) s.setItem(ACCESS_KEY, value);
          url.searchParams.delete('access');
          if (root.history && root.history.replaceState) root.history.replaceState({}, '', url.pathname + (url.search ? url.search : '') + url.hash);
        }
      }
    } catch (error) {}
    return value;
  }

  function inviteRoomCode() {
    try {
      if (!root.location || !root.location.href) return '';
      return (new URL(root.location.href)).searchParams.get('room') || '';
    } catch (error) { return ''; }
  }

  function emitStatus(status, detail) {
    connectionState = status;
    if (detail && detail.error) lastError = detail.error;
    statusListeners.slice().forEach(function (listener) { listener(status, detail || null); });
  }

  function emitView(next) {
    view = next;
    viewListeners.slice().forEach(function (listener) { listener(next); });
  }

  function defaultUrl() {
    if (!root.location) return 'ws://127.0.0.1:8787/ws';
    var url = new URL('/ws', root.location.href);
    url.protocol = root.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  function httpOrigin() {
    if (!root.location) return '';
    return root.location.origin || (root.location.protocol + '//' + root.location.host);
  }

  function makeError(code, message) {
    var error = new Error(message || code);
    error.code = code;
    return error;
  }

  function rejectPending(error) {
    pending.forEach(function (entry) { clearTimeout(entry.timer); entry.reject(error); });
    pending.clear();
  }

  function fetchJson(pathname, timeoutMs) {
    if (!root.fetch || !httpOrigin()) return Promise.resolve(null);
    var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, timeoutMs || 8000);
    return root.fetch(httpOrigin() + pathname, { cache: 'no-store', signal: controller && controller.signal }).then(function (response) {
      return response.text().then(function (text) {
        var body = {};
        try { body = text ? JSON.parse(text) : {}; } catch (error) {}
        if (!response.ok) {
          var failure = makeError(response.status === 503 ? 'SERVER_WAKING' : 'HEALTH_CHECK_FAILED', '云端服务暂未就绪');
          failure.status = response.status;
          failure.body = body;
          throw failure;
        }
        return body;
      });
    }).finally(function () { clearTimeout(timer); });
  }

  function checkReady(deadline) {
    if (!root.fetch || !httpOrigin()) return Promise.resolve(null);
    emitStatus('checking');
    return fetchJson('/readyz', 8000).catch(function (error) {
      if (error.code !== 'SERVER_WAKING' && error.code !== 'HEALTH_CHECK_FAILED') throw error;
      if (Date.now() >= deadline) throw makeError('WS_CONNECT_TIMEOUT', '云端服务唤醒超时');
      emitStatus('waking', { attempt: reconnectAttempt });
      return new Promise(function (resolve) { setTimeout(resolve, Math.min(1200, Math.max(300, deadline - Date.now()))); }).then(function () { return checkReady(deadline); });
    });
  }

  function connectSocket(url, deadline) {
    return new Promise(function (resolve, reject) {
      var WS = root.WebSocket;
      if (!WS) { reject(makeError('WEBSOCKET_UNAVAILABLE', '当前环境不支持 WebSocket')); return; }
      var opened = false;
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch (error) {}
        reject(makeError('WS_CONNECT_TIMEOUT', '连接云端房间超时'));
      }, Math.max(1, deadline - Date.now()));
      try { socket = new WS(url); } catch (error) { clearTimeout(timer); reject(makeError('WS_CONNECT_FAILED', '无法创建云端连接')); return; }
      socket.onopen = function () {
        opened = true;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reconnectAttempt = 0;
        emitStatus('connected');
        resolve(OnlineClient);
      };
      socket.onerror = function () {
        if (!opened && !settled) {
          settled = true;
          clearTimeout(timer);
          reject(makeError('WS_CONNECT_FAILED', '无法连接云端房间'));
        }
      };
      socket.onmessage = function (event) {
        var message;
        try { message = JSON.parse(event.data); } catch (error) { return; }
        if (message.type === 'server_notice') {
          emitStatus('reconnecting', { code: message.payload && message.payload.code || 'SERVER_RESTARTING' });
          return;
        }
        if (message.type === 'room_view' && message.payload) {
          emitView(message.payload.view);
          return;
        }
        if (!message.requestId || !pending.has(message.requestId)) return;
        var entry = pending.get(message.requestId);
        pending.delete(message.requestId);
        clearTimeout(entry.timer);
        if (message.type === 'error') {
          var error = makeError(message.error && message.error.code || 'INTERNAL_ERROR', message.error && message.error.message || '服务器暂时无法完成该操作');
          error.diagnosticId = message.diagnosticId || '';
          if (error.diagnosticId) lastDiagnosticId = error.diagnosticId;
          entry.reject(error);
        } else {
          entry.resolve(message.payload || {});
        }
      };
      socket.onclose = function (event) {
        clearTimeout(timer);
        rejectPending(makeError(event && event.code === 1012 ? 'SERVER_RESTARTING' : 'WS_DISCONNECTED', event && event.code === 1012 ? '服务正在更新，将自动恢复' : '云端连接已断开'));
        if (!manualClose) {
          emitStatus('reconnecting', { attempt: reconnectAttempt + 1, closeCode: event && event.code || 0 });
          scheduleReconnect();
        } else {
          emitStatus('idle');
        }
        if (!opened && !settled) { settled = true; reject(makeError('WS_CONNECT_FAILED', '无法连接云端房间')); }
      };
    });
  }

  function backoffDelay(attempt) {
    var base = Math.min(15000, 1000 * Math.pow(2, Math.max(0, attempt - 1)));
    return Math.min(15000, Math.max(250, Math.round(base * (0.8 + Math.random() * 0.4))));
  }

  function scheduleReconnect(delayOverride) {
    if (manualClose || reconnectTimer) return;
    if (connectPromise) { setTimeout(function () { scheduleReconnect(delayOverride); }, 0); return; }
    reconnectAttempt++;
    var delay = delayOverride == null ? backoffDelay(reconnectAttempt) : delayOverride;
    emitStatus(reconnectAttempt >= 8 ? 'offline' : 'reconnecting', { attempt: reconnectAttempt, delayMs: delay });
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect(socketUrl, { reconnect: true }).then(function () {
        if (session.roomId && session.seatId && session.seatToken) return OnlineClient.reconnect();
      }).catch(function () {});
    }, delay);
  }

  function startConnect(url, options) {
    options = options || {};
    socketUrl = url || socketUrl || defaultUrl();
    manualClose = false;
    var deadline = Date.now() + 12000;
    return checkReady(deadline).then(function () {
      return fetchJson('/api/bootstrap', 4000).then(function (body) { bootstrap = body || bootstrap; return body; }).catch(function () { return null; });
    }).then(function () {
      if (manualClose) throw makeError('WS_CONNECT_CANCELLED', '连接已取消');
      emitStatus(options.reconnect ? 'reconnecting' : 'connecting');
      return connectSocket(socketUrl, deadline);
    }).catch(function (error) {
      lastError = error;
      if (!manualClose) setTimeout(function () { scheduleReconnect(); }, 0);
      throw error;
    });
  }

  function connect(url, options) {
    socketUrl = url || socketUrl || defaultUrl();
    if (socket && socket.readyState === 1) return Promise.resolve(OnlineClient);
    if (connectPromise) return connectPromise;
    connectPromise = startConnect(socketUrl, options).finally(function () { connectPromise = null; });
    return connectPromise;
  }

  function ensureConnected() {
    if (socket && socket.readyState === 1) return Promise.resolve(OnlineClient);
    return connect();
  }

  function request(type, payload, options) {
    options = options || {};
    return ensureConnected().then(function () {
      if (!socket || socket.readyState !== 1) throw makeError('WS_NOT_CONNECTED', '正在连接云端房间，请稍候');
      var requestId = 'req_' + Date.now() + '_' + (++requestSeq);
      var message = { requestId: requestId, type: type, payload: payload || {} };
      if (options.auth !== false && session.roomId) {
        message.roomId = session.roomId;
        message.seatId = session.seatId;
        message.token = session.seatToken;
      }
      if (options.host) message.hostToken = session.hostToken || '';
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          reject(makeError('REQUEST_TIMEOUT', '云端响应超时'));
        }, 70000);
        pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
        try { socket.send(JSON.stringify(message)); } catch (error) { clearTimeout(timer); pending.delete(requestId); reject(makeError('WS_SEND_FAILED', '云端连接不可用')); }
      });
    });
  }

  function dedupe(key, task) {
    if (flights.has(key)) return flights.get(key);
    var promise = Promise.resolve().then(task).finally(function () { flights.delete(key); });
    flights.set(key, promise);
    return promise;
  }

  function remember(result, isHost) {
    session.roomId = result.roomId;
    session.roomCode = result.roomCode || session.roomCode;
    session.seatId = result.seatId || result.hostSeatId;
    session.seatToken = result.seatToken;
    if (isHost) session.hostToken = result.hostToken;
    saveSession();
    if (result.view) emitView(result.view);
    return result;
  }

  var OnlineClient = {
    connect: connect,
    ensureConnected: ensureConnected,
    close: function () { manualClose = true; clearTimeout(reconnectTimer); reconnectTimer = null; if (socket) { try { socket.close(); } catch (error) {} } rejectPending(makeError('WS_CONNECT_CANCELLED', '连接已取消')); emitStatus('idle'); },
    createRoom: function (payload) {
      return dedupe('create_room', function () { payload = Object.assign({}, payload || {}); if (accessCode) payload.accessCode = accessCode; return request('create_room', payload, { auth: false }).then(function (r) { return remember(r, true); }); });
    },
    joinRoom: function (roomCode, displayName) {
      return dedupe('join_room:' + roomCode, function () { var payload = { roomCode: roomCode, displayName: displayName }; if (accessCode) payload.accessCode = accessCode; return request('join_room', payload, { auth: false }).then(function (r) { return remember(r, false); }); });
    },
    reconnect: function (roomId, seatId, token) {
      if (roomId) session.roomId = roomId;
      if (seatId) session.seatId = seatId;
      if (token) session.seatToken = token;
      return dedupe('reconnect', function () { return request('reconnect', {}, { auth: true }).then(function (r) { if (r.view) emitView(r.view); return r; }); });
    },
    assignActor: function (actorSetup) { return request('assign_actor', { actorSetup: actorSetup }); },
    setReady: function (ready) { return request('set_ready', { ready: !!ready }); },
    startRoomWithArcVoting: function () { return request('start_room_with_arc_voting', {}, { host: true }); },
    submitArcVote: function (arcId) { return request('submit_arc_vote', { arcId: arcId }); },
    finalizeArcVote: function () { return request('finalize_arc_vote', {}, { host: true }); },
    submitAction: function (action) { return dedupe('submit_action', function () { return request('submit_action', { action: action }); }); },
    cancelAction: function () { return request('cancel_action', {}); },
    retryNarration: function () { return dedupe('retry_narration', function () { return request('retry_narration', {}, { host: true }); }); },
    getRoomView: function () { return request('get_room_view', {}).then(function (r) { if (r.view) emitView(r.view); return r.view; }); },
    ping: function () { return request('ping', {}, { auth: false }); },
    getSession: function () { return Object.assign({}, session); },
    getRoomViewSnapshot: function () { return view; },
    getConnectionState: function () { return connectionState; },
    getLastError: function () { return lastError; },
    getBootstrap: function () { return bootstrap; },
    getInviteRoomCode: inviteRoomCode,
    getInviteUrl: function (roomCode) {
      if (!root.location) return '?room=' + encodeURIComponent(roomCode || '');
      var url = new URL(root.location.href);
      url.search = '';
      url.hash = '';
      url.searchParams.set('room', roomCode || session.roomCode || '');
      if (accessCode) url.searchParams.set('access', accessCode);
      return url.toString();
    },
    getDiagnostics: function () {
      return {
        version: bootstrap && bootstrap.version || 'unknown',
        connectionState: connectionState,
        roomCode: session.roomCode || '',
        lastErrorCode: lastError && lastError.code || '',
        diagnosticId: lastDiagnosticId || lastError && lastError.diagnosticId || '',
        networkOnline: root.navigator && root.navigator.onLine !== false,
      };
    },
    onRoomView: function (listener) { viewListeners.push(listener); return function () { viewListeners = viewListeners.filter(function (x) { return x !== listener; }); }; },
    onStatus: function (listener) { statusListeners.push(listener); return function () { statusListeners = statusListeners.filter(function (x) { return x !== listener; }); }; },
    clearSession: function () { session = {}; saveSession(); view = null; },
    setAccessCode: function (value) { accessCode = String(value || ''); var s = sessionStorage(); if (s && accessCode) s.setItem(ACCESS_KEY, accessCode); },
  };

  if (root.addEventListener) {
    root.addEventListener('online', function () { reconnectAttempt = 0; if (!socket || socket.readyState !== 1) scheduleReconnect(0); });
    var visibilityTarget = root.document || root;
    visibilityTarget.addEventListener('visibilitychange', function () { if ((visibilityTarget.visibilityState || root.visibilityState) === 'visible' && (!socket || socket.readyState !== 1)) scheduleReconnect(0); });
  }

  root.OnlineClient = OnlineClient;
  if (typeof module !== 'undefined' && module.exports) module.exports = OnlineClient;
})(typeof window !== 'undefined' ? window : globalThis);
