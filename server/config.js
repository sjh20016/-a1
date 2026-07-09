/**
 * server/config.js — 服务端配置（环境变量）
 * ============================================================================
 * 规则：AI_API_KEY 只能存在服务端环境变量里，不写入 RoomState、不发送给浏览器、
 * 不写入存档、不写入错误日志。
 * ============================================================================
 */
const path = require('path');

function bool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const config = {
  PORT: int(process.env.PORT, 8787),
  HOST: process.env.HOST || '0.0.0.0',
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN || '',

  DATA_DIR: process.env.DATA_DIR || path.resolve(process.cwd(), 'data'),
  ROOM_SAVE_DIR: process.env.ROOM_SAVE_DIR || path.resolve(process.cwd(), 'data', 'rooms'),

  AI_ENABLED: bool(process.env.AI_ENABLED, true),
  AI_BASE_URL: (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  AI_API_KEY: process.env.AI_API_KEY || '',
  AI_MODEL: process.env.AI_MODEL || 'gpt-4o-mini',
  AI_TIMEOUT_MS: int(process.env.AI_TIMEOUT_MS, 60000),
  AI_TEMPERATURE: parseFloat(process.env.AI_TEMPERATURE || '0.8'),

  SERVER_SECRET: process.env.SERVER_SECRET || '',

  // 运行时可覆盖（测试用）：注入 Mock AI provider
  _testProvider: null,

  get hasApiKey() { return !!this.AI_API_KEY; },
};

module.exports = config;
