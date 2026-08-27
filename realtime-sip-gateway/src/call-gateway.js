import { EventEmitter } from 'node:events';

import { SidebandSession } from './sideband-session.js';
import { decideIncomingCall } from './sip-event.js';

const RECOVERABLE_SIDEBAND_STATES = new Set(['accepted', 'sideband_attaching', 'attached']);
const DEFAULT_SIDEBAND_CLOSE_TIMEOUT_MS = 2_000;

function durableErrorCode(error, fallback) {
  const candidate = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate) ? candidate : fallback;
}

function isConfirmedAbsentCall(error) {
  return Number(error?.status) === 404;
}

export class CallGateway extends EventEmitter {
  #config;
  #callService;
  #logger;
  #registry;
  #stateStore;
  #sidebandFactory;
  #crashInjector;
  #inFlight = new Map();
  #background = new Set();
  #closing = false;
  #closed = false;
  #closePromise = null;
  #unconfirmedSessions = new Map();
  #sidebandCloseTimeoutMs;

  constructor({
    config,
    callService,
    logger,
    registry,
    sidebandFactory = (options) => new SidebandSession(options),
    crashInjector = null,
    sidebandCloseTimeoutMs = DEFAULT_SIDEBAND_CLOSE_TIMEOUT_MS,
  }) {
    super();
    if (!registry) throw new TypeError('CallGateway requires a durable call registry');
    this.#config = config;
    this.#callService = callService;
    this.#logger = logger;
    this.#registry = registry;
    this.#stateStore = registry.stateStore;
    this.#sidebandFactory = sidebandFactory;
    this.#crashInjector = crashInjector;
    const normalizedCloseTimeout = Number(sidebandCloseTimeoutMs);
    if (!Number.isInteger(normalizedCloseTimeout) || normalizedCloseTimeout < 10
        || normalizedCloseTimeout > 10_000) {
      throw new TypeError('Sideband close timeout must be an integer from 10 to 10000 milliseconds');
    }
    this.#sidebandCloseTimeoutMs = normalizedCloseTimeout;
  }

  get registry() {
    return this.#registry;
  }

