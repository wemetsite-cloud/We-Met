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
  let paymentProofUrl = '';
  let paymentPollTimer = null;
  const paymentStatusSeen = new Map();
  let favoriteIds = new Set();
  let activeTab = 'home';

  const ACTIVE_PAYMENT_KEY = 'we_met_active_payment';

  const show = (selector, visible = true) => $(selector)?.classList.toggle('hidden', !visible);
  const setModalState = () => document.body.classList.toggle('modal-open', Boolean($('.modal:not(.hidden), .call-modal:not(.hidden)')));

  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstallPrompt = event; document.querySelectorAll('[data-install-app]').forEach((b)=>b.classList.remove('hidden')); });
  window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; document.querySelectorAll('[data-install-app]').forEach((b)=>b.classList.add('hidden')); P.toast('We Met installed successfully.', 'success'); });
  async function installApp() {
    if (!deferredInstallPrompt) { P.toast('Use your browser menu and choose Install We Met or Add to Home screen.', 'info'); return; }
    deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null;
  }
  async function registerFreshServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.register('service-worker.js?v=5.4.0', { updateViaCache: 'none' });
      await registration.update();
    } catch {}
  }

  function setAuth(mode) {
    show('#authModal');
    show('#loginForm', mode === 'login');
    show('#registerForm', mode === 'register');
    show('#forgotForm', mode === 'forgot');
    $$('.auth-switch button').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
    $('#authTitle').textContent = mode === 'register' ? 'Create your account' : mode === 'forgot' ? 'Recover your account' : 'Welcome back';
    $('#authSubtitle').textContent = mode === 'register'
      ? 'For people aged 18 and above.'
      : mode === 'forgot'
        ? 'The administrator will review your request.'
        : 'Sign in to continue.';
    if (mode === 'forgot') restoreRecovery();
    else show('#recoveryPanel', false);
    setModalState();
    setTimeout(() => $('#authModal input:not(.hidden)')?.focus(), 50);
  }

  async function init() {
    bind();
    try {
      const [configResponse, plansResponse] = await Promise.all([
        P.api('/api/public/config'),
        P.api('/api/public/plans'),
      ]);
      publicConfig = configResponse;
      renderPlans(plansResponse.plans);
    } catch (error) {
      P.toast(error.message, 'error');
    }

    if (P.Store.token) await loadMe();
    registerFreshServiceWorker();
  }

  function bind() {
    document.addEventListener('click', (e) => { if (e.target.closest('[data-install-app]')) installApp(); });
    $('#openAuth').addEventListener('click', () => setAuth('login'));
    $$('[data-auth]').forEach((button) => button.addEventListener('click', () => setAuth(button.dataset.auth)));
    $$('[data-close]').forEach((button) => button.addEventListener('click', () => {
      show(`#${button.dataset.close}`, false);
      if (button.dataset.close === 'paymentModal') resetPaymentCheckout();
      setModalState();
    }));
    $$('.auth-switch button').forEach((button) => button.addEventListener('click', () => setAuth(button.dataset.mode)));
    $('#forgotOpen').addEventListener('click', () => setAuth('forgot'));
    $('#backLogin').addEventListener('click', () => setAuth('login'));
    $('#loginForm').addEventListener('submit', login);
    $('#registerForm').addEventListener('submit', register);
    $('#forgotForm').addEventListener('submit', forgot);
    $('#logoutBtn').addEventListener('click', () => logout());
    $('#notificationPermission').addEventListener('click', requestNotifications);
    $('#tabs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-tab]');
      if (button) selectTab(button.dataset.tab, button);
    });
    $$('[data-jump]').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.jump)));
    $('#callNow').addEventListener('click', () => requestCall());
    $('#refreshListeners').addEventListener('click', () => socket?.emit('listeners:get'));
    $('#couponForm').addEventListener('submit', redeem);
    $('#paymentForm').addEventListener('submit', submitPayment);
    $('#refreshPayments').addEventListener('click', loadPayments);
    $('#copyUpi').addEventListener('click', () => copyValue(currentCheckout?.payeeUpiId || publicConfig?.paymentUpiId || 'salahkpsite@slc', 'UPI ID copied.'));
    $('#paymentPaidNext').addEventListener('click', () => setPaymentStep('upload'));
    $('#backToPayment').addEventListener('click', () => setPaymentStep('pay'));
    $('#paymentProof').addEventListener('change', previewPaymentProof);
    $('#payGooglePay').addEventListener('click', paymentAppOpened);
    $('#openUpiApp').addEventListener('click', paymentAppOpened);
    $('#checkPaymentNow').addEventListener('click', checkPaymentNow);
    $('#paymentBackWallet').addEventListener('click', () => {
      closePaymentCheckout();
      selectTab('wallet');
    });
    $('#copyRecoveryKey').addEventListener('click', () => copyValue($('#recoveryKey').value, 'Recovery key copied.'));
    $('#checkRecovery').addEventListener('click', checkRecovery);
    $('#resetCompleteForm').addEventListener('submit', completeRecovery);
    $('#supportForm').addEventListener('submit', sendSupport);
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
        show('#authModal', false);
        setModalState();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (me && document.visibilityState === 'visible') loadPayments({ silent: true });
    });
  }

  async function requestNotifications() {
    if (!('Notification' in window)) return P.toast('Browser notifications are not supported on this device.', 'error');
    const permission = await Notification.requestPermission();
    P.toast(permission === 'granted' ? 'Notifications are enabled.' : 'Notification permission was not enabled.', permission === 'granted' ? 'success' : 'info');
  }

  function selectTab(tab, button = null) {
    activeTab = tab;
    const targetButton = button || $(`[data-tab="${tab}"]`);
    $$('#tabs button').forEach((item) => item.classList.toggle('active', item === targetButton));
    $$('.tab').forEach((item) => item.classList.toggle('active', item.id === `tab-${tab}`));
    targetButton?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

    if (tab === 'history' || tab === 'wallet') loadHistory();
    if (tab === 'wallet') loadPayments();
    if (tab === 'favorites') loadFavorites();
    if (tab === 'notifications') loadNotifications();
    if (tab === 'support') loadSupport();

    const top = $('#dashboard').getBoundingClientRect().top + window.scrollY - 74;
    if (window.scrollY > top + 120) window.scrollTo({ top, behavior: 'smooth' });
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
      show('#authModal', false);
      setModalState();
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
          password: $('#regPassword').value,
          termsAccepted: $('#regTerms').checked,
        }),
      });
      P.Store.token = response.token;
      me = response.user;
      show('#authModal', false);
      setModalState();
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
    $('#helloName').textContent = `Hello, ${me.name}`;
    $('#profileName').textContent = me.name;
    $('#profileEmail').textContent = me.email || '—';
    updateBalance(me.balanceSeconds);
    connectSocket();
    loadHistory();
    loadSupport();
    loadFavorites();
    loadNotifications();
    loadPayments();
    startPaymentPolling();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function logout(clear = true) {
    if (clear) P.Store.clear();
    socket?.disconnect();
    audioCall?.stop();
    clearInterval(paymentPollTimer);
    paymentPollTimer = null;
    resetPaymentCheckout();
    me = null;
    currentCall = null;
    show('#landing');
    show('#dashboard', false);
    show('#openAuth');
    show('#logoutBtn', false);
    show('#callModal', false);
    show('#restoreCall', false);
    setModalState();
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
      reconnectionAttempts: 8,
    });

    audioCall = new AudioCall({
      socket,
      iceServers: publicConfig?.iceServers || [],
      remoteAudio: $('#remoteAudio'),
      onState: (state) => {
        if (!currentCall) return;
        if (state === 'connected' && !currentCall.mediaReady) {
          currentCall.mediaReady = true;
          socket.emit('call:media-ready', { callId: currentCall.id });
        }
        if (state === 'connected' && currentCall.mediaConnected !== true) {
          currentCall.mediaConnected = true;
          socket.emit('call:media-state', { callId: currentCall.id, connected: true });
        }
        if (['failed', 'disconnected'].includes(state)) {
          $('#callState').textContent = 'Audio paused while the connection recovers…';
          if (currentCall.mediaConnected !== false) {
            currentCall.mediaConnected = false;
            socket.emit('call:media-state', { callId: currentCall.id, connected: false });
          }
        }
      },
    });

    socket.on('connect', () => socket.emit('listeners:get'));
    socket.on('connect_error', (error) => P.toast(error.message || 'Could not connect to the calling server.', 'error'));
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
    });
    socket.on('call:error', (data) => {
      closeCall();
      P.toast(data.message || 'The call could not be started.', 'error');
      if (data.needsTopup) selectTab('wallet');
    });
    socket.on('call:accepted', async (data) => {
      if (!currentCall) currentCall = { id: data.callId };
      currentCall.status = 'connecting';
      $('#callState').textContent = 'Connecting secure audio…';
      try {
        await audioCall.start(data.callId, data.initiatorId === me.id);
      } catch (error) {
        P.toast(error.message || 'Please allow microphone access.', 'error');
        socket.emit('call:end', { callId: data.callId });
      }
    });
    socket.on('call:connected', () => {
      if (!currentCall) return;
      currentCall.status = 'active';
      $('#callState').textContent = 'Connected · billing is active';
      P.notify('We Met', 'Your Malayalam listener is connected.');
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
      if (needsTopup) selectTab('wallet');
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

  function renderListeners() {
    const available = listeners.filter((listener) => listener.status === 'available').length;
    $('#availabilityText').textContent = available
      ? `${available} listener${available === 1 ? '' : 's'} available now`
      : 'No listener is available right now';

    $('#listenerGrid').innerHTML = listeners.length
      ? listeners.map((listener) => `
        <article class="listener-card">
          <div class="abstract-avatar tone-${listenerTone(listener.id)}"><img src="${P.esc(avatarFor(listener))}" alt="" loading="lazy"></div>
          <button class="favorite-btn" data-favorite="${listener.id}" title="${favoriteIds.has(listener.id) ? 'Remove favourite' : 'Add favourite'}" aria-label="Favourite listener">${favoriteIds.has(listener.id) ? '♥' : '♡'}</button>
          <div class="listener-meta"><strong>${P.esc(listener.name)}</strong><span class="badge ${listener.status}">${statusText(listener.status)}</span></div>
          <div class="language-line">● Malayalam conversations</div>
          <p>${P.esc(listener.bio || 'A calm listener who is here for a real conversation.')}</p>
          <button class="button ${listener.status === 'available' && !listener.demo ? 'button-primary' : 'button-quiet'}" data-call="${listener.id}" ${listener.status !== 'available' || listener.demo ? 'disabled' : ''}>${listener.demo ? 'Demo listener' : (listener.status === 'available' ? 'Call this listener' : statusText(listener.status))}</button>
        </article>`).join('')
      : emptyState('No listeners online', 'Ask a listener to go online, then refresh this page.');

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
      return selectTab('wallet');
    }
    if (currentCall) return P.toast('You already have a call in progress.', 'error');
    socket.emit('call:request', { employeeId });
  }

  function openCall() {
    show('#callModal');
    show('#restoreCall', false);
    setModalState();
    $('#callPerson').textContent = currentCall.employee?.name || 'Listener';
    $('#callBio').textContent = currentCall.employee?.bio || 'A private Malayalam conversation';
    $('#callTimer').textContent = '0:00';
    $('#restoreTimer').textContent = '0:00';
    $('#chatMessages').innerHTML = '<div class="bubble">Your private text chat starts here.</div>';
    updateBalance(me.balanceSeconds);
  }

  function minimizeCall() {
    if (!currentCall) return;
    show('#callModal', false);
    show('#restoreCall');
    setModalState();
  }

  function restoreCall() {
    if (!currentCall) return;
    show('#callModal');
    show('#restoreCall', false);
    setModalState();
  }

  function closeCall() {
    show('#callModal', false);
    show('#restoreCall', false);
    audioCall?.stop();
    currentCall = null;
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
            <div class="language-line">● Malayalam conversations</div>
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

  function renderPlans(plans = []) {
    paymentPlans = plans;
    $('#plansGrid').innerHTML = plans.map((plan) => `
      <article class="plan-card ${plan.popular ? 'popular' : ''}">
        ${plan.popular ? '<span class="popular-tag">POPULAR</span>' : ''}
        <span>${P.esc(plan.name)}</span><h3>${Math.round(plan.seconds / 60)} min</h3><strong>${P.money(plan.price_paise)}</strong><p>Pay with GPay or any UPI app, then send your screenshot for approval.</p><button class="button button-primary" type="button" data-buy-plan="${plan.id}">Purchase pack</button>
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

  function setPaymentStep(step) {
    const order = ['pay', 'upload', 'status'];
    const activeIndex = order.indexOf(step);
    $$('[data-payment-step]').forEach((section) => section.classList.toggle('hidden', section.dataset.paymentStep !== step));
    $$('[data-payment-progress]').forEach((item) => {
      const index = order.indexOf(item.dataset.paymentProgress);
      item.classList.toggle('active', index === activeIndex);
      item.classList.toggle('complete', index < activeIndex || (step === 'status' && currentCheckout?.payment?.status === 'approved'));
    });
  }

  function resetPaymentProof() {
    if (paymentProofUrl) URL.revokeObjectURL(paymentProofUrl);
    paymentProofUrl = '';
    show('#paymentProofPreview', false);
    $('#paymentProofImage').removeAttribute('src');
    $('#paymentProofName').textContent = 'Screenshot selected';
  }

  function resetPaymentCheckout() {
    resetPaymentProof();
    $('#paymentForm')?.reset();
    currentCheckout = null;
    show('#paymentPayContent', false);
    show('#paymentLoading');
    setPaymentStep('pay');
  }

  function closePaymentCheckout() {
    show('#paymentModal', false);
    resetPaymentCheckout();
    setModalState();
  }

  function paymentAppOpened() {
    setTimeout(() => {
      if (!$('#paymentModal').classList.contains('hidden') && currentCheckout && !currentCheckout.activePaymentId) {
        setPaymentStep('upload');
      }
    }, 450);
  }

  function previewPaymentProof() {
    resetPaymentProof();
    const file = $('#paymentProof').files[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      $('#paymentProof').value = '';
      return P.toast('Choose a PNG, JPEG or WebP screenshot.', 'error');
    }
    if (file.size > 5 * 1024 * 1024) {
      $('#paymentProof').value = '';
      return P.toast('The screenshot must be 5 MB or smaller.', 'error');
    }
    paymentProofUrl = URL.createObjectURL(file);
    $('#paymentProofImage').src = paymentProofUrl;
    $('#paymentProofName').textContent = file.name;
    show('#paymentProofPreview');
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
      P.toast('Sign in before submitting a payment.', 'info');
      return setAuth('login');
    }
    const plan = paymentPlans.find((item) => item.id === planId);
    if (!plan) return P.toast('This talk-time pack is unavailable.', 'error');
    resetPaymentCheckout();
    currentCheckout = { plan };
    $('#paymentPlanId').value = plan.id;
    $('#paymentTitle').textContent = `${plan.name} checkout`;
    show('#paymentModal');
    setModalState();
    setPaymentStep('pay');
    try {
      const checkout = await P.api(`/api/public/payment-checkout/${encodeURIComponent(plan.id)}`);
      if (!currentCheckout || currentCheckout.plan.id !== plan.id) return;
      currentCheckout = { ...checkout, plan: checkout.plan || plan };
      const exactPlan = currentCheckout.plan;
      $('#paymentPlanId').value = exactPlan.id;
      $('#paymentSummary').innerHTML = `<div><small>Pack</small><strong>${P.esc(exactPlan.name)}</strong></div><div><small>Talk-time</small><strong>${Math.round(exactPlan.seconds / 60)} minutes</strong></div><div class="exact-amount"><small>Pay exactly</small><strong>${P.money(exactPlan.price_paise)}</strong></div>`;
      $('#paymentUpiId').textContent = checkout.payeeUpiId;
      $('#paymentSafeUpi').textContent = checkout.payeeUpiId;
      $('#paymentPayeeName').textContent = checkout.payeeName;
      $('#paymentQrAmount').textContent = `Pay exactly ${P.money(exactPlan.price_paise)}`;
      $('#paymentQr').src = checkout.qrDataUrl;
      $('#payGooglePay').href = /iPad|iPhone|iPod/i.test(navigator.userAgent)
        ? (checkout.googlePayIosUrl || checkout.googlePayUrl)
        : checkout.googlePayUrl;
      $('#openUpiApp').href = checkout.upiUrl;
      show('#paymentLoading', false);
      show('#paymentPayContent');
    } catch (error) {
      closePaymentCheckout();
      P.toast(error.message || 'The payment checkout could not be prepared.', 'error');
    }
  }

  async function submitPayment(event) {
    event.preventDefault();
    const button = event.submitter;
    const file = $('#paymentProof').files[0];
    if (!file) return P.toast('Choose the successful-payment screenshot.', 'error');
    if (file.size > 5 * 1024 * 1024) return P.toast('The screenshot must be 5 MB or smaller.', 'error');
    button?.setAttribute('disabled', '');
    try {
      const form = new FormData(event.target);
      const response = await P.api('/api/customer/payments', { method: 'POST', body: form, timeout: 60000 });
      event.target.reset();
      resetPaymentProof();
      currentCheckout = { ...(currentCheckout || {}), activePaymentId: response.payment.id, payment: response.payment };
      paymentStatusSeen.set(response.payment.id, response.payment.status);
      saveActivePayment(response.payment.id);
      renderPaymentStatus(response.payment);
      P.toast(response.message || 'Payment proof submitted.', 'success');
      loadPayments({ silent: true });
    } catch (error) {
      P.toast(error.message, 'error');
    } finally {
      button?.removeAttribute('disabled');
    }
  }

  function renderPaymentStatus(payment) {
    if (!payment) return;
    currentCheckout = { ...(currentCheckout || {}), activePaymentId: payment.id, payment };
    const status = payment.status || 'pending';
    const minutes = Math.round(Number(payment.seconds) / 60);
    const details = {
      pending: {
        title: 'Waiting for administrator approval',
        text: 'Your screenshot was sent successfully. This screen updates automatically after the administrator approves or declines it.',
        note: 'You can safely go back and use the rest of the site. Your wallet and this payment status will update automatically.',
        icon: '<i></i>',
      },
      approved: {
        title: 'Payment approved — minutes added',
        text: `${minutes} minutes have been added to your wallet. You can start a call whenever a listener is available.`,
        note: 'Your wallet balance has been refreshed. Each approved payment can be credited only once.',
        icon: '✓',
      },
      declined: {
        title: 'Payment was not approved',
        text: 'The administrator could not verify this payment. Read the message below, then submit a new proof or contact support if needed.',
        note: 'No minutes were added for this submission.',
        icon: '!',
      },
    }[status] || null;
    $('#paymentStatusIcon').className = `payment-status-icon ${status}`;
    $('#paymentStatusIcon').innerHTML = details?.icon || '!';
    $('#paymentLiveLabel').innerHTML = status === 'pending' ? '<i></i> LIVE STATUS' : status.toUpperCase();
    $('#paymentStatusTitle').textContent = details?.title || 'Payment status updated';
    $('#paymentStatusText').textContent = details?.text || status;
    $('#paymentWaitNote').textContent = details?.note || '';
    $('#pendingPaymentSummary').innerHTML = `<div><small>Pack</small><strong>${P.esc(payment.plan_name || currentCheckout.plan?.name || 'Talk-time pack')}</strong></div><div><small>Minutes</small><strong>${minutes}</strong></div><div><small>Amount</small><strong>${P.money(payment.amount_paise ?? currentCheckout.plan?.price_paise)}</strong></div><div><small>Reference</small><strong>${P.esc(payment.utr_reference || `#${String(payment.id).slice(0, 8).toUpperCase()}`)}</strong></div>`;
    if (payment.admin_message) {
      $('#paymentAdminMessage').innerHTML = `<strong>Message from administrator</strong><p>${P.esc(payment.admin_message)}</p>`;
      show('#paymentAdminMessage');
    } else {
      show('#paymentAdminMessage', false);
    }
    show('#checkPaymentNow', status === 'pending');
    setPaymentStep('status');
  }

  function openPaymentStatus(payment) {
    if (!payment) return;
    resetPaymentCheckout();
    currentCheckout = { activePaymentId: payment.id, payment };
    if (payment.status === 'pending') saveActivePayment(payment.id);
    renderPaymentStatus(payment);
    $('#paymentTitle').textContent = 'Payment verification';
    show('#paymentModal');
    setModalState();
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
    return `<article class="list-item payment-item"><div><strong>${P.esc(payment.plan_name)} · ${P.money(payment.amount_paise)}</strong><p>${Math.round(payment.seconds / 60)} minutes · submitted ${P.date(payment.created_at)}</p>${payment.utr_reference ? `<small>UTR: ${P.esc(payment.utr_reference)}</small>` : ''}${payment.admin_message ? `<p><b>Admin message:</b> ${P.esc(payment.admin_message)}</p>` : ''}</div><div class="payment-item-side"><span class="badge ${payment.status}">${P.esc(payment.status)}</span><button class="button button-quiet" type="button" data-view-payment="${payment.id}">View status</button></div></article>`;
  }

  async function loadPayments(options = {}) {
    if (!me) return;
    try {
      const response = await P.api('/api/customer/payments');
      paymentSubmissions = response.payments || [];
      let balanceNeedsRefresh = false;
      paymentSubmissions.forEach((payment) => {
        const previous = paymentStatusSeen.get(payment.id);
        if (previous && previous !== payment.status) {
          const approved = payment.status === 'approved';
          P.notify(approved ? 'Payment approved' : 'Payment status updated', approved
            ? `${Math.round(payment.seconds / 60)} minutes were added to your wallet.`
            : `Your ${payment.plan_name} payment was ${payment.status}.`);
          if (approved) balanceNeedsRefresh = true;
        }
        paymentStatusSeen.set(payment.id, payment.status);
      });

      $('#paymentHistory').innerHTML = paymentSubmissions.length
        ? paymentSubmissions.map(paymentHistoryMarkup).join('')
        : emptyState('No payment submissions', 'Choose a talk-time pack, pay by UPI, and upload the payment screenshot here.');
      $$('[data-view-payment]').forEach((button) => button.addEventListener('click', () => {
        openPaymentStatus(paymentSubmissions.find((payment) => payment.id === button.dataset.viewPayment));
      }));

      const pending = paymentSubmissions.find((payment) => payment.status === 'pending');
      if (pending) {
        $('#activePaymentBanner').innerHTML = `<div><span class="payment-review-dot"><i></i></span><div><strong>Payment verification in progress</strong><p>${P.esc(pending.plan_name)} · ${P.money(pending.amount_paise)} · submitted ${P.date(pending.created_at)}</p></div></div><button id="viewActivePayment" class="button button-soft" type="button">View live status</button>`;
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

  async function changePassword(event) {
    event.preventDefault();
    try {
      await P.api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: $('#currentPassword').value, newPassword: $('#newPassword').value }),
      });
      event.target.reset();
      P.toast('Password updated.', 'success');
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
      show('#legalModal');
      setModalState();
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  init();
})();
