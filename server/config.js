'use strict';

function numberFrom(value, fallback) {
  var parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  host: process.env.HOST || '0.0.0.0',
  port: numberFrom(process.env.PORT || 8787, 8787),
  publicOrigin: process.env.PUBLIC_ORIGIN || '',
  dataDir: process.env.DATA_DIR || './data',
  roomSaveDir: process.env.ROOM_SAVE_DIR || './data/rooms',
  aiEnabled: process.env.AI_ENABLED === 'true',
  aiBaseUrl: process.env.AI_BASE_URL || '',
  aiApiKey: process.env.AI_API_KEY || '',
  aiModel: process.env.AI_MODEL || '',
  aiTimeoutMs: numberFrom(process.env.AI_TIMEOUT_MS || 60000, 60000),
  aiTemperature: numberFrom(process.env.AI_TEMPERATURE || 0.6, 0.6),
  aiMaxTokens: numberFrom(process.env.AI_MAX_TOKENS || 2600, 2600),
  aiJsonMode: process.env.AI_JSON_MODE || 'json_object',
  aiSemanticRetry: numberFrom(process.env.AI_SEMANTIC_RETRY || 1, 1),
  narrationDebug: process.env.NARRATION_DEBUG === 'true',
  serverSecret: process.env.SERVER_SECRET || '',
};
