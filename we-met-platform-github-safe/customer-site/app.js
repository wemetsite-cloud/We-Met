(() => {
  'use strict';

  const P = window.Portal;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const show = (selector, visible = true) => $(selector)?.classList.toggle('hidden', !visible);
  const esc = P.esc;
  const NAV_MARKER = 'we-met-customer-v82';
  const VALID_TABS = new Set(['home', 'subscriptions', 'messages', 'wallet', 'profile', 'history', 'following', 'notifications', 'support']);
  const TAB_PARENT = { history: 'profile', following: 'profile', notifications: 'profile', support: 'profile' };

  let me = null;
  let publicConfig = null;
  let socket = null;
  let audioCall = null;
  let currentCall = null;
  let directory = [];
  let liveListeners = [];
  let subscriptions = [];
  let conversations = [];
  let activeConversation = null;
  let activeTab = 'home';
  let paymentPlans = [];
  let followingListeners = [];
  let authState = { phone: '', challengeId: '', registrationToken: '' };
  let supportAuthState = { challengeId: '', registrationToken: '' };
  let postObjectUrls = [];
  let customerPhotoDraft;
  let deferredInstallPrompt = null;
  let directPollTimer = null;
  let pendingWalletCheckout = null;
  let pendingMembershipCheckout = null;

  window.addEventListener('portal:session-invalid', (event) => {
    P.toast(event.detail?.message || 'Your session expired. Please start again.', 'error');
    setTimeout(() => logout(false), 0);
  });

  function emptyState(title, message) {
    return `<div class="panel empty-state"><img src="assets/logo.svg" alt=""><h3>${esc(title)}</h3><p>${esc(message)}</p></div>`;
  }

  function listenerImage(listener, kind = 'profile') {
    const reference = String(kind === 'banner' ? listener.bannerImage || listener.banner || listener.banner_image || '' : listener.profileImage || listener.listenerImage || listener.avatar || listener.profile_image || '');
    if (/^avatar-(0[1-9]|1[0-9]|20)\.svg$/.test(reference)) return `assets/${reference}`;
    if (reference.startsWith('photo:')) {
      const endpoint = kind === 'banner' ? 'listener-banner-image' : 'listener-profile-image';
      return `${P.base}/api/public/${endpoint}/${encodeURIComponent(listener.id || listener.listenerId)}`;
    }
    const seed = String(listener.id || listener.listenerId || listener.name || 'listener');
    let total = 0;
    for (const char of seed) total += char.charCodeAt(0);
    return `assets/avatar-${String((total % 20) + 1).padStart(2, '0')}.svg`;
  }

  function liveStatus(listener) {
    const live = liveListeners.find((item) => item.id === (listener.id || listener.listenerId));
    if (live) return live.status || 'offline';
    const value = listener.availability || listener.listener_availability || 'offline';
    return value === 'online' ? 'available' : value;
  }

  function statusLabel(status) {
    return ({ available: 'Online', online: 'Online', busy: 'In a call', ringing: 'Ringing', break: 'On a break', offline: 'Offline' })[status] || 'Offline';
  }

  function isActiveMember(listenerId) {
    return subscriptions.some((item) => item.listenerId === listenerId && item.active)
      || directory.some((item) => item.id === listenerId && item.subscribed);
  }

  function currentOverlay() {
    return ['listenerProfileModal', 'authModal', 'preloginSupportModal', 'legalModal', 'walletCheckoutModal', 'membershipCheckoutModal', 'callModal'].find((id) => !document.getElementById(id)?.classList.contains('hidden')) || null;
  }

  function syncBodyState() {
    document.body.classList.toggle('modal-open', Boolean(currentOverlay()));
    $('#appBackButton')?.classList.toggle('hidden', !(currentOverlay() || (me && activeTab !== 'home')));
  }

  function openOverlay(id) {
    const node = document.getElementById(id);
    if (!node) return;
    const opening = node.classList.contains('hidden');
    node.classList.remove('hidden');
    if (opening) history.pushState({ marker: NAV_MARKER, tab: activeTab, overlay: id }, document.title);
    syncBodyState();
  }

  function closeOverlay(id, useHistory = true) {
    if (useHistory && history.state?.marker === NAV_MARKER && history.state.overlay === id) return history.back();
    document.getElementById(id)?.classList.add('hidden');
    if (id === 'listenerProfileModal') releasePostUrls();
    syncBodyState();
  }

  function releasePostUrls() {
    postObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    postObjectUrls = [];
  }

  function initNavigation() {
    history.replaceState({ marker: NAV_MARKER, tab: 'home' }, document.title);
    window.addEventListener('popstate', (event) => {
      const state = event.state?.marker === NAV_MARKER ? event.state : { tab: 'home' };
      ['authModal', 'preloginSupportModal', 'listenerProfileModal', 'legalModal', 'walletCheckoutModal', 'membershipCheckoutModal'].forEach((id) => document.getElementById(id)?.classList.add('hidden'));
      if (!$('#callModal')?.classList.contains('hidden') && currentCall) minimizeCall(false);
      if (me) selectTab(state.tab || 'home', { historyMode: 'none' });
      releasePostUrls();
      syncBodyState();
    });
  }

  function showPhoneStep(step) {
    $$('.phone-auth-step').forEach((section) => section.classList.toggle('active', section.dataset.phoneStep === step));
    const progress = { welcome: 0, phone: 18, password: 100, otp: 52, details: 100 }[step] || 0;
    $('#authProgressFill').style.width = `${progress}%`;
    setTimeout(() => $(`[data-phone-step="${step}"] input`)?.focus(), 60);
  }

  function openAuth() {
    authState = { phone: '', challengeId: '', registrationToken: '' };
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
      if (response.mode === 'password') showPhoneStep('password');
      else {
        authState.challengeId = response.challengeId;
        if (response.developmentOtp) { $('#developmentOtp').textContent = `Development OTP: ${response.developmentOtp}`; show('#developmentOtp'); }
        showPhoneStep('otp');
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
      const response = await P.api('/api/auth/phone/verify', { method: 'POST', body: JSON.stringify({ challengeId: authState.challengeId, otp: $('#authOtp').value }) });
      authState.registrationToken = response.registrationToken;
      showPhoneStep('details');
    } catch (error) { P.toast(error.message, 'error'); }
    finally { submit.disabled = false; }
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
      const response = await P.api('/api/auth/support/phone/start', { method: 'POST', body: JSON.stringify({ phone }) });
      supportAuthState.challengeId = response.challengeId;
      $('#supportPhonePreview').textContent = response.phone;
      if (response.developmentOtp) { $('#supportDevelopmentOtp').textContent = `Development OTP: ${response.developmentOtp}`; show('#supportDevelopmentOtp'); }
      show('#preloginSupportPhoneForm', false); show('#preloginSupportOtpForm'); $('#supportOtp').focus();
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function verifyPreloginSupport(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const response = await P.api('/api/auth/phone/verify', { method: 'POST', body: JSON.stringify({ challengeId: supportAuthState.challengeId, otp: $('#supportOtp').value }) });
      supportAuthState.registrationToken = response.registrationToken;
      show('#preloginSupportOtpForm', false); show('#preloginSupportIssueForm'); $('#supportIssue').focus();
    } catch (error) { P.toast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  async function submitPreloginSupport(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const response = await P.api('/api/auth/support/submit', { method: 'POST', body: JSON.stringify({ registrationToken: supportAuthState.registrationToken, issue: $('#supportIssue').value }) });
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
    try { await navigator.serviceWorker.register('service-worker.js?v=8.2.0', { updateViaCache: 'none' }); } catch {}
  }

  function syncInstallControls() {
    const installed = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
    $$('[data-install-app],.install-banner,.install-inline').forEach((node) => node.classList.toggle('hidden', installed || !deferredInstallPrompt));
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
    $('#phoneOtpForm').onsubmit = verifyOtp;
    $('#phoneDetailsForm').onsubmit = registerCustomer;
    $$('[data-auth-phone-back]').forEach((button) => { button.onclick = () => showPhoneStep('phone'); });
    $$('[data-password-toggle]').forEach((button) => { button.onclick = () => togglePassword(button); });
    $$('[data-close]').forEach((button) => { button.onclick = () => closeOverlay(button.dataset.close); });
    $('#appBackButton').onclick = () => history.back();
    $('#logoutBtn').onclick = () => logout();
    $('#profileLogout').onclick = () => logout();
    $('#tabs').onclick = (event) => { const button = event.target.closest('[data-tab]'); if (button) selectTab(button.dataset.tab); };
    $$('[data-jump]').forEach((button) => { button.onclick = () => selectTab(button.dataset.jump); });
    $('#refreshListeners').onclick = () => { loadDirectory(); socket?.emit('listeners:get'); };
    $('#randomConnectButton').onclick = requestRandomCall;
    $('#otherLanguageToggle').onchange = renderDirectory;
    $('#walletCheckoutPay').onclick = beginWalletCheckout;
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
    if (d.buyPlan) return openPayment(d.buyPlan, target);
    if (d.conversation) return openConversation(d.conversation);
    if (d.cancelSubscription) return cancelSubscription(d.cancelSubscription);
  }

  async function init() {
    initNavigation(); bind(); registerServiceWorker(); syncInstallControls();
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
    document.body.classList.add('signed-in');
    show('#landing', false); show('#dashboard'); show('#openAuth', false); show('#logoutBtn');
    $('#profileName').textContent = me.name || 'Customer';
    $('#customerProfileName').value = me.name || '';
    $('#customerProfileUsername').value = me.username || '';
    $('#profileUsernameText').textContent = me.username ? `@${me.username}` : 'Add a username';
    $('#profilePhoneText').textContent = me.phone || 'Private mobile';
    $('#profilePhone').textContent = me.phone || 'Private mobile';
    updateBalance(me.balanceSeconds);
    await Promise.allSettled([loadSubscriptions(false), loadDirectory(), loadConversations(), loadPlans(), loadHistory(), loadFollowing(), loadNotifications(), loadSupport(), loadCustomerPhoto()]);
    renderSubscriptions(); renderDirectory(); connectSocket();
    clearInterval(directPollTimer);
    directPollTimer = window.setInterval(() => {
      if (activeTab !== 'messages') return;
      if (activeConversation) loadDirectMessages();
      else loadConversations(false);
    }, 8000);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function logout(clear = true) {
    if (clear) P.Store.clear();
    clearInterval(directPollTimer); socket?.disconnect(); audioCall?.stop(); me = null; currentCall = null;
    document.body.classList.remove('signed-in');
    show('#landing'); show('#dashboard', false); show('#openAuth'); show('#logoutBtn', false); show('#callModal', false); show('#restoreCall', false);
    activeTab = 'home'; history.replaceState({ marker: NAV_MARKER, tab: 'home' }, document.title); syncBodyState();
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
    window.scrollTo({ top: Math.max(0, $('#dashboard').offsetTop - 70), behavior: 'smooth' }); syncBodyState();
  }

  function updateBalance(value) {
    if (!me) return;
    me.balanceSeconds = Number(value) || 0;
    $('#walletBalance').textContent = P.duration(me.balanceSeconds);
  }

  async function loadDirectory() {
    if (!me) return;
    try { const response = await P.api('/api/customer/listeners'); directory = response.listeners || []; renderDirectory(); }
    catch (error) { P.toast(error.message, 'error'); }
  }

  function renderDirectory() {
    const node = $('#listenerGrid');
    if (!node) return;
    const showOtherLanguages = Boolean($('#otherLanguageToggle')?.checked);
    const primaryListeners = directory.filter((listener) => String(listener.language || 'Malayalam').trim().toLowerCase() === 'malayalam');
    const otherListeners = directory.filter((listener) => String(listener.language || 'Malayalam').trim().toLowerCase() !== 'malayalam');
    const eligibleOnline = directory.filter((listener) => liveStatus(listener) === 'available' && (showOtherLanguages || String(listener.language || 'Malayalam').trim().toLowerCase() === 'malayalam'));
    $('#availabilityText').textContent = eligibleOnline.length
      ? `${eligibleOnline.length} verified listener${eligibleOnline.length === 1 ? '' : 's'} online now`
      : 'No listener online right now';

    const cards = (listeners) => listeners.map((listener) => {
      const status = liveStatus(listener);
      const subscribed = isActiveMember(listener.id) || listener.subscribed;
      return `<article class="listener-card listener-card-v8"><button class="listener-card-open" data-listener-profile="${esc(listener.id)}" type="button" aria-label="Open ${esc(listener.name)} profile"><div class="listener-card-avatar"><img class="protected-media" src="${esc(listenerImage(listener))}" alt="${esc(listener.name)}" draggable="false"><i class="${status === 'available' ? 'online' : ''}"></i></div><div class="listener-card-copy"><span class="verified-listener-label">Verified listener</span><h3>${esc(listener.name)}</h3><p>${esc(listener.bio || 'Friendly listener')}</p><div class="listener-tags"><span>🎧 ${esc(listener.language || 'Malayalam')}</span><span class="listener-live ${esc(status)}"><i></i>${esc(statusLabel(status))}</span>${subscribed ? '<span class="exclusive-tag">Exclusive</span>' : ''}</div></div></button><div class="listener-card-actions"><button class="button button-soft" data-listener-profile="${esc(listener.id)}" type="button">Profile</button><button class="button button-primary" data-listener-call="${esc(listener.id)}" type="button" ${status !== 'available' ? 'disabled' : ''}>Call</button></div></article>`;
    }).join('');

    node.innerHTML = primaryListeners.length ? cards(primaryListeners) : emptyState('No Malayalam listeners yet', 'Try the other-language option or check again soon.');
    $('#otherLanguageGrid').innerHTML = otherListeners.length ? cards(otherListeners) : emptyState('No other languages yet', 'More verified listeners will appear here.');
    show('#listenerDiscovery');
    show('#otherLanguageSection', showOtherLanguages);
  }

  async function openListenerProfile(listenerId) {
    releasePostUrls(); openOverlay('listenerProfileModal');
    $('#listenerProfileContent').innerHTML = '<div class="profile-loading"><span></span><p>Opening listener profile…</p></div>';
    try {
      const response = await P.api(`/api/customer/listeners/${encodeURIComponent(listenerId)}/profile`);
      const listener = response.listener;
      const status = liveStatus(listener);
      const subscribed = Boolean(listener.subscribed || isActiveMember(listener.id));
      const postsMarkup = subscribed ? await renderPrivatePosts(response.posts || []) : response.postsLocked ? `<button class="locked-posts" data-subscribe="${esc(listener.id)}" type="button"><span class="lock-art">✦</span><b>See exclusive posts</b><small>Subscribe to ${esc(listener.name)} for ₹399/month</small></button>` : '<div class="profile-no-posts">No exclusive posts yet.</div>';
      $('#listenerProfileContent').innerHTML = `<div class="listener-profile-head"><div class="listener-profile-banner protected-media" style="--profile-banner:url('${esc(listenerImage(listener, 'banner'))}')"></div><div class="listener-profile-avatar"><img class="protected-media" src="${esc(listenerImage(listener))}" alt="${esc(listener.name)}" draggable="false"><i class="${status === 'available' ? 'online' : ''}"></i></div><div class="listener-profile-title"><div><span class="listener-live ${esc(status)}"><i></i>${esc(statusLabel(status))}</span><h2 id="listenerProfileName">${esc(listener.name)}</h2><p>${esc(listener.bio)}</p></div><button class="button button-soft" data-follow="${esc(listener.id)}" data-following="${listener.following}" type="button">${listener.following ? 'Following' : 'Follow'}</button></div><div class="listener-profile-tags"><span>🎧 ${esc(listener.language)}</span><span>Verified profile</span></div><div class="listener-profile-actions"><button class="button button-soft" data-listener-message="${esc(listener.id)}" type="button">Message</button><button class="button button-primary" data-listener-call="${esc(listener.id)}" type="button" ${status !== 'available' ? 'disabled' : ''}>${status === 'available' ? 'Call now' : statusLabel(status)}</button>${subscribed ? '<span class="member-confirmed">Exclusive active</span>' : `<button class="button button-soft subscribe-button" data-subscribe="${esc(listener.id)}" type="button">Exclusive · ₹399</button>`}</div><p class="call-wallet-note">Calls need only wallet talk-time. Exclusive unlocks this listener’s posts and messages.</p></div><section class="exclusive-posts"><div class="exclusive-posts-head"><span>POSTS</span><small>${subscribed ? 'Exclusive access active' : 'Exclusive members only'}</small></div><div class="post-grid">${postsMarkup}</div></section>`;
    } catch (error) { $('#listenerProfileContent').innerHTML = emptyState('Profile unavailable', error.message); }
  }

  async function renderPrivatePosts(posts) {
    if (!posts.length) return '<div class="profile-no-posts">No exclusive posts yet.</div>';
    const items = await Promise.all(posts.map(async (post) => {
      try { const blob = await P.apiBlob(post.imageUrl); const url = URL.createObjectURL(blob); postObjectUrls.push(url); return `<figure class="exclusive-post protected-media"><img src="${esc(url)}" alt="Exclusive listener post" draggable="false"><figcaption>${esc(post.caption || '')}<small>${P.date(post.created_at)}</small></figcaption></figure>`; }
      catch { return ''; }
    }));
    return items.join('') || '<div class="profile-no-posts">Posts could not be loaded.</div>';
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
    node.innerHTML = subscriptions.length ? subscriptions.map((item) => `<article class="membership-card ${item.active ? 'active' : 'expired'}"><div class="membership-listener"><img src="${esc(listenerImage({ ...item, id: item.listenerId, profileImage: item.listenerImage }))}" alt=""><div><span>${item.active ? 'ACTIVE MEMBERSHIP' : esc(String(item.status).toUpperCase())}</span><h3>${esc(item.listenerName)}</h3><p>${esc(item.language)}</p></div></div><div class="membership-date"><small>${item.active ? 'Access until' : 'Last updated'}</small><strong>${P.date(item.currentPeriodEnd)}</strong></div><div class="membership-actions"><button class="button button-soft" data-listener-profile="${esc(item.listenerId)}" type="button">View profile</button>${item.active ? `<button class="button button-primary" data-listener-message="${esc(item.listenerId)}" type="button">Message${item.unreadCount ? ` · ${item.unreadCount}` : ''}</button>` : ''}${item.active && !item.cancelAtCycleEnd ? `<button class="text-action" data-cancel-subscription="${esc(item.id)}" type="button">Turn off renewal</button>` : item.cancelAtCycleEnd ? '<small>Renewal is off</small>' : ''}</div></article>`).join('') : emptyState('No listener memberships yet', 'Open a listener profile and subscribe to unlock their exclusive posts and messages.');
  }

  async function subscribeToListener(listenerId, button) {
    if (typeof window.Razorpay !== 'function') return P.toast('Secure checkout could not load. Check your connection.', 'error');
    const listener = directory.find((item) => item.id === listenerId) || { id: listenerId, name: 'this listener' };
    pendingMembershipCheckout = { listenerId, listener, button };
    $('#membershipCheckoutContent').innerHTML = `<div class="wallet-checkout-summary membership-summary"><img class="protected-media" src="${esc(listenerImage(listener))}" alt="" draggable="false"><div><small>Exclusive membership</small><h2 id="membershipCheckoutTitle">${esc(listener.name)}</h2><p>Posts and direct messages for this listener.</p></div><strong>₹399</strong></div><div class="wallet-checkout-trust"><span>Listener-specific access</span><span>Renews monthly</span><span>Calls still use wallet minutes</span></div>`;
    $('#membershipCheckoutPay').textContent = 'Subscribe securely · ₹399';
    openOverlay('membershipCheckoutModal');
  }

  async function beginMembershipCheckout() {
    if (!pendingMembershipCheckout) return;
    const { listenerId, button } = pendingMembershipCheckout;
    const payButton = $('#membershipCheckoutPay');
    payButton.disabled = true; button?.setAttribute('disabled', '');
    try {
      const order = await P.api('/api/subscriptions/create', { method: 'POST', body: JSON.stringify({ employeeId: listenerId }) });
      show('#membershipCheckoutModal', false);
      if (history.state?.marker === NAV_MARKER && history.state.overlay === 'membershipCheckoutModal') history.replaceState({ marker: NAV_MARKER, tab: activeTab }, document.title);
      syncBodyState();
      document.body.classList.add('razorpay-open');
      const finish = () => { document.body.classList.remove('razorpay-open'); button?.removeAttribute('disabled'); payButton.disabled = false; pendingMembershipCheckout = null; };
      const checkout = new window.Razorpay({ key: order.key_id, subscription_id: order.subscription_id, name: 'We Met', description: `${order.listener.name} · Exclusive ₹399/month`, image: new URL('assets/logo.svg', location.href).href, prefill: { name: me.name || '', contact: me.phone || '' }, theme: { color: '#e62d7d', backdrop_color: '#0c0d10' }, modal: { backdropclose: false, escape: true, animation: true, ondismiss: finish }, handler: async (payment) => {
        try { const verified = await P.api('/api/subscriptions/verify', { method: 'POST', timeout: 30000, body: JSON.stringify(payment) }); await Promise.all([loadSubscriptions(), loadDirectory(), loadConversations()]); closeOverlay('listenerProfileModal', false); P.toast(verified.message || 'Exclusive membership is active.', 'success'); openListenerProfile(listenerId); }
        catch (error) { P.toast(error.message, 'error'); }
        finally { finish(); }
      } });
      checkout.on('payment.failed', (response) => P.toast(response?.error?.description || 'Membership payment failed.', 'error')); checkout.open();
    } catch (error) { button?.removeAttribute('disabled'); payButton.disabled = false; document.body.classList.remove('razorpay-open'); P.toast(error.message, 'error'); }
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
    $('#conversationList').innerHTML = conversations.length ? conversations.map((item) => { const state = liveStatus(item); return `<button class="conversation-row ${activeConversation === item.listenerId ? 'active' : ''}" data-conversation="${esc(item.listenerId)}" type="button"><span class="conversation-avatar"><img class="protected-media" src="${esc(listenerImage({ ...item, id: item.listenerId, profileImage: item.listenerImage }))}" alt="" draggable="false"><i class="${state === 'available' ? 'online' : ''}"></i></span><span><b>${esc(item.listenerName)}</b><small>${esc(item.language || 'Malayalam')} · ${esc(item.lastMessage || (item.active ? 'Start a message' : 'Membership ended'))}</small></span>${item.unreadCount ? `<i>${item.unreadCount}</i>` : ''}</button>`; }).join('') : emptyState('No messages', 'Join a listener’s Exclusive membership to start messaging.');
  }

  async function openConversation(listenerId) {
    closeOverlay('listenerProfileModal', false); selectTab('messages'); activeConversation = listenerId; renderConversations();
    const conversation = conversations.find((item) => item.listenerId === listenerId);
    if (!conversation?.active) { P.toast('Subscribe to this listener to send messages.', 'info'); return openListenerProfile(listenerId); }
    $('#directChat').classList.remove('empty'); $('#directChatHead').innerHTML = `<div><strong>${esc(conversation.listenerName)}</strong><small>${statusLabel(liveStatus(conversation))} · exclusive conversation</small></div><button class="button button-quiet button-small" data-listener-profile="${esc(listenerId)}" type="button">Profile</button>`; show('#directMessageForm'); await loadDirectMessages();
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
    try { const response = await P.api('/api/customer/plans'); paymentPlans = response.plans || []; $('#walletPaymentIntro').textContent = 'Choose a talk-time pack.'; $('#plansGrid').innerHTML = paymentPlans.length ? paymentPlans.map((plan) => `<article class="wallet-plan-card ${plan.popular ? 'popular' : ''}">${plan.popular ? '<span class="popular-label">POPULAR</span>' : ''}<span class="wallet-plan-minutes"><b>${Math.round(plan.seconds / 60)}</b><small>min</small></span><span class="wallet-plan-name">${esc(plan.name)}</span><strong class="wallet-plan-price">${P.money(plan.price_paise)}</strong><button class="button button-primary" data-buy-plan="${esc(plan.id)}" type="button">Buy</button></article>`).join('') : emptyState('No talk-time packs', 'Talk-time packs will appear here.'); }
    catch (error) { P.toast(error.message, 'error'); }
  }

  function openPayment(planId, button) {
    const plan = paymentPlans.find((item) => item.id === planId);
    if (!plan || typeof window.Razorpay !== 'function') return P.toast('Secure checkout is unavailable.', 'error');
    pendingWalletCheckout = { plan, button };
    $('#walletCheckoutContent').innerHTML = `<div class="wallet-checkout-summary"><span class="wallet-checkout-minutes"><b>${Math.round(plan.seconds / 60)}</b><small>minutes</small></span><div><small>Talk-time pack</small><h2 id="walletCheckoutTitle">${esc(plan.name)}</h2><p>Added after secure payment confirmation.</p></div><strong>${P.money(plan.price_paise)}</strong></div><div class="wallet-checkout-trust"><span>Secure payment</span><span>Connected-second billing</span><span>No card data stored by We Met</span></div>`;
    $('#walletCheckoutPay').textContent = `Pay ${P.money(plan.price_paise)}`;
    $('#walletCheckoutPay').disabled = false;
    openOverlay('walletCheckoutModal');
  }

  async function beginWalletCheckout() {
    if (!pendingWalletCheckout) return;
    const { plan, button } = pendingWalletCheckout;
    const payButton = $('#walletCheckoutPay');
    payButton.disabled = true;
    button?.setAttribute('disabled', '');
    try {
      const order = await P.api('/api/create-order', { method: 'POST', body: JSON.stringify({ planId: plan.id, amount: Number(plan.price_paise), currency: 'INR', receipt: `wallet_${Date.now()}` }) });
      show('#walletCheckoutModal', false);
      if (history.state?.marker === NAV_MARKER && history.state.overlay === 'walletCheckoutModal') history.replaceState({ marker: NAV_MARKER, tab: activeTab }, document.title);
      syncBodyState();
      document.body.classList.add('razorpay-open');
      const finish = () => { button?.removeAttribute('disabled'); payButton.disabled = false; document.body.classList.remove('razorpay-open'); pendingWalletCheckout = null; };
      const checkout = new window.Razorpay({ key: order.key_id, amount: order.amount, currency: order.currency, order_id: order.order_id, name: 'We Met', description: `Wallet · ${plan.name} · ${Math.round(plan.seconds / 60)} minutes`, image: new URL('assets/logo.svg', location.href).href, prefill: { name: me.name || '', contact: me.phone || '' }, theme: { color: '#e62d7d', backdrop_color: '#0c0d10' }, retry: { enabled: true }, modal: { backdropclose: false, escape: true, animation: true, ondismiss: finish }, handler: async (payment) => {
        try { const verified = await P.api('/api/verify-payment', { method: 'POST', timeout: 30000, body: JSON.stringify(payment) }); updateBalance(verified.balance_seconds); await loadHistory(); P.toast(verified.message || 'Talk-time added.', 'success'); }
        catch (error) { P.toast(`${error.message}${payment.razorpay_payment_id ? ` · Ref ${payment.razorpay_payment_id}` : ''}`, 'error'); }
        finally { finish(); }
      } });
      checkout.on('payment.failed', (response) => P.toast(response?.error?.description || 'Payment failed.', 'error')); checkout.open();
    } catch (error) { button?.removeAttribute('disabled'); payButton.disabled = false; document.body.classList.remove('razorpay-open'); P.toast(error.message, 'error'); }
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
    socket.on('connect', () => socket.emit('listeners:get'));
    socket.on('listeners:update', ({ listeners = [] }) => { liveListeners = listeners; renderDirectory(); });
    socket.on('call:ringing', (data) => { currentCall = { id: data.callId, employee: data.employee, billed: 0 }; openCall(); $('#callState').textContent = `Ringing ${data.employee?.name || 'listener'}…`; });
    socket.on('call:retrying', (data) => { $('#callState').textContent = 'Trying another available listener…'; P.toast(data.reason || 'The listener did not answer.', 'info'); });
    socket.on('call:unavailable', (data) => { closeCall(); P.toast(data.message || 'This listener is unavailable.', 'info'); });
    socket.on('call:error', (data) => { closeCall(); P.toast(data.message || 'The call could not start.', 'error'); if (data.needsTopup) selectTab('wallet'); });
    socket.on('call:accepted', async (data) => { if (!currentCall) currentCall = { id: data.callId }; currentCall.mediaConnected = false; $('#callState').textContent = 'Preparing microphone…'; try { await audioCall.prepare(data.callId); if (currentCall?.id === data.callId) { $('#callState').textContent = 'Connecting secure audio…'; socket.emit('webrtc:ready', { callId: data.callId }); } } catch (error) { P.toast(error.message || 'Allow microphone access.', 'error'); socket.emit('call:end', { callId: data.callId }); } });
    socket.on('webrtc:start', async ({ callId }) => { if (currentCall?.id === callId) { try { await audioCall.createOffer(); } catch { socket.emit('call:end', { callId }); } } });
    socket.on('call:connected', () => { if (currentCall) { $('#callState').textContent = 'Connected · wallet billing active'; P.notify('We Met', 'Your private call is connected.'); } });
    socket.on('call:audio-paused', () => { if (currentCall) $('#callState').textContent = 'Audio paused · wallet billing paused'; });
    socket.on('call:audio-restored', () => { if (currentCall) $('#callState').textContent = 'Connected · wallet billing active'; });
    socket.on('call:tick', (data) => { if (currentCall?.id === data.callId) { $('#callTimer').textContent = P.duration(data.billedSeconds); $('#restoreTimer').textContent = P.duration(data.billedSeconds); updateBalance(data.balanceSeconds); } });
    socket.on('call:low-balance', () => P.notify('Low talk-time', 'Only one minute remains in your wallet.'));
    socket.on('call:ended', (data) => { closeCall(); P.toast(data.reason || 'The call ended.', data.needsTopup ? 'error' : 'info'); loadMe(); if (data.needsTopup) selectTab('wallet'); });
    socket.on('chat:message', addCallChat);
    socket.on('notification:new', (notification) => { P.notify(notification.title, notification.body); loadSubscriptions(false); loadConversations(false); });
    socket.on('account:restricted', (data) => { P.toast(data.reason || 'Account restricted.', 'error'); logout(); });
  }

  function requestCall(listenerId) {
    const listener = directory.find((item) => item.id === listenerId);
    if ((me?.balanceSeconds || 0) < (publicConfig?.minimumStartSeconds || 1)) { P.toast('Add talk-time before calling.', 'info'); return selectTab('wallet'); }
    if (liveStatus(listener || { id: listenerId }) !== 'available') return P.toast('This listener is not online right now.', 'info');
    if (!socket?.connected) return P.toast('Calling is reconnecting. Try again shortly.', 'error');
    if (currentCall) return P.toast('A call is already in progress.', 'info');
    closeOverlay('listenerProfileModal', false); socket.emit('call:request', { employeeId: listenerId, allowOtherLanguages: false });
  }

  function requestRandomCall() {
    if ((me?.balanceSeconds || 0) < (publicConfig?.minimumStartSeconds || 1)) { P.toast('Add talk-time before calling.', 'info'); return selectTab('wallet'); }
    if (!socket?.connected) return P.toast('Calling is reconnecting. Try again shortly.', 'error');
    if (currentCall) return P.toast('A call is already in progress.', 'info');
    currentCall = { employee: null, billed: 0, pending: true };
    openCall();
    $('#callState').textContent = 'Finding an available listener…';
    socket.emit('call:request', { employeeId: null, allowOtherLanguages: Boolean($('#otherLanguageToggle')?.checked) });
  }

  function openCall() {
    openOverlay('callModal'); show('#restoreCall', false); $('#callPerson').textContent = currentCall.employee?.name || 'Listener'; $('#callBio').textContent = currentCall.employee?.bio || 'A private conversation'; $('#callTimer').textContent = '0:00'; $('#restoreTimer').textContent = '0:00'; $('#chatMessages').innerHTML = '<div class="bubble">Private call chat starts here.</div>';
    const employee = directory.find((item) => item.id === currentCall.employee?.id) || currentCall.employee;
    if (employee?.id) currentCall.employee = { ...employee, ...currentCall.employee, following: Boolean(employee.following) };
    $('#callAvatarImage').src = employee?.id ? listenerImage(employee) : 'assets/logo.svg';
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
  function closeCall() { show('#callModal', false); show('#restoreCall', false); audioCall?.stop(); currentCall = null; if (history.state?.marker === NAV_MARKER && history.state.overlay === 'callModal') history.replaceState({ marker: NAV_MARKER, tab: activeTab }, document.title); syncBodyState(); }
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
    try { customerPhotoDraft = await compressPhoto(file); $('#customerPhotoPreview').src = customerPhotoDraft; } catch (error) { P.toast(error.message, 'error'); } finally { event.target.value = ''; }
  }
  async function compressPhoto(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Choose a JPG, PNG or WebP photo smaller than 5 MB.');
    const url = URL.createObjectURL(file);
    try { const image = new Image(); await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; }); const size = 560; const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size; const ctx = canvas.getContext('2d'); const crop = Math.min(image.naturalWidth, image.naturalHeight); ctx.drawImage(image, (image.naturalWidth - crop) / 2, (image.naturalHeight - crop) / 2, crop, crop, 0, 0, size, size); const result = canvas.toDataURL('image/jpeg', 0.84); if (result.length > 610000) throw new Error('Choose a simpler or smaller photo.'); return result; }
    finally { URL.revokeObjectURL(url); }
  }
  async function saveCustomerProfile(event) { event.preventDefault(); try { const response = await P.api('/api/customer/profile', { method: 'PATCH', body: JSON.stringify({ name: $('#customerProfileName').value, username: $('#customerProfileUsername').value, ...(customerPhotoDraft !== undefined ? { profileImage: customerPhotoDraft } : {}) }) }); me.name = response.user.name; me.username = response.user.username; me.profileImage = response.user.profileImage; customerPhotoDraft = undefined; $('#profileName').textContent = me.name; $('#profileUsernameText').textContent = me.username ? `@${me.username}` : 'Add a username'; $('#customerProfileForm').classList.add('hidden'); P.toast('Profile updated.', 'success'); } catch (error) { P.toast(error.message, 'error'); } }
  async function loadCustomerPhoto() { $('#customerPhotoPreview').src = 'assets/profile-placeholder.svg'; if (!me?.profileImage?.startsWith('photo:')) return; try { const blob = await P.apiBlob('/api/customer/profile/image'); $('#customerPhotoPreview').src = URL.createObjectURL(blob); } catch {} }
  async function changePassword(event) { event.preventDefault(); try { await P.api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: $('#currentPassword').value, newPassword: $('#newPassword').value }) }); P.toast('Password updated. Please sign in again.', 'success'); setTimeout(() => logout(), 700); } catch (error) { P.toast(error.message, 'error'); } }
  async function reportCall(id) { const reason = prompt('Describe the issue for the safety team:'); if (!reason) return; try { await P.api('/api/customer/reports', { method: 'POST', body: JSON.stringify({ callId: id, reason, details: reason }) }); P.toast('Report sent.', 'success'); } catch (error) { P.toast(error.message, 'error'); } }
  async function loadLegal(type) { try { const response = await P.api(`/api/public/legal/${type}`); $('#legalTitle').textContent = ({ terms: 'Terms and Conditions', privacy: 'Privacy Policy', refund: 'Refund Policy', safety: 'Safety Centre' })[type] || 'Policy'; $('#legalBody').textContent = response.body; openOverlay('legalModal'); } catch (error) { P.toast(error.message, 'error'); } }

  init();
})();
