const db = require('./db');
const config = require('./config');
const { verifyToken } = require('./auth');
const { activateExpiredSuspension } = require('./middleware');
const listenerActivity = require('./listener-activity');
const { settleCall } = require('./call-settlement');

function createSocketServer(io) {
  const employees = new Map();
  const userSockets = new Map();
  const connectedUsers = new Map();
  const calls = new Map();
  const userCall = new Map();
  const listenerDisconnectTimers = new Map();
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

  function cancelListenerDisconnect(userId) {
    const timer = listenerDisconnectTimers.get(userId);
    if (timer) clearTimeout(timer);
    listenerDisconnectTimers.delete(userId);
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

  function publicListeners() {
    const priority = { available: 0, ringing: 1, busy: 2, break: 3 };
    return [...employees.entries()]
      .map(([id, employee]) => ({ id, name: employee.name, bio: employee.bio || '', avatar: employee.avatar || '', banner: employee.banner || '', language: employee.language || 'Malayalam', status: employee.state }))
      .sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || a.name.localeCompare(b.name));
  }

  function broadcastListeners() {
    io.emit('listeners:update', { listeners: publicListeners() });
  }

  function hasLiveSocket(userId) {
    return Boolean(userSockets.get(userId)?.size);
  }

  function rememberEmployee(user, state = 'available') {
    const availability = user.listener_availability === 'break' ? 'break' : 'online';
    employees.set(user.id, {
      state,
      availability,
      name: user.username || user.name,
      bio: user.bio || '',
      avatar: user.profile_image || '',
      banner: user.banner_image || '',
      language: user.listener_language || 'Malayalam',
      lastAssigned: employees.get(user.id)?.lastAssigned || 0,
    });
  }

  function restoreEmployeeAfterCall(employeeId) {
    const employee = employees.get(employeeId);
    if (!employee) return;
    if (!hasLiveSocket(employeeId)) {
      employees.delete(employeeId);
      return;
    }
    employee.state = employee.availability === 'break' ? 'break' : 'available';
  }

  function accountUnavailable(user) {
    if (!user || user.status === 'blocked') return true;
    if (user.status !== 'suspended') return false;
    if (!user.suspended_until) return true;
    return new Date(user.suspended_until) > new Date();
  }

  io.use(async (socket, next) => {
    try {
      const payload = verifyToken(socket.handshake.auth?.token);
      const result = await db.query(`
        SELECT id, role, name, username, email, bio,
               CASE WHEN profile_image LIKE 'data:image/%' THEN 'photo:'||id::text ELSE profile_image END AS profile_image,
               CASE WHEN banner_image LIKE 'data:image/%' THEN 'photo:'||id::text ELSE banner_image END AS banner_image,
               balance_seconds,status,listener_availability,listener_language,listener_verification_status,
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

  function sameLanguage(a, b) {
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  }

  function findAvailableEmployee(excluded = [], preferredEmployeeId = null, primaryLanguage = 'Malayalam', allowOtherLanguages = false, allowedEmployeeIds = null) {
    const available = [...employees.entries()]
      .filter(([id, employee]) => employee.state === 'available'
        && hasLiveSocket(id)
        && !excluded.includes(id)
        && (!allowedEmployeeIds || allowedEmployeeIds.has(id)));

    if (preferredEmployeeId) {
      const preferred = available.find(([id]) => id === preferredEmployeeId);
      if (preferred) return preferredEmployeeId;
    }

    const primary = available
      .filter(([, employee]) => sameLanguage(employee.language, primaryLanguage))
      .sort((a, b) => a[1].lastAssigned - b[1].lastAssigned)[0]?.[0];
    if (primary) return primary;
    if (!allowOtherLanguages) return null;

    return available
      .filter(([, employee]) => !sameLanguage(employee.language, primaryLanguage))
      .sort((a, b) => a[1].lastAssigned - b[1].lastAssigned)[0]?.[0] || null;
  }

  async function ringCustomer(customerId, preferredEmployeeId = null, triedEmployees = [], options = {}) {
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

    const subscribed = await db.query(`
      SELECT employee_id FROM listener_subscriptions
      WHERE customer_id=$1 AND status='active' AND current_period_end>now()
    `, [customerId]);
    const allowedEmployeeIds = new Set(subscribed.rows.map((row) => row.employee_id));
    if (preferredEmployeeId && !allowedEmployeeIds.has(preferredEmployeeId)) {
      emitToUser(customerId, 'call:error', {
        message: 'Subscribe to this listener before calling. Calls also require talk-time in your wallet.',
        subscriptionRequired: true,
        employeeId: preferredEmployeeId,
      });
      return;
    }
    if (!preferredEmployeeId && !allowedEmployeeIds.size) {
      emitToUser(customerId, 'call:error', {
        message: 'Subscribe to a listener before calling. Calls are charged separately from your talk-time wallet.',
        subscriptionRequired: true,
      });
      return;
    }

    let primaryLanguage = String(options.primaryLanguage || 'Malayalam').trim() || 'Malayalam';
    const allowOtherLanguages = Boolean(options.allowOtherLanguages);

    if (preferredEmployeeId) {
      const preferred = employees.get(preferredEmployeeId);
      if (preferred?.language) primaryLanguage = preferred.language;
    }

    const employeeId = findAvailableEmployee(triedEmployees, preferredEmployeeId, primaryLanguage, allowOtherLanguages, allowedEmployeeIds);
    if (!employeeId) {
      const otherLanguagesAvailable = [...employees.values()].some((item) => item.state === 'available' && !sameLanguage(item.language, primaryLanguage));
      emitToUser(customerId, 'call:unavailable', {
        message: allowOtherLanguages
          ? `No ${primaryLanguage} or other-language listener is available right now. Please try again shortly.`
          : `No ${primaryLanguage} listener is available right now.${otherLanguagesAvailable ? ' Turn on “Suggest other languages” to connect with another available listener.' : ' Please try again shortly.'}`,
        otherLanguagesAvailable,
      });
      return;
    }

    const employee = employees.get(employeeId);
    if (!employee || employee.state !== 'available' || !hasLiveSocket(employeeId)) {
      if (!hasLiveSocket(employeeId)) employees.delete(employeeId);
      await ringCustomer(customerId, null, [...triedEmployees, employeeId], { primaryLanguage, allowOtherLanguages });
      return;
    }
    employee.state = 'ringing';
    employee.lastAssigned = ++assignmentSequence;
    broadcastListeners();

    let callRow;
    try {
      const callResult = await db.query(`
        INSERT INTO calls (customer_id, employee_id, status, listener_rate_paise)
        VALUES (
          $1,
          $2,
          'ringing',
          COALESCE((SELECT listener_rate_paise FROM users WHERE id=$2 AND role='employee'),0)
        )
        RETURNING id,listener_rate_paise
      `, [customerId, employeeId]);
      callRow = callResult.rows[0];
    } catch (error) {
      if (employees.get(employeeId) === employee) employee.state = 'available';
      broadcastListeners();
      if (error.code === '23505') {
        emitToUser(customerId, 'call:error', { message: 'A call is already in progress.' });
        return;
      }
      throw error;
    }

    // The listener may have selected Break/Offline while the call row was being
    // inserted. Re-check persisted availability before creating a runtime or push alert.
    const stillOnline = await db.query(`
      SELECT 1 FROM users
      WHERE id=$1 AND role='employee' AND status='active' AND listener_availability='online'
        AND listener_verification_status='approved'
    `, [employeeId]);
    if (!stillOnline.rows[0] || !hasLiveSocket(employeeId) || employees.get(employeeId) !== employee || employee.state !== 'ringing') {
      await db.query(`
        UPDATE calls SET status='cancelled',ended_at=now(),end_reason='Listener availability changed before ringing'
        WHERE id=$1 AND status='ringing'
      `, [callRow.id]);
      if (employees.get(employeeId) === employee && employee.state === 'ringing') employee.state = 'available';
      broadcastListeners();
      await ringCustomer(customerId, null, [...triedEmployees, employeeId], { primaryLanguage, allowOtherLanguages });
      return;
    }

    const runtime = {
      id: callRow.id,
      customerId,
      employeeId,
      status: 'ringing',
      billedSeconds: 0,
      listenerRatePaise: Number(callRow.listener_rate_paise || 0),
      tried: [...triedEmployees, employeeId],
      language: employee.language || primaryLanguage,
      primaryLanguage,
      allowOtherLanguages,
      customer: { id: customer.id, name: customer.name },
      balanceSeconds: Number(customer.balance_seconds),
      signalingReady: new Set(),
      offerStarted: false,
      activating: false,
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
        language: employee.language || primaryLanguage,
      },
    });

    emitToUser(employeeId, 'call:incoming', {
      callId: runtime.id,
      customer: runtime.customer,
      balanceSeconds: runtime.balanceSeconds,
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

    restoreEmployeeAfterCall(runtime.employeeId);

    emitToUser(runtime.employeeId, 'call:ended', { callId, reason });
    emitToUser(runtime.customerId, 'call:retrying', { reason });
    broadcastListeners();

    await ringCustomer(runtime.customerId, null, runtime.tried, { primaryLanguage: runtime.primaryLanguage, allowOtherLanguages: runtime.allowOtherLanguages });
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
      const settlement = await settleCall(runtime.id);
      if (settlement) runtime.billedSeconds = settlement.billedSeconds;
    } catch (error) {
      console.error('Could not settle call wallets:', error);
      const retryTimer = setTimeout(() => {
        settleCall(runtime.id).catch((retryError) => console.error('Call settlement retry failed:', retryError));
      }, 5000);
      retryTimer.unref();
    }

    calls.delete(callId);
    userCall.delete(runtime.customerId);
    userCall.delete(runtime.employeeId);

    restoreEmployeeAfterCall(runtime.employeeId);

    emitToUser(runtime.customerId, 'call:ended', { callId, reason, needsTopup });
    emitToUser(runtime.employeeId, 'call:ended', { callId, reason });
    broadcastListeners();
  }

  async function activateCallIfReady(runtime) {
    if (!runtime || runtime.status !== 'connecting' || runtime.activating) return;
    if (runtime.mediaConnected.size !== 2) return;

    runtime.activating = true;
    try {
      const result = await db.query(`
        UPDATE calls
        SET status = 'active', started_at = now()
        WHERE id = $1 AND status = 'connecting'
        RETURNING id
      `, [runtime.id]);
      if (!result.rows[0] || runtime.ending) return;

      if (runtime.connectTimer) clearTimeout(runtime.connectTimer);
      runtime.connectTimer = null;
      runtime.status = 'active';
      emitToUser(runtime.customerId, 'call:connected', { callId: runtime.id });
      emitToUser(runtime.employeeId, 'call:connected', { callId: runtime.id });
      startBilling(runtime);
    } finally {
      runtime.activating = false;
    }
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

  function activeCallForUser(userId) {
    const callId = userCall.get(userId);
    if (!callId) return null;
    const runtime = calls.get(callId);
    if (!runtime || !['ringing', 'connecting', 'active'].includes(runtime.status)) {
      userCall.delete(userId);
      return null;
    }
    return runtime;
  }

  function availabilityReply(acknowledge, payload) {
    if (typeof acknowledge === 'function') acknowledge(payload);
  }

  function safeHandler(handler) {
    return (...args) => Promise.resolve(handler(...args)).catch((error) => {
      console.error('Socket event failed:', error);
      const acknowledge = args[args.length - 1];
      if (typeof acknowledge === 'function') acknowledge({ ok: false, error: 'The server could not save that change.' });
    });
  }

  io.on('connection', (socket) => {
    const user = socket.data.user;
    addUserSocket(user.id, socket.id);
    connectedUsers.set(user.id, { role: user.role, name: user.name });
    socket.join(`user:${user.id}`);
    socket.emit('session:ready', { user });
    db.query('UPDATE users SET last_seen_at=now() WHERE id=$1', [user.id]).catch(console.error);

    if (user.role === 'employee') {
      cancelListenerDisconnect(user.id);
      listenerActivity.touchLastSeen(user.id).catch(console.error);
      const availability = user.listener_verification_status === 'approved'
        ? (user.listener_availability || 'offline')
        : 'offline';
      const currentRuntime = calls.get(userCall.get(user.id));
      if (availability === 'online' || availability === 'break') {
        const presenceState = currentRuntime
          ? (currentRuntime.status === 'ringing' ? 'ringing' : 'busy')
          : (availability === 'break' ? 'break' : 'available');
        rememberEmployee(user, presenceState);
        listenerActivity.transition(user.id, availability, 'Listener connected').catch(console.error);
      }
      socket.emit('employee:status', { status: availability });
      if (currentRuntime?.status === 'ringing') {
        socket.emit('call:incoming', {
          callId: currentRuntime.id,
          customer: currentRuntime.customer,
          balanceSeconds: currentRuntime.balanceSeconds,
        });
      }
      broadcastListeners();
    }

    if (user.role === 'customer') {
      socket.emit('listeners:update', { listeners: publicListeners() });
    }

    socket.on('listeners:get', () => {
      socket.emit('listeners:update', { listeners: publicListeners() });
    });

    socket.on('employee:online', safeHandler(async (_payload = {}, acknowledge) => {
      if (user.role !== 'employee') return availabilityReply(acknowledge, { ok: false, error: 'This is not a listener account.' });
      if (activeCallForUser(user.id)) return availabilityReply(acknowledge, { ok: false, error: 'Finish the current call before changing availability.' });

      const verification = await db.query(`
        SELECT listener_verification_status,username,name,bio,profile_image,banner_image,listener_language
        FROM users WHERE id=$1 AND role='employee'
      `, [user.id]);
      if (verification.rows[0]?.listener_verification_status !== 'approved') {
        return availabilityReply(acknowledge, { ok: false, error: 'Wait for administrator voice verification before going online.' });
      }
      Object.assign(user, verification.rows[0]);

      cancelListenerDisconnect(user.id);
      await db.query(`UPDATE users SET listener_availability='online',last_seen_at=now(),updated_at=now() WHERE id=$1 AND role='employee'`, [user.id]);
      await listenerActivity.transition(user.id, 'online', 'Went online');
      user.listener_availability = 'online';
      rememberEmployee(user, 'available');
      socket.emit('employee:status', { status: 'online' });
      broadcastListeners();
      availabilityReply(acknowledge, { ok: true, status: 'online' });
    }));

    socket.on('employee:break', safeHandler(async ({ enabled } = {}, acknowledge) => {
      if (user.role !== 'employee') return availabilityReply(acknowledge, { ok: false, error: 'This is not a listener account.' });
      if (activeCallForUser(user.id)) return availabilityReply(acknowledge, { ok: false, error: 'Finish the current call before changing availability.' });
      const verification = await db.query('SELECT listener_verification_status FROM users WHERE id=$1', [user.id]);
      if (verification.rows[0]?.listener_verification_status !== 'approved') {
        return availabilityReply(acknowledge, { ok: false, error: 'Wait for administrator voice verification before changing availability.' });
      }

      const availability = enabled ? 'break' : 'online';
      await db.query(`UPDATE users SET listener_availability=$2,last_seen_at=now(),updated_at=now() WHERE id=$1 AND role='employee'`, [user.id, availability]);
      await listenerActivity.transition(user.id, availability, enabled ? 'Break started' : 'Break ended');
      user.listener_availability = availability;
      rememberEmployee(user, enabled ? 'break' : 'available');
      socket.emit('employee:status', { status: availability });
      broadcastListeners();
      availabilityReply(acknowledge, { ok: true, status: availability });
    }));

    socket.on('employee:offline', safeHandler(async (_payload = {}, acknowledge) => {
      if (user.role !== 'employee') return availabilityReply(acknowledge, { ok: false, error: 'This is not a listener account.' });

      const runtime = activeCallForUser(user.id);
      cancelListenerDisconnect(user.id);
      await db.query(`UPDATE users SET listener_availability='offline',last_seen_at=now(),updated_at=now() WHERE id=$1 AND role='employee'`, [user.id]);
      await listenerActivity.transition(user.id, null, 'Went offline');
      user.listener_availability = 'offline';
      employees.delete(user.id);
      socket.emit('employee:status', { status: 'offline' });
      broadcastListeners();

      if (runtime) {
        await endCall(runtime.id, 'The listener went offline.');
      }
      availabilityReply(acknowledge, { ok: true, status: 'offline' });
    }));

    socket.on('call:request', safeHandler(async ({ employeeId = null, allowOtherLanguages = false } = {}) => {
      if (user.role !== 'customer') return;
      await ringCustomer(user.id, employeeId || null, [], { primaryLanguage: 'Malayalam', allowOtherLanguages: Boolean(allowOtherLanguages) });
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
      if (user.listener_availability !== 'online' || !hasLiveSocket(user.id)) {
        await retryCall(callId, 'The listener is no longer available.');
        return;
      }

      if (runtime.ringTimer) clearTimeout(runtime.ringTimer);
      runtime.ringTimer = null;
      const result = await db.query(`
        UPDATE calls SET status = 'connecting'
        WHERE id = $1 AND status = 'ringing'
        RETURNING id
      `, [callId]);
      if (!result.rows[0]) {
        await endCall(callId, 'The call could not be accepted.');
        return;
      }

      runtime.status = 'connecting';
      runtime.signalingReady.clear();
      runtime.mediaConnected.clear();
      runtime.offerStarted = false;
      runtime.connectTimer = setTimeout(() => {
        endCall(callId, 'The audio connection could not be established.').catch(console.error);
      }, 45_000);

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

    socket.on('webrtc:ready', safeHandler(async ({ callId } = {}) => {
      const runtime = calls.get(callId);
      if (!runtime || runtime.status !== 'connecting') return;
      if (![runtime.customerId, runtime.employeeId].includes(user.id)) return;

      runtime.signalingReady.add(user.id);
      if (runtime.signalingReady.size === 2 && !runtime.offerStarted) {
        runtime.offerStarted = true;
        emitToUser(runtime.customerId, 'webrtc:start', { callId: runtime.id });
      }
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
      db.query('UPDATE users SET last_seen_at=now() WHERE id=$1', [user.id]).catch(console.error);

      const callId = userCall.get(user.id);
      const runtime = calls.get(callId);

      if (user.role === 'employee') {
        employees.delete(user.id);
        broadcastListeners();
        listenerActivity.touchLastSeen(user.id).catch(console.error);
        cancelListenerDisconnect(user.id);
        const timer = setTimeout(async () => {
          listenerDisconnectTimers.delete(user.id);
          if (hasLiveSocket(user.id)) return;
          try {
            await db.query(`
              UPDATE users
              SET listener_availability='offline',last_seen_at=now(),updated_at=now()
              WHERE id=$1 AND role='employee'
            `, [user.id]);
            await listenerActivity.transition(user.id, null, 'Connection lost');
            emitToUser(user.id, 'employee:status', { status: 'offline' });
          } catch (error) {
            console.error('Could not close disconnected listener activity:', error);
          }
        }, config.listenerDisconnectGraceSeconds * 1000);
        timer.unref();
        listenerDisconnectTimers.set(user.id, timer);
      }

      if (runtime?.status === 'ringing' && user.role === 'employee') {
        await retryCall(runtime.id, 'The listener disconnected before answering.');
      } else if (callId) {
        await endCall(callId, `${user.role === 'employee' ? 'The listener' : 'The customer'} disconnected.`);
      }

    }));
  });

  async function refreshEmployeeProfile(userId) {
    const current = employees.get(userId);
    if (!current) return;
    const result = await db.query(`SELECT id,name,username,bio,
      CASE WHEN profile_image LIKE 'data:image/%' THEN 'photo:'||id::text ELSE profile_image END AS profile_image,
      CASE WHEN banner_image LIKE 'data:image/%' THEN 'photo:'||id::text ELSE banner_image END AS banner_image,
      listener_language,listener_availability,listener_verification_status,status
      FROM users WHERE id=$1 AND role='employee'`, [userId]);
    const row = result.rows[0];
    if (!row || row.status !== 'active' || row.listener_verification_status !== 'approved' || !hasLiveSocket(userId) || !['online','break'].includes(row.listener_availability)) {
      employees.delete(userId);
      if (!row || row.status !== 'active' || row.listener_availability === 'offline') {
        await listenerActivity.transition(userId, null, 'Profile or account status changed');
      }
    } else {
      current.name = row.username || row.name;
      current.bio = row.bio || '';
      current.avatar = row.profile_image || '';
      current.banner = row.banner_image || '';
      current.language = row.listener_language || 'Malayalam';
      current.availability = row.listener_availability;
      if (current.state !== 'ringing' && current.state !== 'busy') current.state = row.listener_availability === 'break' ? 'break' : 'available';
    }
    broadcastListeners();
  }

  async function restrictUser(userId, reason) {
    cancelListenerDisconnect(userId);
    const callId = userCall.get(userId);
    if (callId) await endCall(callId, reason || 'The account was restricted.');
    await db.query(`UPDATE users SET listener_availability='offline',last_seen_at=now(),updated_at=now() WHERE id=$1 AND role='employee'`, [userId]);
    await listenerActivity.transition(userId, null, 'Account restricted');
    employees.delete(userId);
    emitToUser(userId, 'account:restricted', { reason });
    io.in(`user:${userId}`).disconnectSockets(true);
    broadcastListeners();
  }

  return {
    restrictUser,
    refreshEmployeeProfile,
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
          customerName: call.customer?.name || 'Customer',
          employeeName: employees.get(call.employeeId)?.name || 'Listener',
          language: call.language || 'Malayalam',
          status: call.status,
          billedSeconds: call.billedSeconds,
        })),
      };
    },
    notifyUser: (userId, payload) => emitToUser(userId, 'notification:new', payload),
  };
}

module.exports = createSocketServer;
