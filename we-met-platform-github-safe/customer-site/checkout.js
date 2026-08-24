(() => {
  'use strict';

  const P = window.Portal;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const planId = new URLSearchParams(location.search).get('plan') || '';
  const walletUrl = 'index.html?tab=wallet';
  const mobileCheckout = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && window.matchMedia('(max-width: 1024px)').matches);
  const fallbackBanks = [
    ['SBIN', 'State Bank of India'],
    ['HDFC', 'HDFC Bank'],
    ['ICIC', 'ICICI Bank'],
    ['UTIB', 'Axis Bank'],
    ['KKBK', 'Kotak Mahindra Bank'],
  ];

  let me = null;
  let plan = null;
  let razorpayLoader = null;
  let checkoutClient = null;
  let checkoutOrder = null;
  let preparingPayment = false;
  let paymentBusy = false;

  function showOnly(id) {
    ['checkoutLoading', 'checkoutError', 'checkoutView', 'checkoutSuccess', 'checkoutPending']
      .forEach((name) => { document.getElementById(name).hidden = name !== id; });
  }

  function showError(message) {
    $('#checkoutErrorMessage').textContent = message || 'Return to the wallet and choose the pack again.';
    showOnly('checkoutError');
  }

  function paymentStatus(message = '', type = 'info') {
    const node = $('#paymentStatus');
    node.textContent = message;
    node.className = `payment-status ${type === 'error' ? 'error' : ''}`.trim();
    node.hidden = !message;
  }

  function minuteText(seconds) {
    const value = Number(seconds) || 0;
    return value % 60 === 0 ? `${value / 60} minutes` : P.duration(value);
  }

  function renderPlan() {
    const minutes = Math.round(Number(plan.seconds) / 60);
    const amount = P.money(plan.price_paise);
    $('#planMinutes').textContent = String(minutes);
    $('#planName').textContent = plan.name;
    $('#planDuration').textContent = minuteText(plan.seconds);
    $('#planPrice').textContent = amount;
    $('#payButton').textContent = `Continue · ${amount}`;
    $('#cardPaymentForm button[type="submit"]').textContent = `Pay ${amount} by card`;
    $('#netbankingPaymentForm button[type="submit"]').textContent = `Pay ${amount} with bank`;
    $('#walletPaymentForm button[type="submit"]').textContent = `Pay ${amount} with wallet`;
    showOnly('checkoutView');
  }

  function loadRazorpayCustomCheckout() {
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
        else reject(new Error('Secure payment did not initialize. Please try again.'));
      };
      script.onerror = () => {
        cleanup();
        script.remove();
        reject(new Error('Secure payment could not load. Check your connection and try again.'));
      };
      timeout = window.setTimeout(() => {
        cleanup();
        script.remove();
        reject(new Error('Secure payment is taking too long to load. Please try again.'));
      }, 15000);
      script.src = 'https://checkout.razorpay.com/v1/razorpay.js';
      script.async = true;
      script.dataset.weMetRazorpay = 'true';
      document.head.appendChild(script);
    }).catch((error) => {
      razorpayLoader = null;
      throw error;
    });
    return razorpayLoader;
  }

  function setPayControlsDisabled(disabled) {
    $$('[data-pay-control]').forEach((control) => { control.disabled = disabled; });
  }

  function resetPaymentScreen(message = '', type = 'info') {
    paymentBusy = false;
    document.body.classList.remove('payment-open');
    $('#paymentProcessing').hidden = true;
    $('#paymentChooser').hidden = false;
    $('#cancelPayment').hidden = false;
    setPayControlsDisabled(false);
    paymentStatus(message, type);
  }

  function showSuccess(response) {
    paymentBusy = false;
    document.body.classList.remove('payment-open');
    $('#successMessage').textContent = response.message || `${plan.name} was added to your wallet.`;
    $('#successBalance').textContent = `Wallet balance: ${P.duration(response.balance_seconds)}`;
    showOnly('checkoutSuccess');
  }

  function showPending(error, payment) {
    paymentBusy = false;
    document.body.classList.remove('payment-open');
    const reference = payment?.razorpay_payment_id ? ` Reference: ${payment.razorpay_payment_id}.` : '';
    $('#pendingMessage').textContent = `${error.message || 'Your wallet is still updating.'}${reference} Please don’t make the payment again.`;
    showOnly('checkoutPending');
  }

  function readableLabel(code) {
    return String(code || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function methodEntries(source) {
    if (!source || source === true || source === false) return [];
    if (Array.isArray(source)) {
      return source.flatMap((item) => {
        if (typeof item === 'string') return [{ code: item, label: readableLabel(item) }];
        if (!item || typeof item !== 'object' || item.enabled === false) return [];
        const code = item.code || item.id || item.key || item.provider;
        if (!code) return [];
        return [{ code: String(code), label: String(item.name || item.label || item.display_name || readableLabel(code)) }];
      });
    }
    if (typeof source !== 'object') return [];
    return Object.entries(source).flatMap(([code, value]) => {
      if (value === false || value == null) return [];
      if (typeof value === 'string') return [{ code, label: value }];
      if (value === true) return [{ code, label: readableLabel(code) }];
      if (typeof value === 'object') {
        if (value.enabled === false) return [];
        const label = value.name || value.label || value.display_name || value.displayName;
        if (label) return [{ code, label: String(label) }];
        const nested = methodEntries(value);
        return nested.length ? nested : [{ code, label: readableLabel(code) }];
      }
      return [];
    });
  }

  function fillSelect(select, entries, placeholder) {
    select.replaceChildren();
    const first = document.createElement('option');
    first.value = '';
    first.textContent = placeholder;
    first.disabled = true;
    first.selected = true;
    select.appendChild(first);
    entries
      .filter((entry, index, all) => entry.code && all.findIndex((item) => item.code === entry.code) === index)
      .sort((a, b) => a.label.localeCompare(b.label))
      .forEach((entry) => {
        const option = document.createElement('option');
        option.value = entry.code;
        option.textContent = entry.label;
        select.appendChild(option);
      });
  }

  function selectPaymentMethod(method) {
    $$('[data-payment-tab]').forEach((button) => {
      const active = button.dataset.paymentTab === method;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $$('[data-payment-panel]').forEach((panel) => { panel.hidden = panel.dataset.paymentPanel !== method; });
  }

  function renderPaymentMethods(methods) {
    const available = methods && typeof methods === 'object' ? methods : {};
    const receivedMethods = Object.keys(available).length > 0;
    const banks = methodEntries(available.netbanking);
    const wallets = methodEntries(available.wallet);
    const enabled = {
      upi: mobileCheckout && (!receivedMethods || available.upi !== false),
      card: !receivedMethods || available.card !== false,
      netbanking: available.netbanking !== false && (banks.length > 0 || !receivedMethods),
      wallet: wallets.length > 0,
    };

    const bankOptions = banks.length ? banks : fallbackBanks.map(([code, label]) => ({ code, label }));
    fillSelect($('#bankCode'), bankOptions, 'Choose a bank');
    fillSelect($('#walletCode'), wallets, 'Choose a wallet');

    $$('[data-payment-tab]').forEach((button) => { button.hidden = !enabled[button.dataset.paymentTab]; });
    const preferred = enabled.upi ? 'upi' : enabled.card ? 'card' : enabled.netbanking ? 'netbanking' : enabled.wallet ? 'wallet' : '';
    if (!preferred) throw new Error('No payment method is currently available. Please try again later.');
    selectPaymentMethod(preferred);
    $('#payButton').hidden = true;
    $('#paymentChooser').hidden = false;
    paymentStatus('');
  }

  function fetchAvailableMethods(client) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (methods = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(methods);
      };
      const timeout = window.setTimeout(() => finish(null), 4500);
      try {
        client.once('ready', (response) => finish(response?.methods || null));
      } catch {
        finish(null);
      }
    });
  }

  async function handlePaymentSuccess(payment) {
    paymentBusy = true;
    setPayControlsDisabled(true);
    $('#paymentChooser').hidden = true;
    $('#paymentProcessing').hidden = false;
    $('#cancelPayment').hidden = true;
    $('#processingTitle').textContent = 'Confirming your payment';
    $('#processingCopy').textContent = 'Please keep this page open for a moment.';
    paymentStatus('');
    try {
      const verified = await P.api('/api/verify-payment', {
        method: 'POST',
        timeout: 30000,
        body: JSON.stringify(payment),
      });
      showSuccess(verified);
    } catch (error) {
      showPending(error, payment);
    }
  }

  function handlePaymentError(response) {
    const error = response?.error || response || {};
    const cancelled = error.reason === 'payment_cancelled';
    const message = cancelled
      ? 'Payment cancelled. Choose a method whenever you’re ready.'
      : error.description || 'Payment was not completed. Please try again.';
    resetPaymentScreen(message, cancelled ? 'info' : 'error');
  }

  async function preparePayment() {
    if (!plan || preparingPayment || checkoutClient) return;
    preparingPayment = true;
    const button = $('#payButton');
    button.disabled = true;
    button.textContent = 'Preparing secure payment…';
    paymentStatus('Preparing secure payment…');
    try {
      await loadRazorpayCustomCheckout();
      const order = await P.api('/api/create-order', {
        method: 'POST',
        body: JSON.stringify({
          planId: plan.id,
          amount: Number(plan.price_paise),
          currency: 'INR',
          receipt: `wallet_${Date.now()}`,
        }),
      });
      if (!order?.order_id || !order?.key_id) throw new Error('Secure payment could not start. Please try again.');

      const client = new window.Razorpay({
        key: order.key_id,
        image: new URL('assets/icon-192.png', location.href).href,
        redirect: false,
      });
      checkoutClient = client;
      checkoutOrder = order;
      client.on('payment.success', handlePaymentSuccess);
      client.on('payment.error', handlePaymentError);
      const methods = await fetchAvailableMethods(client);
      renderPaymentMethods(methods);
    } catch (error) {
      checkoutClient = null;
      checkoutOrder = null;
      button.disabled = false;
      button.textContent = `Continue · ${P.money(plan.price_paise)}`;
      paymentStatus(error.message || 'Secure payment could not start. Please try again.', 'error');
    } finally {
      preparingPayment = false;
    }
  }

  function basePaymentData() {
    const data = {
      amount: Number(checkoutOrder.amount),
      currency: String(checkoutOrder.currency || 'INR'),
      order_id: checkoutOrder.order_id,
      description: `${plan.name} · ${minuteText(plan.seconds)}`,
    };
    const contact = String(me?.phone || '').replace(/[^+\d]/g, '');
    const email = String(me?.email || '').trim();
    if (contact) data.contact = contact;
    if (email) data.email = email;
    return data;
  }

  function showPaymentProcessing(title, copy) {
    paymentBusy = true;
    setPayControlsDisabled(true);
    document.body.classList.add('payment-open');
    $('#paymentChooser').hidden = true;
    $('#paymentProcessing').hidden = false;
    $('#cancelPayment').hidden = false;
    $('#processingTitle').textContent = title;
    $('#processingCopy').textContent = copy;
    paymentStatus('');
  }

  function startPayment(methodData, adapterOptions, title, copy) {
    if (!checkoutClient || !checkoutOrder || paymentBusy) return;
    showPaymentProcessing(title, copy);
    try {
      const data = { ...basePaymentData(), ...methodData };
      if (adapterOptions) checkoutClient.createPayment(data, adapterOptions);
      else checkoutClient.createPayment(data);
    } catch (error) {
      resetPaymentScreen(error.message || 'Payment could not start. Please try again.', 'error');
    }
  }

  function cancelPayment() {
    if (!paymentBusy) return;
    try { checkoutClient?.emit('payment.cancel'); } catch {}
    resetPaymentScreen('Payment cancelled. Choose a method whenever you’re ready.');
  }

  function validCardNumber(number) {
    if (!/^\d{13,19}$/.test(number)) return false;
    let sum = 0;
    let doubleDigit = false;
    for (let index = number.length - 1; index >= 0; index -= 1) {
      let digit = Number(number[index]);
      if (doubleDigit) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      doubleDigit = !doubleDigit;
    }
    return sum % 10 === 0;
  }

  function submitCardPayment(event) {
    event.preventDefault();
    const name = $('#cardName').value.trim();
    const number = $('#cardNumber').value.replace(/\D/g, '');
    const expiry = $('#cardExpiry').value.match(/^\s*(\d{2})\s*\/\s*(\d{2}|\d{4})\s*$/);
    const cvv = $('#cardCvv').value.replace(/\D/g, '');
    if (!name || !validCardNumber(number) || !expiry || !/^\d{3,4}$/.test(cvv)) {
      paymentStatus('Check the card name, number, expiry and CVV.', 'error');
      return;
    }
    const month = Number(expiry[1]);
    const shortYear = Number(expiry[2].slice(-2));
    const fullYear = 2000 + shortYear;
    const now = new Date();
    if (month < 1 || month > 12 || fullYear < now.getFullYear()
        || (fullYear === now.getFullYear() && month < now.getMonth() + 1)) {
      paymentStatus('Enter a valid future card expiry.', 'error');
      return;
    }
    startPayment({
      method: 'card',
      'card[name]': name,
      'card[number]': number,
      'card[expiry_month]': String(month).padStart(2, '0'),
      'card[expiry_year]': String(shortYear).padStart(2, '0'),
      'card[cvv]': cvv,
    }, null, 'Complete card verification', 'Follow the secure bank verification step to finish your payment.');
    $('#cardCvv').value = '';
  }

  function submitNetbankingPayment(event) {
    event.preventDefault();
    const bank = $('#bankCode').value;
    if (!bank) return paymentStatus('Choose your bank to continue.', 'error');
    startPayment({ method: 'netbanking', bank }, null, 'Complete payment with your bank', 'Return here after the bank confirms your payment.');
  }

  function submitWalletPayment(event) {
    event.preventDefault();
    const wallet = $('#walletCode').value;
    if (!wallet) return paymentStatus('Choose your wallet to continue.', 'error');
    startPayment({ method: 'wallet', wallet }, null, 'Complete payment in your wallet', 'Return here after the wallet confirms your payment.');
  }

  function returnToWallet(event) {
    event.preventDefault();
    if (paymentBusy) {
      try { checkoutClient?.emit('payment.cancel'); } catch {}
    }
    try {
      const previous = document.referrer ? new URL(document.referrer) : null;
      if (history.length > 1 && previous?.origin === location.origin && !previous.pathname.endsWith('/checkout.html')) {
        history.back();
        return;
      }
    } catch {}
    location.assign(walletUrl);
  }

  function bindPaymentControls() {
    $('#payButton').addEventListener('click', preparePayment);
    $('#cancelPayment').addEventListener('click', cancelPayment);
    $$('[data-payment-tab]').forEach((button) => {
      button.addEventListener('click', () => selectPaymentMethod(button.dataset.paymentTab));
    });
    $$('[data-upi-app]').forEach((button) => {
      button.addEventListener('click', () => {
        const app = button.dataset.upiApp;
        const label = button.querySelector('strong')?.textContent || 'UPI app';
        startPayment(
          { method: 'upi' },
          { app },
          `Complete payment in ${label}`,
          'Approve the payment in your UPI app, then return to We Met.',
        );
      });
    });
    $('#cardPaymentForm').addEventListener('submit', submitCardPayment);
    $('#netbankingPaymentForm').addEventListener('submit', submitNetbankingPayment);
    $('#walletPaymentForm').addEventListener('submit', submitWalletPayment);
    $('#cardNumber').addEventListener('input', (event) => {
      const digits = event.target.value.replace(/\D/g, '').slice(0, 19);
      event.target.value = digits.match(/.{1,4}/g)?.join(' ') || '';
    });
    $('#cardExpiry').addEventListener('input', (event) => {
      const digits = event.target.value.replace(/\D/g, '').slice(0, 6);
      event.target.value = digits.length > 2 ? `${digits.slice(0, 2)} / ${digits.slice(2)}` : digits;
    });
    $('#cardCvv').addEventListener('input', (event) => {
      event.target.value = event.target.value.replace(/\D/g, '').slice(0, 4);
    });
  }

  async function init() {
    document.querySelectorAll('[data-wallet-back]').forEach((link) => { link.addEventListener('click', returnToWallet); });
    bindPaymentControls();
    window.addEventListener('portal:session-invalid', () => location.replace(walletUrl));

    if (!P.Store.token) {
      location.replace(walletUrl);
      return;
    }
    if (!UUID_PATTERN.test(planId)) {
      showError('This top-up link is not valid. Return to the wallet and choose the pack again.');
      return;
    }
    try {
      const [account, response] = await Promise.all([
        P.api('/api/auth/me'),
        P.api('/api/customer/plans', { cache: 'no-store' }),
      ]);
      if (account.user?.role !== 'customer') throw new Error('Please sign in to your customer account.');
      me = account.user;
      plan = (response.plans || []).find((item) => item.id === planId);
      if (!plan) throw new Error('This talk-time pack is no longer available.');
      renderPlan();
    } catch (error) {
      if (P.isAuthError(error)) location.replace(walletUrl);
      else showError(error.message);
    }
  }

  init();
})();
