'use strict';

const crypto = require('crypto');
const auth = require('./auth.js');
const { ProtocolError } = require('./protocol.js');

function send(socket, message) {
  if (!socket || socket.readyState !== 1) return false;
  socket.send(JSON.stringify(message));
  return true;
}

class RoomRuntime {
  constructor(options) {
    options = options || {};
    this.Room = options.Room;
    this.Story = options.Story;
    this.store = options.store;
    this.logger = options.logger || console;
    this.config = options.config || {};
    this.roomCodes = new Map();
    this.socketsByRoom = new Map();
    this.socketMeta = new WeakMap();
    this.roomQueues = new Map();
  }

  withRoomLock(roomId, fn) {
    var self = this;
    var previous = this.roomQueues.get(roomId) || Promise.resolve();
    var next = previous.then(fn, fn);
    var tail = next.catch(function () {});
    this.roomQueues.set(roomId, tail);
    return next.finally(function () {
      if (self.roomQueues.get(roomId) === tail) self.roomQueues.delete(roomId);
    });
  }

  generateRoomCode() {
    for (var i = 0; i < 100; i++) {
      var code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      if (!this.roomCodes.has(code)) return code;
    }
    throw new ProtocolError('ROOM_CODE_EXHAUSTED', '暂时无法分配房间码');
  }

  getRoom(roomId) {
    var room = this.Room.coordinator.getRoom(roomId);
    if (!room) throw new ProtocolError('ROOM_NOT_FOUND', '房间不存在');
    return room;
  }

  bindSocket(socket, room, seatId) {
    var previous = this.socketMeta.get(socket);
    if (previous && this.socketsByRoom.has(previous.roomId)) this.socketsByRoom.get(previous.roomId).delete(socket);
    this.socketMeta.set(socket, { roomId: room.roomId, seatId: seatId });
    if (!this.socketsByRoom.has(room.roomId)) this.socketsByRoom.set(room.roomId, new Set());
    this.socketsByRoom.get(room.roomId).add(socket);
    var seat = room.seats.find(function (item) { return item.seatId === seatId; });
    if (seat) seat.connectionStatus = 'connected';
  }

  broadcastRoomViews(room) {
    var sockets = this.socketsByRoom.get(room.roomId);
    if (!sockets) return;
    var self = this;
    sockets.forEach(function (socket) {
      var meta = self.socketMeta.get(socket);
      if (!meta || meta.roomId !== room.roomId) return;
      var view = self.Room.RoomView.getForSeat(room, meta.seatId);
      if (!view) return;
      send(socket, {
        type: 'room_view', roomId: room.roomId, seatId: meta.seatId,
        payload: { view: view },
      });
    });
  }

  async persist(room) {
    if (this.store) await this.store.saveRoom(room);
  }

  restoreRuntimeState(room) {
    room._pending = null;
    room.serverAuth = room.serverAuth || { hostTokenHash: '', seatTokenHashes: {} };
    room.serverAuth.seatTokenHashes = room.serverAuth.seatTokenHashes || {};
    if (room.status === 'resolving' || room.status === 'locked' || room.turn && (room.turn.phase === 'resolving' || room.turn.phase === 'locked')) {
      var pending = room.storySession && room.storySession.story && room.storySession.story.pendingResolution;
      if (pending) {
        room.status = 'narration_failed';
        room.turn.phase = 'narration_failed';
        room.storySession.story.turnPhase = 'narration_failed';
      } else {
        room.status = 'collecting';
        room.turn.phase = 'collecting';
        if (room.storySession && room.storySession.story) room.storySession.story.turnPhase = 'collecting';
      }
    }
    (room.seats || []).forEach(function (seat) {
      if (seat.controller && seat.controller.kind === 'remote-human') seat.connectionStatus = 'disconnected';
    });
    if (!room.roomCode) room.roomCode = this.generateRoomCode();
    this.roomCodes.set(room.roomCode, room.roomId);
    return room;
  }

  async loadRooms() {
    if (!this.store) return [];
    var snapshots = await this.store.loadAllRooms();
    var loaded = [];
    for (var i = 0; i < snapshots.length; i++) {
      try {
        var room = this.Room.coordinator.loadRoom({ room: snapshots[i] });
        if (!room) continue;
        this.restoreRuntimeState(room);
        loaded.push(room);
      } catch (error) {
        this.logger.warn('跳过损坏房间存档：', error.message);
      }
    }
    return loaded;
  }

