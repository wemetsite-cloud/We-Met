(() => {
  'use strict';

  const P = window.Portal;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const show = (selector, visible = true) => $(selector)?.classList.toggle('hidden', !visible);
  const NAVIGATION_MARKER = 'we-met-admin-navigation';
  let sessionResetPending = false;
  window.addEventListener('portal:session-invalid', (event) => {
    if (sessionResetPending) return;
    sessionResetPending = true;
    P.toast(event.detail?.message || 'Your session expired. Please sign in again.', 'error');
    setTimeout(leaveAdminSession, 0);
  });

  let me = null;
  let users = [];
  let calls = [];
  let reports = [];
  let tickets = [];
  let resets = [];
  let listenerWallets = [];
  let auditEntries = [];
  const PROFILE_AVATARS = Array.from({ length: 20 }, (_, index) => `avatar-${String(index + 1).padStart(2, '0')}.svg`);
  let activePage = 'overview';
  let liveRefreshTimer = null;

  const pageMeta = {
    overview: ['Overview', 'Live service health and operational summary'],
    customers: ['Customers', 'Accounts, contact records and wallet controls'],
    employees: ['Listeners', 'Presence, connected work time and call performance'],
    wallets: ['Listener wallets', 'Adjust earnings balances and record manual payments'],
    plans: ['Plans', 'Talk-time pricing available after customer sign-in'],
    coupons: ['Coupons', 'Create and control wallet redeem codes'],
    calls: ['Calls', 'Every call, participant and connected duration'],
    reports: ['Reports', 'Safety review and account actions'],
    support: ['Support', 'Customer messages and replies'],
    resets: ['Password resets', 'Review secure account recovery requests'],
    broadcast: ['Notifications', 'Send in-app and browser service messages'],
    audit: ['Audit log', 'Successful administrator changes across the platform'],
    security: ['Security', 'Administrator credentials and operational safeguards'],
  };

  function profileLink(id, name, detail = '') {
    if (!id) return `<span>${P.esc(name || 'Unknown')}</span>`;
    return `<button class="profile-link" type="button" data-user-profile="${P.esc(id)}"><span>${P.esc(name || 'Unknown')}</span>${detail ? `<small>${P.esc(detail)}</small>` : ''}</button>`;
  }

  function initials(name) {
    return String(name || 'User').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  }

  function profileImageSrc(value, name = 'Listener', userId = '') {
    const image = String(value || '');
    if (/^avatar-(0[1-9]|1[0-9]|20)\.svg$/.test(image)) return `assets/${image}`;
    if ((image === 'photo' || image === `photo:${userId}`) && userId) return `${P.base}/api/public/listener-profile-image/${encodeURIComponent(userId)}`;
    if (/^data:image\/(?:jpeg|png|webp);base64,/.test(image)) return image;
    let total = 0; for (const char of String(name || 'Listener')) total += char.charCodeAt(0);
    return `assets/avatar-${String((total % 20) + 1).padStart(2, '0')}.svg`;
  }

  function listenerAvatarMarkup(user, className = '') {
    return `<span class="customer-avatar listener-avatar listener-photo ${className}"><img src="${P.esc(profileImageSrc(user.profile_image, user.name, user.id))}" alt=""></span>`;
  }

  async function compressProfilePhoto(file) {
    if (!file || !['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG, or WebP photo.');
    if (file.size > 5 * 1024 * 1024) throw new Error('Choose a profile photo smaller than 5 MB.');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
      const size = 420; const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d'); const crop = Math.min(image.naturalWidth, image.naturalHeight);
      const sx = (image.naturalWidth-crop)/2, sy = (image.naturalHeight-crop)/2;
      ctx.fillStyle='#fff'; ctx.fillRect(0,0,size,size); ctx.drawImage(image,sx,sy,crop,crop,0,0,size,size);
      const result = canvas.toDataURL('image/jpeg', .84);
      if (result.length > 600000) throw new Error('This photo is still too large. Choose a simpler or smaller image.');
      return result;
    } finally { URL.revokeObjectURL(url); }
  }

  function closeAdminModal({ fromHistory = false } = {}) {
    if (!fromHistory && history.state?.marker === NAVIGATION_MARKER && history.state.overlay === 'actionModal') {
      history.back();
      return;
    }
    show('#actionModal', false);
  }

  function modal(title, body) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = body;
    const opening = $('#actionModal').classList.contains('hidden');
    show('#actionModal');
    if (opening) history.pushState({ marker: NAVIGATION_MARKER, page: activePage, overlay: 'actionModal' }, document.title);
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      return await navigator.serviceWorker.register('service-worker.js?v=6.9.0', { updateViaCache: 'none' });
    } catch { }
  }

  function leaveAdminSession() {
    P.Store.clear();
    clearInterval(liveRefreshTimer);
    me = null;
    users = [];
    show('#loginView');
    show('#appView', false);
    show('#actionModal', false);
    $('.layout')?.classList.remove('menu-open');
    if ($('#password')) $('#password').value = '';
    activePage = 'overview';
    history.replaceState({ marker: NAVIGATION_MARKER, page: 'overview' }, document.title);
    sessionResetPending = false;
  }

  async function copyText(value) {
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const area = document.createElement('textarea');
        area.value = value;
        area.readOnly = true;
        area.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(area);
        area.select();
        if (!document.execCommand('copy')) throw new Error('Copy is unavailable.');
        area.remove();
      }
      P.toast('Copied.', 'success');
    } catch {
      P.toast('Select the value and copy it manually.', 'error');
    }
  }

  function bind() {
    $('#loginForm').onsubmit = login;
    $('#logout').onclick = leaveAdminSession;
    $('#adminBackButton').onclick = () => { if (activePage !== 'overview') history.back(); };
    $('#menuBtn').onclick = () => $('.layout').classList.toggle('menu-open');
    $('#closeModal').onclick = () => closeAdminModal();
    $('#nav').onclick = event => {
      const button = event.target.closest('[data-page]');
      if (!button) return;
      openPage(button.dataset.page);
      $('.layout').classList.remove('menu-open');
    };

    $('#employeeForm').onsubmit = createEmployee;
    $('#planForm').onsubmit = createPlan;
    $('#couponForm').onsubmit = createCoupon;
    $('#broadcastForm').onsubmit = sendBroadcast;
    $('#adminPasswordForm').onsubmit = changePassword;
    $('#adminUsernameForm').onsubmit = changeAdminUsername;

    $('#refreshLive').onclick = () => loadLive();
    $('#reloadCustomers').onclick = () => loadUsers();
    $('#reloadEmployees').onclick = () => loadUsers();
    $('#reloadWallets').onclick = loadListenerWallets;
    $('#reloadCoupons').onclick = loadCoupons;
    $('#reloadCalls').onclick = loadCalls;
    $('#reloadReports').onclick = loadReports;
    $('#reloadSupport').onclick = loadSupport;
    $('#reloadResets').onclick = loadResets;
    $('#reloadAudit').onclick = loadAudit;

    $('#customerSearch').oninput = renderCustomers;
    $('#listenerSearch').oninput = renderEmployees;
    $('#listenerStatusFilter').onchange = renderEmployees;
    $('#walletSearch').oninput = renderListenerWallets;
    $('#callSearch').oninput = renderCalls;

    document.addEventListener('click', handleActionClick);
    document.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-user-profile][tabindex="0"]')) {
        event.preventDefault();
        showDetails(event.target.dataset.userProfile);
      }
    });
  }

  async function handleActionClick(event) {
    if (event.target.closest('a')) return;
    const target = event.target.closest('button, [data-user-profile]');
    if (!target) return;
    const d = target.dataset;
    if (d.editListener) return editListener(d.editListener);
    if (d.walletRate) return listenerRateModal(d.walletRate);
    if (d.walletAdjust) return adjustListenerWallet(d.walletAdjust);
    if (d.walletPaid) return recordListenerPayment(d.walletPaid);
    if (d.minutes) return minutesModal(d.minutes);
    if (d.suspend) return suspendModal(d.suspend);
    if (d.block) return setUserStatus(d.block, d.status === 'blocked' ? 'active' : 'blocked');
    if (d.reset) return resetPassword(d.reset);
    if (d.planEdit) return editPlan(d.planEdit);
    if (d.planToggle) return updatePlan(d.planToggle, { active: d.active !== 'true' });
    if (d.coupon) return toggleCoupon(d.coupon, d.active !== 'true');
    if (d.copy) return copyText(d.copy);
    if (d.reportReview) return updateReport(d.reportReview, 'reviewing');
    if (d.reportClose) return updateReport(d.reportClose, 'closed');
    if (d.target) return suspendModal(d.target);
    if (d.reply) return replySupport(d.reply);
    if (d.resetApprove) return reviewReset(d.resetApprove, 'approved');
    if (d.resetDecline) return reviewReset(d.resetDecline, 'declined');
    if (d.userProfile) return showDetails(d.userProfile);
  }

  async function init() {
    history.replaceState({ marker: NAVIGATION_MARKER, page: 'overview' }, document.title);
    window.addEventListener('popstate', event => {
      const page = event.state?.marker === NAVIGATION_MARKER ? event.state.page : 'overview';
      closeAdminModal({ fromHistory: true });
      openPage(page, { historyMode: 'none' });
    });
    bind();
    registerServiceWorker();
    if (P.Store.token) await loadMe();
  }

  async function login(event) {
    event.preventDefault();
    const button = event.submitter;
    button?.setAttribute('disabled', '');
    button?.setAttribute('aria-busy', 'true');
    try {
      const data = await P.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier: $('#username').value, password: $('#password').value }) });
      if (data.user.role !== 'admin') throw new Error('This account does not have administrator access.');
      P.Store.token = data.token;
      me = data.user;
      enter();
    } catch (error) {
      P.toast(error.message, 'error');
    } finally {
      button?.removeAttribute('disabled');
      button?.removeAttribute('aria-busy');
    }
  }

  async function loadMe() {
    try {
      const data = await P.api('/api/auth/me');
      if (data.user.role !== 'admin') throw new Error('Administrator access required.');
      me = data.user;
      enter();
    } catch (error) {
      if (P.isAuthError(error)) return;
      P.toast('The server is temporarily unavailable. Your admin login is still saved; try again shortly.', 'error');
    }
  }

  function enter() {
    sessionResetPending = false;
    show('#loginView', false);
    show('#appView');
    $('.admin-chip b').textContent = me.name || 'Administrator';
    $('.admin-chip span').textContent = initials(me.name || 'Administrator');
    openPage('overview', { historyMode: 'replace' });
    loadDashboard();
    loadUsers();
    clearInterval(liveRefreshTimer);
    liveRefreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && activePage === 'overview') loadLive(true);
    }, 10_000);
  }

  function openPage(name, { historyMode = 'push' } = {}) {
    if (!pageMeta[name]) name = 'overview';
    if (activePage !== name && historyMode === 'push') history.pushState({ marker: NAVIGATION_MARKER, page: name }, document.title);
    else if (historyMode === 'replace') history.replaceState({ marker: NAVIGATION_MARKER, page: name }, document.title);
    activePage = name;
    $('#adminBackButton').classList.toggle('hidden', name === 'overview');
    const activeButton = $(`#nav [data-page="${name}"]`);
    $$('#nav button').forEach(button => button.classList.toggle('active', button === activeButton));
    $$('.page').forEach(page => page.classList.toggle('active', page.id === `page-${name}`));
    $('#pageTitle').textContent = pageMeta[name][0];
    $('#pageDesc').textContent = pageMeta[name][1];
    window.scrollTo({ top: 0, behavior: 'smooth' });

    const loaders = {
      overview: () => { loadDashboard(); loadLive(); },
      customers: loadUsers,
      employees: loadUsers,
      wallets: loadListenerWallets,
      plans: loadPlans,
      coupons: loadCoupons,
      calls: loadCalls,
      reports: loadReports,
      support: loadSupport,
      resets: loadResets,
      audit: loadAudit,
    };
    loaders[name]?.();
  }

  async function loadDashboard() {
    try {
      const data = await P.api('/api/admin/dashboard');
      const count = role => data.users.find(item => item.role === role)?.count || 0;
      $('#mCustomers').textContent = count('customer');
      $('#mTalk').textContent = P.duration(data.totalTalkSeconds);
      $('#mAttention').textContent = Number(data.openReports || 0) + Number(data.openTickets || 0);
      $('#callSummary').innerHTML = (data.calls || []).map(item => `<div><small>${P.esc(item.status)}</small><strong>${item.count}</strong><span>${P.duration(item.seconds)}</span></div>`).join('') || '<p class="empty-copy">No calls yet.</p>';
    } catch (error) { P.toast(error.message, 'error'); }
  }

  async function loadLive(silent = false) {
    try {
      const data = await P.api('/api/admin/live');
      const listeners = data.onlineEmployees || [];
      const activeCalls = data.activeCalls || [];
      const byRole = data.onlineByRole || {};
      $('#mConcurrent').textContent = Number(data.concurrentUsers || 0);
      $('#mConcurrentBreakdown').textContent = `${Number(byRole.customer || 0)} customers • ${Number(byRole.employee || 0)} listeners`;
      $('#mOnline').textContent = listeners.length;
      $('#liveListeners').innerHTML = listeners.length ? listeners.map(item => `<div class="live-row"><div>${profileLink(item.id, item.name, item.language || 'Malayalam')}<p>${P.esc(item.bio || 'Listener')}</p></div><span class="pill ${P.esc(item.status)}">${P.esc(item.status)}</span></div>`).join('') : '<p class="empty-copy">No listeners online.</p>';
      $('#liveCalls').innerHTML = activeCalls.length ? activeCalls.map(item => `<div class="live-row"><div><strong>${profileLink(item.customerId, item.customerName)} <span class="connection-arrow">↔</span> ${profileLink(item.employeeId, item.employeeName)}</strong><p>${P.esc(item.language || 'Conversation')} • ${P.esc(item.status)} • ${P.duration(item.billedSeconds)}</p></div><span class="pill busy">LIVE</span></div>`).join('') : '<p class="empty-copy">No live calls.</p>';
    } catch (error) { if (!silent) P.toast(error.message, 'error'); }
  }

  async function loadUsers() {
    try {
      users = (await P.api('/api/admin/users')).users || [];
      renderCustomers();
      renderEmployees();
      $('#broadcastUser').innerHTML = '<option value="">All customers and listeners</option>' + users.filter(user => user.role !== 'admin').map(user => `<option value="${user.id}">${P.esc(user.name)} — ${P.esc(user.email || user.username || '')}</option>`).join('');
    } catch (error) { P.toast(error.message, 'error'); }
  }

  function renderCustomers() {
    const all = users.filter(user => user.role === 'customer');
    const query = ($('#customerSearch')?.value || '').trim().toLowerCase();
    const list = all.filter(user => `${user.name} ${user.email || ''} ${user.phone || ''}`.toLowerCase().includes(query));
    $('#customerCount').textContent = all.length;
    $('#customerActiveCount').textContent = all.filter(user => user.status === 'active').length;
    $('#customerPhoneCount').textContent = all.filter(user => user.phone).length;
    $('#customerWalletTotal').textContent = P.duration(all.reduce((total, user) => total + Number(user.balance_seconds || 0), 0));
    $('#customersTable').innerHTML = list.length ? list.map(user => `<article class="customer-card clickable-card" role="listitem" tabindex="0" data-user-profile="${user.id}"><header><span class="customer-avatar">${P.esc(initials(user.name))}</span><div>${profileLink(user.id, user.name, user.email || 'Email not provided')}</div><span class="pill ${P.esc(user.status)}">${P.esc(user.status)}</span></header><div class="customer-contact-grid"><div><small>Phone</small>${user.phone ? `<a class="phone-link" href="tel:${P.esc(user.phone)}">${P.esc(user.phone)}</a>` : '<span class="contact-missing">Not provided</span>'}</div><div><small>Wallet balance</small><strong>${P.duration(user.balance_seconds)}</strong></div><div><small>Last seen</small><strong>${user.last_seen_at ? P.date(user.last_seen_at) : 'Not recorded'}</strong></div><div><small>Joined</small><strong>${P.date(user.created_at)}</strong></div></div><div class="customer-card-actions"><button class="ghost" data-user-profile="${user.id}">Full profile</button><button class="primary" data-minutes="${user.id}">Minutes</button><button class="warning" data-suspend="${user.id}">Suspend</button><button class="${user.status === 'blocked' ? 'ghost' : 'danger'}" data-block="${user.id}" data-status="${P.esc(user.status)}">${user.status === 'blocked' ? 'Activate' : 'Block'}</button><button class="ghost" data-reset="${user.id}">Reset password</button></div></article>`).join('') : `<div class="customer-empty"><b>${query ? 'No matching customers' : 'No customers yet'}</b><p>${query ? 'Try a different name, email or phone number.' : 'New customer accounts will appear here automatically.'}</p></div>`;
  }

  function renderEmployees() {
    const all = users.filter(user => user.role === 'employee');
    const query = ($('#listenerSearch')?.value || '').trim().toLowerCase();
    const status = $('#listenerStatusFilter')?.value || '';
    const list = all.filter(user => `${user.name} ${user.email || ''} ${user.employee_code || ''} ${user.listener_language || ''}`.toLowerCase().includes(query) && (!status || user.listener_availability === status));
    $('#listenerCount').textContent = all.length;
    $('#listenerOnlineCount').textContent = all.filter(user => user.listener_availability === 'online').length;
    $('#listenerTodayWork').textContent = P.duration(all.reduce((total, user) => total + Number(user.today_work_seconds || 0), 0));
    $('#listenerTodayTalk').textContent = P.duration(all.reduce((total, user) => total + Number(user.today_talk_seconds || 0), 0));
    $('#employeeCards').innerHTML = list.length ? list.map(user => `
      <article class="listener-admin-card clickable-card" tabindex="0" data-user-profile="${user.id}">
        <header>${listenerAvatarMarkup(user)}<div>${profileLink(user.id, user.name, `${user.employee_code || 'No ID'} • ${user.listener_language || 'Malayalam'}`)}</div><div class="listener-statuses"><span class="pill ${P.esc(user.status)}">${P.esc(user.status)}</span><span class="pill ${user.listener_availability === 'online' ? 'available' : P.esc(user.listener_availability || 'offline')}">${P.esc(user.listener_availability || 'offline')}</span></div></header>
        <div class="listener-performance"><div><small>Work today</small><strong>${P.duration(user.today_work_seconds)}</strong></div><div><small>Talk today</small><strong>${P.duration(user.today_talk_seconds)}</strong></div><div><small>Break today</small><strong>${P.duration(user.today_break_seconds)}</strong></div><div><small>Calls today</small><strong>${Number(user.today_calls || 0)}</strong></div><div><small>Rate / min</small><strong>${P.moneyExact(user.listener_rate_paise)}</strong></div><div><small>Unpaid wallet</small><strong>${P.moneyExact(user.listener_wallet_balance_paise)}</strong></div></div>
        <p class="listener-contact">${P.esc(user.email || '')}${user.phone ? ` • ${P.esc(user.phone)}` : ''} • Last seen ${user.last_seen_at ? P.date(user.last_seen_at) : 'not recorded'}</p>
        <div class="customer-card-actions"><button class="primary" data-user-profile="${user.id}">Full profile</button><button class="ghost" data-edit-listener="${user.id}">Edit</button><button class="ghost" data-wallet-rate="${user.id}">Set rate</button><button class="warning" data-suspend="${user.id}">Suspend</button><button class="${user.status === 'blocked' ? 'ghost' : 'danger'}" data-block="${user.id}" data-status="${P.esc(user.status)}">${user.status === 'blocked' ? 'Activate' : 'Block'}</button><button class="ghost" data-reset="${user.id}">Reset password</button></div>
      </article>`).join('') : '<p class="empty-copy">No listeners match this filter.</p>';
  }

  async function showDetails(id) {
    try {
      const data = await P.api(`/api/admin/users/${id}/details`);
      const user = data.user;
      const callStats = data.callAnalytics || {};
      const workStats = data.workAnalytics || {};
      const listenerWalletSummary = data.listenerWalletSummary || {};
      const employeeMetrics = user.role === 'employee' ? `<section class="profile-section"><h3>Listener performance</h3><div class="profile-metrics"><article><small>Work today</small><strong>${P.duration(workStats.today_work_seconds)}</strong></article><article><small>Work this week</small><strong>${P.duration(workStats.week_work_seconds)}</strong></article><article><small>Total work</small><strong>${P.duration(workStats.total_work_seconds)}</strong></article><article><small>Break today</small><strong>${P.duration(workStats.today_break_seconds)}</strong></article><article><small>Talk today</small><strong>${P.duration(callStats.today_talk_seconds)}</strong></article><article><small>Talk this week</small><strong>${P.duration(callStats.week_talk_seconds)}</strong></article><article><small>Total talk</small><strong>${P.duration(callStats.total_talk_seconds)}</strong></article><article><small>Connected calls</small><strong>${Number(callStats.connected_calls || 0)}</strong></article></div></section><section class="profile-section"><h3>Recent availability sessions</h3><div class="activity-table">${(data.activitySessions || []).slice(0, 25).map(session => `<div><span class="pill ${session.state === 'online' ? 'available' : 'break'}">${P.esc(session.state)}</span><span><b>${P.duration(session.duration_seconds)}</b><small>${P.date(session.started_at)} → ${session.ended_at ? P.date(session.ended_at) : 'Now'}</small></span><small>${P.esc(session.end_reason || (session.ended_at ? 'Status changed' : 'Current session'))}</small></div>`).join('') || '<p>No availability sessions recorded.</p>'}</div></section>` : '';
      const listenerLedger = (data.listenerWallet || []).slice(0, 50).map(entry => `<div class="profile-row"><strong>${Number(entry.amount_paise) >= 0 ? '+' : '−'}${P.moneyExact(Math.abs(Number(entry.amount_paise)))}</strong><span>${P.esc(entry.note || entry.type)}${entry.payment_reference ? ` • Ref ${P.esc(entry.payment_reference)}` : ''}</span><small>${P.date(entry.created_at)}</small></div>`).join('') || '<p>No listener wallet entries.</p>';
      const listenerFinance = user.role === 'employee' ? `<section class="profile-section"><h3>Listener wallet</h3><div class="profile-metrics"><article><small>Current balance</small><strong>${P.moneyExact(listenerWalletSummary.balance_paise)}</strong></article><article><small>Rate / minute</small><strong>${P.moneyExact(user.listener_rate_paise)}</strong></article><article><small>Earned today</small><strong>${P.moneyExact(listenerWalletSummary.today_earnings_paise)}</strong></article><article><small>Earned this week</small><strong>${P.moneyExact(listenerWalletSummary.week_earnings_paise)}</strong></article><article><small>Lifetime earned</small><strong>${P.moneyExact(listenerWalletSummary.lifetime_earnings_paise)}</strong></article><article><small>Lifetime recorded paid</small><strong>${P.moneyExact(listenerWalletSummary.lifetime_paid_paise)}</strong></article></div><h3 class="profile-subtitle">Wallet ledger</h3><div class="profile-list">${listenerLedger}</div></section>` : '';
      const recentCalls = (data.calls || []).slice(0, 20).map(call => `<div class="profile-row"><div>${profileLink(call.customer_id, call.customer_name)} <span class="connection-arrow">↔</span> ${profileLink(call.employee_id, call.employee_name)}</div><span class="pill ${P.esc(call.status)}">${P.esc(call.status)}</span><small>${P.duration(call.billed_seconds)}${user.role === 'employee' ? ` • ${P.moneyExact(call.listener_earnings_paise)}` : ''} • ${P.date(call.started_at || call.created_at)}</small></div>`).join('') || '<p>No calls recorded.</p>';
      const wallet = (data.wallet || []).slice(0, 20).map(entry => `<div class="profile-row"><strong>${Number(entry.seconds_delta) >= 0 ? '+' : '−'}${P.duration(Math.abs(Number(entry.seconds_delta)))}</strong><span>${P.esc(entry.note || entry.type)}</span><small>${P.date(entry.created_at)}</small></div>`).join('') || '<p>No wallet entries.</p>';
      const audit = (data.audits || []).slice(0, 20).map(entry => `<div class="profile-row"><strong>${P.esc(entry.action)}</strong><span>${P.esc(entry.admin_name || 'Administrator')}</span><small>${P.date(entry.created_at)}</small></div>`).join('') || '<p>No administrator changes recorded for this account.</p>';
      modal(`${user.name} — full profile`, `<div class="full-profile"><section class="profile-identity">${user.role === 'employee' ? listenerAvatarMarkup(user, 'profile-avatar') : `<span class="customer-avatar profile-avatar">${P.esc(initials(user.name))}</span>`}<div><span class="eyebrow">${P.esc(user.role)} PROFILE</span><h2>${P.esc(user.name)}</h2><p>${P.esc(user.email || user.username || 'No login identifier')}</p></div><span class="pill ${P.esc(user.status)}">${P.esc(user.status)}</span></section><div class="profile-facts"><div><small>Phone</small><strong>${user.phone ? `<a href="tel:${P.esc(user.phone)}">${P.esc(user.phone)}</a>` : 'Not provided'}</strong></div><div><small>Joined</small><strong>${P.date(user.created_at)}</strong></div><div><small>Last login</small><strong>${user.last_login_at ? P.date(user.last_login_at) : 'Not recorded'}</strong></div><div><small>Last seen</small><strong>${user.last_seen_at ? P.date(user.last_seen_at) : 'Not recorded'}</strong></div>${user.role === 'customer' ? `<div><small>Wallet</small><strong>${P.duration(user.balance_seconds)}</strong></div>` : ''}${user.role === 'employee' ? `<div><small>Employee ID</small><strong>${P.esc(user.employee_code || 'Not set')}</strong></div><div><small>Language</small><strong>${P.esc(user.listener_language || 'Malayalam')}</strong></div><div><small>Availability</small><strong>${P.esc(user.listener_availability || 'offline')}</strong></div><div><small>Rate / minute</small><strong>${P.moneyExact(user.listener_rate_paise)}</strong></div>` : ''}</div>${user.bio ? `<p class="profile-bio">${P.esc(user.bio)}</p>` : ''}${user.suspension_reason ? `<p class="profile-warning"><b>Restriction:</b> ${P.esc(user.suspension_reason)}${user.suspended_until ? ` until ${P.date(user.suspended_until)}` : ''}</p>` : ''}${employeeMetrics}${listenerFinance}<section class="profile-section"><h3>Recent calls</h3><div class="profile-list">${recentCalls}</div></section>${user.role === 'customer' ? `<section class="profile-section"><h3>Wallet activity</h3><div class="profile-list">${wallet}</div></section>` : ''}<section class="profile-section"><h3>Safety and support</h3><p>${(data.reports || []).length} report(s) • ${(data.support || []).length} support ticket(s)</p></section><section class="profile-section"><h3>Administrator history</h3><div class="profile-list">${audit}</div></section></div>`);
    } catch (error) { P.toast(error.message, 'error'); }
  }

  function editListener(id) {
    const user = users.find(item => item.id === id && item.role === 'employee');
    if (!user) return;
    let profileImageDraft = user.profile_image || '';
    const avatarOptions = PROFILE_AVATARS.map((avatar) => `<button type="button" class="avatar-choice ${profileImageDraft === avatar ? 'selected' : ''}" data-admin-avatar="${avatar}" aria-label="Choose ${avatar}"><img src="assets/${avatar}" alt=""></button>`).join('');
    modal(`Edit listener — ${user.name}`, `<form id="editListenerForm" class="stack"><div class="admin-profile-photo-editor"><div class="admin-profile-photo-head"><span class="admin-profile-photo-preview"><img id="editListenerPhotoPreview" src="${P.esc(profileImageSrc(profileImageDraft,user.name,user.id))}" alt="Listener profile photo"></span><div><strong>Customer-facing profile photo</strong><p>Upload a photo or choose one of the built-in We Met avatars.</p><div class="profile-photo-actions"><button id="adminUploadListenerPhoto" class="ghost" type="button">Upload photo</button><button id="adminAutoListenerAvatar" class="ghost" type="button">Automatic avatar</button><input id="adminListenerPhotoFile" type="file" accept="image/jpeg,image/png,image/webp" hidden></div></div></div><div id="adminAvatarGrid" class="avatar-picker">${avatarOptions}</div></div><label>Name<input id="editListenerName" value="${P.esc(user.name || '')}" required></label><label>Username<input id="editListenerUsername" value="${P.esc(user.username || '')}"></label><label>Email<input id="editListenerEmail" type="email" value="${P.esc(user.email || '')}" required></label><label>Language<input id="editListenerLanguage" list="listenerLanguages" maxlength="60" value="${P.esc(user.listener_language || 'Malayalam')}" required></label><label>Phone<input id="editListenerPhone" value="${P.esc(user.phone || '')}"></label><label>Rate per connected minute (₹)<input id="editListenerRate" type="number" min="0" max="100000" step="0.01" value="${Number(user.listener_rate_paise || 0) / 100}" required></label><label>Short public bio<textarea id="editListenerBio" maxlength="500">${P.esc(user.bio || '')}</textarea></label><button class="primary">Save listener</button></form>`);
    const renderAvatarState = () => {
      $('#editListenerPhotoPreview').src = profileImageSrc(profileImageDraft, $('#editListenerName').value || user.name, user.id);
      $$('#adminAvatarGrid [data-admin-avatar]').forEach(button => button.classList.toggle('selected', button.dataset.adminAvatar === profileImageDraft));
    };
    $('#adminUploadListenerPhoto').onclick = () => $('#adminListenerPhotoFile').click();
    $('#adminListenerPhotoFile').onchange = async event => { try { profileImageDraft = await compressProfilePhoto(event.target.files?.[0]); renderAvatarState(); } catch (error) { P.toast(error.message,'error'); } finally { event.target.value=''; } };
    $('#adminAutoListenerAvatar').onclick = () => { profileImageDraft=''; renderAvatarState(); };
    $('#adminAvatarGrid').onclick = event => { const button = event.target.closest('[data-admin-avatar]'); if (!button) return; profileImageDraft=button.dataset.adminAvatar; renderAvatarState(); };
    $('#editListenerName').oninput = () => { if (!profileImageDraft) renderAvatarState(); };
    $('#editListenerForm').onsubmit = async event => {
      event.preventDefault();
      try {
        await P.api(`/api/admin/employees/${id}`, { method: 'PATCH', body: JSON.stringify({ name: $('#editListenerName').value, username: $('#editListenerUsername').value, email: $('#editListenerEmail').value, language: $('#editListenerLanguage').value, phone: $('#editListenerPhone').value, ratePaise: Math.round(Number($('#editListenerRate').value) * 100), bio: $('#editListenerBio').value, profileImage: profileImageDraft }) });
        closeAdminModal(); P.toast('Listener updated.', 'success'); loadUsers(); loadListenerWallets(); loadLive(true);
      } catch (error) { P.toast(error.message, 'error'); }
    };
  }

  async function loadListenerWallets() {
    try {
      const walletData = await P.api('/api/admin/listener-wallets');
      listenerWallets = walletData.wallets || [];
      renderListenerWallets();
    } catch (error) {
      P.toast(error.message, 'error');
    }
  }

  function renderListenerWallets() {
    const query = ($('#walletSearch')?.value || '').trim().toLowerCase();
    const list = listenerWallets.filter(item => `${item.name} ${item.email || ''} ${item.employee_code || ''} ${item.listener_language || ''}`.toLowerCase().includes(query));
    const total = field => listenerWallets.reduce((sum, item) => sum + Number(item[field] || 0), 0);
    $('#listenerWalletCount').textContent = listenerWallets.length;
    $('#listenerWalletBalance').textContent = P.moneyExact(total('balance_paise'));
    $('#listenerWalletEarned').textContent = P.moneyExact(total('lifetime_earnings_paise'));
    $('#listenerWalletPaid').textContent = P.moneyExact(total('lifetime_paid_paise'));
    $('#listenerWalletCards').innerHTML = list.length ? list.map(item => {
      const balance = Number(item.balance_paise || 0);
      return `<article class="listener-wallet-card"><header>${listenerAvatarMarkup(item)}<div>${profileLink(item.id, item.name, `${item.employee_code || 'No ID'} • ${item.listener_language || 'Malayalam'}`)}<p>${P.esc(item.email || 'No email recorded')}</p></div><div class="listener-statuses"><span class="pill ${P.esc(item.status)}">${P.esc(item.status)}</span><span class="pill ${item.listener_availability === 'online' ? 'available' : P.esc(item.listener_availability || 'offline')}">${P.esc(item.listener_availability || 'offline')}</span></div></header><div class="wallet-due"><small>Current unpaid balance</small><strong>${P.moneyExact(balance)}</strong><span>${balance > 0 ? 'Record a payment only after the listener has been paid separately' : 'No unpaid listener earnings'}</span></div><div class="wallet-admin-metrics"><div><small>Rate / minute</small><strong>${Number(item.listener_rate_paise || 0) > 0 ? P.moneyExact(item.listener_rate_paise) : 'Not set'}</strong></div><div><small>Earned today</small><strong>${P.moneyExact(item.today_earnings_paise)}</strong></div><div><small>This week</small><strong>${P.moneyExact(item.week_earnings_paise)}</strong></div><div><small>Lifetime earned</small><strong>${P.moneyExact(item.lifetime_earnings_paise)}</strong></div><div><small>Recorded paid</small><strong>${P.moneyExact(item.lifetime_paid_paise)}</strong></div><div><small>Last payment</small><strong>${item.last_paid_at ? P.date(item.last_paid_at) : 'Never'}</strong></div></div><div class="customer-card-actions"><button class="primary" data-wallet-paid="${item.id}" ${balance > 0 ? '' : 'disabled'}>Record paid</button><button class="ghost" data-wallet-rate="${item.id}">Set rate</button><button class="ghost" data-wallet-adjust="${item.id}">Adjust wallet</button><button class="ghost" data-user-profile="${item.id}">Full history</button><button class="ghost" data-edit-listener="${item.id}">Edit details</button></div></article>`;
    }).join('') : '<p class="empty-copy">No listener wallets match this search.</p>';
  }

  function listenerRateModal(id) {
    const listener = listenerWallets.find(item => item.id === id) || users.find(item => item.id === id && item.role === 'employee');
    if (!listener) return;
    modal(`Set rate — ${listener.name}`, `<form id="listenerRateForm" class="stack"><p class="modal-copy">This rate is snapshotted when a new call starts. Changing it does not rewrite previous calls or earnings.</p><label>Rupees per connected minute<input id="listenerRateValue" type="number" min="0" max="100000" step="0.01" value="${Number(listener.listener_rate_paise || 0) / 100}" required></label><button class="primary">Save rate</button></form>`);
    $('#listenerRateForm').onsubmit = async event => {
      event.preventDefault();
      const button = event.submitter;
      button?.setAttribute('disabled', '');
      try {
        await P.api(`/api/admin/listener-wallets/${id}/rate`, { method: 'PATCH', body: JSON.stringify({ ratePaise: Math.round(Number($('#listenerRateValue').value) * 100) }) });
        closeAdminModal();
        P.toast('Listener rate updated for new calls.', 'success');
        loadListenerWallets(); loadUsers(); loadAudit();
      } catch (error) {
        button?.removeAttribute('disabled');
        P.toast(error.message, 'error');
      }
    };
  }

  function recordListenerPayment(id) {
    const listener = listenerWallets.find(item => item.id === id);
    if (!listener) return;
    const balance = Number(listener.balance_paise || 0);
    if (balance <= 0) return P.toast('This listener has no unpaid wallet balance.', 'error');
    modal(`Record payment — ${listener.name}`, `<form id="listenerPaymentForm" class="stack"><div class="exact-payment"><small>Current unpaid balance</small><strong>${P.moneyExact(balance)}</strong><span>This action records a manual payment; it does not send money.</span></div><label>Amount paid in rupees<input id="listenerPaymentAmount" type="number" min="0.01" max="${balance / 100}" step="0.01" value="${balance / 100}" required></label><label>Payment reference (optional)<input id="listenerPaymentReference" maxlength="160" placeholder="Bank reference, receipt number or internal reference"></label><label>Administrator note<textarea id="listenerPaymentNote" maxlength="500" placeholder="Optional note shown in the wallet ledger"></textarea></label><p class="modal-copy">Use this only after the listener has been paid separately. The recorded amount is deducted from the listener wallet once and the listener is notified.</p><button class="primary">Record payment</button></form>`);
    $('#listenerPaymentForm').onsubmit = async event => {
      event.preventDefault();
      const amountPaise = Math.round(Number($('#listenerPaymentAmount').value) * 100);
      if (!Number.isInteger(amountPaise) || amountPaise <= 0 || amountPaise > balance) return P.toast('Enter a payment amount up to the current wallet balance.', 'error');
      const button = event.submitter;
      button?.setAttribute('disabled', '');
      try {
        await P.api(`/api/admin/listener-wallets/${id}/mark-paid`, { method: 'POST', body: JSON.stringify({ amountPaise, paymentReference: $('#listenerPaymentReference').value, note: $('#listenerPaymentNote').value }) });
        closeAdminModal();
        P.toast(`${P.moneyExact(amountPaise)} recorded as paid.`, 'success');
        loadListenerWallets(); loadDashboard(); loadUsers(); loadAudit();
      } catch (error) {
        button?.removeAttribute('disabled');
        P.toast(error.message, 'error');
      }
    };
  }

  function adjustListenerWallet(id) {
    const listener = listenerWallets.find(item => item.id === id);
    if (!listener) return;
    modal(`Adjust wallet — ${listener.name}`, `<form id="listenerAdjustmentForm" class="stack"><p class="modal-copy">Current balance: <b>${P.moneyExact(listener.balance_paise)}</b>. Use a positive amount to add money or a negative amount to remove it.</p><label>Adjustment in rupees<input id="listenerAdjustmentAmount" type="number" step="0.01" required placeholder="Example: 50 or -20"></label><label>Reason<input id="listenerAdjustmentNote" maxlength="500" required placeholder="Reason shown in the audit history"></label><button class="primary">Apply adjustment</button></form>`);
    $('#listenerAdjustmentForm').onsubmit = async event => {
      event.preventDefault();
      const button = event.submitter;
      button?.setAttribute('disabled', '');
      try {
        await P.api(`/api/admin/listener-wallets/${id}/adjust`, { method: 'POST', body: JSON.stringify({ amountPaise: Math.round(Number($('#listenerAdjustmentAmount').value) * 100), note: $('#listenerAdjustmentNote').value }) });
        closeAdminModal();
        P.toast('Listener wallet adjusted.', 'success');
        loadListenerWallets(); loadUsers(); loadAudit();
      } catch (error) {
        button?.removeAttribute('disabled');
        P.toast(error.message, 'error');
      }
    };
  }

  function minutesModal(id) {
    const user = users.find(item => item.id === id);
    if (!user) return;
    modal(`Adjust minutes — ${user.name}`, '<form id="minutesForm" class="stack"><label>Minute change<input id="minutesDelta" type="number" placeholder="Example: 10 or -5" required></label><label>Reason<input id="minutesNote" required placeholder="Reason for this wallet change"></label><button class="primary">Apply adjustment</button></form>');
    $('#minutesForm').onsubmit = async event => {
      event.preventDefault();
      try {
        await P.api(`/api/admin/users/${id}/adjust-minutes`, { method: 'POST', body: JSON.stringify({ secondsDelta: Number($('#minutesDelta').value) * 60, note: $('#minutesNote').value }) });
        closeAdminModal(); P.toast('Wallet balance updated.', 'success'); loadUsers();
      } catch (error) { P.toast(error.message, 'error'); }
    };
  }

  function suspendModal(id) {
    const user = users.find(item => item.id === id);
    if (!user) return;
    modal(`Suspend — ${user.name}`, '<form id="suspendForm" class="stack"><label>Duration<input id="suspendDuration" type="number" min="1" value="1" required></label><label>Unit<select id="suspendUnit"><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days" selected>Days</option></select></label><label>Reason<textarea id="suspendReason" required placeholder="Explain the restriction"></textarea></label><button class="warning">Suspend account</button><button type="button" id="activateNow" class="ghost">Activate now</button></form>');
    $('#suspendForm').onsubmit = async event => {
      event.preventDefault();
      const multiplier = $('#suspendUnit').value === 'minutes' ? 1 : $('#suspendUnit').value === 'hours' ? 60 : 1440;
      await patchUser(id, { status: 'suspended', suspendMinutes: Number($('#suspendDuration').value) * multiplier, reason: $('#suspendReason').value });
      closeAdminModal();
    };
    $('#activateNow').onclick = async () => { await setUserStatus(id, 'active'); closeAdminModal(); };
  }

  async function setUserStatus(id, status) {
    if (status === 'blocked' && !confirm('Block this account and end any active session?')) return;
    await patchUser(id, { status });
  }

  async function patchUser(id, body) {
    try {
      await P.api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      P.toast('Account updated.', 'success'); loadUsers(); loadAudit();
    } catch (error) { P.toast(error.message, 'error'); }
  }

  async function resetPassword(id) {
    const password = prompt('New temporary password (at least 8 characters):');
    if (!password) return;
    try {
      await P.api(`/api/admin/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword: password }) });
      P.toast('Password reset completed. Existing sessions were revoked.', 'success'); loadResets(); loadAudit();
    } catch (error) { P.toast(error.message, 'error'); }
  }

  async function createEmployee(event) {
    event.preventDefault();
    try {
      await P.api('/api/admin/employees', { method: 'POST', body: JSON.stringify({ name: $('#empName').value, username: $('#empUsername').value, email: $('#empEmail').value, password: $('#empPassword').value, employeeCode: $('#empCode').value, phone: $('#empPhone').value, ratePaise: Math.round(Number($('#empRate').value) * 100), bio: $('#empBio').value, language: $('#empLanguage').value }) });
      event.target.reset(); $('#empLanguage').value = 'Malayalam'; P.toast('Listener created.', 'success'); loadUsers();
    } catch (error) { P.toast(error.message, 'error'); }
  }

  let loadedPlans = [];
  async function loadPlans() {
    try {
      loadedPlans = (await P.api('/api/admin/plans')).plans || [];
      $('#plansList').innerHTML = loadedPlans.map(plan => `<div class="mini-card"><div><strong>${P.esc(plan.name)} ${plan.popular ? '★' : ''}</strong><p>${P.money(plan.price_paise)} • ${P.duration(plan.seconds)}</p></div><div class="actions"><button class="ghost" data-plan-edit="${plan.id}">Edit</button><button class="${plan.active ? 'danger' : 'ghost'}" data-plan-toggle="${plan.id}" data-active="${plan.active}">${plan.active ? 'Disable' : 'Enable'}</button></div></div>`).join('') || '<p>No plans.</p>';
    } catch (error) { P.toast(error.message, 'error'); }
  }

  async function createPlan(event) {
    event.preventDefault();
    try {
      await P.api('/api/admin/plans', { method: 'POST', body: JSON.stringify({ name: $('#planName').value, pricePaise: Number($('#planPrice').value) * 100, seconds: Number($('#planMinutes').value) * 60, popular: $('#planPopular').checked }) });
      event.target.reset(); P.toast('Plan created.', 'success'); loadPlans();
    } catch (error) { P.toast(error.message, 'error'); }
  }

  function editPlan(id) {
    const plan = loadedPlans.find(item => item.id === id);
    if (!plan) return;
    modal('Edit plan', `<form id="editPlanForm" class="stack"><label>Name<input id="epName" value="${P.esc(plan.name)}" required></label><label>Price in INR<input id="epPrice" type="number" min="1" value="${plan.price_paise / 100}" required></label><label>Minutes<input id="epMinutes" type="number" min="1" value="${plan.seconds / 60}" required></label><label class="check"><input id="epPopular" type="checkbox" ${plan.popular ? 'checked' : ''}><span>Popular</span></label><button class="primary">Save plan</button></form>`);
    $('#editPlanForm').onsubmit = async event => { event.preventDefault(); await updatePlan(id, { name: $('#epName').value, pricePaise: Number($('#epPrice').value) * 100, seconds: Number($('#epMinutes').value) * 60, popular: $('#epPopular').checked }); closeAdminModal(); };
  }

  async function updatePlan(id, body) {
    try { await P.api(`/api/admin/plans/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); P.toast('Plan updated.', 'success'); loadPlans(); }
    catch (error) { P.toast(error.message, 'error'); }
  }

  async function loadCoupons() {
    try {
      const coupons = (await P.api('/api/admin/coupons')).coupons || [];
      $('#couponsList').innerHTML = coupons.map(coupon => `<div class="mini-card"><div><strong>${P.esc(coupon.code)}</strong><p>${P.duration(coupon.seconds)} • Used ${coupon.used_count}${coupon.max_uses ? '/' + coupon.max_uses : ''}</p><p>${P.esc(coupon.label || '')} ${coupon.expires_at ? '• expires ' + P.date(coupon.expires_at) : ''}</p></div><div class="actions"><button class="ghost" data-copy="${P.esc(coupon.code)}">Copy</button><button class="${coupon.active ? 'danger' : 'ghost'}" data-coupon="${coupon.id}" data-active="${coupon.active}">${coupon.active ? 'Disable' : 'Enable'}</button></div></div>`).join('') || '<p>No coupons.</p>';
    } catch (error) { P.toast(error.message, 'error'); }
  }

  async function createCoupon(event) {
    event.preventDefault();
    try {
      const data = await P.api('/api/admin/coupons', { method: 'POST', body: JSON.stringify({ code: $('#couponCode').value, label: $('#couponLabel').value, seconds: Number($('#couponMinutes').value) * 60, maxUses: $('#couponUses').value || null, expiresAt: $('#couponExpiry').value || null }) });
      event.target.reset(); P.toast(`Coupon ${data.coupon.code} created.`, 'success'); loadCoupons();
    } catch (error) { P.toast(error.message, 'error'); }
  }

  async function toggleCoupon(id, active) {
    try { await P.api(`/api/admin/coupons/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }); loadCoupons(); }
    catch (error) { P.toast(error.message, 'error'); }
  }

  async function loadCalls() {
    try { calls = (await P.api('/api/admin/calls')).calls || []; renderCalls(); }
    catch (error) { P.toast(error.message, 'error'); }
  }

  function renderCalls() {
    const query = ($('#callSearch')?.value || '').toLowerCase();
    const list = calls.filter(call => `${call.customer_name} ${call.employee_name}`.toLowerCase().includes(query));
    $('#callsTable').innerHTML = list.map(call => `<tr><td>${profileLink(call.customer_id, call.customer_name, call.customer_email || '')}</td><td>${profileLink(call.employee_id, call.employee_name, call.employee_email || '')}</td><td><span class="pill ${P.esc(call.status)}">${P.esc(call.status)}</span></td><td>${P.duration(call.billed_seconds)}</td><td>${P.moneyExact(call.listener_rate_paise)}</td><td>${P.moneyExact(call.listener_earnings_paise)}</td><td>${P.date(call.started_at || call.created_at)}</td><td>${P.esc(call.end_reason || '—')}</td></tr>`).join('') || '<tr><td colspan="8">No calls match this search.</td></tr>';
  }

  async function loadReports() {
    try {
      reports = (await P.api('/api/admin/reports')).reports || [];
      $('#reportsList').innerHTML = reports.map(report => `<article class="ticket"><div><div><span class="pill ${P.esc(report.status)}">${P.esc(report.status)}</span> ${report.priority === 'high' ? '<span class="pill open">HIGH</span>' : ''}</div><strong>${profileLink(report.reporter_id, report.reporter_name)} <span class="connection-arrow">→</span> ${profileLink(report.target_id, report.target_name || 'Unknown')}</strong><p><b>${P.esc(report.reason)}</b></p><p>${P.esc(report.details || '')}</p><small>${P.date(report.created_at)}</small>${report.admin_note ? `<p>Admin note: ${P.esc(report.admin_note)}</p>` : ''}</div><div class="actions"><button class="warning" data-report-review="${report.id}">Review</button><button class="ghost" data-report-close="${report.id}">Close</button>${report.target_id ? `<button class="danger" data-target="${report.target_id}">Suspend target</button>` : ''}</div></article>`).join('') || '<p>No reports.</p>';
    } catch (error) { P.toast(error.message, 'error'); }
  }

  async function updateReport(id, status) {
    const note = prompt('Administrator note (optional):') || '';
    try { await P.api(`/api/admin/reports/${id}`, { method: 'PATCH', body: JSON.stringify({ status, adminNote: note }) }); P.toast('Report updated.', 'success'); loadReports(); }
    catch (error) { P.toast(error.message, 'error'); }
  }

  async function loadSupport() {
    try {
      tickets = (await P.api('/api/admin/support')).tickets || [];
      $('#supportList').innerHTML = tickets.map(ticket => `<article class="ticket"><div><span class="pill ${P.esc(ticket.status)}">${P.esc(ticket.status)}</span><strong>${P.esc(ticket.subject)} — ${profileLink(ticket.customer_id, ticket.customer_name, ticket.customer_email)}</strong><p>${P.esc(ticket.message)}</p>${ticket.admin_reply ? `<p><b>Reply:</b> ${P.esc(ticket.admin_reply)}</p>` : ''}<small>${P.date(ticket.created_at)}</small></div><button class="primary" data-reply="${ticket.id}">Reply</button></article>`).join('') || '<p>No support messages.</p>';
    } catch (error) { P.toast(error.message, 'error'); }
  }

  function replySupport(id) {
    const ticket = tickets.find(item => item.id === id);
    if (!ticket) return;
    modal(`Reply — ${ticket.subject}`, `<form id="replyForm" class="stack"><label>Reply<textarea id="replyText" required>${P.esc(ticket.admin_reply || '')}</textarea></label><label>Status<select id="replyStatus"><option value="replied">Replied</option><option value="closed">Closed</option></select></label><button class="primary">Send reply</button></form>`);
    $('#replyForm').onsubmit = async event => {
      event.preventDefault();
      try { await P.api(`/api/admin/support/${id}`, { method: 'PATCH', body: JSON.stringify({ adminReply: $('#replyText').value, status: $('#replyStatus').value }) }); closeAdminModal(); P.toast('Reply sent.', 'success'); loadSupport(); }
      catch (error) { P.toast(error.message, 'error'); }
    };
  }

  async function loadResets() {
    try {
      resets = (await P.api('/api/admin/password-resets')).requests || [];
      $('#resetList').innerHTML = resets.map(request => `<article class="ticket"><div><span class="pill ${P.esc(request.status)}">${P.esc(request.status)}</span><strong>${profileLink(request.user_id, request.name, request.email || request.username)}</strong><p>${P.esc(request.role)} • requested ${P.date(request.created_at)} • expires ${P.date(request.expires_at)}</p>${request.admin_message ? `<p><b>Admin message:</b> ${P.esc(request.admin_message)}</p>` : ''}</div>${request.status === 'open' ? `<div class="actions"><button class="primary" data-reset-approve="${request.id}">Approve</button><button class="danger" data-reset-decline="${request.id}">Decline</button></div>` : ''}</article>`).join('') || '<p>No reset requests.</p>';
    } catch (error) { P.toast(error.message, 'error'); }
  }

  async function reviewReset(id, action) {
    const message = prompt(`Optional message for the user (${action}):`) || '';
    try { await P.api(`/api/admin/password-resets/${id}`, { method: 'PATCH', body: JSON.stringify({ action, adminMessage: message }) }); P.toast(`Recovery request ${action}.`, 'success'); loadResets(); }
    catch (error) { P.toast(error.message, 'error'); }
  }

  async function loadAudit() {
    try {
      auditEntries = (await P.api('/api/admin/audit-log')).entries || [];
      $('#auditList').innerHTML = auditEntries.map(entry => `<article class="audit-entry"><span class="audit-method">${P.esc(String(entry.action || '').split(' ')[0])}</span><div><strong>${P.esc(entry.action)}</strong><p>${P.esc(entry.admin_name || 'Administrator')} • ${P.esc(entry.route || '')}</p><small>${P.date(entry.created_at)}${entry.ip_address ? ` • ${P.esc(entry.ip_address)}` : ''}</small></div>${entry.target_id && ['users', 'employees'].includes(entry.target_type) ? `<button class="ghost" data-user-profile="${P.esc(entry.target_id)}">Open profile</button>` : ''}</article>`).join('') || '<p>No administrator actions recorded.</p>';
    } catch (error) { P.toast(error.message, 'error'); }
  }

  async function sendBroadcast(event) {
    event.preventDefault();
    try {
      const data = await P.api('/api/admin/notifications', { method: 'POST', body: JSON.stringify({ userId: $('#broadcastUser').value || null, title: $('#broadcastTitle').value, body: $('#broadcastBody').value }) });
      $('#broadcastBody').value = ''; P.toast(`${data.sent} user(s) notified.`, 'success');
    } catch (error) { P.toast(error.message, 'error'); }
  }

  async function changeAdminUsername(event) {
    event.preventDefault();
    try {
      await P.api('/api/auth/change-login', { method: 'POST', body: JSON.stringify({ newUsername: $('#adminNewUsername').value, currentPassword: $('#adminUsernamePassword').value }) });
      P.toast('Administrator username changed. Sign in again.', 'success');
      setTimeout(leaveAdminSession, 900);
    } catch (error) { P.toast(error.message, 'error'); }
  }

  async function changePassword(event) {
    event.preventDefault();
    try {
      await P.api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: $('#adminCurrent').value, newPassword: $('#adminNew').value }) });
      event.target.reset(); P.toast('Administrator password changed. All sessions were signed out.', 'success');
      setTimeout(leaveAdminSession, 900);
    } catch (error) { P.toast(error.message, 'error'); }
  }

  init();
})();
