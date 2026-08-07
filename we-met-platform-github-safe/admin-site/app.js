(() => {
    'use strict';
    const P = window.Portal;
    let me = null, users = [], calls = [], reports = [], tickets = [], resets = [], payments = [], razorpayOrders = [], demoListeners = [];
    let liveRefreshTimer = null;
    let activePage = 'overview';
    const NAVIGATION_MARKER = 'we-met-admin-navigation';
    const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
    const show = (s, v = true) => $(s)?.classList.toggle('hidden', !v);
    function closeAdminModal({ fromHistory = false } = {}) { if (!fromHistory && history.state?.marker === NAVIGATION_MARKER && history.state.overlay === 'actionModal') { history.back(); return; } show('#actionModal', false); }
    async function registerFreshServiceWorker() {
        if (!('serviceWorker' in navigator))
            return;
        try {
            const registration = await navigator.serviceWorker.register('service-worker.js?v=5.14.0', { updateViaCache: 'none' });
            await registration.update();
        }
        catch { }
    }
    async function copyText(value) {
        try {
            if (navigator.clipboard?.writeText && window.isSecureContext) {
                await navigator.clipboard.writeText(value);
            } else {
                const area = document.createElement('textarea');
                area.value = value;
                area.setAttribute('readonly', '');
                area.style.position = 'fixed';
                area.style.opacity = '0';
                document.body.appendChild(area);
                area.select();
                if (!document.execCommand('copy')) throw new Error('Copy is unavailable.');
                area.remove();
            }
            P.toast('Copied.', 'success');
        } catch {
            P.toast('Could not copy automatically. Select the code and copy it manually.', 'error');
        }
    }
    const pageMeta = { overview: ['Overview', 'We Met platform live summary'], customers: ['Customers', 'Responsive account cards, contacts and wallet controls'], employees: ['Listeners', 'Female listener accounts and access'], plans: ['Plans', 'Talk-time pricing'], payments: ['Payments', 'Review UTR, screenshot and Razorpay history'], coupons: ['Coupons', 'Create wallet redeem codes'], calls: ['Calls', 'Every call and duration'], reports: ['Reports', 'Safety review and account actions'], support: ['Support', 'Customer messages'], resets: ['Password resets', 'Approve secure account recovery'], broadcast: ['Notifications', 'Send in-app/browser messages'], 'demo-listeners': ['Demo Listeners', 'Manage safe demo/test listener profiles and activity'], security: ['Security', 'Administrator password and launch safety'] };
    function bind() { $('#loginForm').onsubmit = login; $('#logout').onclick = () => { P.Store.clear(); location.reload(); }; $('#adminBackButton').onclick = () => { if (activePage !== 'overview') history.back(); }; $('#nav').onclick = e => { const b = e.target.closest('[data-page]'); if (!b)
        return; openPage(b.dataset.page); document.querySelector('.layout').classList.remove('menu-open'); }; $('#menuBtn').onclick = () => document.querySelector('.layout').classList.toggle('menu-open'); $('#employeeForm').onsubmit = createEmployee; $('#demoListenerForm').onsubmit = createDemoListener; $('#planForm').onsubmit = createPlan; $('#couponForm').onsubmit = createCoupon; $('#broadcastForm').onsubmit = sendBroadcast; $('#adminPasswordForm').onsubmit = changePassword; $('#adminUsernameForm').onsubmit = changeAdminUsername; $('#refreshLive').onclick = loadLive; $('#reloadCustomers').onclick = loadUsers; $('#reloadEmployees').onclick = loadUsers; $('#reloadDemoListeners').onclick = loadDemoListeners; $('#reloadPayments').onclick = loadPayments; $('#reloadCoupons').onclick = loadCoupons; $('#reloadCalls').onclick = loadCalls; $('#reloadReports').onclick = loadReports; $('#reloadSupport').onclick = loadSupport; $('#reloadResets').onclick = loadResets; $('#customerSearch').oninput = renderCustomers; $('#callSearch').oninput = renderCalls; $('#closeModal').onclick = () => closeAdminModal(); }
    async function init() { history.replaceState({ marker: NAVIGATION_MARKER, page: 'overview' }, document.title); window.addEventListener('popstate', (event) => { const page = event.state?.marker === NAVIGATION_MARKER ? event.state.page : 'overview'; closeAdminModal({ fromHistory: true }); openPage(page, { historyMode: 'none' }); }); bind(); registerFreshServiceWorker(); if (P.Store.token)
        await loadMe(); }
    async function login(e) { e.preventDefault(); try {
        const d = await P.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier: $('#username').value, password: $('#password').value }) });
        if (d.user.role !== 'admin')
            throw new Error('This is not an admin account.');
        P.Store.token = d.token;
        me = d.user;
        enter();
    }
    catch (x) {
        P.toast(x.message, 'error');
    } }
    async function loadMe() { try {
        const d = await P.api('/api/auth/me');
        if (d.user.role !== 'admin')
            throw 0;
        me = d.user;
        enter();
    }
    catch {
        P.Store.clear();
    } }
    function enter() { show('#loginView', false); show('#appView'); const adminName = document.querySelector('.admin-chip b'); if (adminName) adminName.textContent = me.name || 'Administrator'; openPage('overview', { historyMode: 'replace' }); loadDashboard(); loadUsers(); loadDemoListeners(); loadPlans(); loadPayments(); loadCoupons(); loadCalls(); loadReports(); loadSupport(); loadResets(); clearInterval(liveRefreshTimer); liveRefreshTimer = setInterval(() => { if (document.visibilityState === 'visible' && $('#page-overview').classList.contains('active')) loadLive(true); }, 10000); }
    function openPage(name, { historyMode = 'push' } = {}) { if (!pageMeta[name]) name = 'overview'; if (activePage !== name && historyMode === 'push') history.pushState({ marker: NAVIGATION_MARKER, page: name }, document.title); else if (historyMode === 'replace') history.replaceState({ marker: NAVIGATION_MARKER, page: name }, document.title); activePage = name; $('#adminBackButton').classList.toggle('hidden', name === 'overview'); const activeNavButton = $(`#nav [data-page="${name}"]`); $$('#nav button').forEach(b => b.classList.toggle('active', b === activeNavButton)); activeNavButton?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }); $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${name}`)); $('#pageTitle').textContent = pageMeta[name][0]; $('#pageDesc').textContent = pageMeta[name][1]; window.scrollTo({ top: 0, behavior: 'smooth' }); if (name === 'overview') {
        loadDashboard();
        loadLive();
    } if (name === 'customers' || name === 'employees' || name === 'demo-listeners')
        loadUsers(); if (name === 'plans')
        loadPlans(); if (name === 'payments')
        loadPayments(); if (name === 'coupons')
        loadCoupons(); if (name === 'calls')
        loadCalls(); if (name === 'reports')
        loadReports(); if (name === 'support')
        loadSupport(); if (name === 'resets')
        loadResets(); }
    async function loadDashboard() { try {
        const d = await P.api('/api/admin/dashboard');
        const count = r => d.users.find(x => x.role === r)?.count || 0;
        $('#mCustomers').textContent = count('customer');
        $('#mTalk').textContent = P.duration(d.totalTalkSeconds);
        $('#mAttention').textContent = (d.openReports || 0) + (d.openTickets || 0) + (d.pendingPayments || 0);
        $('#callSummary').innerHTML = (d.calls || []).map(x => `<div><small>${P.esc(x.status)}</small><strong>${x.count}</strong><span>${P.duration(x.seconds)}</span></div>`).join('') || '<p class="empty-copy">No calls yet.</p>';
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    async function loadLive(silent = false) { try {
        const d = await P.api('/api/admin/live');
        const onlineEmployees = d.onlineEmployees || [];
        const activeCalls = d.activeCalls || [];
        const byRole = d.onlineByRole || {};
        $('#mConcurrent').textContent = Number(d.concurrentUsers || 0);
        $('#mConcurrentBreakdown').textContent = `${Number(byRole.customer || 0)} customers • ${Number(byRole.employee || 0)} listeners`;
        $('#mOnline').textContent = onlineEmployees.length;
        $('#liveListeners').innerHTML = onlineEmployees.length ? onlineEmployees.map(x => `<div class="live-row"><div><strong>${P.esc(x.name)}</strong><p>${P.esc(x.bio || '')}</p></div><span class="pill ${x.status}">${P.esc(x.status)}</span></div>`).join('') : '<p class="empty-copy">No listeners online.</p>';
        $('#liveCalls').innerHTML = activeCalls.length ? activeCalls.map(x => `<div class="live-row"><div><strong>${x.id.slice(0, 8)}</strong><p>${x.status} • ${P.duration(x.billedSeconds)}</p></div><span class="pill busy">LIVE</span></div>`).join('') : '<p class="empty-copy">No live calls.</p>';
    }
    catch (e) {
        if (!silent) P.toast(e.message, 'error');
    } }
    async function loadUsers() { try {
        users = (await P.api('/api/admin/users')).users;
        renderCustomers();
        renderEmployees();
        const sel = $('#broadcastUser');
        sel.innerHTML = '<option value="">All customers and listeners</option>' + users.filter(x => x.role !== 'admin').map(x => `<option value="${x.id}">${P.esc(x.name)} — ${P.esc(x.email || x.username || '')}</option>`).join('');
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    function renderCustomers() {
        const all = users.filter(x => x.role === 'customer');
        const query = ($('#customerSearch')?.value || '').trim().toLowerCase();
        const list = all.filter(x => (`${x.name} ${x.email || ''} ${x.phone || ''}`).toLowerCase().includes(query));
        $('#customerCount').textContent = all.length;
        $('#customerActiveCount').textContent = all.filter(x => x.status === 'active').length;
        $('#customerPhoneCount').textContent = all.filter(x => x.phone).length;
        $('#customerWalletTotal').textContent = P.duration(all.reduce((total, item) => total + Number(item.balance_seconds || 0), 0));
        $('#customersTable').innerHTML = list.length ? list.map(u => {
            const initials = String(u.name || 'Customer').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
            return `<article class="customer-card" role="listitem"><header><span class="customer-avatar">${P.esc(initials)}</span><div><strong>${P.esc(u.name)}</strong><small>${P.esc(u.email || 'Email not provided')}</small></div><span class="pill ${u.status}">${P.esc(u.status)}</span></header><div class="customer-contact-grid"><div><small>Phone</small>${u.phone ? `<a class="phone-link" href="tel:${P.esc(u.phone)}">${P.esc(u.phone)}</a>` : '<span class="contact-missing">Not provided</span>'}</div><div><small>Wallet balance</small><strong>${P.duration(u.balance_seconds)}</strong></div><div><small>Joined</small><strong>${P.date(u.created_at)}</strong></div><div><small>Account</small><strong>${u.suspended_until ? `Suspended until ${P.date(u.suspended_until)}` : P.esc(u.status)}</strong></div></div><div class="customer-card-actions"><button class="ghost" data-details="${u.id}">Details</button><button class="primary" data-minutes="${u.id}">Minutes</button><button class="warning" data-suspend="${u.id}">Suspend</button><button class="${u.status === 'blocked' ? 'ghost' : 'danger'}" data-block="${u.id}" data-status="${u.status}">${u.status === 'blocked' ? 'Activate' : 'Block'}</button><button class="ghost" data-reset="${u.id}">Reset password</button></div></article>`;
        }).join('') : `<div class="customer-empty"><b>${query ? 'No matching customers' : 'No customers yet'}</b><p>${query ? 'Try a different name, email or phone number.' : 'New customer accounts will appear here automatically.'}</p></div>`;
        wireUserActions();
    }
    function renderEmployees() { const list = users.filter(x => x.role === 'employee'); $('#employeeCards').innerHTML = list.map(u => `<div class="mini-card"><div><strong>${P.esc(u.name)}</strong><p>${P.esc(u.email || '')} • ${P.esc(u.employee_code || '')}</p><p>${P.esc(u.bio || '')}</p></div><div class="actions"><span class="pill ${u.status}">${u.status}</span><span class="pill ${u.listener_availability === 'online' ? 'available' : P.esc(u.listener_availability || 'offline')}">${P.esc(u.listener_availability || 'offline')}</span><button class="ghost" data-details="${u.id}">Details</button><button class="warning" data-suspend="${u.id}">Suspend</button><button class="${u.status === 'blocked' ? 'ghost' : 'danger'}" data-block="${u.id}" data-status="${u.status}">${u.status === 'blocked' ? 'Activate' : 'Block'}</button><button class="ghost" data-reset="${u.id}">Reset pass</button></div></div>`).join('') || '<p>No listeners.</p>'; wireUserActions(); }
    function wireUserActions() { $$('[data-details]').forEach(b => b.onclick = () => showDetails(b.dataset.details)); $$('[data-minutes]').forEach(b => b.onclick = () => minutesModal(b.dataset.minutes)); $$('[data-suspend]').forEach(b => b.onclick = () => suspendModal(b.dataset.suspend)); $$('[data-block]').forEach(b => b.onclick = () => setUserStatus(b.dataset.block, b.dataset.status === 'blocked' ? 'active' : 'blocked')); $$('[data-reset]').forEach(b => b.onclick = () => resetPassword(b.dataset.reset)); }
    function modal(title, body) { $('#modalTitle').textContent = title; $('#modalBody').innerHTML = body; const opening = $('#actionModal').classList.contains('hidden'); show('#actionModal'); if (opening) history.pushState({ marker: NAVIGATION_MARKER, page: activePage, overlay: 'actionModal' }, document.title); }
    async function showDetails(id) { try {
        const d = await P.api(`/api/admin/users/${id}/details`), u = d.user;
        modal(`Details — ${u.name}`, `<div class="stack"><div class="mini-card"><div><strong>${P.esc(u.name)}</strong><p>Email: ${P.esc(u.email || 'Not provided')}</p><p>Phone: ${u.phone ? `<a class="phone-link" href="tel:${P.esc(u.phone)}">${P.esc(u.phone)}</a>` : 'Not provided'} • Role: ${P.esc(u.role)}</p><p>Balance: ${P.duration(u.balance_seconds)} • Status: ${P.esc(u.status)}</p></div></div><h3>Recent calls</h3>${d.calls.length ? d.calls.slice(0, 10).map(c => `<div class="mini-card"><div><strong>${P.esc(c.customer_name)} ↔ ${P.esc(c.employee_name)}</strong><p>${P.duration(c.billed_seconds)} • ${P.esc(c.status)} • ${P.date(c.created_at)}</p></div></div>`).join('') : '<p>No calls.</p>'}<h3>Wallet</h3>${d.wallet.length ? d.wallet.slice(0, 10).map(w => `<div class="mini-card"><div><strong>${w.seconds_delta > 0 ? '+' : '−'}${P.duration(Math.abs(w.seconds_delta))}</strong><p>${P.esc(w.note || w.type)} • ${P.date(w.created_at)}</p></div></div>`).join('') : '<p>No wallet entries.</p>'}<h3>Reports / support</h3><p>${d.reports.length} report(s), ${d.support.length} support ticket(s)</p></div>`);
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    function minutesModal(id) { const u = users.find(x => x.id === id); modal(`Adjust minutes — ${u.name}`, `<form id="minutesForm" class="stack"><input id="minutesDelta" type="number" placeholder="Minutes: +10 or -5" required><input id="minutesNote" placeholder="Reason"><button class="primary">Apply</button></form>`); $('#minutesForm').onsubmit = async (e) => { e.preventDefault(); try {
        await P.api(`/api/admin/users/${id}/adjust-minutes`, { method: 'POST', body: JSON.stringify({ secondsDelta: Number($('#minutesDelta').value) * 60, note: $('#minutesNote').value }) });
        closeAdminModal();
        P.toast('Balance updated.', 'success');
        loadUsers();
    }
    catch (x) {
        P.toast(x.message, 'error');
    } }; }
    function suspendModal(id) { const u = users.find(x => x.id === id); modal(`Suspend — ${u.name}`, `<form id="suspendForm" class="stack"><label>Duration<input id="suspendDuration" type="number" min="1" value="1" required></label><label>Unit<select id="suspendUnit"><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days" selected>Days</option></select></label><label>Reason<textarea id="suspendReason" placeholder="Explain the restriction"></textarea></label><button class="warning">Suspend account</button><button type="button" id="activateNow" class="ghost">Activate now</button></form>`); $('#suspendForm').onsubmit = async (e) => { e.preventDefault(); const duration = Number($('#suspendDuration').value); const unit = $('#suspendUnit').value; const multiplier = unit === 'minutes' ? 1 : unit === 'hours' ? 60 : 1440; await patchUser(id, { status: 'suspended', suspendMinutes: duration * multiplier, reason: $('#suspendReason').value }); closeAdminModal(); }; $('#activateNow').onclick = () => { setUserStatus(id, 'active'); closeAdminModal(); }; }
    async function setUserStatus(id, status) { if (status === 'blocked' && !confirm('Block this account?'))
        return; await patchUser(id, { status }); }
    async function patchUser(id, body) { try {
        await P.api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
        P.toast('Account updated.', 'success');
        loadUsers();
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    async function resetPassword(id) { const p = prompt('New temporary password (8+ characters):'); if (!p)
        return; try {
        await P.api(`/api/admin/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword: p }) });
        P.toast('Password reset completed.', 'success');
        loadResets();
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    async function createEmployee(e) { e.preventDefault(); try {
        await P.api('/api/admin/employees', { method: 'POST', body: JSON.stringify({ name: $('#empName').value, username: $('#empUsername').value, email: $('#empEmail').value, password: $('#empPassword').value, employeeCode: $('#empCode').value, phone: $('#empPhone').value, upiId: $('#empUpi').value, bio: $('#empBio').value }) });
        e.target.reset();
        P.toast('Listener created.', 'success');
        loadUsers();
    }
    catch (x) {
        P.toast(x.message, 'error');
    } }
    async function loadDemoListeners() { try { const d=await P.api('/api/admin/demo-listeners'); demoListeners=d.listeners||[]; $('#demoListenerCards').innerHTML=demoListeners.map(x=>`<div class="mini-card"><div><strong>${P.esc(x.name)}</strong><p>${P.esc(x.activity)} · ${x.randomize?'randomized':'fixed'}</p></div><div class="actions"><button class="ghost" data-demo-edit="${x.id}">Edit</button><button class="danger" data-demo-delete="${x.id}">Delete</button></div></div>`).join('') || '<p>No demo listeners yet.</p>'; $$('[data-demo-edit]').forEach(b=>b.onclick=()=>editDemo(b.dataset.demoEdit)); $$('[data-demo-delete]').forEach(b=>b.onclick=()=>deleteDemo(b.dataset.demoDelete)); } catch(e){P.toast(e.message,'error');} }
    async function createDemoListener(e){e.preventDefault();try{await P.api('/api/admin/demo-listeners',{method:'POST',body:JSON.stringify({name:$('#demoName').value,bio:$('#demoBio').value,avatar:$('#demoAvatar').value,activity:$('#demoActivity').value,randomize:$('#demoRandomize').checked})});e.target.reset();P.toast('Demo listener added.','success');loadDemoListeners();}catch(x){P.toast(x.message,'error');}}
    function editDemo(id){const x=demoListeners.find(a=>a.id===id);if(!x)return;modal('Edit demo listener',`<form id="editDemoForm" class="stack"><label>Name<input id="edName" value="${P.esc(x.name)}" required></label><label>Bio<textarea id="edBio">${P.esc(x.bio||'')}</textarea></label><label>Avatar<select id="edAvatar">${Array.from({length:20},(_,i)=>{const v=`assets/avatar-${String(i+1).padStart(2,'0')}.svg`;return `<option value="${v}" ${x.avatar===v?'selected':''}>Avatar ${String(i+1).padStart(2,'0')}</option>`}).join('')}</select></label><label>Activity<select id="edActivity"><option value="available">Online</option><option value="break">On break</option><option value="busy">On another call</option><option value="offline">Offline</option></select></label><label class="check"><input id="edRandom" type="checkbox" ${x.randomize?'checked':''}><span>Randomize activity</span></label><label class="check"><input id="edEnabled" type="checkbox" ${x.enabled?'checked':''}><span>Visible</span></label><button class="primary">Save changes</button></form>`);$('#edActivity').value=x.activity;$('#editDemoForm').onsubmit=async(e)=>{e.preventDefault();try{await P.api(`/api/admin/demo-listeners/${id}`,{method:'PATCH',body:JSON.stringify({name:$('#edName').value,bio:$('#edBio').value,avatar:$('#edAvatar').value,activity:$('#edActivity').value,randomize:$('#edRandom').checked,enabled:$('#edEnabled').checked})});closeAdminModal();loadDemoListeners();P.toast('Demo listener updated.','success');}catch(err){P.toast(err.message,'error')}}}
    async function deleteDemo(id){if(!confirm('Delete this demo listener?'))return;try{await P.api(`/api/admin/demo-listeners/${id}`,{method:'DELETE'});loadDemoListeners();P.toast('Demo listener deleted.','success')}catch(e){P.toast(e.message,'error')}}
    async function loadPlans() { try {
        const d = await P.api('/api/admin/plans');
        $('#plansList').innerHTML = d.plans.map(p => `<div class="mini-card"><div><strong>${P.esc(p.name)} ${p.popular ? '★' : ''}</strong><p>${P.money(p.price_paise)} • ${P.duration(p.seconds)}</p></div><div class="actions"><button class="ghost" data-plan-edit="${p.id}">Edit</button><button class="${p.active ? 'danger' : 'ghost'}" data-plan-toggle="${p.id}" data-active="${p.active}">${p.active ? 'Disable' : 'Enable'}</button></div></div>`).join('');
        $$('[data-plan-toggle]').forEach(b => b.onclick = () => updatePlan(b.dataset.planToggle, { active: b.dataset.active !== 'true' }));
        $$('[data-plan-edit]').forEach(b => b.onclick = () => editPlan(b.dataset.planEdit, d.plans));
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    async function createPlan(e) { e.preventDefault(); try {
        await P.api('/api/admin/plans', { method: 'POST', body: JSON.stringify({ name: $('#planName').value, pricePaise: Number($('#planPrice').value) * 100, seconds: Number($('#planMinutes').value) * 60, popular: $('#planPopular').checked }) });
        e.target.reset();
        P.toast('Plan created.', 'success');
        loadPlans();
    }
    catch (x) {
        P.toast(x.message, 'error');
    } }
    function editPlan(id, plans) { const p = plans.find(x => x.id === id); modal('Edit plan', `<form id="editPlanForm" class="stack"><input id="epName" value="${P.esc(p.name)}"><input id="epPrice" type="number" value="${p.price_paise / 100}"><input id="epMinutes" type="number" value="${p.seconds / 60}"><label class="check"><input id="epPopular" type="checkbox" ${p.popular ? 'checked' : ''}> Popular</label><button class="primary">Save</button></form>`); $('#editPlanForm').onsubmit = e => { e.preventDefault(); updatePlan(id, { name: $('#epName').value, pricePaise: Number($('#epPrice').value) * 100, seconds: Number($('#epMinutes').value) * 60, popular: $('#epPopular').checked }); closeAdminModal(); }; }
    async function updatePlan(id, b) { try {
        await P.api(`/api/admin/plans/${id}`, { method: 'PATCH', body: JSON.stringify(b) });
        P.toast('Plan updated.', 'success');
        loadPlans();
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    async function loadCoupons() { try {
        const d = await P.api('/api/admin/coupons');
        $('#couponsList').innerHTML = d.coupons.map(c => `<div class="mini-card"><div><strong>${P.esc(c.code)}</strong><p>${P.duration(c.seconds)} • Used ${c.used_count}${c.max_uses ? '/' + c.max_uses : ''}</p><p>${P.esc(c.label || '')} ${c.expires_at ? '• expires ' + P.date(c.expires_at) : ''}</p></div><div class="actions"><button class="ghost" data-copy="${P.esc(c.code)}">Copy</button><button class="${c.active ? 'danger' : 'ghost'}" data-coupon="${c.id}" data-active="${c.active}">${c.active ? 'Disable' : 'Enable'}</button></div></div>`).join('') || '<p>No coupons.</p>';
        $$('[data-copy]').forEach(b => b.onclick = () => copyText(b.dataset.copy));
        $$('[data-coupon]').forEach(b => b.onclick = () => toggleCoupon(b.dataset.coupon, b.dataset.active !== 'true'));
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    async function createCoupon(e) { e.preventDefault(); try {
        const d = await P.api('/api/admin/coupons', { method: 'POST', body: JSON.stringify({ code: $('#couponCode').value, label: $('#couponLabel').value, seconds: Number($('#couponMinutes').value) * 60, maxUses: $('#couponUses').value || null, expiresAt: $('#couponExpiry').value || null }) });
        e.target.reset();
        P.toast(`Coupon ${d.coupon.code} created.`, 'success');
        loadCoupons();
    }
    catch (x) {
        P.toast(x.message, 'error');
    } }
    async function toggleCoupon(id, active) { await P.api(`/api/admin/coupons/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }); loadCoupons(); }
    async function loadCalls() { try {
        calls = (await P.api('/api/admin/calls')).calls;
        renderCalls();
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    function renderCalls() { const q = ($('#callSearch')?.value || '').toLowerCase(), list = calls.filter(c => `${c.customer_name} ${c.employee_name}`.toLowerCase().includes(q)); $('#callsTable').innerHTML = list.map(c => `<tr><td><b>${P.esc(c.customer_name)}</b><br><small>${P.esc(c.customer_email || '')}</small></td><td>${P.esc(c.employee_name)}</td><td><span class="pill ${c.status}">${c.status}</span></td><td>${P.duration(c.billed_seconds)}</td><td>${P.date(c.started_at || c.created_at)}</td><td>${P.esc(c.end_reason || '—')}</td></tr>`).join(''); }
    async function loadReports() { try {
        reports = (await P.api('/api/admin/reports')).reports;
        $('#reportsList').innerHTML = reports.map(r => `<article class="ticket"><div><div><span class="pill ${r.status}">${r.status}</span> ${r.priority === 'high' ? '<span class="pill open">HIGH</span>' : ''}</div><strong>${P.esc(r.reporter_name)} (${r.reporter_role}) → ${P.esc(r.target_name || 'Unknown')}</strong><p><b>${P.esc(r.reason)}</b></p><p>${P.esc(r.details || '')}</p><small>${P.date(r.created_at)}</small>${r.admin_note ? `<p>Admin note: ${P.esc(r.admin_note)}</p>` : ''}</div><div class="actions"><button class="warning" data-report-review="${r.id}">Review</button><button class="ghost" data-report-close="${r.id}">Close</button>${r.target_id ? `<button class="danger" data-target="${r.target_id}">Suspend target</button>` : ''}</div></article>`).join('') || '<p>No reports.</p>';
        $$('[data-report-review]').forEach(b => b.onclick = () => updateReport(b.dataset.reportReview, 'reviewing'));
        $$('[data-report-close]').forEach(b => b.onclick = () => updateReport(b.dataset.reportClose, 'closed'));
        $$('[data-target]').forEach(b => b.onclick = () => suspendModal(b.dataset.target));
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    async function updateReport(id, status) { const note = prompt('Admin note (optional):') || ''; await P.api(`/api/admin/reports/${id}`, { method: 'PATCH', body: JSON.stringify({ status, adminNote: note }) }); loadReports(); }
    async function loadSupport() { try {
        tickets = (await P.api('/api/admin/support')).tickets;
        $('#supportList').innerHTML = tickets.map(t => `<article class="ticket"><div><span class="pill ${t.status}">${t.status}</span><strong>${P.esc(t.subject)} — ${P.esc(t.customer_name)}</strong><p>${P.esc(t.message)}</p>${t.admin_reply ? `<p><b>Reply:</b> ${P.esc(t.admin_reply)}</p>` : ''}<small>${P.esc(t.customer_email)} • ${P.date(t.created_at)}</small></div><button class="primary" data-reply="${t.id}">Reply</button></article>`).join('') || '<p>No support messages.</p>';
        $$('[data-reply]').forEach(b => b.onclick = () => replySupport(b.dataset.reply));
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    function replySupport(id) { const t = tickets.find(x => x.id === id); modal(`Reply — ${t.subject}`, `<form id="replyForm" class="stack"><textarea id="replyText" placeholder="Reply to customer">${P.esc(t.admin_reply || '')}</textarea><select id="replyStatus"><option value="replied">Replied</option><option value="closed">Closed</option></select><button class="primary">Send</button></form>`); $('#replyForm').onsubmit = async (e) => { e.preventDefault(); await P.api(`/api/admin/support/${id}`, { method: 'PATCH', body: JSON.stringify({ adminReply: $('#replyText').value, status: $('#replyStatus').value }) }); closeAdminModal(); P.toast('Reply sent.', 'success'); loadSupport(); }; }
    async function loadResets() { try {
        resets = (await P.api('/api/admin/password-resets')).requests;
        $('#resetList').innerHTML = resets.map(r => `<article class="ticket"><div><span class="pill ${r.status}">${r.status}</span><strong>${P.esc(r.name)} — ${P.esc(r.email || r.username)}</strong><p>${P.esc(r.role)} • requested ${P.date(r.created_at)} • expires ${P.date(r.expires_at)}</p>${r.admin_message ? `<p><b>Admin message:</b> ${P.esc(r.admin_message)}</p>` : ''}</div>${r.status === 'open' ? `<div class="actions"><button class="primary" data-reset-approve="${r.id}">Approve</button><button class="danger" data-reset-decline="${r.id}">Decline</button></div>` : ''}</article>`).join('') || '<p>No reset requests.</p>';
        $$('[data-reset-approve]').forEach(b => b.onclick = () => reviewReset(b.dataset.resetApprove, 'approved'));
        $$('[data-reset-decline]').forEach(b => b.onclick = () => reviewReset(b.dataset.resetDecline, 'declined'));
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    async function reviewReset(id, action) { const message = prompt(`Optional message for the user (${action}):`) || ''; try {
        await P.api(`/api/admin/password-resets/${id}`, { method: 'PATCH', body: JSON.stringify({ action, adminMessage: message }) });
        P.toast(`Recovery request ${action}.`, 'success');
        loadResets();
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    async function loadPayments() { try {
        const response = await P.api('/api/admin/payments');
        payments = response.payments || [];
        razorpayOrders = response.razorpayOrders || [];
        const automatic = razorpayOrders.map(p => {
            const reference = p.razorpay_payment_id || p.razorpay_order_id || '';
            return `<article class="ticket payment-review"><div><span class="pill ${p.status}">${P.esc(p.status)}</span><strong>${P.esc(p.customer_name)} — ${P.esc(p.plan_name)}</strong><p>${P.money(p.amount_paise)} • ${Math.round(p.seconds / 60)} minutes • ${P.date(p.created_at)}</p><p>${P.esc(p.customer_email || '')}${p.customer_phone ? ` • <a class="phone-link" href="tel:${P.esc(p.customer_phone)}">${P.esc(p.customer_phone)}</a>` : ''}${p.payment_method ? ` • ${P.esc(p.payment_method)}` : ''}</p><small>${P.esc(reference)}</small>${p.failure_description ? `<p><b>Razorpay:</b> ${P.esc(p.failure_description)}</p>` : ''}</div><div class="actions"><span class="gateway-label">Razorpay${p.credited_at ? ' • wallet credited' : ''}</span></div></article>`;
        }).join('');
        const manual = payments.map(p => { const method = p.payment_method === 'bank_transfer' ? 'Older bank transfer' : 'Direct UPI'; return `<article class="ticket payment-review"><div><span class="pill ${p.status}">${P.esc(p.status)}</span><strong>${P.esc(p.customer_name)} — ${P.esc(p.plan_name)}</strong><p>${P.money(p.amount_paise)} • ${Math.round(p.seconds / 60)} minutes • ${P.esc(method)} • ${P.date(p.created_at)}</p><p>${P.esc(p.customer_email || '')}${p.customer_phone ? ` • <a class="phone-link" href="tel:${P.esc(p.customer_phone)}">${P.esc(p.customer_phone)}</a>` : ''}</p><p class="payment-utr"><b>UPI transaction ID / UTR</b><strong>${P.esc(p.utr_reference || 'Missing')}</strong></p>${p.customer_note ? `<p><b>Customer note:</b> ${P.esc(p.customer_note)}</p>` : ''}${p.admin_message ? `<p><b>Admin message:</b> ${P.esc(p.admin_message)}</p>` : ''}</div><div class="actions payment-review-actions">${p.proof_size ? `<button class="ghost" data-payment-proof="${p.id}">View screenshot</button>` : '<span class="gateway-label">Screenshot missing</span>'}${p.status === 'pending' ? `<button class="primary" data-payment-approve="${p.id}" ${!p.proof_size || !p.utr_reference ? 'disabled' : ''}>Approve</button><button class="danger" data-payment-decline="${p.id}">Decline</button>` : ''}</div></article>`; }).join('');
        $('#paymentsList').innerHTML = `${manual ? `<div class="payment-group-heading"><b>Direct UPI verification</b><span>${payments.length} submission(s)</span></div>${manual}` : ''}${automatic ? `<div class="payment-group-heading"><b>Razorpay history</b><span>${razorpayOrders.length} order(s)</span></div>${automatic}` : ''}` || '<p>No payments yet.</p>';
        $$('[data-payment-proof]').forEach(b => b.onclick = () => viewPaymentProof(b.dataset.paymentProof));
        $$('[data-payment-approve]').forEach(b => b.onclick = () => reviewPayment(b.dataset.paymentApprove, 'approved'));
        $$('[data-payment-decline]').forEach(b => b.onclick = () => reviewPayment(b.dataset.paymentDecline, 'declined'));
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    async function viewPaymentProof(id) { try {
        const payment = payments.find(p => p.id === id);
        const blob = await P.file(`/api/admin/payments/${id}/proof`);
        const url = URL.createObjectURL(blob);
        modal(`Payment screenshot — ${payment?.customer_name || ''}`, `<img id="paymentProofImage" class="proof-image" alt="Uploaded payment screenshot"><p><b>Submitted UTR:</b> ${P.esc(payment?.utr_reference || 'Missing')}</p>`);
        $('#paymentProofImage').src = url;
        $('#paymentProofImage').onload = () => URL.revokeObjectURL(url);
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    async function reviewPayment(id, action) { const payment = payments.find(p => p.id === id); if (!payment) return;
        const message = action === 'declined' ? (prompt('Optional decline reason for the customer:') || '') : ''; try {
        await P.api(`/api/admin/payments/${id}`, { method: 'PATCH', body: JSON.stringify({ action, adminMessage: message }) });
        P.toast(action === 'approved' ? 'Payment approved and minutes added.' : 'Payment declined.', 'success');
        loadPayments();
        loadDashboard();
        loadUsers();
    }
    catch (e) {
        P.toast(e.message, 'error');
    } }
    async function sendBroadcast(e) { e.preventDefault(); try {
        const d = await P.api('/api/admin/notifications', { method: 'POST', body: JSON.stringify({ userId: $('#broadcastUser').value || null, title: $('#broadcastTitle').value, body: $('#broadcastBody').value }) });
        $('#broadcastBody').value = '';
        P.toast(`${d.sent} user(s) notified.`, 'success');
    }
    catch (x) {
        P.toast(x.message, 'error');
    } }
    async function changeAdminUsername(e) { e.preventDefault(); try {
        await P.api('/api/auth/change-login', { method: 'POST', body: JSON.stringify({ newUsername: $('#adminNewUsername').value, currentPassword: $('#adminUsernamePassword').value }) });
        P.toast('Admin username changed. Log in again.', 'success');
        setTimeout(() => { P.Store.clear(); location.reload(); }, 900);
    }
    catch (x) {
        P.toast(x.message, 'error');
    } }
    async function changePassword(e) { e.preventDefault(); try {
        await P.api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: $('#adminCurrent').value, newPassword: $('#adminNew').value }) });
        e.target.reset();
        P.toast('Admin password changed.', 'success');
    }
    catch (x) {
        P.toast(x.message, 'error');
    } }
    init();
})();
