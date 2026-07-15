'use strict';

const crypto = require('crypto');
const { ProtocolError } = require('./protocol.js');

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function ensureAuth(room) {
  if (!room.serverAuth) room.serverAuth = { hostTokenHash: '', seatTokenHashes: {} };
  if (!room.serverAuth.seatTokenHashes) room.serverAuth.seatTokenHashes = {};
  return room.serverAuth;
}

function safeEqualHash(expected, actual) {
  if (!expected || !actual || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function issueSeatToken(room, seatId) {
  var token = newToken();
  ensureAuth(room).seatTokenHashes[seatId] = hashToken(token);
  return token;
}

function issueHostToken(room) {
  var token = newToken();
  ensureAuth(room).hostTokenHash = hashToken(token);
  return token;
}

function assertSeat(room, seatId, token) {
  if (!room || !seatId || !token) throw new ProtocolError('UNAUTHORIZED', '席位凭据缺失');
  var seat = (room.seats || []).find(function (item) { return item.seatId === seatId; });
  var expected = ensureAuth(room).seatTokenHashes[seatId];
  if (!seat || !safeEqualHash(expected, hashToken(token))) throw new ProtocolError('UNAUTHORIZED', '席位凭据无效');
  return seat;
}

function assertHost(room, seatId, token, hostToken) {
  var seat = assertSeat(room, seatId, token);
  var expected = ensureAuth(room).hostTokenHash;
  if (room.hostSeatId !== seatId || !safeEqualHash(expected, hashToken(hostToken))) {
    throw new ProtocolError('FORBIDDEN', '仅房主可以执行此命令');
  }
  return seat;
}

module.exports = {
  hashToken: hashToken,
  issueSeatToken: issueSeatToken,
  issueHostToken: issueHostToken,
  assertSeat: assertSeat,
  assertHost: assertHost,
};
