'use strict';

const fs = require('fs');
const path = require('path');

function safeSegment(value, fallback) {
  var safe = String(value || fallback || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  return safe.slice(0, 100) || fallback || 'unknown';
}

function sanitize(value, seen) {
  if (value == null || typeof value !== 'object') return value;
  seen = seen || new WeakSet();
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(function (item) { return sanitize(item, seen); });
  var output = {};
  Object.keys(value).forEach(function (key) {
    if (/(api.?key|authorization|hosttoken|seattoken|hiddenfate|privatefate|privatefacts|privateeffects|privateevents)/i.test(key)) {
      output[key] = '[redacted]';
      return;
    }
    output[key] = sanitize(value[key], seen);
  });
  return output;
}

function createNarrationDebugSink(options) {
  options = options || {};
  var root = path.resolve(options.dataDir || './data', 'debug');
  return async function writeNarrationDebug(event) {
    if (!event) return;
    var directory = path.join(root, safeSegment(event.roomId, 'local'), safeSegment(event.turnId, 'turn_unknown'));
    await fs.promises.mkdir(directory, { recursive: true });
    var file;
    var payload;
    if (event.stage === 'context') {
      await fs.promises.writeFile(path.join(directory, 'contract.json'), JSON.stringify(sanitize(event.contract), null, 2), 'utf8');
      file = 'ai-context.json'; payload = JSON.stringify(sanitize(event.context), null, 2);
    } else if (event.stage === 'raw') {
      file = 'raw-response-' + (event.attempt || 1) + '.txt';
      payload = typeof event.raw === 'string' ? event.raw : JSON.stringify(sanitize(event.raw), null, 2);
    } else if (event.stage === 'validation') {
      file = 'validation-' + (event.attempt || 1) + '.json'; payload = JSON.stringify(sanitize({ valid: !!event.valid, errors: event.errors || [] }), null, 2);
    } else if (event.stage === 'correction') {
      file = 'correction.json'; payload = JSON.stringify(sanitize(event.correction), null, 2);
    } else return;
    await fs.promises.writeFile(path.join(directory, file), payload, 'utf8');
  };
}

module.exports = { createNarrationDebugSink: createNarrationDebugSink, sanitize: sanitize };
