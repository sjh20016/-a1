'use strict';

const fs = require('fs');
const path = require('path');

function cloneForDisk(room) {
  var serialized = JSON.stringify(room, function (key, value) {
    if (key === '_pending') return undefined;
    if (typeof value === 'function' || (value && typeof value.then === 'function')) return undefined;
    if (/^(apiKey|_apiKey|AI_API_KEY)$/i.test(key)) return undefined;
    return value;
  });
  return JSON.parse(serialized);
}

class FileStore {
  constructor(options) {
    options = options || {};
    this.roomSaveDir = path.resolve(options.roomSaveDir || './data/rooms');
    fs.mkdirSync(this.roomSaveDir, { recursive: true });
  }

  fileFor(roomId) {
    if (!/^room_[A-Za-z0-9_-]+$/.test(String(roomId || ''))) throw new Error('非法 roomId');
    return path.join(this.roomSaveDir, roomId + '.json');
  }

  async saveRoom(room) {
    if (!room || !room.roomId) throw new Error('无法保存空房间');
    var file = this.fileFor(room.roomId);
    var tmp = file + '.' + process.pid + '.tmp';
    var payload = JSON.stringify({ saveVersion: room.schemaVersion, snapshotAt: Date.now(), room: cloneForDisk(room) }, null, 2);
    await fs.promises.writeFile(tmp, payload, 'utf8');
    await fs.promises.rename(tmp, file);
    return file;
  }

  async loadRoom(roomId) {
    try {
      var raw = await fs.promises.readFile(this.fileFor(roomId), 'utf8');
      var parsed = JSON.parse(raw);
      return parsed && parsed.room || null;
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async loadAllRooms() {
    var names = await fs.promises.readdir(this.roomSaveDir);
    var rooms = [];
    for (var i = 0; i < names.length; i++) {
      if (!/^room_[A-Za-z0-9_-]+\.json$/.test(names[i])) continue;
      try {
        var raw = await fs.promises.readFile(path.join(this.roomSaveDir, names[i]), 'utf8');
        var parsed = JSON.parse(raw);
        if (parsed && parsed.room) rooms.push(parsed.room);
      } catch (error) {
        // 单个损坏存档不阻止其他房间恢复。
      }
    }
    return rooms;
  }

  async deleteRoom(roomId) {
    try { await fs.promises.unlink(this.fileFor(roomId)); return true; }
    catch (error) { if (error && error.code === 'ENOENT') return false; throw error; }
  }
}

module.exports = { FileStore: FileStore, cloneForDisk: cloneForDisk };
