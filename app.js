/* 語言學習 Language Learning — 主程式。
   架構：Firebase Google 登入（ll-auth.js）＋ Firestore 個人空間
   langlearn/{uid}/langs/{lang}/{notes,inbox} ＋ Azure TTS（Cloud Function
   synthesizeV4Source，失敗時降級瀏覽器語音）。 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var state = {
    user: null, uid: null, lang: 'hi',
    notes: [], inbox: [], topics: [],
    playQueue: [], playing: false, stopFlag: false,
    audioCache: new Map(), synthFn: null
  };

  function langProfile() { return LL_LANGS[state.lang] || LL_LANGS.hi; }

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
  async function loadNotes() {
    try {
      var snap = await langCol('notes').orderBy('createdAt', 'desc').get();
      state.notes = [];
      snap.forEach(function (d) {
        var n = d.data(); n._id = d.id; state.notes.push(n);
      });
    } catch (err) { console.error('load notes failed', err); state.notes = []; }
    buildTopicFilter();
    renderNotes();
  }

  function buildTopicFilter() {
    var map = new Map();
    state.notes.forEach(function (n) {
      var key = (n.topicId || '') + '‖' + (n.topicName || '');
      if (!map.has(key)) map.set(key, { id: n.topicId || '', name: n.topicName || '', count: 0 });
      map.get(key).count++;
    });
    state.topics = Array.from(map.values());
    var sel = $('topicFilter');
    var cur = sel.value;
    sel.innerHTML = '<option value="">全部主題</option>';
    state.topics.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t.id + '‖' + t.name;
      o.textContent = (t.id ? '#' + t.id + ' ' : '') + (t.name || '(未分類)') + ' (' + t.count + ')';
      sel.appendChild(o);
    });
    if (cur) sel.value = cur;
  }

  function filteredNotes() {
    var q = $('searchInput').value.trim().toLowerCase();
    var tf = $('topicFilter').value;
    return state.notes.filter(function (n) {
      if (tf) {
        var key = (n.topicId || '') + '‖' + (n.topicName || '');
        if (key !== tf) return false;
      }
      if (q) {
        var hay = [n.zh, n.foreign, n.roman, n.topicName].join(' ').toLowerCase();
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
      div.innerHTML = '<div class="empty">還沒有句子。去「學新句」用 AI 整理第一批，或到「設定」匯入舊站資料。</div>';
      return;
    }
    var L = langProfile();
    list.forEach(function (n) {
      var card = document.createElement('div');
      card.className = 'note-card';
      card.innerHTML =
        '<label class="note-check"><input type="checkbox" data-id="' + n._id + '"></label>' +
        '<div class="note-body">' +
          '<div class="note-zh">' + esc(n.zh || '') +
            (n.topicName ? ' <span class="topic-badge">' + esc(n.topicId ? '#' + n.topicId + ' ' : '') + esc(n.topicName) + '</span>' : '') + '</div>' +
          '<div class="note-foreign" lang="' + esc(L.locale) + '">' + esc(n.foreign || '') + '</div>' +
          (n.roman ? '<div class="note-roman">' + esc(n.roman) + '</div>' : '') +
        '</div>' +
        '<div class="note-actions">' +
          '<button type="button" data-act="play" data-id="' + n._id + '" title="播放">▶</button>' +
          '<button type="button" data-act="edit" data-id="' + n._id + '" title="編輯">✏️</button>' +
          '<button type="button" data-act="del" data-id="' + n._id + '" title="刪除">🗑</button>' +
        '</div>';
      div.appendChild(card);
    });
  }

  function findNote(id) { return state.notes.find(function (n) { return n._id === id; }); }

  $('noteList').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var n = findNote(btn.getAttribute('data-id'));
    if (!n) return;
    var act = btn.getAttribute('data-act');
    if (act === 'play') playSentence(n, btn);
    else if (act === 'edit') openEditor(n);
    else if (act === 'del' && confirm('確定刪除這句？')) deleteNote(n);
  });

  async function deleteNote(n) {
    try { await langCol('notes').doc(n._id).delete(); await loadNotes(); }
    catch (err) { alert('刪除失敗：' + (err.message || err)); }
  }

  /* ---------- 新增／編輯 ---------- */
  var editingId = null;
  function openEditor(n) {
    editingId = n ? n._id : null;
    $('editZh').value = n ? n.zh || '' : '';
    $('editForeign').value = n ? n.foreign || '' : '';
    $('editRoman').value = n ? n.roman || '' : '';
    $('editTopicId').value = n ? n.topicId || '' : '';
    $('editTopicName').value = n ? n.topicName || '' : '';
    $('editorTitle').textContent = n ? '編輯句子' : '新增句子';
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
      try {
        speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(text);
        u.lang = lang; u.rate = rate || 0.85;
        var vs = speechSynthesis.getVoices();
        var low = lang.toLowerCase();
        u.voice = vs.find(function (v) { return v.lang.toLowerCase() === low; }) ||
                  vs.find(function (v) { return v.lang.toLowerCase().indexOf(low.split('-')[0]) === 0; }) || null;
        u.onend = u.onerror = function () { resolve(); };
        speechSynthesis.speak(u);
      } catch (_) { resolve(); }
    });
  }

  function playUrl(url) {
    return new Promise(function (resolve) {
      var a = new Audio(url);
      a.onended = a.onerror = function () { resolve(); };
      a.play().catch(function () { resolve(); });
    });
  }

  async function azureForeign(text, locale) {
    var key = locale + '\n' + text;
    if (state.audioCache.has(key)) return state.audioCache.get(key);
    if (!state.synthFn) {
      state.synthFn = window.firebase.app().functions('us-east1').httpsCallable('synthesizeV4Source', { timeout: 60000 });
    }
    var res = await state.synthFn({ locale: locale, text: text });
    var data = (res && res.data) || {};
    if (!data.audioBase64) throw new Error('empty audio');
    var url = 'data:' + (data.contentType || 'audio/mpeg') + ';base64,' + data.audioBase64;
    state.audioCache.set(key, url);
    return url;
  }

  async function playForeign(text, locale) {
    var L = langProfile();
    if (L.cloudVoice) {
      try { return await playUrl(await azureForeign(text, locale)); }
      catch (err) { console.warn('Azure failed, browser fallback', err); }
    }
    await speakBrowser(text, locale, 0.85);
  }

  async function playSentence(n, btn) {
    if (state.playing) { stopPlayback(); return; }
    state.playing = true; state.stopFlag = false;
    if (btn) btn.classList.add('playing');
    $('playState').textContent = '▶ 播放中：' + (n.zh || n.foreign || '').slice(0, 24);
    try {
      if (n.audioUrl) {
        /* 舊站匯入：MP3 已含完整版式（中文1遍＋外語3遍），直接播。 */
        if (!state.stopFlag) await playUrl(n.audioUrl);
      } else {
        var L = langProfile();
        if (!state.stopFlag && n.zh) await speakBrowser(n.zh, 'zh-TW', 0.9);
        for (var i = 0; i < 3 && !state.stopFlag; i++) {
          await playForeign(n.foreign, L.locale);
          if (!state.stopFlag) await sleep(700);
        }
      }
    } finally {
      state.playing = false;
      if (btn) btn.classList.remove('playing');
      $('playState').textContent = '';
    }
  }

  function stopPlayback() {
    state.stopFlag = true;
    try { speechSynthesis.cancel(); } catch (_) {}
  }

  async function playSelected() {
    var ids = Array.prototype.map.call(
      document.querySelectorAll('#noteList input[type=checkbox]:checked'),
      function (cb) { return cb.getAttribute('data-id'); });
    if (!ids.length) { alert('請先勾選句子。'); return; }
    if (state.playing) { stopPlayback(); return; }
    state.playing = true; state.stopFlag = false;
    $('playSelectedBtn').textContent = '⏹ 停止';
    var loop = $('loopCheck').checked;
    try {
      do {
        for (var i = 0; i < ids.length && !state.stopFlag; i++) {
          var n = findNote(ids[i]);
          if (n) await playSentenceInner(n);
        }
      } while (loop && !state.stopFlag);
    } finally {
      state.playing = false;
      $('playSelectedBtn').textContent = '▶ 播放勾選';
      $('playState').textContent = '';
    }
  }

  async function playSentenceInner(n) {
    $('playState').textContent = '▶ 播放中：' + (n.zh || n.foreign || '').slice(0, 24);
    if (n.audioUrl) { await playUrl(n.audioUrl); return; }
    var L = langProfile();
    if (n.zh) await speakBrowser(n.zh, 'zh-TW', 0.9);
    for (var i = 0; i < 3 && !state.stopFlag; i++) {
      await playForeign(n.foreign, L.locale);
      if (!state.stopFlag) await sleep(700);
    }
  }

  /* ---------- 學新句：提示辭工作流 ---------- */
  function currentLearnPrompt() { return llBuildLearnPrompt(state.lang); }
  function currentOrganizePrompt() { return llBuildOrganizePrompt(state.lang); }

  function copyText(t, okMsg) {
    function done() { $('learnMsg').textContent = okMsg || '已複製，去 Gemini／ChatGPT 貼上吧。'; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (_) { $('learnMsg').textContent = '複製失敗，請手動複製。'; }
      document.body.removeChild(ta);
    }
  }

  function copyLearnPrompt() {
    var idea = $('ideaInput').value.trim();
    var t = currentLearnPrompt() + (idea ? '\n\n我想表達的內容：\n' + idea : '');
    copyText(t, '學習提示辭已複製（' + langProfile().nameZh + '）。');
  }

  function copyOrganizePrompt() { copyText(currentOrganizePrompt(), '整理提示辭已複製。'); }

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
      var d = document.createElement('div');
      d.className = 'preview-item';
      d.innerHTML = '<div class="preview-num">第 ' + (i + 1) + ' 句</div>' +
        '<div>中文：' + esc(it.zh) + '</div>' +
        '<div>' + esc(langProfile().scriptName) + '：' + esc(it.foreign) + '</div>' +
        (it.roman ? '<div class="note-roman">' + esc(it.roman) + '</div>' : '');
      div.appendChild(d);
    });
    $('saveParsedBtn').hidden = false;
    $('learnMsg').textContent = '解析出 ' + items.length + ' 句，檢查無誤後存入句子庫。';
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
      $('learnMsg').textContent = '已存入 ' + items.length + ' 句！';
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
        $('learnMsg').textContent = '已載入待整理內容，開始第一步吧。';
      }
    }
  });

  /* ---------- 設定 ---------- */
  function renderLangUI() {
    var L = langProfile();
    $('currentLangName').textContent = L.nameZh + ' (' + L.name + ' · ' + L.locale + ')';
    document.title = '語言學習 · ' + L.nameZh;
    var sel = $('langSelect');
    sel.innerHTML = '';
    Object.keys(LL_LANGS).forEach(function (code) {
      var p = LL_LANGS[code];
      var o = document.createElement('option');
      o.value = code;
      o.textContent = p.nameZh + ' · ' + p.name;
      if (code === state.lang) o.selected = true;
      sel.appendChild(o);
    });
    $('libraryTitle').textContent = L.nameZh + '句子庫';
  }

  async function setLang(code) {
    if (!LL_LANGS[code] || code === state.lang) return;
    state.lang = code;
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
    $('topicFilter').addEventListener('change', renderNotes);
    $('searchInput').addEventListener('input', renderNotes);
    $('playSelectedBtn').addEventListener('click', playSelected);
    $('addNoteBtn').addEventListener('click', function () { openEditor(null); });
    $('saveEditBtn').addEventListener('click', saveEditor);
    $('copyLearnBtn').addEventListener('click', copyLearnPrompt);
    $('copyOrganizeBtn').addEventListener('click', copyOrganizePrompt);
    $('parseBtn').addEventListener('click', parsePreview);
    $('saveParsedBtn').addEventListener('click', saveParsed);
    $('addInboxBtn').addEventListener('click', addInbox);
    $('langSelect').addEventListener('change', function (e) { setLang(e.target.value); });
    $('testVoiceBtn').addEventListener('click', testVoice);
    $('importLegacyBtn').addEventListener('click', importLegacy);
    $('exportBtn').addEventListener('click', exportBackup);
    window.addEventListener('ll-auth-changed', onAuthChanged);
    if (window.LL_AUTH && window.LL_AUTH.ready) onAuthChanged({ detail: window.LL_AUTH });
  }

  document.addEventListener('DOMContentLoaded', bindUI);
})();
