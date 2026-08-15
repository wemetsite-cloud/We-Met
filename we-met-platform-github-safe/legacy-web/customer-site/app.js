(() => {
  'use strict';

  const P = window.Portal;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  let me = null;
  let publicConfig = null;
  let socket = null;
  let audioCall = null;
  let currentCall = null;
  let listeners = [];
  let deferredInstallPrompt = null;
  let historyCalls = [];
  let paymentPlans = [];
  let paymentSubmissions = [];
  let currentCheckout = null;
  let paymentPollTimer = null;
  let proofPreviewUrl = '';
  const paymentStatusSeen = new Map();
  let favoriteIds = new Set();
  let activeTab = 'home';
  let serviceWorkerRegistration = null;
  let pushSubscriptionActive = false;
  let otherLanguagesEnabled = localStorage.getItem('we_met_other_languages') === '1';

  const ACTIVE_PAYMENT_KEY = 'we_met_active_payment';
  const NAVIGATION_MARKER = 'we-met-customer-navigation';
  const VALID_TABS = new Set(['home', 'wallet', 'history', 'favorites', 'notifications', 'support', 'profile']);

  const show = (selector, visible = true) => $(selector)?.classList.toggle('hidden', !visible);
  const setModalState = () => {
    document.body.classList.toggle('modal-open', Boolean($('.modal:not(.hidden), .call-modal:not(.hidden)')));
    syncBackButton();
  };

  function navigationState(tab = activeTab, overlay = null) {
    return { marker: NAVIGATION_MARKER, tab: VALID_TABS.has(tab) ? tab : 'home', overlay };
  }

  function currentOverlay() {
    if (!$('#authModal')?.classList.contains('hidden')) return 'authModal';
    if (!$('#paymentModal')?.classList.contains('hidden')) return 'paymentModal';
    if (!$('#legalModal')?.classList.contains('hidden')) return 'legalModal';
    if (!$('#callModal')?.classList.contains('hidden')) return 'callModal';
    return null;
  }

  function syncBackButton() {
    const visible = Boolean(currentOverlay() || (me && activeTab !== 'home'));
    $('#appBackButton')?.classList.toggle('hidden', !visible);
  }

  function setNavigationState({ tab = activeTab, overlay = null } = {}, mode = 'push') {
    const state = navigationState(tab, overlay);
    if (mode === 'replace') history.replaceState(state, document.title);
    else history.pushState(state, document.title);
    syncBackButton();
  }

  function openManagedOverlay(selector, overlay) {
    const element = $(selector);
    const opening = element?.classList.contains('hidden');
    show(selector);
    if (opening) setNavigationState({ overlay });
    setModalState();
  }

  function hideManagedOverlays({ preserveCall = false } = {}) {
    show('#authModal', false);
    if (!$('#paymentModal')?.classList.contains('hidden')) {
      show('#paymentModal', false);
      resetPaymentCheckout();
    }
    show('#legalModal', false);
    if (!preserveCall && !$('#callModal')?.classList.contains('hidden')) minimizeCall({ historyMode: 'none' });
    setModalState();
  }

  function closeManagedOverlay(overlay, { historyMode = 'back' } = {}) {
    if (historyMode === 'back' && history.state?.marker === NAVIGATION_MARKER && history.state.overlay === overlay) {
      history.back();
      return;
    }
    if (overlay === 'paymentModal') resetPaymentCheckout();
    if (overlay === 'callModal') minimizeCall({ historyMode: 'none' });
    else show(`#${overlay}`, false);
    setNavigationState({ overlay: null }, 'replace');
    setModalState();
  }

  function goBackInApp() {
    if (currentOverlay() || activeTab !== 'home') history.back();
  }

  function initNavigation() {
    history.replaceState(navigationState('home', null), document.title);
    window.addEventListener('popstate', (event) => {
      const state = event.state?.marker === NAVIGATION_MARKER
        ? event.state
        : navigationState('home', null);
      hideManagedOverlays();
      if (me) selectTab(state.tab, null, { historyMode: 'none' });
      syncBackButton();
    });
  }

  const isInstalledApp = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
  function syncInstallControls() {
    const installed = isInstalledApp();
    document.querySelectorAll('[data-install-app]').forEach((button) => {
      button.classList.toggle('hidden', installed || !deferredInstallPrompt);
    });
    document.querySelectorAll('.install-banner,.install-inline').forEach((section) => {
      section.classList.toggle('hidden', installed || !deferredInstallPrompt);
    });
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    if (isInstalledApp()) return;
    event.preventDefault();
    deferredInstallPrompt = event;
    syncInstallControls();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    syncInstallControls();
    P.toast('We Met is installed. Enjoy the app-like experience.', 'success');
  });
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', syncInstallControls);
  async function installApp() {
    if (isInstalledApp()) return syncInstallControls();
    if (!deferredInstallPrompt) { P.toast('Use your browser menu and choose Install We Met or Add to Home screen.', 'info'); return; }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    syncInstallControls();
  }
  async function registerFreshServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      serviceWorkerRegistration = await navigator.serviceWorker.register('service-worker.js?v=6.1.0', { updateViaCache: 'none' });
      await serviceWorkerRegistration.update();
      return serviceWorkerRegistration;
    } catch {}
  }

  function setAuth(mode) {
    openManagedOverlay('#authModal', 'authModal');
    show('#loginForm', mode === 'login');
    show('#registerForm', mode === 'register');
    show('#forgotForm', mode === 'forgot');
    $$('.auth-switch button').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
    $('#authTitle').textContent = mode === 'register' ? 'Create your account' : mode === 'forgot' ? 'Recover your account' : 'Welcome back';
    $('#authSubtitle').textContent = mode === 'register'
      ? 'Create your private We Met account.'
      : mode === 'forgot'
        ? 'The administrator will review your request.'
        : 'Sign in to continue.';
    if (mode === 'forgot') restoreRecovery();
    else show('#recoveryPanel', false);
    setTimeout(() => $('#authModal input:not(.hidden)')?.focus(), 50);
  }

  async function init() {
    initNavigation();
    bind();
    syncInstallControls();
    await registerFreshServiceWorker();
    try {
      publicConfig = await P.api('/api/public/config');
    } catch (error) {
      P.toast(error.message, 'error');
    }

    if (P.Store.token) await loadMe();
  }

  function bind() {
    document.addEventListener('click', (e) => { if (e.target.closest('[data-install-app]')) installApp(); });
    $('#appBackButton').addEventListener('click', goBackInApp);
    $('.brand').addEventListener('click', (event) => {
      event.preventDefault();
      if (me) selectTab('home');
      else window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    $('#openAuth').addEventListener('click', () => setAuth('login'));
    $$('[data-auth]').forEach((button) => button.addEventListener('click', () => setAuth(button.dataset.auth)));
    $$('[data-close]').forEach((button) => button.addEventListener('click', () => closeManagedOverlay(button.dataset.close)));
    $$('[data-app-back]').forEach((button) => button.addEventListener('click', goBackInApp));
    $$('.auth-switch button').forEach((button) => button.addEventListener('click', () => setAuth(button.dataset.mode)));
    $('#forgotOpen').addEventListener('click', () => setAuth('forgot'));
    $('#backLogin').addEventListener('click', () => setAuth('login'));
    $('#loginForm').addEventListener('submit', login);
    $('#registerForm').addEventListener('submit', register);
    $('#forgotForm').addEventListener('submit', forgot);
    $('#logoutBtn').addEventListener('click', () => logout());
    $('#notificationPermission').addEventListener('click', requestNotifications);
    $('#paymentEnableAlerts').addEventListener('click', requestNotifications);
    $('#tabs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-tab]');
      if (button) selectTab(button.dataset.tab, button);
    });
    $$('[data-jump]').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.jump)));
    $$('[data-purchase]').forEach((button) => button.addEventListener('click', openPurchaseSection));
    $('#otherLanguageToggle').checked = otherLanguagesEnabled;
    $('#otherLanguageToggle').addEventListener('change', (event) => { otherLanguagesEnabled = event.target.checked; localStorage.setItem('we_met_other_languages', otherLanguagesEnabled ? '1' : '0'); renderListeners(); });
    $('#callNow').addEventListener('click', () => requestCall());
    $('#refreshListeners').addEventListener('click', () => socket?.emit('listeners:get'));
    $('#couponForm').addEventListener('submit', redeem);
    $('#refreshPayments').addEventListener('click', loadPayments);
    $('#downloadUpiQr').addEventListener('click', saveUpiQr);
    $('#manualTransferContinue').addEventListener('click', () => setPaymentStep('submit'));
    $('#manualBackToTransfer').addEventListener('click', () => setPaymentStep('pay'));
    $('#manualPaymentForm').addEventListener('submit', submitManualPayment);
    $('#manualProof').addEventListener('change', previewManualProof);
    $$('[data-copy-payment]').forEach((button) => button.addEventListener('click', () => {
      copyValue($(`#${button.dataset.copyPayment}`)?.textContent?.trim(), 'Payment detail copied.');
    }));
    $('#checkPaymentNow').addEventListener('click', checkPaymentNow);
    $('#paymentBackWallet').addEventListener('click', () => {
      closePaymentCheckout();
    });
    $('#copyRecoveryKey').addEventListener('click', () => copyValue($('#recoveryKey').value, 'Recovery key copied.'));
    $('#checkRecovery').addEventListener('click', checkRecovery);
    $('#resetCompleteForm').addEventListener('submit', completeRecovery);
    $('#supportForm').addEventListener('submit', sendSupport);
    $('#phoneForm').addEventListener('submit', changePhone);
    $('#passwordForm').addEventListener('submit', changePassword);
    $('#loginChangeForm').addEventListener('submit', changeLogin);
    $('#endCallBtn').addEventListener('click', () => socket?.emit('call:end', { callId: currentCall?.id }));
    $('#muteBtn').addEventListener('click', toggleMute);
    $('#chatForm').addEventListener('submit', sendChat);
    $('#reportCallBtn').addEventListener('click', reportCurrent);
    $('#readNotifications').addEventListener('click', markNotificationsRead);
    $('#minimizeCall').addEventListener('click', minimizeCall);
    $('#restoreCall').addEventListener('click', restoreCall);
    $$('.legal-btn').forEach((button) => button.addEventListener('click', () => loadLegal(button.dataset.legal)));

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('#authModal').classList.contains('hidden')) {
        closeManagedOverlay('authModal');
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (me && document.visibilityState === 'visible') loadPayments({ silent: true });
    });
  }

  function applicationServerKey(value) {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = atob(base64);
    return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
  }

  function syncAlertControls() {
    const granted = 'Notification' in window && Notification.permission === 'granted';
    show('#notificationPermission', Boolean(me && publicConfig?.pushEnabled));
    $('#notificationPermission').textContent = pushSubscriptionActive
      ? 'Alerts enabled'
      : (granted ? 'Finish alert setup' : 'Enable alerts');
    $('#notificationPermission').disabled = pushSubscriptionActive;
    show('#paymentEnableAlerts', Boolean(
      publicConfig?.pushEnabled
      && 'Notification' in window
      && Notification.permission === 'default',
    ));
  }

  async function subscribeToPush({ prompt = false } = {}) {
    if (!publicConfig?.pushEnabled || !publicConfig?.vapidPublicKey) {
      if (prompt) P.toast('Notification-bar alerts are not configured yet.', 'info');
      return false;
    }
    if (!('Notification' in window) || !('PushManager' in window)) {
      if (prompt) P.toast('Push notifications are not supported on this browser.', 'info');
      return false;
    }
    let permission = Notification.permission;
    if (permission === 'default' && prompt) permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      pushSubscriptionActive = false;
      syncAlertControls();
      if (prompt) P.toast('Notification permission was not enabled.', 'info');
      return false;
    }

    try {
      const registration = serviceWorkerRegistration || await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(publicConfig.vapidPublicKey),
        });
      }
      await P.api('/api/push/subscriptions', {
        method: 'POST',
        body: JSON.stringify(subscription.toJSON()),
      });
      pushSubscriptionActive = true;
      syncAlertControls();
      if (prompt) P.toast('Notification-bar alerts are enabled.', 'success');
      return true;
    } catch (error) {
      pushSubscriptionActive = false;
      syncAlertControls();
      if (prompt) P.toast(error.message || 'Push notifications could not be enabled.', 'error');
      return false;
    }
  }

  async function requestNotifications() {
    await subscribeToPush({ prompt: true });
  }

  async function removePushSubscription() {
    try {
      const registration = serviceWorkerRegistration || await navigator.serviceWorker?.ready;
      const subscription = await registration?.pushManager?.getSubscription();
      if (!subscription) return;
      if (P.Store.token) {
        await P.api('/api/push/subscriptions', {
          method: 'DELETE',
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }).catch(() => null);
      }
      await subscription.unsubscribe();
      pushSubscriptionActive = false;
      syncAlertControls();
    } catch {}
  }

  function openPurchaseSection() {
    selectTab('wallet');
    requestAnimationFrame(() => $('#plansGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function selectTab(tab, button = null, { historyMode = 'push' } = {}) {
    if (!VALID_TABS.has(tab)) tab = 'home';
    const changed = activeTab !== tab;
    if (changed && historyMode === 'push') setNavigationState({ tab, overlay: null });
    activeTab = tab;
    const targetButton = button || $(`[data-tab="${tab}"]`);
    $$('#tabs button').forEach((item) => item.classList.toggle('active', item === targetButton));
    $$('.tab').forEach((item) => item.classList.toggle('active', item.id === `tab-${tab}`));
    targetButton?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

    if (tab === 'history' || tab === 'wallet') loadHistory();
    if (tab === 'wallet') {
      loadPlans();
      loadPayments();
    }
    if (tab === 'favorites') loadFavorites();
    if (tab === 'notifications') loadNotifications();
    if (tab === 'support') loadSupport();

    const top = $('#dashboard').getBoundingClientRect().top + window.scrollY - 74;
    if (window.scrollY > top + 120) window.scrollTo({ top, behavior: 'smooth' });
    syncBackButton();
  }

  async function login(event) {
    event.preventDefault();
    const submit = event.submitter;
    submit?.setAttribute('disabled', '');
    try {
      const response = await P.api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: $('#loginIdentifier').value, password: $('#loginPassword').value }),
      });
      if (response.user.role !== 'customer') throw new Error('Use the correct We Met app for this account.');
      P.Store.token = response.token;
      me = response.user;
      closeManagedOverlay('authModal', { historyMode: 'replace' });
      enterApp();
    } catch (error) {
      P.toast(error.message, 'error');
    } finally {
      submit?.removeAttribute('disabled');
    }
  }

  async function register(event) {
    event.preventDefault();
    const submit = event.submitter;
    submit?.setAttribute('disabled', '');
    try {
      const response = await P.api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#regName').value,
          email: $('#regEmail').value,
          phone: $('#regPhone').value,
          password: $('#regPassword').value,
          ageConfirmed: $('#regTerms').checked,
          termsAccepted: $('#regTerms').checked,
        }),
      });
      P.Store.token = response.token;
      me = response.user;
      closeManagedOverlay('authModal', { historyMode: 'replace' });
      enterApp();
    } catch (error) {
      P.toast(error.message, 'error');
    } finally {
      submit?.removeAttribute('disabled');
    }
  }

  async function forgot(event) {
    event.preventDefault();
    try {
      const response = await P.api('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ identifier: $('#forgotIdentifier').value }),
      });
      if (response.requestId && response.recoveryKey) {
        saveRecovery({ requestId: response.requestId, recoveryKey: response.recoveryKey });
        $('#recoveryRequestId').value = response.requestId;
        $('#recoveryKey').value = response.recoveryKey;
        $('#recoveryStatus').textContent = 'Request sent. Save this recovery key and check again after the administrator reviews it.';
        show('#recoveryPanel');
        show('#resetCompleteForm', false);
      }
      P.toast(response.message || 'Recovery request sent.', 'success');
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function loadMe() {
    try {
      const response = await P.api('/api/auth/me');
      if (response.user.role !== 'customer') throw new Error('Wrong account type.');
      me = response.user;
      enterApp();
    } catch {
      P.Store.clear();
      logout(false);
    }
  }

  function enterApp() {
    show('#landing', false);
    show('#dashboard');
    show('#openAuth', false);
    show('#logoutBtn');
    show('#notificationPermission');
    $('#helloName').textContent = `Hello, ${me.name}`;
    $('#profileName').textContent = me.name;
    $('#profileEmail').textContent = me.email || '—';
    $('#profilePhoneText').textContent = me.phone || 'Phone not added';
    $('#profilePhone').value = me.phone || '';
    updateBalance(me.balanceSeconds);
    connectSocket();
    loadHistory();
    loadSupport();
    loadFavorites();
    loadNotifications();
    loadPlans();
    loadPayments();
    startPaymentPolling();
    syncAlertControls();
    if ('Notification' in window && Notification.permission === 'granted') {
      subscribeToPush().catch(() => null);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    syncBackButton();
  }

  async function logout(clear = true) {
    if (clear) await removePushSubscription();
    if (clear) P.Store.clear();
    socket?.disconnect();
    audioCall?.stop();
    clearInterval(paymentPollTimer);
    paymentPollTimer = null;
    resetPaymentCheckout();
    me = null;
    pushSubscriptionActive = false;
    currentCall = null;
    show('#landing');
    show('#dashboard', false);
    show('#openAuth');
    show('#logoutBtn', false);
    show('#notificationPermission', false);
    show('#callModal', false);
    show('#restoreCall', false);
    history.replaceState(navigationState('home', null), document.title);
    activeTab = 'home';
    setModalState();
    syncAlertControls();
  }

  function updateBalance(value) {
    if (!me) return;
    me.balanceSeconds = Number(value) || 0;
    ['#balanceTop', '#balanceRing', '#walletBalance', '#callBalance'].forEach((selector) => {
      const element = $(selector);
      if (element) element.textContent = P.duration(me.balanceSeconds);
    });
  }

  async function refreshCustomerBalance() {
    if (!me) return;
    try {
      const response = await P.api('/api/auth/me');
      if (response.user.role !== 'customer') return;
      me = { ...me, ...response.user };
      updateBalance(me.balanceSeconds);
    } catch {}
  }

  function startPaymentPolling() {
    clearInterval(paymentPollTimer);
    paymentPollTimer = setInterval(() => {
      if (me && document.visibilityState !== 'hidden') loadPayments({ silent: true });
    }, 12000);
  }

  async function connectSocket() {
    socket?.disconnect();
    try { await window.SocketIOReady; } catch (error) { P.toast(error.message, 'error'); return; }
    socket = io(P.socketUrl, {
      auth: { token: P.Store.token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelayMax: 10000,
    });

    audioCall = new AudioCall({
      socket,
      iceServers: publicConfig?.iceServers || [],
      remoteAudio: $('#remoteAudio'),
      onState: (state) => {
        if (!currentCall) return;
        if (state === 'connected' && currentCall.mediaConnected !== true) {
          currentCall.mediaConnected = true;
          socket.emit('call:media-state', { callId: currentCall.id, connected: true });
        }
        if (['failed', 'disconnected', 'closed'].includes(state)) {
          $('#callState').textContent = 'Audio paused while the connection recovers…';
          if (currentCall.mediaConnected !== false) {
            currentCall.mediaConnected = false;
            socket.emit('call:media-state', { callId: currentCall.id, connected: false });
          }
        }
      },
    });

    socket.on('connect', () => socket.emit('listeners:get'));
    socket.on('disconnect', () => {
      if (!currentCall) return;
      closeCall();
      P.toast('Connection lost. The call was closed safely.', 'error');
    });
    socket.on('connect_error', (error) => console.warn('Calling server reconnecting:', error?.message || error));
    socket.on('listeners:update', ({ listeners: next = [] }) => {
      listeners = next;
      renderListeners();
    });
    socket.on('call:ringing', (data) => {
      currentCall = { id: data.callId, employee: data.employee, status: 'ringing', billed: 0 };
      openCall();
      $('#callState').textContent = `Ringing ${data.employee?.name || 'listener'}…`;
    });
    socket.on('call:retrying', (data) => {
      $('#callState').textContent = 'Trying the next available listener…';
      P.toast(data.reason || 'The listener did not answer.');
    });
    socket.on('call:unavailable', (data) => {
      closeCall();
      P.toast(data.message || 'No listener is available right now.', 'error');
      if (data.otherLanguagesAvailable && !otherLanguagesEnabled) $('#otherLanguageToggle')?.focus();
    });
    socket.on('call:error', (data) => {
      closeCall();
      P.toast(data.message || 'The call could not be started.', 'error');
      if (data.needsTopup) openPurchaseSection();
    });
    socket.on('call:accepted', async (data) => {
      if (!currentCall) currentCall = { id: data.callId };
      currentCall.status = 'connecting';
      currentCall.mediaConnected = false;
      $('#callState').textContent = 'Preparing microphone…';
      try {
        await audioCall.prepare(data.callId);
        if (!currentCall || currentCall.id !== data.callId) return;
        $('#callState').textContent = 'Connecting secure audio…';
        socket.emit('webrtc:ready', { callId: data.callId });
      } catch (error) {
        P.toast(error.message || 'Please allow microphone access.', 'error');
        socket.emit('call:end', { callId: data.callId });
      }
    });
    socket.on('webrtc:start', async ({ callId } = {}) => {
      if (!currentCall || currentCall.id !== callId) return;
      try {
        await audioCall.createOffer();
      } catch (error) {
        P.toast(error.message || 'The audio connection could not start.', 'error');
        socket.emit('call:end', { callId });
      }
    });
    socket.on('call:connected', () => {
      if (!currentCall) return;
      currentCall.status = 'active';
      $('#callState').textContent = 'Connected · billing is active';
      P.notify('We Met', `Your ${currentCall.employee?.language || 'listener'} conversation is connected.`);
    });
    socket.on('call:audio-paused', () => {
      if (currentCall) $('#callState').textContent = 'Audio paused · talk-time is not being charged';
    });
    socket.on('call:audio-restored', () => {
      if (currentCall) $('#callState').textContent = 'Connected · billing is active';
    });
    socket.on('call:tick', (data) => {
      if (!currentCall || data.callId !== currentCall.id) return;
      currentCall.billed = data.billedSeconds;
      $('#callTimer').textContent = P.duration(data.billedSeconds);
      $('#restoreTimer').textContent = P.duration(data.billedSeconds);
      updateBalance(data.balanceSeconds);
    });
    socket.on('call:low-balance', () => P.notify('Low talk-time', 'Only one minute remains in your wallet.'));
    socket.on('call:ended', (data) => {
      const needsTopup = data.needsTopup;
      P.toast(data.reason || 'The call ended.', needsTopup ? 'error' : 'info');
      closeCall();
      loadMe();
      loadHistory();
      if (needsTopup) openPurchaseSection();
    });
    socket.on('chat:message', addChat);
    socket.on('notification:new', (notification) => {
      if (/payment/i.test(notification.title || '')) {
        refreshCustomerBalance();
        loadPayments({ silent: true });
      } else {
        P.notify(notification.title, notification.body);
      }
    });
    socket.on('account:restricted', (data) => {
      P.toast(data.reason || 'Your account has been restricted.', 'error');
      logout();
    });
  }

  function listenerTone(id = '') {
    let total = 0;
    for (const character of String(id)) total += character.charCodeAt(0);
    return total % 4;
  }

  function initials(name = 'Listener') {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  }

  function statusText(status) { return ({ available: 'Available', busy: 'On a call', break: 'On break', ringing: 'Ringing', offline:'Offline' })[status] || 'Offline'; }
  function avatarFor(listener) {
    if (listener.avatar) return listener.avatar;
    let n = 0; for (const c of String(listener.id || '')) n += c.charCodeAt(0);
    return `assets/avatar-${String((n % 20) + 1).padStart(2,'0')}.svg`;
  }

  function listenerLanguage(listener) {
    return String(listener?.language || listener?.listener_language || 'Malayalam').trim() || 'Malayalam';
  }

  function listenerCardsMarkup(items, emptyTitle, emptyMessage) {
    return items.length
      ? items.map((listener) => `
        <article class="listener-card">
          <div class="abstract-avatar tone-${listenerTone(listener.id)}"><img src="${P.esc(avatarFor(listener))}" alt="" loading="lazy"></div>
          <button class="favorite-btn" data-favorite="${listener.id}" title="${favoriteIds.has(listener.id) ? 'Remove favourite' : 'Add favourite'}" aria-label="Favourite listener">${favoriteIds.has(listener.id) ? '♥' : '♡'}</button>
          <div class="listener-meta"><strong>${P.esc(listener.name)}</strong><span class="badge ${listener.status}">${statusText(listener.status)}</span></div>
          <div class="language-line">● ${P.esc(listenerLanguage(listener))} conversations</div>
          <p>${P.esc(listener.bio || 'A calm listener who is here for a real conversation.')}</p>
          <button class="button ${listener.status === 'available' ? 'button-primary' : 'button-quiet'}" data-call="${listener.id}" ${listener.status !== 'available' ? 'disabled' : ''}>${listener.status === 'available' ? 'Call this listener' : statusText(listener.status)}</button>
        </article>`).join('')
      : emptyState(emptyTitle, emptyMessage);
  }

  function renderListeners() {
    const malayalam = listeners.filter((listener) => listenerLanguage(listener).toLowerCase() === 'malayalam');
    const others = listeners.filter((listener) => listenerLanguage(listener).toLowerCase() !== 'malayalam');
    const malayalamAvailable = malayalam.filter((listener) => listener.status === 'available').length;
    const otherAvailable = others.filter((listener) => listener.status === 'available').length;

    $('#availabilityText').textContent = malayalamAvailable
      ? `${malayalamAvailable} Malayalam listener${malayalamAvailable === 1 ? '' : 's'} available now`
      : otherLanguagesEnabled && otherAvailable
        ? `No Malayalam listener right now · ${otherAvailable} other-language listener${otherAvailable === 1 ? '' : 's'} available`
        : otherAvailable
          ? 'No Malayalam listener right now · other languages are available'
          : 'No listener is available right now';

    $('#listenerGrid').innerHTML = listenerCardsMarkup(
      malayalam,
      'No Malayalam listeners online',
      otherAvailable ? 'Turn on “Suggest other languages” to see other available listeners.' : 'Please refresh or try again shortly.',
    );
    show('#otherLanguageSection', otherLanguagesEnabled);
    if (otherLanguagesEnabled) {
      $('#otherLanguageGrid').innerHTML = listenerCardsMarkup(others, 'No other-language listeners online', 'Other language listeners will appear here when they are available.');
    }

    $$('[data-call]').forEach((button) => button.addEventListener('click', () => requestCall(button.dataset.call)));
    $$('[data-favorite]').forEach((button) => button.addEventListener('click', () => toggleFavorite(button.dataset.favorite)));
  }

  function emptyState(title, message) {
    return `<div class="panel empty-state"><img src="assets/logo.svg" alt=""><h3>${P.esc(title)}</h3><p>${P.esc(message)}</p></div>`;
  }

  function requestCall(employeeId = null) {
    if (!socket?.connected) return P.toast('The calling server is not connected yet. Please try again.', 'error');
    if ((me?.balanceSeconds || 0) < (publicConfig?.minimumStartSeconds || 120)) {
      P.toast('You need at least two minutes of talk-time to start a call.', 'error');
      return openPurchaseSection();
    }
    if (currentCall) return P.toast('You already have a call in progress.', 'error');
    socket.emit('call:request', { employeeId, allowOtherLanguages: otherLanguagesEnabled });
  }

  function openCall() {
    openManagedOverlay('#callModal', 'callModal');
    show('#restoreCall', false);
    $('#callPerson').textContent = currentCall.employee?.name || 'Listener';
    $('#callBio').textContent = currentCall.employee?.bio || `A private ${currentCall.employee?.language || ''} conversation`.replace('  ', ' ');
    $('#callTimer').textContent = '0:00';
    $('#restoreTimer').textContent = '0:00';
    $('#chatMessages').innerHTML = '<div class="bubble">Your private text chat starts here.</div>';
    updateBalance(me.balanceSeconds);
  }

  function minimizeCall({ historyMode = 'back' } = {}) {
    if (!currentCall) return;
    if (historyMode === 'back' && history.state?.overlay === 'callModal') {
      history.back();
      return;
    }
    show('#callModal', false);
    show('#restoreCall');
    setModalState();
  }

  function restoreCall() {
    if (!currentCall) return;
    openManagedOverlay('#callModal', 'callModal');
    show('#restoreCall', false);
  }

  function closeCall() {
    show('#callModal', false);
    show('#restoreCall', false);
    audioCall?.stop();
    currentCall = null;
    if (history.state?.marker === NAVIGATION_MARKER && history.state.overlay === 'callModal') {
      setNavigationState({ overlay: null }, 'replace');
    }
    setModalState();
  }

  function toggleMute() {
    const muted = audioCall?.toggleMute();
    $('#muteBtn').innerHTML = `<span>${muted ? '🔇' : '🎙'}</span><small>${muted ? 'Unmute' : 'Mute'}</small>`;
  }

  function sendChat(event) {
    event.preventDefault();
    const input = $('#chatInput');
    const message = input.value.trim();
    if (!message || !currentCall) return;
    const callId = currentCall.id;
    input.value = '';
    socket.timeout(8000).emit('chat:send', { callId, message }, (error, response) => {
      if (!error && response?.ok) return;
      if (currentCall?.id === callId && !input.value) input.value = message;
      P.toast(response?.error || 'The message was not delivered. Please try again.', 'error');
    });
  }

  function addChat(message) {
    if (!currentCall || message.callId !== currentCall.id) return;
    const bubble = document.createElement('div');
    bubble.className = `bubble ${message.senderId === me.id ? 'mine' : ''}`;
    bubble.innerHTML = `<b>${P.esc(message.senderName)}</b><br>${P.esc(message.message)}`;
    $('#chatMessages').append(bubble);
    $('#chatMessages').scrollTo({ top: $('#chatMessages').scrollHeight, behavior: 'smooth' });
  }

  async function loadFavorites() {
    if (!me) return;
    try {
      const response = await P.api('/api/customer/favorites');
      favoriteIds = new Set(response.favorites.map((listener) => listener.employee_id));
      $('#favoritesList').innerHTML = response.favorites.length
        ? response.favorites.map((listener) => `
          <article class="listener-card">
            <div class="abstract-avatar tone-${listenerTone(listener.employee_id)}">${P.esc(initials(listener.name))}</div>
            <div class="listener-meta"><strong>${P.esc(listener.name)}</strong><span class="badge">Favourite</span></div>
            <div class="language-line">● ${P.esc(listener.listener_language || 'Malayalam')} conversations</div>
            <p>${P.esc(listener.bio || 'A calm listener who is here for a real conversation.')}</p>
            <div class="list-actions"><button class="button button-primary" data-fav-call="${listener.employee_id}">Call</button><button class="button button-quiet" data-fav-remove="${listener.employee_id}">Remove</button></div>
          </article>`).join('')
        : emptyState('No favourites yet', 'Tap the heart on a listener card to save them here.');
      $$('[data-fav-call]').forEach((button) => button.addEventListener('click', () => requestCall(button.dataset.favCall)));
      $$('[data-fav-remove]').forEach((button) => button.addEventListener('click', () => toggleFavorite(button.dataset.favRemove)));
      renderListeners();
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function toggleFavorite(id) {
    try {
      const saved = favoriteIds.has(id);
      await P.api(`/api/customer/favorites/${id}`, { method: saved ? 'DELETE' : 'POST' });
      P.toast(saved ? 'Listener removed from favourites.' : 'Listener added to favourites.', 'success');
      await loadFavorites();
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function loadNotifications() {
    if (!me) return;
    try {
      const response = await P.api('/api/customer/notifications');
      $('#notificationsList').innerHTML = response.notifications.length
        ? response.notifications.map((notification) => `
          <article class="list-item"><div><strong>${P.esc(notification.title)}</strong><p>${P.esc(notification.body)}</p></div><div><small>${P.date(notification.created_at)}</small>${notification.read_at ? '' : '<span class="badge available">New</span>'}</div></article>`).join('')
        : emptyState('No notifications', 'Important account and call updates will appear here.');
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function markNotificationsRead() {
    try {
      await P.api('/api/customer/notifications/read', { method: 'POST', body: '{}' });
      loadNotifications();
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function loadHistory() {
    if (!me) return;
    try {
      const response = await P.api('/api/customer/history');
      historyCalls = response.calls || [];
      $('#callHistory').innerHTML = historyCalls.length
        ? historyCalls.map((call) => `
          <article class="list-item"><div><strong>${P.esc(call.employee_name)}</strong><p>${P.date(call.created_at)} · ${P.duration(call.billed_seconds)}</p><small>${P.esc(call.end_reason || call.status)}</small></div><div class="list-actions"><button class="button button-soft" data-reconnect="${call.employee_id}">Call again</button><button class="button button-quiet" data-report="${call.id}">Report</button><button class="button button-quiet" data-block-request="${call.id}">Request restriction</button></div></article>`).join('')
        : emptyState('No call history', 'Your completed and missed calls will appear here.');

      $('#walletHistory').innerHTML = (response.wallet || []).length
        ? response.wallet.map((entry) => `
          <article class="list-item"><div><strong>${entry.seconds_delta > 0 ? '+' : '−'}${P.duration(Math.abs(entry.seconds_delta))}</strong><p>${P.esc(entry.note || entry.type)}</p></div><small>${P.date(entry.created_at)}</small></article>`).join('')
        : emptyState('No wallet activity', 'Redeemed minutes and call deductions will appear here.');

      $$('[data-reconnect]').forEach((button) => button.addEventListener('click', () => requestCall(button.dataset.reconnect)));
      $$('[data-report]').forEach((button) => button.addEventListener('click', () => reportCall(button.dataset.report, false)));
      $$('[data-block-request]').forEach((button) => button.addEventListener('click', () => reportCall(button.dataset.blockRequest, true)));

      const previous = historyCalls[0];
      if (previous) {
        show('#previousBox');
        $('#previousBox').innerHTML = `<div><strong>Continue with ${P.esc(previous.employee_name)}</strong><p>Reconnect with your most recent listener.</p></div><button class="button button-soft" id="previousCall" type="button">Call again</button>`;
        $('#previousCall').addEventListener('click', () => requestCall(previous.employee_id));
      } else {
        show('#previousBox', false);
      }
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function loadPlans() {
    if (!me) return;
    try {
      const response = await P.api('/api/customer/plans');
      renderPlans(response.plans || []);
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  function renderPlans(plans = []) {
    paymentPlans = plans;
    const planDescription = 'Exact-amount UPI · verified once · billed by connected second.';
    $('#walletPaymentIntro').textContent = 'Scan the QR or copy the UPI ID, pay the exact amount, then submit the successful UTR and payment screenshot.';
    $('#paymentHistoryIntro').textContent = 'UPI submissions remain pending until an administrator verifies the UTR and screenshot.';
    $('#plansGrid').innerHTML = plans.map((plan) => `
      <article class="plan-card ${plan.popular ? 'popular' : ''}">
        ${plan.popular ? '<span class="popular-tag">POPULAR</span>' : ''}
        <span class="plan-kicker">TALK-TIME</span>
        <h3>${Math.round(plan.seconds / 60)} <small>min</small></h3>
        <strong>${P.money(plan.price_paise)}</strong>
        <p>${P.esc(planDescription)}</p>
        <button class="button button-primary" type="button" data-buy-plan="${plan.id}">Get this pack <span>→</span></button>
      </article>`).join('');
    $$('[data-buy-plan]').forEach((button) => button.addEventListener('click', () => openPayment(button.dataset.buyPlan)));
  }

  async function copyValue(value, message = 'Copied.') {
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const area = document.createElement('textarea');
        area.value = value;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      P.toast(message, 'success');
    } catch {
      P.toast('Copy failed. Select the value and copy it manually.', 'error');
    }
  }

  function currentPaymentMode() {
    return currentCheckout?.mode || 'upi_direct';
  }

  function isDirectPaymentMode(mode) {
    return mode === 'upi_direct' || mode === 'manual_transfer';
  }

  function setPaymentStep(step) {
    const order = ['pay', 'submit', 'status'];
    const activeIndex = order.indexOf(step);
    $('#paymentProgress').classList.add('manual-mode');
    $('[data-payment-progress="submit"]').classList.remove('hidden');
    $('[data-payment-progress="status"] b').textContent = '3';
    $$('[data-payment-step]').forEach((section) => section.classList.toggle('hidden', section.dataset.paymentStep !== step));
    $$('[data-payment-progress]').forEach((item) => {
      const index = order.indexOf(item.dataset.paymentProgress);
      if (index < 0) return;
      item.classList.toggle('active', index === activeIndex);
      item.classList.toggle('complete', index < activeIndex || (step === 'status' && ['paid', 'approved'].includes(currentCheckout?.payment?.status)));
    });
    $('#paymentModal .modal-card').scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetPaymentCheckout(mode = null) {
    if (proofPreviewUrl) URL.revokeObjectURL(proofPreviewUrl);
    proofPreviewUrl = '';
    currentCheckout = null;
    $('#manualPaymentForm')?.reset();
    show('#manualProofPreview', false);
    show('#manualCheckoutPanel', false);
    show('#paymentPayContent', false);
    show('#paymentLoading');
    if (mode) currentCheckout = { mode };
    $('#paymentModal .payment-card').classList.toggle('simple-upi-mode', isDirectPaymentMode(mode));
    $('#paymentSummary').classList.toggle('simple-upi-summary', isDirectPaymentMode(mode));
    setPaymentStep('pay');
  }

  function closePaymentCheckout() {
    closeManagedOverlay('paymentModal');
  }

  function saveActivePayment(id) {
    try {
      if (id) localStorage.setItem(ACTIVE_PAYMENT_KEY, id);
      else localStorage.removeItem(ACTIVE_PAYMENT_KEY);
    } catch {}
  }

  function storedActivePayment() {
    try { return localStorage.getItem(ACTIVE_PAYMENT_KEY) || ''; } catch { return ''; }
  }

  async function openPayment(planId) {
    if (!me) {
      P.toast('Sign in before starting a payment.', 'info');
      return setAuth('login');
    }
    const mode = 'upi_direct';
    const plan = paymentPlans.find((item) => item.id === planId);
    if (!plan) return P.toast('This talk-time pack is unavailable.', 'error');
    resetPaymentCheckout(mode);
    currentCheckout = { mode, plan };
    $('#paymentTitle').textContent = 'Scan to pay';
    $('#paymentEyebrow').textContent = 'DIRECT UPI';
    $('#paymentSubtitle').textContent = 'Pay the exact amount shown below.';
    openManagedOverlay('#paymentModal', 'paymentModal');
    setPaymentStep('pay');
    try {
      const checkout = await P.api('/api/customer/manual-payments/intents', {
        method: 'POST',
        body: JSON.stringify({ planId: plan.id }),
      });
      if (!currentCheckout || currentCheckout.plan.id !== plan.id) return;
      currentCheckout = { mode, plan, intent: checkout.intent };
      renderDirectUpiIntent(checkout.intent);
      show('#paymentLoading', false);
      show('#paymentPayContent');
    } catch (error) {
      closePaymentCheckout();
      P.toast(error.message || 'The payment checkout could not be prepared.', 'error');
    }
  }

  function renderDirectUpiIntent(intent) {
    $('#paymentSummary').innerHTML = `<div><small>Talk-time</small><strong>${Math.round(intent.seconds / 60)} minutes</strong></div><div class="exact-amount"><small>Pay exactly</small><strong>${P.money(intent.amount_paise)}</strong></div>`;
    $('#manualUpiId').textContent = intent.upi.id;
    $('#manualPayeeName').textContent = intent.upi.payee_name;
    $('#manualUpiQr').src = intent.upi_qr_data_url;
    show('#manualCheckoutPanel');
  }

  function saveUpiQr() {
    const qrImage = $('#manualUpiQr');
    if (!qrImage?.src?.startsWith('data:image/')) {
      P.toast('The payment QR is not ready. Close checkout and try again.', 'error');
      return;
    }
    const reference = currentCheckout?.intent?.checkout_reference || 'payment';
    const download = document.createElement('a');
    download.href = qrImage.src;
    download.download = `we-met-upi-${reference}.png`;
    document.body.append(download);
    download.click();
    download.remove();
    P.toast('QR saved. Open your UPI app and use Scan from gallery.', 'success');
  }

  function previewManualProof(event) {
    const file = event.target.files?.[0];
    if (proofPreviewUrl) URL.revokeObjectURL(proofPreviewUrl);
    proofPreviewUrl = '';
    show('#manualProofPreview', false);
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 3 * 1024 * 1024) {
      event.target.value = '';
      return P.toast('Choose a PNG, JPG, or WebP screenshot no larger than 3 MB.', 'error');
    }
    proofPreviewUrl = URL.createObjectURL(file);
    $('#manualProofImage').src = proofPreviewUrl;
    $('#manualProofName').textContent = `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`;
    show('#manualProofPreview');
  }

  async function submitManualPayment(event) {
    event.preventDefault();
    const intent = currentCheckout?.intent;
    if (!intent) return P.toast('This checkout expired. Start again.', 'error');
    const button = event.submitter;
    button?.setAttribute('disabled', '');
    try {
      const body = new FormData(event.target);
      body.set('intentId', intent.id);
      body.set('paymentMethod', 'upi');
      const response = await P.api('/api/customer/manual-payments/submissions', {
        method: 'POST',
        body,
        timeout: 60000,
      });
      const payment = response.submission;
      currentCheckout = { ...currentCheckout, activePaymentId: payment.id, payment };
      paymentStatusSeen.set(payment.id, payment.status);
      saveActivePayment(payment.id);
      renderPaymentStatus(payment);
      P.toast(response.message || 'UPI payment submitted for verification.', 'success');
      await loadPayments({ silent: true });
    } catch (error) {
      P.toast(error.message || 'The UPI transaction ID could not be submitted.', 'error');
    } finally {
      button?.removeAttribute('disabled');
    }
  }

  function renderPaymentStatus(payment) {
    if (!payment) return;
    currentCheckout = { ...(currentCheckout || {}), activePaymentId: payment.id, payment };
    const status = payment.status || 'created';
    const minutes = Math.round(Number(payment.seconds) / 60);
    currentCheckout.mode = 'upi_direct';
    const details = ({
      pending: {
        title: 'UPI payment submitted — review pending',
        text: 'The administrator will review your submitted UTR and payment screenshot before adding talk-time.',
        note: 'Do not pay again while this submission is pending.',
        icon: '<i></i>',
      },
      approved: {
        title: 'UPI payment verified — minutes added',
        text: `${minutes} minutes have been added to your wallet. You can start a call whenever a listener is available.`,
        note: 'The UPI transaction ID was approved once and cannot credit another wallet entry.',
        icon: '✓',
      },
      declined: {
        title: 'UPI payment was declined',
        text: payment.admin_message || 'The administrator declined the submitted UTR and screenshot.',
        note: 'Check the administrator message. If money was debited, contact support with the correct transaction ID.',
        icon: '!',
      },
    })[status] || null;
    $('#paymentStatusIcon').className = `payment-status-icon ${status}`;
    $('#paymentStatusIcon').innerHTML = details?.icon || '!';
    const waiting = status === 'pending';
    $('#paymentLiveLabel').innerHTML = waiting ? '<i></i> PAYMENT STATUS' : status.toUpperCase();
    $('#paymentStatusTitle').textContent = details?.title || 'Payment status updated';
    $('#paymentStatusText').textContent = details?.text || status;
    $('#paymentWaitNote').textContent = details?.note || '';
    const reference = payment.utr_reference || payment.checkout_reference || `#${String(payment.id).slice(0, 8).toUpperCase()}`;
    $('#pendingPaymentSummary').innerHTML = `<div><small>Pack</small><strong>${P.esc(payment.plan_name || currentCheckout.plan?.name || 'Talk-time pack')}</strong></div><div><small>Minutes</small><strong>${minutes}</strong></div><div><small>Amount</small><strong>${P.money(payment.amount_paise ?? currentCheckout.plan?.price_paise)}</strong></div><div><small>Reference</small><strong>${P.esc(reference)}</strong></div>`;
    const statusMessage = payment.admin_message;
    if (statusMessage) {
      $('#paymentAdminMessage').innerHTML = `<strong>Administrator message</strong><p>${P.esc(statusMessage)}</p>`;
      show('#paymentAdminMessage');
    } else {
      show('#paymentAdminMessage', false);
    }
    show('#checkPaymentNow', waiting);
    show('#paymentEnableAlerts', status === 'approved'
      && publicConfig?.pushEnabled
      && 'Notification' in window
      && Notification.permission === 'default');
    setPaymentStep('status');
  }

  function openPaymentStatus(payment) {
    if (!payment) return;
    const mode = 'upi_direct';
    resetPaymentCheckout(mode);
    currentCheckout = { mode, activePaymentId: payment.id, payment };
    if (payment.status === 'pending') saveActivePayment(payment.id);
    renderPaymentStatus(payment);
    $('#paymentTitle').textContent = 'Payment status';
    $('#paymentEyebrow').textContent = 'UPI VERIFICATION';
    $('#paymentSubtitle').textContent = 'Your submitted UTR and payment screenshot are shown here.';
    openManagedOverlay('#paymentModal', 'paymentModal');
  }

  async function checkPaymentNow(event) {
    const button = event.currentTarget;
    button.setAttribute('disabled', '');
    try {
      await loadPayments({ silent: true });
      P.toast('Payment status is up to date.', 'success');
    } finally {
      button.removeAttribute('disabled');
    }
  }

  function paymentHistoryMarkup(payment) {
    const reference = payment.utr_reference || payment.checkout_reference || '';
    const method = payment.payment_method === 'bank_transfer' ? 'Previous bank transfer' : 'Direct UPI';
    return `<article class="list-item payment-item"><div><strong>${P.esc(payment.plan_name)} · ${P.money(payment.amount_paise)}</strong><p>${Math.round(payment.seconds / 60)} minutes · ${P.esc(method)} · ${P.date(payment.created_at)}</p>${reference ? `<small>Reference: ${P.esc(reference)}</small>` : ''}${payment.admin_message ? `<p><b>Admin:</b> ${P.esc(payment.admin_message)}</p>` : ''}</div><div class="payment-item-side"><span class="badge ${payment.status}">${P.esc(payment.status)}</span><button class="button button-quiet" type="button" data-view-payment="${payment.id}">View status</button></div></article>`;
  }

  async function loadPayments(options = {}) {
    if (!me) return;
    try {
      const manualResponse = await P.api('/api/customer/manual-payments/submissions');
      paymentSubmissions = (manualResponse.submissions || [])
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      let balanceNeedsRefresh = false;
      paymentSubmissions.forEach((payment) => {
        const previous = paymentStatusSeen.get(payment.id);
        if (previous && previous !== payment.status) {
          const paid = payment.status === 'approved';
          P.notify(paid ? 'Payment successful' : 'Payment status updated', paid
            ? `${Math.round(payment.seconds / 60)} minutes were added to your wallet.`
            : `Your ${payment.plan_name} payment was ${payment.status}.`);
          if (paid) balanceNeedsRefresh = true;
        }
        paymentStatusSeen.set(payment.id, payment.status);
      });

      $('#paymentHistory').innerHTML = paymentSubmissions.length
        ? paymentSubmissions.map(paymentHistoryMarkup).join('')
        : emptyState('No payments yet', 'Choose a talk-time pack, pay in a UPI app, and submit its transaction ID.');
      $$('[data-view-payment]').forEach((button) => button.addEventListener('click', () => {
        openPaymentStatus(paymentSubmissions.find((payment) => payment.id === button.dataset.viewPayment));
      }));

      const pending = paymentSubmissions.find((payment) => payment.status === 'pending');
      if (pending) {
        $('#activePaymentBanner').innerHTML = `<div><span class="payment-review-dot"><i></i></span><div><strong>UPI verification pending</strong><p>${P.esc(pending.plan_name)} · ${P.money(pending.amount_paise)} · ${P.date(pending.created_at)}</p></div></div><button id="viewActivePayment" class="button button-soft" type="button">View status</button>`;
        show('#activePaymentBanner');
        $('#viewActivePayment').addEventListener('click', () => openPaymentStatus(pending));
      } else {
        show('#activePaymentBanner', false);
      }

      const activeId = storedActivePayment();
      const activePayment = paymentSubmissions.find((payment) => payment.id === activeId);
      if (activePayment && currentCheckout?.activePaymentId === activePayment.id) renderPaymentStatus(activePayment);
      if (activePayment && activePayment.status !== 'pending') {
        saveActivePayment('');
        if (activePayment.status === 'approved') balanceNeedsRefresh = true;
      }
      if (balanceNeedsRefresh) await refreshCustomerBalance();
    } catch (error) {
      if (!options?.silent) P.toast(error.message, 'error');
    }
  }

  function saveRecovery(value) {
    try { localStorage.setItem('we_met_password_recovery', JSON.stringify(value)); } catch {}
  }

  function restoreRecovery() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('we_met_password_recovery') || 'null'); } catch {}
    if (!saved?.recoveryKey) {
      $('#recoveryRequestId').value = '';
      $('#recoveryKey').value = '';
      $('#recoveryStatus').textContent = 'Already have a recovery key? Paste it below to check the request.';
      show('#resetCompleteForm', false);
      return show('#recoveryPanel');
    }
    $('#recoveryRequestId').value = saved.requestId;
    $('#recoveryKey').value = saved.recoveryKey;
    show('#recoveryPanel');
  }

  async function checkRecovery() {
    try {
      const response = await P.api('/api/auth/password-reset/status', {
        method: 'POST',
        body: JSON.stringify({ requestId: $('#recoveryRequestId').value, recoveryKey: $('#recoveryKey').value.trim() }),
      });
      const request = response.request;
      const labels = {
        open: 'Waiting for administrator review.',
        approved: 'Approved. Enter a new password below.',
        declined: 'Declined. Submit a new request or contact support.',
        completed: 'This recovery request was already used.',
      };
      $('#recoveryStatus').textContent = `${labels[request.status] || request.status}${request.adminMessage ? ` Admin message: ${request.adminMessage}` : ''}`;
      show('#resetCompleteForm', request.status === 'approved');
      saveRecovery({ requestId: request.id, recoveryKey: $('#recoveryKey').value.trim() });
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function completeRecovery(event) {
    event.preventDefault();
    const password = $('#recoveryNewPassword').value;
    if (password !== $('#recoveryConfirmPassword').value) return P.toast('The two passwords do not match.', 'error');
    try {
      const response = await P.api('/api/auth/password-reset/complete', {
        method: 'POST',
        body: JSON.stringify({ requestId: $('#recoveryRequestId').value, recoveryKey: $('#recoveryKey').value.trim(), newPassword: password }),
      });
      localStorage.removeItem('we_met_password_recovery');
      event.target.reset();
      show('#recoveryPanel', false);
      P.toast(response.message, 'success');
      setAuth('login');
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function redeem(event) {
    event.preventDefault();
    const button = event.submitter;
    button?.setAttribute('disabled', '');
    try {
      const response = await P.api('/api/customer/redeem', {
        method: 'POST',
        body: JSON.stringify({ code: $('#couponCode').value }),
      });
      updateBalance(response.balanceSeconds);
      $('#couponCode').value = '';
      P.notify('Code redeemed', `${P.duration(response.seconds)} was added to your wallet.`);
      loadHistory();
    } catch (error) {
      P.toast(error.message, 'error');
    } finally {
      button?.removeAttribute('disabled');
    }
  }

  async function loadSupport() {
    if (!me) return;
    try {
      const response = await P.api('/api/customer/support');
      $('#supportList').innerHTML = response.tickets.length
        ? response.tickets.map((ticket) => `
          <article class="list-item"><div><strong>${P.esc(ticket.subject)}</strong><p>${P.esc(ticket.message)}</p>${ticket.admin_reply ? `<p><b>Admin reply:</b> ${P.esc(ticket.admin_reply)}</p>` : ''}</div><span class="badge ${ticket.status === 'open' ? 'ringing' : 'available'}">${P.esc(ticket.status)}</span></article>`).join('')
        : emptyState('No support messages', 'Messages you send to the admin will appear here.');
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function sendSupport(event) {
    event.preventDefault();
    try {
      await P.api('/api/customer/support', {
        method: 'POST',
        body: JSON.stringify({ subject: $('#supportSubject').value, message: $('#supportMessage').value }),
      });
      event.target.reset();
      P.toast('Your message was sent to the administrator.', 'success');
      loadSupport();
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function changeLogin(event) {
    event.preventDefault();
    try {
      await P.api('/api/auth/change-login', {
        method: 'POST',
        body: JSON.stringify({ newEmail: $('#newEmail').value, currentPassword: $('#emailChangePassword').value }),
      });
      P.toast('Email updated. Please sign in again.', 'success');
      setTimeout(() => logout(), 900);
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function changePhone(event) {
    event.preventDefault();
    const submit = event.submitter;
    submit?.setAttribute('disabled', '');
    try {
      const response = await P.api('/api/auth/change-phone', {
        method: 'POST',
        body: JSON.stringify({
          phone: $('#profilePhone').value,
          currentPassword: $('#phoneChangePassword').value,
        }),
      });
      me.phone = response.phone;
      $('#profilePhone').value = response.phone;
      $('#profilePhoneText').textContent = response.phone;
      $('#phoneChangePassword').value = '';
      P.toast('Contact phone updated.', 'success');
    } catch (error) {
      P.toast(error.message, 'error');
    } finally {
      submit?.removeAttribute('disabled');
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    try {
      await P.api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: $('#currentPassword').value, newPassword: $('#newPassword').value }),
      });
      event.target.reset();
      P.toast('Password updated. All sessions were signed out.', 'success');
      setTimeout(() => logout(), 900);
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function reportCall(id, high = false) {
    const reason = prompt(high ? 'Explain why you want this listener restricted:' : 'Describe the issue you want to report:');
    if (!reason) return;
    try {
      await P.api('/api/customer/reports', {
        method: 'POST',
        body: JSON.stringify({ callId: id, reason, details: reason, priority: high ? 'high' : 'normal' }),
      });
      P.toast('Your report was sent to the administrator.', 'success');
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  function reportCurrent() {
    if (currentCall) reportCall(currentCall.id, false);
  }

  async function loadLegal(type) {
    try {
      const response = await P.api(`/api/public/legal/${type}`);
      $('#legalTitle').textContent = ({ terms: 'Terms and Conditions', privacy: 'Privacy Policy', refund: 'Refund Policy', safety: 'Safety Policy' })[type] || 'Policy';
      $('#legalBody').textContent = response.body;
      openManagedOverlay('#legalModal', 'legalModal');
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  init();
})();
