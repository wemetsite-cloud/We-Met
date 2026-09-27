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

  function latestSocketId(userId) {
    const sockets = [...(userSockets.get(userId) || [])];
    return sockets[sockets.length - 1] || null;
  }

  function socketIdForClient(userId, clientId) {
    if (!clientId) return null;
    for (const socketId of userSockets.get(userId) || []) {
      const candidate = io.sockets.sockets.get(socketId);
      if (candidate?.data?.clientId === clientId) return socketId;
    }
    return null;
  }

  function emitToSocket(socketId, event, payload) {
    if (!socketId) return;
    io.to(socketId).emit(event, payload);
  }

  function clearParticipantDisconnectTimer(runtime, userId) {
    const timer = runtime?.disconnectTimers?.get(userId);
    if (timer) clearTimeout(timer);
    runtime?.disconnectTimers?.delete(userId);
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
      .map(([id, employee]) => ({ id, name: employee.name, bio: employee.bio || '', avatar: employee.avatar || '', banner: employee.banner || '', language: employee.language || 'Malayalam', status: employee.state, updatedAt: employee.updatedAt || null }))
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
      updatedAt: user.updated_at || null,
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
               suspended_until, suspension_reason, auth_version, updated_at
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
      socket.data.clientId = String(socket.handshake.auth?.clientId || socket.id).slice(0, 120);
      next();
    } catch (_error) {
      next(new Error('Your login is invalid or has expired.'));
    }
  });

  function sameLanguage(a, b) {
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  }

  function availableEmployeeEntries(primaryLanguage = 'Malayalam', allowOtherLanguages = false, directEmployeeId = null) {
    const available = [...employees.entries()]
      .filter(([id, employee]) => employee.state === 'available' && hasLiveSocket(id) && !userCall.has(id))
      .sort((a, b) => (a[1].lastAssigned || 0) - (b[1].lastAssigned || 0));

    if (directEmployeeId) {
      const direct = available.find(([id]) => id === directEmployeeId);
      return direct ? [direct] : [];
    }

    const primary = available.filter(([, employee]) => sameLanguage(employee.language, primaryLanguage));
    if (!allowOtherLanguages) return primary;
    const secondary = available.filter(([, employee]) => !sameLanguage(employee.language, primaryLanguage));
    return [...primary, ...secondary];
  }

  function candidatePayload(employeeId) {
    const employee = employees.get(employeeId);
    if (!employee) return null;
    return {
      id: employeeId,
      name: employee.name,
      bio: employee.bio || '',
      language: employee.language || 'Malayalam',
      avatar: employee.avatar || '',
      banner: employee.banner || '',
    };
  }

  function customerRingingPayload(runtime) {
    const candidates = [...(runtime?.candidateIds || [])];
    const first = candidatePayload(candidates[0]);
    return {
      callId: runtime.id,
      employee: runtime.directEmployeeId
        ? first
        : {
            id: null,
            name: candidates.length === 1 ? first?.name || 'Available listener' : `${candidates.length} available listeners`,
            bio: 'The first available listener to answer will connect.',
            language: runtime.primaryLanguage || 'Malayalam',
            avatar: first?.avatar || '',
            banner: first?.banner || '',
          },
      candidateCount: candidates.length,
    };
  }

  function isRingingCandidate(runtime, userId) {
    return Boolean(runtime?.candidateIds?.has(userId));
  }

  function isSelectedParticipantSocket(runtime, userId, socketId) {
    if (!runtime) return false;
    if (userId === runtime.customerId) return runtime.customerSocketId === socketId;
    if (userId === runtime.employeeId) return runtime.employeeSocketId === socketId;
    return false;
  }

  function otherParticipantSocket(runtime, userId) {
    if (userId === runtime.customerId) return runtime.employeeSocketId;
    if (userId === runtime.employeeId) return runtime.customerSocketId;
    return null;
  }

  function releaseRingingCandidate(runtime, employeeId, reason = 'This call is no longer available.', notify = true) {
    if (!runtime?.candidateIds?.has(employeeId)) return;
    runtime.candidateIds.delete(employeeId);
    runtime.candidateSockets?.delete(employeeId);
    runtime.candidateClients?.delete(employeeId);
    if (userCall.get(employeeId) === runtime.id) userCall.delete(employeeId);
    restoreEmployeeAfterCall(employeeId);
    if (notify) emitToUser(employeeId, 'call:ended', { callId: runtime.id, reason });
  }

  async function finishUnansweredBroadcast(runtime, reason) {
    if (!runtime || runtime.ending) return;
    runtime.ending = true;
    if (runtime.ringTimer) clearTimeout(runtime.ringTimer);
    runtime.ringTimer = null;

    await db.query(`
      UPDATE calls
      SET status='rejected', ended_at=now(), end_reason=$2
      WHERE id=$1 AND status='ringing'
    `, [runtime.id, reason]);

    for (const employeeId of [...runtime.candidateIds]) {
      releaseRingingCandidate(runtime, employeeId, reason, true);
    }
    calls.delete(runtime.id);
    if (userCall.get(runtime.customerId) === runtime.id) userCall.delete(runtime.customerId);
    emitToSocket(runtime.customerSocketId, 'call:ended', { callId: runtime.id, reason });
    broadcastListeners();
  }

  async function ringCustomer(customerId, preferredEmployeeId = null, _triedEmployees = [], options = {}) {
    if (userCall.has(customerId)) {
      const outcome = { ok: false, error: 'You already have a call in progress.' };
      emitToSocket(options.requestSocketId || latestSocketId(customerId), 'call:error', { message: outcome.error });
      return outcome;
    }

    const customerResult = await db.query(`
      SELECT id, name, profile_image, balance_seconds, status, suspended_until
      FROM users
      WHERE id = $1 AND role = 'customer'
    `, [customerId]);
    const customer = customerResult.rows[0];
    const customerSocketId = options.requestSocketId || latestSocketId(customerId);

    if (!customerSocketId || !hasLiveSocket(customerId)) {
      return { ok: false, error: 'Calling is reconnecting. Please try again.' };
    }
    if (!customer || accountUnavailable(customer)) {
      const outcome = { ok: false, error: 'Your account is not available for calls.' };
      emitToSocket(customerSocketId, 'call:error', { message: outcome.error });
      return outcome;
    }
    if (Number(customer.balance_seconds) < config.minimumStartSeconds) {
      const outcome = { ok: false, error: 'Your wallet has no talk-time. Add minutes to start a call.', needsTopup: true };
      emitToSocket(customerSocketId, 'call:error', { message: outcome.error, needsTopup: true });
      return outcome;
    }

    let primaryLanguage = String(options.primaryLanguage || 'Malayalam').trim() || 'Malayalam';
    const allowOtherLanguages = Boolean(options.allowOtherLanguages);
    const directEmployeeId = options.directEmployeeId || preferredEmployeeId || null;
    if (directEmployeeId) {
      const preferred = employees.get(directEmployeeId);
      if (preferred?.language) primaryLanguage = preferred.language;
    }

    let entries = availableEmployeeEntries(primaryLanguage, allowOtherLanguages, directEmployeeId);
    const blocked = await db.query('SELECT employee_id FROM customer_blocks WHERE customer_id=$1', [customerId]);
    if (blocked.rows.length) {
      const blockedIds = new Set(blocked.rows.map((row) => row.employee_id));
      entries = entries.filter(([employeeId]) => !blockedIds.has(employeeId));
    }
    if (!entries.length) {
      const otherLanguagesAvailable = [...employees.values()].some((item) => item.state === 'available' && !sameLanguage(item.language, primaryLanguage));
      const outcome = {
        ok: false,
        unavailable: true,
        message: directEmployeeId
          ? 'This listener is not available right now. Please try again shortly.'
          : allowOtherLanguages
            ? `No ${primaryLanguage} or other-language listener is available right now. Please try again shortly.`
            : `No ${primaryLanguage} listener is available right now.${otherLanguagesAvailable ? ' Turn on “Suggest other languages” to connect with another available listener.' : ' Please try again shortly.'}`,
        otherLanguagesAvailable,
      };
      emitToSocket(customerSocketId, 'call:unavailable', outcome);
      return outcome;
    }

    // A random request rings every eligible listener at the same time. A direct
    // profile call contains only one entry. Runtime reservations prevent the same
    // listener from being offered to two customers while this ring is active.
    const candidateIds = new Set();
    const candidateSockets = new Map();
    const candidateClients = new Map();
    for (const [employeeId, employee] of entries) {
      const targetSocketId = latestSocketId(employeeId);
      if (!targetSocketId || userCall.has(employeeId) || employee.state !== 'available') continue;
      candidateIds.add(employeeId);
      candidateSockets.set(employeeId, targetSocketId);
      candidateClients.set(employeeId, io.sockets.sockets.get(targetSocketId)?.data?.clientId || targetSocketId);
    }

    if (!candidateIds.size) {
      const outcome = { ok: false, unavailable: true, message: 'No listener is available right now. Please try again shortly.' };
      emitToSocket(customerSocketId, 'call:unavailable', outcome);
      return outcome;
    }

    // Reserve candidates synchronously before the database await so two customer
    // requests cannot select the same listener in the same event-loop window.
    for (const employeeId of candidateIds) {
      const employee = employees.get(employeeId);
      if (employee?.state === 'available') employee.state = 'reserved';
    }

    // The schema keeps employee_id non-null for historical reporting. Until one
    // listener accepts, store the first candidate as a placeholder; acceptance
    // atomically replaces it with the actual winner before the call connects.
    const placeholderEmployeeId = [...candidateIds][0];
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
        RETURNING id
      `, [customerId, placeholderEmployeeId]);
      callRow = callResult.rows[0];
    } catch (error) {
      for (const employeeId of candidateIds) {
        const employee = employees.get(employeeId);
        if (employee?.state === 'reserved') employee.state = employee.availability === 'break' ? 'break' : 'available';
      }
      if (error.code === '23505') {
        const outcome = { ok: false, error: 'A call is already in progress.' };
        emitToSocket(customerSocketId, 'call:error', { message: outcome.error });
        return outcome;
      }
      throw error;
    }

    const runtime = {
      id: callRow.id,
      customerId,
      customerSocketId,
      customerClientId: options.requestClientId || io.sockets.sockets.get(customerSocketId)?.data?.clientId || customerSocketId,
      employeeId: null,
      employeeSocketId: null,
      employeeClientId: null,
      placeholderEmployeeId,
      candidateIds,
      candidateSockets,
      candidateClients,
      status: 'ringing',
      billedSeconds: 0,
      listenerRatePaise: 0,
      language: primaryLanguage,
      primaryLanguage,
      allowOtherLanguages,
      directEmployeeId,
      customer: { id: customer.id, name: customer.name, profileImage: customer.profile_image || '' },
      balanceSeconds: Number(customer.balance_seconds),
      signalingReady: new Set(),
      offerStarted: false,
      activating: false,
      accepting: false,
      mediaConnected: new Set(),
      ringTimer: null,
      connectTimer: null,
      mediaReconnectTimer: null,
      mediaPaused: false,
      billingTimer: null,
      billingBusy: false,
      ending: false,
      disconnectTimers: new Map(),
    };

    calls.set(runtime.id, runtime);
    userCall.set(customerId, runtime.id);

    const validCandidates = [];
    for (const employeeId of [...candidateIds]) {
      const employee = employees.get(employeeId);
      const targetSocketId = candidateSockets.get(employeeId);
      if (!employee || employee.state !== 'reserved' || !targetSocketId || userCall.has(employeeId)) {
        if (employee?.state === 'reserved') employee.state = employee.availability === 'break' ? 'break' : 'available';
        runtime.candidateIds.delete(employeeId);
        runtime.candidateSockets.delete(employeeId);
        runtime.candidateClients.delete(employeeId);
        continue;
      }
      employee.state = 'ringing';
      employee.lastAssigned = ++assignmentSequence;
      userCall.set(employeeId, runtime.id);
      validCandidates.push(employeeId);
      emitToSocket(targetSocketId, 'call:incoming', {
        callId: runtime.id,
        customer: runtime.customer,
        balanceSeconds: runtime.balanceSeconds,
        language: employee.language || primaryLanguage,
      });
    }

    if (!validCandidates.length) {
      for (const employeeId of candidateIds) {
        const employee = employees.get(employeeId);
        if (employee?.state === 'reserved') employee.state = employee.availability === 'break' ? 'break' : 'available';
      }
      await db.query(`UPDATE calls SET status='cancelled',ended_at=now(),end_reason='No listener remained available' WHERE id=$1 AND status='ringing'`, [runtime.id]);
      calls.delete(runtime.id);
      userCall.delete(customerId);
      const outcome = { ok: false, unavailable: true, message: 'No listener remained available. Please try again.' };
      emitToSocket(customerSocketId, 'call:unavailable', outcome);
      broadcastListeners();
      return outcome;
    }

    emitToSocket(customerSocketId, 'call:ringing', customerRingingPayload(runtime));

    broadcastListeners();
    runtime.ringTimer = setTimeout(() => {
      finishUnansweredBroadcast(runtime, 'No listener answered in time.').catch(console.error);
    }, config.ringSeconds * 1000);

    return { ok: true, state: 'ringing', callId: runtime.id, candidateCount: validCandidates.length };
  }

  async function retryCall(callId, reason) {
    const runtime = calls.get(callId);
    if (!runtime || runtime.ending) return;
    if (runtime.status === 'ringing') {
      await finishUnansweredBroadcast(runtime, reason);
      return;
    }
    await endCall(callId, reason);
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

    if (runtime.employeeId && (runtime.status === 'active' || runtime.billedSeconds > 0)) {
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
    }

    calls.delete(callId);
    if (userCall.get(runtime.customerId) === callId) userCall.delete(runtime.customerId);

    for (const employeeId of [...(runtime.candidateIds || [])]) {
      if (userCall.get(employeeId) === callId) userCall.delete(employeeId);
      restoreEmployeeAfterCall(employeeId);
      if (employeeId !== runtime.employeeId) {
        emitToUser(employeeId, 'call:ended', { callId, reason });
      }
    }
    if (runtime.employeeId) {
      if (userCall.get(runtime.employeeId) === callId) userCall.delete(runtime.employeeId);
      restoreEmployeeAfterCall(runtime.employeeId);
    }

    for (const timer of runtime.disconnectTimers?.values?.() || []) clearTimeout(timer);
    runtime.disconnectTimers?.clear?.();

    emitToSocket(runtime.customerSocketId, 'call:ended', { callId, reason, needsTopup });
    if (runtime.employeeSocketId) emitToSocket(runtime.employeeSocketId, 'call:ended', { callId, reason });
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
      emitToSocket(runtime.customerSocketId, 'call:connected', { callId: runtime.id });
      emitToSocket(runtime.employeeSocketId, 'call:connected', { callId: runtime.id });
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
          emitToSocket(runtime.customerSocketId, 'call:audio-restored', { callId: runtime.id });
          emitToSocket(runtime.employeeSocketId, 'call:audio-restored', { callId: runtime.id });
        }
      } else if (!runtime.mediaReconnectTimer) {
        runtime.mediaPaused = true;
        emitToSocket(runtime.customerSocketId, 'call:audio-paused', { callId: runtime.id });
        emitToSocket(runtime.employeeSocketId, 'call:audio-paused', { callId: runtime.id });
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
        emitToSocket(runtime.customerSocketId, 'call:tick', tick);
        emitToSocket(runtime.employeeSocketId, 'call:tick', tick);

        if (charge.balance <= 0) {
          await endCall(runtime.id, 'Your talk-time balance has ended.', true);
          return;
        }

        if (charge.balance === config.lowBalanceSeconds) {
          emitToSocket(runtime.customerSocketId, 'call:low-balance', { seconds: charge.balance });
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
      if (currentRuntime?.status === 'ringing' && isRingingCandidate(currentRuntime, user.id)) {
        const selected = currentRuntime.candidateSockets.get(user.id);
        const expectedClient = currentRuntime.candidateClients.get(user.id);
        if ((!selected || !io.sockets.sockets.has(selected)) && (!expectedClient || expectedClient === socket.data.clientId)) {
          currentRuntime.candidateSockets.set(user.id, socket.id);
          currentRuntime.candidateClients.set(user.id, socket.data.clientId);
          clearParticipantDisconnectTimer(currentRuntime, user.id);
          socket.emit('call:incoming', {
            callId: currentRuntime.id,
            customer: currentRuntime.customer,
            balanceSeconds: currentRuntime.balanceSeconds,
            language: employees.get(user.id)?.language || currentRuntime.primaryLanguage,
          });
        }
      } else if (currentRuntime && ['connecting', 'active'].includes(currentRuntime.status) && currentRuntime.employeeId === user.id) {
        if ((!currentRuntime.employeeSocketId || !io.sockets.sockets.has(currentRuntime.employeeSocketId)) && (!currentRuntime.employeeClientId || currentRuntime.employeeClientId === socket.data.clientId)) {
          currentRuntime.employeeSocketId = socket.id;
          currentRuntime.employeeClientId = socket.data.clientId;
          clearParticipantDisconnectTimer(currentRuntime, user.id);
          socket.emit('call:resumed', { callId: currentRuntime.id, state: currentRuntime.status, initiatorId: currentRuntime.customerId });
        }
      }
      broadcastListeners();
    }

    if (user.role === 'customer') {
      socket.emit('listeners:update', { listeners: publicListeners() });
      const currentRuntime = calls.get(userCall.get(user.id));
      if (currentRuntime?.status === 'ringing' && currentRuntime.customerId === user.id && (!currentRuntime.customerClientId || currentRuntime.customerClientId === socket.data.clientId)) {
        currentRuntime.customerSocketId = socket.id;
        currentRuntime.customerClientId = socket.data.clientId;
        clearParticipantDisconnectTimer(currentRuntime, user.id);
        socket.emit('call:ringing', customerRingingPayload(currentRuntime));
      } else if (currentRuntime && ['connecting', 'active'].includes(currentRuntime.status) && currentRuntime.customerId === user.id) {
        if ((!currentRuntime.customerSocketId || !io.sockets.sockets.has(currentRuntime.customerSocketId)) && (!currentRuntime.customerClientId || currentRuntime.customerClientId === socket.data.clientId)) {
          currentRuntime.customerSocketId = socket.id;
          currentRuntime.customerClientId = socket.data.clientId;
          clearParticipantDisconnectTimer(currentRuntime, user.id);
          socket.emit('call:resumed', { callId: currentRuntime.id, state: currentRuntime.status, initiatorId: currentRuntime.customerId });
        }
      }
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

      if (runtime?.status === 'ringing' && isRingingCandidate(runtime, user.id)) {
        releaseRingingCandidate(runtime, user.id, 'The listener went offline.', true);
        if (!runtime.candidateIds.size) await finishUnansweredBroadcast(runtime, 'No listener remained available.');
      } else if (runtime) {
        await endCall(runtime.id, 'The listener went offline.');
      }
      availabilityReply(acknowledge, { ok: true, status: 'offline' });
    }));

    socket.on('call:request', safeHandler(async ({ employeeId = null, allowOtherLanguages = false } = {}, acknowledge) => {
      if (user.role !== 'customer') return availabilityReply(acknowledge, { ok: false, error: 'This is not a customer account.' });
      const directEmployeeId = employeeId || null;
      const outcome = await ringCustomer(user.id, directEmployeeId, [], {
        primaryLanguage: 'Malayalam',
        allowOtherLanguages: directEmployeeId ? false : Boolean(allowOtherLanguages),
        directEmployeeId,
        requestSocketId: socket.id,
        requestClientId: socket.data.clientId,
      });
      availabilityReply(acknowledge, outcome || { ok: false, error: 'The call could not start.' });
    }));

    socket.on('call:cancel', safeHandler(async ({ callId } = {}) => {
      const runtime = calls.get(callId);
      if (runtime?.customerId === user.id) {
        await endCall(callId, 'The customer cancelled the call.');
      }
    }));

    socket.on('call:accept', safeHandler(async ({ callId } = {}, acknowledge) => {
      if (user.role !== 'employee') return availabilityReply(acknowledge, { ok: false, error: 'This is not a listener account.' });
      const runtime = calls.get(callId);
      if (!runtime || runtime.status !== 'ringing' || runtime.ending || runtime.accepting || !isRingingCandidate(runtime, user.id)) {
        return availabilityReply(acknowledge, { ok: false, error: 'This call is no longer available.' });
      }
      if (runtime.candidateSockets.get(user.id) !== socket.id) {
        return availabilityReply(acknowledge, { ok: false, error: 'Answer this call from the tab where it is ringing.' });
      }
      if (user.listener_availability !== 'online' || !hasLiveSocket(user.id)) {
        releaseRingingCandidate(runtime, user.id, 'You are no longer available for this call.', false);
        broadcastListeners();
        if (!runtime.candidateIds.size) await finishUnansweredBroadcast(runtime, 'No listener remained available.');
        return availabilityReply(acknowledge, { ok: false, error: 'You are no longer available.' });
      }

      runtime.accepting = true;
      if (runtime.ringTimer) clearTimeout(runtime.ringTimer);
      runtime.ringTimer = null;

      try {
        const persisted = await db.query(`
          SELECT listener_availability,listener_verification_status,status,listener_rate_paise
          FROM users WHERE id=$1 AND role='employee'
        `, [user.id]);
        const row = persisted.rows[0];
        if (!row || row.status !== 'active' || row.listener_verification_status !== 'approved' || row.listener_availability !== 'online') {
          runtime.accepting = false;
          releaseRingingCandidate(runtime, user.id, 'You are no longer available for this call.', false);
          broadcastListeners();
          if (!runtime.candidateIds.size) await finishUnansweredBroadcast(runtime, 'No listener remained available.');
          return availabilityReply(acknowledge, { ok: false, error: 'You are no longer available.' });
        }

        const result = await db.query(`
          UPDATE calls
          SET status='connecting',
              employee_id=$2,
              listener_rate_paise=COALESCE((SELECT listener_rate_paise FROM users WHERE id=$2 AND role='employee'),0)
          WHERE id=$1 AND status='ringing'
          RETURNING id,listener_rate_paise
        `, [callId, user.id]);

        if (!result.rows[0] || runtime.ending) {
          runtime.accepting = false;
          return availabilityReply(acknowledge, { ok: false, error: 'Another listener already answered this call.' });
        }

        const customerSocketId = io.sockets.sockets.has(runtime.customerSocketId)
          ? runtime.customerSocketId
          : latestSocketId(runtime.customerId);
        if (!customerSocketId) {
          runtime.accepting = false;
          await endCall(callId, 'The customer disconnected before the call connected.');
          return availabilityReply(acknowledge, { ok: false, error: 'The customer disconnected.' });
        }

        const losers = [...runtime.candidateIds].filter((id) => id !== user.id);
        for (const employeeId of losers) {
          releaseRingingCandidate(runtime, employeeId, 'Another listener answered this call.', true);
        }

        runtime.customerSocketId = customerSocketId;
        runtime.employeeId = user.id;
        runtime.employeeSocketId = socket.id;
        runtime.employeeClientId = socket.data.clientId;
        runtime.listenerRatePaise = Number(result.rows[0].listener_rate_paise || 0);
        runtime.status = 'connecting';
        runtime.accepting = false;
        runtime.candidateIds = new Set([user.id]);
        runtime.candidateSockets = new Map([[user.id, socket.id]]);
        runtime.candidateClients = new Map([[user.id, socket.data.clientId]]);
        runtime.signalingReady.clear();
        runtime.mediaConnected.clear();
        runtime.offerStarted = false;

        const employee = employees.get(user.id);
        if (employee) employee.state = 'busy';

        runtime.connectTimer = setTimeout(() => {
          endCall(callId, 'The audio connection could not be established.').catch(console.error);
        }, 60_000);

        const payload = { callId, initiatorId: runtime.customerId, employee: candidatePayload(user.id) };
        emitToSocket(runtime.customerSocketId, 'call:accepted', payload);
        emitToSocket(runtime.employeeSocketId, 'call:accepted', payload);
        broadcastListeners();
        availabilityReply(acknowledge, { ok: true, callId });
      } catch (error) {
        runtime.accepting = false;
        if (!runtime.ending && runtime.status !== 'connecting') {
          await finishUnansweredBroadcast(runtime, 'The call could not be accepted.');
        }
        throw error;
      }
    }));

    socket.on('call:reject', safeHandler(async ({ callId } = {}, acknowledge) => {
      const runtime = calls.get(callId);
      if (!runtime || runtime.status !== 'ringing' || !isRingingCandidate(runtime, user.id)) {
        return availabilityReply(acknowledge, { ok: false, error: 'This call is no longer ringing.' });
      }
      releaseRingingCandidate(runtime, user.id, 'You declined this call.', false);
      emitToSocket(socket.id, 'call:ended', { callId, reason: 'Call declined.' });
      broadcastListeners();
      if (!runtime.candidateIds.size) {
        await finishUnansweredBroadcast(runtime, 'All available listeners declined the call.');
      } else {
        emitToSocket(runtime.customerSocketId, 'call:retrying', { reason: 'Waiting for another available listener…' });
      }
      availabilityReply(acknowledge, { ok: true });
    }));

    socket.on('call:resume', safeHandler(async ({ callId } = {}, acknowledge) => {
      const runtime = calls.get(callId || userCall.get(user.id));
      if (!runtime || runtime.ending) return availabilityReply(acknowledge, { ok: false, error: 'No active call to resume.' });

      if (runtime.status === 'ringing' && user.role === 'employee' && isRingingCandidate(runtime, user.id)) {
        const expectedClient = runtime.candidateClients.get(user.id);
        if (expectedClient && expectedClient !== socket.data.clientId) return availabilityReply(acknowledge, { ok: false, error: 'This call is ringing in another tab.' });
        runtime.candidateSockets.set(user.id, socket.id);
        runtime.candidateClients.set(user.id, socket.data.clientId);
        clearParticipantDisconnectTimer(runtime, user.id);
        emitToSocket(socket.id, 'call:incoming', {
          callId: runtime.id,
          customer: runtime.customer,
          balanceSeconds: runtime.balanceSeconds,
          language: employees.get(user.id)?.language || runtime.primaryLanguage,
        });
        return availabilityReply(acknowledge, { ok: true, state: 'ringing', callId: runtime.id });
      }

      if (runtime.status === 'ringing' && user.role === 'customer' && runtime.customerId === user.id) {
        if (runtime.customerClientId && runtime.customerClientId !== socket.data.clientId) return availabilityReply(acknowledge, { ok: false, error: 'This call was started in another tab.' });
        runtime.customerSocketId = socket.id;
        runtime.customerClientId = socket.data.clientId;
        clearParticipantDisconnectTimer(runtime, user.id);
        emitToSocket(socket.id, 'call:ringing', customerRingingPayload(runtime));
        return availabilityReply(acknowledge, { ok: true, state: 'ringing', callId: runtime.id });
      }

      if (!['connecting', 'active'].includes(runtime.status) || ![runtime.customerId, runtime.employeeId].includes(user.id)) {
        return availabilityReply(acknowledge, { ok: false, error: 'No active call to resume.' });
      }

      if (user.id === runtime.customerId && runtime.customerClientId && runtime.customerClientId !== socket.data.clientId) return availabilityReply(acknowledge, { ok: false, error: 'This call is active in another tab.' });
      if (user.id === runtime.employeeId && runtime.employeeClientId && runtime.employeeClientId !== socket.data.clientId) return availabilityReply(acknowledge, { ok: false, error: 'This call is active in another tab.' });
      clearParticipantDisconnectTimer(runtime, user.id);
      if (user.id === runtime.customerId) { runtime.customerSocketId = socket.id; runtime.customerClientId = socket.data.clientId; }
      if (user.id === runtime.employeeId) { runtime.employeeSocketId = socket.id; runtime.employeeClientId = socket.data.clientId; }

      availabilityReply(acknowledge, { ok: true, state: runtime.status, callId: runtime.id, initiatorId: runtime.customerId });
      emitToSocket(socket.id, 'call:resumed', { callId: runtime.id, state: runtime.status, initiatorId: runtime.customerId });
    }));

    socket.on('webrtc:ready', safeHandler(async ({ callId } = {}) => {
      const runtime = calls.get(callId);
      if (!runtime || runtime.status !== 'connecting') return;
      if (!isSelectedParticipantSocket(runtime, user.id, socket.id)) return;

      runtime.signalingReady.add(socket.id);
      if (runtime.signalingReady.has(runtime.customerSocketId) && runtime.signalingReady.has(runtime.employeeSocketId) && !runtime.offerStarted) {
        runtime.offerStarted = true;
        emitToSocket(runtime.customerSocketId, 'webrtc:start', { callId: runtime.id });
      }
    }));

    socket.on('call:media-state', safeHandler(async ({ callId, connected } = {}) => {
      const runtime = calls.get(callId);
      if (!runtime || !['connecting', 'active'].includes(runtime.status)) return;
      if (!isSelectedParticipantSocket(runtime, user.id, socket.id)) return;

      updateMediaState(runtime, user.id, Boolean(connected));
      await activateCallIfReady(runtime);
    }));

    socket.on('call:end', safeHandler(async ({ callId } = {}) => {
      const runtime = calls.get(callId);
      if (runtime && isSelectedParticipantSocket(runtime, user.id, socket.id)) {
        await endCall(callId, 'The call was ended.');
      }
    }));

    for (const event of ['webrtc:offer', 'webrtc:answer', 'webrtc:ice']) {
      socket.on(event, ({ callId, payload } = {}) => {
        const runtime = calls.get(callId);
        if (!runtime || !['connecting', 'active'].includes(runtime.status)) return;
        if (!isSelectedParticipantSocket(runtime, user.id, socket.id)) return;
        const targetSocketId = otherParticipantSocket(runtime, user.id);
        if (!targetSocketId) return;
        emitToSocket(targetSocketId, event, { callId, payload, from: user.id });
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

        const chatPayload = {
          ...result.rows[0],
          callId,
          senderId: user.id,
          senderName: user.name,
        };
        emitToSocket(runtime.customerSocketId, 'chat:message', chatPayload);
        emitToSocket(runtime.employeeSocketId, 'chat:message', chatPayload);
        return reply({ ok: true, id: result.rows[0].id });
      }).catch((error) => {
        console.error('Socket chat failed:', error);
        reply({ ok: false, error: 'The message could not be sent. Please try again.' });
      });
    });

    socket.on('disconnect', safeHandler(async () => {
      const remainingSockets = removeUserSocket(user.id, socket.id);
      if (!remainingSockets) {
        connectedUsers.delete(user.id);
        db.query('UPDATE users SET last_seen_at=now() WHERE id=$1', [user.id]).catch(console.error);
      }

      const callId = userCall.get(user.id);
      const runtime = calls.get(callId);

      if (runtime?.status === 'ringing' && user.role === 'employee' && isRingingCandidate(runtime, user.id)) {
        if (runtime.candidateSockets.get(user.id) === socket.id) {
          const replacement = socketIdForClient(user.id, runtime.candidateClients.get(user.id));
          if (replacement) {
            runtime.candidateSockets.set(user.id, replacement);
            emitToSocket(replacement, 'call:incoming', {
              callId: runtime.id,
              customer: runtime.customer,
              balanceSeconds: runtime.balanceSeconds,
              language: employees.get(user.id)?.language || runtime.primaryLanguage,
            });
          } else {
            releaseRingingCandidate(runtime, user.id, 'Listener disconnected before answering.', false);
            broadcastListeners();
            if (!runtime.candidateIds.size) {
              await finishUnansweredBroadcast(runtime, 'No listener remained connected.');
            }
          }
        }
      } else if (runtime && ['connecting', 'active'].includes(runtime.status) && isSelectedParticipantSocket(runtime, user.id, socket.id)) {
        const expectedClient = user.id === runtime.customerId ? runtime.customerClientId : runtime.employeeClientId;
        const replacement = socketIdForClient(user.id, expectedClient);
        if (replacement) {
          if (user.id === runtime.customerId) runtime.customerSocketId = replacement;
          if (user.id === runtime.employeeId) runtime.employeeSocketId = replacement;
          emitToSocket(replacement, 'call:resumed', { callId: runtime.id, state: runtime.status, initiatorId: runtime.customerId });
        } else if (!runtime.disconnectTimers.has(user.id)) {
          const graceMs = Math.max(12_000, Math.min(config.mediaReconnectSeconds * 1000, 45_000));
          const timer = setTimeout(() => {
            runtime.disconnectTimers.delete(user.id);
            if (!hasLiveSocket(user.id) && calls.get(runtime.id) === runtime) {
              endCall(runtime.id, `${user.role === 'employee' ? 'The listener' : 'The customer'} disconnected.`).catch(console.error);
            }
          }, graceMs);
          timer.unref();
          runtime.disconnectTimers.set(user.id, timer);
        }
      }

      if (user.role === 'employee' && !remainingSockets) {
        // A listener that has no browser connection must disappear from the live
        // directory immediately. Persisted availability changes after the grace
        // window so short reconnects do not create unnecessary activity sessions.
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
    }));
  });

  async function refreshEmployeeProfile(userId) {
    const result = await db.query(`SELECT id,name,username,bio,
      CASE WHEN profile_image LIKE 'data:image/%' THEN 'photo:'||id::text ELSE profile_image END AS profile_image,
      CASE WHEN banner_image LIKE 'data:image/%' THEN 'photo:'||id::text ELSE banner_image END AS banner_image,
      listener_language,listener_availability,listener_verification_status,status,updated_at
      FROM users WHERE id=$1 AND role='employee'`, [userId]);
    const row = result.rows[0];
    const current = employees.get(userId);
    if (row?.status === 'active' && row.listener_verification_status === 'approved') {
      io.emit('listener:profile-updated', {
        listener: {
          id: row.id,
          name: row.username || row.name,
          bio: row.bio || '',
          avatar: row.profile_image || '',
          banner: row.banner_image || '',
          language: row.listener_language || 'Malayalam',
          updatedAt: row.updated_at,
        },
      });
    }
    if (!current) {
      broadcastListeners();
      return;
    }
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
      current.updatedAt = row.updated_at;
      current.availability = row.listener_availability;
      if (current.state !== 'ringing' && current.state !== 'busy') current.state = row.listener_availability === 'break' ? 'break' : 'available';
    }
    broadcastListeners();
  }

  async function restrictUser(userId, reason) {
    cancelListenerDisconnect(userId);
    const callId = userCall.get(userId);
    const runtime = calls.get(callId);
    if (runtime?.status === 'ringing' && isRingingCandidate(runtime, userId)) {
      releaseRingingCandidate(runtime, userId, reason || 'The account was restricted.', true);
      if (!runtime.candidateIds.size) await finishUnansweredBroadcast(runtime, reason || 'No listener remained available.');
    } else if (callId) {
      await endCall(callId, reason || 'The account was restricted.');
    }
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
