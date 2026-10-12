(() => {
  'use strict';
  const form = document.getElementById('deleteAccountForm');
  const status = document.getElementById('deleteStatus');
  const base = String(window.PORTAL_CONFIG?.API_BASE_URL || '').replace(/\/$/, '');
  function show(message, ok = false) { status.hidden = false; status.textContent = message; status.dataset.ok = ok ? '1' : '0'; }
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const phone = document.getElementById('deletePhone').value.replace(/\D/g, '');
    const password = document.getElementById('deletePassword').value;
    const confirmation = document.getElementById('deleteConfirm').value.trim().toUpperCase();
    if (confirmation !== 'DELETE') return show('Type DELETE exactly to continue.');
    const button = form.querySelector('button'); button.disabled = true;
    try {
      const loginResponse = await fetch(`${base}/api/auth/login`, { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body:JSON.stringify({ identifier: phone, password, role: 'customer' }) });
      const login = await loginResponse.json();
      if (!loginResponse.ok || !login.token) throw new Error(login.error || 'Could not verify this customer account.');
      if (login.user?.role !== 'customer') throw new Error('This deletion page is for customer accounts.');
      const response = await fetch(`${base}/api/auth/account`, { method:'DELETE', headers:{'Content-Type':'application/json','Accept':'application/json','Authorization':`Bearer ${login.token}`}, body:JSON.stringify({ password, confirmation }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Account deletion could not be completed.');
      try { localStorage.removeItem(window.PORTAL_CONFIG?.TOKEN_KEY || 'we_met_customer_token'); } catch {}
      form.reset(); show(data.message || 'Your account has been deleted.', true); button.textContent = 'Account deleted';
    } catch (error) { show(error.message || 'Account deletion could not be completed.'); button.disabled = false; }
  });
})();
