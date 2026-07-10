'use strict';

const safeJson = require('./utils/safe-json.js');

const COMMANDS = new Set([
  'ping',
  'create_room',
  'join_room',
  'reconnect',
  'assign_actor',
  'set_ready',
  'start_room_with_arc_voting',
  'submit_arc_vote',
  'finalize_arc_vote',
  'submit_action',
  'cancel_action',
  'retry_narration',
  'get_room_view',
]);

const ROOM_COMMANDS = new Set([
  'reconnect', 'assign_actor', 'set_ready', 'start_room_with_arc_voting',
  'submit_arc_vote', 'finalize_arc_vote', 'submit_action', 'cancel_action',
  'retry_narration', 'get_room_view',
]);

const AUTH_COMMANDS = new Set([
  'reconnect', 'assign_actor', 'set_ready', 'start_room_with_arc_voting',
  'submit_arc_vote', 'finalize_arc_vote', 'submit_action', 'cancel_action',
  'retry_narration', 'get_room_view',
]);

class ProtocolError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ProtocolError';
    this.code = code || 'INTERNAL_ERROR';
  }
}

function validateMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new ProtocolError('INVALID_PAYLOAD', '消息必须是对象');
  }
  if (!COMMANDS.has(message.type)) throw new ProtocolError('INVALID_COMMAND', '未知命令');
  if (message.payload !== undefined && (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload))) {
    throw new ProtocolError('INVALID_PAYLOAD', 'payload 必须是对象');
  }
  if (ROOM_COMMANDS.has(message.type) && !message.roomId) throw new ProtocolError('MISSING_ROOM_ID', '缺少 roomId');
  if (AUTH_COMMANDS.has(message.type) && !message.token) throw new ProtocolError('UNAUTHORIZED', '缺少席位凭据');
  if (message.type === 'submit_action') {
    var action = message.payload && message.payload.action;
    var customText = action && action.custom && action.custom.text;
    if (typeof customText === 'string' && customText.length > 500) {
      throw new ProtocolError('INVALID_ACTION', '自定义行动不能超过 500 字');
    }
  }
  return message;
}

function parseMessage(raw) {
  var parsed = safeJson.parse(raw);
  if (!parsed.ok) throw new ProtocolError(parsed.error.code, parsed.error.message);
  return validateMessage(parsed.value);
}

function errorMessage(requestId, error) {
  return {
    requestId: requestId || null,
    type: 'error',
    error: {
      code: error && error.code || 'INTERNAL_ERROR',
      message: error && error.message || '服务器内部错误',
    },
  };
}

module.exports = {
  COMMANDS: COMMANDS,
  ROOM_COMMANDS: ROOM_COMMANDS,
  AUTH_COMMANDS: AUTH_COMMANDS,
  ProtocolError: ProtocolError,
  validateMessage: validateMessage,
  parseMessage: parseMessage,
  errorMessage: errorMessage,
};
