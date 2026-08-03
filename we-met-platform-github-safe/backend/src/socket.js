const db = require('./db');
const config = require('./config');
const { verifyToken } = require('./auth');
const { activateExpiredSuspension } = require('./middleware');

function createSocketServer(io) {
  const employees = new Map();
  const userSockets = new Map();
  const connectedUsers = new Map();
  const calls = new Map();
  const userCall = new Map();
  let assignmentSequence = 0;

  function addUserSocket(userId, socketId) {
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socketId);
  }

  function removeUserSocket(userId, socketId) {
    const sockets = userSockets.get(userId);
    if (!sockets) return 0;
    sockets.delete(socketId);
    if (!sockets.size) userSockets.delete(userId);
    return sockets.size;
  }

  function emitToUser(userId, event, payload) {
    io.to(`user:${userId}`).emit(event, payload);
  }

  function concurrentPresence() {
    const byRole = { customer: 0, employee: 0, admin: 0 };
    for (const user of connectedUsers.values()) {
      if (Object.hasOwn(byRole, user.role)) byRole[user.role] += 1;
    }
    return { total: connectedUsers.size, byRole };
  }

  let demoCache = [];
  async function refreshDemoListeners() {
    try {
      const result = await db.query(`SELECT id,name,bio,avatar,activity,randomize,enabled FROM demo_listeners WHERE enabled=true ORDER BY created_at DESC`);
      demoCache = result.rows.map((x) => ({ id: `demo-${x.id}`, demoId:x.id, name:x.name, bio:x.bio||'', avatar:x.avatar||'', status:x.activity, demo:true }));
    } catch (error) { console.error('Demo listener refresh failed:', error); }
    broadcastListeners();
  }
  function publicListeners() {
    const priority = { available: 0, ringing: 1, busy: 2, break: 3 };
    return [...employees.entries()]
      .map(([id, employee]) => ({ id, name: employee.name, bio: employee.bio || '', avatar: employee.avatar || '', status: employee.state, demo:false }))
      .concat(demoCache)
      .sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || a.name.localeCompare(b.name));
  }

  function broadcastListeners() {
    io.emit('listeners:update', { listeners: publicListeners() });
  }

  function accountUnavailable(user) {
    if (!user || user.status === 'blocked') return true;
    if (user.status !== 'suspended') return false;
    if (!user.suspended_until) return true;
    return new Date(user.suspended_until) > new Date();
  }

  refreshDemoListeners();
  setInterval(async () => {
    if (!demoCache.length) return;
    let changed = false;
    const result = await db.query(`SELECT id,name,bio,avatar,activity,randomize,enabled FROM demo_listeners WHERE enabled=true`);
    const rows = result.rows;
    for (const row of rows) {
      if (!row.randomize) continue;
      if (Math.random() < 0.22) {
        const states = ['available','break','busy','offline'];
        await db.query('UPDATE demo_listeners SET activity=$2,updated_at=now() WHERE id=$1',[row.id,states[Math.floor(Math.random()*states.length)]]);
        changed = true;
      }
    }
    if (changed) refreshDemoListeners();
  }, 30000);

  io.use(async (socket, next) => {
    try {
      const payload = verifyToken(socket.handshake.auth?.token);
      const result = await db.query(`
        SELECT id, role, name, email, bio, balance_seconds, status,
               suspended_until, suspension_reason, auth_version
        FROM users
        WHERE id = $1
      `, [payload.sub]);
      const user = await activateExpiredSuspension(result.rows[0]);

      if (!user || Number(payload.ver || 0) !== Number(user.auth_version || 0)) {
        return next(new Error('Your login is invalid or has expired.'));
      }
      if (accountUnavailable(user)) {
        return next(new Error('This account is currently unavailable.'));
      }

      socket.data.user = user;
      next();
    } catch (_error) {
      next(new Error('Your login is invalid or has expired.'));
    }
  });

  function findAvailableEmployee(excluded = [], preferredEmployeeId = null) {
    if (preferredEmployeeId) {
      const preferred = employees.get(preferredEmployeeId);
      if (preferred?.state === 'available' && !excluded.includes(preferredEmployeeId)) {
        return preferredEmployeeId;
      }
    }

    return [...employees.entries()]
      .filter(([id, employee]) => employee.state === 'available' && !excluded.includes(id))
      .sort((a, b) => a[1].lastAssigned - b[1].lastAssigned)[0]?.[0] || null;
  }

  async function writeCallDebit(callRuntime) {
    const callResult = await db.query(`
      SELECT billed_seconds FROM calls WHERE id = $1
    `, [callRuntime.id]);
    const billedSeconds = Number(callResult.rows[0]?.billed_seconds || callRuntime.billedSeconds || 0);
    callRuntime.billedSeconds = billedSeconds;

    if (billedSeconds <= 0) return;

    await db.query(`
      INSERT INTO wallet_transactions (
        customer_id, seconds_delta, type, note, reference_id
      )
      VALUES ($1, $2, 'call_debit', $3, $4)
      ON CONFLICT DO NOTHING
    `, [
      callRuntime.customerId,
      -billedSeconds,
      'Malayalam voice call',
      callRuntime.id,
    ]);
  }

  async function ringCustomer(customerId, preferredEmployeeId = null, triedEmployees = []) {
    if (userCall.has(customerId)) {
      emitToUser(customerId, 'call:error', { message: 'You already have a call in progress.' });
      return;
    }

    const customerResult = await db.query(`
      SELECT id, name, balance_seconds, status, suspended_until
      FROM users
      WHERE id = $1 AND role = 'customer'
    `, [customerId]);
    const customer = customerResult.rows[0];

    if (!customer || accountUnavailable(customer)) {
      emitToUser(customerId, 'call:error', { message: 'Your account is not available for calls.' });
      return;
    }

    if (Number(customer.balance_seconds) < config.minimumStartSeconds) {
      emitToUser(customerId, 'call:error', {
        message: `You need at least ${Math.ceil(config.minimumStartSeconds / 60)} minutes to start a call.`,
        needsTopup: true,
      });
      return;
    }

    const employeeId = findAvailableEmployee(triedEmployees, preferredEmployeeId);
    if (!employeeId) {
      emitToUser(customerId, 'call:unavailable', {
        message: 'No Malayalam listener is available right now. Please try again shortly.',
      });
      return;
    }

    const employee = employees.get(employeeId);
    employee.state = 'ringing';
    employee.lastAssigned = ++assignmentSequence;
    broadcastListeners();

    let callRow;
    try {
      const callResult = await db.query(`
        INSERT INTO calls (customer_id, employee_id, status)
        VALUES ($1, $2, 'ringing')
        RETURNING id
      `, [customerId, employeeId]);
      callRow = callResult.rows[0];
    } catch (error) {
      employee.state = 'available';
      broadcastListeners();
      if (error.code === '23505') {
        emitToUser(customerId, 'call:error', { message: 'A call is already in progress.' });
        return;
      }
      throw error;
    }

    const runtime = {
      id: callRow.id,
      customerId,
      employeeId,
      status: 'ringing',
      billedSeconds: 0,
      tried: [...triedEmployees, employeeId],
      ready: new Set(),
      mediaConnected: new Set(),
      ringTimer: null,
      connectTimer: null,
      mediaReconnectTimer: null,
      mediaPaused: false,
      billingTimer: null,
      billingBusy: false,
      ending: false,
    };

    calls.set(runtime.id, runtime);
    userCall.set(customerId, runtime.id);
    userCall.set(employeeId, runtime.id);

    emitToUser(customerId, 'call:ringing', {
      callId: runtime.id,
      employee: {
        id: employeeId,
        name: employee.name,
        bio: employee.bio || '',
      },
    });

    emitToUser(employeeId, 'call:incoming', {
      callId: runtime.id,
      customer: { id: customer.id, name: customer.name },
      balanceSeconds: Number(customer.balance_seconds),
    });

    runtime.ringTimer = setTimeout(() => {
      retryCall(runtime.id, 'The listener did not answer.').catch(console.error);
    }, config.ringSeconds * 1000);
  }

  async function retryCall(callId, reason) {
    const runtime = calls.get(callId);
    if (!runtime || runtime.ending) return;
    runtime.ending = true;

    if (runtime.ringTimer) clearTimeout(runtime.ringTimer);
    if (runtime.connectTimer) clearTimeout(runtime.connectTimer);
    if (runtime.mediaReconnectTimer) clearTimeout(runtime.mediaReconnectTimer);

    await db.query(`
      UPDATE calls
      SET status = 'rejected', ended_at = now(), end_reason = $2
      WHERE id = $1 AND status IN ('ringing', 'connecting')
    `, [callId, reason]);

    calls.delete(callId);
    userCall.delete(runtime.customerId);
    userCall.delete(runtime.employeeId);

    const employee = employees.get(runtime.employeeId);
    if (employee) employee.state = 'available';

    emitToUser(runtime.employeeId, 'call:ended', { callId, reason });
    emitToUser(runtime.customerId, 'call:retrying', { reason });
    broadcastListeners();

    await ringCustomer(runtime.customerId, null, runtime.tried);
  }

  async function endCall(callId, reason = 'The call ended.', needsTopup = false) {
    const runtime = calls.get(callId);
    if (!runtime || runtime.ending) return;
    runtime.ending = true;

    if (runtime.billingTimer) clearInterval(runtime.billingTimer);
    if (runtime.ringTimer) clearTimeout(runtime.ringTimer);
    if (runtime.connectTimer) clearTimeout(runtime.connectTimer);
    if (runtime.mediaReconnectTimer) clearTimeout(runtime.mediaReconnectTimer);

    const finalStatus = runtime.status === 'active' ? 'ended' : 'cancelled';
    await db.query(`
      UPDATE calls
      SET status = $2, ended_at = now(), end_reason = $3
      WHERE id = $1 AND status IN ('ringing', 'connecting', 'active')
    `, [callId, finalStatus, reason]);

    try {
      await writeCallDebit(runtime);
    } catch (error) {
      console.error('Could not save call wallet transaction:', error);
    }

    calls.delete(callId);
    userCall.delete(runtime.customerId);
    userCall.delete(runtime.employeeId);

    const employee = employees.get(runtime.employeeId);
    if (employee) employee.state = 'available';

    emitToUser(runtime.customerId, 'call:ended', { callId, reason, needsTopup });
    emitToUser(runtime.employeeId, 'call:ended', { callId, reason });
    broadcastListeners();
  }

  async function activateCallIfReady(runtime) {
    if (!runtime || runtime.status !== 'connecting') return;
    if (runtime.ready.size !== 2 || runtime.mediaConnected.size !== 2) return;

    if (runtime.connectTimer) clearTimeout(runtime.connectTimer);
    runtime.status = 'active';

    const result = await db.query(`
      UPDATE calls
      SET status = 'active', started_at = now()
      WHERE id = $1 AND status = 'connecting'
      RETURNING id
    `, [runtime.id]);
    if (!result.rows[0]) return;

    emitToUser(runtime.customerId, 'call:connected', { callId: runtime.id });
    emitToUser(runtime.employeeId, 'call:connected', { callId: runtime.id });
    startBilling(runtime);
  }

  function updateMediaState(runtime, userId, connected) {
    if (!runtime || ![runtime.customerId, runtime.employeeId].includes(userId)) return;

    if (connected) runtime.mediaConnected.add(userId);
    else runtime.mediaConnected.delete(userId);

    if (runtime.status === 'active') {
      if (runtime.mediaConnected.size === 2) {
        if (runtime.mediaReconnectTimer) clearTimeout(runtime.mediaReconnectTimer);
        runtime.mediaReconnectTimer = null;
        if (runtime.mediaPaused) {
          runtime.mediaPaused = false;
          emitToUser(runtime.customerId, 'call:audio-restored', { callId: runtime.id });
          emitToUser(runtime.employeeId, 'call:audio-restored', { callId: runtime.id });
        }
      } else if (!runtime.mediaReconnectTimer) {
        runtime.mediaPaused = true;
        emitToUser(runtime.customerId, 'call:audio-paused', { callId: runtime.id });
        emitToUser(runtime.employeeId, 'call:audio-paused', { callId: runtime.id });
        runtime.mediaReconnectTimer = setTimeout(() => {
          endCall(runtime.id, 'The audio connection could not be restored.').catch(console.error);
        }, config.mediaReconnectSeconds * 1000);
      }
    }
  }

  function startBilling(runtime) {
    if (runtime.billingTimer) return;

    runtime.billingTimer = setInterval(async () => {
      if (runtime.billingBusy || runtime.ending) return;
      runtime.billingBusy = true;

      try {
        // Talk-time is charged only while both browsers report a live audio connection.
        if (runtime.mediaConnected.size !== 2) return;

        const charge = await db.transaction(async (client) => {
          const call = (await client.query(`
            SELECT status FROM calls WHERE id = $1 FOR UPDATE
          `, [runtime.id])).rows[0];

          if (!call || call.status !== 'active') return { ended: true };

          const debit = await client.query(`
            UPDATE users
            SET balance_seconds = balance_seconds - 1, updated_at = now()
            WHERE id = $1 AND balance_seconds > 0
            RETURNING balance_seconds
          `, [runtime.customerId]);

          if (!debit.rows[0]) return { empty: true };

          const update = await client.query(`
            UPDATE calls
            SET billed_seconds = billed_seconds + 1
            WHERE id = $1
            RETURNING billed_seconds
          `, [runtime.id]);

          return {
            balance: Number(debit.rows[0].balance_seconds),
            billed: Number(update.rows[0].billed_seconds),
          };
        });

        if (charge.empty) {
          await endCall(runtime.id, 'Your talk-time balance has ended.', true);
          return;
        }
        if (charge.ended) return;

        runtime.billedSeconds = charge.billed;
        const tick = {
          callId: runtime.id,
          balanceSeconds: charge.balance,
          billedSeconds: charge.billed,
        };
        emitToUser(runtime.customerId, 'call:tick', tick);
        emitToUser(runtime.employeeId, 'call:tick', tick);

        if (charge.balance <= 0) {
          await endCall(runtime.id, 'Your talk-time balance has ended.', true);
          return;
        }

        if (charge.balance === config.lowBalanceSeconds) {
          emitToUser(runtime.customerId, 'call:low-balance', { seconds: charge.balance });
        }

        if (config.maxCallSeconds > 0 && charge.billed >= config.maxCallSeconds) {
          await endCall(runtime.id, 'The maximum call duration was reached.');
        }
      } catch (error) {
        console.error('Call billing failed:', error);
        await endCall(runtime.id, 'The call ended because of a server error.');
      } finally {
        runtime.billingBusy = false;
      }
    }, 1000);
  }

  function safeHandler(handler) {
    return (...args) => Promise.resolve(handler(...args)).catch((error) => {
      console.error('Socket event failed:', error);
    });
  }

  io.on('connection', (socket) => {
    const user = socket.data.user;
    addUserSocket(user.id, socket.id);
    connectedUsers.set(user.id, { role: user.role, name: user.name });
    socket.join(`user:${user.id}`);
    socket.emit('session:ready', { user });

    if (user.role === 'customer') {
      socket.emit('listeners:update', { listeners: publicListeners() });
    }

    socket.on('listeners:get', () => {
      socket.emit('listeners:update', { listeners: publicListeners() });
    });

    socket.on('employee:online', () => {
      if (user.role !== 'employee' || userCall.has(user.id)) return;
      employees.set(user.id, {
        state: 'available',
        name: user.name,
        bio: user.bio,
        lastAssigned: employees.get(user.id)?.lastAssigned || 0,
      });
      socket.emit('employee:status', { status: 'online' });
      broadcastListeners();
    });

    socket.on('employee:break', ({ enabled } = {}) => {
      if (user.role !== 'employee' || userCall.has(user.id)) return;
      const employee = employees.get(user.id);
      if (!employee) return;
      employee.state = enabled ? 'break' : 'available';
      socket.emit('employee:status', { status: enabled ? 'break' : 'online' });
      broadcastListeners();
    });

    socket.on('employee:offline', safeHandler(async () => {
      if (user.role !== 'employee') return;
      const callId = userCall.get(user.id);
      if (callId) await endCall(callId, 'The listener went offline.');
      employees.delete(user.id);
      socket.emit('employee:status', { status: 'offline' });
      broadcastListeners();
    }));

    socket.on('call:request', safeHandler(async ({ employeeId = null } = {}) => {
      if (user.role !== 'customer') return;
      await ringCustomer(user.id, employeeId || null, []);
    }));

    socket.on('call:cancel', safeHandler(async ({ callId } = {}) => {
      const runtime = calls.get(callId);
      if (runtime?.customerId === user.id) {
        await endCall(callId, 'The customer cancelled the call.');
      }
    }));

    socket.on('call:accept', safeHandler(async ({ callId } = {}) => {
      if (user.role !== 'employee') return;
      const runtime = calls.get(callId);
      if (!runtime || runtime.employeeId !== user.id || runtime.status !== 'ringing') return;

      if (runtime.ringTimer) clearTimeout(runtime.ringTimer);
      runtime.status = 'connecting';
      runtime.connectTimer = setTimeout(() => {
        endCall(callId, 'The audio connection could not be established.').catch(console.error);
      }, 45_000);

      const result = await db.query(`
        UPDATE calls SET status = 'connecting'
        WHERE id = $1 AND status = 'ringing'
        RETURNING id
      `, [callId]);
      if (!result.rows[0]) return;

      const employee = employees.get(user.id);
      if (employee) employee.state = 'busy';

      io.in(`user:${runtime.customerId}`).socketsJoin(`call:${callId}`);
      io.in(`user:${runtime.employeeId}`).socketsJoin(`call:${callId}`);

      const payload = { callId, initiatorId: runtime.customerId };
      emitToUser(runtime.customerId, 'call:accepted', payload);
      emitToUser(runtime.employeeId, 'call:accepted', payload);
      broadcastListeners();
    }));

    socket.on('call:reject', safeHandler(async ({ callId } = {}) => {
      const runtime = calls.get(callId);
      if (runtime?.employeeId === user.id) {
        await retryCall(callId, 'The listener declined the call.');
      }
    }));

    socket.on('call:media-ready', safeHandler(async ({ callId } = {}) => {
      const runtime = calls.get(callId);
      if (!runtime || runtime.status !== 'connecting') return;
      if (![runtime.customerId, runtime.employeeId].includes(user.id)) return;

      runtime.ready.add(user.id);
      updateMediaState(runtime, user.id, true);
      await activateCallIfReady(runtime);
    }));

    socket.on('call:media-state', safeHandler(async ({ callId, connected } = {}) => {
      const runtime = calls.get(callId);
      if (!runtime || !['connecting', 'active'].includes(runtime.status)) return;
      if (![runtime.customerId, runtime.employeeId].includes(user.id)) return;

      updateMediaState(runtime, user.id, Boolean(connected));
      await activateCallIfReady(runtime);
    }));

    socket.on('call:end', safeHandler(async ({ callId } = {}) => {
      const runtime = calls.get(callId);
      if (runtime && [runtime.customerId, runtime.employeeId].includes(user.id)) {
        await endCall(callId, 'The call was ended.');
      }
    }));

    for (const event of ['webrtc:offer', 'webrtc:answer', 'webrtc:ice']) {
      socket.on(event, ({ callId, payload } = {}) => {
        const runtime = calls.get(callId);
        if (!runtime || !['connecting', 'active'].includes(runtime.status)) return;
        if (![runtime.customerId, runtime.employeeId].includes(user.id)) return;
        socket.to(`call:${callId}`).emit(event, { callId, payload, from: user.id });
      });
    }

    socket.on('chat:send', ({ callId, message } = {}, acknowledge) => {
      const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
      Promise.resolve().then(async () => {
        const runtime = calls.get(callId);
        const content = String(message || '').trim().slice(0, 1000);
        if (!content) return reply({ ok: false, error: 'Type a message first.' });
        if (!runtime || !['connecting', 'active'].includes(runtime.status)) {
          return reply({ ok: false, error: 'Text chat is available only during the current call.' });
        }
        if (![runtime.customerId, runtime.employeeId].includes(user.id)) {
          return reply({ ok: false, error: 'You cannot send a message to this call.' });
        }

        const result = await db.query(`
          INSERT INTO call_messages (call_id, sender_id, message)
          VALUES ($1, $2, $3)
          RETURNING id, message, created_at
        `, [callId, user.id, content]);

        io.to(`call:${callId}`).emit('chat:message', {
          ...result.rows[0],
          callId,
          senderId: user.id,
          senderName: user.name,
        });
        return reply({ ok: true, id: result.rows[0].id });
      }).catch((error) => {
        console.error('Socket chat failed:', error);
        reply({ ok: false, error: 'The message could not be sent. Please try again.' });
      });
    });

    socket.on('disconnect', safeHandler(async () => {
      if (removeUserSocket(user.id, socket.id) > 0) return;
      connectedUsers.delete(user.id);

      if (user.role === 'employee') {
        employees.delete(user.id);
        broadcastListeners();
      }

      const callId = userCall.get(user.id);
      if (callId) {
        await endCall(callId, `${user.role === 'employee' ? 'The listener' : 'The customer'} disconnected.`);
      }
    }));
  });

  async function restrictUser(userId, reason) {
    const callId = userCall.get(userId);
    if (callId) await endCall(callId, reason || 'The account was restricted.');
    employees.delete(userId);
    emitToUser(userId, 'account:restricted', { reason });
    io.in(`user:${userId}`).disconnectSockets(true);
    broadcastListeners();
  }

  return {
    restrictUser,
    refreshDemoListeners,
    liveSnapshot: () => {
      const presence = concurrentPresence();
      return {
        concurrentUsers: presence.total,
        onlineByRole: presence.byRole,
        onlineEmployees: publicListeners(),
        activeCalls: [...calls.values()].map((call) => ({
          id: call.id,
          customerId: call.customerId,
          employeeId: call.employeeId,
          status: call.status,
          billedSeconds: call.billedSeconds,
        })),
      };
    },
    notifyUser: (userId, payload) => emitToUser(userId, 'notification:new', payload),
  };
}

module.exports = createSocketServer;