  async handleIncoming(event, { webhookId } = {}) {
    if (this.#closing) {
      const error = new Error('Realtime SIP gateway is closing');
      error.code = 'SIP_GATEWAY_CLOSING';
      throw error;
    }
    const decision = decideIncomingCall(this.#config, event);
    const active = this.#inFlight.get(decision.callId);
    if (active) return active;
    const operation = this.#handleIncoming(decision, webhookId);
    this.#inFlight.set(decision.callId, operation);
    try {
      return await operation;
    } finally {
      this.#inFlight.delete(decision.callId);
    }
  }

  async #handleIncoming(decision, webhookId) {
    const reservation = this.#stateStore.reserveCall({
      webhookId,
      callId: decision.callId,
      authenticatedPrincipal: decision.authenticatedPrincipal ?? null,
      decision: decision.action,
      reason: decision.reason,
      statusCode: decision.statusCode ?? null,
      maxActiveCalls: this.#config.maxActiveCalls,
    });
    if (!reservation.inserted) return this.#resumeExisting(reservation.record);

    if (reservation.record.state === 'reject_intent') {
      return this.#performReject(reservation.record);
    }

    this.#injectCrash('after_accept_intent', decision.callId);
    try {
      await this.#callService.accept(decision.callId);
    } catch (error) {
      this.#logger.error('Realtime call accept returned an uncertain outcome; failing closed', {
        callId: decision.callId,
        errorCode: durableErrorCode(error, 'ACCEPT_FAILED'),
      });
      return this.#conservativeHangup(decision.callId, 'accept_api_uncertain', error);
    }
    this.#injectCrash('after_remote_accept', decision.callId);
    this.#registry.update(decision.callId, 'accepted');
    this.#injectCrash('after_accepted', decision.callId);
    this.#logger.info('Accepted authenticated incoming SIP canary call', {
      callId: decision.callId,
      authenticatedPrincipal: decision.authenticatedPrincipal,
    });
    return this.#attachSideband(decision.callId, { recovering: false });
  }

  async #performReject(record) {
    this.#injectCrash('after_reject_intent', record.callId);
    try {
      await this.#callService.reject(record.callId, record.rejectStatus);
    } catch (error) {
      this.#logger.error('Realtime call reject returned an uncertain outcome; failing closed', {
        callId: record.callId,
        errorCode: durableErrorCode(error, 'REJECT_FAILED'),
      });
      return this.#conservativeHangup(record.callId, 'reject_api_uncertain', error);
    }
    this.#injectCrash('after_remote_reject', record.callId);
    this.#registry.update(record.callId, 'rejected', { rejectStatus: record.rejectStatus });
    this.#logger.info('Rejected incoming SIP canary call', {
      callId: record.callId,
      reason: record.decision,
      statusCode: record.rejectStatus,
    });
    return {
      outcome: record.decision === 'capacity_reached' ? 'capacity_rejected' : 'rejected',
      callId: record.callId,
    };
  }

  async #resumeExisting(record) {
    if (['closed', 'rejected', 'failed'].includes(record.state)) {
      return { outcome: `already_${record.state}`, callId: record.callId };
    }
    if (RECOVERABLE_SIDEBAND_STATES.has(record.state)) {
      const live = this.#registry.get(record.callId);
      if (live?.session) return { outcome: 'already_attached', callId: record.callId };
      return this.#attachSideband(record.callId, { recovering: true });
    }
    return this.#conservativeHangup(record.callId, `${record.state}_recovery`);
  }

  async recover() {
    const records = this.#stateStore.activeRecords();
    for (const record of records) {
      if (RECOVERABLE_SIDEBAND_STATES.has(record.state)) {
        await this.#attachSideband(record.callId, { recovering: true });
      } else {
        await this.#conservativeHangup(record.callId, `${record.state}_startup_recovery`);
      }
    }
  }

  async #attachSideband(callId, { recovering }) {
    this.#registry.update(callId, 'sideband_attaching', recovering
      ? { recoveryReason: 'exact_call_id_sideband_adoption' }
      : {});
    this.#injectCrash('after_sideband_attaching', callId);

    let session;
    try {
      session = this.#sidebandFactory({ callId, config: this.#config });
    } catch (error) {
      this.#registry.update(callId, 'hangup_intent', {
        failureCode: 'SIDEBAND_CREATE_FAILED',
      });
      this.#logger.error('Could not create Realtime sideband; failing closed', {
        callId,
        errorCode: durableErrorCode(error, 'SIDEBAND_CREATE_FAILED'),
      });
      return this.#conservativeHangup(callId, 'sideband_create_failed', error);
    }

    const lifecycle = { intentionalClose: false };
    this.#registry.attachSession(callId, session);
    this.#wireSideband(callId, session, lifecycle);
    try {
      await session.connect();
      this.#injectCrash('after_sideband_connected', callId);
      this.#registry.update(callId, 'attached');
      this.#injectCrash('after_attached', callId);
      if (this.#config.greetingEnabled && !recovering) session.requestResponse();
      this.#logger.info(recovering
        ? 'Adopted existing Realtime call by exact call ID'
        : 'Attached Realtime sideband to accepted call', { callId });
      return { outcome: recovering ? 'sideband_adopted' : 'accepted', callId };
    } catch (error) {
      if (error?.simulatedCrash === true) throw error;
      lifecycle.intentionalClose = true;
      this.#registry.detachSession(callId, session);
      session.close?.(1011, 'sideband attach failed');
      this.#logger.error('Could not attach Realtime sideband; failing closed', {
        callId,
        errorCode: durableErrorCode(error, 'SIDEBAND_CONNECT_FAILED'),
      });
      return this.#conservativeHangup(callId, recovering
        ? 'sideband_adoption_failed'
        : 'sideband_connect_failed', error);
    }
  }

  #wireSideband(callId, session, lifecycle) {
    session.on('raw_event', (event) => {
      this.emit('raw_event', { callId, event });
    });
    session.on('dtmf', (event) => {
      this.#logger.info('Received SIP DTMF event', { callId });
      this.emit('dtmf', { callId, ...event });
    });
    session.on('protocol_error', (error) => {
      this.#logger.warn('Invalid Realtime sideband event', { callId, error: error.message });
    });
    session.on('realtime_error', (error) => {
      this.#logger.error('OpenAI Realtime sideband reported an error', {
        callId,
        error: typeof error?.message === 'string' ? error.message : 'realtime_error',
      });
    });
    session.on('socket_error', (error) => {
      this.#logger.warn('Realtime sideband socket error', { callId, error: error.message });
    });
    session.on('close', ({ code, previousState }) => {
      this.#registry.detachSession(callId, session);
      if (this.#unconfirmedSessions.get(callId) === session) {
        this.#unconfirmedSessions.delete(callId);
      }
      this.#logger.info('Realtime sideband closed', { callId, code, previousState });
      this.emit('call_closed', { callId, code, previousState });
      if (!lifecycle.intentionalClose && !this.#closing) {
        const record = this.#registry.get(callId);
        if (record?.state === 'attached') {
          this.#track(this.#conservativeHangup(callId, 'unexpected_sideband_close'));
        }
      }
    });
  }

  async #conservativeHangup(callId, reason, sourceError = null) {
    const current = this.#registry.get(callId);
    if (!current) return { outcome: 'outcome_unknown', callId };
    this.#registry.update(callId, 'hangup_intent', {
      recoveryReason: reason,
      ...(sourceError
        ? { failureCode: durableErrorCode(sourceError, 'REMOTE_OUTCOME_UNCERTAIN') }
        : {}),
    });
    try {
      await this.#callService.hangup(callId);
      this.#injectCrash('after_remote_hangup', callId);
      this.#registry.update(callId, 'closed', {
        closeReason: reason,
        recoveryReason: reason,
        failureCode: null,
        hangupConfirmed: true,
      });
      return { outcome: 'closed_fail_safe', callId };
    } catch (error) {
      if (error?.simulatedCrash === true) throw error;
      if (isConfirmedAbsentCall(error)) {
        this.#registry.update(callId, 'closed', {
          closeReason: reason,
          recoveryReason: reason,
          failureCode: null,
          hangupConfirmed: true,
        });
        this.#logger.info('Realtime call was already absent during fail-safe hangup', {
          callId,
          reason,
        });
        return { outcome: 'closed_fail_safe', callId };
      }
      this.#registry.update(callId, 'outcome_unknown', {
        recoveryReason: reason,
        failureCode: durableErrorCode(error, 'HANGUP_FAILED'),
        hangupConfirmed: false,
      });
      this.#logger.error('Could not confirm conservative Realtime call hangup', {
        callId,
        reason,
        errorCode: durableErrorCode(error, 'HANGUP_FAILED'),
      });
      return { outcome: 'outcome_unknown', callId };
    }
  }

  #injectCrash(point, callId) {
    this.#crashInjector?.(point, { callId });
  }

  #track(promise) {
    this.#background.add(promise);
    void promise.catch((error) => {
      this.#logger.error('Background Realtime call cleanup failed', {
        errorCode: durableErrorCode(error, 'BACKGROUND_CLEANUP_FAILED'),
      });
    }).finally(() => this.#background.delete(promise));
  }

  async #closeSideband(callId, session) {
    if (!session) return { quiesced: true, callId };
    if (session.state === 'closed') {
      this.#registry.detachSession(callId, session);
      if (this.#unconfirmedSessions.get(callId) === session) {
        this.#unconfirmedSessions.delete(callId);
      }
      return { quiesced: true, callId };
    }
    if (typeof session.once !== 'function' || typeof session.close !== 'function') {
      const error = new Error(`Sideband close cannot be confirmed for call ${callId}`);
      error.code = 'SIDEBAND_CLOSE_UNCONFIRMED';
      throw error;
    }

    this.#unconfirmedSessions.set(callId, session);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.off?.('close', onClose);
        if (error) reject(error);
        else resolve({ quiesced: true, callId });
      };
      const onClose = () => {
        this.#registry.detachSession(callId, session);
        if (this.#unconfirmedSessions.get(callId) === session) {
          this.#unconfirmedSessions.delete(callId);
        }
        finish();
      };
      const timer = setTimeout(() => {
        const error = new Error(`Sideband close timed out for call ${callId}`);
        error.code = 'SIDEBAND_CLOSE_UNCONFIRMED';
        finish(error);
      }, this.#sidebandCloseTimeoutMs);
      session.once('close', onClose);
      try {
        const closeResult = session.close(1001, 'gateway shutdown');
        Promise.resolve(closeResult).catch((error) => finish(error));
      } catch (error) {
        finish(error);
      }
    });
  }

  async close() {
    if (this.#closed) {
      return { quiesced: true, activeCount: 0, unconfirmedSessionCount: 0 };
    }
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      // HTTP shutdown normally drains these first, but the gateway also proves
      // its own standalone quiescence before surrendering process ownership.
      await Promise.allSettled([...this.#inFlight.values()]);

      const calls = this.#registry.activeRecords();
      const sessions = new Map(this.#unconfirmedSessions);
      for (const record of calls) {
        if (record.session) sessions.set(record.callId, record.session);
      }
      const sidebandPromise = Promise.allSettled(
        [...sessions].map(([callId, session]) => this.#closeSideband(callId, session)),
      );
      const hangupPromise = Promise.allSettled(calls.map((record) => (
        this.#conservativeHangup(record.callId, 'gateway_shutdown')
      )));
      const [sidebandResults] = await Promise.all([sidebandPromise, hangupPromise]);
      await Promise.allSettled([...this.#background]);

      const remaining = this.#registry.activeRecords();
      const failedSidebands = sidebandResults.filter((result) => result.status === 'rejected');
      const quiesced = remaining.length === 0
        && this.#inFlight.size === 0
        && this.#background.size === 0
        && this.#unconfirmedSessions.size === 0
        && failedSidebands.length === 0;
      if (!quiesced) {
        const error = new Error(
          `Realtime SIP gateway quiescence is unconfirmed: active=${remaining.length}, sideband=${this.#unconfirmedSessions.size}`,
        );
        error.code = 'SIP_GATEWAY_NOT_QUIESCED';
        error.activeCallIds = remaining.map((record) => record.callId);
        error.unconfirmedSessionCallIds = [...this.#unconfirmedSessions.keys()];
        throw error;
      }
      this.#closed = true;
      return {
        quiesced: true,
        activeCount: 0,
        unconfirmedSessionCount: 0,
      };
    })();
    try {
      return await this.#closePromise;
    } finally {
      this.#closePromise = null;
    }
  }
}
