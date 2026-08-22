(() => {
  'use strict';

  const config = window.PORTAL_CONFIG || {};
  const base = String(config.API_BASE_URL || '').replace(/\/$/, '');
  const tokenKey = config.TOKEN_KEY || 'we_met_customer_token';
  const expectedRole = config.EXPECTED_ROLE || 'customer';

  function tokenRole(token) {
    try {
      const payload = String(token || '').split('.')[1];
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))).role || null;
    } catch { return null; }
  }

  function invalidateSession(message) {
    localStorage.removeItem(tokenKey);
    window.dispatchEvent(new CustomEvent('portal:session-invalid', { detail: { message } }));
  }

  const Store = {
    get token() {
      const token = localStorage.getItem(tokenKey);
      if (token && tokenRole(token) !== expectedRole) {
        invalidateSession('Please sign in to the customer portal again.');
        return null;
      }
      return token;
    },
    set token(value) { value ? localStorage.setItem(tokenKey, value) : localStorage.removeItem(tokenKey); },
    clear() { localStorage.removeItem(tokenKey); },
  };

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body !== undefined && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const sessionToken = Store.token;
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 20000);
    try {
      const response = await fetch(`${base}${path}`, { ...options, headers, signal: controller.signal });
      const isJson = (response.headers.get('content-type') || '').includes('json');
      const data = isJson ? await response.json() : await response.text();
      if (!response.ok) {
        if ((sessionToken && response.status === 401) || data?.code === 'ROLE_MISMATCH') invalidateSession(data?.error || 'Your session has expired.');
        throw Object.assign(new Error(data?.error || data || 'The request could not be completed.'), { status: response.status, code: data?.code });
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The server is taking too long to respond. Please try again.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
  }

  function duration(value = 0) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
      : `${minutes}:${String(remainder).padStart(2, '0')}`;
  }

  function date(value) {
    return value ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
  }

  function money(paise = 0) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format((Number(paise) || 0) / 100);
  }

  function toast(message, type = 'info') {
    let box = document.querySelector('.toast-box');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toast-box';
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.textContent = message;
    box.appendChild(item);
    requestAnimationFrame(() => item.classList.add('show'));
    setTimeout(() => {
      item.classList.remove('show');
      setTimeout(() => item.remove(), 250);
    }, 4200);
  }

  async function notify(title, body, options = {}) {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const registration = await navigator.serviceWorker?.ready;
        if (registration) {
          await registration.showNotification(title, {
            body,
            icon: 'assets/icon-192.png',
            badge: 'assets/favicon.png',
            tag: options.tag || 'we-met-update',
            renotify: options.renotify === true,
            requireInteraction: options.requireInteraction === true,
            data: { url: options.url || './' },
          });
        }
      } catch {}
    }
    toast(body);
  }

  window.Portal = {
    config,
    base,
    Store,
    api,
    esc: escapeHtml,
    duration,
    date,
    money,
    toast,
    notify,
    socketUrl: base || location.origin,
  };
})();
