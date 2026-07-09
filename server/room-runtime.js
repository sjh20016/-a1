/**
 * server/room-runtime.js — 房间运行时
 * ============================================================================
 * 职责：
 *   - 创建房间码，维护 roomCode → roomId 映射
 *   - 调用 Room.coordinator（服务端权威）
 *   - 保存房间（file-store）
 *   - 广播过滤视图给相关玩家
 *   - 串行化每个房间的操作（withRoomLock）
 *   - Token 校验（auth）
 *
 * 客户端不能直接调用 Room.coordinator 修改状态，只能通过本运行时命令。
 * ============================================================================
 */
const Room = require('../room-core.js');
const Story = require('../story-core.js');
const auth = require('./auth');
const fileStore = require('./persistence/file-store');
const logger = require('./utils/logger');
const protocol = require('./protocol');

const rooms = Room.coordinator._rooms;       // roomId -> room
const roomCodes = new Map();                 // roomCode -> roomId
const socketsByRoom = new Map();             // roomId -> Set<ws>
const socketMeta = new WeakMap();            // ws -> { roomId, seatId, token, isHost }
const roomQueues = new Map();                // roomId -> Promise（串行锁）

// 恢复 Story RNG 的函数引用
fileStore.setStoryRestoreRng(function (storyState) {
  if (Story && typeof Story._activateState === 'function') {
    Story._activateState(storyState);
  }
});

/* ============================================================
 * 串行锁：每个房间命令串行执行，避免竞态
 * ============================================================ */
function withRoomLock(roomId, fn) {
  const prev = roomQueues.get(roomId) || Promise.resolve();
  const next = prev.then(fn, fn);
  roomQueues.set(roomId, next.catch(function () {}));
  return next;
}

/* ============================================================
 * 房间码 / socket 管理
 * ============================================================ */
function generateUniqueRoomCode() {
  for (let i = 0; i < 100; i++) {
    const code = auth.generateRoomCode();
    if (!roomCodes.has(code)) return code;
  }
  // 兜底：加时间戳后缀
  return auth.generateRoomCode() + '-' + Date.now().toString(36);
}

function attachSocket(ws, roomId, seatId, token, isHost) {
  let set = socketsByRoom.get(roomId);
  if (!set) { set = new Set(); socketsByRoom.set(roomId, set); }
  set.add(ws);
  socketMeta.set(ws, { roomId, seatId, token, isHost });
}

function detachSocket(ws) {
  const meta = socketMeta.get(ws);
  if (!meta) return;
  const set = socketsByRoom.get(meta.roomId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) socketsByRoom.delete(meta.roomId);
  }
  socketMeta.delete(ws);
}

function getSocketMeta(ws) { return socketMeta.get(ws) || null; }

/* ============================================================
 * 广播
 * ============================================================ */
function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return; // OPEN
  try { ws.send(JSON.stringify(obj)); } catch (e) {}
}

/** 给房间内每个 socket 发送其专属过滤视图 */
function broadcastRoomViews(room) {
  if (!room) return;
  const set = socketsByRoom.get(room.roomId);
  if (!set || set.size === 0) return;
  set.forEach(function (ws) {
    const meta = socketMeta.get(ws);
    if (!meta) return;
    const view = Room.RoomView.getForSeat(room, meta.seatId);
    send(ws, {
      type: 'room_view',
      roomId: room.roomId,
      seatId: meta.seatId,
      payload: { view: view },
    });
  });
}

/** 广播特殊事件（如 narration_failed） */
function broadcastEvent(room, type, payload) {
  const set = socketsByRoom.get(room.roomId);
  if (!set) return;
  set.forEach(function (ws) {
    const meta = socketMeta.get(ws);
    send(ws, {
      type: type,
      roomId: room.roomId,
      seatId: meta ? meta.seatId : '',
      payload: Object.assign({}, payload, { isHost: meta ? meta.isHost : false }),
    });
  });
}

/* ============================================================
 * 保存（每次状态变化后）
 * ============================================================ */
async function persist(room) {
  if (!room) return;
  // 快照 RNG（若 story-core 支持）
  try { if (room.storySession && Story.snapshotRng) Story.snapshotRng(room.storySession); } catch (e) {}
  await fileStore.saveRoom(room);
}

/* ============================================================
 * 启动：恢复所有房间
 * ============================================================ */
function restoreOnStartup() {
  fileStore.loadAllRooms(Room.coordinator, {
    onRoom: function (room) {
      if (room.roomCode) roomCodes.set(room.roomCode, room.roomId);
    },
  });
}

