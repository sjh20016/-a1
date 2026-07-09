/**
 * public/online-ui.js — V0.1 联机模式 UI 接线（粗糙集成版）
 * ============================================================================
 * 仅负责：连接、创建/加入房间、绑定角色、准备、卷纲投票、提交行动、重试。
 * 所有状态由服务端权威裁决，浏览器只显示 room_view。
 * 依赖：public/online-client.js（提供 OnlineClient）
 * ============================================================================
 */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  var OC = null;
  var onlineActorSetup = {
    name: '陆知微', identity: '青霄宗外门弟子', daoPath: '剑修',
    publicWish: '寻找失落剑经', hiddenFate: '残剑认主', personalityTags: ['敏锐'],
  };

  function $(id) { return document.getElementById(id); }
  function show(id) { $(id).style.display = ''; }
  function hide(id) { $(id).style.display = 'none'; }

  function switchScreen(id) {
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('active'); });
    $(id).classList.add('active');
  }

  function setStatus(s) {
    var map = { disconnected: '已断开', connecting: '连接中…', connected: '已连接', reconnecting: '重连中…' };
    var el = $('online-status'); if (el) el.textContent = map[s] || s;
  }

  function errBox(e) { return (e && e.message) ? e.message : ('错误：' + ((e && e.code) || '未知')); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderView(view) {
    if (!view) return;
    var r = view.room || {};
    $('og-roomcode').textContent = (OC.session && OC.session.roomCode) || '—';
    $('og-status').textContent = r.status || '—';
    $('og-round').textContent = r.round != null ? r.round : '—';

    var seats = (r.seats || []).map(function (s) {
      var mark = s.submitted ? ' ✓' : '';
      var host = s.isHost ? ' [房主]' : '';
      return '[' + s.seatId + '] ' + (s.displayName || '空') + host + mark;
    }).join('<br>');
    $('og-seats').innerHTML = seats;

    var ps = view.publicStory;
    $('og-chapter').innerHTML = ps && ps.title
      ? '<b>' + escapeHtml(ps.title) + '</b><br><br>' + escapeHtml(ps.chapter || '')
      : '<i>（尚未生成章节）</i>';

    var dv = view.directorVote;
    if (dv && dv.phase === 'voting') {
      show('og-arcvote');
      var html = '<b>命途签投票</b><br>';
      dv.candidates.forEach(function (c) {
        html += '<button class="btn ghost sm" data-arc="' + c.arcId + '" style="margin:4px">' +
          escapeHtml(c.title || c.arcId) + (dv.ownVote === c.arcId ? ' ✓' : '') + '</button>';
      });
      $('og-arcvote').innerHTML = html;
      $('og-arcvote').querySelectorAll('button').forEach(function (btn) {
        btn.onclick = function () {
          OC.submitArcVote(btn.getAttribute('data-arc')).catch(function (e) { $('og-hint').textContent = errBox(e); });
        };
      });
      if (OC.session && OC.session.isHost) {
        var finBtn = document.createElement('button');
        finBtn.className = 'btn primary sm'; finBtn.textContent = '结算投票';
        finBtn.onclick = function () { OC.finalizeArcVote().catch(function (e) { $('og-hint').textContent = errBox(e); }); };
        $('og-arcvote').appendChild(finBtn);
      }
    } else {
      hide('og-arcvote');
    }

    var own = view.ownActor;
    var cBox = $('og-choices');
    if (r.status === 'collecting' && own && own.ownChoices && own.ownChoices.length) {
      var html2 = '<b>你的行动</b><br>';
      own.ownChoices.forEach(function (c) {
        html2 += '<button class="btn ghost sm" data-choice="' + c.id + '" style="margin:4px">' +
          escapeHtml(c.label || c.text || c.id) + '</button>';
      });
      html2 += '<br><button class="btn ghost sm" id="og-cancel">撤回</button>';
      cBox.innerHTML = html2;
      cBox.querySelectorAll('button[data-choice]').forEach(function (btn) {
        btn.onclick = function () {
          OC.submitAction({ choiceId: btn.getAttribute('data-choice') })
            .catch(function (e) { $('og-hint').textContent = errBox(e); });
        };
      });
      var cancelBtn = $('og-cancel');
      if (cancelBtn) cancelBtn.onclick = function () { OC.cancelAction().catch(function (e) { $('og-hint').textContent = errBox(e); }); };
    } else if (r.status === 'narration_failed') {
      cBox.innerHTML = '<b style="color:#c0392b">天机未应：本回合行动已锁定，等待房主重试。</b>';
      if (OC.session && OC.session.isHost) {
        cBox.innerHTML += '<br><button class="btn primary sm" id="og-retry">重试叙事</button>';
        $('og-retry').onclick = function () { OC.retryNarration().catch(function (e) { $('og-hint').textContent = errBox(e); }); };
      }
    } else {
      cBox.innerHTML = '<i>等待中…</i>';
    }

    $('og-hint').textContent = '';
  }

  function clearAndShowLobby() {
    try { localStorage.removeItem('xiuxingju_online_session'); } catch (e) {}
    OC.session = {};
    hide('online-game-panel'); show('online-lobby-panel');
  }

  // 房主开局按钮
  var startBtn = document.createElement('button');
  startBtn.className = 'btn primary sm'; startBtn.textContent = '开局（卷纲投票）';
  startBtn.style.display = 'none';
  if ($('og-seats')) $('og-seats').parentNode.insertBefore(startBtn, $('og-seats'));

  // 进入 / 返回
  var btnMode = $('btn-online-mode');
  var btnBack = $('btn-online-back');
  if (btnMode) btnMode.onclick = function () { switchScreen('screen-online'); };
  if (btnBack) btnBack.onclick = function () { switchScreen('screen-intro'); };

  // 连接
  var btnConn = $('btn-online-connect');
  if (btnConn) btnConn.onclick = function () {
    OC = new OnlineClient();
    var url = $('online-url').value.trim();
    OC.onStatus(setStatus).onView(function (view) {
      startBtn.style.display = (view && view.room && view.room.status === 'lobby' && OC.session && OC.session.isHost) ? '' : 'none';
      renderView(view);
    });
    OC.connect(url).then(function () {
      hide('online-connect-panel'); show('online-lobby-panel');
      if (OC.session.roomId) {
        OC.reconnect().then(function () {
          show('online-game-panel'); hide('online-lobby-panel');
          OC.getRoomView().then(function (res) { renderView(res.view); }).catch(function () {});
        }).catch(function () { clearAndShowLobby(); });
      }
    }).catch(function (e) { alert('连接失败：' + errBox(e)); });
  };

  // 创建房间
  var btnCreate = $('btn-online-create');
  if (btnCreate) btnCreate.onclick = function () {
    var name = $('online-name').value.trim() || '玩家A';
    OC.createRoom({ hostName: name, mode: 'online' }).then(function (res) {
      $('online-room-info').innerHTML = '房间码：<b>' + res.roomCode + '</b>（分享给好友加入）';
      return OC.assignActor(onlineActorSetup).then(function () { return OC.setReady(true); });
    }).then(function () { show('online-game-panel'); hide('online-lobby-panel'); })
      .catch(function (e) { $('online-room-info').textContent = errBox(e); });
  };

  // 加入房间
  var btnJoin = $('btn-online-join');
  if (btnJoin) btnJoin.onclick = function () {
    var code = $('online-code').value.trim();
    var name = $('online-name').value.trim() || '玩家B';
    OC.joinRoom(code, name).then(function () {
      return OC.assignActor({
        name: '沈青萝', identity: '药谷弃徒', daoPath: '丹道',
        publicWish: '查明身世', hiddenFate: '血脉旧梦', personalityTags: ['谨慎'],
      });
    }).then(function () { return OC.setReady(true); })
      .then(function () { show('online-game-panel'); hide('online-lobby-panel'); })
      .catch(function (e) { alert(errBox(e)); });
  };

  startBtn.onclick = function () { if (OC) OC.startRoomWithArcVoting().catch(function (e) { $('og-hint').textContent = errBox(e); }); };

  var btnLeave = $('btn-online-leave');
  if (btnLeave) btnLeave.onclick = function () { if (OC) OC.leave(); clearAndShowLobby(); location.reload(); };
})();
