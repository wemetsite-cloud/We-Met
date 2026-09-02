(() => {
  'use strict';

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  function resetViewportTop(node = null) {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    window.scrollTo(0, 0);
    if (node) {
      node.scrollTop = 0;
      node.querySelectorAll?.('.modal-card,.listener-profile-modal,.customer-post-feed-list,.legal-card,.recovery-card,.verification-card,.listener-post-feed-list').forEach((part) => { part.scrollTop = 0; });
    }
  }

  const P = window.Portal;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const show = (selector, visible = true) => $(selector)?.classList.toggle('hidden', !visible);
  const esc = P.esc;
  const NAV_MARKER = 'we-met-customer-v86';
  const VALID_TABS = new Set(['home', 'subscriptions', 'messages', 'wallet', 'profile', 'history', 'following', 'notifications', 'support']);
  const TAB_PARENT = { history: 'profile', following: 'profile', notifications: 'profile', support: 'profile' };

  let me = null;
  let publicConfig = null;
  let socket = null;
  let audioCall = null;
  let currentCall = null;
  let directory = [];
  const listenerShuffleKeys = new Map();
  let liveListeners = [];
  let liveDirectoryReady = false;
  let subscriptions = [];
  let conversations = [];
  let activeConversation = null;
  let activeTab = 'home';
  let paymentPlans = [];
  let followingListeners = [];
  let authState = { phone: '', registrationToken: '', otpPurpose: 'registration' };
  let customerRecoveryState = { phone: '', resetToken: '' };
  let supportAuthState = { challengeId: '', registrationToken: '' };
  let postObjectUrls = [];
  let activeProfilePosts = [];
  let activeProfileListener = null;
  let customerPhotoObjectUrl = '';
  let customerPhotoDraft;
  let deferredInstallPrompt = null;
  let directPollTimer = null;
  let pendingMembershipCheckout = null;
  let pendingCallRequest = null;
  let razorpayLoader = null;
  let activeWalletCheckout = null;
  let activeListenerProfileId = null;

  window.addEventListener('portal:session-invalid', (event) => {
    P.toast(event.detail?.message || 'Your session expired. Please start again.', 'error');
    setTimeout(() => logout(false), 0);
  });

  function emptyState(title, message) {
    return `<div class="panel empty-state"><img src="/shared/logo.svg" alt=""><h3>${esc(title)}</h3><p>${esc(message)}</p></div>`;
  }

  function generatedAvatar(seed, name = 'Listener') {
    const palettes = [['#ff4f9a','#6d1748'],['#8b5cf6','#3b1f75'],['#23b5a9','#135b60'],['#f59e5b','#963b52'],['#51a7f9','#294678']];
    let total = 0;
    for (const char of String(seed || name)) total = (total * 31 + char.charCodeAt(0)) >>> 0;
    const [start, end] = palettes[total % palettes.length];
    const letters = String(name || 'Listener').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'WM';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${start}"/><stop offset="1" stop-color="${end}"/></linearGradient></defs><rect width="320" height="320" rx="160" fill="url(#g)"/><circle cx="240" cy="72" r="52" fill="#fff" opacity=".12"/><text x="160" y="188" text-anchor="middle" font-family="Arial,sans-serif" font-size="104" font-weight="700" fill="#fff">${letters}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  function listenerImage(listener, kind = 'profile') {
    const reference = String(kind === 'banner' ? listener.bannerImage || listener.banner || listener.banner_image || '' : listener.profileImage || listener.listenerImage || listener.avatar || listener.profile_image || '');
    const listenerId = listener.id || listener.listenerId;
    const mediaVersion = listener.updatedAt || listener.updated_at || 'current';
    if (reference.startsWith('photo:')) {
      const endpoint = kind === 'banner' ? 'listener-banner-image' : 'listener-profile-image';
      return `${P.base}/api/public/${endpoint}/${encodeURIComponent(listenerId)}?v=${encodeURIComponent(mediaVersion)}`;
    }
    if (/^data:image\/(?:jpeg|png|webp);base64,/.test(reference)) return reference;
    if (kind === 'banner') return '/shared/default-listener-banner.png';
    const seed = String(listenerId || listener.name || 'listener');
    return generatedAvatar(`${reference}:${seed}`, listener.name || listener.username || 'Listener');
  }

  function liveStatus(listener) {
    if (!liveDirectoryReady || !socket?.connected) return 'offline';
    const live = liveListeners.find((item) => item.id === (listener.id || listener.listenerId));
    return live?.status || 'offline';
  }

  function statusLabel(status) {
    return ({ available: 'Online', online: 'Online', busy: 'In a call', ringing: 'Ringing', break: 'On a break', offline: 'Offline' })[status] || 'Offline';
  }

  function listenerShuffleKey(listener) {
    const id = String(listener?.id || listener?.listenerId || listener?.name || Math.random());
    if (!listenerShuffleKeys.has(id)) listenerShuffleKeys.set(id, Math.random());
    return listenerShuffleKeys.get(id);
  }

  function listenerStatusRank(listener) {
    const status = liveStatus(listener);
    if (['available', 'online', 'busy', 'ringing'].includes(status)) return 0;
    if (status === 'break') return 1;
    return 2;
  }

  function randomizedListenerOrder(listeners) {
    return [...listeners].sort((a, b) => {
      const statusDifference = listenerStatusRank(a) - listenerStatusRank(b);
      if (statusDifference) return statusDifference;
      return listenerShuffleKey(a) - listenerShuffleKey(b);
    });
  }

  function isActiveMember(listenerId) {
    return subscriptions.some((item) => item.listenerId === listenerId && item.active)
      || directory.some((item) => item.id === listenerId && item.subscribed);
  }

  function currentOverlay() {
    return ['customerPostFeed', 'listenerProfileModal', 'authModal', 'customerRecoveryModal', 'preloginSupportModal', 'legalModal', 'membershipCheckoutModal', 'callModal'].find((id) => !document.getElementById(id)?.classList.contains('hidden')) || null;
  }

  function syncBodyState() {
    const overlay = currentOverlay();
    const rootTab = ['home', 'subscriptions', 'messages', 'wallet', 'profile'].includes(activeTab);
    const nestedCustomerView = Boolean(me && (overlay || !rootTab || currentCall || pendingCallRequest));
    document.body.classList.toggle('modal-open', Boolean(overlay));
    document.body.classList.toggle('nested-view-open', nestedCustomerView);
    document.body.classList.toggle('call-active', Boolean(me && (currentCall || pendingCallRequest)));
    document.body.classList.toggle('customer-messages-active', Boolean(me && activeTab === 'messages' && !overlay && !currentCall && !pendingCallRequest));
    $('#appBackButton')?.classList.toggle('hidden', !(overlay || (me && activeTab !== 'home')));
  }

  function openOverlay(id) {
    const node = document.getElementById(id);
    if (!node) return;
    const opening = node.classList.contains('hidden');
    node.classList.remove('hidden');
    resetViewportTop(node);
    if (opening) history.pushState({ marker: NAV_MARKER, tab: activeTab, overlay: id }, document.title);
    syncBodyState();
  }

  function closeOverlay(id, useHistory = true) {
    if (useHistory && history.state?.marker === NAV_MARKER && history.state.overlay === id) return history.back();
    document.getElementById(id)?.classList.add('hidden');
    if (id === 'listenerProfileModal') { activeListenerProfileId = null; activeProfileListener = null; releasePostUrls(); }
    if (id === 'membershipCheckoutModal') pendingMembershipCheckout = null;
    syncBodyState();
  }

  function replaceOverlayHistory(overlay = null) {
    history.replaceState({ marker: NAV_MARKER, tab: activeTab, ...(overlay ? { overlay } : {}) }, document.title);
  }

  function sealCustomerAuthenticatedHistory() {
    const root = { marker: NAV_MARKER, tab: activeTab || 'home', authRoot: true };
    history.replaceState(root, document.title);
    history.pushState({ ...root, authRoot: false, authGuard: true }, document.title);
  }

  function releasePostUrls() {
    postObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    postObjectUrls = [];
    activeProfilePosts = [];
  }

  function initAutoHideHeader() {
    let lastY = Math.max(0, window.scrollY);
    let downDistance = 0;
    let upDistance = 0;
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = Math.max(0, window.scrollY);
        const delta = y - lastY;
        const topbar = document.querySelector('.topbar');
        if (topbar) {
          if (y < 28 || currentOverlay()) {
            topbar.classList.remove('topbar-hidden');
            downDistance = 0;
            upDistance = 0;
          } else if (delta > 0) {
            downDistance += delta;
            upDistance = 0;
            if (y > 110 && downDistance > 30) topbar.classList.add('topbar-hidden');
          } else if (delta < 0) {
            upDistance += -delta;
            downDistance = 0;
            if (upDistance > 20) topbar.classList.remove('topbar-hidden');
          }
        }
        lastY = y;
        ticking = false;
      });
    }, { passive: true });
  }

  function initNavigation() {
    const requestedTab = new URLSearchParams(location.search).get('tab');
    activeTab = VALID_TABS.has(requestedTab) ? requestedTab : 'home';
    history.replaceState({ marker: NAV_MARKER, tab: activeTab, root: true }, document.title);
    history.pushState({ marker: NAV_MARKER, tab: activeTab, guard: true }, document.title);
    window.addEventListener('popstate', (event) => {
      const state = event.state?.marker === NAV_MARKER
        ? event.state
        : { tab: activeTab || 'home' };
      if (me && (event.state?.authRoot || event.state?.marker !== NAV_MARKER)) {
        history.pushState({ marker: NAV_MARKER, tab: activeTab || 'home', authGuard: true }, document.title);
        selectTab(activeTab || 'home', { historyMode: 'none' });
        syncBodyState();
        resetViewportTop();
        return;
      }
      ['authModal', 'customerRecoveryModal', 'preloginSupportModal', 'listenerProfileModal', 'customerPostFeed', 'legalModal', 'membershipCheckoutModal'].forEach((id) => document.getElementById(id)?.classList.add('hidden'));
      if (state.overlay !== 'membershipCheckoutModal') pendingMembershipCheckout = null;
      document.body.classList.remove('razorpay-open');
      if (!$('#callModal')?.classList.contains('hidden') && currentCall) minimizeCall(false);
      if (me) selectTab(state.tab || 'home', { historyMode: 'none' });
      if (state.overlay && state.overlay !== 'callModal') document.getElementById(state.overlay)?.classList.remove('hidden');
      if (!['listenerProfileModal', 'customerPostFeed'].includes(state.overlay)) { activeListenerProfileId = null; activeProfileListener = null; releasePostUrls(); }
      syncBodyState();
      resetViewportTop(state.overlay ? document.getElementById(state.overlay) : null);
      if (event.state?.marker === NAV_MARKER && event.state.root && !currentOverlay() && (!me || activeTab === 'home')) {
        history.pushState({ marker: NAV_MARKER, tab: activeTab || 'home', guard: true }, document.title);
      }
    });
  }

  function showPhoneStep(step) {
    $$('.phone-auth-step').forEach((section) => section.classList.toggle('active', section.dataset.phoneStep === step));
    const progress = { welcome: 0, phone: 18, password: 100, otp: 52, details: 100 }[step] || 0;
    $('#authProgressFill').style.width = `${progress}%`;
    setTimeout(() => $(`[data-phone-step="${step}"] input`)?.focus(), 60);
  }

  function openAuth() {
    authState = { phone: '', registrationToken: '', otpPurpose: 'registration' };
    ['phoneStartForm', 'phonePasswordForm', 'phoneOtpForm', 'phoneDetailsForm'].forEach((id) => document.getElementById(id)?.reset());
    show('#developmentOtp', false);
    showPhoneStep('welcome');
    openOverlay('authModal');
  }

  function composedPhone(countrySelector, inputSelector) {
    const raw = $(inputSelector).value.trim();
    const digits = raw.replace(/\D/g, '');
    if (raw.startsWith('+')) return `+${digits}`;
    return `${$(countrySelector).value}${digits.replace(/^0+/, '')}`;
  }

  function canonicalPhone(value) {
    const raw = String(value || '').trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+91${digits}`;
    if (digits.length >= 8 && digits.length <= 15 && digits[0] !== '0') return `+${digits}`;
    return raw;
  }

  async function sendMsg91Otp(phone) {
    if (!window.WMMsg91Otp) throw new Error('MSG91 OTP is not available. Refresh and try again.');
    await window.WMMsg91Otp.send(phone);
  }

  async function verifyMsg91ForServer({ phone, role, purpose, otp }) {
    if (!window.WMMsg91Otp) throw new Error('MSG91 OTP is not available. Refresh and try again.');
    const verified = await window.WMMsg91Otp.verify(otp);
    return P.api('/api/auth/msg91/verify', {
      method: 'POST',
      body: JSON.stringify({ accessToken: verified.accessToken, phone, role, purpose }),
    });
  }

  async function startPhone(event) {
    event.preventDefault();
    const submit = event.submitter;
    const phone = composedPhone('#authCountry', '#authPhone');
    submit.disabled = true;
    try {
      const response = await P.api('/api/auth/phone/start', { method: 'POST', body: JSON.stringify({ phone, role: 'customer' }) });
      authState.phone = phone;
      $('#authPhonePreview').textContent = response.phone;
      $('#otpPhonePreview').textContent = response.phone;
      if (response.mode === 'password') {
        showPhoneStep('password');
      } else {
        authState.otpPurpose = 'registration';
        window.WMMsg91Otp?.reset();
        await sendMsg91Otp(phone);
        show('#developmentOtp', false);
        showPhoneStep('otp');
        P.toast('OTP sent by SMS.', 'success');
      }
    } catch (error) { P.toast(error.message, 'error'); }
    finally { submit.disabled = false; }
  }

  async function passwordLogin(event) {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try {
      const response = await P.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier: authState.phone, password: $('#authPassword').value, role: 'customer' }) });
      completeAuthentication(response);
    } catch (error) { P.toast(error.message, 'error'); }
    finally { submit.disabled = false; }
  }


  async function verifyOtp(event) {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try {
      const response = await verifyMsg91ForServer({
        phone: authState.phone, role: 'customer', purpose: 'registration', otp: $('#authOtp').value,
      });
      authState.registrationToken = response.registrationToken;
      showPhoneStep('details');
    } catch (error) { P.toast(error.message, 'error'); }
    finally { submit.disabled = false; }
  }

  async function resendCustomerRegistrationOtp() {
    const button = $('#customerResendOtp');
    button.disabled = true;
    try {
      await window.WMMsg91Otp.retry();
      P.toast('OTP resent by SMS.', 'success');
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  function openCustomerRecovery() {
    customerRecoveryState = { phone: '', resetToken: '' };
    ['customerRecoveryPhoneForm', 'customerRecoveryOtpForm', 'customerRecoveryPasswordForm'].forEach((id) => document.getElementById(id)?.reset());
    show('#customerRecoveryPhoneForm'); show('#customerRecoveryOtpForm', false); show('#customerRecoveryPasswordForm', false); show('#customerRecoveryDevelopmentOtp', false);
    if (authState.phone) $('#customerRecoveryPhone').value = authState.phone;
    openOverlay('customerRecoveryModal');
    setTimeout(() => $('#customerRecoveryPhone').focus(), 60);
  }

  async function startCustomerRecovery(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const phone = canonicalPhone($('#customerRecoveryPhone').value);
      const response = await P.api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ identifier: phone, role: 'customer' }) });
      customerRecoveryState.phone = phone;
      $('#customerRecoveryPhonePreview').textContent = response.phone;
      window.WMMsg91Otp?.reset();
      await sendMsg91Otp(phone);
      show('#customerRecoveryDevelopmentOtp', false);
      show('#customerRecoveryPhoneForm', false); show('#customerRecoveryOtpForm'); $('#customerRecoveryOtp').focus();
      P.toast('OTP sent by SMS.', 'success');
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function verifyCustomerRecovery(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const response = await verifyMsg91ForServer({
        phone: customerRecoveryState.phone, role: 'customer', purpose: 'password_reset', otp: $('#customerRecoveryOtp').value,
      });
      if (!response.resetToken) throw new Error('Password reset verification failed. Request a new OTP.');
      customerRecoveryState.resetToken = response.resetToken;
      show('#customerRecoveryOtpForm', false); show('#customerRecoveryPasswordForm'); $('#customerRecoveryPassword').focus();
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function resendCustomerRecoveryOtp() {
    const button = $('#customerRecoveryResendOtp');
    button.disabled = true;
    try { await window.WMMsg91Otp.retry(); P.toast('OTP resent by SMS.', 'success'); }
    catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function completeCustomerRecovery(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    const password = $('#customerRecoveryPassword').value;
    if (password !== $('#customerRecoveryConfirm').value) { button.disabled = false; return P.toast('The new passwords do not match.', 'error'); }
    try {
      const response = await P.api('/api/auth/password-reset/complete', { method: 'POST', body: JSON.stringify({ resetToken: customerRecoveryState.resetToken, role: 'customer', newPassword: password }) });
      closeOverlay('customerRecoveryModal');
      showPhoneStep('password');
      P.toast(response.message || 'Password changed. Sign in now.', 'success');
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function registerCustomer(event) {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try {
      const response = await P.api('/api/auth/phone/register/customer', { method: 'POST', body: JSON.stringify({ registrationToken: authState.registrationToken, name: $('#authName').value, password: $('#authNewPassword').value, termsAccepted: $('#authTerms').checked }) });
      completeAuthentication(response);
    } catch (error) { P.toast(error.message, 'error'); }
    finally { submit.disabled = false; }
  }

  function openPreloginSupport() {
    supportAuthState = { challengeId: '', registrationToken: '' };
    $('#preloginSupportPhoneForm').reset(); $('#preloginSupportOtpForm').reset(); $('#preloginSupportIssueForm').reset();
    show('#preloginSupportPhoneForm'); show('#preloginSupportOtpForm', false); show('#preloginSupportIssueForm', false); show('#supportDevelopmentOtp', false);
    openOverlay('preloginSupportModal');
    setTimeout(() => $('#supportPhone').focus(), 60);
  }

  async function startPreloginSupport(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const phone = composedPhone('#supportCountry', '#supportPhone');
      supportAuthState = { phone, challengeId: '', registrationToken: '' };
      window.WMMsg91Otp?.reset();
      await sendMsg91Otp(phone);
      $('#supportPhonePreview').textContent = phone;
      show('#supportDevelopmentOtp', false);
      show('#preloginSupportPhoneForm', false); show('#preloginSupportOtpForm'); $('#supportOtp').focus();
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function verifyPreloginSupport(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const response = await verifyMsg91ForServer({ phone: supportAuthState.phone, role: 'customer', purpose: 'support', otp: $('#supportOtp').value });
      supportAuthState.registrationToken = response.supportToken;
      show('#preloginSupportOtpForm', false); show('#preloginSupportIssueForm'); $('#supportIssue').focus();
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function submitPreloginSupport(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const response = await P.api('/api/auth/support/submit', { method: 'POST', body: JSON.stringify({ registrationToken: supportAuthState.registrationToken, role: 'customer', issue: $('#supportIssue').value }) });
      closeOverlay('preloginSupportModal', false); P.toast(response.message || 'Login issue submitted.', 'success');
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  function completeAuthentication(response) {
    if (response.user?.role !== 'customer') throw new Error('This is not a customer account.');
    P.Store.token = response.token;
    me = response.user;
    closeOverlay('authModal', false);
    enterApp();
  }

  function togglePassword(button) {
    const input = document.getElementById(button.dataset.passwordToggle);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    button.textContent = input.type === 'password' ? 'Show' : 'Hide';
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try { await navigator.serviceWorker.register('service-worker.js?v=8.9.25', { updateViaCache: 'none' }); } catch {}
  }

  function syncInstallControls() {
    const installed = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
    $$('[data-install-app]').forEach((node) => node.classList.toggle('hidden', installed || !deferredInstallPrompt));
  }

  async function installApp() {
    if (!deferredInstallPrompt) return P.toast('Use your browser menu and choose “Add to Home screen”.', 'info');
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    syncInstallControls();
  }

  function bind() {
    $('#openAuth').onclick = openAuth;
    $$('[data-auth]').forEach((button) => { button.onclick = openAuth; });
    $('#authBegin').onclick = () => showPhoneStep('phone');
    $('#phoneStartForm').onsubmit = startPhone;
    $('#phonePasswordForm').onsubmit = passwordLogin;
    $('#customerForgotPassword').onclick = openCustomerRecovery;
    $('#phoneOtpForm').onsubmit = verifyOtp;
    $('#customerResendOtp').onclick = resendCustomerRegistrationOtp;
    $('#phoneDetailsForm').onsubmit = registerCustomer;
    $('#customerRecoveryPhoneForm').onsubmit = startCustomerRecovery;
    $('#customerRecoveryOtpForm').onsubmit = verifyCustomerRecovery;
    $('#customerRecoveryResendOtp').onclick = resendCustomerRecoveryOtp;
    $('#customerRecoveryPasswordForm').onsubmit = completeCustomerRecovery;
    $$('[data-auth-phone-back]').forEach((button) => { button.onclick = () => showPhoneStep('phone'); });
    $$('[data-password-toggle]').forEach((button) => { button.onclick = () => togglePassword(button); });
    $$('[data-close]').forEach((button) => { button.onclick = () => closeOverlay(button.dataset.close); });
    $$('[data-app-back]').forEach((button) => button.onclick = () => history.back());
    $('#appBackButton').onclick = () => history.back();
    $('#logoutBtn').onclick = () => logout();
    $('#tabs').onclick = (event) => { const button = event.target.closest('[data-tab]'); if (button) selectTab(button.dataset.tab); };
    $$('[data-jump]').forEach((button) => { button.onclick = () => selectTab(button.dataset.jump); });
    $('#refreshListeners').onclick = () => { loadDirectory(); socket?.emit('listeners:get'); };
    $('#randomConnectButton').onclick = requestRandomCall;
    $('#otherLanguageToggle').onchange = renderDirectory;
    $('#membershipCheckoutPay').onclick = beginMembershipCheckout;
    $('#couponForm').onsubmit = redeem;
    $('#supportForm').onsubmit = sendSupport;
    $('#passwordForm').onsubmit = changePassword;
    $('#readNotifications').onclick = markNotificationsRead;
    $('#directMessageForm').onsubmit = sendDirectMessage;
    $('#customerProfileForm').onsubmit = saveCustomerProfile;
    $('#toggleCustomerProfileEdit').onclick = () => {
      $('#customerProfileForm').classList.toggle('hidden');
      if (!$('#customerProfileForm').classList.contains('hidden')) $('#customerProfileName').focus();
    };
    $('#customerPhotoButton').onclick = () => $('#customerPhotoFile').click();
    $('#customerPhotoFile').onchange = chooseCustomerPhoto;
    $('#endCallBtn').onclick = () => socket?.emit('call:end', { callId: currentCall?.id });
    $('#minimizeCall').onclick = () => minimizeCall();
    $('#restoreCall').onclick = restoreCall;
    $('#muteBtn').onclick = toggleMute;
    $('#chatForm').onsubmit = sendCallChat;
    $('#reportCallBtn').onclick = () => currentCall && reportCall(currentCall.id);
    $('#callProfileButton').onclick = openCurrentCallProfile;
    $('#callFollowButton').onclick = () => currentCall?.employee?.id && toggleFollow(currentCall.employee.id, Boolean(currentCall.employee.following));
    $('#callSubscribeButton').onclick = () => currentCall?.employee?.id && subscribeToListener(currentCall.employee.id, $('#callSubscribeButton'));
    $('#preloginSupportButton').onclick = openPreloginSupport;
    $('#preloginSupportPhoneForm').onsubmit = startPreloginSupport;
    $('#preloginSupportOtpForm').onsubmit = verifyPreloginSupport;
    $('#preloginSupportIssueForm').onsubmit = submitPreloginSupport;
    $$('.legal-btn').forEach((button) => { button.onclick = () => loadLegal(button.dataset.legal); });
    document.addEventListener('click', handleActionClick);
    document.addEventListener('contextmenu', (event) => { if (event.target.closest('img,.protected-media,.exclusive-post')) event.preventDefault(); });
    document.addEventListener('dragstart', (event) => { if (event.target.closest('img,.protected-media')) event.preventDefault(); });
    document.addEventListener('copy', (event) => { if (me && !event.target.closest('input,textarea')) event.preventDefault(); });
    document.addEventListener('click', (event) => { if (event.target.closest('[data-install-app]')) installApp(); });
    window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstallPrompt = event; syncInstallControls(); });
  }

  async function handleActionClick(event) {
    if (event.target.closest('[data-close-customer-conversation]')) {
      activeConversation = null;
      $('.direct-message-layout')?.classList.remove('conversation-open');
      $('#directChat')?.classList.add('empty');
      show('#directMessageForm', false);
      renderConversations();
      return;
    }
    const postLike = event.target.closest('button[data-post-like]');
    if (postLike) return togglePostLike(postLike);
    const openPost = event.target.closest('button[data-open-customer-post]');
    if (openPost) return openCustomerPostFeed(openPost.dataset.openCustomerPost);
    const target = event.target.closest('button[data-listener-profile],button[data-follow],button[data-subscribe],button[data-listener-call],button[data-listener-message],button[data-buy-plan],button[data-conversation],button[data-cancel-subscription]');
    if (!target) return;
    const d = target.dataset;
    if (d.listenerProfile) return openListenerProfile(d.listenerProfile);
    if (d.follow) return toggleFollow(d.follow, d.following === 'true');
    if (d.subscribe) return subscribeToListener(d.subscribe, target);
    if (d.listenerCall) return requestCall(d.listenerCall);
    if (d.listenerMessage) return isActiveMember(d.listenerMessage)
      ? openConversation(d.listenerMessage)
      : subscribeToListener(d.listenerMessage, target);
    if (d.buyPlan) { event.preventDefault(); event.stopPropagation(); return openPayment(d.buyPlan, target); }
    if (d.conversation) return openConversation(d.conversation);
    if (d.cancelSubscription) return cancelSubscription(d.cancelSubscription);
  }

  async function togglePostLike(button) {
    const postId = button.dataset.postLike;
    const liked = button.dataset.liked === 'true';
    button.disabled = true;
    try {
      const response = await P.api(`/api/customer/listener-posts/${encodeURIComponent(postId)}/like`, {
        method: liked ? 'DELETE' : 'POST',
        body: '{}',
      });
      button.dataset.liked = String(response.liked);
      const saved = activeProfilePosts.find((post) => post.id === postId);
      if (saved) saved.liked = response.liked;
      $$(`button[data-post-like="${CSS.escape(postId)}"]`).forEach((control) => {
        control.dataset.liked = String(response.liked);
        control.classList.toggle('liked', response.liked);
        control.setAttribute('aria-pressed', String(response.liked));
        control.setAttribute('aria-label', `${response.liked ? 'Unlike' : 'Like'} this post`);
      });
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  function dailyShuffle(items) {
    const copy = [...items];
    const stamp = new Date().toISOString().slice(0, 10);
    let seed = [...stamp].reduce((n, char) => ((n * 33) ^ char.charCodeAt(0)) >>> 0, 5381);
    for (let i = copy.length - 1; i > 0; i--) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const j = seed % (i + 1); [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  async function loadPublicShowcase() {
    try {
      const response = await P.api('/api/public/showcase-images', { cache: 'no-store' });
      const images = dailyShuffle(Array.isArray(response.images) ? response.images : []);
      if (!images.length) return;
      const hero = $('#publicHeroListenerImage'); if (hero) hero.src = images[0];
      const frame = $('#publicListenerShowcase');
      if (frame) frame.innerHTML = Array.from({ length: Math.min(3, images.length) }, (_, index) => `<img src="${esc(images[index % images.length])}" alt="">`).join('');
    } catch {}
  }

  async function init() {
    initNavigation(); bind(); registerServiceWorker(); syncInstallControls(); initAutoHideHeader(); loadPublicShowcase();
    try { publicConfig = await P.api('/api/public/config'); } catch (error) { P.toast(error.message, 'error'); }
    if (P.Store.token) await loadMe();
  }

  async function loadMe() {
    try {
      const response = await P.api('/api/auth/me');
      if (response.user.role !== 'customer') throw new Error('Wrong portal for this account.');
      me = response.user; enterApp();
    } catch (error) { if (!P.isAuthError(error)) P.toast('The server is temporarily unavailable. Try again shortly.', 'error'); }
  }

  async function enterApp() {
    const wasSignedIn = document.body.classList.contains('signed-in');
    document.body.classList.add('signed-in');
    if (!wasSignedIn) sealCustomerAuthenticatedHistory();
    show('#landing', false); show('#dashboard'); show('#openAuth', false); show('#logoutBtn');
    $('#profileName').textContent = me.name || 'Customer';
    $('#customerProfileName').value = me.name || '';
    $('#customerProfileUsername').value = me.username || '';
    $('#profileUsernameText').textContent = me.username ? `@${me.username}` : 'Add a username';
    $('#profilePhoneText').textContent = me.phone || 'Private mobile';
    $('#profilePhone').textContent = me.phone || 'Private mobile';
    updateBalance(me.balanceSeconds);
    const requestedTab = activeTab;
    await Promise.allSettled([loadSubscriptions(false), loadDirectory(), loadConversations(), loadPlans(), loadHistory(), loadFollowing(), loadNotifications(), loadSupport(), loadCustomerPhoto()]);
    renderSubscriptions(); renderDirectory(); connectSocket();
    if (requestedTab !== 'home') selectTab(requestedTab, { historyMode: 'none' });
    clearInterval(directPollTimer);
    directPollTimer = window.setInterval(() => {
      if (activeTab !== 'messages') return;
      if (activeConversation) loadDirectMessages();
      else loadConversations(false);
    }, 8000);
    resetViewportTop();
  }

  async function logout(clear = true) {
    if (clear) P.Store.clear();
    clearInterval(directPollTimer);
    clearPendingCallRequest();
    currentCall = null;
    pendingMembershipCheckout = null;
    activeListenerProfileId = null;
    socket?.disconnect();
    audioCall?.stop();
    me = null;
    liveDirectoryReady = false;
    liveListeners = [];
    if (customerPhotoObjectUrl) URL.revokeObjectURL(customerPhotoObjectUrl);
    customerPhotoObjectUrl = '';
    document.body.classList.remove('signed-in', 'razorpay-open');
    show('#landing'); show('#dashboard', false); show('#openAuth'); show('#logoutBtn', false); show('#callModal', false); show('#restoreCall', false);
    activeTab = 'home'; document.querySelector('.topbar')?.classList.remove('topbar-hidden'); resetViewportTop(); history.replaceState({ marker: NAV_MARKER, tab: 'home', root: true }, document.title); history.pushState({ marker: NAV_MARKER, tab: 'home', guard: true }, document.title); syncBodyState();
  }

  function selectTab(tab, { historyMode = 'push' } = {}) {
    if (!VALID_TABS.has(tab)) tab = 'home';
    activeTab = tab;
    const parent = TAB_PARENT[tab] || tab;
    $$('#tabs [data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === parent));
    $$('.tab').forEach((node) => node.classList.toggle('active', node.id === `tab-${tab}`));
    if (historyMode === 'push') history.pushState({ marker: NAV_MARKER, tab }, document.title);
    if (tab === 'subscriptions') loadSubscriptions();
    if (tab === 'messages') loadConversations();
    if (tab === 'wallet') { loadPlans(); loadHistory(); }
    if (tab === 'history') loadHistory();
    if (tab === 'following') loadFollowing();
    if (tab === 'notifications') loadNotifications();
    if (tab === 'support') loadSupport();
    resetViewportTop(); document.querySelector('.topbar')?.classList.remove('topbar-hidden'); syncBodyState();
  }

  function updateBalance(value) {
    if (!me) return;
    me.balanceSeconds = Number(value) || 0;
    $('#walletBalance').textContent = P.duration(me.balanceSeconds);
  }

  async function loadDirectory() {
    if (!me) return;
    try { const response = await P.api('/api/customer/listeners', { cache: 'no-store' }); directory = response.listeners || []; renderDirectory(); }
    catch (error) { P.toast(error.message, 'error'); }
  }

  function renderDirectory() {
    const node = $('#listenerGrid');
    if (!node) return;
    const showOtherLanguages = Boolean($('#otherLanguageToggle')?.checked);
    const primaryListeners = randomizedListenerOrder(directory.filter((listener) => String(listener.language || 'Malayalam').trim().toLowerCase() === 'malayalam'));
    const otherListeners = randomizedListenerOrder(directory.filter((listener) => String(listener.language || 'Malayalam').trim().toLowerCase() !== 'malayalam'));
    $('#availabilityText').textContent = 'Listeners available';

    const cards = (listeners) => listeners.map((listener) => {
      const status = liveStatus(listener);
      const subscribed = isActiveMember(listener.id) || listener.subscribed;
      return `<article class="listener-card listener-card-v8"><button class="listener-card-open" data-listener-profile="${esc(listener.id)}" type="button" aria-label="Open ${esc(listener.name)} profile"><div class="listener-card-avatar"><img class="protected-media" src="${esc(listenerImage(listener))}" alt="${esc(listener.name)}" draggable="false"><i class="${status === 'available' ? 'online' : ''}"></i></div><div class="listener-card-copy"><span class="verified-listener-label">Verified listener</span><h3>${esc(listener.name)}</h3><p>${esc(listener.bio || 'Friendly listener')}</p><div class="listener-tags"><span>🎧 ${esc(listener.language || 'Malayalam')}</span><span class="listener-live ${esc(status)}"><i></i>${esc(statusLabel(status))}</span>${subscribed ? '<span class="exclusive-tag">Exclusive</span>' : ''}</div></div></button><div class="listener-card-actions"><button class="button button-soft" data-listener-profile="${esc(listener.id)}" type="button">Profile</button><button class="button button-primary" data-listener-call="${esc(listener.id)}" data-call-available="${status === 'available'}" type="button" ${status !== 'available' || pendingCallRequest || currentCall ? 'disabled' : ''}>Call</button></div></article>`;
    }).join('');

    node.innerHTML = primaryListeners.length ? cards(primaryListeners) : '';
    $('#otherLanguageGrid').innerHTML = otherListeners.length ? cards(otherListeners) : '';
    show('#listenerDiscovery');
    show('#otherLanguageSection', showOtherLanguages);
    syncCallRequestControls();
  }

  async function openListenerProfile(listenerId) {
    activeListenerProfileId = listenerId;
    activeProfileListener = null;
    releasePostUrls(); openOverlay('listenerProfileModal');
    $('#listenerProfileContent').innerHTML = '<div class="profile-loading"><span></span><p>Opening listener profile…</p></div>';
    try {
      const response = await P.api(`/api/customer/listeners/${encodeURIComponent(listenerId)}/profile`);
      const listener = response.listener;
      activeProfileListener = listener;
      const status = liveStatus(listener);
      const subscribed = Boolean(listener.subscribed || isActiveMember(listener.id));
      const postsMarkup = subscribed ? await renderPrivatePosts(response.posts || []) : response.postsLocked ? `<button class="locked-posts" data-subscribe="${esc(listener.id)}" type="button"><span class="lock-art">✦</span><b>See exclusive posts</b><small>Subscribe to ${esc(listener.name)} for ₹399/month</small></button>` : '<div class="profile-no-posts">No exclusive posts yet.</div>';
      const callButton = status === 'available'
        ? `<button class="listener-call-fab" data-listener-call="${esc(listener.id)}" data-call-available="true" type="button" aria-label="Call ${esc(listener.name)}" ${pendingCallRequest || currentCall ? 'disabled' : ''}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7.1 3.7 4.8 5.2c-.8.5-1.1 1.5-.8 2.4 2 6.4 6 10.4 12.4 12.4.9.3 1.9 0 2.4-.8l1.5-2.3c.4-.7.3-1.6-.3-2.1l-3-2.3c-.6-.5-1.4-.4-2 .1l-1.4 1.4a12 12 0 0 1-3.6-3.6L11.4 9c.5-.6.6-1.4.1-2l-2.3-3c-.5-.6-1.4-.7-2.1-.3Z"/></svg></button>`
        : '';
      $('#listenerProfileContent').innerHTML = `<div class="listener-profile-head"><div class="listener-profile-banner protected-media" style="--profile-banner:url('${esc(listenerImage(listener, 'banner'))}')"></div><div class="listener-profile-avatar"><img class="protected-media" src="${esc(listenerImage(listener))}" alt="${esc(listener.name)}" draggable="false"><i class="${status === 'available' ? 'online' : ''}"></i></div><div class="listener-profile-title"><div><span class="listener-live ${esc(status)}"><i></i>${esc(statusLabel(status))}</span><h2 id="listenerProfileName">${esc(listener.name)}</h2><p>${esc(listener.bio)}</p></div><button class="button button-soft profile-follow-button" data-follow="${esc(listener.id)}" data-following="${listener.following}" type="button">${listener.following ? 'Following' : 'Follow'}</button></div><div class="listener-profile-tags"><span>🎧 ${esc(listener.language)}</span><span>Verified profile</span></div><div class="listener-profile-actions"><button class="button button-soft" data-listener-message="${esc(listener.id)}" type="button">Message</button>${subscribed ? '<span class="member-confirmed">Exclusive active</span>' : `<button class="button button-soft subscribe-button" data-subscribe="${esc(listener.id)}" type="button">Exclusive · ₹399</button>`}</div><p class="call-wallet-note">Calls need only wallet talk-time. Exclusive unlocks posts and messages.</p></div><section class="exclusive-posts"><div class="exclusive-posts-head"><span>POSTS</span><small>${subscribed ? 'Exclusive access active' : 'Exclusive members only'}</small></div><div class="post-grid">${postsMarkup}</div></section>${callButton}`;
    } catch (error) { $('#listenerProfileContent').innerHTML = emptyState('Profile unavailable', error.message); }
  }

  async function renderPrivatePosts(posts) {
    activeProfilePosts = [];
    if (!posts.length) return '<div class="profile-no-posts">No exclusive posts yet.</div>';
    const items = await Promise.all(posts.map(async (post) => {
      try {
        const blob = await P.apiBlob(post.imageUrl);
        const url = URL.createObjectURL(blob);
        postObjectUrls.push(url);
        return {
          post: { ...post, image: url },
          markup: `<button class="exclusive-post protected-media" data-open-customer-post="${esc(post.id)}" type="button" aria-label="Open post"><img src="${esc(url)}" alt="Exclusive listener post" draggable="false"></button>`,
        };
      } catch { return null; }
    }));
    activeProfilePosts = items.filter(Boolean).map((item) => item.post);
    return items.filter(Boolean).map((item) => item.markup).join('') || '<div class="profile-no-posts">Posts could not be loaded.</div>';
  }

  function renderCustomerPostFeed() {
    const feed = $('#customerPostFeedList');
    if (!feed) return;
    feed.innerHTML = activeProfilePosts.map((post) => `<article class="customer-feed-post" data-customer-feed-post="${esc(post.id)}"><div class="customer-feed-media protected-media"><img src="${esc(post.image)}" alt="Exclusive listener post" draggable="false"></div><footer><p>${esc(post.caption || '')}</p><button class="customer-feed-like ${post.liked ? 'liked' : ''}" data-post-like="${esc(post.id)}" data-liked="${Boolean(post.liked)}" type="button" aria-label="${post.liked ? 'Unlike' : 'Like'} this post" aria-pressed="${Boolean(post.liked)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/></svg><span>${post.liked ? 'Liked' : 'Like'}</span></button></footer></article>`).join('');
    $('#customerPostFeedTitle').textContent = activeProfileListener?.name ? `${activeProfileListener.name}'s posts` : 'Posts';
  }

  function openCustomerPostFeed(postId) {
    if (!activeProfilePosts.some((post) => post.id === postId)) return;
    renderCustomerPostFeed();
    openOverlay('customerPostFeed');
    requestAnimationFrame(() => {
      document.querySelector(`[data-customer-feed-post="${CSS.escape(postId)}"]`)?.scrollIntoView({ block: 'start' });
    });
  }

  async function toggleFollow(listenerId, following) {
    try {
      const result = await P.api(`/api/customer/listeners/${encodeURIComponent(listenerId)}/follow`, { method: following ? 'DELETE' : 'POST', body: '{}' });
      const listener = directory.find((item) => item.id === listenerId); if (listener) listener.following = result.following;
      if (currentCall?.employee?.id === listenerId) currentCall.employee.following = result.following;
      $$(`[data-follow="${CSS.escape(listenerId)}"]`).forEach((button) => { button.dataset.following = String(result.following); button.textContent = result.following ? 'Following' : 'Follow'; });
      if (currentCall?.employee?.id === listenerId) $('#callFollowButton').textContent = result.following ? 'Following' : 'Follow';
      renderDirectory(); loadFollowing(false); P.toast(result.following ? 'Following listener.' : 'Listener unfollowed.', 'success');
    }
    catch (error) { P.toast(error.message, 'error'); }
  }

  async function loadSubscriptions(render = true) {
    if (!me) return;
    try { const response = await P.api('/api/customer/subscriptions'); subscriptions = response.subscriptions || []; if (render) renderSubscriptions(); renderDirectory(); }
    catch (error) { P.toast(error.message, 'error'); }
  }

  function renderSubscriptions() {
    const node = $('#subscriptionsList'); if (!node) return;
    node.innerHTML = subscriptions.length ? subscriptions.map((item) => `<article class="membership-card ${item.active ? 'active' : 'expired'}"><div class="membership-listener"><img src="${esc(listenerImage({ ...item, id: item.listenerId, profileImage: item.listenerImage }))}" alt=""><div><span>${item.active ? (item.accessSource === 'admin' ? 'ADMIN ACCESS' : 'ACTIVE AUTOPAY') : esc(String(item.status).toUpperCase())}</span><h3>${esc(item.listenerName)}</h3><p>${esc(item.language)}</p></div></div><div class="membership-date"><small>${item.active ? (item.accessSource === 'admin' ? 'Access' : 'Access until') : 'Last updated'}</small><strong>${item.accessSource === 'admin' && item.active ? 'Until admin removes it' : P.date(item.currentPeriodEnd)}</strong></div><div class="membership-actions"><button class="button button-soft" data-listener-profile="${esc(item.listenerId)}" type="button">View profile</button>${item.active ? `<button class="button button-primary" data-listener-message="${esc(item.listenerId)}" type="button">Message${item.unreadCount ? ` · ${item.unreadCount}` : ''}</button>` : ''}${item.accessSource === 'razorpay' && item.active && !item.cancelAtCycleEnd ? `<button class="text-action" data-cancel-subscription="${esc(item.id)}" type="button">Turn off renewal</button>` : item.accessSource === 'razorpay' && item.cancelAtCycleEnd ? '<small>Renewal is off</small>' : ''}</div></article>`).join('') : emptyState('No listener memberships yet', 'Open a listener profile and subscribe to unlock their exclusive posts and messages.');
  }

  const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

  async function refreshMembershipUntilActive(listenerId, attempts = 6) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await loadSubscriptions(false);
      if (isActiveMember(listenerId)) return true;
      if (attempt < attempts - 1) await wait(900 + attempt * 500);
    }
    return false;
  }

  async function verifyMembershipPayment(payment, listenerId) {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await P.api('/api/subscriptions/verify', {
          method: 'POST',
          timeout: 30000,
          body: JSON.stringify(payment),
        });
        if (!response?.pending) return response;
      } catch (error) {
        lastError = error;
        if (![409, 502].includes(error.status) && error.code !== 'NETWORK_ERROR' && error.code !== 'VERIFY_RETRY') throw error;
      }
      if (attempt < 4) await wait(900 + attempt * 700);
    }
    if (await refreshMembershipUntilActive(listenerId, 3)) {
      return { message: 'Exclusive membership is active.' };
    }
    throw lastError || new Error('Payment is still being confirmed. Open Exclusive and refresh in a moment.');
  }

  function loadRazorpayCheckout() {
    if (typeof window.Razorpay === 'function') return Promise.resolve(window.Razorpay);
    if (razorpayLoader) return razorpayLoader;
    razorpayLoader = new Promise((resolve, reject) => {
      document.querySelector('script[data-we-met-razorpay]')?.remove();
      const script = document.createElement('script');
      let timeout = 0;
      const cleanup = () => { clearTimeout(timeout); script.onload = null; script.onerror = null; };
      script.onload = () => {
        cleanup();
        if (typeof window.Razorpay === 'function') resolve(window.Razorpay);
        else reject(new Error('Secure checkout did not initialize. Please try again.'));
      };
      script.onerror = () => { cleanup(); script.remove(); reject(new Error('Secure checkout could not load. Check your connection and try again.')); };
      timeout = window.setTimeout(() => {
        cleanup();
        script.remove();
        reject(new Error('Secure checkout is taking too long to load. Please try again.'));
      }, 15000);
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      script.dataset.weMetRazorpay = 'true';
      document.head.appendChild(script);
    }).catch((error) => {
      razorpayLoader = null;
      throw error;
    });
    return razorpayLoader;
  }

  async function subscribeToListener(listenerId, button) {
    if (!me) {
      P.toast('Sign in before starting a subscription.', 'info');
      return setAuth('login');
    }
    const listener = directory.find((item) => item.id === listenerId) || { id: listenerId, name: 'this listener' };
    const originalLabel = button?.textContent || 'Subscribe';
    if (button) { button.disabled = true; button.textContent = 'Opening…'; }
    let handled = false;
    let failureShown = false;
    const restore = () => {
      if (button) { button.disabled = false; button.textContent = originalLabel; }
    };
    try {
      const order = await P.api('/api/subscriptions/create', {
        method: 'POST',
        body: JSON.stringify({ employeeId: listenerId }),
      });
      if (order?.processing) {
        if (button) button.textContent = 'Confirming…';
        const active = await refreshMembershipUntilActive(listenerId);
        restore();
        if (active) {
          await Promise.all([loadSubscriptions(), loadDirectory(), loadConversations()]);
          P.toast('Exclusive membership is active.', 'success');
          if (!$('#listenerProfileModal')?.classList.contains('hidden')) openListenerProfile(listenerId);
        } else {
          P.toast(order.message || 'Payment is still being confirmed. Refresh Exclusive in a moment.', 'info');
        }
        return;
      }
      if (!order?.key_id || !order?.subscription_id) throw new Error('Subscription checkout could not start. Please try again.');
      await loadRazorpayCheckout();
      if (typeof window.Razorpay !== 'function') throw new Error('Secure checkout could not load. Please try again.');

      const checkout = new window.Razorpay({
        key: order.key_id,
        subscription_id: order.subscription_id,
        name: 'We Met',
        description: `${order.listener?.name || listener.name} · Exclusive ₹399/month`,
        image: new URL('/shared/icon-192.png', location.href).href,
        redirect: false,
        handleback: true,
        prefill: {
          name: me.name || '',
          contact: me.phone || '',
        },
        theme: { color: '#f0448f', backdrop_color: '#0c0d10' },
        modal: {
          ondismiss: () => {
            restore();
            if (!handled && !failureShown) P.toast('Subscription checkout closed.', 'info');
          },
        },
        handler: async (payment) => {
          handled = true;
          try {
            const verified = await verifyMembershipPayment(payment, listenerId);
            await Promise.all([loadSubscriptions(), loadDirectory(), loadConversations()]);
            P.toast(verified.message || 'Exclusive membership is active.', 'success');
            if (!$('#listenerProfileModal')?.classList.contains('hidden')) openListenerProfile(listenerId);
          } catch (error) {
            P.toast(`${error.message}${payment?.razorpay_payment_id ? ` · Ref ${payment.razorpay_payment_id}` : ''}`, 'error');
          } finally {
            restore();
          }
        },
      });
      checkout.on('payment.failed', (response) => {
        failureShown = true;
        restore();
        P.toast(response?.error?.description || response?.error?.reason || 'Subscription payment failed. Try again.', 'error');
      });
      checkout.open();
    } catch (error) {
      restore();
      P.toast(error.message || 'Subscription checkout could not start. Please try again.', 'error');
    }
  }

  // Kept only for backwards compatibility with an already-open cached modal.
  async function beginMembershipCheckout() {
    if (!pendingMembershipCheckout?.listenerId) return;
    const pending = pendingMembershipCheckout;
    pendingMembershipCheckout = null;
    closeOverlay('membershipCheckoutModal', false);
    return subscribeToListener(pending.listenerId, pending.button);
  }

  async function cancelSubscription(id) {
    if (!confirm('Turn off automatic renewal? Your access continues until the paid period ends.')) return;
    try { const response = await P.api(`/api/subscriptions/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }); P.toast(response.message, 'success'); loadSubscriptions(); }
    catch (error) { P.toast(error.message, 'error'); }
  }

  async function loadConversations(render = true) {
    if (!me) return;
    try { const response = await P.api('/api/customer/conversations'); conversations = response.conversations || []; if (render) renderConversations(); }
    catch (error) { if (render) P.toast(error.message, 'error'); }
  }

  function renderConversations() {
    const layout = $('.direct-message-layout');
    const hasConversations = conversations.length > 0;
    layout?.classList.toggle('no-conversations', !hasConversations);
    if (!hasConversations) {
      activeConversation = null;
      layout?.classList.remove('conversation-open');
      $('#conversationList').innerHTML = '<div class="messages-empty"><span aria-hidden="true">♡</span><strong>No messages yet</strong><small>Exclusive conversations will appear here.</small></div>';
      $('#directChat').classList.add('empty');
      show('#directMessageForm', false);
      return;
    }
    $('#conversationList').innerHTML = conversations.map((item) => {
      const state = liveStatus(item);
      return `<button class="conversation-row ${activeConversation === item.listenerId ? 'active' : ''}" data-conversation="${esc(item.listenerId)}" type="button"><span class="conversation-avatar"><img class="protected-media" src="${esc(listenerImage({ ...item, id: item.listenerId, profileImage: item.listenerImage }))}" alt="" draggable="false"><i class="${state === 'available' ? 'online' : ''}"></i></span><span><b>${esc(item.listenerName)}</b><small>${esc(item.language || 'Malayalam')} · ${esc(statusLabel(state))}</small><em class="conversation-membership ${item.active ? 'active' : ''}">${item.active ? 'Member' : 'Ended'}</em></span>${item.unreadCount ? `<i>${item.unreadCount}</i>` : ''}</button>`;
    }).join('');
  }

  async function openConversation(listenerId) {
    closeOverlay('listenerProfileModal', false); selectTab('messages'); activeConversation = listenerId; renderConversations();
    const conversation = conversations.find((item) => item.listenerId === listenerId);
    if (!conversation?.active) { P.toast('Subscribe to this listener to send messages.', 'info'); return openListenerProfile(listenerId); }
    const state = liveStatus(conversation);
    $('.direct-message-layout')?.classList.add('conversation-open');
    $('#directChat').classList.remove('empty');
    $('#directChatHead').innerHTML = `<button class="conversation-mobile-back" data-close-customer-conversation type="button" aria-label="Back to messages">‹</button><span class="conversation-avatar chat-profile-avatar"><img class="protected-media" src="${esc(listenerImage({ ...conversation, id: conversation.listenerId, profileImage: conversation.listenerImage }))}" alt="" draggable="false"><i class="${state === 'available' ? 'online' : ''}"></i></span><div><strong>${esc(conversation.listenerName)}</strong><small>${esc(conversation.language || 'Malayalam')} · ${esc(statusLabel(state))}</small></div><button class="button button-quiet button-small" data-listener-profile="${esc(listenerId)}" type="button">Profile</button>`;
    show('#directMessageForm'); await loadDirectMessages();
  }

  async function loadDirectMessages() {
    if (!activeConversation) return;
    try { const response = await P.api(`/api/customer/conversations/${encodeURIComponent(activeConversation)}/messages`); $('#directMessages').innerHTML = response.messages.length ? response.messages.map((message) => `<div class="direct-bubble ${message.sender_id === me.id ? 'mine' : ''}"><p>${esc(message.message)}</p><small>${P.date(message.created_at)}</small></div>`).join('') : '<div class="chat-first-message">Say hello. Keep conversations respectful and private.</div>'; $('#directMessages').scrollTop = $('#directMessages').scrollHeight; loadConversations(false); }
    catch (error) { P.toast(error.message, 'error'); }
  }

  async function sendDirectMessage(event) {
    event.preventDefault(); const input = $('#directMessageInput'); const message = input.value.trim(); if (!message || !activeConversation) return; const submit = event.submitter; submit.disabled = true;
    try { await P.api(`/api/customer/conversations/${encodeURIComponent(activeConversation)}/messages`, { method: 'POST', body: JSON.stringify({ message }) }); input.value = ''; await loadDirectMessages(); }
    catch (error) { P.toast(error.message, 'error'); } finally { submit.disabled = false; }
  }

  async function loadPlans() {
    if (!me) return;
    try { const response = await P.api('/api/customer/plans', { cache: 'no-store' }); paymentPlans = response.plans || []; $('#walletPaymentIntro').textContent = 'Choose a talk-time pack.'; $('#plansGrid').innerHTML = paymentPlans.length ? paymentPlans.map((plan) => `<article class="wallet-plan-card ${plan.popular ? 'popular' : ''}">${plan.popular ? '<span class="popular-label">POPULAR</span>' : ''}<span class="wallet-plan-minutes"><b>${Math.round(plan.seconds / 60)}</b><small>min</small></span><span class="wallet-plan-name">${esc(plan.name)}</span><strong class="wallet-plan-price">${P.money(plan.price_paise)}</strong><button class="button button-primary" data-buy-plan="${esc(plan.id)}" type="button">Pay ${P.money(plan.price_paise)}</button></article>`).join('') : emptyState('No talk-time packs', 'Talk-time packs will appear here.'); }
    catch (error) { P.toast(error.message, 'error'); }
  }

  async function openPayment(planId, button = null) {
    if (!me) {
      P.toast('Sign in before starting a payment.', 'info');
      return setAuth('login');
    }
    const plan = paymentPlans.find((item) => item.id === planId);
    if (!plan) return P.toast('This talk-time pack is unavailable.', 'error');

    const originalLabel = button?.textContent || `Pay ${P.money(plan.price_paise)}`;
    if (button) { button.disabled = true; button.textContent = 'Opening…'; }
    let paymentHandled = false;
    let paymentFailureShown = false;
    const restore = () => {
      activeWalletCheckout = null;
      if (button) { button.disabled = false; button.textContent = originalLabel; }
    };

    try {
      await loadRazorpayCheckout();
      if (typeof window.Razorpay !== 'function') throw new Error('Secure checkout could not load. Check your connection and try again.');
      const order = await P.api('/api/create-order', {
        method: 'POST',
        body: JSON.stringify({
          planId: plan.id,
          amount: Number(plan.price_paise),
          currency: 'INR',
          receipt: `checkout_${Date.now()}`,
        }),
      });
      if (!order?.order_id || !order?.key_id) throw new Error('Secure payment could not start. Please try again.');

      const checkout = new window.Razorpay({
        key: order.key_id,
        amount: order.amount,
        currency: order.currency,
        name: publicConfig?.appName || 'We Met',
        description: `${plan.name} · ${Math.round(Number(plan.seconds) / 60)} minutes`,
        image: new URL('/shared/icon-192.png', window.location.href).href,
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
            restore();
            if (!paymentHandled && !paymentFailureShown) {
              P.toast('Payment cancelled. No talk-time was added.', 'info');
            }
          },
        },
        handler: async (payment) => {
          paymentHandled = true;
          try {
            const verified = await P.api('/api/verify-payment', {
              method: 'POST',
              timeout: 30000,
              body: JSON.stringify(payment),
            });
            updateBalance(verified.balance_seconds);
            await loadHistory();
            P.toast(verified.message || 'Payment verified and talk-time added.', 'success');
          } catch (error) {
            const reference = payment?.razorpay_payment_id || 'unavailable';
            P.toast(`${error.message || 'Payment verification failed.'} Payment reference: ${reference}`, 'error');
          } finally {
            restore();
          }
        },
      });
      checkout.on('payment.failed', (response) => {
        paymentFailureShown = true;
        restore();
        const reason = response?.error?.description || response?.error?.reason || 'Payment failed. Try again.';
        P.toast(reason, 'error');
      });
      activeWalletCheckout = checkout;
      checkout.open();
    } catch (error) {
      restore();
      P.toast(error.message || 'The Razorpay checkout could not be prepared.', 'error');
    }
  }

  async function redeem(event) {
    event.preventDefault();
    try { const response = await P.api('/api/customer/redeem', { method: 'POST', body: JSON.stringify({ code: $('#couponCode').value }) }); updateBalance(response.balanceSeconds); event.target.reset(); loadHistory(); P.toast('Talk-time added.', 'success'); }
    catch (error) { P.toast(error.message, 'error'); }
  }

  async function connectSocket() {
    socket?.disconnect();
    try { await window.SocketIOReady; } catch (error) { return P.toast(error.message, 'error'); }
    socket = io(P.socketUrl, { auth: { token: P.Store.token }, transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelayMax: 10000 });
    audioCall = new AudioCall({ socket, iceServers: publicConfig?.iceServers || [], remoteAudio: $('#remoteAudio'), onState: (state) => {
      if (!currentCall) return;
      if (state === 'connected' && currentCall.mediaConnected !== true) { currentCall.mediaConnected = true; socket.emit('call:media-state', { callId: currentCall.id, connected: true }); }
      if (['failed', 'disconnected', 'closed'].includes(state) && currentCall.mediaConnected !== false) { currentCall.mediaConnected = false; socket.emit('call:media-state', { callId: currentCall.id, connected: false }); $('#callState').textContent = 'Audio reconnecting…'; }
    } });
    socket.on('connect', () => {
      socket.emit('listeners:get');
      if (currentCall?.id) {
        socket.emit('call:resume', { callId: currentCall.id }, (response) => {
          if (!response?.ok && currentCall) $('#callState').textContent = 'Reconnecting call…';
        });
      }
    });
    socket.on('disconnect', () => {
      liveDirectoryReady = false;
      // Do not tear down an established WebRTC peer just because Socket.IO is
      // reconnecting. The audio path can remain alive while signaling recovers.
      if (currentCall) {
        $('#callState').textContent = 'Reconnecting call controls…';
        P.toast('Call controls are reconnecting. Keep this page open.', 'info');
      } else if (pendingCallRequest) {
        P.toast('Calling is reconnecting. Please wait a moment.', 'info');
      }
      renderDirectory();
    });
    socket.on('listeners:update', ({ listeners = [] }) => {
      liveListeners = listeners;
      liveDirectoryReady = true;
      for (const live of listeners) {
        const saved = directory.find((item) => item.id === live.id);
        if (!saved) continue;
        saved.name = live.name || saved.name;
        saved.bio = live.bio || saved.bio;
        saved.profileImage = live.avatar || saved.profileImage;
        saved.bannerImage = live.banner || saved.bannerImage;
        saved.language = live.language || saved.language;
        saved.updatedAt = live.updatedAt || saved.updatedAt;
      }
      renderDirectory();
    });
    socket.on('listener:profile-updated', ({ listener = {} } = {}) => {
      if (!listener.id) return;
      const saved = directory.find((item) => item.id === listener.id);
      if (saved) {
        saved.name = listener.name || saved.name;
        saved.bio = listener.bio ?? saved.bio;
        saved.profileImage = listener.avatar ?? saved.profileImage;
        saved.bannerImage = listener.banner ?? saved.bannerImage;
        saved.language = listener.language || saved.language;
        saved.updatedAt = listener.updatedAt || new Date().toISOString();
        renderDirectory();
      }
      if (activeListenerProfileId === listener.id && !$('#listenerProfileModal').classList.contains('hidden')) {
        openListenerProfile(listener.id);
      }
    });
    socket.on('call:ringing', (data) => {
      clearPendingCallRequest();
      currentCall = { id: data.callId, employee: data.employee, billed: 0, mediaConnected: false };
      closeOverlay('listenerProfileModal', false);
      openCall();
      $('#callState').textContent = `Ringing ${data.employee?.name || 'listener'}…`;
      syncCallRequestControls();
    });
    socket.on('call:retrying', (data) => { $('#callState').textContent = 'Trying another available listener…'; P.toast(data.reason || 'The listener did not answer.', 'info'); });
    socket.on('call:unavailable', (data) => { clearPendingCallRequest(); if (currentCall) closeCall(); P.toast(data.message || 'No listener is available right now.', 'info'); });
    socket.on('call:error', (data) => { clearPendingCallRequest(); if (currentCall) closeCall(); P.toast(data.message || 'The call could not start.', 'error'); if (data.needsTopup) selectTab('wallet'); });
    socket.on('call:accepted', async (data) => {
      if (!currentCall) currentCall = { id: data.callId };
      if (data.employee?.id) {
        const saved = directory.find((item) => item.id === data.employee.id);
        currentCall.employee = { ...(saved || {}), ...data.employee };
        $('#callPerson').textContent = currentCall.employee.name || 'Listener';
        $('#callBio').textContent = currentCall.employee.bio || 'A private conversation';
        $('#callAvatarImage').src = listenerImage(currentCall.employee);
        const callShell = $('#callModal .call-shell');
        if (callShell) callShell.style.setProperty('--call-profile-bg', `url("${listenerImage(currentCall.employee, 'banner')}")`);
        show('#callProfileButton', true);
        show('#callFollowButton', true);
        show('#callSubscribeButton', !isActiveMember(currentCall.employee.id) && !currentCall.employee.subscribed);
        $('#callFollowButton').textContent = currentCall.employee.following ? 'Following' : 'Follow';
      }
      currentCall.mediaConnected = false;
      $('#callState').textContent = 'Preparing microphone…';
      try {
        await audioCall.prepare(data.callId);
        if (currentCall?.id === data.callId) {
          $('#callState').textContent = 'Connecting secure audio…';
          socket.emit('webrtc:ready', { callId: data.callId });
        }
      } catch (error) {
        P.toast(error.message || 'Allow microphone access.', 'error');
        socket.emit('call:end', { callId: data.callId });
      }
    });
    socket.on('webrtc:start', async ({ callId }) => { if (currentCall?.id === callId) { try { await audioCall.createOffer(); } catch { socket.emit('call:end', { callId }); } } });
    socket.on('call:resumed', ({ callId, state } = {}) => {
      if (!currentCall || currentCall.id !== callId) return;
      audioCall?.resumeRemoteAudio?.();
      $('#callState').textContent = state === 'active' ? 'Connected · wallet billing active' : 'Reconnecting secure audio…';
      if (currentCall.mediaConnected) socket.emit('call:media-state', { callId, connected: true });
    });
    socket.on('call:connected', () => { if (currentCall) { $('#callState').textContent = 'Connected · wallet billing active'; P.notify('We Met', 'Your private call is connected.'); } });
    socket.on('call:audio-paused', () => { if (currentCall) $('#callState').textContent = 'Audio paused · wallet billing paused'; });
    socket.on('call:audio-restored', () => { if (currentCall) $('#callState').textContent = 'Connected · wallet billing active'; });
    socket.on('call:tick', (data) => { if (currentCall?.id === data.callId) { $('#callTimer').textContent = P.duration(data.billedSeconds); $('#restoreTimer').textContent = P.duration(data.billedSeconds); updateBalance(data.balanceSeconds); } });
    socket.on('call:low-balance', () => P.notify('Low talk-time', 'Only one minute remains in your wallet.'));
    socket.on('call:ended', (data) => { clearPendingCallRequest(); if (currentCall) closeCall(); P.toast(data.reason || 'The call ended.', data.needsTopup ? 'error' : 'info'); loadMe(); if (data.needsTopup) selectTab('wallet'); });
    socket.on('chat:message', addCallChat);
    socket.on('notification:new', (notification) => { P.notify(notification.title, notification.body); loadSubscriptions(false); loadConversations(false); });
    socket.on('account:restricted', (data) => { P.toast(data.reason || 'Account restricted.', 'error'); logout(); });
  }

  async function requestCall(listenerId) {
    audioCall?.resumeRemoteAudio?.();
    const listener = directory.find((item) => item.id === listenerId);
    if ((me?.balanceSeconds || 0) < (publicConfig?.minimumStartSeconds || 1)) { P.toast('Add talk-time before calling.', 'info'); return selectTab('wallet'); }
    if (liveStatus(listener || { id: listenerId }) !== 'available') return P.toast('This listener is not online right now.', 'info');
    if (!socket?.connected) return P.toast('Calling is reconnecting. Try again shortly.', 'error');
    if (currentCall || pendingCallRequest) return P.toast('A call request is already in progress.', 'info');
    try {
      await audioCall.ensureMedia();
    } catch (error) {
      return P.toast(error.message || 'Allow microphone access before calling.', 'error');
    }
    beginCallRequest({ employeeId: listenerId, allowOtherLanguages: false });
  }

  async function requestRandomCall() {
    audioCall?.resumeRemoteAudio?.();
    if ((me?.balanceSeconds || 0) < (publicConfig?.minimumStartSeconds || 1)) { P.toast('Add talk-time before calling.', 'info'); return selectTab('wallet'); }
    if (!socket?.connected) return P.toast('Calling is reconnecting. Try again shortly.', 'error');
    if (currentCall || pendingCallRequest) return P.toast('A call request is already in progress.', 'info');
    try {
      await audioCall.ensureMedia();
    } catch (error) {
      return P.toast(error.message || 'Allow microphone access before calling.', 'error');
    }
    beginCallRequest({ employeeId: null, allowOtherLanguages: Boolean($('#otherLanguageToggle')?.checked) });
  }

  function syncCallRequestControls() {
    const locked = Boolean(pendingCallRequest || currentCall);
    const randomButton = $('#randomConnectButton');
    if (randomButton) {
      randomButton.disabled = locked;
      randomButton.textContent = pendingCallRequest ? 'Checking availability…' : currentCall ? 'Call in progress' : 'Connect now';
    }
    $$('[data-listener-call]').forEach((button) => {
      button.disabled = locked || button.dataset.callAvailable === 'false';
    });
  }

  function clearPendingCallRequest() {
    if (pendingCallRequest?.timer) clearTimeout(pendingCallRequest.timer);
    pendingCallRequest = null;
    if (!currentCall) audioCall?.stop?.();
    syncCallRequestControls();
    syncBodyState();
  }

  function beginCallRequest(payload) {
    const request = { employeeId: payload.employeeId || null, timer: null };
    pendingCallRequest = request;
    syncBodyState();
    request.timer = setTimeout(() => {
      if (pendingCallRequest !== request || currentCall) return;
      clearPendingCallRequest();
      P.toast('Calling took too long to respond. Please try again.', 'error');
    }, 15_000);
    syncCallRequestControls();
    socket.timeout(12_000).emit('call:request', payload, (timeoutError, response) => {
      if (pendingCallRequest !== request || currentCall) return;
      if (timeoutError) {
        clearPendingCallRequest();
        return P.toast('Calling is taking too long. Please try again.', 'error');
      }
      if (response?.ok) return;
      clearPendingCallRequest();
      if (response?.needsTopup) selectTab('wallet');
      if (response?.error || response?.message) P.toast(response.error || response.message, response?.unavailable ? 'info' : 'error');
    });
  }

  function openCall() {
    openOverlay('callModal'); show('#restoreCall', false); $('#callPerson').textContent = currentCall.employee?.name || 'Listener'; $('#callBio').textContent = currentCall.employee?.bio || 'A private conversation'; $('#callTimer').textContent = '0:00'; $('#restoreTimer').textContent = '0:00'; $('#chatMessages').innerHTML = '<div class="bubble">Private call chat starts here.</div>';
    const employee = directory.find((item) => item.id === currentCall.employee?.id) || currentCall.employee;
    if (employee?.id) currentCall.employee = { ...employee, ...currentCall.employee, following: Boolean(employee.following) };
    $('#callAvatarImage').src = employee?.id ? listenerImage(employee) : '/shared/logo.svg';
    const callShell = $('#callModal .call-shell');
    if (callShell) callShell.style.setProperty('--call-profile-bg', `url("${employee?.id ? listenerImage(employee, 'banner') : '/shared/default-listener-banner.png'}")`);
    show('#callProfileButton', Boolean(employee?.id)); show('#callFollowButton', Boolean(employee?.id)); show('#callSubscribeButton', Boolean(employee?.id) && !isActiveMember(employee.id) && !employee.subscribed);
    if (employee?.id) $('#callFollowButton').textContent = employee.following ? 'Following' : 'Follow';
  }

  function openCurrentCallProfile() {
    const listenerId = currentCall?.employee?.id;
    if (!listenerId) return;
    minimizeCall(false);
    openListenerProfile(listenerId);
  }
  function minimizeCall(useHistory = true) { if (!currentCall) return; if (useHistory && history.state?.overlay === 'callModal') return history.back(); show('#callModal', false); show('#restoreCall'); syncBodyState(); }
  function restoreCall() { if (currentCall) { openOverlay('callModal'); show('#restoreCall', false); } }
  function closeCall() { show('#callModal', false); show('#restoreCall', false); audioCall?.stop(); currentCall = null; if (history.state?.marker === NAV_MARKER && history.state.overlay === 'callModal') history.replaceState({ marker: NAV_MARKER, tab: activeTab }, document.title); syncBodyState(); syncCallRequestControls(); }
  function toggleMute() { const muted = audioCall?.toggleMute(); $('#muteBtn small').textContent = muted ? 'Unmute' : 'Mute'; }
  function sendCallChat(event) { event.preventDefault(); const message = $('#chatInput').value.trim(); if (!message || !currentCall) return; socket.emit('chat:send', { callId: currentCall.id, message }); $('#chatInput').value = ''; }
  function addCallChat(message) { if (currentCall?.id !== message.callId) return; $('#chatMessages').insertAdjacentHTML('beforeend', `<div class="bubble ${message.senderId === me.id ? 'mine' : ''}"><b>${esc(message.senderName)}</b><br>${esc(message.message)}</div>`); }

  async function loadHistory() {
    if (!me) return;
    try { const response = await P.api('/api/customer/history'); $('#callHistory').innerHTML = response.calls?.length ? response.calls.map((call) => `<article class="list-item"><div><strong>${esc(call.employee_name)}</strong><p>${P.date(call.created_at)} · ${P.duration(call.billed_seconds)}</p></div><button class="button button-quiet" data-listener-profile="${esc(call.employee_id)}">Profile</button></article>`).join('') : emptyState('No calls yet', 'Your private call history appears here.'); $('#walletHistory').innerHTML = response.wallet?.length ? response.wallet.map((entry) => `<article class="list-item"><div><strong>${entry.seconds_delta > 0 ? '+' : '−'}${P.duration(Math.abs(entry.seconds_delta))}</strong><p>${esc(entry.note || entry.type)}</p></div><small>${P.date(entry.created_at)}</small></article>`).join('') : emptyState('No wallet activity', 'Top-ups and call charges appear here.'); }
    catch (error) { P.toast(error.message, 'error'); }
  }

  async function loadFollowing(render = true) {
    if (!me) return;
    try { const response = await P.api('/api/customer/following'); followingListeners = response.listeners || []; if (render) $('#followingList').innerHTML = followingListeners.length ? followingListeners.map((item) => `<article class="mini-listener"><span class="conversation-avatar"><img class="protected-media" src="${esc(listenerImage(item))}" alt="" draggable="false"><i class="${liveStatus(item) === 'available' ? 'online' : ''}"></i></span><div><strong>${esc(item.name)}</strong><small>${esc(item.language || 'Malayalam')} · ${esc(statusLabel(liveStatus(item)))}</small></div><button class="button button-soft" data-listener-profile="${esc(item.id)}">Profile</button></article>`).join('') : emptyState('Not following anyone yet', 'Tap Follow on any listener profile.'); }
    catch (error) { P.toast(error.message, 'error'); }
  }
  async function loadNotifications() { if (!me) return; try { const response = await P.api('/api/customer/notifications'); $('#notificationsList').innerHTML = response.notifications?.length ? response.notifications.map((n) => `<article class="list-item"><div><strong>${esc(n.title)}</strong><p>${esc(n.body)}</p></div><small>${P.date(n.created_at)}</small></article>`).join('') : emptyState('No notifications', 'Account and payment updates appear here.'); } catch (error) { P.toast(error.message, 'error'); } }
  async function markNotificationsRead() { try { await P.api('/api/customer/notifications/read', { method: 'POST', body: '{}' }); loadNotifications(); } catch (error) { P.toast(error.message, 'error'); } }
  async function loadSupport() { if (!me) return; try { const r = await P.api('/api/customer/support'); $('#supportList').innerHTML = r.tickets?.length ? r.tickets.map((t) => `<article class="list-item"><div><strong>${esc(t.subject)}</strong><p>${esc(t.message)}</p>${t.admin_reply ? `<p><b>Reply:</b> ${esc(t.admin_reply)}</p>` : ''}</div><span>${esc(t.status)}</span></article>`).join('') : emptyState('No support messages', 'Messages to the team appear here.'); } catch {} }
  async function sendSupport(event) { event.preventDefault(); try { await P.api('/api/customer/support', { method: 'POST', body: JSON.stringify({ subject: $('#supportSubject').value, message: $('#supportMessage').value }) }); event.target.reset(); loadSupport(); P.toast('Message sent.', 'success'); } catch (error) { P.toast(error.message, 'error'); } }

  async function chooseCustomerPhoto(event) {
    const file = event.target.files?.[0]; if (!file) return;
    const button = $('#customerPhotoButton');
    button.disabled = true;
    button.classList.add('uploading');
    try {
      customerPhotoDraft = await compressPhoto(file);
      $('#customerPhotoPreview').src = customerPhotoDraft;
      const response = await P.api('/api/customer/profile', { method: 'PATCH', body: JSON.stringify({ name: me.name, username: me.username || '', profileImage: customerPhotoDraft }) });
      me.profileImage = response.user.profileImage;
      customerPhotoDraft = undefined;
      await loadCustomerPhoto();
      P.toast('Profile photo updated.', 'success');
    } catch (error) {
      customerPhotoDraft = undefined;
      await loadCustomerPhoto();
      P.toast(error.message, 'error');
    } finally {
      button.disabled = false;
      button.classList.remove('uploading');
      event.target.value = '';
    }
  }
  async function compressPhoto(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Choose a JPG, PNG or WebP photo smaller than 5 MB.');
    const url = URL.createObjectURL(file);
    try { const image = new Image(); await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; }); const size = 560; const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size; const ctx = canvas.getContext('2d'); const crop = Math.min(image.naturalWidth, image.naturalHeight); ctx.drawImage(image, (image.naturalWidth - crop) / 2, (image.naturalHeight - crop) / 2, crop, crop, 0, 0, size, size); const result = canvas.toDataURL('image/jpeg', 0.84); if (result.length > 610000) throw new Error('Choose a simpler or smaller photo.'); return result; }
    finally { URL.revokeObjectURL(url); }
  }
  async function saveCustomerProfile(event) { event.preventDefault(); try { const response = await P.api('/api/customer/profile', { method: 'PATCH', body: JSON.stringify({ name: $('#customerProfileName').value, username: $('#customerProfileUsername').value }) }); me.name = response.user.name; me.username = response.user.username; me.profileImage = response.user.profileImage; $('#profileName').textContent = me.name; $('#profileUsernameText').textContent = me.username ? `@${me.username}` : 'Add a username'; $('#customerProfileForm').classList.add('hidden'); P.toast('Profile updated.', 'success'); } catch (error) { P.toast(error.message, 'error'); } }
  async function loadCustomerPhoto() {
    if (customerPhotoObjectUrl) URL.revokeObjectURL(customerPhotoObjectUrl);
    customerPhotoObjectUrl = '';
    $('#customerPhotoPreview').src = 'assets/profile-placeholder.svg';
    if (!me?.profileImage?.startsWith('photo:')) return;
    try {
      const blob = await P.apiBlob('/api/customer/profile/image');
      customerPhotoObjectUrl = URL.createObjectURL(blob);
      $('#customerPhotoPreview').src = customerPhotoObjectUrl;
    } catch {}
  }
  async function changePassword(event) { event.preventDefault(); try { await P.api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: $('#currentPassword').value, newPassword: $('#newPassword').value }) }); P.toast('Password updated. Please sign in again.', 'success'); setTimeout(() => logout(), 700); } catch (error) { P.toast(error.message, 'error'); } }
  async function reportCall(id) { const reason = prompt('Describe the issue for the safety team:'); if (!reason) return; try { await P.api('/api/customer/reports', { method: 'POST', body: JSON.stringify({ callId: id, reason, details: reason }) }); P.toast('Report sent.', 'success'); } catch (error) { P.toast(error.message, 'error'); } }
  async function loadLegal(type) { try { const response = await P.api(`/api/public/legal/${type}`); $('#legalTitle').textContent = ({ terms: 'Terms and Conditions', privacy: 'Privacy Policy', refund: 'Refund Policy', safety: 'Safety Centre' })[type] || 'Policy'; $('#legalBody').textContent = response.body; openOverlay('legalModal'); } catch (error) { P.toast(error.message, 'error'); } }

  init();
})();
