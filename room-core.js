/**
 * ============================================================================
 * 《修行局》V3.4.2 — 房间协调器 + 权威联机视图（room-core.js）
 * ============================================================================
 * 职责：管理房间、席位、角色绑定、回合收集、机器人自动落子、统一结算。
 *   Story 只负责叙事，Room 负责秩序与隐私。
 *
 * 四层关系：
 *   Room（房间）→ Seat（席位）→ Actor（角色）→ Controller（控制器）
 *
 * 本阶段（Sprint 2）实现：
 *   - RoomState / RoomSeat 数据结构
 *   - LocalRoomCoordinator（创建/加入/准备/开局/卷纲投票/提交/机器人/结算）
 *   - RoomView.getForSeat（按席位过滤隐私视图）
 *   - 本地存档与恢复
 *
 * V3.4.2 由 server/room-runtime.js 在服务端串行调用协调器，浏览器仅持有 RoomView。
 * ============================================================================
 */
const Room = {};

(function () {
  /** 解析 Story 依赖：Node 用 require，浏览器用 window.Story
   *  注意：不能用 typeof Story 判断，因为 var Story 提升后 typeof Story === 'undefined' */
  var Story = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
    ? require('./story-core.js')
    : (typeof globalThis !== 'undefined' ? globalThis.Story : null);
  if (!Story) throw new Error('story-core.js must be loaded before room-core.js');

  Room.VERSION = '3.4.2';
  Room.MAX_SEATS = 4;

  /** 机器人策略模板（影响描述与未来权重，当前决策由 Story.aiChoose 执行） */
  Room.BOT_PROFILES = {
    pursuer:      { id: 'pursuer',      label: '逐愿者', desc: '偏好推进个人目标，险中求胜。' },
    profitSeeker: { id: 'profitSeeker', label: '逐利者', desc: '偏好资源与交易，规避无谓风险。' },
    guardian:     { id: 'guardian',     label: '守护者', desc: '偏好同行援护与稳固关系。' },
    wanderer:     { id: 'wanderer',     label: '游荡者', desc: '偏好探索与游历，随性而行。' },
  };

  /** 预设机器人角色（复用 Story.PRESET_COMPANIONS） */
  Room.PRESET_BOT_ACTORS = Story ? Story.PRESET_COMPANIONS.slice() : [];

  /* ============================================================
   * §1 RoomState / RoomSeat 工厂
   * ============================================================ */

  Room.createRoomState = function (config) {
    config = config || {};
    var now = Date.now();
    return {
      schemaVersion: Room.VERSION,
      roomId: config.roomId || ('room_' + Math.random().toString(36).slice(2, 10)),
      roomCode: config.roomCode || '',
      mode: config.mode || 'local-solo',       // local-solo | local-hotseat | online
      status: 'lobby',                          // lobby | generating | collecting | locked | resolving | published | ended
      createdAt: now,
      updatedAt: now,
      hostSeatId: '',
      maxSeats: config.maxSeats || Room.MAX_SEATS,
      settings: {
        seed: config.seed || '',
        narrativePace: config.narrativePace || '常规',
        narrativeProfile: config.narrativeProfile || 'immersive',
        allowCustomActions: config.allowCustomActions !== false,
        allowSpectators: !!config.allowSpectators,
        aiNarrationMode: config.aiNarrationMode || 'host-byok',  // host-byok | offline
        pvpMode: config.pvpMode || 'dramatic',                  // off | dramatic | full
      },
      seats: [],
      storySession: null,                       // StoryState（开局后填充）
      turn: {
        turnId: '',
        round: 0,
        phase: 'idle',                          // idle | collecting | locked | resolving | published
        openedAt: 0,
        lockedAt: 0,
        submittedActorIds: [],
        actionsByActorId: {},
        botStatusByActorId: {},
        resolutionId: null,
        lastError: null,
      },
      // V3.3.2 Director 投票
      directorVote: {
        phase: 'idle',                          // idle | voting | finalized
        candidates: [],
        votesBySeatId: {},
        botVotesBySeatId: {},
        openedAt: 0,
        finalizedAt: 0,
        selectedArcId: null,
      },
      eventLog: [],
      _pending: null,                           // 进行中的结算 Promise（不入存档）
    };
  };

  Room.createSeat = function (config) {
    config = config || {};
    var seatId = config.seatId || ('seat_' + Math.random().toString(36).slice(2, 8));
    return {
      seatId: seatId,
      index: config.index || 0,
      kind: config.kind || 'empty',             // empty | human | bot | spectator
      displayName: config.displayName || '',
      avatarSeed: config.avatarSeed || seatId,
      actorId: null,                            // 开局后由 Story 分配
      actorSetup: null,                         // 立命信息（开局前存储）
      participantId: config.participantId || null,
      controller: {
        kind: config.controllerKind || 'none',  // none | local-human | local-hotseat | bot-weighted | bot-llm | remote-human
        controllerId: config.controllerId || null,
        botProfileId: config.botProfileId || null,
      },
      ready: false,
      connectionStatus: 'local',
      joinedAt: Date.now(),
    };
  };

  /* ============================================================
   * §2 LocalRoomCoordinator
   * ============================================================ */

  var _rooms = new Map();

  Room.SerialQueue = function () { this.tail = Promise.resolve(); };
  Room.SerialQueue.prototype.run = function (fn) {
    var next = this.tail.then(fn, fn);
    this.tail = next.catch(function () {});
    return next;
  };
  // Story 仍有全局 state/RNG/Provider，因此所有房间共用一条执行队列。
  Room.storyExecutionQueue = new Room.SerialQueue();
  Room.runStoryTask = function (fn) {
    // 全局串行是服务端多房间保护；浏览器本地单房直接执行，避免跨 realm Promise 队列阻塞 UI 事件循环。
    var isNodeRuntime = typeof module !== 'undefined' && module.exports;
    return isNodeRuntime ? Room.storyExecutionQueue.run(fn) : fn();
  };

  Room.coordinator = {
    _rooms: _rooms,

    /** 创建房间，初始化 maxSeats 个空席位，房主占第一席 */
    createRoom: function (config) {
      var room = Room.createRoomState(config);
      for (var i = 0; i < room.maxSeats; i++) {
        room.seats.push(Room.createSeat({ seatId: 'seat_' + i, index: i, kind: 'empty' }));
      }
      if (config.hostName) {
        var hostSeat = room.seats[0];
        hostSeat.kind = 'human';
        hostSeat.displayName = config.hostName;
        hostSeat.controller.kind = 'local-human';
        hostSeat.controller.controllerId = 'host';
        room.hostSeatId = hostSeat.seatId;
      } else {
        room.hostSeatId = 'seat_0';
      }
      _rooms.set(room.roomId, room);
      _logEvent(room, { type: 'ROOM_CREATED', visibility: 'public', payload: { roomId: room.roomId, mode: room.mode } });
      return room;
    },

    getRoom: function (roomId) { return _rooms.get(roomId) || null; },

    /** 真人加入指定席位 */
    addHumanSeat: function (roomId, seatIndex, participant) {
      var room = _requireRoom(roomId);
      if (room.status !== 'lobby') throw new Error('房间已开始，无法加入');
      var seat = _requireSeat(room, seatIndex);
      if (seat.kind !== 'empty') throw new Error('该席位已被占用');
      seat.kind = 'human';
      seat.displayName = (participant && participant.displayName) || ('真人' + (seatIndex + 1));
      seat.participantId = (participant && participant.participantId) || ('p_' + Date.now());
      seat.controller.kind = room.mode === 'local-hotseat' ? 'local-hotseat' : 'local-human';
      seat.controller.controllerId = seat.participantId;
      _logEvent(room, { type: 'SEAT_JOINED', visibility: 'public', payload: { seatId: seat.seatId, displayName: seat.displayName } });
      return seat;
    },

    /** 添加机器人到指定席位 */
    addBotSeat: function (roomId, seatIndex, botConfig) {
      var room = _requireRoom(roomId);
      if (room.status !== 'lobby') throw new Error('房间已开始，无法加入');
      var seat = _requireSeat(room, seatIndex);
      if (seat.kind !== 'empty') throw new Error('该席位已被占用');
      botConfig = botConfig || {};
      var profileId = botConfig.profileId || 'pursuer';
      if (!Room.BOT_PROFILES[profileId]) throw new Error('未知机器人策略：' + profileId);
      seat.kind = 'bot';
      seat.displayName = botConfig.displayName || Room.BOT_PROFILES[profileId].label;
      seat.controller.kind = 'bot-weighted';
      seat.controller.botProfileId = profileId;
      seat.ready = true;  // 机器人无需准备，添加即就绪
      // 绑定角色模板：优先用调用方指定的，否则按 presetIndex 取预设
      if (botConfig.actorTemplate) {
        seat.actorSetup = botConfig.actorTemplate;
      } else if (botConfig.presetIndex != null && Room.PRESET_BOT_ACTORS[botConfig.presetIndex]) {
        seat.actorSetup = Object.assign({}, Room.PRESET_BOT_ACTORS[botConfig.presetIndex]);
      } else {
        // 无指定时取第一个未占用的预设
        var used = room.seats.filter(function (s) { return s.actorSetup; }).map(function (s) { return s.actorSetup.id; });
        var tpl = Room.PRESET_BOT_ACTORS.find(function (t) { return used.indexOf(t.id) < 0; });
        if (tpl) seat.actorSetup = Object.assign({}, tpl);
      }
      _logEvent(room, { type: 'BOT_ADDED', visibility: 'public', payload: { seatId: seat.seatId, displayName: seat.displayName, profileId: seat.controller.botProfileId } });
      return seat;
    },

    /** 移除席位（不能移除房主） */
    removeSeat: function (roomId, seatId) {
      var room = _requireRoom(roomId);
      if (room.status !== 'lobby') throw new Error('房间已开始，无法移除');
      var seat = room.seats.find(function (s) { return s.seatId === seatId; });
      if (!seat) throw new Error('席位不存在');
      if (seat.seatId === room.hostSeatId) throw new Error('不能移除房主席位');
      seat.kind = 'empty';
      seat.displayName = '';
      seat.actorId = null;
      seat.actorSetup = null;
      seat.participantId = null;
      seat.ready = false;
      seat.controller = { kind: 'none', controllerId: null, botProfileId: null };
      _logEvent(room, { type: 'SEAT_LEFT', visibility: 'public', payload: { seatId: seatId } });
      return seat;
    },

    setSeatReady: function (roomId, seatId, ready) {
      var room = _requireRoom(roomId);
      var seat = room.seats.find(function (s) { return s.seatId === seatId; });
      if (!seat) throw new Error('席位不存在');
      if (seat.kind === 'empty') throw new Error('空席位无法准备');
      seat.ready = !!ready;
      return seat;
    },

    /** 绑定立命信息到席位（开局前） */
    assignActorToSeat: function (roomId, seatId, actorSetup) {
      var room = _requireRoom(roomId);
      if (room.status !== 'lobby') throw new Error('房间已开始，无法绑定角色');
      var seat = room.seats.find(function (s) { return s.seatId === seatId; });
      if (!seat) throw new Error('席位不存在');
      if (seat.kind === 'empty') throw new Error('空席位无法绑定角色');
      seat.actorSetup = actorSetup;
      return seat;
    },

    /** 开局：校验 → 创建故事会话 → 开启第一回合 → 机器人自动落子 */
    startRoom: async function (roomId) {
      var room = _requireRoom(roomId);
      if (room.status !== 'lobby') throw new Error('房间已开始');
      var occupied = room.seats.filter(function (s) { return s.kind === 'human' || s.kind === 'bot'; });
      if (occupied.length < 2) throw new Error('至少需要 2 个非空席位');
      if (!occupied.some(function (s) { return s.kind === 'human'; })) throw new Error('至少需要 1 名真人');
      var notReady = occupied.filter(function (s) { return !s.ready; });
      if (notReady.length) throw new Error('尚有席位未准备：' + notReady.map(function (s) { return s.displayName; }).join('、'));
      var noActor = occupied.filter(function (s) { return !s.actorSetup; });
      if (noActor.length) throw new Error('尚有席位未绑定角色：' + noActor.map(function (s) { return s.displayName; }).join('、'));

      room.status = 'generating';
      try {
        var actors = occupied.map(function (s) {
          return Object.assign({}, s.actorSetup, {
            seatId: s.seatId,
            controller: s.kind === 'human' ? 'human' : 'bot',
            roomDisplayName: s.displayName,
          });
        });
        var storyState = await Room.runStoryTask(function () { return Story.createSession({
          seed: room.settings.seed || undefined,
          actors: actors,
          narrativePace: room.settings.narrativePace,
          narrativeProfile: room.settings.narrativeProfile,
          pvpMode: room.settings.pvpMode,
        }); });
        room.storySession = storyState;
        storyState.roomId = room.roomId;
        // 绑定 actorId 到 seat
        occupied.forEach(function (s) {
          var actor = storyState.actors.find(function (a) { return a.seatId === s.seatId; });
          if (actor) s.actorId = actor.id;
        });
        // V3.3.1：开局可能因 AI 失败停在 narration_failed（V3.3 为 awaiting_narration）
        var openPhase = Story.getTurnPhase(storyState);
        if (openPhase === 'awaiting_narration' || openPhase === 'narration_failed') {
          room.status = 'narration_failed';
          room.turn.phase = 'narration_failed';
          var pr0 = Story.getPendingResolution(storyState);
          var err0 = pr0 && pr0.lastNarrationError ? pr0.lastNarrationError : null;
          room.turn.lastError = err0 ? ('天机未应：' + (err0.code || 'UNKNOWN') + ' — ' + (err0.message || '')) : '天机未应';
          _logEvent(room, { type: 'NARRATION_AWAITING_RETRY', visibility: 'host', payload: { round: 0, error: room.turn.lastError } });
        } else {
          _openTurn(room);
          room.status = 'collecting';
        }
        _logEvent(room, { type: 'ROOM_STARTED', visibility: 'public', payload: { seed: room.settings.seed } });
        return room;
      } catch (e) {
        // Generation/provider failures must not strand the lobby in a state
        // that can never be started again.
        room.status = 'lobby';
        room.storySession = null;
        occupied.forEach(function (s) { s.actorId = null; });
        _logEvent(room, { type: 'ROOM_START_FAILED', visibility: 'host', payload: { error: e.message } });
        throw e;
      }
    },

    /** V3.3.2：带卷纲投票的开局流程。
     *  世界与角色生成 → 生成命途签候选 → 进入 arc_voting → 投票后激活卷纲 → 开局叙事 */
    startRoomWithArcVoting: async function (roomId) {
      var room = _requireRoom(roomId);
      if (room.status !== 'lobby') throw new Error('房间已开始');
      var occupied = room.seats.filter(function (s) { return s.kind === 'human' || s.kind === 'bot'; });
      if (occupied.length < 2) throw new Error('至少需要 2 个非空席位');
      if (!occupied.some(function (s) { return s.kind === 'human'; })) throw new Error('至少需要 1 名真人');
      var notReady = occupied.filter(function (s) { return !s.ready; });
      if (notReady.length) throw new Error('尚有席位未准备：' + notReady.map(function (s) { return s.displayName; }).join('、'));
      var noActor = occupied.filter(function (s) { return !s.actorSetup; });
      if (noActor.length) throw new Error('尚有席位未绑定角色：' + noActor.map(function (s) { return s.displayName; }).join('、'));

      room.status = 'generating';
      try {
        var actors = occupied.map(function (s) {
          return Object.assign({}, s.actorSetup, {
            seatId: s.seatId,
            controller: s.kind === 'human' ? 'human' : 'bot',
            roomDisplayName: s.displayName,
          });
        });
        // 跳过开局生成，等待投票后激活
        var storyState = await Room.runStoryTask(function () { return Story.createSession({
          seed: room.settings.seed || undefined,
          actors: actors,
          narrativePace: room.settings.narrativePace,
          narrativeProfile: room.settings.narrativeProfile,
          pvpMode: room.settings.pvpMode,
          skipOpening: true,
        }); });
        room.storySession = storyState;
        storyState.roomId = room.roomId;
        occupied.forEach(function (s) {
          var actor = storyState.actors.find(function (a) { return a.seatId === s.seatId; });
          if (actor) s.actorId = actor.id;
        });
        // 生成命途签候选
        var candidates = Story.Director.generateCandidates(storyState);
        var d = storyState.story.director;
        d.candidates = candidates;
        d.phase = 'voting';
        // 填充 directorVote
        room.directorVote.phase = 'voting';
        room.directorVote.candidates = candidates;
        room.directorVote.openedAt = Date.now();
        room.status = 'arc_voting';
        // Bot 自动投票
        var botSeats = occupied.filter(function (s) { return s.kind === 'bot'; });
        botSeats.forEach(function (s) {
          var vote = Story.DirectorVote.autoVoteForBot(storyState, s.actorId);
          if (vote) {
            Story.DirectorVote.submitVote(storyState, s.actorId, vote);
            room.directorVote.botVotesBySeatId[s.seatId] = vote;
            room.directorVote.votesBySeatId[s.seatId] = vote;
          }
        });
        _logEvent(room, { type: 'ARC_VOTING_STARTED', visibility: 'public', payload: { candidateCount: candidates.length } });
        return room;
      } catch (e) {
        room.status = 'lobby';
        room.storySession = null;
        occupied.forEach(function (s) { s.actorId = null; });
        _logEvent(room, { type: 'ROOM_START_FAILED', visibility: 'host', payload: { error: e.message } });
        throw e;
      }
    },

    /** 提交卷纲投票（真人） */
    submitArcVote: function (roomId, seatId, arcId) {
      var room = _requireRoom(roomId);
      if (room.status !== 'arc_voting') throw new Error('当前不在投票阶段');
      var seat = room.seats.find(function (s) { return s.seatId === seatId; });
      if (!seat || seat.kind !== 'human') throw new Error('只有真人席位可投票');
      if (!seat.actorId) throw new Error('该席位未绑定角色');
      var state = room.storySession;
      if (!state) throw new Error('故事会话未创建');
      Story.DirectorVote.submitVote(state, seat.actorId, arcId);
      room.directorVote.votesBySeatId[seatId] = arcId;
      _logEvent(room, { type: 'ARC_VOTE_SUBMITTED', visibility: 'host', payload: { seatId: seatId, arcId: arcId } });
      return room;
    },

    /** 结算投票并激活卷纲 */
    finalizeArcVote: async function (roomId, masterSeatId) {
      var room = _requireRoom(roomId);
      if (room.status !== 'arc_voting') throw new Error('当前不在投票阶段');
      var state = room.storySession;
      if (!state) throw new Error('故事会话未创建');
      var d = state.story.director;
      // 检查是否所有真人席位都已投票
      var humanSeats = room.seats.filter(function (s) { return s.kind === 'human'; });
      var allVoted = humanSeats.every(function (s) {
        return room.directorVote.votesBySeatId[s.seatId] !== undefined;
      });
      if (!allVoted) throw new Error('尚有真人席位未投票');
      // 房主可在平票时指定
      var winner = Story.DirectorVote.finalizeVote(state);
      room.directorVote.phase = 'finalized';
      room.directorVote.finalizedAt = Date.now();
      room.directorVote.selectedArcId = winner;
      // 激活卷纲 → 生成开局场景与叙事
      await Room.runStoryTask(function () { return Story.Director.finalizeSessionWithArc(state, winner); });
      // 正常开局流程
      room.status = 'generating';
      var openPhase = Story.getTurnPhase(state);
      if (openPhase === 'awaiting_narration' || openPhase === 'narration_failed') {
        room.status = 'narration_failed';
        room.turn.phase = 'narration_failed';
        var pr0 = Story.getPendingResolution(state);
        var err0 = pr0 && pr0.lastNarrationError ? pr0.lastNarrationError : null;
        room.turn.lastError = err0 ? ('天机未应：' + (err0.code || 'UNKNOWN') + ' — ' + (err0.message || '')) : '天机未应';
      } else {
        _openTurn(room);
        room.status = 'collecting';
      }
      _logEvent(room, { type: 'ARC_VOTE_FINALIZED', visibility: 'public', payload: { selectedArcId: winner } });
      var activatedPayload = _directorEventPayload(room);
      if (activatedPayload) {
        _logEvent(room, { type: 'DIRECTOR_ARC_ACTIVATED', visibility: 'public', payload: activatedPayload });
      }
      return room;
    },
    submitAction: function (roomId, seatId, action) {
      var room = _requireRoom(roomId);
      if (room.status !== 'collecting') throw new Error('当前不在收集阶段');
      var seat = room.seats.find(function (s) { return s.seatId === seatId; });
      if (!seat) throw new Error('席位不存在');
      if (seat.kind !== 'human') throw new Error('只有真人席位可手动提交');
      if (!seat.actorId) throw new Error('该席位未绑定角色');
      if (room.turn.submittedActorIds.indexOf(seat.actorId) >= 0) throw new Error('已提交，请先撤回');
      var normalizedAction = _normalizeAction(room, seat, action);
      room.turn.actionsByActorId[seat.actorId] = normalizedAction;
      room.turn.submittedActorIds.push(seat.actorId);
      _logEvent(room, { type: 'ACTION_SUBMITTED', visibility: 'public', payload: { seatId: seatId, actorId: seat.actorId } });
      _resolveIfReady(room);
      return room;
    },

    /** 撤回行动（锁定前可撤回） */
    cancelAction: function (roomId, seatId) {
      var room = _requireRoom(roomId);
      if (room.status !== 'collecting') throw new Error('当前不在收集阶段');
      var seat = room.seats.find(function (s) { return s.seatId === seatId; });
      if (!seat || !seat.actorId) return;
      var idx = room.turn.submittedActorIds.indexOf(seat.actorId);
      if (idx < 0) return;
      room.turn.submittedActorIds.splice(idx, 1);
      delete room.turn.actionsByActorId[seat.actorId];
      _logEvent(room, { type: 'ACTION_CANCELLED', visibility: 'public', payload: { seatId: seatId, actorId: seat.actorId } });
    },

    /** 真人席位转为机器人接管 */
    replaceWithBot: function (roomId, seatId, botConfig) {
      var room = _requireRoom(roomId);
      var seat = room.seats.find(function (s) { return s.seatId === seatId; });
      if (!seat) throw new Error('席位不存在');
      if (seat.kind !== 'human') throw new Error('只能替换真人席位');
      seat.kind = 'bot';
      seat.controller.kind = 'bot-weighted';
      seat.controller.controllerId = null;
      seat.controller.botProfileId = (botConfig && botConfig.profileId) || 'pursuer';
      // 若在收集中且已提交，撤回并让 bot 自动落子
      if (room.status === 'collecting' && seat.actorId) {
        var idx = room.turn.submittedActorIds.indexOf(seat.actorId);
        if (idx >= 0) {
          room.turn.submittedActorIds.splice(idx, 1);
          delete room.turn.actionsByActorId[seat.actorId];
        }
        _autoSubmitBots(room);
        _resolveIfReady(room);
      }
      _logEvent(room, { type: 'BOT_REPLACED', visibility: 'public', payload: { seatId: seatId } });
      return seat;
    },

    /** 回收机器人席位为真人 */
    reclaimBotSeat: function (roomId, seatId, participant) {
      var room = _requireRoom(roomId);
      var seat = room.seats.find(function (s) { return s.seatId === seatId; });
      if (!seat) throw new Error('席位不存在');
      if (seat.kind !== 'bot') throw new Error('只能回收机器人席位');
      seat.kind = 'human';
      seat.displayName = (participant && participant.displayName) || seat.displayName || '回归者';
      seat.controller.kind = room.mode === 'local-hotseat' ? 'local-hotseat' : 'local-human';
      seat.controller.botProfileId = null;
      seat.participantId = (participant && participant.participantId) || ('p_' + Date.now());
      seat.controller.controllerId = seat.participantId;
      // 无论当前处于哪个阶段，都撤回该席位的已提交动作，让真人重新选择
      if (seat.actorId) {
        var idx = room.turn.submittedActorIds.indexOf(seat.actorId);
        if (idx >= 0) {
          room.turn.submittedActorIds.splice(idx, 1);
          delete room.turn.actionsByActorId[seat.actorId];
        }
      }
      _logEvent(room, { type: 'SEAT_RECLAIMED', visibility: 'public', payload: { seatId: seatId } });
      return seat;
    },

    /** 获取某席位的过滤视图（隐私隔离） */
    getViewForSeat: function (roomId, seatId) {
      var room = _rooms.get(roomId);
      if (!room) return null;
      return Room.RoomView.getForSeat(room, seatId);
    },

    /** 等待进行中的结算完成 */
    awaitPending: function (roomId) {
      var room = _rooms.get(roomId);
      if (!room || !room._pending) return Promise.resolve();
      return room._pending;
    },

    /** 保存房间（API Key 不入存档） */
    saveRoom: function (roomId) {
      var room = _rooms.get(roomId);
      if (!room) return null;
      if (room.storySession && Story.snapshotRng) Story.snapshotRng(room.storySession);
      var snap = JSON.parse(JSON.stringify(room));
      delete snap._pending;  // 不存运行时 Promise
      _stripKeys(snap, ['apiKey', '_apiKey', 'key']);
      return JSON.stringify({ saveVersion: Room.VERSION, room: snap, snapshotAt: Date.now() });
    },

    /** 读取存档恢复房间 */
    loadRoom: function (serialized) {
      var parsed;
      try { parsed = typeof serialized === 'string' ? JSON.parse(serialized) : serialized; }
      catch (e) { return null; }
      if (!parsed || !parsed.room) return null;
      var room = parsed.room;
      // 迁移：补齐字段
      if (!room.schemaVersion) room.schemaVersion = Room.VERSION;
      if (!room.turn) room.turn = { turnId: '', round: 0, phase: 'idle', openedAt: 0, lockedAt: 0, submittedActorIds: [], actionsByActorId: {}, botStatusByActorId: {}, resolutionId: null };
      if (room.turn.lastError === undefined) room.turn.lastError = null;
      if (!room.eventLog) room.eventLog = [];
      if (!room.settings) room.settings = { seed: '', narrativePace: '常规', narrativeProfile: 'immersive', allowCustomActions: true, allowSpectators: false, aiNarrationMode: 'host-byok', pvpMode: 'dramatic' };
      if (!room.settings.narrativeProfile) room.settings.narrativeProfile = 'immersive';
      if (!room.settings.pvpMode) room.settings.pvpMode = 'dramatic';
      room._pending = null;
      // 恢复 Story RNG
      if (room.storySession) {
        Story._activateState(room.storySession);
      }
      _rooms.set(room.roomId, room);
      return room;
    },

    /** V3 单人存档迁移为 V3.1 房间存档（Sprint 5 预留，基础实现） */
    migrateFromV3: function (v3Save) {
      var parsed;
      try { parsed = typeof v3Save === 'string' ? JSON.parse(v3Save) : v3Save; }
      catch (e) { return null; }
      if (!parsed || !parsed.world) return null;
      parsed = Story._migrate(parsed);
      var room = Room.createRoomState({ mode: 'local-solo', seed: parsed.world.seed });
      // 初始化 maxSeats 个空席位（createRoomState 不自动创建）
      for (var i = 0; i < room.maxSeats; i++) {
        room.seats.push(Room.createSeat({ seatId: 'seat_' + i, index: i, kind: 'empty' }));
      }
      room.status = 'collecting';
      room.storySession = parsed;
      // 第一席为真人（旧玩家），其余为机器人
      parsed.actors.forEach(function (a, i) {
        var seat = room.seats[i];
        if (!seat) return;
        seat.kind = i === 0 ? 'human' : 'bot';
        seat.displayName = a.name;
        seat.actorId = a.id;
        seat.actorSetup = { name: a.name, identity: a.identity, daoPath: a.daoPath, publicWish: a.publicWish, hiddenFate: a.hiddenFate, personalityTags: a.personalityTags };
        seat.ready = true;
        if (i === 0) {
          seat.controller.kind = 'local-human';
          room.hostSeatId = seat.seatId;
        } else {
          seat.controller.kind = 'bot-weighted';
          seat.controller.botProfileId = 'pursuer';
        }
      });
      room.turn.round = parsed.story.chapterIndex;
      room.turn.phase = 'collecting';
      _rooms.set(room.roomId, room);
      return room;
    },
  };

  /* ============================================================
   * §3 内部辅助
   * ============================================================ */

  function _requireRoom(roomId) {
    var room = _rooms.get(roomId);
    if (!room) throw new Error('房间不存在：' + roomId);
    return room;
  }

  function _requireSeat(room, seatIndex) {
    var seat = room.seats[seatIndex];
    if (!seat) throw new Error('席位不存在：' + seatIndex);
    return seat;
  }

  /** Validate at the room boundary so a bad client command never locks a turn. */
  function _normalizeAction(room, seat, action) {
    if (!action || typeof action !== 'object') throw new Error('需要 choiceId 或 custom');
    var choiceId = typeof action.choiceId === 'string' ? action.choiceId.trim() : '';
    var customText = action.custom && typeof action.custom.text === 'string'
      ? action.custom.text.trim()
      : '';
    if (choiceId && customText) throw new Error('choiceId 与 custom 不能同时提交');
    if (choiceId) {
      var choices = Story.getChoicesForActor(room.storySession, seat.actorId);
      if (!choices.some(function (c) { return c.id === choiceId; })) {
        throw new Error('无效的选择：' + choiceId);
      }
      return { choiceId: choiceId };
    }
    if (customText) {
      if (!room.settings.allowCustomActions) throw new Error('本房间未开启自定义行动');
      if (customText.length > 500) throw new Error('自定义行动不能超过 500 字');
      return { custom: { text: customText } };
    }
    throw new Error('需要有效的 choiceId 或非空 custom.text');
  }

  function _logEvent(room, event) {
    room.eventLog.push(Object.assign({
      id: 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      roomId: room.roomId,
      turnId: room.turn.turnId,
      createdAt: Date.now(),
    }, event));
    room.updatedAt = Date.now();
  }

  function _directorEventPayload(room) {
    if (!room || !room.storySession || !Story.getDirectorSnapshot) return null;
    var snap = Story.getDirectorSnapshot(room.storySession);
    if (!snap || !snap.activeArc) return null;
    var arc = snap.activeArc;
    var last = snap.lastDivergence || null;
    var event = snap.lastEvent || null;
    return {
      arcId: arc.arcId,
      arcTitle: arc.title,
      arcStatus: arc.status,
      currentBeatId: arc.currentBeat ? arc.currentBeat.beatId : '',
      currentBeatTitle: arc.currentBeat ? arc.currentBeat.title : '',
      result: event ? event.result : (last ? last.result : null),
      lastBeatId: event ? event.beatId : (last ? last.beatId : null),
      reasons: last ? (last.reasons || []) : [],
      clockEvents: last ? (last.clockEvents || []) : [],
      directorScore: last && last.directorScore ? last.directorScore : null,
      clocks: arc.pressureClocks || [],
    };
  }

  function _logNarrationRepairEvents(room) {
    var repair = room && room.storySession && room.storySession.api && room.storySession.api.lastSemanticRepair;
    if (!repair || repair.reportedAt) return;
    var payload = { round: room.turn.round, turnId: repair.turnId || room.turn.turnId, errors: repair.errors || [] };
    _logEvent(room, { type: 'NARRATION_VALIDATION_FAILED', visibility: 'host', payload: payload });
    _logEvent(room, { type: 'NARRATION_AUTO_REPAIR_STARTED', visibility: 'host', payload: payload });
    _logEvent(room, { type: repair.status === 'succeeded' ? 'NARRATION_AUTO_REPAIR_SUCCEEDED' : 'NARRATION_AUTO_REPAIR_FAILED', visibility: 'host', payload: payload });
    repair.reportedAt = Date.now();
  }

  /** 开启新回合：重置收集状态，机器人自动落子 */
  function _openTurn(room) {
    if (!room.storySession) return;
    room.turn.round++;
    room.turn.turnId = 'turn_' + room.turn.round;
    room.turn.phase = 'collecting';
    room.turn.openedAt = Date.now();
    room.turn.lockedAt = 0;
    room.turn.submittedActorIds = [];
    room.turn.actionsByActorId = {};
    room.turn.botStatusByActorId = {};
    room.turn.resolutionId = null;
    room.turn.lastError = null;
    _logEvent(room, { type: 'TURN_OPENED', visibility: 'public', payload: { round: room.turn.round } });
    _autoSubmitBots(room);
    // 仅当有真人席位时才检查自动结算（避免全 Bot 房间无限循环）
    var hasHuman = room.seats.some(function (s) { return s.kind === 'human'; });
    if (hasHuman) _resolveIfReady(room);
  }

  /** 机器人自动落子：读取候选 → aiChoose → 写入动作 */
  function _autoSubmitBots(room) {
    if (!room.storySession) return;
    var botSeats = room.seats.filter(function (s) {
      return s.kind === 'bot' && s.actorId && room.turn.submittedActorIds.indexOf(s.actorId) < 0;
    });
    botSeats.forEach(function (seat) {
      var choices = Story.getChoicesForActor(room.storySession, seat.actorId);
      if (!choices || !choices.length) return;
      var actor = room.storySession.actors.find(function (a) { return a.id === seat.actorId; });
      if (!actor) return;
      room.turn.botStatusByActorId[seat.actorId] = { status: 'thinking', startedAt: Date.now() };
      _logEvent(room, { type: 'BOT_THINKING', visibility: 'public', payload: { seatId: seat.seatId, actorId: seat.actorId } });
      var chosen = Story.aiChoose(actor, choices, room.storySession);
      room.turn.actionsByActorId[seat.actorId] = { choiceId: chosen.id };
      room.turn.submittedActorIds.push(seat.actorId);
      room.turn.botStatusByActorId[seat.actorId] = { status: 'submitted', choiceId: chosen.id, tags: chosen.tags || [] };
      _logEvent(room, { type: 'BOT_ACTION_SELECTED', visibility: 'public', payload: { seatId: seat.seatId, actorId: seat.actorId } });
    });
  }

  /** 检查所有活跃席位是否已提交 */
  function _allSeatsSubmitted(room) {
    var active = room.seats.filter(function (s) { return s.kind === 'human' || s.kind === 'bot'; });
    return active.every(function (s) {
      return s.actorId && room.turn.submittedActorIds.indexOf(s.actorId) >= 0;
    });
  }

  /** 若全部已提交，锁定并触发结算 */
  function _resolveIfReady(room) {
    if (room.turn.phase !== 'collecting') return false;
    if (!_allSeatsSubmitted(room)) return false;
    room.turn.phase = 'locked';
    room.turn.lockedAt = Date.now();
    room.status = 'locked';
    _logEvent(room, { type: 'TURN_LOCKED', visibility: 'public', payload: { round: room.turn.round } });
    room._pending = _resolveTurn(room);
    return true;
  }

  /** 结算回合：调用 Story.resolveTurn → 发布章节 → 开启下一回合（V3.3 Narration Transaction） */
  async function _resolveTurn(room) {
    room.status = 'resolving';
    room.turn.phase = 'resolving';
    _logEvent(room, { type: 'NARRATION_STARTED', visibility: 'public', payload: { round: room.turn.round } });
    try {
      var actions = Object.assign({}, room.turn.actionsByActorId);
      await Room.runStoryTask(function () {
        return Story.resolveTurn(room.storySession, actions, { beforeNarration: room._beforeNarration });
      });
      _logNarrationRepairEvents(room);
      // V3.3.1：resolveTurn 成功返回后，根据 turnPhase 判断结果
      var phase = Story.getTurnPhase(room.storySession);
      if (phase === 'awaiting_narration' || phase === 'narration_failed') {
        // AI 失败：停在 narration_failed，不清空提交状态，全员保持锁定
        room.status = 'narration_failed';
        room.turn.phase = 'narration_failed';
        var pr = Story.getPendingResolution(room.storySession);
        var err = pr && pr.lastNarrationError ? pr.lastNarrationError : null;
        room.turn.lastError = err ? ('天机未应：' + (err.code || 'UNKNOWN') + ' — ' + (err.message || '')) : '天机未应';
        _logEvent(room, { type: 'NARRATION_AWAITING_RETRY', visibility: 'host', payload: { round: room.turn.round, error: room.turn.lastError } });
      } else {
        // published：正常推进
        room.turn.phase = 'published';
        room.turn.resolutionId = 'res_' + room.turn.round;
        _logEvent(room, { type: 'CHAPTER_PUBLISHED', visibility: 'public', payload: { round: room.turn.round, chapterIndex: room.storySession.story.chapterIndex } });
        var directorPayload = _directorEventPayload(room);
        if (directorPayload && directorPayload.result) {
          directorPayload.round = room.turn.round;
          directorPayload.chapterIndex = room.storySession.story.chapterIndex;
          _logEvent(room, { type: 'DIRECTOR_RESOLVED', visibility: 'public', payload: directorPayload });
        }
        _logEvent(room, { type: 'PRIVATE_CHOICES_DELIVERED', visibility: 'seat', payload: { round: room.turn.round } });
        room.status = 'collecting';
        _openTurn(room);
      }
    } catch (e) {
      // resolving 异常（边界 1A）：回 collecting，保留 actionsByActorId + botActions，不清空 submittedActorIds
      // 玩家可重新触发结算。Story.abortResolution 已在 resolveTurn 内部调用，回 collecting。
      room.status = 'collecting';
      room.turn.phase = 'collecting';
      room.turn.lastError = e && e.message ? e.message : 'unknown resolving error';
      _logEvent(room, { type: 'NARRATION_FAILED', visibility: 'host', payload: { error: e.message } });
    } finally {
      room._pending = null;
      room._beforeNarration = null;
    }
  }

  /** V3.3.1 重试叙事：在 narration_failed 可调用，复用同一 pendingResolution */
  Room.coordinator.retryNarration = async function (roomId, options) {
    var room = _rooms.get(roomId);
    if (!room) throw new Error('房间不存在');
    if (room.status !== 'narration_failed' && room.status !== 'awaiting_narration') throw new Error('当前不在待叙事状态');
    room._pending = _retryNarration(room, options || {});
    return room._pending;
  };

  async function _retryNarration(room, options) {
    room.turn.lastError = null;
    try {
      await Room.runStoryTask(function () { return Story.retryNarration(room.storySession, options); });
      _logNarrationRepairEvents(room);
      var phase = Story.getTurnPhase(room.storySession);
      if (phase === 'narration_failed' || phase === 'awaiting_narration') {
        // 仍失败：保持 narration_failed
        var pr = Story.getPendingResolution(room.storySession);
        var err = pr && pr.lastNarrationError ? pr.lastNarrationError : null;
        room.turn.lastError = err ? ('天机未应：' + (err.code || 'UNKNOWN') + ' — ' + (err.message || '')) : '天机未应';
        _logEvent(room, { type: 'NARRATION_RETRY_FAILED', visibility: 'host', payload: { round: room.turn.round, retryCount: pr ? pr.retryCount : 0, error: room.turn.lastError } });
      } else {
        // 成功：published → collecting
        room.turn.phase = 'published';
        room.turn.resolutionId = 'res_' + room.turn.round;
        _logEvent(room, { type: 'CHAPTER_PUBLISHED', visibility: 'public', payload: { round: room.turn.round, chapterIndex: room.storySession.story.chapterIndex } });
        var directorPayload = _directorEventPayload(room);
        if (directorPayload && directorPayload.result) {
          directorPayload.round = room.turn.round;
          directorPayload.chapterIndex = room.storySession.story.chapterIndex;
          _logEvent(room, { type: 'DIRECTOR_RESOLVED', visibility: 'public', payload: directorPayload });
        }
        _logEvent(room, { type: 'PRIVATE_CHOICES_DELIVERED', visibility: 'seat', payload: { round: room.turn.round } });
        room.status = 'collecting';
        _openTurn(room);
      }
    } catch (e) {
      room.turn.lastError = e && e.message ? e.message : 'retry error';
      _logEvent(room, { type: 'NARRATION_RETRY_FAILED', visibility: 'host', payload: { round: room.turn.round, error: e.message } });
    } finally {
      room._pending = null;
      room._beforeNarration = null;
    }
  }

  /** 递归剔除敏感字段（API Key 等） */
  function _stripKeys(obj, keys) {
    if (!obj || typeof obj !== 'object') return;
    keys.forEach(function (k) { delete obj[k]; });
    Object.keys(obj).forEach(function (k) {
      if (typeof obj[k] === 'object' && obj[k] !== null) _stripKeys(obj[k], keys);
    });
  }

  /* ============================================================
   * §4 RoomView — 按席位过滤隐私视图
   * ============================================================ */

  Room.RoomView = {
    /**
     * 返回某席位的可见视图。
     * 公共部分：房间状态、公共故事、各席位占用/准备/已落子状态。
     * 私密部分：仅本席位的角色选择、私密事实、隐藏命数。
     * 禁止返回：其他真人的 choices/privateFacts、机器人候选选项。
     */
    getForSeat: function (room, seatId) {
      if (!room) return null;
      var seat = room.seats.find(function (s) { return s.seatId === seatId; });
      if (!seat) return null;

      var publicStory = room.storySession ? Story.getPublicStoryView(room.storySession) : null;
      var eventLog = Array.isArray(room.eventLog) ? room.eventLog : [];

      var view = {
        room: {
          roomId: room.roomId,
          roomCode: room.roomCode || '',
          mode: room.mode,
          status: room.status,
          round: room.turn.round,
          phase: room.turn.phase,
          maxSeats: room.maxSeats,
          hostSeatId: room.hostSeatId,
          seats: room.seats.map(function (s) {
            var actorName = '';
            if (s.actorSetup) actorName = s.actorSetup.name;
            else if (s.actorId && room.storySession) {
              var a = room.storySession.actors.find(function (x) { return x.id === s.actorId; });
              if (a) actorName = a.name;
            }
            return {
              seatId: s.seatId,
              index: s.index,
              kind: s.kind,
              displayName: s.displayName,
              actorName: actorName,
              ready: s.ready,
              submitted: s.actorId ? room.turn.submittedActorIds.indexOf(s.actorId) >= 0 : false,
              isHost: s.seatId === room.hostSeatId,
            };
          }),
        },
        publicStory: publicStory,
        publicDirector: room.storySession && Story.getDirectorSnapshot
          ? Story.getDirectorSnapshot(room.storySession)
          : null,
        arcVoting: room.directorVote ? {
          phase: room.directorVote.phase,
          candidates: Story._clone(room.directorVote.candidates || []),
          votedSeatIds: Object.keys(room.directorVote.votesBySeatId || {}),
          selectedArcId: room.directorVote.selectedArcId || null,
        } : null,
        publicEvents: eventLog.filter(function (e) {
          return e && e.visibility === 'public';
        }).slice(-20),
        ownSeat: {
          seatId: seat.seatId,
          kind: seat.kind,
          actorId: seat.actorId,
          ready: seat.ready,
          submitted: seat.actorId ? room.turn.submittedActorIds.indexOf(seat.actorId) >= 0 : false,
        },
        ownActor: null,
      };

      if (seat.seatId === room.hostSeatId) {
        view.hostEvents = eventLog.filter(function (e) {
          return e && e.visibility === 'host';
        }).slice(-20);
      }
      view.ownEvents = eventLog.filter(function (e) {
        return e && e.visibility === 'seat' && (!e.seatId || e.seatId === seatId);
      }).slice(-20);

      // 私密信息：仅当席位有角色且游戏已开始时
      if (seat.kind !== 'spectator') {
        if (seat.actorId && room.storySession) {
          view.ownActor = Story.getPrivateActorView(room.storySession, seat.actorId);
        } else if (seat.actorSetup) {
          // 大厅阶段：返回立命信息
          view.ownActor = {
            actorId: null,
            name: seat.actorSetup.name,
            publicProfile: seat.actorSetup.identity + '·' + seat.actorSetup.daoPath,
            ownPrivateFacts: [],
            ownStatus: '尚未入局。',
            ownChoices: [],
            ownPrivateEvents: [],
            ownHiddenFate: seat.actorSetup.hiddenFate || '',
          };
        }
      }

      return view;
    },
  };

  /* ============================================================
   * §5 RoomTransport — 联机接口预留（Sprint 6）
   * ------------------------------------------------------------
   * 将"命令发送 / 事件接收 / 快照同步"抽象为 Transport 接口。
   * UI 只依赖 Transport，不直接依赖 LocalRoomCoordinator。
   *
   * 接口契约：
   *   transport.send(command)        → Promise<any>     发送命令并返回结果
   *   transport.onEvent(cb)          → unsubscribe      注册事件监听
   *   transport.getSnapshot(roomId)  → RoomState|null   获取当前快照
   *   transport.awaitPending(roomId) → Promise          等待异步结算完成
   *
   * 命令格式：{ type: 'COMMAND_TYPE', ...params }
   * 事件格式：{ type: 'EVENT_TYPE', payload: {...}, ts: number }
   *
   * 替换为 MockRemoteTransport / WebSocketRoomTransport 时，
   * UI 核心逻辑无需修改。
   * ============================================================ */

  /** 命令 → 协调器方法 映射表 */
  Room.COMMAND_HANDLERS = {
    createRoom:        function (c) { return Room.coordinator.createRoom(c.config); },
    addHumanSeat:      function (c) { return Room.coordinator.addHumanSeat(c.roomId, c.seatIndex, c.participant); },
    addBotSeat:        function (c) { return Room.coordinator.addBotSeat(c.roomId, c.seatIndex, c.botConfig); },
    removeSeat:        function (c) { return Room.coordinator.removeSeat(c.roomId, c.seatId); },
    assignActorToSeat: function (c) { return Room.coordinator.assignActorToSeat(c.roomId, c.seatId, c.actorSetup); },
    setSeatReady:      function (c) { return Room.coordinator.setSeatReady(c.roomId, c.seatId, c.ready); },
    startRoom:         function (c) { return Room.coordinator.startRoom(c.roomId); },
    submitAction:      function (c) { return Room.coordinator.submitAction(c.roomId, c.seatId, c.action); },
    cancelAction:      function (c) { return Room.coordinator.cancelAction(c.roomId, c.seatId); },
    replaceWithBot:    function (c) { return Room.coordinator.replaceWithBot(c.roomId, c.seatId, c.botConfig); },
    reclaimBotSeat:    function (c) { return Room.coordinator.reclaimBotSeat(c.roomId, c.seatId, c.participant); },
    getViewForSeat:    function (c) { return Room.coordinator.getViewForSeat(c.roomId, c.seatId); },
    getChoicesForActor:function (c) { return Room.coordinator.getChoicesForActor(c.roomId, c.seatId); },
  };

  /** LocalRoomTransport：本地内存传输层，包装 LocalRoomCoordinator */
  Room.LocalRoomTransport = {
    _eventListeners: [],

    /** 发送命令（返回值或 Promise） */
    send: function (command) {
      if (!command || !command.type) return Promise.reject(new Error('命令缺少 type'));
      var handler = Room.COMMAND_HANDLERS[command.type];
      if (!handler) return Promise.reject(new Error('未知命令类型：' + command.type));
      try {
        var result = handler(command);
        // 兼容 async handler（startRoom 返回 Promise）
        return Promise.resolve(result).then(function (r) {
          return r;
        }, function (e) {
          throw e;
        });
      } catch (e) {
        return Promise.reject(e);
      }
    },

    /** 同步发送（非 async 命令用，返回直接值或抛异常） */
    sendSync: function (command) {
      if (!command || !command.type) throw new Error('命令缺少 type');
      var handler = Room.COMMAND_HANDLERS[command.type];
      if (!handler) throw new Error('未知命令类型：' + command.type);
      return handler(command);
    },

    /** 注册事件监听，返回取消订阅函数 */
    onEvent: function (cb) {
      this._eventListeners.push(cb);
      var self = this;
      return function () {
        var idx = self._eventListeners.indexOf(cb);
        if (idx >= 0) self._eventListeners.splice(idx, 1);
      };
    },

    /** 内部：将协调器 eventLog 中的新事件派发给监听者 */
    _emit: function (event) {
      var e = Object.assign({}, event, { ts: event.ts || Date.now() });
      this._eventListeners.forEach(function (cb) {
        try { cb(e); } catch (err) { /* 单个监听者异常不影响其他 */ }
      });
    },

    /** 获取房间快照（深拷贝，防止外部直接修改内部状态） */
    getSnapshot: function (roomId) {
      var room = Room.coordinator.getRoom(roomId);
      if (!room) return null;
      return JSON.parse(JSON.stringify(room));
    },

    /** 等待异步结算完成 */
    awaitPending: function (roomId) {
      return Room.coordinator.awaitPending(roomId);
    },

    /** 获取房间活动引用（供 UI 渲染用，不拷贝） */
    getRoom: function (roomId) {
      return Room.coordinator.getRoom(roomId);
    },
  };

  /** 默认传输层实例 */
  Room.transport = Room.LocalRoomTransport;

  /**
   * 轮询指定房间的新事件并派发给监听者。
   * UI 可调用此方法实现"事件驱动"渲染（替代直接轮询 coordinator）。
   * 返回停止函数。
   */
  Room.transport.startEventPolling = function (roomId, intervalMs) {
    var lastLen = 0;
    var stopped = false;
    var self = this;
    var room = Room.coordinator.getRoom(roomId);
    if (room) lastLen = room.eventLog.length;
    function poll() {
      if (stopped) return;
      var r = Room.coordinator.getRoom(roomId);
      if (!r) return;
      if (r.eventLog.length > lastLen) {
        for (var i = lastLen; i < r.eventLog.length; i++) {
          self._emit(r.eventLog[i]);
        }
        lastLen = r.eventLog.length;
      }
      setTimeout(poll, intervalMs || 300);
    }
    poll();
    return function () { stopped = true; };
  };

  /* ============================================================
   * §4 RoomSave — 存档、回放、迁移、导出（Sprint 5）
   * ------------------------------------------------------------
   * 仅做持久化与导出，房间/回合规则仍归 LocalRoomCoordinator。
   * localStorage 中存的是 coordinator.saveRoom 的输出（含 room + snapshotAt）。
   * ============================================================ */

  Room.SAVE_KEY = 'xiuxianju_v31_room';
  Room.V3_SAVE_KEY = 'xiuxianju_v3_save';

  Room.RoomSave = {
    /** 保存房间到 localStorage（API Key 不入存档） */
    save: function (roomId) {
      var data = Room.coordinator.saveRoom(roomId);
      if (!data) return null;
      try { if (typeof localStorage !== 'undefined') localStorage.setItem(Room.SAVE_KEY, data); } catch (e) {}
      return data;
    },

    /** 读取 localStorage 中的存档并恢复房间到 coordinator */
    load: function () {
      var data;
      try { if (typeof localStorage !== 'undefined') data = localStorage.getItem(Room.SAVE_KEY); } catch (e) { return null; }
      if (!data) return null;
      return Room.coordinator.loadRoom(data);
    },

    hasSave: function () {
      try { return typeof localStorage !== 'undefined' && !!localStorage.getItem(Room.SAVE_KEY); } catch (e) { return false; }
    },

    clear: function () {
      try { if (typeof localStorage !== 'undefined') localStorage.removeItem(Room.SAVE_KEY); } catch (e) {}
    },

    /** 旧 V3 单人存档是否存在于 localStorage */
    hasV3Save: function () {
      try { return typeof localStorage !== 'undefined' && !!localStorage.getItem(Room.V3_SAVE_KEY); } catch (e) { return false; }
    },

    /** 读取旧 V3 存档原始字符串（不迁移） */
    readV3Save: function () {
      try { if (typeof localStorage !== 'undefined') return localStorage.getItem(Room.V3_SAVE_KEY); } catch (e) { return null; }
      return null;
    },

    /** 旧 V3 单人存档迁移为 V3.1 房间（写入 coordinator 并返回） */
    migrate: function (v3Save) {
      return Room.coordinator.migrateFromV3(v3Save);
    },

    /** 回合回放：基于 eventLog + 编年史重建各回合时间线
     *  注：Story 只保留当前章节全文（currentChapter），过往章节仅存编年史摘要。
     *  因此回放中"本章正文"对当前回合为完整正文，对历史回合为编年史摘要。 */
    replayTimeline: function (roomId) {
      var room = Room.coordinator.getRoom(roomId);
      if (!room) return [];
      var rounds = {};
      function ensure(r) {
        if (!rounds[r]) rounds[r] = { round: r, events: [], actions: [], chapterTitle: '', chapterText: '' };
        return rounds[r];
      }
      room.eventLog.forEach(function (e) {
        var r = null;
        if (e.turnId) {
          var m = String(e.turnId).match(/(\d+)$/);
          if (m) r = parseInt(m[1], 10);
        }
        if (r == null) return;
        ensure(r).events.push(e);
      });
      // 编年史：chronicle[i] 是第 (i+1) 回合展示的章节摘要（开界章为 chronicle[0]）
      var story = room.storySession;
      if (story && story.story && story.story.chronicle) {
        story.story.chronicle.forEach(function (c, i) {
          var r = i + 1;
          var rd = ensure(r);
          rd.chapterTitle = '第 ' + r + ' 章';
          rd.chapterText = (c.year != null ? c.year + '年·' : '') + (c.text || '');
        });
      }
      // 当前回合若有完整章节正文，覆盖最新回合的摘要为完整正文
      if (story && story.story && story.story.currentChapter) {
        var cc = story.story.currentChapter;
        var curRound = room.turn.round || (story.story.chronicle ? story.story.chronicle.length : 1);
        var rd = ensure(curRound);
        rd.chapterTitle = cc.title || rd.chapterTitle;
        rd.chapterText = cc.chapter || cc.chapterSummary || rd.chapterText;
      }
      // 从事件中提取各角色行动（只记 seatId/actorId，私密选择内容不公开）
      Object.keys(rounds).forEach(function (k) {
        var rd = rounds[k];
        rd.events.forEach(function (e) {
          if (e.type === 'ACTION_SUBMITTED' && e.payload) {
            rd.actions.push({ seatId: e.payload.seatId, actorId: e.payload.actorId });
          }
        });
      });
      return Object.keys(rounds).map(function (k) { return rounds[k]; })
        .sort(function (a, b) { return a.round - b.round; });
    },

    /** 导出本局修行录（纯文本，可下载） */
    exportLog: function (roomId) {
      var room = Room.coordinator.getRoom(roomId);
      if (!room) return '';
      var lines = [];
      lines.push('《修行局》本局修行录');
      lines.push('种子：' + (room.settings.seed || '—') + '  模式：' + room.mode + '  房间：' + room.roomId);
      lines.push('导出时间：' + new Date().toISOString());
      lines.push('');
      if (room.storySession && room.storySession.actors) {
        lines.push('— 入局修士 —');
        room.storySession.actors.forEach(function (a, i) {
          var seat = room.seats[i];
          var kind = seat ? seat.kind : '?';
          lines.push((i + 1) + '. ' + a.name + '（' + (a.daoPath || '—') + '）· ' + kind);
        });
        lines.push('');
      }
      var timeline = Room.RoomSave.replayTimeline(roomId);
      if (timeline.length) {
        lines.push('— 章节回放 —');
        timeline.forEach(function (rd) {
          lines.push('【第 ' + rd.round + ' 回合】');
          if (rd.chapterTitle) lines.push('章节：' + rd.chapterTitle);
          if (rd.chapterText) {
            lines.push(rd.chapterText);
            lines.push('');
          }
        });
      }
      if (room.storySession && room.storySession.finalLegacy) {
        lines.push('— 百年遗产 —');
        lines.push(room.storySession.finalLegacy);
      }
      return lines.join('\n');
    },

    /** 导出房间世界遗产包（JSON 字符串，含完整世界状态供下一卷开局） */
    exportWorldLegacy: function (roomId) {
      var room = Room.coordinator.getRoom(roomId);
      if (!room || !room.storySession) return null;
      var story = room.storySession;
      var legacy = story.finalLegacy || (Story.generateLegacy ? Story.generateLegacy(story) : null);
      var pack = {
        packVersion: Room.VERSION,
        roomId: room.roomId,
        seed: room.settings.seed,
        mode: room.mode,
        snapshotAt: Date.now(),
        world: story.world,
        actors: (story.actors || []).map(function (a) {
          return {
            id: a.id, name: a.name, daoPath: a.daoPath, identity: a.identity,
            publicWish: a.publicWish, status: a.status, agentArc: a.agentArc,
          };
        }),
        chronicle: (story.story && story.story.chronicle) ? story.story.chronicle.slice() : [],
        finalLegacy: legacy,
        currentChapter: story.story && story.story.currentChapter
          ? { title: story.story.currentChapter.title, chapter: story.story.currentChapter.chapter, chapterSummary: story.story.currentChapter.chapterSummary, year: story.world ? story.world.year : null }
          : null,
      };
      return JSON.stringify(pack, null, 2);
    },
  };

})();

/* 模块导出（兼容 Node 测试；浏览器内联时自动忽略） */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Room;
} else if (typeof globalThis !== 'undefined') {
  globalThis.Room = Room;
}