/* ============================================================
 * 命令处理：返回 { ok, payload } 或抛 Error
 * 每条修改状态的命令都先 withRoomLock。
 * ============================================================ */

/** create_room：房主创建，无需 token 校验 */
async function handleCreateRoom(ws, msg) {
  const p = msg.payload || {};
  const roomCode = generateUniqueRoomCode();
  const room = Room.coordinator.createRoom({
    hostName: p.hostName,
    mode: p.mode || 'online',
    seed: p.seed || '',
  });
  room.roomCode = roomCode;
  roomCodes.set(roomCode, room.roomId);
  // 生成 serverAuth（token）
  room.serverAuth = auth.createServerAuth(room);
  attachSocket(ws, room.roomId, room.hostSeatId, room.serverAuth.hostToken, true);
  await persist(room);
  logger.info('runtime', '创建房间 ' + room.roomCode, { roomId: room.roomId });
  return {
    roomId: room.roomId,
    roomCode: roomCode,
    hostSeatId: room.hostSeatId,
    hostToken: room.serverAuth.hostToken,
    seatToken: room.serverAuth.seatTokens[room.hostSeatId],
  };
}

/** join_room：通过房间码加入空席位 */
async function handleJoinRoom(ws, msg) {
  const p = msg.payload || {};
  const roomId = roomCodes.get(p.roomCode);
  if (!roomId) throw new ProtocolError('ROOM_NOT_FOUND', '房间码无效');
  return withRoomLock(roomId, async function () {
    const room = Room.coordinator.getRoom(roomId);
    if (!room) throw new ProtocolError('ROOM_NOT_FOUND', '房间不存在');
    if (room.status !== 'lobby') throw new ProtocolError('INVALID_ACTION', '房间已开始，无法加入');
    // 找第一个空席位
    const emptySeat = room.seats.find(function (s) { return s.kind === 'empty'; });
    if (!emptySeat) throw new ProtocolError('INVALID_ACTION', '房间已满');
    // 复用 coordinator.addHumanSeat（seatIndex）
    Room.coordinator.addHumanSeat(roomId, emptySeat.index, { displayName: p.displayName });
    // 为新 seat 生成 token
    if (!room.serverAuth) room.serverAuth = auth.createServerAuth(room);
    if (!room.serverAuth.seatTokens[emptySeat.seatId]) {
      room.serverAuth.seatTokens[emptySeat.seatId] = auth.generateToken();
    }
    const seatToken = room.serverAuth.seatTokens[emptySeat.seatId];
    attachSocket(ws, room.roomId, emptySeat.seatId, seatToken, emptySeat.seatId === room.hostSeatId);
    await persist(room);
    broadcastRoomViews(room);
    logger.info('runtime', '加入房间 ' + room.roomCode, { seatId: emptySeat.seatId });
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      seatId: emptySeat.seatId,
      seatToken: seatToken,
      isHost: emptySeat.seatId === room.hostSeatId,
    };
  });
}

/** reconnect：用 roomId/roomCode + seatId + token 恢复连接 */
async function handleReconnect(ws, msg) {
  const p = msg.payload || {};
  let room = null;
  if (p.roomId) {
    room = Room.coordinator.getRoom(p.roomId);
  } else if (p.roomCode) {
    const rid = roomCodes.get(p.roomCode);
    if (rid) room = Room.coordinator.getRoom(rid);
  }
  if (!room) throw new ProtocolError('ROOM_NOT_FOUND', '房间不存在');
  const v = auth.verify(room, p.seatId, p.token);
  if (!v.ok) throw new ProtocolError('UNAUTHORIZED', 'token 无效');
  attachSocket(ws, room.roomId, v.seatId, p.token, v.isHost);
  // 立即推送一次视图
  broadcastRoomViews(room);
  return { roomId: room.roomId, seatId: v.seatId, isHost: v.isHost, restored: true };
}

