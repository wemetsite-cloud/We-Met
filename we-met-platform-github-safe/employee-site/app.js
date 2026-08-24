(() => {
  'use strict';

  const P = window.Portal;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const show = (selector, visible = true) => $(selector)?.classList.toggle('hidden', !visible);
  let sessionResetPending = false;
  window.addEventListener('portal:session-invalid', (event) => {
    if (sessionResetPending) return;
    sessionResetPending = true;
    P.toast(event.detail?.message || 'Your session expired. Please sign in again.', 'error');
    setTimeout(leaveListenerSession, 0);
  });

  let me = null;
  let profileImageDraft = '';
  let bannerImageDraft;
  let listenerAuthState = { phone: '', challengeId: '', registrationToken: '' };
  let listenerSupportState = { phone: '', challengeId: '', verificationToken: '' };
  let verificationState = null;
  let voiceRecorder = null;
  let voiceChunks = [];
  let voiceBlob = null;
  let voiceStream = null;
  let voicePreviewUrl = '';
  let postPreviewUrl = '';
  let renderedPostUrls = [];
  let postDetailUrls = [];
  let postEditPreviewUrl = '';
  let listenerPosts = [];
  let postDetailRequestId = 0;
  let profileMediaVersion = Date.now();
  let followerPhotoUrls = [];
  const inboxPhotoUrls = new Map();
  let inbox = [];
  let activeCustomerId = null;
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
  const VALID_TABS = new Set(['desk', 'posts', 'inbox', 'followers', 'wallet', 'history', 'profile', 'settings', 'notifications']);

  function navigationState(tab = activeTab, overlay = null) {
    return { marker: NAVIGATION_MARKER, tab: VALID_TABS.has(tab) ? tab : 'desk', overlay };
  }

  function currentOverlay() {
    if (!$('#listenerPostEditModal')?.classList.contains('hidden')) return 'listenerPostEditModal';
    if (!$('#listenerPostDetailModal')?.classList.contains('hidden')) return 'listenerPostDetailModal';
    if (!$('#listenerSupportModal')?.classList.contains('hidden')) return 'listenerSupportModal';
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
    if (overlay === 'listenerPostDetailModal') releasePostDetailUrls();
    if (overlay === 'listenerPostEditModal') releasePostEditPreview();
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
      show('#listenerSupportModal', false);
      show('#listenerPostDetailModal', false);
      show('#listenerPostEditModal', false);
      releasePostDetailUrls();
      releasePostEditPreview();
      if (me) selectTab(state.tab, { historyMode: 'none' });
      syncBackButton();
    });
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      return await navigator.serviceWorker.register('service-worker.js?v=8.5.0', { updateViaCache: 'none' });
    } catch {}
  }

  function leaveListenerSession() {
    P.Store.clear();
    socket?.disconnect();
    audioCall?.stop();
    voiceStream?.getTracks().forEach((track) => track.stop());
    [voicePreviewUrl, postPreviewUrl, postEditPreviewUrl, ...renderedPostUrls, ...postDetailUrls, ...followerPhotoUrls].filter(Boolean).forEach((url) => URL.revokeObjectURL(url));
    voicePreviewUrl = '';
    postPreviewUrl = '';
    renderedPostUrls = [];
    postDetailUrls = [];
    postEditPreviewUrl = '';
    listenerPosts = [];
    followerPhotoUrls = [];
    inboxPhotoUrls.forEach((url) => URL.revokeObjectURL(url));
    inboxPhotoUrls.clear();
    stopRing();
    ringContext?.close().catch(() => {});
    ringContext = null;
    clearInterval(statsRefreshTimer);
    me = null;
    currentCall = null;
    status = 'offline';
    show('#loginView');
    show('#appView', false);
    show('#verificationView', false);
    show('#incomingModal', false);
    show('#callView', false);
    show('#recoveryModal', false);
    show('#listenerSupportModal', false);
    show('#listenerPostDetailModal', false);
    show('#listenerPostEditModal', false);
    show('#restoreListenerCall', false);
    ['listenerPhoneForm','listenerPasswordForm','listenerOtpForm','listenerDetailsForm','listenerSupportPhoneForm','listenerSupportOtpForm','listenerSupportIssueForm'].forEach((id) => document.getElementById(id)?.reset());
    showListenerAuthStep('welcome');
    activeTab = 'desk';
    history.replaceState(navigationState('desk', null), document.title);
    sessionResetPending = false;
  }

  function profileImageSrc(value, name = 'Listener', userId = me?.id) {
    const image = String(value || '');
    if (/^avatar-(0[1-9]|1[0-9]|20)\.svg$/.test(image)) return `assets/${image}`;
    if ((image === 'photo' || image === `photo:${userId}`) && userId) return `${P.base}/api/public/listener-profile-image/${encodeURIComponent(userId)}?v=${encodeURIComponent(profileMediaVersion)}`;
    if (/^data:image\/(?:jpeg|png|webp);base64,/.test(image)) return image;
    let total = 0; for (const char of String(name || 'Listener')) total += char.charCodeAt(0);
    return `assets/avatar-${String((total % 20) + 1).padStart(2, '0')}.svg`;
  }

  function renderProfileImageEditor() {
    const preview = $('#profileImagePreview');
    if (preview) preview.src = profileImageSrc(profileImageDraft, me?.name);
    if ($('#profilePreviewUsername')) $('#profilePreviewUsername').textContent = `@${me?.username || 'listener'}`;
    if ($('#profileDisplayName')) $('#profileDisplayName').textContent = me?.name || 'Listener';
    if ($('#profileCodeText')) $('#profileCodeText').textContent = me?.employeeCode ? `Listener · ${me.employeeCode}` : 'Verified listener';
    if ($('#profileBannerPreview')) {
      const banner = bannerImageDraft === undefined ? me?.bannerImage : bannerImageDraft;
      const url = String(banner || '').startsWith('photo:')
        ? `${P.base}/api/public/listener-banner-image/${encodeURIComponent(me.id)}?v=${encodeURIComponent(profileMediaVersion)}`
        : /^data:image\//.test(String(banner || '')) ? banner : 'assets/default-listener-banner.png';
      $('#profileBannerPreview').style.backgroundImage = `linear-gradient(180deg,rgba(16,11,14,.03),rgba(16,11,14,.52)),url("${url}")`;
    }
  }

  async function compressProfilePhoto(file) {
    if (!file || !['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG, or WebP photo.');
    if (file.size > 5 * 1024 * 1024) throw new Error('Choose a profile photo smaller than 5 MB.');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
      const size = 420;
      const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const crop = Math.min(image.naturalWidth, image.naturalHeight);
      const sx = (image.naturalWidth - crop) / 2; const sy = (image.naturalHeight - crop) / 2;
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,size,size);
      ctx.drawImage(image, sx, sy, crop, crop, 0, 0, size, size);
      const result = canvas.toDataURL('image/jpeg', .84);
      if (result.length > 600000) throw new Error('This photo is still too large. Choose a simpler or smaller image.');
      return result;
    } finally { URL.revokeObjectURL(url); }
  }

  async function compressBannerPhoto(file) {
    if (!file || !['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG, or WebP banner.');
    if (file.size > 7 * 1024 * 1024) throw new Error('Choose a banner smaller than 7 MB.');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
      const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 430;
      const ctx = canvas.getContext('2d');
      const sourceRatio = image.naturalWidth / image.naturalHeight; const targetRatio = canvas.width / canvas.height;
      let sx = 0; let sy = 0; let sw = image.naturalWidth; let sh = image.naturalHeight;
      if (sourceRatio > targetRatio) { sw = image.naturalHeight * targetRatio; sx = (image.naturalWidth - sw) / 2; }
      else { sh = image.naturalWidth / targetRatio; sy = (image.naturalHeight - sh) / 2; }
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const result = canvas.toDataURL('image/jpeg', .8);
      if (result.length > 610000) throw new Error('Choose a simpler or smaller banner image.');
      return result;
    } finally { URL.revokeObjectURL(url); }
  }

  function applyProfileResponse(user) {
    profileMediaVersion = Date.now();
    me = {
      ...me,
      ...user,
      profileImage: user.profile_image ?? user.profileImage ?? me.profileImage,
      bannerImage: user.banner_image ?? user.bannerImage ?? me.bannerImage,
      updatedAt: user.updated_at ?? user.updatedAt ?? new Date().toISOString(),
    };
    profileImageDraft = me.profileImage || '';
    bannerImageDraft = undefined;
    $('#profileName').value = me.name || '';
    $('#profileUsername').value = me.username || '';
    $('#profileBio').value = me.bio || '';
    renderProfileImageEditor();
  }

  async function saveProfileMedia(kind, image, trigger) {
    const oldProfile = profileImageDraft;
    const oldBanner = bannerImageDraft;
    if (kind === 'profileImage') profileImageDraft = image;
    else bannerImageDraft = image;
    renderProfileImageEditor();
    trigger.disabled = true;
    trigger.classList.add('uploading');
    try {
      const response = await P.api('/api/employee/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          name: me.name,
          username: me.username || '',
          bio: me.bio || '',
          [kind]: image,
        }),
      });
      applyProfileResponse(response.user);
      P.toast(kind === 'profileImage' ? 'Profile photo updated.' : 'Banner updated.', 'success');
    } catch (error) {
      profileImageDraft = oldProfile;
      bannerImageDraft = oldBanner;
      renderProfileImageEditor();
      P.toast(error.message, 'error');
    } finally {
      trigger.disabled = false;
      trigger.classList.remove('uploading');
    }
  }

  function bind() {
    $('#listenerAuthBegin').addEventListener('click', () => showListenerAuthStep('phone'));
    $('#listenerPhoneForm').addEventListener('submit', startListenerPhone);
    $('#listenerPasswordForm').addEventListener('submit', listenerPasswordLogin);
    $('#listenerForgotPassword').addEventListener('click', openRecovery);
    $('#listenerOtpForm').addEventListener('submit', verifyListenerOtp);
    $('#listenerDetailsForm').addEventListener('submit', registerListener);
    $('#listenerSupportButton').addEventListener('click', () => openManagedOverlay('#listenerSupportModal', 'listenerSupportModal'));
    $('#closeListenerSupport').addEventListener('click', () => closeManagedOverlay('listenerSupportModal'));
    $('#listenerSupportPhoneForm').addEventListener('submit', startListenerSupport);
    $('#listenerSupportOtpForm').addEventListener('submit', verifyListenerSupport);
    $('#listenerSupportIssueForm').addEventListener('submit', submitListenerSupport);
    $$('[data-listener-auth-back]').forEach((button) => button.addEventListener('click', () => showListenerAuthStep('phone')));
    $('#verificationLogout').addEventListener('click', leaveListenerSession);
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
    $('#toggleListenerProfileEdit').addEventListener('click', () => {
      const opening = $('#profileForm').classList.contains('hidden');
      show('#profileForm', opening);
      if (opening) setTimeout(() => $('#profileForm').scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
    });
    $('#closeListenerProfileEdit').addEventListener('click', () => show('#profileForm', false));
    $('#profilePhotoMenu').addEventListener('click', () => $('#profilePhotoFile').click());
    $('#profileBannerEdit').addEventListener('click', () => $('#profileBannerFile').click());
    $('#profilePhotoFile').addEventListener('change', async (event) => { try { const image = await compressProfilePhoto(event.target.files?.[0]); await saveProfileMedia('profileImage', image, $('#profilePhotoMenu')); } catch (error) { P.toast(error.message, 'error'); } finally { event.target.value = ''; } });
    $('#profileBannerFile').addEventListener('change', async (event) => { try { const image = await compressBannerPhoto(event.target.files?.[0]); await saveProfileMedia('bannerImage', image, $('#profileBannerEdit')); } catch (error) { P.toast(error.message, 'error'); } finally { event.target.value = ''; } });
    $('#passwordForm').addEventListener('submit', changePassword);
    $('#refreshHistory').addEventListener('click', loadHistory);
    $('#refreshWallet').addEventListener('click', loadWallet);
    $('#payoutDetailsForm').addEventListener('submit', savePayoutDetails);
    $('#withdrawalForm').addEventListener('submit', requestWithdrawal);
    $('#refreshActivity').addEventListener('click', () => { loadStats(); loadActivity(); });
    $('#minimizeListenerCall').addEventListener('click', () => minimizeListenerCall());
    $('#restoreListenerCall').addEventListener('click', restoreListenerCall);
    $('#choosePostPhoto').addEventListener('click', () => $('#postPhoto').click());
    $('#postPhoto').addEventListener('change', previewPostPhoto);
    $('#postForm').addEventListener('submit', publishPost);
    $('#listenerMessageForm').addEventListener('submit', sendListenerMessage);
    $('#closeListenerPostDetail').addEventListener('click', () => closeManagedOverlay('listenerPostDetailModal'));
    $('#closeListenerPostEdit').addEventListener('click', () => closeManagedOverlay('listenerPostEditModal'));
    $('#chooseListenerPostEditPhoto').addEventListener('click', () => $('#listenerPostEditPhoto').click());
    $('#listenerPostEditPhoto').addEventListener('change', previewPostEditPhoto);
    $('#listenerPostEditForm').addEventListener('submit', savePostEdit);
    document.addEventListener('click', handleListenerSocialClick);
    document.addEventListener('contextmenu', (event) => { if (event.target.closest('img,.listener-post,.follower-card')) event.preventDefault(); });
    document.addEventListener('dragstart', (event) => { if (event.target.closest('img')) event.preventDefault(); });
    document.addEventListener('copy', (event) => { if (!event.target.closest('input,textarea,[contenteditable="true"]')) event.preventDefault(); });
  }

  async function init() {
    initNavigation();
    bind();
    registerServiceWorker();
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
    if (tab === 'wallet') loadWallet();
    if (tab === 'notifications' || tab === 'settings') loadNotifications();
    if (tab === 'posts') loadPosts();
    if (tab === 'profile') loadPosts();
    if (tab === 'inbox') loadInbox();
    if (tab === 'followers') loadFollowers();
    if (tab === 'desk') { loadStats(); loadActivity(); }
    syncBackButton();
  }

  function showListenerAuthStep(step) {
    $$('.listener-auth-step').forEach((section) => section.classList.toggle('active', section.dataset.listenerAuth === step));
    const progress = { welcome: 0, phone: 18, password: 100, otp: 46, details: 100 }[step] || 0;
    $('#listenerAuthProgress').style.width = `${progress}%`;
    setTimeout(() => $(`[data-listener-auth="${step}"] input`)?.focus(), 50);
  }

  function composedPhone(countrySelector, numberSelector) {
    const raw = String($(numberSelector)?.value || '').trim();
    if (raw.startsWith('+')) return `+${raw.replace(/\D/g, '')}`;
    const national = raw.replace(/\D/g, '').replace(/^0+/, '');
    return `${$(countrySelector)?.value || '+91'}${national}`;
  }

  async function startListenerPhone(event) {
    event.preventDefault();
    const button = event.submitter; button.disabled = true;
    const phone = composedPhone('#listenerCountry', '#listenerPhone');
    try {
      const response = await P.api('/api/auth/phone/start', { method: 'POST', body: JSON.stringify({ phone, role: 'employee' }) });
      listenerAuthState.phone = phone;
      $('#listenerPhonePreview').textContent = response.phone;
      $('#listenerOtpPhone').textContent = response.phone;
      if (response.mode === 'password') showListenerAuthStep('password');
      else {
        listenerAuthState.challengeId = response.challengeId;
        if (response.developmentOtp) { $('#listenerDevelopmentOtp').textContent = `Development OTP: ${response.developmentOtp}`; show('#listenerDevelopmentOtp'); }
        showListenerAuthStep('otp');
      }
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function listenerPasswordLogin(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const response = await P.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier: listenerAuthState.phone, password: $('#listenerLoginPassword').value, role: 'employee' }) });
      if (response.user.role !== 'employee') throw new Error('This is not a listener account.');
      P.Store.token = response.token; me = response.user; await enter();
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function verifyListenerOtp(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const response = await P.api('/api/auth/phone/verify', { method: 'POST', body: JSON.stringify({ challengeId: listenerAuthState.challengeId, otp: $('#listenerOtp').value }) });
      listenerAuthState.registrationToken = response.registrationToken; showListenerAuthStep('details');
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function registerListener(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const response = await P.api('/api/auth/phone/register/listener', { method: 'POST', body: JSON.stringify({ registrationToken: listenerAuthState.registrationToken, username: $('#listenerPublicUsername').value, name: $('#listenerLegalName').value, password: $('#listenerNewPassword').value, termsAccepted: $('#listenerTerms').checked }) });
      P.Store.token = response.token; me = response.user; await enter();
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function startListenerSupport(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const phone = composedPhone('#listenerSupportCountry', '#listenerSupportPhone');
      const response = await P.api('/api/auth/support/phone/start', { method: 'POST', body: JSON.stringify({ phone }) });
      listenerSupportState = { phone, challengeId: response.challengeId, verificationToken: '' };
      $('#listenerSupportPhonePreview').textContent = response.phone;
      if (response.developmentOtp) { $('#listenerSupportDevelopmentOtp').textContent = `Development OTP: ${response.developmentOtp}`; show('#listenerSupportDevelopmentOtp'); }
      show('#listenerSupportPhoneForm', false); show('#listenerSupportOtpForm');
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function verifyListenerSupport(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const response = await P.api('/api/auth/phone/verify', { method: 'POST', body: JSON.stringify({ challengeId: listenerSupportState.challengeId, otp: $('#listenerSupportOtp').value }) });
      listenerSupportState.verificationToken = response.registrationToken;
      show('#listenerSupportOtpForm', false); show('#listenerSupportIssueForm');
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function submitListenerSupport(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const response = await P.api('/api/auth/support/submit', { method: 'POST', body: JSON.stringify({ registrationToken: listenerSupportState.verificationToken, issue: $('#listenerSupportIssue').value }) });
      P.toast(response.message || 'Your issue was sent securely.', 'success');
      closeManagedOverlay('listenerSupportModal', 'replace');
      ['listenerSupportPhoneForm','listenerSupportOtpForm','listenerSupportIssueForm'].forEach((id) => document.getElementById(id)?.reset());
      show('#listenerSupportPhoneForm'); show('#listenerSupportOtpForm', false); show('#listenerSupportIssueForm', false); show('#listenerSupportDevelopmentOtp', false);
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
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
        body: JSON.stringify({ identifier: $('#recoveryPhone').value }),
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
      await enter();
    } catch (error) {
      if (P.isAuthError(error)) return;
      P.toast('The server is temporarily unavailable. Your listener login is still saved; try again shortly.', 'error');
    }
  }

  async function enter() {
    sessionResetPending = false;
    show('#loginView', false);
    verificationState = await loadVerificationState();
    if (verificationState?.status !== 'approved') {
      show('#appView', false);
      show('#verificationView');
      renderVerification();
      return;
    }
    show('#verificationView', false);
    show('#appView');
    $('#profileName').value = me.name || '';
    $('#profileUsername').value = me.username || '';
    $('#profilePhone').value = me.phone || '';
    $('#profileBio').value = me.bio || '';
    $('#profileCode').value = me.employeeCode || '';
    $('#profileLanguage').value = me.listenerLanguage || 'Malayalam';
    profileImageDraft = me.profileImage || '';
    bannerImageDraft = undefined;
    renderProfileImageEditor();
    show('#profileForm', false);
    $('#deskLanguage').textContent = `${me.listenerLanguage || 'Malayalam'} calls`;
    connect();
    loadStats();
    loadActivity();
    loadWallet();
    loadHistory();
    loadNotifications();
    loadPosts();
    loadInbox();
    loadFollowers();
    clearInterval(statsRefreshTimer);
    statsRefreshTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (activeTab === 'desk') loadStats();
      if (activeTab === 'wallet') loadWallet();
      if (activeTab === 'inbox') {
        if (activeCustomerId) openListenerConversation(activeCustomerId);
        else loadInbox();
      }
    }, 30_000);
    syncBackButton();
  }

  async function loadVerificationState() {
    try { return await P.api('/api/employee/verification'); }
    catch (error) { P.toast(error.message, 'error'); return { status: me?.listenerVerificationStatus || 'voice_required', prompt: '' }; }
  }

  function renderVerification() {
    const content = $('#verificationContent');
    if (!content || !verificationState) return;
    if (verificationState.status === 'pending') {
      content.innerHTML = `<div class="verification-wait-art"><div class="wait-orbit one"></div><div class="wait-orbit two"></div><img src="assets/logo.svg" alt=""></div><span class="eyebrow">RECORDING RECEIVED</span><h1>We’re checking your voice.</h1><p>Review normally takes up to 24 hours. This page opens automatically as soon as the admin approves your recording.</p><div class="verification-status-line"><i></i><span>Review in progress</span></div><small class="verification-submitted">Submitted <span>${P.date(verificationState.submission?.created_at)}</span></small>`;
      window.setTimeout(checkVerificationApproval, 15000);
      return;
    }
    const rejected = verificationState.status === 'rejected';
    content.innerHTML = `<span class="eyebrow">VOICE VERIFICATION</span><h1>${rejected ? 'Record the line again' : 'One quick voice check'}</h1><p>Read this Malayalam line clearly in a quiet room. The admin uses only this clip to verify the listener account.</p>${rejected && verificationState.note ? `<div class="verification-note"><b>Admin note</b><span>${P.esc(verificationState.note)}</span></div>` : ''}<blockquote lang="ml">${P.esc(verificationState.prompt)}</blockquote><div id="recordingVisualizer" class="recording-visualizer"><i></i><i></i><i></i><i></i><i></i><span id="recordingStatus">Ready to record</span></div><audio id="voicePreview" class="hidden" controls></audio><div class="verification-actions"><button id="startVoiceRecord" class="button button-primary button-large" type="button">● Start recording</button><button id="stopVoiceRecord" class="button button-soft button-large hidden" type="button">Stop recording</button><button id="submitVoiceRecord" class="button button-primary button-large hidden" type="button">Send for verification</button></div><small>Your phone number and original name are never shown publicly.</small>`;
    $('#startVoiceRecord').onclick = startVoiceRecording;
    $('#stopVoiceRecord').onclick = stopVoiceRecording;
    $('#submitVoiceRecord').onclick = submitVoiceRecording;
  }

  async function checkVerificationApproval() {
    if (!me || $('#verificationView').classList.contains('hidden')) return;
    const latest = await loadVerificationState();
    verificationState = latest;
    if (latest.status === 'approved') {
      const response = await P.api('/api/auth/me'); me = response.user; P.toast('Voice verified. Welcome to your listener workspace!', 'success'); await enter();
    } else if (latest.status !== 'pending') renderVerification();
    else window.setTimeout(checkVerificationApproval, 15000);
  }

  async function startVoiceRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return P.toast('Voice recording is not supported in this browser. Use current Chrome, Edge or Safari.', 'error');
    try {
      voiceStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
      voicePreviewUrl = '';
      show('#voicePreview', false);
      show('#submitVoiceRecord', false);
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported?.(type));
      voiceRecorder = preferred ? new MediaRecorder(voiceStream, { mimeType: preferred }) : new MediaRecorder(voiceStream);
      voiceChunks = []; voiceBlob = null;
      voiceRecorder.ondataavailable = (event) => { if (event.data?.size) voiceChunks.push(event.data); };
      voiceRecorder.onstop = () => {
        voiceBlob = new Blob(voiceChunks, { type: String(voiceRecorder.mimeType || 'audio/webm').split(';')[0] });
        voicePreviewUrl = URL.createObjectURL(voiceBlob);
        const preview = $('#voicePreview'); preview.src = voicePreviewUrl; show('#voicePreview'); show('#submitVoiceRecord');
        $('#recordingStatus').textContent = 'Recording ready — listen before sending'; $('#recordingVisualizer').classList.remove('recording');
        voiceStream?.getTracks().forEach((track) => track.stop()); voiceStream = null;
      };
      voiceRecorder.start(250); show('#startVoiceRecord', false); show('#stopVoiceRecord'); $('#recordingVisualizer').classList.add('recording'); $('#recordingStatus').textContent = 'Recording… read the complete line';
    } catch (error) { P.toast(error.name === 'NotAllowedError' ? 'Allow microphone access to record the verification line.' : error.message, 'error'); }
  }

  function stopVoiceRecording() {
    if (voiceRecorder?.state === 'recording') voiceRecorder.stop();
    show('#stopVoiceRecord', false); show('#startVoiceRecord'); $('#startVoiceRecord').textContent = 'Record again';
  }

  async function submitVoiceRecording() {
    if (!voiceBlob?.size) return P.toast('Record the Malayalam line first.', 'info');
    const button = $('#submitVoiceRecord'); button.disabled = true;
    try {
      const form = new FormData(); form.append('audio', voiceBlob, voiceBlob.type === 'audio/mp4' ? 'verification.m4a' : 'verification.webm');
      const response = await P.api('/api/employee/verification/audio', { method: 'POST', body: form, timeout: 30000 });
      if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
      voicePreviewUrl = '';
      P.toast(response.message, 'success'); verificationState = await loadVerificationState(); renderVerification();
    } catch (error) { P.toast(error.message, 'error'); button.disabled = false; }
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
    leaveListenerSession();
  }

  async function connect() {
    try { await window.SocketIOReady; } catch (error) { P.toast(error.message, 'error'); return; }
    if (!me || !P.Store.token) return;
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
      loadWallet();
    });
    socket.on('chat:message', addChat);
    socket.on('notification:new', (notification) => {
      P.toast(`${notification.title}: ${notification.body}`, 'info');
      if (/wallet|payment|earning/i.test(`${notification.title} ${notification.body}`)) loadWallet();
    });
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

  function previewPostPhoto(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (postPreviewUrl) URL.revokeObjectURL(postPreviewUrl);
    postPreviewUrl = URL.createObjectURL(file);
    $('#postForm').classList.add('has-photo');
    $('#postUploadPreview').innerHTML = `<img src="${postPreviewUrl}" alt="Selected post" draggable="false"><b>${P.esc(file.name)}</b><small>${(file.size / 1024 / 1024).toFixed(1)} MB</small>`;
  }

  async function publishPost(event) {
    event.preventDefault();
    const file = $('#postPhoto').files?.[0];
    if (!file) return P.toast('Choose a photo first.', 'info');
    const button = event.submitter; button.disabled = true;
    try {
      const form = new FormData(); form.append('photo', file); form.append('caption', $('#postCaption').value);
      await P.api('/api/employee/posts', { method: 'POST', body: form, timeout: 30000 });
      if (postPreviewUrl) URL.revokeObjectURL(postPreviewUrl);
      postPreviewUrl = '';
      event.target.reset(); event.target.classList.remove('has-photo'); $('#postUploadPreview').innerHTML = '<span>＋</span><b>Choose a photo</b><small>JPG, PNG or WebP · max 4 MB</small>'; await loadPosts(); P.toast('Exclusive post published.', 'success');
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function loadPosts() {
    const nextUrls = [];
    try {
      const response = await P.api('/api/employee/posts');
      listenerPosts = response.posts || [];
      const markup = await Promise.all(listenerPosts.map(async (post) => {
        try {
          const blob = await P.apiBlob(post.imageUrl, { cache: 'no-store' });
          const url = URL.createObjectURL(blob);
          nextUrls.push(url);
          return `<article class="listener-post"><button class="listener-post-open" data-open-post="${P.esc(post.id)}" type="button" aria-label="Open post details"><img src="${url}" alt="Your exclusive post" draggable="false"><span class="listener-post-like-count">♥ ${Number(post.likeCount || 0).toLocaleString('en-IN')}</span><span class="listener-post-caption"><b>${P.esc(post.caption || 'No caption')}</b><small>${P.date(post.updated_at || post.created_at)}</small></span></button><details class="listener-post-options"><summary aria-label="Post options"><span></span><span></span><span></span></summary><div role="menu"><button data-edit-post="${P.esc(post.id)}" type="button" role="menuitem">Edit</button><button class="danger" data-delete-post="${P.esc(post.id)}" type="button" role="menuitem">Delete</button></div></details></article>`;
        }
        catch { return ''; }
      }));
      $('#listenerPosts').innerHTML = markup.filter(Boolean).join('') || emptyState('No exclusive posts', 'Publish your first member-only photo from the form.');
      renderedPostUrls.forEach((url) => URL.revokeObjectURL(url));
      renderedPostUrls = nextUrls;
    } catch (error) { nextUrls.forEach((url) => URL.revokeObjectURL(url)); P.toast(error.message, 'error'); }
  }

  async function deletePost(id) {
    if (!confirm('Delete this exclusive post?')) return;
    try {
      await P.api(`/api/employee/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const overlay = currentOverlay();
      if (overlay === 'listenerPostDetailModal' || overlay === 'listenerPostEditModal') closeManagedOverlay(overlay);
      await loadPosts();
      P.toast('Post deleted.', 'success');
    }
    catch (error) { P.toast(error.message, 'error'); }
  }

  function releasePostEditPreview() {
    if (postEditPreviewUrl) URL.revokeObjectURL(postEditPreviewUrl);
    postEditPreviewUrl = '';
    $('#listenerPostEditForm')?.reset();
    if ($('#listenerPostEditPreview')) $('#listenerPostEditPreview').innerHTML = '<span>Choose a post to edit.</span>';
  }

  async function openPostEditor(postId) {
    const post = listenerPosts.find((item) => item.id === postId);
    if (!post) return P.toast('This post is no longer available.', 'error');
    const replacingDetail = !$('#listenerPostDetailModal').classList.contains('hidden');
    if (replacingDetail) {
      show('#listenerPostDetailModal', false);
      releasePostDetailUrls();
      show('#listenerPostEditModal');
      setNavigationState({ overlay: 'listenerPostEditModal' }, 'replace');
    } else {
      openManagedOverlay('#listenerPostEditModal', 'listenerPostEditModal');
    }
    releasePostEditPreview();
    $('#listenerPostEditId').value = postId;
    $('#listenerPostEditCaption').value = post.caption || '';
    $('#listenerPostEditPreview').innerHTML = '<span>Loading photo…</span>';
    try {
      const blob = await P.apiBlob(post.imageUrl, { cache: 'no-store' });
      if ($('#listenerPostEditModal').classList.contains('hidden') || $('#listenerPostEditId').value !== postId) return;
      postEditPreviewUrl = URL.createObjectURL(blob);
      $('#listenerPostEditPreview').innerHTML = `<img src="${P.esc(postEditPreviewUrl)}" alt="Current post photo" draggable="false">`;
    } catch (error) {
      $('#listenerPostEditPreview').innerHTML = `<span>${P.esc(error.message)}</span>`;
    }
  }

  function previewPostEditPhoto(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)) {
      event.target.value = '';
      return P.toast('Choose a JPG, PNG or WebP photo.', 'error');
    }
    if (file.size > 4 * 1024 * 1024) {
      event.target.value = '';
      return P.toast('Choose a photo smaller than 4 MB.', 'error');
    }
    if (postEditPreviewUrl) URL.revokeObjectURL(postEditPreviewUrl);
    postEditPreviewUrl = URL.createObjectURL(file);
    $('#listenerPostEditPreview').innerHTML = `<img src="${P.esc(postEditPreviewUrl)}" alt="New post photo" draggable="false">`;
  }

  async function savePostEdit(event) {
    event.preventDefault();
    const postId = $('#listenerPostEditId').value;
    if (!postId) return;
    const button = event.submitter;
    button.disabled = true;
    try {
      const form = new FormData();
      form.append('caption', $('#listenerPostEditCaption').value);
      const photo = $('#listenerPostEditPhoto').files?.[0];
      if (photo) form.append('photo', photo);
      await P.api(`/api/employee/posts/${encodeURIComponent(postId)}`, { method: 'PATCH', body: form, timeout: 30000 });
      await loadPosts();
      closeManagedOverlay('listenerPostEditModal');
      P.toast('Post updated.', 'success');
    } catch (error) {
      P.toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function releasePostDetailUrls() {
    postDetailRequestId += 1;
    postDetailUrls.forEach((url) => URL.revokeObjectURL(url));
    postDetailUrls = [];
  }

  async function openPostInsights(postId) {
    releasePostDetailUrls();
    const requestId = postDetailRequestId;
    const createdUrls = [];
    const isCurrentRequest = () => requestId === postDetailRequestId && !$('#listenerPostDetailModal').classList.contains('hidden');
    openManagedOverlay('#listenerPostDetailModal', 'listenerPostDetailModal');
    $('#listenerPostDetailContent').innerHTML = '<div class="post-insights-loading"><span></span><p>Loading post…</p></div>';
    try {
      const response = await P.api(`/api/employee/posts/${encodeURIComponent(postId)}/insights`);
      if (!isCurrentRequest()) return;
      const imageBlob = await P.apiBlob(response.post.imageUrl);
      const postImage = URL.createObjectURL(imageBlob);
      createdUrls.push(postImage);
      const likerMarkup = await Promise.all((response.likes || []).map(async (like) => {
        let photo = '';
        if (like.imageUrl) {
          try {
            const blob = await P.apiBlob(like.imageUrl);
            photo = URL.createObjectURL(blob);
            createdUrls.push(photo);
          } catch {}
        }
        return `<li>${photo ? `<img src="${P.esc(photo)}" alt="" draggable="false">` : `<span>${initials(like.name)}</span>`}<div><b>${P.esc(like.name)}</b><small>${like.username ? `@${P.esc(like.username)} · ` : ''}${P.date(like.likedAt)}</small></div></li>`;
      }));
      if (!isCurrentRequest()) {
        createdUrls.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      postDetailUrls.push(...createdUrls);
      const count = Number(response.post.likeCount || 0);
      $('#listenerPostDetailContent').innerHTML = `<div class="post-insights-head"><div><span class="eyebrow">YOUR POST</span><h2 id="listenerPostDetailTitle">Post insights</h2></div><details class="listener-post-options post-insights-options"><summary aria-label="Post options"><span></span><span></span><span></span></summary><div role="menu"><button data-edit-post="${P.esc(response.post.id)}" type="button" role="menuitem">Edit</button><button class="danger" data-delete-post="${P.esc(response.post.id)}" type="button" role="menuitem">Delete</button></div></details></div><img class="post-insights-image" src="${P.esc(postImage)}" alt="Your exclusive post" draggable="false"><div class="post-insights-copy"><p>${P.esc(response.post.caption || 'No caption')}</p><small>${P.date(response.post.updatedAt || response.post.createdAt)}</small><strong>♥ ${count.toLocaleString('en-IN')} ${count === 1 ? 'like' : 'likes'}</strong></div><div class="post-likers"><h3>Liked by</h3>${likerMarkup.length ? `<ul>${likerMarkup.join('')}</ul>` : '<p>No likes yet.</p>'}</div>`;
    } catch (error) {
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
      if (isCurrentRequest()) $('#listenerPostDetailContent').innerHTML = `<div class="post-insights-error"><h2 id="listenerPostDetailTitle">Post unavailable</h2><p>${P.esc(error.message)}</p></div>`;
    }
  }

  async function loadInbox() {
    try {
      const response = await P.api('/api/employee/inbox'); inbox = response.conversations || [];
      const liveCustomerIds = new Set(inbox.map((item) => item.customerId));
      inboxPhotoUrls.forEach((url, customerId) => { if (!liveCustomerIds.has(customerId)) { URL.revokeObjectURL(url); inboxPhotoUrls.delete(customerId); } });
      await Promise.all(inbox.map(async (item) => {
        if (!String(item.customerImage || '').startsWith('photo:') || inboxPhotoUrls.has(item.customerId)) return;
        try {
          const blob = await P.apiBlob(`/api/employee/inbox/${encodeURIComponent(item.customerId)}/image`);
          inboxPhotoUrls.set(item.customerId, URL.createObjectURL(blob));
        } catch {}
      }));
      $('#listenerInbox').innerHTML = inbox.length ? inbox.map((item) => {
        const photo = inboxPhotoUrls.get(item.customerId);
        const avatar = photo ? `<img src="${P.esc(photo)}" alt="" draggable="false">` : `<b>${initials(item.customerName)}</b>`;
        const state = item.active ? 'Member' : 'Ended';
        return `<button class="listener-inbox-row ${activeCustomerId === item.customerId ? 'active' : ''}" data-inbox-customer="${P.esc(item.customerId)}" type="button"><span class="inbox-customer-photo">${avatar}<i class="${item.active ? 'member' : ''}"></i></span><div><b>${P.esc(item.customerName)}</b><small><em class="membership-state ${item.active ? 'active' : ''}">${state}</em>${P.esc(item.lastMessage || (item.active ? 'Start a conversation' : 'Message history'))}</small></div>${item.unreadCount ? `<i class="unread-badge">${item.unreadCount}</i>` : ''}</button>`;
      }).join('') : emptyState('No messages yet', 'Paid Exclusive members appear here automatically.');
    } catch (error) { P.toast(error.message, 'error'); }
  }

  async function openListenerConversation(customerId) {
    activeCustomerId = customerId; await loadInbox();
    const item = inbox.find((row) => row.customerId === customerId);
    if (!item) return;
    const photo = inboxPhotoUrls.get(item.customerId);
    $('#listenerChatHead').innerHTML = `<button class="chat-mobile-back" data-close-conversation type="button" aria-label="Back to messages">‹</button><span class="chat-head-photo">${photo ? `<img src="${P.esc(photo)}" alt="" draggable="false">` : initials(item.customerName)}<i class="${item.active ? 'member' : ''}"></i></span><span><strong>${P.esc(item.customerName)}</strong><small>${item.active ? `Exclusive member · ${P.date(item.currentPeriodEnd)}` : 'Membership ended · history only'}</small></span>`;
    $('.listener-inbox-layout')?.classList.add('conversation-open');
    show('#listenerMessageForm', item.active);
    try {
      const response = await P.api(`/api/employee/inbox/${encodeURIComponent(customerId)}/messages`);
      $('#listenerDirectMessages').innerHTML = response.messages.length ? response.messages.map((message) => `<div class="listener-direct-bubble ${message.sender_id === me.id ? 'mine' : ''}"><p>${P.esc(message.message)}</p><small>${P.date(message.created_at)}</small></div>`).join('') : '<div class="chat-empty">Start a respectful private conversation.</div>';
      $('#listenerDirectMessages').scrollTop = $('#listenerDirectMessages').scrollHeight;
    } catch (error) { P.toast(error.message, 'error'); }
  }

  async function sendListenerMessage(event) {
    event.preventDefault(); const message = $('#listenerMessageInput').value.trim(); if (!message || !activeCustomerId) return; const button = event.submitter; button.disabled = true;
    try { await P.api(`/api/employee/inbox/${encodeURIComponent(activeCustomerId)}/messages`, { method: 'POST', body: JSON.stringify({ message }) }); $('#listenerMessageInput').value = ''; await openListenerConversation(activeCustomerId); }
    catch (error) { P.toast(error.message, 'error'); } finally { button.disabled = false; }
  }

  async function loadFollowers() {
    const nextUrls = [];
    try {
      const response = await P.api('/api/employee/followers');
      const count = Number(response.count || 0);
      $('#followerCount').textContent = `${count.toLocaleString('en-IN')} ${count === 1 ? 'follower' : 'followers'}`;
      const cards = await Promise.all((response.followers || []).map(async (item) => {
        let image = ''; if (String(item.profileImage || '').startsWith('photo:')) { try { const blob = await P.apiBlob(`/api/employee/followers/${encodeURIComponent(item.customerId)}/image`); image = URL.createObjectURL(blob); nextUrls.push(image); } catch {} }
        return `<article class="follower-card">${image ? `<img src="${image}" alt="" draggable="false">` : `<span>${initials(item.name)}</span>`}<div><strong>${P.esc(item.name)}</strong><small><b>${item.subscribed ? 'Exclusive member' : 'Follower'}</b><time>${P.date(item.followedAt)}</time></small></div>${item.subscribed ? '<i>Member</i>' : ''}</article>`;
      }));
      $('#followerGrid').innerHTML = cards.join('') || '<div class="followers-empty"><strong>No followers yet</strong><small>People who follow your profile will appear here.</small></div>';
      followerPhotoUrls.forEach((url) => URL.revokeObjectURL(url));
      followerPhotoUrls = nextUrls;
    } catch (error) { nextUrls.forEach((url) => URL.revokeObjectURL(url)); P.toast(error.message, 'error'); }
  }

  function handleListenerSocialClick(event) {
    const currentOptions = event.target.closest('.listener-post-options');
    $$('.listener-post-options[open]').forEach((menu) => { if (menu !== currentOptions) menu.removeAttribute('open'); });
    if (event.target.closest('[data-close-conversation]')) {
      activeCustomerId = null;
      $('.listener-inbox-layout')?.classList.remove('conversation-open');
      $('#listenerChatHead').innerHTML = '<strong>Select a message</strong><small>Tap a profile to open the chat.</small>';
      show('#listenerMessageForm', false);
      return loadInbox();
    }
    const editPost = event.target.closest('[data-edit-post]'); if (editPost) return openPostEditor(editPost.dataset.editPost);
    const post = event.target.closest('[data-delete-post]'); if (post) return deletePost(post.dataset.deletePost);
    const openPost = event.target.closest('[data-open-post]'); if (openPost) return openPostInsights(openPost.dataset.openPost);
    const conversation = event.target.closest('[data-inbox-customer]'); if (conversation) return openListenerConversation(conversation.dataset.inboxCustomer);
  }

  async function loadStats() {
    try {
      const response = await P.api('/api/employee/stats');
      $('#todayTime').textContent = P.duration(response.stats.today_seconds);
      $('#weekTime').textContent = P.duration(response.stats.week_seconds);
      $('#totalCalls').textContent = response.stats.total_calls;
      $('#totalTime').textContent = P.duration(response.stats.total_seconds);
      $('#currentShiftSince').textContent = response.stats.current_activity_started_at
        ? `${status === 'break' ? 'Break' : 'Work'} session started ${P.date(response.stats.current_activity_started_at)}`
        : 'No active work session';
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function loadWallet() {
    try {
      const response = await P.api('/api/employee/wallet');
      const summary = response.summary || {};
      $('#walletBalance').textContent = P.moneyExact(summary.balancePaise);
      $('#walletRate').textContent = `${P.moneyExact(summary.ratePaisePerMinute)}/min`;
      $('#walletToday').textContent = P.moneyExact(summary.todayEarningsPaise);
      $('#walletWeek').textContent = P.moneyExact(summary.weekEarningsPaise);
      $('#walletLifetime').textContent = P.moneyExact(summary.lifetimeEarningsPaise);
      $('#walletPaid').textContent = P.moneyExact(summary.lifetimePaidPaise);
      if (document.activeElement !== $('#listenerUpiId')) $('#listenerUpiId').value = response.payoutDetails?.upiId || '';
      if (document.activeElement !== $('#listenerUpiPhone')) $('#listenerUpiPhone').value = response.payoutDetails?.upiPhone || '';
      const balancePaise = Number(summary.balancePaise || 0);
      $('#walletPaymentStatus').textContent = Number(summary.ratePaisePerMinute || 0) <= 0
        ? 'Your rate has not been set yet. Ask the administrator to set it before taking paid calls.'
        : balancePaise > 0
          ? `${P.moneyExact(balancePaise)} is awaiting manual payment by the administrator.`
          : Number(summary.lifetimePaidPaise || 0) > 0
            ? 'Your recorded earnings are fully settled. New call and subscription earnings will appear here automatically.'
            : 'Call earnings and ₹50 successful-subscription credits are added automatically.';

      const labels = {
        call_credit: 'Call earnings',
        subscription_credit: 'Exclusive subscription earning',
        payout: 'Payment recorded',
        admin_adjustment: 'Administrator adjustment',
      };
      $('#walletHistory').innerHTML = response.transactions?.length
        ? response.transactions.map((entry) => {
          const amount = Number(entry.amount_paise || 0);
          const callDetail = entry.type === 'call_credit'
            ? `${P.duration(entry.billed_seconds)} at ${P.moneyExact(entry.rate_paise_per_minute)}/min`
            : '';
          const subscriptionDetail = entry.type === 'subscription_credit'
            ? '₹50 for a successful exclusive membership payment'
            : '';
          const paymentDetail = entry.type === 'payout'
            ? `${entry.payment_reference ? `Reference ${entry.payment_reference}` : 'Recorded by administrator'}`
            : '';
          const detail = [callDetail || paymentDetail || subscriptionDetail, entry.note].filter(Boolean).join(' · ');
          return `<article class="wallet-entry ${amount < 0 ? 'debit' : 'credit'}"><div><strong>${P.esc(labels[entry.type] || entry.type)}</strong><p>${P.esc(detail || 'Wallet entry')}</p><small>${P.date(entry.created_at)}</small></div><b>${amount >= 0 ? '+' : '−'}${P.moneyExact(Math.abs(amount))}</b></article>`;
        }).join('')
        : emptyState('No wallet activity', 'Connected-call earnings, ₹50 subscription credits and recorded payments will appear here.');
      $('#withdrawalHistory').innerHTML = response.withdrawals?.length
        ? response.withdrawals.map((entry) => `<article class="withdrawal-entry"><div><span class="withdrawal-status ${P.esc(entry.status)}">${P.esc(entry.status)}</span><strong>${P.moneyExact(entry.amount_paise)}</strong><small>${P.date(entry.requested_at)}</small></div><p>${entry.status === 'paid' ? `Paid${entry.payment_reference ? ` · UTR ${P.esc(entry.payment_reference)}` : ''}` : entry.status === 'declined' ? P.esc(entry.admin_note || 'Declined by admin') : 'Admin review · up to 24 hours'}</p></article>`).join('')
        : '<small class="empty-copy">No withdrawal requests yet.</small>';
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  async function savePayoutDetails(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      await P.api('/api/employee/payout-details', { method: 'PATCH', body: JSON.stringify({ upiId: $('#listenerUpiId').value, upiPhone: $('#listenerUpiPhone').value }) });
      P.toast('UPI payout details saved.', 'success'); await loadWallet();
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function requestWithdrawal(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const rupees = Number($('#withdrawalAmount').value);
      if (!Number.isFinite(rupees)) throw new Error('Enter a withdrawal amount.');
      const response = await P.api('/api/employee/withdrawals', { method: 'POST', body: JSON.stringify({ amountPaise: Math.round(rupees * 100) }) });
      event.target.reset(); P.toast(response.message || 'Withdrawal requested.', 'success'); await loadWallet();
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
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
          <article class="list-item"><div><strong>${P.esc(call.customer_name)}</strong><p>${P.date(call.created_at)} · ${P.duration(call.billed_seconds)} · Earned ${P.moneyExact(call.listener_earnings_paise)}</p><small>${P.esc(call.end_reason || call.status)}</small></div><div class="list-actions"><button class="button button-quiet" data-report="${call.id}">Report</button><button class="button button-soft" data-block="${call.id}">Request restriction</button></div></article>`).join('')
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
    const button = event.submitter;
    const previous = { name: me.name, username: me.username, bio: me.bio };
    const draft = {
      name: $('#profileName').value.trim(),
      username: $('#profileUsername').value.trim().toLowerCase(),
      bio: $('#profileBio').value.trim(),
    };
    me = { ...me, ...draft };
    renderProfileImageEditor();
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const response = await P.api('/api/employee/profile', {
        method: 'PATCH',
        body: JSON.stringify(draft),
      });
      applyProfileResponse(response.user);
      show('#profileForm', false);
      P.toast('Profile saved.', 'success');
    } catch (error) {
      me = { ...me, ...previous };
      renderProfileImageEditor();
      P.toast(error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Save profile';
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
        ? response.notifications.map((notification) => `<article class="settings-notification"><div><strong>${P.esc(notification.title)}</strong><p>${P.esc(notification.body)}</p></div><time>${P.date(notification.created_at)}</time></article>`).join('')
        : '<div class="settings-empty"><strong>No updates</strong><small>Important account notices will appear here.</small></div>';
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  init();
})();
