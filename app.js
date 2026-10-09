/* 語言學習 Language Learning — 主程式。
   架構：Firebase Google 登入（ll-auth.js）＋ Firestore 個人空間
   langlearn/{uid}/langs/{lang}/{notes,inbox} ＋ Azure TTS（Cloud Function
   synthesizeV4Source，失敗時降級瀏覽器語音）。 */
(function () {
  'use strict';

  /* 版本號：每次改 app.js 就 bump，並同步 index.html 的 ?v=。設定頁會顯示它。 */
  var LL_APP_VERSION = '20261006-04';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* 暫停中就原地等待（不往下播），直到繼續或停止。 */
  async function waitIfPaused() {
    while (state.paused && !state.stopFlag) await sleep(250);
  }

  var state = {
    user: null, uid: null, lang: 'hi',
    notes: [], inbox: [], topics: [],
    playQueue: [], playing: false, stopFlag: false, paused: false,
    currentAudio: null, currentNote: null, playToken: 0, cancelWait: null,
    audioCache: new Map(), synthFn: null, audioSource: '', lastAudioFrom: '',
    playLog: [],
    /* 2026-10-09 背景播放：連播清單＋鎖屏上下句跳轉狀態 */
    playIds: null, currentIdx: null, skipRequest: null, skipArmed: false
  };

  function langProfile() { return LL_LANGS[state.lang] || LL_LANGS.hi; }

  /* 管理員（f216002@gmail.com）：Azure 不限使用次數、不限句子長度。 */
  function llIsAdmin() {
    var u = window.LL_AUTH && window.LL_AUTH.user;
    var adminEmail = window.LL_ADMIN_EMAIL || 'f216002@gmail.com';
    return !!(u && u.email && String(u.email).toLowerCase() === String(adminEmail).toLowerCase());
  }

  /* ---------- Firestore ---------- */
  function db() { return window.firebase.firestore(); }
  function langCol(name) {
    return db().collection('langlearn').doc(state.uid).collection('langs').doc(state.lang).collection(name);
  }
  function profileRef() {
    return db().collection('langlearn').doc(state.uid).collection('profile').doc('main');
  }

  /* ---------- Auth ---------- */
  function onAuthChanged(e) {
    var auth = (e && e.detail) || window.LL_AUTH || {};
    if (!auth.ready) return;
    if (auth.user) {
      state.user = auth.user; state.uid = auth.user.uid;
      $('signedOutView').hidden = true;
      $('appView').hidden = false;
      bootUser();
    } else {
      state.user = null; state.uid = null;
      $('signedOutView').hidden = false;
      $('appView').hidden = true;
    }
  }

  async function bootUser() {
    try {
      var snap = await profileRef().get();
      if (snap.exists && snap.data().currentLang && LL_LANGS[snap.data().currentLang]) {
        state.lang = snap.data().currentLang;
      } else {
        await profileRef().set({ currentLang: 'hi', updatedAt: window.firebase.firestore.FieldValue.serverTimestamp() });
        state.lang = 'hi';
      }
    } catch (err) { console.error('profile load failed', err); }
    renderLangUI();
    await Promise.all([loadNotes(), loadInbox()]);
  }

  /* ---------- Tabs ---------- */
  var TABS = ['library', 'learn', 'inbox', 'settings'];
  function switchTab(name) {
    TABS.forEach(function (t) {
      $('tab-' + t).hidden = (t !== name);
      $('nav-' + t).classList.toggle('active', t === name);
    });
    if (name === 'inbox') loadInbox();
  }

  /* ---------- 句子庫 ---------- */
  /* 舊站匯入句子的原始編號（#id）：新匯入的存 legacyId；已匯入的可從音檔名還原。 */
  function noteLegacyId(n) {
    if (n.legacyId != null && n.legacyId !== '') return String(n.legacyId);
    var m = /(\d+)\.mp3$/.exec(n.audioUrl || '');
    return m ? String(Number(m[1])) : '';
  }

  async function loadNotes() {
    try {
      var snap = await langCol('notes').get();
      state.notes = [];
      snap.forEach(function (d) {
        var n = d.data(); n._id = d.id; state.notes.push(n);
      });
      /* 排序：有主題編號的在前（編號小→大），同主題內按舊站 id 排序；自建句子按建立時間倒序。 */
      state.notes.sort(function (a, b) {
        var ta = parseInt(a.topicId, 10), tb = parseInt(b.topicId, 10);
        var ga = isNaN(ta) ? 1 : 0, gb = isNaN(tb) ? 1 : 0;
        if (ga !== gb) return ga - gb;
        if (!ga && ta !== tb) return ta - tb;
        var la = parseInt(noteLegacyId(a), 10), lb = parseInt(noteLegacyId(b), 10);
        var ia = isNaN(la) ? 1e9 : la, ib = isNaN(lb) ? 1e9 : lb;
        if (ia !== ib) return ia - ib;
        var at = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
        var bt = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
        return bt - at;
      });
    } catch (err) { console.error('load notes failed', err); state.notes = []; }
    buildTopicFilter();
    renderNotes();
  }

  /* 主題多選（對齊舊站）：下拉式勾選清單，含「全選全部主題」，再按一次全取消。 */
  var selectedTopicKeys = [];
  var prevTopicKeys = [];
  function topicKey(t) { return (t.id || '') + '‖' + (t.name || ''); }

  function buildTopicFilter() {
    var map = new Map();
    state.notes.forEach(function (n) {
      var key = (n.topicId || '') + '‖' + (n.topicName || '');
      if (!map.has(key)) map.set(key, { id: n.topicId || '', name: n.topicName || '', count: 0 });
      map.get(key).count++;
    });
    /* 主題按編號由小到大排序（修復匯入後順序亂掉的問題）。 */
    state.topics = Array.from(map.values()).sort(function (a, b) {
      var x = parseInt(a.id, 10), y = parseInt(b.id, 10);
      var nx = isNaN(x), ny = isNaN(y);
      if (nx !== ny) return nx ? 1 : -1;
      if (!nx && x !== y) return x - y;
      return String(a.name).localeCompare(String(b.name), 'zh-Hant');
    });
    var newKeys = state.topics.map(topicKey);
    if (!prevTopicKeys.length) {
      /* 首次載入／切換語言：預設空白（對齊舊站），讓使用者自己挑選主題或全選。 */
      selectedTopicKeys = [];
    } else {
      /* 主題增減或更名：保留仍存在的已選主題。 */
      selectedTopicKeys = selectedTopicKeys.filter(function (k) { return newKeys.indexOf(k) !== -1; });
    }
    prevTopicKeys = newKeys;
    renderTopicDropdown();
  }

  function renderTopicDropdown() {
    var list = $('topicCheckboxList');
    list.innerHTML = '';
    state.topics.forEach(function (t) {
      var key = topicKey(t);
      var row = document.createElement('div');
      row.className = 'topic-item';
      var label = document.createElement('label');
      label.className = 'topic-check';
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = key;
      cb.checked = selectedTopicKeys.indexOf(key) !== -1;
      cb.addEventListener('change', onTopicCheckChange);
      var sp = document.createElement('span');
      sp.textContent = (t.id ? '#' + t.id + ' ' : '') + (t.name || '(未分類)') + ' (' + t.count + ')';
      label.appendChild(cb); label.appendChild(sp);
      var rn = document.createElement('button');
      rn.type = 'button'; rn.className = 'topic-rename'; rn.title = '重新命名主題';
      rn.textContent = '✏️';
      rn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openTopicRename(key); });
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'topic-del'; del.title = '刪除主題及全部句子';
      del.textContent = '🗑️';
      del.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); deleteTopic(key); });
      var ops = document.createElement('span');
      ops.className = 'topic-ops';
      ops.appendChild(rn); ops.appendChild(del);
      row.appendChild(label); row.appendChild(ops);
      list.appendChild(row);
    });
    syncTopicUI();
  }

  /* 主題刪除：該主題下全部句子一起刪除（先顯示句數確認，無法復原）。 */
  async function deleteTopic(key) {
    var t = null;
    state.topics.forEach(function (x) { if (topicKey(x) === key) t = x; });
    if (!t) return;
    var label = (t.id ? '#' + t.id + ' ' : '') + (t.name || '(未分類)');
    if (!confirm('確定刪除主題「' + label + '」嗎？\n共 ' + t.count + ' 個句子會一起被刪除，此動作無法復原。')) return;
    try {
      var ids = [];
      state.notes.forEach(function (n) {
        if ((n.topicId || '') + '‖' + (n.topicName || '') === key) ids.push(n._id);
      });
      for (var i = 0; i < ids.length; i += 400) {
        var batch = db().batch();
        ids.slice(i, i + 400).forEach(function (id) { batch.delete(langCol('notes').doc(id)); });
        await batch.commit();
      }
      $('topicDropdownMenu').hidden = true;
      await loadNotes();
    } catch (err) { alert('刪除失敗：' + (err.message || err)); }
  }

  /* 主題批量更名：把該主題下全部句子的編號／名稱一起更新（含事後補主題）。 */
  var renamingTopicKey = null;
  function openTopicRename(key) {
    var t = null;
    state.topics.forEach(function (x) { if (topicKey(x) === key) t = x; });
    if (!t) return;
    renamingTopicKey = key;
    $('topicEditId').value = t.id || '';
    $('topicEditName').value = t.name || '';
    $('topicDropdownMenu').hidden = true;
    $('topicDialog').showModal();
  }
  async function saveTopicRename() {
    var newId = $('topicEditId').value.trim();
    var newName = $('topicEditName').value.trim();
    var old = null;
    state.topics.forEach(function (x) { if (topicKey(x) === renamingTopicKey) old = x; });
    if (!old) { $('topicDialog').close(); return; }
    var oldId = old.id || '', oldName = old.name || '';
    if (newId === oldId && newName === oldName) { $('topicDialog').close(); return; }
    var oldLabel = (oldId ? '#' + oldId + ' ' : '') + (oldName || '(未分類)');
    var newLabel = (newId ? '#' + newId + ' ' : '') + (newName || '(未分類)');
    if (!confirm('確定把主題「' + oldLabel + '」改為「' + newLabel + '」嗎？\n共 ' + old.count + ' 句會一起更新。')) return;
    try {
      var ts = window.firebase.firestore.FieldValue.serverTimestamp();
      var ids = [];
      state.notes.forEach(function (n) {
        if ((n.topicId || '') === oldId && (n.topicName || '') === oldName) ids.push(n._id);
      });
      for (var i = 0; i < ids.length; i += 400) {
        var batch = db().batch();
        ids.slice(i, i + 400).forEach(function (id) {
          batch.update(langCol('notes').doc(id), { topicId: newId, topicName: newName, updatedAt: ts });
        });
        await batch.commit();
      }
      /* 更名後保持該主題的勾選狀態。 */
      var newKey = newId + '‖' + newName;
      selectedTopicKeys = selectedTopicKeys.map(function (k) { return k === renamingTopicKey ? newKey : k; });
      $('topicDialog').close();
      await loadNotes();
    } catch (err) { alert('更新失敗：' + (err.message || err)); }
  }

  function onTopicCheckChange() {
    selectedTopicKeys = Array.prototype.map.call(
      document.querySelectorAll('#topicCheckboxList input[type=checkbox]:checked'),
      function (cb) { return cb.value; });
    syncTopicUI();
    renderNotes();
  }

  function syncTopicUI() {
    var all = $('topicSelectAll');
    if (all) all.checked = state.topics.length > 0 && selectedTopicKeys.length === state.topics.length;
    var n = selectedTopicKeys.length, total = state.topics.length;
    $('topicBtnText').textContent =
      n === total ? '全部主題' : (n === 0 ? '未選擇主題' : '已選擇 ' + n + ' 個主題');
  }

  function toggleSelectAllTopics(checked) {
    selectedTopicKeys = checked ? state.topics.map(topicKey) : [];
    renderTopicDropdown();
    renderNotes();
  }

  function filteredNotes() {
    var q = $('searchInput').value.trim().toLowerCase();
    return state.notes.filter(function (n) {
      var key = (n.topicId || '') + '‖' + (n.topicName || '');
      if (selectedTopicKeys.indexOf(key) === -1) return false;
      if (q) {
        var hay = [n.topicId, n.zh, n.foreign, n.roman, n.topicName].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function renderNotes() {
    var list = filteredNotes();
    var div = $('noteList');
    div.innerHTML = '';
    $('noteCount').textContent = '共 ' + state.notes.length + ' 句' + (list.length !== state.notes.length ? '／顯示 ' + list.length + ' 句' : '');
    if (!list.length) {
      var emptyMsg;
      if (!state.notes.length) emptyMsg = '還沒有句子。去「學新句」用 AI 整理第一批，或到「設定」匯入舊站資料。';
      else if (!selectedTopicKeys.length) emptyMsg = '請先從上方選擇主題（可複選，或勾選「全選全部主題」）。';
      else emptyMsg = '沒有符合的句子，請調整主題選擇或搜尋關鍵字。';
      div.innerHTML = '<div class="empty">' + emptyMsg + '</div>';
      updateSelectCount();
      return;
    }
    var L = langProfile();
    list.forEach(function (n) {
      var lid = noteLegacyId(n);
      var card = document.createElement('div');
      card.className = 'note-card';
      card.setAttribute('data-id', n._id);
      card.innerHTML =
        '<label class="note-check"><input type="checkbox" data-id="' + n._id + '"></label>' +
        '<div class="note-body">' +
          '<div class="note-zh">' + (lid ? '<span class="id-badge">#' + esc(lid) + '</span>' : '') + esc(n.zh || '') +
            (n.topicName ? ' <span class="topic-badge">' + esc(n.topicId ? '#' + n.topicId + ' ' : '') + esc(n.topicName) + '</span>' : '') + '</div>' +
          '<div class="note-foreign" lang="' + esc(L.locale) + '">' + esc(n.foreign || '') + '</div>' +
          (n.roman ? '<div class="note-roman">' + esc(n.roman) + '</div>' : '') +
        '</div>' +
        '<div class="note-actions">' +
          '<button type="button" data-act="play" data-id="' + n._id + '" title="播放">▶</button>' +
          /* ✨ 解釋僅印地文：播放條已移除，改由卡片觸發（沿用舊站 Gemini 服務）。 */
          (state.lang === 'hi' ? '<button type="button" data-act="explain" data-id="' + n._id + '" title="AI 解釋">✨</button>' : '') +
          '<button type="button" data-act="edit" data-id="' + n._id + '" title="編輯">✏️</button>' +
          '<button type="button" data-act="del" data-id="' + n._id + '" title="刪除">🗑</button>' +
        '</div>';
      div.appendChild(card);
    });
    updateSelectCount();
    markPlayingCard();
  }

  /* 全選目前顯示句子（對齊舊站）：再按一次全取消。 */
  function updateSelectCount() {
    var boxes = document.querySelectorAll('#noteList input[type=checkbox]');
    var checked = document.querySelectorAll('#noteList input[type=checkbox]:checked');
    $('selectCount').textContent = '共 ' + boxes.length + ' 句／已選 ' + checked.length + ' 句';
    var all = $('selectAllBox');
    if (all) all.checked = boxes.length > 0 && checked.length === boxes.length;
  }
  function toggleSelectAllShown(checked) {
    Array.prototype.forEach.call(
      document.querySelectorAll('#noteList input[type=checkbox]'),
      function (cb) { cb.checked = checked; });
    updateSelectCount();
  }

  function findNote(id) { return state.notes.find(function (n) { return n._id === id; }); }

  $('noteList').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (btn) {
      var n = findNote(btn.getAttribute('data-id'));
      if (!n) return;
      var act = btn.getAttribute('data-act');
      if (act === 'play') { warmUpAudio(); playSentence(n, btn); }
      else if (act === 'explain') explainNote(n, btn);
      else if (act === 'edit') openEditor(n);
      else if (act === 'del' && confirm('確定刪除這句？')) deleteNote(n);
      return;
    }
    /* 對齊舊站：點整行切換勾選（按鈕／輸入框本身除外）。 */
    if (e.target.closest('input, label, a, textarea, select')) return;
    var card = e.target.closest('.note-card');
    if (!card) return;
    var cb = card.querySelector('input[type=checkbox]');
    if (cb) { cb.checked = !cb.checked; updateSelectCount(); }
  });
  $('noteList').addEventListener('change', function (e) {
    if (e.target.matches('input[type=checkbox]')) updateSelectCount();
  });

  async function deleteNote(n) {
    try { await langCol('notes').doc(n._id).delete(); await loadNotes(); }
    catch (err) { alert('刪除失敗：' + (err.message || err)); }
  }

  /* ---------- 新增／編輯 ---------- */
  var editingId = null;
  function updateForeignCount() {
    var len = Array.from($('editForeign').value || '').length;
    if (llIsAdmin()) {
      $('foreignCount').textContent = len + ' 字（管理者：Azure 不限字數）';
      return;
    }
    $('foreignCount').textContent = len + ' / ' + LL_MAX_AZURE_CHARS + ' 字'
      + (len > LL_MAX_AZURE_CHARS ? '（超過上限，播放時改用瀏覽器語音，不耗 Azure 額度）' : '');
  }
  function openEditor(n) {
    editingId = n ? n._id : null;
    $('editZh').value = n ? n.zh || '' : '';
    $('editForeign').value = n ? n.foreign || '' : '';
    $('editRoman').value = n ? n.roman || '' : '';
    $('editTopicId').value = n ? n.topicId || '' : '';
    $('editTopicName').value = n ? n.topicName || '' : '';
    $('editorTitle').textContent = n ? '編輯句子' : '新增句子';
    updateForeignCount();
    $('editDialog').showModal();
  }

  async function saveEditor() {
    var L = langProfile();
    var data = {
      zh: $('editZh').value.trim(),
      foreign: $('editForeign').value.trim(),
      roman: $('editRoman').value.trim(),
      topicId: $('editTopicId').value.trim(),
      topicName: $('editTopicName').value.trim(),
      updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
    };
    if (!data.zh && !data.foreign) { alert('請至少填寫中文或' + L.nameZh + '。'); return; }
    try {
      if (editingId) {
        await langCol('notes').doc(editingId).update(data);
      } else {
        data.source = 'manual';
        data.createdAt = window.firebase.firestore.FieldValue.serverTimestamp();
        await langCol('notes').add(data);
      }
      $('editDialog').close();
      await loadNotes();
    } catch (err) { alert('儲存失敗：' + (err.message || err)); }
  }

  /* ---------- 播放引擎 ---------- */
  function speakBrowser(text, lang, rate) {
    return new Promise(function (resolve) {
      if (!('speechSynthesis' in window)) return resolve();
      var done = false;
      /* 看門狗：Chrome 的 speechSynthesis 有時永遠不觸發 onend（尤其 cancel 後緊接 speak），
         加上超時保底，保證播放流程永遠不會凍結。時間估寬一點，寧可等完不提早切斷。 */
      var timer = setTimeout(finish, Math.min(180000, 8000 + Array.from(text || '').length * 800));
      function finish() {
        if (done) return; done = true;
        clearTimeout(timer);
        if (state.speechCtl) state.speechCtl = null;
        try { if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel(); } catch (_) {}
        resolve();
      }
      /* 暫停時凍結看門狗，繼續時重設。 */
      state.speechCtl = {
        pause: function () { clearTimeout(timer); },
        resume: function () {
          clearTimeout(timer);
          timer = setTimeout(finish, Math.min(180000, 8000 + Array.from(text || '').length * 800));
        }
      };
      /* 讓 stopPlayback 可以立刻叫醒這次等待，不用等看門狗。 */
      state.cancelWait = finish;
      try {
        /* 只有真的在講話或排隊時才 cancel，避免「cancel 後緊接 speak」觸發 Chrome 的卡住 bug。 */
        if (speechSynthesis.speaking || speechSynthesis.pending) {
          try { speechSynthesis.cancel(); } catch (_) {}
        }
        var u = new SpeechSynthesisUtterance(text);
        u.lang = lang; u.rate = rate || 0.85;
        var vs = speechSynthesis.getVoices();
        var low = lang.toLowerCase();
        u.voice = vs.find(function (v) { return v.lang.toLowerCase() === low; }) ||
                  vs.find(function (v) { return v.lang.toLowerCase().indexOf(low.split('-')[0]) === 0; }) || null;
        u.onend = u.onerror = finish;
        speechSynthesis.speak(u);
      } catch (_) { finish(); }
    });
  }

  /* 共用單一 Audio 元素：iOS Safari 對頻繁 new Audio() 支援不穩，共用最可靠。 */
  var sharedAudioEl = null;
  function getAudioEl() {
    if (!sharedAudioEl) {
      sharedAudioEl = new Audio();
      try { sharedAudioEl.preload = 'auto'; } catch (_) {}
    }
    return sharedAudioEl;
  }

  /* iOS 音訊暖機：必須在使用者手勢內「同步」執行一次，否則前幾句的 play() 會被靜默跳過。 */
  var SILENT_WAV = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';
  var audioWarmedUp = false;
  function warmUpAudio() {
    if (audioWarmedUp) return;
    audioWarmedUp = true;
    try {
      var a = getAudioEl();
      a.src = SILENT_WAV;
      var pr = a.play();
      if (pr && pr.then) {
        pr.then(function () { try { a.pause(); } catch (_) {} }).catch(function () {});
      } else {
        try { a.pause(); } catch (_) {}
      }
    } catch (_) {}
  }

  /* 播放診斷：記錄最近 20 次播放，供設定頁顯示。 */
  function logPlay(entry) {
    try {
      state.playLog.push(entry);
      if (state.playLog.length > 20) state.playLog.shift();
      renderPlayDiag();
    } catch (_) {}
  }
  function renderPlayDiag() {
    var box = $('playDiagLog');
    if (!box) return;
    if (!state.playLog.length) { box.textContent = '尚無播放紀錄。'; return; }
    box.textContent = state.playLog.map(function (e) {
      return e.time + '｜' + e.text + '｜' + e.src + '｜' + e.ms + 'ms｜' + e.outcome + (e.err ? '｜' + e.err : '');
    }).join('\n');
  }

  function playUrl(url) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      var noteText = (state.currentNote && (state.currentNote.foreign || '')) || '';
      /* iOS Safari 用 data: URL 播音不可靠（play() 會靜默被拒絕導致無聲跳過），
         先轉成 Blob URL 再播才穩定。轉換是純本機運算，不耗 Azure 額度。 */
      var objectUrl = null, src = url, convErr = '';
      var dm = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url || '');
      if (dm) {
        try {
          var b64 = dm[2].replace(/\s+/g, '');
          var bin = atob(b64);
          var bytes = new Uint8Array(bin.length);
          for (var bi = 0; bi < bin.length; bi++) bytes[bi] = bin.charCodeAt(bi);
          objectUrl = URL.createObjectURL(new Blob([bytes], { type: dm[1] || 'audio/mpeg' }));
          src = objectUrl;
        } catch (err) {
          convErr = 'blob轉換失敗:' + ((err && err.message) || err);
          objectUrl = null; src = url;
        }
      }
      var a = getAudioEl();
      try { a.pause(); } catch (_) {}
      state.currentAudio = a;
      var done = false, timer = null, playErr = convErr;
      function finish(outcome) {
        if (done) return; done = true;
        if (timer) clearTimeout(timer);
        if (state.currentAudio === a) state.currentAudio = null;
        if (state.audioCtl) state.audioCtl = null;
        if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (_) {} }
        logPlay({
          time: new Date().toLocaleTimeString('zh-TW', { hour12: false }),
          text: noteText.slice(0, 18),
          src: state.lastAudioFrom || state.audioSource || '?',
          ms: Date.now() - t0,
          outcome: outcome,
          err: playErr
        });
        resolve();
      }
      /* 讓 stopPlayback 可以立刻叫醒這次等待，不用等看門狗。 */
      state.cancelWait = function () { try { a.pause(); } catch (_) {} finish('stopped'); };
      /* 看門狗：先給 45 秒保底；讀到 duration 後改按實際長度＋緩衝，保證一定結束。 */
      function arm(ms) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { try { a.pause(); } catch (_) {} finish('watchdog'); }, ms);
      }
      /* 暫停時凍結看門狗（否則暫停幾秒後會被看門狗推進到下一句、自動播出），
         繼續時按剩餘長度重設。 */
      state.audioCtl = {
        pause: function () { if (timer) { clearTimeout(timer); timer = null; } },
        resume: function () {
          var ms = 45000;
          try {
            if (a.duration && isFinite(a.duration) && a.duration > 0) {
              ms = Math.max(8000, (a.duration - (a.currentTime || 0)) * 1000 + 10000);
            }
          } catch (_) {}
          arm(Math.min(ms, 180000));
        }
      };
      arm(45000);
      try {
        a.onloadedmetadata = function () {
          var ms = 45000;
          try { if (a.duration && isFinite(a.duration) && a.duration > 0) ms = a.duration * 1000 + 10000; } catch (_) {}
          arm(Math.min(ms, 180000));
        };
      } catch (_) {}
      a.onended = function () { finish('ended'); };
      a.onerror = function () {
        try { playErr = 'audio-error code=' + (a.error ? a.error.code : '?'); } catch (_) {}
        finish('error');
      };
      try { a.src = src; } catch (_) {}
      /* iOS：等載入到可播狀態（canplay）再 play，否則前幾句會被靜默跳過。最多等 3 秒。 */
      function doPlay() {
        /* 暫停中或已停止：不要播出；繼續時由 togglePause 接手播放。 */
        if (state.paused || state.stopFlag) return;
        try {
          var pr = a.play();
          if (pr && pr.catch) pr.catch(function (err) {
            playErr = 'play()被拒:' + ((err && err.name) || (err && err.message) || err);
            try { console.warn('audio play() rejected', err); } catch (_) {}
            finish('play-rejected');
          });
        } catch (_) { finish('play-exception'); }
      }
      var canplayTimer = null, canplayDone = false;
      function canplayCleanup() {
        if (canplayTimer) clearTimeout(canplayTimer);
        try { a.removeEventListener('canplay', onCanPlay); } catch (_) {}
      }
      function onCanPlay() {
        if (canplayDone) return; canplayDone = true;
        canplayCleanup(); doPlay();
      }
      try {
        if (a.readyState >= 3) { doPlay(); }
        else {
          a.addEventListener('canplay', onCanPlay);
          canplayTimer = setTimeout(function () {
            if (canplayDone) return; canplayDone = true;
            canplayCleanup(); doPlay();
          }, 3000);
        }
      } catch (_) { doPlay(); }
    });
  }

  /* ---------- 背景播放：Media Session（鎖屏／系統媒體控制） ---------- */
  /* 2026-10-09：讓連播走系統媒體通道——關屏繼續播，鎖屏顯示句子、可暫停／切上下句。 */
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('play', function () { if (state.playing && state.paused) togglePause(); });
      navigator.mediaSession.setActionHandler('pause', function () { if (state.playing && !state.paused) togglePause(); });
      navigator.mediaSession.setActionHandler('previoustrack', function () { stepSentence(-1); });
      navigator.mediaSession.setActionHandler('nexttrack', function () { stepSentence(1); });
    } catch (_) {}
  }
  function updateMediaMetadata(n) {
    if (!('mediaSession' in navigator) || !n) return;
    try {
      var L = langProfile();
      navigator.mediaSession.metadata = new MediaMetadata({
        title: String(n.foreign || n.zh || '').slice(0, 100),
        artist: '語言學習 Language Learning',
        album: (L.nameZh || L.name || '') + '句子庫'
      });
    } catch (_) {}
    setMediaPlaybackState();
  }
  function setMediaPlaybackState() {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.playbackState = (!state.playing || state.paused) ? 'paused' : 'playing'; }
    catch (_) {}
  }
  /* 鎖屏／媒體鍵的上下句：中斷目前這句，跳到清單中指定位置（僅連播模式）。 */
  function stepSentence(dir) {
    if (!state.playing || !state.playIds || !state.playIds.length) return;
    var idx = (state.currentIdx == null ? 0 : state.currentIdx) + dir;
    if (idx < 0) idx = 0;
    if (idx >= state.playIds.length) idx = state.playIds.length - 1;
    state.skipArmed = true;
    state.skipRequest = idx;
    /* 立刻叫醒目前的等待（播音／Azure 請求），不等看門狗超時。 */
    var cancel = state.cancelWait;
    state.cancelWait = null;
    try { if (cancel) cancel(); } catch (_) {}
    try { if (state.currentAudio) state.currentAudio.pause(); } catch (_) {}
    try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (_) {}
  }

  /* ---------- 暫停／繼續（對齊舊站 ⏸ 暫停） ---------- */
  function setPausedUI() {
    $('pauseBtn').textContent = state.paused ? '▶ 繼續' : '⏸ 暫停';
  }
  function togglePause() {
    if (!state.playing) return;
    if (state.paused) {
      /* 繼續：恢復聲音＋重設看門狗 */
      state.paused = false;
      if (state.currentAudio) {
        state.currentAudio.play().catch(function () {});
        if (state.audioCtl) { try { state.audioCtl.resume(); } catch (_) {} }
      } else {
        try { speechSynthesis.resume(); } catch (_) {}
        if (state.speechCtl) { try { state.speechCtl.resume(); } catch (_) {} }
      }
    } else {
      /* 暫停：停住聲音＋凍結看門狗（否則幾秒後看門狗會推進到下一句自動播出） */
      state.paused = true;
      if (state.currentAudio) {
        try { state.currentAudio.pause(); } catch (_) {}
        if (state.audioCtl) { try { state.audioCtl.pause(); } catch (_) {} }
      } else {
        try { speechSynthesis.pause(); } catch (_) {}
        if (state.speechCtl) { try { state.speechCtl.pause(); } catch (_) {} }
      }
    }
    setPausedUI();
    setMediaPlaybackState();
  }
  function beginPlaybackUI() {
    state.paused = false; setPausedUI();
    $('pauseBtn').disabled = false;
    setMediaPlaybackState();
  }
  function endPlaybackUI() {
    state.paused = false; setPausedUI();
    $('pauseBtn').disabled = true;
    state.currentAudio = null;
    showNowPlaying(null);
    setMediaPlaybackState();
  }

  /* ---------- 播放中顯示＋卡片高亮（對齊舊站） ---------- */
  function showNowPlaying(n) {
    var bar = $('nowPlaying');
    state.currentNote = n || null;
    if (!n) { bar.hidden = true; markPlayingCard(); return; }
    bar.hidden = false;
    $('npForeign').textContent = n.foreign || '';
    $('npRoman').textContent = n.roman || '';
    $('npZh').textContent = n.zh || '';
    markPlayingCard();
  }
  function markPlayingCard() {
    Array.prototype.forEach.call(
      document.querySelectorAll('#noteList .note-card.playing'),
      function (c) { c.classList.remove('playing'); });
    if (state.currentNote) {
      var card = document.querySelector('#noteList .note-card[data-id="' + state.currentNote._id + '"]');
      if (card) card.classList.add('playing');
    }
  }

  /* ---------- Azure 音檔本機快取（IndexedDB，關掉重開還在；換聲音時改 tag 舊快取自動失效） ---------- */
  var IDB_VOICE_TAG = { 'hi-IN': 'madhur-v2', 'id-ID': 'gadis-v1', 'es-ES': 'elvira-v1',
    'en-US': 'jenny-v1', 'de-DE': 'katja-v1', 'ko-KR': 'sunhi-v1', 'ja-JP': 'nanami-v1' }; /* 2026-10-05 後端男聲上線，bump 使舊女聲本機快取失效 */
  function audioCacheKey(locale, text) {
    return locale + '\n' + (IDB_VOICE_TAG[locale] || 'v1') + '\n' + text;
  }
  var idbAudio = null;
  function openAudioDB() {
    return new Promise(function (resolve) {
      if (idbAudio) return resolve(idbAudio);
      if (!('indexedDB' in window)) return resolve(null);
      try {
        var req = indexedDB.open('ll-audio-cache', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('audio'); };
        req.onsuccess = function () {
          idbAudio = req.result;
          /* 清掉已失效的舊 tag 條目。 */
          try {
            var store = idbAudio.transaction('audio', 'readwrite').objectStore('audio');
            var all = store.getAllKeys();
            all.onsuccess = function () {
              (all.result || []).forEach(function (k) {
                var p = String(k).split('\n');
                if (p.length < 3 || (IDB_VOICE_TAG[p[0]] || 'v1') !== p[1]) {
                  try { store.delete(k); } catch (_) {}
                }
              });
            };
          } catch (_) {}
          resolve(idbAudio);
        };
        req.onerror = function () { resolve(null); };
      } catch (_) { resolve(null); }
    });
  }
  function idbGet(key) {
    return openAudioDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var rq = db.transaction('audio', 'readonly').objectStore('audio').get(key);
          rq.onsuccess = function () { resolve(rq.result || null); };
          rq.onerror = function () { resolve(null); };
        } catch (_) { resolve(null); }
      });
    });
  }
  function idbPut(key, val) {
    openAudioDB().then(function (db) {
      if (!db) return;
      try { db.transaction('audio', 'readwrite').objectStore('audio').put(val, key); } catch (_) {}
    });
  }

  /* ---------- 聲音來源標記（讓使用者親眼確認這句是 Azure 還是瀏覽器語音） ---------- */
  var AUDIO_SOURCE_LABEL = {
    'azure': 'Azure',
    'cloud-cache': 'Azure · 雲端快取',
    'idbcache': 'Azure · 本機快取',
    'browser': '瀏覽器語音'
  };
  function setAudioSource(kind, detail) {
    state.audioSource = kind;
    var el = $('npSource');
    if (!el) return;
    el.textContent = AUDIO_SOURCE_LABEL[kind] || kind;
    el.title = detail ? ('Azure 失敗原因：' + detail) : '';
    el.className = 'np-source ' + (kind === 'browser' ? 'np-source-browser' : 'np-source-azure');
  }

  async function azureForeign(text, locale) {
    var key = audioCacheKey(locale, text);
    if (state.audioCache.has(key)) { state.lastAudioFrom = 'idbcache'; return state.audioCache.get(key); }
    var local = await idbGet(key);
    if (local) { state.audioCache.set(key, local); state.lastAudioFrom = 'idbcache'; return local; }
    if (!state.synthFn) {
      state.synthFn = window.firebase.app().functions('us-east1').httpsCallable('synthesizeV4Source', { timeout: 60000 });
    }
    /* 保底 70 秒＋可被 stopPlayback 立刻叫醒：雲端函式無回應時也不凍結播放流程。 */
    var res = await new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('Azure 請求逾時（70秒無回應）')); }, 70000);
      state.cancelWait = function () { clearTimeout(timer); reject(new Error('已停止')); };
      state.synthFn({ locale: locale, text: text }).then(
        function (r) { clearTimeout(timer); resolve(r); },
        function (e) { clearTimeout(timer); reject(e); }
      );
    });
    state.cancelWait = null;
    var data = (res && res.data) || {};
    if (!data.audioBase64) throw new Error('empty audio');
    var url = 'data:' + (data.contentType || 'audio/mpeg') + ';base64,' + data.audioBase64;
    state.audioCache.set(key, url);
    idbPut(key, url);
    state.lastAudioFrom = data.cached ? 'cloud-cache' : 'azure';
    return url;
  }

  async function playForeign(text, locale) {
    var L = langProfile();
    var tooLong = !llIsAdmin() && Array.from(text || '').length > LL_MAX_AZURE_CHARS;
    if (L.cloudVoice && !tooLong) {
      try {
        var url = await azureForeign(text, locale);
        /* 查詢期間被按了停止：直接返回，不要播。 */
        if (state.stopFlag) return;
        await waitIfPaused();
        if (state.stopFlag) return;
        setAudioSource(state.lastAudioFrom || 'azure');
        await playUrl(url);
        return;
      } catch (err) {
        /* 使用者按了停止：不要改播瀏覽器語音，直接把停止信號往上拋，讓循環立刻結束。 */
        if (state.stopFlag) throw err;
        /* 鎖屏上下句跳轉：往上拋，讓連播循環處理跳轉，不降級。 */
        if (state.skipArmed) { err._llSkip = true; throw err; }
        var reason = (err && err.message) || String(err);
        console.warn('Azure failed, browser fallback', err);
        /* 失敗原因顯示出來，不再靜默降級。 */
        setAudioSource('browser', reason);
      }
    }
    if (tooLong) {
      var ps = $('playState');
      if (ps && ps.textContent.indexOf('瀏覽器語音') < 0) ps.textContent += '（超過' + LL_MAX_AZURE_CHARS + '字，改用瀏覽器語音）';
      setAudioSource('browser', '超過 ' + LL_MAX_AZURE_CHARS + ' 字上限');
    } else if (!L.cloudVoice) {
      setAudioSource('browser');
    }
    await waitIfPaused();
    await speakBrowser(text, locale, 0.85);
  }

  /* 2026-10-09：中文改走 Azure 預生成音檔（背景播放用），走 <audio> 媒體通道，
     關屏不中斷。後端尚未部署中文語音、或額度用完時，自動降級瀏覽器語音。 */
  async function playChineseAzure(text) {
    var tooLong = !llIsAdmin() && Array.from(text || '').length > LL_MAX_AZURE_CHARS;
    if (tooLong) return false;
    try {
      var url = await azureForeign(text, 'zh-TW');
      /* 查詢期間被按了停止：直接返回，不要播。 */
      if (state.stopFlag) return true;
      await waitIfPaused();
      if (state.stopFlag) return true;
      setAudioSource(state.lastAudioFrom || 'azure');
      await playUrl(url);
      return true;
    } catch (err) {
      /* 使用者按了停止：不要改播瀏覽器語音，直接把停止信號往上拋，讓循環立刻結束。 */
      if (state.stopFlag) throw err;
      /* 鎖屏上下句跳轉：往上拋，讓連播循環處理跳轉，不降級。 */
      if (state.skipArmed) { err._llSkip = true; throw err; }
      var reason = (err && err.message) || String(err);
      console.warn('Chinese Azure failed, browser fallback', err);
      /* 失敗原因顯示出來，不再靜默降級。 */
      setAudioSource('browser', reason);
      return false;
    }
  }

  /* 每句先播一次中文（Azure 預生成音檔；失敗時降級瀏覽器語音 zh-TW），再播三次外語。 */
  async function playChineseOnce(n, token) {
    if (!n.zh || state.stopFlag) return;
    if (token !== undefined && token !== state.playToken) return;
    await waitIfPaused();
    if (state.stopFlag) return;
    if (token !== undefined && token !== state.playToken) return;
    var azureOk = await playChineseAzure(n.zh);
    if (!azureOk && !state.stopFlag && (token === undefined || token === state.playToken)) {
      setAudioSource('browser');
      await speakBrowser(n.zh, 'zh-TW', 0.9);
    }
    if (!state.stopFlag && (token === undefined || token === state.playToken)) await sleep(500);
  }

  async function playSentence(n, btn) {
    if (state.playing) {
      /* 播到一半點了別句的播放鍵：直接切換過去（先停舊的，等它完全退出再播新的），
         不讓使用者以為當掉。點同一句則是切換為停止。 */
      var switching = !state.currentNote || state.currentNote._id !== n._id;
      stopPlayback();
      if (!switching) return;
      var waited = 0;
      while (state.playing && waited < 2000) { await sleep(50); waited += 50; }
      if (state.playing) return;  /* 舊循環 2 秒還沒退出，保守起見不啟動新的 */
    }
    state.playing = true; state.stopFlag = false;
    var token = ++state.playToken;
    beginPlaybackUI();
    if (btn) btn.classList.add('playing');
    $('playState').textContent = '▶ 播放中：' + (n.foreign || n.zh || '').slice(0, 24);
    showNowPlaying(n);
    try {
      /* 每句先播一次中文，再播三次外語（Azure）。 */
      var L = langProfile();
      await playChineseOnce(n, token);
      for (var i = 0; i < 3 && !state.stopFlag && token === state.playToken; i++) {
        await waitIfPaused();
        await playForeign(n.foreign, L.locale);
        if (!state.stopFlag && token === state.playToken) await sleep(700);
      }
    } finally {
      state.playing = false;
      if (btn) btn.classList.remove('playing');
      $('playState').textContent = '';
      endPlaybackUI();
    }
  }

  function stopPlayback() {
    state.playToken++;
    state.stopFlag = true;
    state.skipRequest = null; state.skipArmed = false;
    /* 立刻叫醒目前卡住的等待（播音／Azure 請求），不等看門狗超時。 */
    var cancel = state.cancelWait;
    state.cancelWait = null;
    try { if (cancel) cancel(); } catch (_) {}
    state.paused = false; setPausedUI();
    try { if (state.currentAudio) state.currentAudio.pause(); } catch (_) {}
    try { speechSynthesis.cancel(); } catch (_) {}
    setMediaPlaybackState();
  }

  async function playSelected() {
    var ids = Array.prototype.map.call(
      document.querySelectorAll('#noteList input[type=checkbox]:checked'),
      function (cb) { return cb.getAttribute('data-id'); });
    if (!ids.length) { alert('請先勾選句子。'); return; }
    if (state.playing) { stopPlayback(); return; }
    state.playing = true; state.stopFlag = false;
    state.playIds = ids; state.currentIdx = 0; state.skipRequest = null; state.skipArmed = false;
    var token = ++state.playToken;
    beginPlaybackUI();
    $('playSelectedBtn').textContent = '⏹ 停止';
    var loop = $('loopCheck').checked;
    try {
      do {
        var idx = 0;
        /* 2026-10-09：while 循環＋skipRequest，讓鎖屏上下句可以中途跳轉。 */
        while (idx < ids.length && !state.stopFlag && token === state.playToken) {
          if (state.skipRequest != null) {
            idx = state.skipRequest;
            state.skipRequest = null; state.skipArmed = false;
            if (idx < 0) idx = 0;
            if (idx >= ids.length) break;
          }
          state.currentIdx = idx;
          var n = findNote(ids[idx]);
          try {
            if (n) await playSentenceInner(n, token);
          } catch (err) {
            /* 鎖屏跳轉中斷：回到循環頂部處理 skipRequest。 */
            if (err && err._llSkip) continue;
            throw err;
          }
          idx++;
        }
      } while (loop && !state.stopFlag && token === state.playToken);
    } finally {
      state.playing = false;
      state.playIds = null; state.currentIdx = null; state.skipRequest = null; state.skipArmed = false;
      $('playSelectedBtn').textContent = '▶ 播放勾選';
      $('playState').textContent = '';
      endPlaybackUI();
    }
  }

  async function playSentenceInner(n, token) {
    $('playState').textContent = '▶ 播放中：' + (n.foreign || n.zh || '').slice(0, 24);
    showNowPlaying(n);
    updateMediaMetadata(n);
    /* 每句先播一次中文，再播三次外語。 */
    var L = langProfile();
    await playChineseOnce(n, token);
    for (var i = 0; i < 3 && !state.stopFlag && (token === undefined || token === state.playToken); i++) {
      await waitIfPaused();
      await playForeign(n.foreign, L.locale);
      if (!state.stopFlag && (token === undefined || token === state.playToken)) await sleep(700);
    }
  }

  /* ---------- ✨ 解釋（移植舊站 Gemini 面板，僅印地文；觸發鈕在各卡片上，播放條不再佔位） ---------- */
  var GEMINI_WEB_APP = 'https://script.google.com/macros/s/AKfycbwJSRywJnRF-H7B8imfFNzGAL-Af32AEOuMZUMgAUKc7zg1Yox4NedVWz1IeljRKc7jiQ/exec';

  function explainNote(n, btn) {
    if (!n || !n.foreign) { alert('找不到這句的內容。'); return; }
    $('geminiOriginalHindi').textContent = n.foreign || '';
    $('geminiOriginalRoman').textContent = n.roman || '';
    $('geminiOriginalZh').textContent = n.zh || '';
    $('geminiPanel').style.display = 'block';
    var statusBox = $('geminiStatus'), resultBox = $('geminiResult');
    statusBox.style.display = 'block';
    statusBox.textContent = '⏳ 正在連線 Gemini AI，請稍候……';
    resultBox.textContent = '';
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
    var callbackName = 'geminiCallback_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    var script = document.createElement('script');
    var completed = false, timeoutId = null;
    function cleanup() {
      if (script.parentNode) script.parentNode.removeChild(script);
      try { delete window[callbackName]; } catch (e) { window[callbackName] = undefined; }
      if (timeoutId) clearTimeout(timeoutId);
      if (btn) { btn.textContent = '✨'; btn.disabled = false; }
    }
    window[callbackName] = function (result) {
      if (completed) return; completed = true;
      if (!result || !result.ok) {
        statusBox.textContent = '❌ ' + ((result && result.error) || 'Gemini 沒有回傳資料。');
      } else {
        statusBox.style.display = 'none';
        resultBox.textContent = result.text || 'Gemini 沒有回傳解釋內容。';
      }
      cleanup();
    };
    script.onerror = function () {
      if (completed) return; completed = true;
      statusBox.textContent = '❌ 無法連線解釋服務。';
      cleanup();
    };
    script.src = GEMINI_WEB_APP + '?callback=' + encodeURIComponent(callbackName) +
      '&hindi=' + encodeURIComponent(n.foreign || '') +
      '&zh=' + encodeURIComponent(n.zh || '');
    script.async = true;
    document.body.appendChild(script);
    timeoutId = setTimeout(function () {
      if (completed) return; completed = true;
      statusBox.textContent = '❌ 等待超過 90 秒，後端沒有回傳。';
      cleanup();
    }, 90000);
  }

  /* ---------- 學新句：提示辭工作流 ---------- */
  function currentLearnPrompt() { return llBuildLearnPrompt(state.lang); }
  function currentOrganizePrompt() { return llBuildOrganizePrompt(state.lang); }

  /* 學新句三段式：提示詞由系統在背景自動加上，使用者只管輸入／按鍵／貼上。 */
  function learnFullText() {
    var idea = $('ideaInput').value.trim();
    return currentLearnPrompt() + (idea ? '\n\n我想表達的內容：\n' + idea : '');
  }
  function requireIdea() {
    var idea = $('ideaInput').value.trim();
    if (!idea) { alert('請先在上面輸入你想表達的中文。'); $('ideaInput').focus(); return null; }
    return idea;
  }

  function copyTextFallback(t) {
    var ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function copyTextRaw(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).then(function () { return true; }, function () { return copyTextFallback(t); });
    }
    return Promise.resolve(copyTextFallback(t));
  }
  function isMobileDevice() {
    return window.matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  /* ①：複製學習提示詞（含中文） */
  function copyLearn() {
    if (!requireIdea()) return;
    copyTextRaw(learnFullText()).then(function (ok) {
      $('step1Msg').textContent = ok ? '已複製（含提示詞），去 ChatGPT／Gemini 貼上吧。' : '複製失敗，請重試。';
    });
  }
  function copyAndOpenLearn(url) {
    if (!requireIdea()) return;
    copyTextRaw(learnFullText()).then(function () {
      if (isMobileDevice()) window.location.assign(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    });
  }

  /* ②：複製整理提示詞（追問版）——解釋已在 AI 對話上下文中，不需貼回。 */
  function copyOrganizeFollowup() {
    copyTextRaw(currentOrganizePrompt()).then(function (ok) {
      $('step2Msg').textContent = ok ? '已複製，回去剛才的大語言模型聊天室貼上送出吧。' : '複製失敗，請重試。';
    });
  }

  function parsePreview() {
    var text = $('organizedInput').value;
    if (!text.trim()) { alert('請先貼上 AI 整理好的句子。'); return; }
    var items = llParseOrganizedText(text, state.lang);
    var topicId = $('importTopicId').value.trim();
    var topicName = $('importTopicName').value.trim();
    var div = $('parsePreview');
    div.innerHTML = '';
    if (!items.length) {
      div.innerHTML = '<div class="empty">解析不到句子，請確認格式為「第 N 句／中文：／' + esc(langProfile().scriptName) + '：」。 </div>';
      $('saveParsedBtn').hidden = true;
      return;
    }
    window._parsedItems = items.map(function (it) {
      return { zh: it.zh, foreign: it.foreign, roman: it.roman, topicId: topicId, topicName: topicName, source: 'ai-import' };
    });
    items.forEach(function (it, i) {
      var tooLong = !llIsAdmin() && it.foreign && Array.from(it.foreign).length > LL_MAX_AZURE_CHARS;
      var d = document.createElement('div');
      d.className = 'preview-item';
      d.innerHTML = '<div class="preview-num">第 ' + (i + 1) + ' 句'
        + (tooLong ? ' <span class="topic-badge">超過' + LL_MAX_AZURE_CHARS + '字</span>' : '') + '</div>' +
        '<div>中文：' + esc(it.zh) + '</div>' +
        '<div>' + esc(langProfile().scriptName) + '：' + esc(it.foreign) + '</div>' +
        (it.roman ? '<div class="note-roman">' + esc(it.roman) + '</div>' : '');
      div.appendChild(d);
    });
    $('saveParsedBtn').hidden = false;
    $('parseMsg').textContent = '解析出 ' + items.length + ' 句，檢查無誤後存入句子庫。';
  }

  async function saveParsed() {
    var items = window._parsedItems || [];
    if (!items.length) return;
    $('saveParsedBtn').disabled = true;
    try {
      var col = langCol('notes');
      var batch = db().batch();
      var ts = window.firebase.firestore.FieldValue.serverTimestamp();
      items.forEach(function (it) {
        it.createdAt = ts; it.updatedAt = ts;
        batch.set(col.doc(), it);
      });
      await batch.commit();
      $('organizedInput').value = '';
      $('parsePreview').innerHTML = '';
      $('saveParsedBtn').hidden = true;
      $('parseMsg').textContent = '已存入 ' + items.length + ' 句！';
      switchTab('library');
      await loadNotes();
    } catch (err) { alert('存入失敗：' + (err.message || err)); }
    finally { $('saveParsedBtn').disabled = false; }
  }

  /* ---------- 待整理 ---------- */
  async function loadInbox() {
    try {
      var snap = await langCol('inbox').orderBy('createdAt', 'desc').get();
      state.inbox = [];
      snap.forEach(function (d) { var x = d.data(); x._id = d.id; state.inbox.push(x); });
    } catch (err) { state.inbox = []; }
    renderInbox();
  }

  function renderInbox() {
    var div = $('inboxList');
    div.innerHTML = '';
    $('inboxCount').textContent = '待整理 ' + state.inbox.length + ' 則';
    if (!state.inbox.length) { div.innerHTML = '<div class="empty">空的。想到要表達的話，隨手記一句。</div>'; return; }
    state.inbox.forEach(function (x) {
      var d = document.createElement('div');
      d.className = 'inbox-item';
      d.innerHTML = '<div class="inbox-text">' + esc(x.text) + '</div>' +
        '<div class="inbox-actions"><button type="button" data-act="go" data-id="' + x._id + '">去整理 →</button>' +
        '<button type="button" data-act="del" data-id="' + x._id + '">刪除</button></div>';
      div.appendChild(d);
    });
  }

  async function addInbox() {
    var t = $('inboxInput').value.trim();
    if (!t) return;
    try {
      await langCol('inbox').add({ text: t, createdAt: window.firebase.firestore.FieldValue.serverTimestamp() });
      $('inboxInput').value = '';
      await loadInbox();
    } catch (err) { alert('儲存失敗：' + (err.message || err)); }
  }

  $('inboxList').addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    if (btn.getAttribute('data-act') === 'del') {
      if (confirm('刪除這則？')) { await langCol('inbox').doc(id).delete(); await loadInbox(); }
    } else {
      var x = state.inbox.find(function (v) { return v._id === id; });
      if (x) {
        $('ideaInput').value = x.text;
        await langCol('inbox').doc(id).delete();
        await loadInbox();
        switchTab('learn');
        $('ideaMsg').textContent = '已載入待整理內容，開始第一步吧。';
      }
    }
  });

  /* ---------- 設定 ---------- */
  function renderLangUI() {
    var L = langProfile();
    $('currentLangName').textContent = L.nameZh + ' (' + L.name + ' · ' + L.locale + ')';
    document.title = '語言學習 · ' + L.nameZh;
    ['langSelect', 'langSelectTop'].forEach(function (id) {
      var sel = $(id);
      if (!sel) return;
      sel.innerHTML = '';
      Object.keys(LL_LANGS).forEach(function (code) {
        var p = LL_LANGS[code];
        var o = document.createElement('option');
        o.value = code;
        o.textContent = p.nameZh + ' · ' + p.name;
        if (code === state.lang) o.selected = true;
        sel.appendChild(o);
      });
    });
    $('libraryTitle').textContent = L.nameZh + '句子庫';
    /* 各欄位跟著語言變：學新句輸入框的舉例提示 */
    var ideaInput = $('ideaInput');
    if (ideaInput) ideaInput.placeholder = '例如：我明天早上要去市場買菜，怎麼用' + L.nameZh + '說？';
  }

  async function setLang(code) {
    if (!LL_LANGS[code] || code === state.lang) return;
    state.lang = code;
    prevTopicKeys = []; selectedTopicKeys = [];
    try {
      await profileRef().set({ currentLang: code, updatedAt: window.firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } catch (err) { console.error(err); }
    renderLangUI();
    await Promise.all([loadNotes(), loadInbox()]);
  }

  async function testVoice() {
    var L = langProfile();
    var sample = (L.examples[0] && L.examples[0].foreign) || 'Hello';
    $('settingsMsg').textContent = '試播' + L.nameZh + '…';
    await playForeign(sample, L.locale);
    $('settingsMsg').textContent = L.cloudVoice ? 'Azure 雲端語音正常。' : '瀏覽器語音正常（此語言走瀏覽器）。';
  }

  function parseCSV(text) {
    var rows = [], row = [], field = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  var OLD_CSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS9BA88Sf3mnAfyLALjFSNAWJEjBCd0A8EiA6JRLuwSMe2JHhT-8vD3nm-7sZKYZ3HOlFLAOfS2Aqd3/pub?gid=0&single=true&output=csv';
  var OLD_AUDIO_BASE = 'https://f216002.github.io/hindi-learning/audio/';

  async function importLegacy() {
    if (state.lang !== 'hi') { alert('舊站資料是印地文，請先把學習語言切換為印地文再匯入。'); return; }
    var existing = state.notes.length;
    if (existing > 0 && !confirm('目前已有 ' + existing + ' 句，確定要匯入舊站 480 句嗎？（不會刪除現有句子）')) return;
    $('settingsMsg').textContent = '下載舊站資料中…';
    try {
      var res = await fetch(OLD_CSV);
      var rows = parseCSV(await res.text());
      var data = rows.slice(1).filter(function (r) { return r[1] && r[1].trim(); });
      var col = langCol('notes');
      var ts = window.firebase.firestore.FieldValue.serverTimestamp();
      var n = 0;
      for (var i = 0; i < data.length; i += 400) {
        var batch = db().batch();
        data.slice(i, i + 400).forEach(function (r) {
          var id = String(r[0] || '').trim();
          var file = id.padStart(4, '0') + '.mp3';
          batch.set(col.doc(), {
            zh: (r[3] || '').trim(), foreign: (r[1] || '').trim(), roman: (r[2] || '').trim(),
            topicId: (r[5] || '').trim(), topicName: (r[6] || '').trim(),
            legacyId: id,
            audioUrl: OLD_AUDIO_BASE + file,
            source: 'legacy-import', createdAt: ts, updatedAt: ts
          });
          n++;
        });
        await batch.commit();
        $('settingsMsg').textContent = '匯入中 ' + n + ' / ' + data.length + '…';
      }
      $('settingsMsg').textContent = '匯入完成，共 ' + n + ' 句（含舊站音檔）。';
      switchTab('library');
      await loadNotes();
    } catch (err) { $('settingsMsg').textContent = '匯入失敗：' + (err.message || err); }
  }

  async function dedupeNotes() {
    if (!state.notes.length) { alert('目前沒有句子。'); return; }
    var seen = {}, dupIds = [];
    state.notes.forEach(function (n) {
      var key = n.audioUrl || ('t:' + n.foreign + '‖' + n.zh);
      if (seen[key]) dupIds.push(n._id);
      else seen[key] = true;
    });
    if (!dupIds.length) { $('settingsMsg').textContent = '檢查完成，沒有重複句子。'; return; }
    if (!confirm('找到 ' + dupIds.length + ' 句重複，確定刪除嗎？（每組只保留一句）')) return;
    $('settingsMsg').textContent = '刪除重複中…';
    try {
      for (var i = 0; i < dupIds.length; i += 400) {
        var batch = db().batch();
        dupIds.slice(i, i + 400).forEach(function (id) { batch.delete(langCol('notes').doc(id)); });
        await batch.commit();
      }
      $('settingsMsg').textContent = '完成，共刪除 ' + dupIds.length + ' 句重複。';
      await loadNotes();
    } catch (err) { $('settingsMsg').textContent = '刪除失敗：' + (err.message || err); }
  }

  async function exportBackup() {
    var data = { lang: state.lang, exportedAt: new Date().toISOString(), notes: state.notes };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lang-learning-' + state.lang + '-backup.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  /* ---------- 事件綁定 ---------- */
  function bindUI() {
    TABS.forEach(function (t) { $('nav-' + t).addEventListener('click', function () { switchTab(t); }); });
    /* 主題多選下拉 */
    $('topicDropdownBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      var m = $('topicDropdownMenu');
      m.hidden = !m.hidden;
    });
    document.addEventListener('click', function (e) {
      var dd = $('topicDropdown');
      if (dd && !dd.contains(e.target)) $('topicDropdownMenu').hidden = true;
    });
    $('topicSelectAll').addEventListener('change', function (e) { toggleSelectAllTopics(e.target.checked); });
    $('topicSaveBtn').addEventListener('click', saveTopicRename);
    $('searchInput').addEventListener('input', renderNotes);
    $('playSelectedBtn').addEventListener('click', function () { warmUpAudio(); playSelected(); });
    $('pauseBtn').addEventListener('click', togglePause);
    setupMediaSession();
    $('selectAllBox').addEventListener('change', function (e) { toggleSelectAllShown(e.target.checked); });
    $('geminiBackBtn').addEventListener('click', function () { $('geminiPanel').style.display = 'none'; });
    $('addNoteBtn').addEventListener('click', function () { openEditor(null); });
    $('saveEditBtn').addEventListener('click', saveEditor);
    $('copyLearnBtn').addEventListener('click', copyLearn);
    $('openLearnChatGPT').addEventListener('click', function () { copyAndOpenLearn('https://chatgpt.com/'); });
    $('openLearnGemini').addEventListener('click', function () { copyAndOpenLearn('https://gemini.google.com/app'); });
    $('copyOrganizeBtn').addEventListener('click', copyOrganizeFollowup);
    $('parseBtn').addEventListener('click', parsePreview);
    $('saveParsedBtn').addEventListener('click', saveParsed);
    $('addInboxBtn').addEventListener('click', addInbox);
    $('editForeign').addEventListener('input', updateForeignCount);
    $('langSelect').addEventListener('change', function (e) { setLang(e.target.value); });
    var langSelectTop = $('langSelectTop');
    if (langSelectTop) langSelectTop.addEventListener('change', function (e) { setLang(e.target.value); });
    $('testVoiceBtn').addEventListener('click', testVoice);
    $('importLegacyBtn').addEventListener('click', importLegacy);
    $('dedupeBtn').addEventListener('click', dedupeNotes);
    $('exportBtn').addEventListener('click', exportBackup);
    /* 版本號＋播放診斷 */
    try { $('appVersion').textContent = LL_APP_VERSION; } catch (_) {}
    $('clearDiagBtn').addEventListener('click', function () {
      state.playLog = []; renderPlayDiag();
    });
    renderPlayDiag();
    window.addEventListener('ll-auth-changed', onAuthChanged);
    if (window.LL_AUTH && window.LL_AUTH.ready) onAuthChanged({ detail: window.LL_AUTH });
  }

  document.addEventListener('DOMContentLoaded', bindUI);
})();
