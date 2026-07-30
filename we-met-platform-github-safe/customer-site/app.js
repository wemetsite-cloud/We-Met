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
  let historyCalls = [];
  let favoriteIds = new Set();
  let activeTab = 'home';

  const show = (selector, visible = true) => $(selector)?.classList.toggle('hidden', !visible);
  const setModalState = () => document.body.classList.toggle('modal-open', Boolean($('.modal:not(.hidden), .call-modal:not(.hidden)')));

  function setAuth(mode) {
    show('#authModal');
    show('#loginForm', mode === 'login');
    show('#registerForm', mode === 'register');
    show('#forgotForm', mode === 'forgot');
    $$('.auth-switch button').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
    $('#authTitle').textContent = mode === 'register' ? 'Create your account' : mode === 'forgot' ? 'Recover your account' : 'Welcome back';
    $('#authSubtitle').textContent = mode === 'register'
      ? 'For people aged 16 and above.'
      : mode === 'forgot'
        ? 'The administrator will review your request.'
        : 'Sign in to continue.';
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
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }

  function bind() {
    $('#openAuth').addEventListener('click', () => setAuth('login'));
    $$('[data-auth]').forEach((button) => button.addEventListener('click', () => setAuth(button.dataset.auth)));
    $$('[data-close]').forEach((button) => button.addEventListener('click', () => {
      show(`#${button.dataset.close}`, false);
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
          dateOfBirth: $('#regDob').value,
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
      await P.api('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ identifier: $('#forgotIdentifier').value }),
      });
      P.toast('Your reset request was sent to the administrator.', 'success');
      event.target.reset();
      setAuth('login');
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
    $('#profileDob').textContent = me.dateOfBirth ? `Date of birth: ${new Date(me.dateOfBirth).toLocaleDateString('en-IN')}` : '';
    updateBalance(me.balanceSeconds);
    connectSocket();
    loadHistory();
    loadSupport();
    loadFavorites();
    loadNotifications();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function logout(clear = true) {
    if (clear) P.Store.clear();
    socket?.disconnect();
    audioCall?.stop();
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
    socket.on('notification:new', (notification) => P.notify(notification.title, notification.body));
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

  function statusText(status) {
    return ({ available: 'Available', busy: 'On a call', break: 'On break', ringing: 'Ringing' })[status] || 'Offline';
  }

  function renderListeners() {
    const available = listeners.filter((listener) => listener.status === 'available').length;
    $('#availabilityText').textContent = available
      ? `${available} listener${available === 1 ? '' : 's'} available now`
      : 'No listener is available right now';

    $('#listenerGrid').innerHTML = listeners.length
      ? listeners.map((listener) => `
        <article class="listener-card">
          <div class="abstract-avatar tone-${listenerTone(listener.id)}">${P.esc(initials(listener.name))}</div>
          <button class="favorite-btn" data-favorite="${listener.id}" title="${favoriteIds.has(listener.id) ? 'Remove favourite' : 'Add favourite'}" aria-label="Favourite listener">${favoriteIds.has(listener.id) ? '♥' : '♡'}</button>
          <div class="listener-meta"><strong>${P.esc(listener.name)}</strong><span class="badge ${listener.status}">${statusText(listener.status)}</span></div>
          <div class="language-line">● Malayalam conversations</div>
          <p>${P.esc(listener.bio || 'A calm listener who is here for a real conversation.')}</p>
          <button class="button ${listener.status === 'available' ? 'button-primary' : 'button-quiet'}" data-call="${listener.id}" ${listener.status !== 'available' ? 'disabled' : ''}>${listener.status === 'available' ? 'Call this listener' : statusText(listener.status)}</button>
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
    socket.emit('chat:send', { callId: currentCall.id, message });
    input.value = '';
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
    $('#plansGrid').innerHTML = plans.map((plan) => `
      <article class="plan-card ${plan.popular ? 'popular' : ''}">
        ${plan.popular ? '<span class="popular-tag">POPULAR</span>' : ''}
        <span>${P.esc(plan.name)}</span><h3>${Math.round(plan.seconds / 60)} min</h3><strong>${P.money(plan.price_paise)}</strong><p>Redeem a matching code issued by We Met support or the administrator.</p>
      </article>`).join('');
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