  async disconnect(socket) {
    var meta = this.socketMeta.get(socket);
    if (!meta) return;
    var sockets = this.socketsByRoom.get(meta.roomId);
    if (sockets) sockets.delete(socket);
    this.socketMeta.delete(socket);
    var self = this;
    await this.withRoomLock(meta.roomId, async function () {
      var room = self.Room.coordinator.getRoom(meta.roomId);
      if (!room) return;
      var stillConnected = sockets && Array.from(sockets).some(function (candidate) {
        var candidateMeta = self.socketMeta.get(candidate);
        return candidateMeta && candidateMeta.seatId === meta.seatId;
      });
      if (!stillConnected) {
        var seat = room.seats.find(function (item) { return item.seatId === meta.seatId; });
        if (seat) seat.connectionStatus = 'disconnected';
        await self.persist(room);
        self.broadcastRoomViews(room);
      }
    });
  }

  _assertHost(room, message) {
    return auth.assertHost(room, message.seatId, message.token, message.hostToken || message.payload && message.payload.hostToken);
  }

  _assertSeat(room, message) {
    return auth.assertSeat(room, message.seatId, message.token);
  }

  async createRoom(socket, payload) {
    payload = payload || {};
    var hostName = String(payload.hostName || '').trim().slice(0, 40);
    if (!hostName) throw new ProtocolError('INVALID_PAYLOAD', 'hostName 不能为空');
    var roomCode = this.generateRoomCode();
    var room = this.Room.coordinator.createRoom({ hostName: hostName, mode: 'online', seed: payload.seed || '' });
    room.roomCode = roomCode;
    var hostSeat = room.seats.find(function (seat) { return seat.seatId === room.hostSeatId; });
    hostSeat.controller.kind = 'remote-human';
    hostSeat.connectionStatus = 'connected';
    var seatToken = auth.issueSeatToken(room, hostSeat.seatId);
    var hostToken = auth.issueHostToken(room);
    this.roomCodes.set(roomCode, room.roomId);
    this.bindSocket(socket, room, hostSeat.seatId);
    await this.persist(room);
    this.broadcastRoomViews(room);
    return {
      roomId: room.roomId, roomCode: roomCode, hostSeatId: hostSeat.seatId,
      seatId: hostSeat.seatId, hostToken: hostToken, seatToken: seatToken,
      view: this.Room.RoomView.getForSeat(room, hostSeat.seatId),
    };
  }

  async joinRoom(socket, payload) {
    payload = payload || {};
    var code = String(payload.roomCode || '').trim();
    var roomId = this.roomCodes.get(code);
    if (!roomId) throw new ProtocolError('ROOM_NOT_FOUND', '房间码不存在');
    var self = this;
    return this.withRoomLock(roomId, async function () {
      var room = self.getRoom(roomId);
      if (room.status !== 'lobby') throw new ProtocolError('ROOM_ALREADY_STARTED', '房间已经开始');
      var index = room.seats.findIndex(function (seat) { return seat.kind === 'empty'; });
      if (index < 0) throw new ProtocolError('ROOM_FULL', '房间已满');
      var displayName = String(payload.displayName || '').trim().slice(0, 40);
      if (!displayName) throw new ProtocolError('INVALID_PAYLOAD', 'displayName 不能为空');
      var seat = self.Room.coordinator.addHumanSeat(roomId, index, { displayName: displayName });
      seat.controller.kind = 'remote-human';
      seat.connectionStatus = 'connected';
      var seatToken = auth.issueSeatToken(room, seat.seatId);
      self.bindSocket(socket, room, seat.seatId);
      await self.persist(room);
      self.broadcastRoomViews(room);
      return {
        roomId: room.roomId, roomCode: room.roomCode, seatId: seat.seatId,
        seatToken: seatToken, view: self.Room.RoomView.getForSeat(room, seat.seatId),
      };
    });
  }

