(() => {
  'use strict';

  const P = window.Portal;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const show = (selector, visible = true) => $(selector)?.classList.toggle('hidden', !visible);

  let me = null;
  let socket = null;
  let audioCall = null;
  let currentCall = null;
  let status = 'offline';
  let ringContext = null;
  let ringToneTimer = null;
  let ringCountdown = null;
  let ringSecondsLeft = 30;
  let publicConfig = null;
  let activeTab = 'desk';
  let statsRefreshTimer = null;

  const NAVIGATION_MARKER = 'we-met-listener-navigation';
  const VALID_TABS = new Set(['desk', 'history', 'profile', 'notifications']);

  function navigationState(tab = activeTab, overlay = null) {
    return { marker: NAVIGATION_MARKER, tab: VALID_TABS.has(tab) ? tab : 'desk', overlay };
  }

  function currentOverlay() {
    if (!$('#recoveryModal')?.classList.contains('hidden')) return 'recoveryModal';
    if (!$('#incomingModal')?.classList.contains('hidden')) return 'incomingModal';
    if (!$('#callView')?.classList.contains('hidden')) return 'callView';
    return null;
  }

  function syncBackButton() {
    $('#listenerBackButton')?.classList.toggle('hidden', !(currentOverlay() || (me && activeTab !== 'desk')));
  }

  function setNavigationState({ tab = activeTab, overlay = null } = {}, mode = 'push') {
    const state = navigationState(tab, overlay);
    if (mode === 'replace') history.replaceState(state, document.title);
    else history.pushState(state, document.title);
    syncBackButton();
  }

  function openManagedOverlay(selector, overlay, mode = 'push') {
    const opening = $(selector)?.classList.contains('hidden');
    show(selector);
    if (opening) setNavigationState({ overlay }, mode);
    syncBackButton();
  }

  function closeManagedOverlay(overlay, mode = 'back') {
    if (mode === 'back' && history.state?.marker === NAVIGATION_MARKER && history.state.overlay === overlay) {
      history.back();
      return;
    }
    show(`#${overlay}`, false);
    setNavigationState({ overlay: null }, 'replace');
    syncBackButton();
  }

  function minimizeListenerCall(mode = 'back') {
    if (!currentCall) return;
    if (mode === 'back' && history.state?.overlay === 'callView') {
      history.back();
      return;
    }
    show('#callView', false);
    show('#restoreListenerCall');
    syncBackButton();
  }

  function restoreListenerCall() {
    if (!currentCall) return;
    openManagedOverlay('#callView', 'callView');
    show('#restoreListenerCall', false);
  }

  function goBackInListener() {
    if (currentOverlay() || activeTab !== 'desk') history.back();
  }

  function initNavigation() {
    history.replaceState(navigationState('desk', null), document.title);
    window.addEventListener('popstate', (event) => {
      const previousOverlay = currentOverlay();
      const state = event.state?.marker === NAVIGATION_MARKER
        ? event.state
        : navigationState('desk', null);
      if (previousOverlay === 'incomingModal' && currentCall) {
        socket?.emit('call:reject', { callId: currentCall.id });
        stopRing();
      }
      if (previousOverlay === 'callView' && currentCall) minimizeListenerCall('none');
      else show('#callView', false);
      show('#incomingModal', false);
      show('#recoveryModal', false);
      if (me) selectTab(state.tab, { historyMode: 'none' });
      syncBackButton();
    });
  }

  async function registerFreshServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.register('service-worker.js?v=6.0.0', { updateViaCache: 'none' });
      await registration.update();
    } catch {}
  }

  function bind() {
    $('#loginForm').addEventListener('submit', login);
    $('#forgotBtn').addEventListener('click', openRecovery);
    $('#closeRecovery').addEventListener('click', () => closeManagedOverlay('recoveryModal'));
    $('#listenerRecoveryBack').addEventListener('click', goBackInListener);
    $('#recoveryRequestForm').addEventListener('submit', requestRecovery);
    $('#employeeCheckRecovery').addEventListener('click', checkRecovery);
    $('#employeeCopyRecovery').addEventListener('click', () => copyValue($('#employeeRecoveryKey').value));
    $('#employeeResetForm').addEventListener('submit', completeRecovery);
    $('#logoutBtn').addEventListener('click', logout);
    $('#listenerBackButton').addEventListener('click', goBackInListener);
    $$('[data-tab]').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.tab)));
    $('#onlineBtn').addEventListener('click', goOnline);
    $('#offlineBtn').addEventListener('click', () => sendAvailabilityCommand('employee:offline').catch((error) => P.toast(error.message, 'error')));
    $('#breakBtn').addEventListener('click', () => sendAvailabilityCommand('employee:break', { enabled: status !== 'break' }).catch((error) => P.toast(error.message, 'error')));
    $('#acceptBtn').addEventListener('click', accept);
    $('#rejectBtn').addEventListener('click', () => socket?.emit('call:reject', { callId: currentCall?.id }));
    $('#endBtn').addEventListener('click', () => socket?.emit('call:end', { callId: currentCall?.id }));
    $('#muteBtn').addEventListener('click', toggleMute);
    $('#reportBtn').addEventListener('click', reportCurrent);
    $('#chatForm').addEventListener('submit', sendChat);
    $('#profileForm').addEventListener('submit', saveProfile);
    $('#passwordForm').addEventListener('submit', changePassword);
    $('#employeeEmailForm').addEventListener('submit', changeEmail);
    $('#refreshHistory').addEventListener('click', loadHistory);
    $('#refreshActivity').addEventListener('click', () => { loadStats(); loadActivity(); });
    $('#minimizeListenerCall').addEventListener('click', () => minimizeListenerCall());
    $('#restoreListenerCall').addEventListener('click', restoreListenerCall);
  }

  async function init() {
    initNavigation();
    bind();
    await registerFreshServiceWorker();
    try { publicConfig = await P.api('/api/public/config'); } catch {}
    ringSecondsLeft = publicConfig?.ringSeconds || 30;
    if (P.Store.token) await loadMe();
  }

  function selectTab(tab, { historyMode = 'push' } = {}) {
    if (!VALID_TABS.has(tab)) tab = 'desk';
    if (activeTab !== tab && historyMode === 'push') setNavigationState({ tab, overlay: null });
    activeTab = tab;
    const button = $(`[data-tab="${tab}"]`);
    $$('[data-tab]').forEach((item) => item.classList.toggle('active', item === button));
    $$('.tab').forEach((item) => item.classList.toggle('active', item.id === `tab-${tab}`));
    button?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    if (tab === 'history') loadHistory();
    if (tab === 'notifications') loadNotifications();
    if (tab === 'desk') { loadStats(); loadActivity(); }
    syncBackButton();
  }

  async function login(event) {
    event.preventDefault();
    const button = event.submitter;
    button?.setAttribute('disabled', '');
    try {
      const response = await P.api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: $('#loginEmail').value, password: $('#loginPassword').value }),
      });
      if (response.user.role !== 'employee') throw new Error('This is not a listener account.');
      P.Store.token = response.token;
      me = response.user;
      enter();
    } catch (error) {
      P.toast(error.message, 'error');
    } finally {
      button?.removeAttribute('disabled');
    }
  }

  function recoveryStorage(value) {
    if (value === undefined) {
      try { return JSON.parse(localStorage.getItem('we_met_employee_password_recovery') || 'null'); } catch { return null; }
    }
    try {
      if (value) localStorage.setItem('we_met_employee_password_recovery', JSON.stringify(value));
      else localStorage.removeItem('we_met_employee_password_recovery');
    } catch {}
    return value;
  }

  function openRecovery() {
    const saved = recoveryStorage();
    if (saved?.recoveryKey) {
      $('#employeeRecoveryId').value = saved.requestId;
      $('#employeeRecoveryKey').value = saved.recoveryKey;
      show('#employeeRecoveryPanel');
    } else {
      $('#employeeRecoveryId').value = '';
      $('#employeeRecoveryKey').value = '';
      $('#employeeRecoveryStatus').textContent = 'Already have a recovery key? Paste it below to check the request.';
      show('#employeeResetForm', false);
      show('#employeeRecoveryPanel');
    }
    openManagedOverlay('#recoveryModal', 'recoveryModal');
  }

  async function goOnline() {
    try {
      await sendAvailabilityCommand('employee:online');
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function requestRecovery(event) {
    event.preventDefault();
    try {
      const response = await P.api('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ identifier: $('#recoveryEmail').value }),
      });
      if (response.requestId && response.recoveryKey) {
        recoveryStorage({ requestId: response.requestId, recoveryKey: response.recoveryKey });
        $('#employeeRecoveryId').value = response.requestId;
        $('#employeeRecoveryKey').value = response.recoveryKey;
        $('#employeeRecoveryStatus').textContent = 'Request sent. Save this key and check again after administrator review.';
        show('#employeeRecoveryPanel');
        show('#employeeResetForm', false);
      }
      P.toast(response.message || 'Recovery request sent.', 'success');
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function copyValue(value) {
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) await navigator.clipboard.writeText(value);
      else {
        const area = document.createElement('textarea');
        area.value = value;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      P.toast('Recovery key copied.', 'success');
    } catch {
      P.toast('Copy failed. Select and copy the key manually.', 'error');
    }
  }

  async function checkRecovery() {
    try {
      const response = await P.api('/api/auth/password-reset/status', {
        method: 'POST',
        body: JSON.stringify({ requestId: $('#employeeRecoveryId').value, recoveryKey: $('#employeeRecoveryKey').value.trim() }),
      });
      const request = response.request;
      const labels = { open: 'Waiting for administrator review.', approved: 'Approved. Enter a new password below.', declined: 'Declined. Contact the administrator or submit a new request.', completed: 'This recovery request was already used.' };
      $('#employeeRecoveryStatus').textContent = `${labels[request.status] || request.status}${request.adminMessage ? ` Admin message: ${request.adminMessage}` : ''}`;
      show('#employeeResetForm', request.status === 'approved');
      recoveryStorage({ requestId: request.id, recoveryKey: $('#employeeRecoveryKey').value.trim() });
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function completeRecovery(event) {
    event.preventDefault();
    const password = $('#employeeRecoveryPassword').value;
    if (password !== $('#employeeRecoveryConfirm').value) return P.toast('The two passwords do not match.', 'error');
    try {
      const response = await P.api('/api/auth/password-reset/complete', {
        method: 'POST',
        body: JSON.stringify({ requestId: $('#employeeRecoveryId').value, recoveryKey: $('#employeeRecoveryKey').value.trim(), newPassword: password }),
      });
      recoveryStorage(null);
      closeManagedOverlay('recoveryModal');
      P.toast(response.message, 'success');
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function loadMe() {
    try {
      const response = await P.api('/api/auth/me');
      if (response.user.role !== 'employee') throw new Error('Wrong account type.');
      me = response.user;
      enter();
    } catch {
      P.Store.clear();
    }
  }

  function enter() {
    show('#loginView', false);
    show('#appView');
    $('#hello').textContent = `Hello, ${me.name}`;
    $('#profileName').value = me.name || '';
    $('#profileUsername').value = me.username || '';
    $('#profileEmail').value = me.email || '';
    $('#profilePhone').value = me.phone || '';
    $('#profileUpi').value = me.upiId || '';
    $('#profileBio').value = me.bio || '';
    $('#profileCode').value = me.employeeCode || '';
    $('#profileLanguage').value = me.listenerLanguage || 'Malayalam';
    $('#deskLanguage').textContent = `${me.listenerLanguage || 'Malayalam'} calls`;
    connect();
    loadStats();
    loadActivity();
    loadHistory();
    loadNotifications();
    clearInterval(statsRefreshTimer);
    statsRefreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && activeTab === 'desk') loadStats();
    }, 30_000);
    syncBackButton();
  }

  function sendAvailabilityCommand(event, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!socket?.connected) return reject(new Error('Reconnect before changing availability.'));
      socket.timeout(8000).emit(event, payload, (error, response) => {
        if (error) return reject(new Error('Availability could not be saved. Try again.'));
        if (!response?.ok) return reject(new Error(response?.error || 'Availability could not be saved. Try again.'));
        resolve(response);
      });
    });
  }

  async function logout() {
    await sendAvailabilityCommand('employee:offline').catch(() => null);
    socket?.disconnect();
    audioCall?.stop();
    stopRing();
    ringContext?.close().catch(() => {});
    ringContext = null;
    P.Store.clear();
    clearInterval(statsRefreshTimer);
    location.reload();
  }

  async function connect() {
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

    socket.on('connect', () => {
      $('#connectionBadge').textContent = 'Connected';
      $('#connectionBadge').className = 'status online';
      $('#connectionBadge').title = 'Calling server connected';
    });
    socket.on('disconnect', () => {
      $('#connectionBadge').textContent = 'Reconnecting…';
      $('#connectionBadge').className = 'status break';
      $('#connectionBadge').title = 'Reconnecting to the calling server';
      $('#onlineBtn').disabled = true;
      $('#offlineBtn').disabled = true;
      $('#breakBtn').disabled = true;
      if (currentCall) {
        stopRing();
        audioCall?.stop();
        show('#incomingModal', false);
        show('#callView', false);
        show('#restoreListenerCall', false);
        currentCall = null;
        if (history.state?.marker === NAVIGATION_MARKER && history.state.overlay) {
          setNavigationState({ overlay: null }, 'replace');
        }
        P.toast('Connection lost. The call was closed safely.', 'error');
      }
    });
    socket.on('connect_error', (error) => console.warn('Calling server reconnecting:', error?.message || error));
    socket.on('employee:status', (data) => {
      setStatus(data.status);
      loadStats();
      loadActivity();
    });
    socket.on('call:incoming', incoming);
    socket.on('call:accepted', async (data) => {
      stopRing();
      show('#incomingModal', false);
      openManagedOverlay('#callView', 'callView', 'replace');
      show('#restoreListenerCall', false);
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
      $('#callState').textContent = 'Connected · customer billing is active';
      P.toast('Customer connected.', 'success');
    });
    socket.on('call:audio-paused', () => {
      if (currentCall) $('#callState').textContent = 'Audio paused · customer is not being charged';
    });
    socket.on('call:audio-restored', () => {
      if (currentCall) $('#callState').textContent = 'Connected · customer billing is active';
    });
    socket.on('call:tick', (data) => {
      $('#callTimer').textContent = P.duration(data.billedSeconds);
      $('#customerBalance').textContent = P.duration(data.balanceSeconds);
    });
    socket.on('call:ended', (data) => {
      stopRing();
      show('#incomingModal', false);
      show('#callView', false);
      show('#restoreListenerCall', false);
      audioCall?.stop();
      $('#acceptBtn').disabled = false;
      $('#rejectBtn').disabled = false;
      currentCall = null;
      if (history.state?.marker === NAVIGATION_MARKER && history.state.overlay) {
        setNavigationState({ overlay: null }, 'replace');
      }
      P.toast(data.reason || 'The call ended.');
      loadStats();
      loadActivity();
      loadHistory();
    });
    socket.on('chat:message', addChat);
    socket.on('notification:new', (notification) => P.toast(`${notification.title}: ${notification.body}`, 'info'));
    socket.on('account:restricted', (data) => {
      P.toast(data.reason || 'Your account has been restricted.', 'error');
      logout();
    });
  }

  function setStatus(nextStatus) {
    status = nextStatus;
    const label = nextStatus === 'online' ? 'Online' : nextStatus === 'break' ? 'On break' : 'Offline';
    $('#shiftStatus').textContent = label;
    $('#onlineBtn').disabled = nextStatus === 'online';
    $('#offlineBtn').disabled = nextStatus === 'offline';
    $('#breakBtn').disabled = nextStatus === 'offline';
    $('#breakBtn').textContent = nextStatus === 'break' ? 'End break' : 'Take a break';
    $('#deskTitle').textContent = nextStatus === 'online'
      ? 'You are ready to receive calls'
      : nextStatus === 'break'
        ? 'Break mode is active'
        : 'You are offline';
    $('#deskText').textContent = nextStatus === 'online'
      ? 'You are online and available for calls.'
      : nextStatus === 'break'
        ? 'End your break when you are ready to receive calls again.'
        : `Go online when you are ready to receive ${me?.listenerLanguage || 'your language'} calls.`;
  }

  function initials(name = 'Customer') {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  }

  function incoming(data) {
    // Never surface a call after the listener has already moved to Break/Offline.
    // The server also protects this, but this client guard closes the final race window.
    if (status !== 'online') {
      socket?.emit('call:reject', { callId: data.callId });
      return;
    }
    currentCall = { id: data.callId, customer: data.customer, mediaConnected: false, language: me?.listenerLanguage || 'Malayalam' };
    $('#acceptBtn').disabled = false;
    $('#rejectBtn').disabled = false;
    $('#incomingName').textContent = data.customer.name;
    $('#incomingInitials').textContent = initials(data.customer.name);
    $('#incomingBalance').textContent = P.duration(data.balanceSeconds);
    $('#activeCallLanguage').textContent = `${me?.listenerLanguage || 'Malayalam'} conversation`;
    openManagedOverlay('#incomingModal', 'incomingModal');
    startRing();
  }

  function accept() {
    if (!currentCall || !socket?.connected) return;
    $('#acceptBtn').disabled = true;
    $('#rejectBtn').disabled = true;
    socket.emit('call:accept', { callId: currentCall.id });
    $('#customerName').textContent = currentCall.customer.name;
    $('#customerInitials').textContent = initials(currentCall.customer.name);
    $('#chatMessages').innerHTML = '<div class="bubble">Private text chat is ready.</div>';
    $('#callTimer').textContent = '0:00';
  }

  async function prepareRingtone() {
    try {
      if (!ringContext) ringContext = new (window.AudioContext || window.webkitAudioContext)();
      if (ringContext.state === 'suspended') await ringContext.resume();
    } catch {
      ringContext = null;
    }
  }

  function startRing() {
    stopRing();
    ringSecondsLeft = publicConfig?.ringSeconds || 30;
    $('#ringCountdown').textContent = `${ringSecondsLeft}s`;
    ringCountdown = setInterval(() => {
      ringSecondsLeft -= 1;
      $('#ringCountdown').textContent = `${Math.max(0, ringSecondsLeft)}s`;
      if (ringSecondsLeft <= 0) clearInterval(ringCountdown);
    }, 1000);

    prepareRingtone().then(() => {
      if (!ringContext) return;
      const playTone = () => {
        if (!ringContext || ringContext.state !== 'running') return;
        const oscillator = ringContext.createOscillator();
        const gain = ringContext.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(610, ringContext.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(760, ringContext.currentTime + 0.24);
        gain.gain.setValueAtTime(0.0001, ringContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.11, ringContext.currentTime + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, ringContext.currentTime + 0.55);
        oscillator.connect(gain).connect(ringContext.destination);
        oscillator.start();
        oscillator.stop(ringContext.currentTime + 0.58);
      };
      playTone();
      ringToneTimer = setInterval(playTone, 1250);
    });
  }

  function stopRing() {
    if (ringCountdown) clearInterval(ringCountdown);
    ringCountdown = null;
    if (ringToneTimer) clearInterval(ringToneTimer);
    ringToneTimer = null;
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

  async function loadStats() {
    try {
      const response = await P.api('/api/employee/stats');
      $('#todayWork').textContent = P.duration(response.stats.today_work_seconds);
      $('#todayTime').textContent = P.duration(response.stats.today_seconds);
      $('#todayBreak').textContent = P.duration(response.stats.today_break_seconds);
      $('#weekWork').textContent = P.duration(response.stats.week_work_seconds);
      $('#totalCalls').textContent = response.stats.total_calls;
      $('#totalTime').textContent = P.duration(response.stats.total_seconds);
      $('#currentShiftSince').textContent = response.stats.current_activity_started_at
        ? `${status === 'break' ? 'Break' : 'Work'} session started ${P.date(response.stats.current_activity_started_at)}`
        : 'No active work session';
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function loadActivity() {
    try {
      const response = await P.api('/api/employee/activity');
      $('#activityList').innerHTML = response.sessions?.length
        ? response.sessions.map((session) => `<article><span class="activity-state ${P.esc(session.state)}">${P.esc(session.state)}</span><div><strong>${P.duration(session.duration_seconds)}</strong><p>${P.date(session.started_at)} → ${session.ended_at ? P.date(session.ended_at) : 'Now'}</p></div><small>${P.esc(session.end_reason || (session.ended_at ? 'Status changed' : 'Current session'))}</small></article>`).join('')
        : emptyState('No work sessions yet', 'Go online to begin recording connected work time.');
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  function emptyState(title, message) {
    return `<div class="panel empty-state"><img src="assets/logo.svg" alt=""><h3>${P.esc(title)}</h3><p>${P.esc(message)}</p></div>`;
  }

  async function loadHistory() {
    try {
      const response = await P.api('/api/employee/history');
      $('#historyList').innerHTML = response.calls.length
        ? response.calls.map((call) => `
          <article class="list-item"><div><strong>${P.esc(call.customer_name)}</strong><p>${P.date(call.created_at)} · ${P.duration(call.billed_seconds)}</p><small>${P.esc(call.end_reason || call.status)}</small></div><div class="list-actions"><button class="button button-quiet" data-report="${call.id}">Report</button><button class="button button-soft" data-block="${call.id}">Request restriction</button></div></article>`).join('')
        : emptyState('No call history', 'Completed and missed calls will appear here.');
      $$('[data-report]').forEach((button) => button.addEventListener('click', () => reportId(button.dataset.report, false)));
      $$('[data-block]').forEach((button) => button.addEventListener('click', () => reportId(button.dataset.block, true)));
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function reportId(id, high) {
    const reason = prompt(high ? 'Explain why you want this customer restricted:' : 'Describe the issue you want to report:');
    if (!reason) return;
    try {
      await P.api('/api/employee/reports', {
        method: 'POST',
        body: JSON.stringify({ callId: id, reason, details: reason, priority: high ? 'high' : 'normal' }),
      });
      P.toast('Your report was sent to the administrator.', 'success');
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  function reportCurrent() {
    if (currentCall) reportId(currentCall.id, false);
  }

  async function saveProfile(event) {
    event.preventDefault();
    try {
      const response = await P.api('/api/employee/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          name: $('#profileName').value,
          username: $('#profileUsername').value,
          phone: $('#profilePhone').value,
          upiId: $('#profileUpi').value,
          bio: $('#profileBio').value,
        }),
      });
      me = { ...me, ...response.user };
      $('#hello').textContent = `Hello, ${me.name}`;
      P.toast('Profile saved.', 'success');
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function changeEmail(event) {
    event.preventDefault();
    try {
      await P.api('/api/auth/change-login', {
        method: 'POST',
        body: JSON.stringify({ newEmail: $('#employeeNewEmail').value, currentPassword: $('#employeeEmailPassword').value }),
      });
      P.toast('Email updated. Please sign in again.', 'success');
      setTimeout(logout, 900);
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
      P.toast('Password updated. All sessions were signed out.', 'success');
      setTimeout(logout, 900);
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function loadNotifications() {
    try {
      const response = await P.api('/api/employee/notifications');
      $('#notificationList').innerHTML = response.notifications.length
        ? response.notifications.map((notification) => `<article class="list-item"><div><strong>${P.esc(notification.title)}</strong><p>${P.esc(notification.body)}</p></div><small>${P.date(notification.created_at)}</small></article>`).join('')
        : emptyState('No admin messages', 'Important platform updates will appear here.');
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  init();
})();
