/**
 * public/online-client.js — 《修行局》联机客户端（V0.1）
 * ============================================================================
 * 职责：
 *   - 连接 WebSocket（自动重连）
 *   - 发送命令（维护 requestId，等待 ok/error 响应）
 *   - 收到 room_view 后刷新 UI（通过 onView 回调）
 *   - 保存 seatToken / hostToken / roomId / seatId 到 localStorage
 *
 * 浏览器只负责显示与发送命令，不直接修改 StoryState / RoomState。
 * 所有状态裁决由服务端权威完成。
 * ============================================================================
 */
(function (global) {
  'use strict';

  var LS_KEY = 'xiuxingju_online_session';
  var RECONNECT_DELAY = 1500;
  var MAX_RECONNECT = 10;

  function OnlineClient() {
    this.ws = null;
    this.url = '';
    this._reqId = 0;
    this._pending = {};          // requestId -> {resolve, reject}
    this._viewListeners = [];
    this._eventListeners = [];
    this._statusListeners = [];
    this._reconnectCount = 0;
    this._closedByUser = false;
    this.session = loadSession();
    this.status = 'disconnected'; // disconnected | connecting | connected | reconnecting
  }

  /* ---------- 会话持久化 ---------- */
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function saveSession(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s || {})); } catch (e) {}
  }
  function clearSession() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
  }

  /* ---------- 状态广播 ---------- */
  function setStatus(self, s) {
    self.status = s;
    self._statusListeners.forEach(function (cb) { try { cb(s); } catch (e) {} });
  }

  /* ---------- 连接 ---------- */
  OnlineClient.prototype.connect = function (url) {
    var self = this;
    this.url = url || this.url || deriveUrl();
    this._closedByUser = false;
    return new Promise(function (resolve, reject) {
      setStatus(self, 'connecting');
      try { self.ws = new WebSocket(self.url); }
      catch (e) { reject(e); return; }

      self.ws.onopen = function () {
        self._reconnectCount = 0;
        setStatus(self, 'connected');
        resolve(self);
      };
      self.ws.onmessage = function (ev) { self._onMessage(ev); };
      self.ws.onerror = function () { /* close 会处理 */ };
      self.ws.onclose = function () {
        setStatus(self, 'disconnected');
        if (!self._closedByUser) self._scheduleReconnect();
      };
    });
  };

  OnlineClient.prototype._scheduleReconnect = function () {
    var self = this;
    if (this._reconnectCount >= MAX_RECONNECT) return;
    if (this._reconnectTimer) return;
    this._reconnectCount++;
    setStatus(self, 'reconnecting');
    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      self.connect(self.url).then(function () {
        // 重连后若有会话，自动 reconnect 房间
        if (self.session.roomId && self.session.seatId && self.session.token) {
          self.reconnect().catch(function () {});
        }
      }, function () { self._scheduleReconnect(); });
    }, RECONNECT_DELAY * Math.min(this._reconnectCount, 5));
  };

  OnlineClient.prototype.disconnect = function () {
    this._closedByUser = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
    setStatus(this, 'disconnected');
  };

  /* ---------- 消息分发 ---------- */
  OnlineClient.prototype._onMessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }

    if (msg.requestId && (msg.type === 'ok' || msg.type === 'error')) {
      var p = this._pending[msg.requestId];
      if (p) {
        delete this._pending[msg.requestId];
        if (msg.type === 'ok') p.resolve(msg.payload);
        else p.reject(msg.error);
      }
      return;
    }

    if (msg.type === 'room_view' && msg.payload && msg.payload.view) {
      this._viewListeners.forEach(function (cb) { try { cb(msg.payload.view, msg); } catch (e) {} });
    } else {
      // 其他广播事件（narration_failed 等）
      this._eventListeners.forEach(function (cb) { try { cb(msg); } catch (e) {} });
    }
  };

  /* ---------- 发送命令 ---------- */
  OnlineClient.prototype.send = function (type, extra) {
    var self = this;
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject({ code: 'NOT_CONNECTED', message: '未连接服务器' });
    }
    var requestId = 'req_' + (++this._reqId);
    var msg = Object.assign({ requestId: requestId, type: type }, extra || {});
    return new Promise(function (resolve, reject) {
      self._pending[requestId] = { resolve: resolve, reject: reject };
      try {
        self.ws.send(JSON.stringify(msg));
      } catch (e) {
        delete self._pending[requestId];
        reject({ code: 'SEND_FAILED', message: e.message });
      }
    });
  };

  /* ---------- 监听 ---------- */
  OnlineClient.prototype.onView = function (cb) {
    this._viewListeners.push(cb);
    return this;
  };
  OnlineClient.prototype.onEvent = function (cb) {
    this._eventListeners.push(cb);
    return this;
  };
  OnlineClient.prototype.onStatus = function (cb) {
    this._statusListeners.push(cb);
    cb(this.status);
    return this;
  };

  /* ---------- 命令 API ---------- */
  OnlineClient.prototype.ping = function () { return this.send('ping'); };

  OnlineClient.prototype.createRoom = function (payload) {
    var self = this;
    return this.send('create_room', { payload: payload }).then(function (res) {
      self.session = {
        roomId: res.roomId, roomCode: res.roomCode,
        seatId: res.hostSeatId, token: res.seatToken,
        hostToken: res.hostToken, isHost: true,
      };
      saveSession(self.session);
      return res;
    });
  };

  OnlineClient.prototype.joinRoom = function (roomCode, displayName) {
    var self = this;
    return this.send('join_room', { payload: { roomCode: roomCode, displayName: displayName } }).then(function (res) {
      self.session = {
        roomId: res.roomId, roomCode: roomCode,
        seatId: res.seatId, token: res.seatToken,
        hostToken: null, isHost: !!res.isHost,
      };
      saveSession(self.session);
      return res;
    });
  };

  OnlineClient.prototype.reconnect = function () {
    var s = this.session;
    if (!s) return Promise.reject({ code: 'NO_SESSION', message: '无本地会话' });
    return this.send('reconnect', { payload: {
      roomId: s.roomId, roomCode: s.roomCode, seatId: s.seatId, token: s.token,
    } });
  };

  OnlineClient.prototype.setReady = function (ready) {
    var s = this.session;
    return this.send('set_ready', { roomId: s.roomId, seatId: s.seatId, token: s.token, payload: { ready: ready } });
  };

  OnlineClient.prototype.assignActor = function (actorSetup) {
    var s = this.session;
    return this.send('assign_actor', { roomId: s.roomId, seatId: s.seatId, token: s.token, payload: { actorSetup: actorSetup } });
  };

  OnlineClient.prototype.startRoomWithArcVoting = function () {
    var s = this.session;
    return this.send('start_room_with_arc_voting', { roomId: s.roomId, seatId: s.seatId, token: s.hostToken || s.token });
  };

  OnlineClient.prototype.submitArcVote = function (arcId) {
    var s = this.session;
    return this.send('submit_arc_vote', { roomId: s.roomId, seatId: s.seatId, token: s.token, payload: { arcId: arcId } });
  };

  OnlineClient.prototype.finalizeArcVote = function () {
    var s = this.session;
    return this.send('finalize_arc_vote', { roomId: s.roomId, seatId: s.seatId, token: s.hostToken || s.token });
  };

  OnlineClient.prototype.submitAction = function (action) {
    var s = this.session;
    return this.send('submit_action', { roomId: s.roomId, seatId: s.seatId, token: s.token, payload: { action: action } });
  };

  OnlineClient.prototype.cancelAction = function () {
    var s = this.session;
    return this.send('cancel_action', { roomId: s.roomId, seatId: s.seatId, token: s.token });
  };

  OnlineClient.prototype.retryNarration = function () {
    var s = this.session;
    return this.send('retry_narration', { roomId: s.roomId, seatId: s.seatId, token: s.hostToken || s.token });
  };

  OnlineClient.prototype.getRoomView = function () {
    var s = this.session;
    return this.send('get_room_view', { roomId: s.roomId, seatId: s.seatId, token: s.token });
  };

  OnlineClient.prototype.leave = function () {
    clearSession();
    this.session = {};
    this.disconnect();
  };

  /* ---------- 工具：推导默认 WS 地址 ---------- */
  function deriveUrl() {
    var loc = global.location;
    if (!loc) return 'ws://localhost:8787/ws';
    var proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + loc.host + '/ws';
  }

  global.OnlineClient = OnlineClient;
})(typeof window !== 'undefined' ? window : globalThis);
