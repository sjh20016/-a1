'use strict';

const { ProtocolError } = require('./protocol.js');

class SlidingWindowLimiter {
  constructor(options) {
    options = options || {};
    this.now = options.now || function () { return Date.now(); };
    this.entries = new Map();
  }

  consume(key, limit, windowMs) {
    key = String(key || 'anonymous');
    limit = Math.max(1, Number(limit) || 1);
    windowMs = Math.max(1, Number(windowMs) || 60000);
    var now = this.now();
    var cutoff = now - windowMs;
    var timestamps = (this.entries.get(key) || []).filter(function (value) { return value > cutoff; });
    if (timestamps.length >= limit) {
      var retryAfterMs = Math.max(1, timestamps[0] + windowMs - now);
      this.entries.set(key, timestamps);
      throw new ProtocolError('RATE_LIMITED', '操作过于频繁，请稍后再试', { retryAfterMs: retryAfterMs });
    }
    timestamps.push(now);
    this.entries.set(key, timestamps);
    return { remaining: Math.max(0, limit - timestamps.length), retryAfterMs: 0 };
  }

  prune() {
    var now = this.now();
    this.entries.forEach(function (timestamps, key) {
      if (!timestamps.length || timestamps[timestamps.length - 1] < now - 3600000) this.entries.delete(key);
    }, this);
  }

  size() { return this.entries.size; }
}

module.exports = { SlidingWindowLimiter: SlidingWindowLimiter };
