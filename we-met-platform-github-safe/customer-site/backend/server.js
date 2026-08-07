const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const config = require('./src/config');
const db = require('./src/db');
const pushService = require('./src/push');
const { authenticate, requireRole } = require('./src/middleware');

const app = express();
const server = http.createServer(app);

function originAllowed(origin) {
  if (!origin) return true;
  if (config.nodeEnv !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return config.allowedOrigins.includes(origin);
}

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') return res.sendStatus(originAllowed(origin) ? 204 : 403);
  if (origin && !originAllowed(origin)) return res.status(403).json({ error: 'Origin not allowed.' });

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (config.isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' https://checkout.razorpay.com; connect-src 'self' https: wss: ws:; img-src 'self' data: blob: https://*.razorpay.com; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; frame-src https://api.razorpay.com https://*.razorpay.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
});

app.use(
  '/api/webhooks/razorpay',
  express.raw({ type: 'application/json', limit: '1mb' }),
  require('./src/routes/razorpay-webhook'),
);
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, app: config.appName, time: new Date().toISOString() });
  } catch (_error) {
    res.status(503).json({ ok: false, error: 'Database unavailable.' });
  }
});

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/public', require('./src/routes/public'));
app.use('/api/push', require('./src/routes/push'));
app.use('/api/customer/razorpay', require('./src/routes/razorpay'));
app.use('/api/customer/manual-payments', require('./src/routes/manual-payments'));
app.use('/api/customer', require('./src/routes/customer'));
app.use('/api/employee', require('./src/routes/employee'));
app.use('/api/admin', require('./src/routes/admin'));

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, originAllowed(origin)),
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e6,
});

const socketRuntime = require('./src/socket')(io, { pushService });
app.locals.socketRuntime = socketRuntime;
app.locals.notifyUser = (userId, payload) => {
  socketRuntime.notifyUser(userId, payload);
  return pushService.sendToUser(userId, payload).catch((error) => {
    console.error('Notification delivery failed:', error?.message || error);
  });
};

app.get('/api/admin/live', authenticate, requireRole('admin'), (_req, res) => {
  res.json(socketRuntime.liveSnapshot());
});

const staticOptions = {
  etag: true,
  maxAge: config.nodeEnv === 'production' ? '7d' : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('config.js') || filePath.endsWith('index.html') || filePath.endsWith('service-worker.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
};

if (config.serveFrontends) {
  const root = path.resolve(__dirname, '..');
  const customer = path.join(root, 'customer-site');
  const employee = path.join(root, 'employee-site');
  const admin = path.join(root, 'admin-site');
  const portalStatic = {
    customer: express.static(customer, staticOptions),
    employee: express.static(employee, staticOptions),
    admin: express.static(admin, staticOptions),
  };
  const portalIndex = {
    customer: path.join(customer, 'index.html'),
    employee: path.join(employee, 'index.html'),
    admin: path.join(admin, 'index.html'),
  };

  function portalForHostname(hostname) {
    const firstLabel = String(hostname || '').toLowerCase().split('.')[0];
    if (firstLabel === 'employee' || firstLabel === 'listener') return 'employee';
    if (firstLabel === 'admin') return 'admin';
    if (firstLabel === 'api') return null;
    return 'customer';
  }

  // A single Render service can later use separate customer, employee and admin
  // subdomains. Each subdomain serves its own portal directly from `/`.
  app.use((req, res, next) => {
    if (
      req.path.startsWith('/api/')
      || req.path.startsWith('/socket.io/')
      || req.path.startsWith('/customer')
      || req.path.startsWith('/employee')
      || req.path.startsWith('/admin')
    ) return next();

    const portal = portalForHostname(req.hostname);
    if (!portal) return next();

    return portalStatic[portal](req, res, () => {
      if (req.method === 'GET' && !path.extname(req.path)) {
        return res.sendFile(portalIndex[portal]);
      }
      return next();
    });
  });

  app.use('/customer', portalStatic.customer);
  app.use('/employee', portalStatic.employee);
  app.use('/admin', portalStatic.admin);

  app.get('/customer', (_req, res) => res.sendFile(portalIndex.customer));
  app.get('/employee', (_req, res) => res.sendFile(portalIndex.employee));
  app.get('/admin', (_req, res) => res.sendFile(portalIndex.admin));
  app.get('/', (req, res) => {
    if (String(req.hostname || '').toLowerCase().startsWith('api.')) {
      return res.json({ ok: true, app: config.appName, health: '/api/health' });
    }
    return res.sendFile(portalIndex.customer);
  });
}

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found.' });
  res.status(404).send('Page not found.');
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.status || 500;
  res.status(status).json({
    error: status >= 500 ? 'Server error. Please try again.' : error.message,
  });
});

async function reconcileInterruptedCalls() {
  await db.query(`
    INSERT INTO wallet_transactions (customer_id, seconds_delta, type, note, reference_id)
    SELECT customer_id, -billed_seconds, 'call_debit', 'Malayalam voice call', id
    FROM calls
    WHERE billed_seconds > 0
    ON CONFLICT DO NOTHING
  `);

  await db.query(`
    UPDATE calls
    SET
      status = CASE WHEN status = 'ringing' THEN 'cancelled' ELSE 'ended' END,
      ended_at = now(),
      end_reason = 'Server restarted during the call'
    WHERE status IN ('ringing', 'connecting', 'active')
  `);
}

(async () => {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required.');
  await db.query('SELECT 1');
  await reconcileInterruptedCalls();
  server.listen(config.port, () => {
    console.log(`We Met running at ${config.publicUrl}`);
    if (config.serveFrontends) {
      console.log(`Customer: ${config.publicUrl}/customer/`);
      console.log(`Listener: ${config.publicUrl}/employee/`);
      console.log(`Admin:    ${config.publicUrl}/admin/`);
    }
  });
})().catch((error) => {
  console.error('Startup failed:', error);
  process.exit(1);
});

function shutdown() {
  io.close();
  server.close(async () => {
    await db.pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
