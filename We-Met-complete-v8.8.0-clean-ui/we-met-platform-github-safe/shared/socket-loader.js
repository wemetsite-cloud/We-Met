(() => {
  'use strict';

  const base = String(window.PORTAL_CONFIG?.API_BASE_URL || '').replace(/\/$/, '');
  const source = `${base}/socket.io/socket.io.js`;

  window.SocketIOReady = new Promise((resolve, reject) => {
    if (window.io) return resolve(window.io);
    const script = document.createElement('script');
    script.src = source;
    script.async = true;
    script.onload = () => window.io ? resolve(window.io) : reject(new Error('Socket.IO did not load correctly.'));
    script.onerror = () => reject(new Error('Could not load the real-time calling library.'));
    document.head.appendChild(script);
  });
})();
