(() => {
  'use strict';

  const P = window.Portal;
  const $ = (selector) => document.querySelector(selector);
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const planId = new URLSearchParams(location.search).get('plan') || '';
  const walletUrl = 'index.html?tab=wallet';
  let me = null;
  let plan = null;
  let razorpayLoader = null;
  let activeCheckout = null;

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
    $('#planMinutes').textContent = String(minutes);
    $('#planName').textContent = plan.name;
    $('#planDuration').textContent = minuteText(plan.seconds);
    $('#planPrice').textContent = P.money(plan.price_paise);
    $('#payButton').textContent = `Pay ${P.money(plan.price_paise)}`;
    showOnly('checkoutView');
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

  function restoreCheckout(message = '') {
    activeCheckout = null;
    document.body.classList.remove('payment-open');
    $('#payButton').disabled = false;
    $('#payButton').textContent = `Pay ${P.money(plan.price_paise)}`;
    paymentStatus(message);
  }

  function showSuccess(response) {
    activeCheckout = null;
    document.body.classList.remove('payment-open');
    $('#successMessage').textContent = response.message || `${plan.name} was added to your wallet.`;
    $('#successBalance').textContent = `Wallet balance: ${P.duration(response.balance_seconds)}`;
    showOnly('checkoutSuccess');
  }

  function showPending(error, payment) {
    activeCheckout = null;
    document.body.classList.remove('payment-open');
    const reference = payment?.razorpay_payment_id ? ` Reference: ${payment.razorpay_payment_id}.` : '';
    $('#pendingMessage').textContent = `${error.message || 'Your wallet is still updating.'}${reference} Please don’t make the payment again.`;
    showOnly('checkoutPending');
  }

  async function beginPayment() {
    if (!plan || activeCheckout) return;
    const button = $('#payButton');
    button.disabled = true;
    button.textContent = 'Opening secure payment…';
    paymentStatus('Opening secure payment…');
    try {
      await loadRazorpayCheckout();
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

      let handled = false;
      let failureMessage = '';
      const checkout = new window.Razorpay({
        key: order.key_id,
        amount: order.amount,
        currency: order.currency,
        order_id: order.order_id,
        name: 'We Met',
        description: `${plan.name} · ${minuteText(plan.seconds)}`,
        image: new URL('assets/icon-192.png', location.href).href,
        prefill: { name: me.name || '', contact: me.phone || '' },
        readonly: { contact: true },
        remember_customer: false,
        redirect: false,
        theme: { color: '#e62d7d', backdrop_color: '#0c0d10' },
        retry: { enabled: true },
        modal: {
          backdropclose: false,
          confirm_close: true,
          handleback: true,
          escape: true,
          animation: true,
          ondismiss: () => {
            if (!handled) restoreCheckout(failureMessage || 'Payment window closed. You can continue whenever you’re ready.');
          },
        },
        handler: async (payment) => {
          handled = true;
          paymentStatus('Confirming your payment…');
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
        },
      });
      activeCheckout = checkout;
      checkout.on('payment.failed', (response) => {
        failureMessage = response?.error?.description || 'Payment was not completed. Please try again.';
      });
      document.body.classList.add('payment-open');
      checkout.open();
    } catch (error) {
      restoreCheckout(error.message || 'Secure payment could not start. Please try again.');
      paymentStatus(error.message || 'Secure payment could not start. Please try again.', 'error');
    }
  }

  function returnToWallet(event) {
    event.preventDefault();
    try {
      const previous = document.referrer ? new URL(document.referrer) : null;
      if (history.length > 1 && previous?.origin === location.origin && !previous.pathname.endsWith('/checkout.html')) {
        history.back();
        return;
      }
    } catch {}
    location.assign(walletUrl);
  }

  async function init() {
    document.querySelectorAll('[data-wallet-back]').forEach((link) => { link.addEventListener('click', returnToWallet); });
    $('#payButton').addEventListener('click', beginPayment);
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
