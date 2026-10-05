/* ---- 語言學習登入狀態（移植自 V4 v4-auth.js，獨立運作） ----
   本站不設登入按鈕：與 V4 同源（f216002.github.io），共用 Firebase 登入狀態。
   老師先在 V4 用 Google 登入，本站自動辨識；未登入時顯示前往 V4 的引導。
   登入狀態發布到 window.LL_AUTH，並觸發 ll-auth-changed 事件。 */
(function () {
  'use strict';

  window.LL_FIREBASE_CONFIG = {
    apiKey: 'AIzaSyChpInXumwIWaOrR4cU8KhNm1NK5-RdgQw',
    authDomain: 'my-chinese-sentence-bank-v3.firebaseapp.com',
    projectId: 'my-chinese-sentence-bank-v3',
    storageBucket: 'my-chinese-sentence-bank-v3.firebasestorage.app',
    messagingSenderId: '178850974896',
    appId: '1:178850974896:web:f1d40b2ed4e7218b553f75'
  };
  /* 管理員（與 V3 相同）。後台審核頁只認這個 Google 帳號。 */
  window.LL_ADMIN_EMAIL = 'f216002@gmail.com';

  function $(id) { return document.getElementById(id); }

  var auth = null;
  try {
    if (!window.firebase) throw new Error('Firebase SDK 載入失敗。');
    if (!window.firebase.apps.length) {
      window.firebase.initializeApp(window.LL_FIREBASE_CONFIG);
    }
    auth = window.firebase.auth();
  } catch (err) {
    var msg = $('llAuthMessage');
    if (msg) msg.textContent = '登入功能暫時無法使用，請重新整理頁面。';
    window.LL_AUTH = Object.freeze({ ready: false, user: null });
    return;
  }
  window.LL_AUTH_INSTANCE = auth;

  var signOutButton = $('llGoogleSignOut');
  var accountPanel = $('llTeacherAccount');
  var accountPhoto = $('llAccountPhoto');
  var accountName = $('llAccountName');
  var accountEmail = $('llAccountEmail');
  var authMessage = $('llAuthMessage');
  var adminButton = $('llAdminButton');

  function setAuthMessage(message, isError) {
    if (!authMessage) return;
    authMessage.textContent = message || '';
    authMessage.classList.toggle('error', !!isError);
  }

  function isAdminEmail(email) {
    return String(email || '').toLowerCase() === String(window.LL_ADMIN_EMAIL).toLowerCase();
  }

  function publishAuthState(user) {
    window.LL_AUTH = Object.freeze({
      ready: true,
      user: user ? Object.freeze({
        uid: user.uid,
        displayName: user.displayName || '',
        email: user.email || '',
        photoURL: user.photoURL || ''
      }) : null
    });
    window.dispatchEvent(new CustomEvent('ll-auth-changed', { detail: window.LL_AUTH }));
  }

  function showSignedOut() {
    if (signOutButton) signOutButton.hidden = true;
    if (accountPanel) accountPanel.hidden = true;
    if (adminButton) adminButton.hidden = true;
    if (accountPhoto) accountPhoto.removeAttribute('src');
    if (accountName) accountName.textContent = '';
    if (accountEmail) accountEmail.textContent = '';
    setAuthMessage('');
  }

  function showSignedIn(user) {
    if (signOutButton) { signOutButton.hidden = false; signOutButton.disabled = false; }
    if (accountPanel) accountPanel.hidden = false;
    if (adminButton) adminButton.hidden = !isAdminEmail(user.email);
    if (accountName) accountName.textContent = user.displayName || '老師';
    if (accountEmail) accountEmail.textContent = user.email || '';
    if (accountPhoto) {
      if (user.photoURL) { accountPhoto.src = user.photoURL; accountPhoto.alt = ''; }
      else { accountPhoto.removeAttribute('src'); }
    }
    setAuthMessage('');
  }

  if (signOutButton) {
    signOutButton.addEventListener('click', function () {
      signOutButton.disabled = true;
      auth.signOut().catch(function (error) {
        setAuthMessage('登出失敗：' + ((error && error.message) || error.code), true);
      }).finally(function () { signOutButton.disabled = false; });
    });
  }

  window.LL_AUTH = Object.freeze({ ready: false, user: null });
  auth.onAuthStateChanged(function (user) {
    if (user && user.isAnonymous) {
      /* 舊版的匿名登入已退役：清掉殘留的匿名 session，回到未登入狀態。 */
      auth.signOut();
      return;
    }
    if (user) showSignedIn(user); else showSignedOut();
    publishAuthState(user);
  });
})();

