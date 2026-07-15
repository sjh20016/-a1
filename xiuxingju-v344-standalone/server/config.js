'use strict';

const packageInfo = require('../package.json');

function numberFrom(value, fallback) {
  var parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  version: packageInfo.version || '3.4.4',
  host: process.env.HOST || '0.0.0.0',
  port: numberFrom(process.env.PORT || 8787, 8787),
  publicOrigin: process.env.PUBLIC_ORIGIN || '',
  allowedOrigins: process.env.ALLOWED_ORIGINS || '',
  renderExternalHostname: process.env.RENDER_EXTERNAL_HOSTNAME || '',
  dataDir: process.env.DATA_DIR || './data',
  roomSaveDir: process.env.ROOM_SAVE_DIR || './data/rooms',
  maxSeats: numberFrom(process.env.MAX_SEATS || 4, 4),
  maxRounds: numberFrom(process.env.MAX_ROUNDS || 12, 12),
  roomTtlMinutes: numberFrom(process.env.ROOM_TTL_MINUTES || 180, 180),
  roomIdleMinutes: numberFrom(process.env.ROOM_IDLE_MINUTES || 30, 30),
  roomEndedTtlMinutes: numberFrom(process.env.ROOM_ENDED_TTL_MINUTES || 60, 60),
  betaAccessCode: process.env.BETA_ACCESS_CODE || '',
  createRoomsPerHour: numberFrom(process.env.CREATE_ROOMS_PER_HOUR || 3, 3),
  commandRateLimit: numberFrom(process.env.COMMAND_RATE_LIMIT || 60, 60),
  commandRateWindowMs: numberFrom(process.env.COMMAND_RATE_WINDOW_MS || 60000, 60000),
  aiEnabled: process.env.AI_ENABLED === 'true',
  aiBaseUrl: process.env.AI_BASE_URL || '',
  aiApiKey: process.env.AI_API_KEY || '',
  aiModel: process.env.AI_MODEL || '',
  aiTimeoutMs: numberFrom(process.env.AI_TIMEOUT_MS || 60000, 60000),
  aiTemperature: numberFrom(process.env.AI_TEMPERATURE || 0.6, 0.6),
  aiMaxTokens: numberFrom(process.env.AI_MAX_TOKENS || 4096, 4096),
  aiJsonMode: process.env.AI_JSON_MODE || 'json_object',
  aiSemanticRetry: numberFrom(process.env.AI_SEMANTIC_RETRY || 1, 1),
  aiGlobalConcurrency: numberFrom(process.env.AI_GLOBAL_CONCURRENCY || 3, 3),
  aiRoomConcurrency: numberFrom(process.env.AI_ROOM_CONCURRENCY || 1, 1),
  aiDailyBudget: numberFrom(process.env.AI_DAILY_BUDGET || 200, 200),
  narrationDebug: process.env.NARRATION_DEBUG === 'true',
  serverSecret: process.env.SERVER_SECRET || '',
};
