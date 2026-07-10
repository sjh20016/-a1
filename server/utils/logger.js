'use strict';

function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/ig, '$1[REDACTED]')
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,}]+/ig, '$1[REDACTED]');
}

function createLogger(base) {
  base = base || console;
  function write(method, args) {
    var safe = Array.prototype.map.call(args, function (item) {
      return typeof item === 'string' ? redact(item) : item;
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
