/**
 * server/utils/safe-json.js — 安全 JSON 解析/序列化
 * ============================================================================
 */

/** 安全解析 JSON，失败返回 null */
function parse(str) {
  if (typeof str !== 'string') return null;
  try { return JSON.parse(str); } catch (e) { return null; }
}

/** 安全序列化，循环引用或失败返回 null */
function stringify(obj) {
  try { return JSON.stringify(obj); } catch (e) { return null; }
}

module.exports = { parse, stringify };