/** 通用：需要 roomId+seatId+token 的命令 */
async function handleSecuredCommand(ws, msg) {
  const type = msg.type;
  const room = Room.coordinator.getRoom(msg.roomId);
  if (!room) throw new ProtocolError('ROOM_NOT_FOUND', '房间不存在');
  const v = auth.verify(room, msg.seatId, msg.token);
  if (!v.ok) throw new ProtocolError('UNAUTHORIZED', 'token 无效');

  const isHostCommand = (type === 'finalize_arc_vote' || type === 'retry_narration' || type === 'start_room_with_arc_voting');
  if (isHostCommand && !v.isHost) {
    throw new ProtocolError('NOT_HOST', '仅房主可执行：' + type);
  }

  return withRoomLock(room.roomId, async function () {
    const r = Room.coordinator.getRoom(room.roomId);
    if (!r) throw new ProtocolError('ROOM_NOT_FOUND', '房间不存在');
    const seatId = v.seatId;
    const payload = msg.payload || {};

    switch (type) {
      case 'set_ready':
        Room.coordinator.setSeatReady(r.roomId, seatId, !!payload.ready);
        break;

      case 'assign_actor':
        Room.coordinator.assignActorToSeat(r.roomId, seatId, payload.actorSetup);
        break;

      case 'start_room_with_arc_voting':
        await Room.coordinator.startRoomWithArcVoting(r.roomId);
        break;

      case 'submit_arc_vote':
        Room.coordinator.submitArcVote(r.roomId, seatId, payload.arcId);
        break;

      case 'finalize_arc_vote':
        await Room.coordinator.finalizeArcVote(r.roomId, seatId);
        break;

      case 'submit_action':
        Room.coordinator.submitAction(r.roomId, seatId, payload.action);
        break;

      case 'cancel_action':
        Room.coordinator.cancelAction(r.roomId, seatId);
        break;

      case 'retry_narration':
        await Room.coordinator.retryNarration(r.roomId);
        break;

      case 'get_room_view':
        // 仅返回视图，不修改状态
        return { view: Room.RoomView.getForSeat(r, seatId) };

      default:
        throw new ProtocolError('UNKNOWN_TYPE', '未实现命令：' + type);
    }

    // 捕获进行中的结算 Promise（若存在）。必须在任何 await 之前捕获，
    // 否则异步结算可能在 await 期间完成并把 r._pending 置空，导致跳过最终态保存。
    const pending = r._pending;

    // 若有进行中的结算，先等待其完成，再保存最终态（避免把中间态 resolving 写入存档）
    if (pending) {
      try { await pending; } catch (e) { logger.error('runtime', '结算异常', { error: e.message }); }
      const r2 = Room.coordinator.getRoom(r.roomId) || r;
      if (r2.status === 'narration_failed') {
        broadcastEvent(r2, 'narration_failed', {
          message: r2.turn.lastError || '天机未应',
          canRetry: true,
        });
      }
      await persist(r2);
      broadcastRoomViews(r2);
      return { view: Room.RoomView.getForSeat(r2, seatId) };
    }

    // 无异步结算：直接保存 + 广播当前态
    await persist(r);
    if (r.status === 'narration_failed') {
      broadcastEvent(r, 'narration_failed', {
        message: r.turn.lastError || '天机未应',
        canRetry: true,
      });
    }
    broadcastRoomViews(r);
    return { view: Room.RoomView.getForSeat(r, seatId) };
  });
}

/* ============================================================
 * 主入口：处理一条客户端消息
 * ============================================================ */
async function handleMessage(ws, msg) {
  const requestId = msg && msg.requestId ? msg.requestId : '';
  try {
    const v = protocol.validate(msg);
    if (!v.ok) {
      return send(ws, protocol.error(requestId, v.error.code, v.error.message));
    }
    const type = msg.type;
    let result;
    if (type === 'ping') {
      result = { pong: true, ts: Date.now() };
    } else if (type === 'create_room') {
      result = await handleCreateRoom(ws, msg);
    } else if (type === 'join_room') {
      result = await handleJoinRoom(ws, msg);
    } else if (type === 'reconnect') {
      result = await handleReconnect(ws, msg);
    } else {
      result = await handleSecuredCommand(ws, msg);
    }
    send(ws, protocol.ok(requestId, result));
  } catch (e) {
    const code = (e && e.code) || protocol.ERROR_CODES.INTERNAL;
    const message = (e && e.message) || '内部错误';
    logger.warn('runtime', '命令失败 ' + (msg && msg.type), { code, message });
    send(ws, protocol.error(requestId, code, message));
  }
}

/** 处理 socket 关闭 */
function handleDisconnect(ws) {
  detachSocket(ws);
}

/** 协议错误：携带 code */
function ProtocolError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

module.exports = {
  rooms,
  roomCodes,
  socketsByRoom,
  withRoomLock,
  handleMessage,
  handleDisconnect,
  broadcastRoomViews,
  restoreOnStartup,
  getSocketMeta,
  attachSocket,
  _persist: persist,
  _ProtocolError: ProtocolError,
};
