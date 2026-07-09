/**
 * server/protocol.js — WebSocket 协议白名单 + 字段校验
 * ============================================================================
 * 客户端只能发送白名单内的命令；每条命令做字段校验。
 * 服务端响应统一格式：
 *   ok:    { requestId, type: 'ok', payload }
 *   error: { requestId, type: 'error', error: { code, message } }
 *   广播:  { type: 'room_view', roomId, seatId, payload: { view } }
 * ============================================================================
 */

const ALLOWED = [
  'ping',
  'create_room',
  'join_room',
  'reconnect',
  'set_ready',
  'assign_actor',
  'start_room_with_arc_voting',
  'submit_arc_vote',
  'finalize_arc_vote',
  'submit_action',
  'cancel_action',
  'retry_narration',
  'get_room_view',
];

const ERROR_CODES = {
  INVALID_JSON: 'INVALID_JSON',
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  MISSING_FIELD: 'MISSING_FIELD',
  INVALID_FIELD: 'INVALID_FIELD',
  UNAUTHORIZED: 'UNAUTHORIZED',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  NOT_HOST: 'NOT_HOST',
  NOT_YOUR_SEAT: 'NOT_YOUR_SEAT',
  INVALID_ACTION: 'INVALID_ACTION',
  INTERNAL: 'INTERNAL',
};

function isStr(v, max) {
  return typeof v === 'string' && v.length > 0 && (!max || v.length <= max);
}

/** 校验单条消息基本结构 + payload 字段。返回 { ok, error } 或 { ok: true } */
function validate(msg) {
  if (!msg || typeof msg !== 'object') return err('INVALID_JSON', '消息不是对象');
  const type = msg.type;
  if (typeof type !== 'string' || ALLOWED.indexOf(type) < 0) {
    return err('UNKNOWN_TYPE', '未知命令类型：' + type);
  }
  // ping 无需校验
  if (type === 'ping') return ok();

  const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : null;

  switch (type) {
    case 'create_room':
      if (!p) return err('MISSING_FIELD', '缺少 payload');
      if (!isStr(p.hostName, 32)) return err('INVALID_FIELD', 'hostName 必须为 1-32 字字符串');
      if (p.mode !== undefined && ['online', 'local-hotseat'].indexOf(p.mode) < 0) {
        return err('INVALID_FIELD', 'mode 非法');
      }
      if (p.seed !== undefined && typeof p.seed !== 'string') return err('INVALID_FIELD', 'seed 非法');
      return ok();

    case 'join_room': {
      if (!p) return err('MISSING_FIELD', '缺少 payload');
      if (!isStr(p.roomCode, 16)) return err('INVALID_FIELD', 'roomCode 非法');
      if (!isStr(p.displayName, 32)) return err('INVALID_FIELD', 'displayName 必须为 1-32 字字符串');
      return ok();
    }

    case 'reconnect': {
      if (!p) return err('MISSING_FIELD', '缺少 payload');
      if (!isStr(p.seatId, 32)) return err('INVALID_FIELD', 'seatId 非法');
      if (!isStr(p.token, 128)) return err('MISSING_FIELD', '缺少 token');
      // roomId 或 roomCode 二选一
      const hasRoomId = isStr(p.roomId, 64);
      const hasRoomCode = isStr(p.roomCode, 16);
      if (!hasRoomId && !hasRoomCode) return err('MISSING_FIELD', '缺少 roomId 或 roomCode');
      return ok();
    }

    case 'set_ready':
    case 'assign_actor':
    case 'start_room_with_arc_voting':
    case 'submit_arc_vote':
    case 'finalize_arc_vote':
    case 'submit_action':
    case 'cancel_action':
    case 'retry_narration':
    case 'get_room_view': {
      // 这些命令需要 roomId / seatId / token（具体在 auth 层校验）
      if (!isStr(msg.roomId, 64)) return err('MISSING_FIELD', '缺少 roomId');
      if (!isStr(msg.seatId, 32)) return err('MISSING_FIELD', '缺少 seatId');
      if (!isStr(msg.token, 128)) return err('MISSING_FIELD', '缺少 token');

      if (type === 'set_ready') {
        if (typeof (p && p.ready) !== 'boolean') return err('INVALID_FIELD', 'ready 必须为布尔');
      }
      if (type === 'assign_actor') {
        const a = p && p.actorSetup;
        if (!a || typeof a !== 'object') return err('MISSING_FIELD', '缺少 actorSetup');
        if (!isStr(a.name, 32)) return err('INVALID_FIELD', 'actorSetup.name 非法');
        if (!isStr(a.identity, 64)) return err('INVALID_FIELD', 'actorSetup.identity 非法');
        if (!isStr(a.daoPath, 32)) return err('INVALID_FIELD', 'actorSetup.daoPath 非法');
        if (!isStr(a.publicWish, 200)) return err('INVALID_FIELD', 'actorSetup.publicWish 非法');
        if (a.hiddenFate !== undefined && !isStr(a.hiddenFate, 500)) return err('INVALID_FIELD', 'actorSetup.hiddenFate 非法');
      }
      if (type === 'submit_arc_vote') {
        if (!isStr(p && p.arcId, 64)) return err('MISSING_FIELD', '缺少 arcId');
      }
      if (type === 'submit_action') {
        const a = p && p.action;
        if (!a || typeof a !== 'object') return err('MISSING_FIELD', '缺少 action');
        const hasChoice = isStr(a.choiceId, 64);
        const hasCustom = a.custom && isStr(a.custom.text, 500);
        if (!hasChoice && !hasCustom) return err('INVALID_ACTION', '需要 choiceId 或 custom.text');
        if (hasChoice && hasCustom) return err('INVALID_ACTION', 'choiceId 与 custom 不能同时提交');
      }
      return ok();
    }

    default:
      return err('UNKNOWN_TYPE', '未实现校验：' + type);
  }
}

function ok() { return { ok: true }; }
function err(code, message) { return { ok: false, error: { code, message } }; }

module.exports = {
  ALLOWED,
  ERROR_CODES,
  validate,
  ok: (requestId, payload) => ({ requestId, type: 'ok', payload: payload || {} }),
  error: (requestId, code, message) => ({ requestId, type: 'error', error: { code, message } }),
};
