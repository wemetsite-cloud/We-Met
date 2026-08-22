(() => {
  'use strict';

  const config = window.PORTAL_CONFIG || {};
  const base = String(config.API_BASE_URL || '').replace(/\/$/, '');
  const tokenKey = config.TOKEN_KEY || 'we_met_listener_token';
  const expectedRole = config.EXPECTED_ROLE || 'employee';
  let sessionInvalidated = false;

  function tokenRole(token) {
    try {
      const payload = String(token || '').split('.')[1];
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))).role || null;
    } catch { return null; }
  }

  function invalidateSession(message) {
    localStorage.removeItem(tokenKey);
    if (sessionInvalidated) return;
    sessionInvalidated = true;
    window.dispatchEvent(new CustomEvent('portal:session-invalid', { detail: { message } }));
  }

  const Store = {
    get token() {
      const token = localStorage.getItem(tokenKey);
      if (token && tokenRole(token) !== expectedRole) {
        invalidateSession('Please sign in to the listener portal again.');
        return null;
      }
      return token;
    },
    set token(value) {
      if (value) {
        localStorage.setItem(tokenKey, value);
        sessionInvalidated = false;
      } else {
        localStorage.removeItem(tokenKey);
      }
    },
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
      if (!error.status && (error instanceof TypeError || /failed to fetch|network error/i.test(error.message || ''))) {
        throw Object.assign(new Error('Could not reach the We Met server. Check your connection and try again.'), { code: 'NETWORK_ERROR' });
      }
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

  function moneyExact(paise = 0) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format((Number(paise) || 0) / 100);
  }

  function toast(message, type = 'info') {
    const text = String(message || 'Something went wrong.');
    let box = document.querySelector('.toast-box');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toast-box';
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    if ([...box.children].some((child) => child.dataset.message === text)) return;
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.dataset.message = text;
    item.textContent = text;
    box.appendChild(item);
    requestAnimationFrame(() => item.classList.add('show'));
    setTimeout(() => {
      item.classList.remove('show');
      setTimeout(() => item.remove(), 250);
    }, 4200);
  }

  async function notify(title, body) {
    // Listener portal intentionally uses in-app alerts only.
    // Incoming calls are delivered through the live Socket.IO connection.
    toast(title ? `${title}: ${body}` : body);
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
    moneyExact,
    toast,
    notify,
    isAuthError: (error) => error?.status === 401 || error?.code === 'ROLE_MISMATCH',
    socketUrl: base || location.origin,
  };
})();
