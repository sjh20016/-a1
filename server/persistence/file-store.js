/**
 * server/persistence/file-store.js — 房间文件存档
 * ============================================================================
 * 保存路径：{ROOM_SAVE_DIR}/{roomId}.json
 * 保存前清理：room._pending、socket 对象、AI API Key、临时 Promise。
 * 启动时 loadAllRooms 重建房间 + roomCode 映射。
 *
 * 状态修复（重启时）：
 *   - room.status = resolving → 若有 pendingResolution 改 narration_failed，否则 collecting
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

let SAVE_DIR = '';

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function init(saveDir) {
  SAVE_DIR = saveDir;
  ensureDir(SAVE_DIR);
}

function filePath(roomId) {
  // 仅允许字母数字下划线，防止路径穿越
  if (!/^[\w-]+$/.test(roomId)) throw new Error('非法 roomId');
  return path.join(SAVE_DIR, roomId + '.json');
}

/** 清理存档：剔除运行时字段与敏感字段 */
function sanitize(room) {
  // 深拷贝
  const snap = JSON.parse(JSON.stringify(room));
  delete snap._pending;
  delete snap.serverAuth; // 不把 token 写入存档文件（重连时由内存重建？不行——重启后内存也丢了）
  // 注：MVP 需要重启后仍能 reconnect，因此 serverAuth 必须入存档。
  // 但 API Key 绝不入存档。serverAuth 中只有 token，无 API Key，可入存档。
  // 重新挂回 serverAuth
  snap.serverAuth = room.serverAuth ? JSON.parse(JSON.stringify(room.serverAuth)) : null;
  // 剔除任何残留的 apiKey 字段（防御性）
  stripKeys(snap, ['apiKey', '_apiKey', 'key', 'AI_API_KEY']);
  return snap;
}

function stripKeys(obj, keys) {
  if (!obj || typeof obj !== 'object') return;
  keys.forEach(function (k) { delete obj[k]; });
  Object.keys(obj).forEach(function (k) {
    if (typeof obj[k] === 'object' && obj[k] !== null) stripKeys(obj[k], keys);
  });
}

/** 保存房间到文件 */
async function saveRoom(room) {
  if (!room || !room.roomId) return;
  try {
    const snap = sanitize(room);
    const data = JSON.stringify({ saveVersion: 'server-0.1', room: snap, savedAt: Date.now() });
    const fp = filePath(room.roomId);
    // 原子写入：先写临时文件再 rename
    const tmp = fp + '.tmp';
    await fs.promises.writeFile(tmp, data, 'utf8');
    await fs.promises.rename(tmp, fp);
  } catch (e) {
    logger.error('file-store', '保存房间失败 ' + (room && room.roomId), { error: e.message });
  }
}

/** 读取单个房间文件 */
async function loadRoomFile(roomId) {
  try {
    const raw = await fs.promises.readFile(filePath(roomId), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.room || null;
  } catch (e) {
    if (e.code !== 'ENOENT') logger.error('file-store', '读取房间失败 ' + roomId, { error: e.message });
    return null;
  }
}

/** 列出所有存档文件名（不带扩展名） */
function listRoomIds() {
  try {
    const files = fs.readdirSync(SAVE_DIR);
    return files
      .filter(function (f) { return f.endsWith('.json') && !f.endsWith('.tmp.json'); })
      .map(function (f) { return f.replace(/\.json$/, ''); });
  } catch (e) {
    logger.error('file-store', '列出房间失败', { error: e.message });
    return [];
  }
}

/**
 * 加载所有房间并修复状态。
 * @param coordinator Room.coordinator
 * @param options { onRoom(room) } 每个房间恢复后回调（用于重建 roomCode 映射）
 * @returns { number } 恢复的房间数
 */
function loadAllRooms(coordinator, options) {
  const ids = listRoomIds();
  let count = 0;
  ids.forEach(function (id) {
    // 同步读取（启动阶段）
    let raw;
    try { raw = fs.readFileSync(filePath(id), 'utf8'); } catch (e) { return; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { logger.warn('file-store', '房间存档损坏 ' + id); return; }
    if (!parsed || !parsed.room) return;
    const room = parsed.room;
    repairRoomState(room);
    // 注入 coordinator 的 _rooms
    coordinator._rooms.set(room.roomId, room);
    if (room.storySession && Story_restoreRng) {
      try { Story_restoreRng(room.storySession); } catch (e) {}
    }
    if (options && typeof options.onRoom === 'function') options.onRoom(room);
    count++;
  });
  logger.info('file-store', '恢复房间 ' + count + ' 个');
  return count;
}

// story-core 提供 _activateState 用于恢复 RNG；通过延迟 require 避免循环依赖
let Story_restoreRng = null;
function setStoryRestoreRng(fn) { Story_restoreRng = fn; }

/**
 * 重启状态修复：
 * - resolving → 有 pendingResolution 则 narration_failed，否则 collecting
 * - locked → collecting（重新允许结算）
 * - generating → lobby
 */
function repairRoomState(room) {
  if (!room) return;
  room._pending = null;
  if (room.status === 'resolving') {
    const hasPending = room.storySession &&
      room.storySession.story &&
      room.storySession.story.pendingResolution;
    if (hasPending) {
      room.status = 'narration_failed';
      room.turn.phase = 'narration_failed';
      if (!room.turn.lastError) room.turn.lastError = '天机未应（服务重启后恢复）';
    } else {
      room.status = 'collecting';
      room.turn.phase = 'collecting';
    }
  } else if (room.status === 'locked') {
    // 锁定但未结算：回 collecting，保留已提交行动
    room.status = 'collecting';
    room.turn.phase = 'collecting';
  } else if (room.status === 'generating') {
    room.status = 'lobby';
    room.turn.phase = 'idle';
  } else if (room.status === 'published') {
    room.status = 'collecting';
    room.turn.phase = 'collecting';
  }
}

/** 删除房间存档 */
async function deleteRoom(roomId) {
  try { await fs.promises.unlink(filePath(roomId)); } catch (e) { /* ignore */ }
}

module.exports = {
  init,
  saveRoom,
  loadRoomFile,
  listRoomIds,
  loadAllRooms,
  repairRoomState,
  deleteRoom,
  setStoryRestoreRng,
};
