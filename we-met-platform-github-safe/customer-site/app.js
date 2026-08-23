(() => {
  'use strict';

  const P = window.Portal;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  window.addEventListener('portal:session-invalid', (event) => {
    P.toast(event.detail?.message || 'Your session expired. Please sign in again.', 'error');
    setTimeout(() => logout(false), 0);
  });

  let me = null;
  let publicConfig = null;
  let socket = null;
  let audioCall = null;
  let currentCall = null;
  let listeners = [];
  let deferredInstallPrompt = null;
  let historyCalls = [];
  let paymentPlans = [];
  let favoriteIds = new Set();
  let activeTab = 'home';
  let serviceWorkerRegistration = null;
  let pushSubscriptionActive = false;
  let otherLanguagesEnabled = localStorage.getItem('we_met_other_languages') === '1';

  const NAVIGATION_MARKER = 'we-met-customer-navigation';
  const VALID_TABS = new Set(['home', 'wallet', 'history', 'favorites', 'notifications', 'support', 'profile']);
  const TAB_PARENT = { favorites: 'history', notifications: 'profile', support: 'profile' };

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
    show('#legalModal', false);
    if (!preserveCall && !$('#callModal')?.classList.contains('hidden')) minimizeCall({ historyMode: 'none' });
    setModalState();
  }

  function closeManagedOverlay(overlay, { historyMode = 'back' } = {}) {
    if (historyMode === 'back' && history.state?.marker === NAVIGATION_MARKER && history.state.overlay === overlay) {
      history.back();
      return;
    }
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
  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      serviceWorkerRegistration = await navigator.serviceWorker.register('service-worker.js?v=7.0.0', { updateViaCache: 'none' });
      return serviceWorkerRegistration;
    } catch {}
  }

  function authFormFor(mode) {
    return mode === 'register' ? $('#registerForm') : mode === 'login' ? $('#loginForm') : null;
  }

  function focusCurrentAuthField() {
    const field = $('#authModal form:not(.hidden) .auth-step.active input:not([type="hidden"])')
      || $('#authModal form:not(.hidden) input:not([type="hidden"])');
    field?.focus({ preventScroll: true });
  }

  function showAuthStep(form, step) {
    if (!form) return;
    const nextStep = Number(step) || 1;
    form.querySelectorAll('.auth-step').forEach((section) => {
      section.classList.toggle('active', Number(section.dataset.authStep) === nextStep);
    });
    form.querySelectorAll('.auth-progress span').forEach((item, index) => {
      item.classList.toggle('active', index < nextStep);
    });
    if (form.dataset.authFlow === 'login' && nextStep === 2) {
      $('#loginEmailPreview').textContent = $('#loginIdentifier').value.trim();
    }
    setTimeout(focusCurrentAuthField, 40);
  }

  function validateAuthStep(section) {
    const fields = [...section.querySelectorAll('input,select,textarea')];
    for (const field of fields) {
      if (!field.checkValidity()) {
        field.reportValidity();
        field.focus();
        return false;
      }
    }
    return true;
  }

  function moveAuthStep(button, direction) {
    const form = button.closest('.auth-flow');
    const current = button.closest('.auth-step');
    if (!form || !current) return;
    if (direction === 'next' && !validateAuthStep(current)) return;
    showAuthStep(form, button.dataset.authNext || button.dataset.authPrev || 1);
  }

  function togglePassword(button) {
    const input = document.getElementById(button.dataset.passwordToggle);
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.textContent = reveal ? 'Hide' : 'Show';
    button.setAttribute('aria-label', `${reveal ? 'Hide' : 'Show'} password`);
    input.focus({ preventScroll: true });
  }

  function setAuth(mode) {
    openManagedOverlay('#authModal', 'authModal');
    show('#loginForm', mode === 'login');
    show('#registerForm', mode === 'register');
    show('#forgotForm', mode === 'forgot');
    $$('.auth-switch button').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
    $('#authTitle').textContent = mode === 'register' ? 'Create your account' : mode === 'forgot' ? 'Recover your account' : 'Welcome back';
    $('#authSubtitle').textContent = mode === 'register'
      ? 'A private account, created one step at a time.'
      : mode === 'forgot'
        ? 'The administrator will review your request.'
        : 'Sign in one simple step at a time.';
    if (mode === 'forgot') restoreRecovery();
    else show('#recoveryPanel', false);
    const form = authFormFor(mode);
    if (form) showAuthStep(form, 1);
    else setTimeout(focusCurrentAuthField, 50);
  }

  async function init() {
    initNavigation();
    bind();
    syncInstallControls();
    registerServiceWorker();
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
    $$('[data-auth-next]').forEach((button) => button.addEventListener('click', () => moveAuthStep(button, 'next')));
    $$('[data-auth-prev]').forEach((button) => button.addEventListener('click', () => moveAuthStep(button, 'previous')));
    $$('[data-password-toggle]').forEach((button) => button.addEventListener('click', () => togglePassword(button)));
    $$('.auth-flow').forEach((form) => form.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.target.matches('button')) return;
      const next = form.querySelector('.auth-step.active [data-auth-next]');
      if (!next) return;
      event.preventDefault();
      next.click();
    }));
    $('#forgotOpen').addEventListener('click', () => setAuth('forgot'));
    $('#backLogin').addEventListener('click', () => setAuth('login'));
    $('#loginForm').addEventListener('submit', login);
    $('#registerForm').addEventListener('submit', register);
    $('#forgotForm').addEventListener('submit', forgot);
    $('#logoutBtn').addEventListener('click', () => logout());
    $('#profileLogout').addEventListener('click', () => logout());
    $('#notificationPermission').addEventListener('click', requestNotifications);
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
    const parentTab = TAB_PARENT[tab] || tab;
    const targetButton = button || $(`[data-tab="${parentTab}"]`);
    $$('#tabs button').forEach((item) => item.classList.toggle('active', item === targetButton));
    $$('.tab').forEach((item) => item.classList.toggle('active', item.id === `tab-${tab}`));
    targetButton?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

    if (tab === 'history' || tab === 'wallet') loadHistory();
    if (tab === 'wallet') {
      loadPlans();
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
      if (response.user.role !== 'customer') throw new Error('This is not a customer account.');
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
    } catch (error) {
      if (P.isAuthError(error)) return;
      P.toast('The server is temporarily unavailable. Your login is still saved; try again shortly.', 'error');
    }
  }

  function enterApp() {
    document.body.classList.add('signed-in');
    show('#landing', false);
    show('#dashboard');
    show('#openAuth', false);
    show('#logoutBtn');
    show('#notificationPermission');
    $('#helloName').textContent = `Hello, ${String(me.name || '').trim().split(/\s+/)[0] || 'there'}`;
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
    me = null;
    pushSubscriptionActive = false;
    currentCall = null;
    document.body.classList.remove('signed-in');
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
      P.toast(data.message || 'No active listener is ready for a call right now. Please refresh shortly.', 'info');
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
    socket.on('call:low-balance', () => P.notify('Low talk-time', 'Only one minute remains.'));
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
      }
      P.notify(notification.title, notification.body);
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
    const avatar = String(listener.avatar || '');
    if (/^avatar-(0[1-9]|1[0-9]|20)\.svg$/.test(avatar)) return `assets/${avatar}`;
    if (avatar === `photo:${listener.id}` || avatar === 'photo') return `${P.base}/api/public/listener-profile-image/${encodeURIComponent(listener.id)}`;
    if (/^data:image\/(?:jpeg|png|webp);base64,/.test(avatar)) return avatar;
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
          <div class="listener-media">
            <div class="abstract-avatar tone-${listenerTone(listener.id)}"><img src="${P.esc(avatarFor(listener))}" alt="${P.esc(listener.name)} profile" loading="lazy"></div>
            <span class="listener-status badge ${P.esc(listener.status)}"><i></i>${statusText(listener.status)}</span>
            <button class="favorite-btn ${favoriteIds.has(listener.id) ? 'saved' : ''}" data-favorite="${P.esc(listener.id)}" title="${favoriteIds.has(listener.id) ? 'Remove favourite' : 'Add favourite'}" aria-label="${favoriteIds.has(listener.id) ? 'Remove from favourites' : 'Add to favourites'}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.7-7.5 1.1-1.1a5.5 5.5 0 0 0 0-7.8Z"/></svg></button>
          </div>
          <div class="listener-body">
            <div class="listener-meta"><strong>${P.esc(listener.name)}</strong><span>${P.esc(listenerLanguage(listener))}</span></div>
            <p>${P.esc(listener.bio || 'A calm listener who is here for a real conversation.')}</p>
            <button class="button ${listener.status === 'available' ? 'button-primary' : 'button-quiet'}" data-call="${P.esc(listener.id)}" ${listener.status !== 'available' ? 'disabled' : ''}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7.1 3.7 4.8 5.2c-.8.5-1.1 1.5-.8 2.4 2 6.4 6 10.4 12.4 12.4.9.3 1.9 0 2.4-.8l1.5-2.3c.4-.7.3-1.6-.3-2.1l-3-2.3c-.6-.5-1.4-.4-2 .1l-1.4 1.4a12 12 0 0 1-3.6-3.6L11.4 9c.5-.6.6-1.4.1-2l-2.3-3c-.5-.6-1.4-.7-2.1-.3Z"/></svg>${listener.status === 'available' ? 'Start voice call' : statusText(listener.status)}</button>
          </div>
        </article>`).join('')
      : emptyState(emptyTitle, emptyMessage);
  }

  function renderListeners() {
    const malayalam = listeners.filter((listener) => listenerLanguage(listener).toLowerCase() === 'malayalam');
    const others = listeners.filter((listener) => listenerLanguage(listener).toLowerCase() !== 'malayalam');
    const malayalamAvailable = malayalam.some((listener) => listener.status === 'available');
    const otherAvailable = others.some((listener) => listener.status === 'available');
    const anyAvailable = malayalamAvailable || otherAvailable;
    const anyoneOnline = listeners.length > 0;

    $('#availabilityText').textContent = anyAvailable
      ? 'Listeners are available now'
      : anyoneOnline
        ? 'Live listener status is updating'
        : 'Listener availability updates live';
    $('.call-hero')?.classList.toggle('has-available', anyAvailable);

    // Hide listener discovery completely when nobody is online.
    // This keeps the customer home clean and avoids showing an empty live-listener section.
    if (!anyoneOnline) {
      show('#listenerDiscovery', false);
      $('#listenerGrid').innerHTML = '';
      $('#otherLanguageGrid').innerHTML = '';
      show('#otherLanguageSection', false);
      return;
    }
    show('#listenerDiscovery', true);

    $('#listenerGrid').innerHTML = listenerCardsMarkup(
      malayalam,
      'Malayalam listener list',
      otherAvailable ? 'Turn on “Suggest other languages” to see another active listener.' : 'Active profiles will appear here as soon as a listener is ready.',
    );
    show('#otherLanguageSection', otherLanguagesEnabled);
    if (otherLanguagesEnabled) {
      $('#otherLanguageGrid').innerHTML = listenerCardsMarkup(others, 'Other-language listener list', 'Active profiles will appear here when another language listener is ready.');
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
    $('#muteBtn').innerHTML = muted
      ? '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m3 3 18 18M9 9v2a3 3 0 0 0 4.7 2.5M15 10V5a3 3 0 0 0-5.6-1.5M5 10a7 7 0 0 0 11.7 5.2M19 10a7 7 0 0 1-.3 2M12 17v4M8 21h8"/></svg><small>Unmute</small>'
      : '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8"/></svg><small>Mute</small>';
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
            <div class="listener-media">
              <div class="abstract-avatar tone-${listenerTone(listener.employee_id)}"><img src="${P.esc(avatarFor({ id: listener.employee_id }))}" alt="${P.esc(listener.name)} profile" loading="lazy"></div>
              <span class="listener-status badge ${P.esc(listener.status || '')}"><i></i>${statusText(listener.status)}</span>
              <button class="favorite-btn saved" data-fav-remove="${P.esc(listener.employee_id)}" aria-label="Remove from favourites"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.7-7.5 1.1-1.1a5.5 5.5 0 0 0 0-7.8Z"/></svg></button>
            </div>
            <div class="listener-body">
              <div class="listener-meta"><strong>${P.esc(listener.name)}</strong><span>${P.esc(listener.listener_language || 'Malayalam')}</span></div>
              <p>${P.esc(listener.bio || 'A calm listener who is here for a real conversation.')}</p>
              <button class="button ${listener.status === 'available' ? 'button-primary' : 'button-quiet'}" data-fav-call="${P.esc(listener.employee_id)}" ${listener.status !== 'available' ? 'disabled' : ''}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7.1 3.7 4.8 5.2c-.8.5-1.1 1.5-.8 2.4 2 6.4 6 10.4 12.4 12.4.9.3 1.9 0 2.4-.8l1.5-2.3c.4-.7.3-1.6-.3-2.1l-3-2.3c-.6-.5-1.4-.4-2 .1l-1.4 1.4a12 12 0 0 1-3.6-3.6L11.4 9c.5-.6.6-1.4.1-2l-2.3-3c-.5-.6-1.4-.7-2.1-.3Z"/></svg>${listener.status === 'available' ? 'Start voice call' : statusText(listener.status)}</button>
            </div>
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
        : emptyState('No talk-time activity', 'Payments, redeemed minutes and call usage will appear here.');

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
    $('#walletPaymentIntro').textContent = 'Tap a pack to pay securely. Verified payments add minutes automatically.';
    $('#plansGrid').innerHTML = plans.map((plan) => `
      <button class="plan-card ${plan.popular ? 'popular' : ''}" type="button" data-buy-plan="${P.esc(plan.id)}" aria-label="Buy ${Math.round(plan.seconds / 60)} minutes for ${P.money(plan.price_paise)}">
        <span class="plan-minutes"><b>${Math.round(plan.seconds / 60)}</b><small>min</small></span>
        <strong class="plan-price">${P.money(plan.price_paise)}</strong>
      </button>`).join('');
    $$('[data-buy-plan]').forEach((button) => button.addEventListener('click', (event) => {
      openPayment(button.dataset.buyPlan, event.currentTarget);
    }));
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

  async function verifyRazorpayCheckout(payment) {
    const body = JSON.stringify({
      razorpay_payment_id: payment.razorpay_payment_id,
      razorpay_order_id: payment.razorpay_order_id,
      razorpay_signature: payment.razorpay_signature,
    });
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await P.api('/api/verify-payment', { method: 'POST', body, timeout: 30000 });
      } catch (error) {
        lastError = error;
        if (error.status !== 425 || attempt === 2) throw error;
        await new Promise((resolve) => window.setTimeout(resolve, 1200 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async function openPayment(planId, button = null) {
    if (!me) {
      P.toast('Sign in before starting a payment.', 'info');
      return setAuth('login');
    }
    const plan = paymentPlans.find((item) => item.id === planId);
    if (!plan) return P.toast('This talk-time pack is unavailable.', 'error');
    if (typeof window.Razorpay !== 'function') {
      return P.toast('Secure checkout could not load. Check your connection and try again.', 'error');
    }

    button?.setAttribute('disabled', '');
    try {
      const order = await P.api('/api/create-order', {
        method: 'POST',
        body: JSON.stringify({
          planId: plan.id,
          amount: Number(plan.price_paise),
          currency: 'INR',
          receipt: `checkout_${Date.now()}`,
        }),
      });

      let paymentHandled = false;
      let paymentFailureShown = false;
      const checkout = new window.Razorpay({
        key: order.key_id,
        amount: order.amount,
        currency: order.currency,
        name: publicConfig?.appName || 'We Met',
        description: `${plan.name} · ${Math.round(Number(plan.seconds) / 60)} minutes`,
        image: new URL('assets/logo.svg', window.location.href).href,
        order_id: order.order_id,
        prefill: {
          name: me.name || '',
          email: me.email || '',
          contact: me.phone || '',
        },
        notes: { plan_id: plan.id },
        theme: { color: '#f0448f' },
        retry: { enabled: true },
        modal: {
          ondismiss: () => {
            button?.removeAttribute('disabled');
            if (!paymentHandled && !paymentFailureShown) {
              P.toast('Payment cancelled. No talk-time was added.', 'info');
            }
          },
        },
        handler: async (payment) => {
          paymentHandled = true;
          try {
            const verified = await verifyRazorpayCheckout(payment);
            updateBalance(verified.balance_seconds);
            await loadHistory();
            P.toast(verified.message || 'Payment verified and talk-time added.', 'success');
          } catch (error) {
            const reference = payment.razorpay_payment_id || 'unavailable';
            P.toast(
              `${error.message || 'Payment verification failed.'} Payment reference: ${reference}`,
              'error',
            );
          } finally {
            button?.removeAttribute('disabled');
          }
        },
      });

      checkout.on('payment.failed', (response) => {
        paymentFailureShown = true;
        const reason = response?.error?.description || response?.error?.reason || 'Payment failed. Try again.';
        P.toast(reason, 'error');
      });
      checkout.open();
    } catch (error) {
      button?.removeAttribute('disabled');
      P.toast(error.message || 'The Razorpay checkout could not be prepared.', 'error');
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
      P.notify('Code redeemed', `${P.duration(response.seconds)} was added to your talk-time.`);
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
