/**
 * server/auth.js — 房间权限与 Token
 * ============================================================================
 * 创建房间时生成 hostToken + 每个 seat 的 seatToken。
 * Token 至少 24 字节随机。
 *
 * 权限：
 *   hostToken：finalize_arc_vote / retry_narration（房主操作）
 *   seatToken：只能操作自己的 seat（提交/撤回行动、投票、查看私密视图）
 *
 * MVP：明文 token 存于 room.serverAuth（存档建议 hash，此处提供 hash 工具但默认明文比对）。
 * ============================================================================
 */
const crypto = require('crypto');

const TOKEN_BYTES = 24;

/** 生成随机 token（hex） */
function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/** 生成 6 位房间码（数字，避免重复由调用方校验） */
function generateRoomCode() {
  // 6 位数字，首位非 0
  const n = Math.floor(100000 + Math.random() * 900000);
  return String(n);
}

/** sha256 hash（用于存档存储；MVP 可选用） */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** 为新房间创建 serverAuth 结构（含 hostSeatId、hostToken、seatTokenHashes） */
function createServerAuth(room) {
  const seatTokens = {};
  room.seats.forEach(function (seat) {
    seatTokens[seat.seatId] = generateToken();
  });
  const hostToken = generateToken();
  return {
    hostSeatId: room.hostSeatId,
    hostToken: hostToken,
    seatTokens: seatTokens, // seatId -> token
  };
}

/**
 * 校验请求 token。
 * @returns { ok, isHost, seatId }
 *   - seatToken 匹配 → ok:true, isHost 取决于是否房主席位
 *   - hostToken 匹配 → ok:true, isHost:true，seatId 取 hostSeatId
 */
function verify(room, seatId, token) {
  if (!room || !room.serverAuth || !token) return { ok: false };
  const auth = room.serverAuth;
  // 优先校验 seatToken
  if (seatId && auth.seatTokens[seatId] && auth.seatTokens[seatId] === token) {
    return { ok: true, isHost: seatId === auth.hostSeatId, seatId: seatId };
  }
  // hostToken：用于房主专属命令（seatId 应为 hostSeatId）
  if (auth.hostToken === token) {
    const hostSeatId = auth.hostSeatId;
    // 若调用方传入的 seatId 与房主不一致，拒绝（防止 hostToken 被用于冒充其他 seat）
    if (seatId && seatId !== hostSeatId) return { ok: false };
    return { ok: true, isHost: true, seatId: hostSeatId };
  }
  return { ok: false };
}

/** 校验房主身份 */
function verifyHost(room, seatId, token) {
  const v = verify(room, seatId, token);
  return v.ok && v.isHost;
}

module.exports = {
  generateToken,
  generateRoomCode,
  hashToken,
  createServerAuth,
  verify,
  verifyHost,
};
