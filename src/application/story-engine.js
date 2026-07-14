'use strict';

/**
 * 每个房间独占的 Story 运行时。
 *
 * 领域实现仍由 story-core.js 提供；本类把会话状态、RNG 绑定、Provider
 * 上下文和同房间串行队列收进实例，作为逐步移除全局 Story facade 的边界。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
    module.exports = factory(require('../../story-core.js'));
  } else {
    root.StoryEngine = factory(root.Story);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Story) {
  if (!Story) throw new Error('story-core.js must be loaded before StoryEngine');

  function SerialQueue() {
    this.tail = Promise.resolve();
  }

  SerialQueue.prototype.run = function (task) {
    var next = this.tail.then(task, task);
    this.tail = next.catch(function () {});
    return next;
  };

  function captureProviderContext() {
    var ai = Story.ai || {};
    return {
      inheritGlobal: true,
      enabled: !!ai.enabled,
      provider: ai.provider || null,
      timeoutMs: ai.timeoutMs || 30000,
      providerMeta: Object.assign({}, ai.providerMeta || {}),
    };
  }

  function StoryEngine(options) {
    options = options || {};
    this.id = options.id || ('engine_' + Math.random().toString(36).slice(2, 10));
    this.state = null;
    this.providerContext = options.providerContext || captureProviderContext();
    this.queue = new SerialQueue();
    if (options.state) this.attach(options.state);
  }

  StoryEngine.create = function (options) {
    return new StoryEngine(options);
  };

  StoryEngine.prototype.attach = function (state) {
    this.state = state || null;
    if (this.state) {
      Story._activateState(this.state);
      if (typeof Story.bindProviderContext === 'function') {
        Story.bindProviderContext(this.state, this.providerContext);
      }
    }
    return this.state;
  };

  StoryEngine.prototype.run = function (task) {
    var self = this;
    return this.queue.run(function () {
      if (self.state) Story._activateState(self.state);
      return task(self.state, Story);
    });
  };

  StoryEngine.prototype.createSession = function (config) {
    var self = this;
    return this.run(async function () {
      var sessionConfig = Object.assign({}, config || {}, { providerContext: self.providerContext });
      var state = await Story.createSession(sessionConfig);
      self.attach(state);
      return state;
    });
  };

  StoryEngine.prototype.finalizeSessionWithArc = function (arcId) {
    var self = this;
    return this.run(function () {
      if (!self.state) throw new Error('StoryEngine 尚未绑定会话');
      return Story.Director.finalizeSessionWithArc(self.state, arcId);
    });
  };

  StoryEngine.prototype.resolveTurn = function (actionsByActorId, options) {
    var self = this;
    return this.run(function () {
      if (!self.state) throw new Error('StoryEngine 尚未绑定会话');
      return Story.resolveTurn(self.state, actionsByActorId, options || {});
    });
  };

  StoryEngine.prototype.retryNarration = function (options) {
    var self = this;
    return this.run(function () {
      if (!self.state) throw new Error('StoryEngine 尚未绑定会话');
      return Story.retryNarration(self.state, options || {});
    });
  };

  StoryEngine.SerialQueue = SerialQueue;
  return StoryEngine;
});
