(() => {
  'use strict';

  const root = document.documentElement;
  let revealTimer = 0;
  root.classList.add('capture-protected');

  function ensureShield() {
    if (document.getElementById('captureShield') || !document.body) return;
    const shield = document.createElement('div');
    shield.id = 'captureShield';
    shield.setAttribute('aria-hidden', 'true');
    shield.innerHTML = '<div><img src="assets/logo.svg" alt=""><strong>Private screen</strong><small>Return to We Met to continue</small></div>';
    document.body.appendChild(shield);
  }

  function obscure() {
    clearTimeout(revealTimer);
    ensureShield();
    root.classList.add('capture-obscured');
  }

  function revealSoon() {
    clearTimeout(revealTimer);
    revealTimer = window.setTimeout(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        root.classList.remove('capture-obscured');
      }
    }, 140);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureShield, { once: true });
  else ensureShield();

  window.addEventListener('blur', obscure);
  window.addEventListener('focus', revealSoon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') obscure();
    else revealSoon();
  });
  window.addEventListener('beforeprint', obscure);
  window.addEventListener('afterprint', revealSoon);

  document.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('dragstart', (event) => {
    if (event.target.closest?.('img,video,canvas')) event.preventDefault();
  });
  document.addEventListener('keydown', (event) => {
    const key = String(event.key || '').toLowerCase();
    const saveOrPrint = (event.ctrlKey || event.metaKey) && (key === 's' || key === 'p');
    if (key !== 'printscreen' && !saveOrPrint) return;
    event.preventDefault();
    obscure();
    revealTimer = window.setTimeout(revealSoon, 1000);
  });
})();
