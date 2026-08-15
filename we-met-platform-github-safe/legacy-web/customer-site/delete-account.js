(() => {
  'use strict';

  const form = document.querySelector('#deleteAccountForm');
  const button = document.querySelector('#deleteSubmit');
  const status = document.querySelector('#deleteStatus');

  function show(message, type) {
    status.textContent = message;
    status.className = `form-status ${type || ''}`.trim();
  }

  async function request(path, options) {
    const response = await fetch(path, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
    return body;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (document.querySelector('#deleteConfirmation').value !== 'DELETE') {
      show('Type DELETE exactly to continue.', 'error');
      return;
    }
    button.disabled = true;
    show('Verifying your account…');
    try {
      const email = document.querySelector('#deleteEmail').value.trim();
      const password = document.querySelector('#deletePassword').value;
      const login = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: email, password }),
      });
      if (login.user?.role !== 'customer') throw new Error('This page is for We Met member accounts only.');
      const result = await request('/api/auth/account-deletion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
        body: JSON.stringify({ password, confirmation: 'DELETE' }),
      });
      form.reset();
      show(result.message || 'Your account and associated data were deleted.', 'success');
    } catch (error) {
      show(error.message || 'Account deletion failed. Please try again.', 'error');
    } finally {
      button.disabled = false;
    }
  });
})();
