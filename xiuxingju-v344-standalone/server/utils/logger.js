'use strict';

function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/ig, '$1[REDACTED]')
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,}]+/ig, '$1[REDACTED]')
    .replace(/((?:seat|host|beta|access)[_-]?token\s*[=:]\s*)[^\s,}]+/ig, '$1[REDACTED]');
}

function redactObject(value, seen) {
  if (!value || typeof value !== 'object') return redact(value);
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(function (item) { return redactObject(item, seen); });
  var out = {};
  Object.keys(value).forEach(function (key) {
    if (/^(apiKey|aiApiKey|seatToken|hostToken|token|hiddenFate|accessCode|betaAccessCode)$/i.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redactObject(value[key], seen);
    }
  });
  return out;
}

function createLogger(base) {
  base = base || console;
  function write(method, args) {
    var safe = Array.prototype.map.call(args, function (item) {
      return redactObject(item, new Set());
    });
    (base[method] || base.log).apply(base, safe);
  }
  return {
    info: function () { write('log', arguments); },
    warn: function () { write('warn', arguments); },
    error: function () { write('error', arguments); },
  };
}

module.exports = { createLogger: createLogger, redact: redact };
