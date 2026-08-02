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

  async function registerFreshServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.register('service-worker.js?v=5.3.0', { updateViaCache: 'none' });
      await registration.update();
    } catch {}
  }

  function bind() {
    $('#loginForm').addEventListener('submit', login);
    $('#forgotBtn').addEventListener('click', openRecovery);
    $('#closeRecovery').addEventListener('click', () => show('#recoveryModal', false));
    $('#recoveryRequestForm').addEventListener('submit', requestRecovery);
    $('#employeeCheckRecovery').addEventListener('click', checkRecovery);
    $('#employeeCopyRecovery').addEventListener('click', () => copyValue($('#employeeRecoveryKey').value));
    $('#employeeResetForm').addEventListener('submit', completeRecovery);
    $('#logoutBtn').addEventListener('click', logout);
    $$('[data-tab]').forEach((button) => button.addEventListener('click', () => selectTab(button)));
    $('#onlineBtn').addEventListener('click', async () => {
      await prepareRingtone();
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      socket?.emit('employee:online');
    });
    $('#offlineBtn').addEventListener('click', () => socket?.emit('employee:offline'));
    $('#breakBtn').addEventListener('click', () => socket?.emit('employee:break', { enabled: status !== 'break' }));
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
  }

  async function init() {
    bind();
    registerFreshServiceWorker();
    try { publicConfig = await P.api('/api/public/config'); } catch {}
    ringSecondsLeft = publicConfig?.ringSeconds || 30;
    if (P.Store.token) await loadMe();
  }

  function selectTab(button) {
    $$('[data-tab]').forEach((item) => item.classList.toggle('active', item === button));
    $$('.tab').forEach((item) => item.classList.toggle('active', item.id === `tab-${button.dataset.tab}`));
    button.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    if (button.dataset.tab === 'history') loadHistory();
    if (button.dataset.tab === 'notifications') loadNotifications();
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
    show('#recoveryModal');
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
      show('#recoveryModal', false);
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
    connect();
    loadStats();
    loadHistory();
    loadNotifications();
  }

  function logout() {
    socket?.emit('employee:offline');
    socket?.disconnect();
    audioCall?.stop();
    stopRing();
    ringContext?.close().catch(() => {});
    ringContext = null;
    P.Store.clear();
    location.reload();
  }

  async function connect() {
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
        if (state === 'connected' && !currentCall.ready) {
          currentCall.ready = true;
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

    socket.on('connect_error', (error) => P.toast(error.message || 'Could not connect to the calling server.', 'error'));
    socket.on('employee:status', (data) => setStatus(data.status));
    socket.on('call:incoming', incoming);
    socket.on('call:accepted', async (data) => {
      stopRing();
      show('#incomingModal', false);
      show('#callView');
      $('#callState').textContent = 'Connecting secure audio…';
      try {
        await audioCall.start(data.callId, data.initiatorId === me.id);
      } catch (error) {
        P.toast(error.message || 'Please allow microphone access.', 'error');
        socket.emit('call:end', { callId: data.callId });
      }
    });
    socket.on('call:connected', () => {
      $('#callState').textContent = 'Connected · customer billing is active';
      P.notify('We Met', 'The customer is connected.');
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
      audioCall?.stop();
      currentCall = null;
      P.toast(data.reason || 'The call ended.');
      loadStats();
      loadHistory();
    });
    socket.on('chat:message', addChat);
    socket.on('notification:new', (notification) => P.notify(notification.title, notification.body));
    socket.on('account:restricted', (data) => {
      P.toast(data.reason || 'Your account has been restricted.', 'error');
      logout();
    });
  }

  function setStatus(nextStatus) {
    status = nextStatus;
    const label = nextStatus === 'online' ? 'Online' : nextStatus === 'break' ? 'On break' : 'Offline';
    $('#connectionBadge').textContent = label;
    $('#connectionBadge').className = `status ${nextStatus}`;
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
      ? 'You will hear a ringtone when a customer calls.'
      : nextStatus === 'break'
        ? 'End your break when you are ready to receive calls again.'
        : 'Go online when you are ready to receive Malayalam calls.';
  }

  function initials(name = 'Customer') {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  }

  function incoming(data) {
    currentCall = { id: data.callId, customer: data.customer };
    $('#incomingName').textContent = data.customer.name;
    $('#incomingInitials').textContent = initials(data.customer.name);
    $('#incomingBalance').textContent = P.duration(data.balanceSeconds);
    show('#incomingModal');
    startRing();
    P.notify('Incoming call', `${data.customer.name} is calling for a Malayalam conversation.`);
  }

  function accept() {
    if (!currentCall) return;
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
      $('#todayTime').textContent = P.duration(response.stats.today_seconds);
      $('#totalCalls').textContent = response.stats.total_calls;
      $('#totalTime').textContent = P.duration(response.stats.total_seconds);
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
      P.toast('Password updated.', 'success');
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
