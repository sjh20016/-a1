(function (root) {
  'use strict';

  var STORAGE_KEY = 'xiuxingju-online-session-v1';
  var socket = null;
  var socketUrl = '';
  var requestSeq = 0;
  var pending = new Map();
  var view = null;
  var session = readSession();
  var viewListeners = [];
  var statusListeners = [];
  var reconnectTimer = null;
  var manualClose = false;

  function storage() {
    try { return root.localStorage || null; } catch (error) { return null; }
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

  function emitStatus(status, detail) {
    statusListeners.slice().forEach(function (listener) { listener(status, detail || null); });
  }

  function emitView(next) {
    view = next;
    viewListeners.slice().forEach(function (listener) { listener(next); });
  }

  function defaultUrl() {
    if (!root.location) return 'ws://127.0.0.1:8787/ws';
    return (root.location.protocol === 'https:' ? 'wss://' : 'ws://') + root.location.host + '/ws';
  }

  function rejectPending(error) {
    pending.forEach(function (entry) { entry.reject(error); });
    pending.clear();
  }

  function connect(url) {
    socketUrl = url || socketUrl || defaultUrl();
    manualClose = false;
    if (socket && socket.readyState === 1) return Promise.resolve(OnlineClient);
    return new Promise(function (resolve, reject) {
      var WS = root.WebSocket;
      if (!WS) { reject(new Error('当前环境不支持 WebSocket')); return; }
      socket = new WS(socketUrl);
      socket.onopen = function () {
        emitStatus('connected');
        resolve(OnlineClient);
      };
      socket.onerror = function () { emitStatus('error'); };
      socket.onmessage = function (event) {
        var message;
        try { message = JSON.parse(event.data); } catch (error) { return; }
        if (message.type === 'room_view' && message.payload) {
          emitView(message.payload.view);
          return;
        }
        if (!message.requestId || !pending.has(message.requestId)) return;
        var entry = pending.get(message.requestId);
        pending.delete(message.requestId);
        if (message.type === 'error') {
          var error = new Error(message.error && message.error.message || '服务器错误');
          error.code = message.error && message.error.code;
          entry.reject(error);
        } else {
          entry.resolve(message.payload || {});
        }
      };
      socket.onclose = function () {
        emitStatus('disconnected');
        rejectPending(new Error('WebSocket 已断开'));
        if (!manualClose) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(function () {
            connect(socketUrl).then(function () {
              if (session.roomId && session.seatId && session.seatToken) return OnlineClient.reconnect();
            }).catch(function () {});
          }, 1500);
        }
      };
    });
  }

  function request(type, payload, options) {
    options = options || {};
    if (!socket || socket.readyState !== 1) return Promise.reject(new Error('WebSocket 尚未连接'));
    var requestId = 'req_' + Date.now() + '_' + (++requestSeq);
    var message = { requestId: requestId, type: type, payload: payload || {} };
    if (options.auth !== false && session.roomId) {
      message.roomId = session.roomId;
      message.seatId = session.seatId;
      message.token = session.seatToken;
    }
    if (options.host) message.hostToken = session.hostToken || '';
    return new Promise(function (resolve, reject) {
      pending.set(requestId, { resolve: resolve, reject: reject });
      socket.send(JSON.stringify(message));
    });
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
    close: function () { manualClose = true; clearTimeout(reconnectTimer); if (socket) socket.close(); },
    createRoom: function (payload) { return request('create_room', payload, { auth: false }).then(function (r) { return remember(r, true); }); },
    joinRoom: function (roomCode, displayName) { return request('join_room', { roomCode: roomCode, displayName: displayName }, { auth: false }).then(function (r) { return remember(r, false); }); },
    reconnect: function (roomId, seatId, token) {
      if (roomId) session.roomId = roomId;
      if (seatId) session.seatId = seatId;
      if (token) session.seatToken = token;
      return request('reconnect', {}, { auth: true }).then(function (r) { if (r.view) emitView(r.view); return r; });
    },
    assignActor: function (actorSetup) { return request('assign_actor', { actorSetup: actorSetup }); },
    setReady: function (ready) { return request('set_ready', { ready: !!ready }); },
    startRoomWithArcVoting: function () { return request('start_room_with_arc_voting', {}, { host: true }); },
    submitArcVote: function (arcId) { return request('submit_arc_vote', { arcId: arcId }); },
    finalizeArcVote: function () { return request('finalize_arc_vote', {}, { host: true }); },
    submitAction: function (action) { return request('submit_action', { action: action }); },
    cancelAction: function () { return request('cancel_action', {}); },
    retryNarration: function () { return request('retry_narration', {}, { host: true }); },
    getRoomView: function () { return request('get_room_view', {}).then(function (r) { if (r.view) emitView(r.view); return r.view; }); },
    ping: function () { return request('ping', {}, { auth: false }); },
    getSession: function () { return Object.assign({}, session); },
    getRoomViewSnapshot: function () { return view; },
    onRoomView: function (listener) { viewListeners.push(listener); return function () { viewListeners = viewListeners.filter(function (x) { return x !== listener; }); }; },
    onStatus: function (listener) { statusListeners.push(listener); return function () { statusListeners = statusListeners.filter(function (x) { return x !== listener; }); }; },
    clearSession: function () { session = {}; saveSession(); view = null; },
  };

  root.OnlineClient = OnlineClient;
  if (typeof module !== 'undefined' && module.exports) module.exports = OnlineClient;
})(typeof window !== 'undefined' ? window : globalThis);
