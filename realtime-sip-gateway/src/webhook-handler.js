import OpenAI from 'openai';

import { assertCallId } from './sip-event.js';
import { SipStateStorageError } from './state-storage-boundary.js';

function firstHeader(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function response(statusCode, body = '') {
  return { statusCode, body };
}

export class OpenAIWebhookHandler {
  #callService;
  #callGateway;
  #stateStore;
  #logger;
  #inFlight = new Map();

  constructor({ callService, callGateway, stateStore, logger }) {
    this.#callService = callService;
    this.#callGateway = callGateway;
    this.#stateStore = stateStore;
    this.#logger = logger;
  }

  async handle({ headers, rawBody }) {
    const webhookId = firstHeader(headers, 'webhook-id');
    if (typeof webhookId !== 'string' || !webhookId) {
      return response(400, 'Missing webhook-id');
    }

    let event;
    try {
      event = await this.#callService.verifyWebhook(rawBody.toString('utf8'), headers);
    } catch (error) {
      const signatureFailure = error instanceof OpenAI.InvalidWebhookSignatureError;
      this.#logger.warn('Rejected OpenAI webhook', {
        webhookId,
        reason: signatureFailure ? 'invalid_signature' : 'verification_failed',
      });
      return response(400, 'Invalid webhook');
    }

    try {
      const metadata = {
        eventId: event?.id,
        eventType: event?.type,
        callId: event?.type === 'realtime.call.incoming'
          ? assertCallId(event?.data?.call_id)
          : event?.data?.call_id,
      };
      const verified = this.#stateStore.recordVerifiedWebhook(webhookId, metadata);
      if (verified.duplicate) {
        this.#logger.info('Acknowledged duplicate OpenAI webhook', {
          webhookId,
          priorOutcome: verified.record.outcome,
        });
        return response(event?.type === 'realtime.call.incoming' ? 200 : 204);
      }

      const active = this.#inFlight.get(webhookId);
      if (active) {
        await active;
        return response(event?.type === 'realtime.call.incoming' ? 200 : 204);
      }

      const operation = this.#processVerified(webhookId, event);
      this.#inFlight.set(webhookId, operation);
      try {
        await operation;
      } finally {
        this.#inFlight.delete(webhookId);
      }
      return response(event?.type === 'realtime.call.incoming' ? 200 : 204);
    } catch (error) {
      if (error instanceof SipStateStorageError) {
        this.#logger.warn('Refused new OpenAI webhook at durable-state boundary', {
          webhookId,
          reason: error.code === 'SIP_STATE_CAPACITY_EXHAUSTED'
            ? 'durable_state_capacity_exhausted'
            : 'durable_state_boundary_invalid',
        });
        return response(503, 'Durable state unavailable');
      }
      if (error instanceof TypeError) {
        this.#logger.warn('Rejected malformed signed OpenAI webhook', {
          webhookId,
          error: error.message,
        });
        return response(400, 'Malformed webhook');
      }
      this.#logger.error('OpenAI webhook processing failed', {
        webhookId,
        error: error.message,
      });
      return response(500, 'Webhook processing failed');
    }
  }

  async #processVerified(webhookId, event) {
    if (event?.type !== 'realtime.call.incoming') {
      this.#logger.info('Ignored unconfigured OpenAI webhook event', {
        webhookId,
        eventType: event?.type ?? 'unknown',
      });
      this.#stateStore.completeWebhook(webhookId, 'ignored');
      return;
    }
    const result = await this.#callGateway.handleIncoming(event, { webhookId });
    this.#stateStore.completeWebhook(webhookId, result.outcome);
  }
}
