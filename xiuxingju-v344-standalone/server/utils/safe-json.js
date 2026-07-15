'use strict';

function parse(raw, maxBytes) {
  var limit = maxBytes || 64 * 1024;
  var text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw == null ? '' : raw);
  if (Buffer.byteLength(text, 'utf8') > limit) {
    return { ok: false, error: { code: 'MESSAGE_TOO_LARGE', message: '消息超过大小限制' } };
  }
  try {
    var value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: { code: 'INVALID_PAYLOAD', message: '消息必须是 JSON 对象' } };
    }
    return { ok: true, value: value };
  } catch (error) {
    return { ok: false, error: { code: 'BAD_JSON', message: '无法解析 JSON' } };
  }
}

function stringify(value) {
  return JSON.stringify(value);
}

module.exports = { parse: parse, stringify: stringify };
