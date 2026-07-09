/**
 * server/utils/logger.js — 极简日志（脱敏：不打印 API Key）
 * ============================================================================
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL || 'info')] || LEVELS.info;

function ts() { return new Date().toISOString(); }

function scrub(obj) {
  try {
    const s = JSON.stringify(obj);
    if (s && s.length > 2000) return s.slice(0, 2000) + '…(truncated)';
    return s;
  } catch (e) { return '[unserializable]'; }
}

function log(level, tag, msg, extra) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const line = `[${ts()}] ${level.toUpperCase()} [${tag}] ${msg}` +
    (extra !== undefined ? ' ' + scrub(extra) : '');
  if (level === 'error') console.error(line);
  else console.log(line);
}

module.exports = {
  debug: (tag, msg, extra) => log('debug', tag, msg, extra),
  info: (tag, msg, extra) => log('info', tag, msg, extra),
  warn: (tag, msg, extra) => log('warn', tag, msg, extra),
  error: (tag, msg, extra) => log('error', tag, msg, extra),
};