  async reconnect(socket, message) {
    var room = this.getRoom(message.roomId);
    this._assertSeat(room, message);
    this.bindSocket(socket, room, message.seatId);
    await this.persist(room);
    this.broadcastRoomViews(room);
    return { roomId: room.roomId, seatId: message.seatId, view: this.Room.RoomView.getForSeat(room, message.seatId) };
  }

  async handleCommand(socket, message) {
    var self = this;
    var payload = message.payload || {};
    if (message.type === 'ping') return { pong: true, now: Date.now() };
    if (message.type === 'create_room') return this.createRoom(socket, payload);
    if (message.type === 'join_room') return this.joinRoom(socket, payload);
    if (message.type === 'reconnect') return this.reconnect(socket, message);

    var room = this.getRoom(message.roomId);
    this._assertSeat(room, message);
    this.bindSocket(socket, room, message.seatId);
    if (message.type === 'get_room_view') {
      return { view: this.Room.RoomView.getForSeat(room, message.seatId) };
    }

    return this.withRoomLock(room.roomId, async function () {
      room = self.getRoom(message.roomId);
      self._assertSeat(room, message);
      try { switch (message.type) {
        case 'assign_actor': {
          var setup = payload.actorSetup;
          if (!setup || typeof setup !== 'object') throw new ProtocolError('INVALID_PAYLOAD', '缺少 actorSetup');
          var normalized = {
            name: String(setup.name || '').trim().slice(0, 40),
            identity: String(setup.identity || '').trim().slice(0, 100),
            daoPath: String(setup.daoPath || '').trim().slice(0, 40),
            publicWish: String(setup.publicWish || '').trim().slice(0, 200),
            hiddenFate: String(setup.hiddenFate || '').trim().slice(0, 300),
            personalityTags: Array.isArray(setup.personalityTags) ? setup.personalityTags.slice(0, 8).map(String) : [],
          };
          if (!normalized.name || !normalized.identity || !normalized.daoPath) throw new ProtocolError('INVALID_PAYLOAD', '角色名、身份和道途不能为空');
          self.Room.coordinator.assignActorToSeat(room.roomId, message.seatId, normalized);
          break;
        }
        case 'set_ready':
          self.Room.coordinator.setSeatReady(room.roomId, message.seatId, !!payload.ready);
          break;
        case 'start_room_with_arc_voting':
          self._assertHost(room, message);
          await self.Room.coordinator.startRoomWithArcVoting(room.roomId);
          break;
        case 'submit_arc_vote':
          self.Room.coordinator.submitArcVote(room.roomId, message.seatId, payload.arcId);
          break;
        case 'finalize_arc_vote':
          self._assertHost(room, message);
          await self.Room.coordinator.finalizeArcVote(room.roomId, message.seatId);
          break;
        case 'submit_action': {
          var boundaryResolved = false;
          var resolveBoundary;
          var boundaryPersisted = new Promise(function (resolve) { resolveBoundary = resolve; });
          room._beforeNarration = async function () {
            self.broadcastRoomViews(room);
            await self.persist(room);
            boundaryResolved = true;
            resolveBoundary();
          };
          self.Room.coordinator.submitAction(room.roomId, message.seatId, payload.action);
          self.broadcastRoomViews(room);
          var pending = room._pending;
          if (pending) {
            // pendingResolution 已建立后的快照必须先落盘，然后才等待 AI。
            await Promise.race([boundaryPersisted, pending]);
            await pending;
          } else {
            room._beforeNarration = null;
            await self.persist(room);
            boundaryResolved = true;
            resolveBoundary();
          }
          if (!boundaryResolved) resolveBoundary();
          break;
        }
        case 'cancel_action':
          self.Room.coordinator.cancelAction(room.roomId, message.seatId);
          break;
        case 'retry_narration':
          self._assertHost(room, message);
          await self.Room.coordinator.retryNarration(room.roomId, {});
          break;
        default:
          throw new ProtocolError('INVALID_COMMAND', '未知命令');
      } } catch (error) {
        if (error instanceof ProtocolError) throw error;
        throw new ProtocolError('COMMAND_REJECTED', error && error.message || '命令被当前房间状态拒绝');
      }
      await self.persist(room);
      self.broadcastRoomViews(room);
      return { view: self.Room.RoomView.getForSeat(room, message.seatId) };
    });
  }
}

module.exports = { RoomRuntime: RoomRuntime, send: send };
