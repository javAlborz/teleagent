import OpenAI from 'openai';

import { assertCallId } from './sip-event.js';

export function buildAcceptConfig(config) {
  return {
    type: 'realtime',
    model: config.model,
    instructions: config.instructions,
    output_modalities: ['audio'],
    audio: {
      input: {
        turn_detection: {
          type: 'semantic_vad',
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        voice: config.voice,
      },
    },
  };
}

export class OpenAICallService {
  #client;
  #config;

  constructor({ config, client } = {}) {
    this.#config = config;
    this.#client = client ?? new OpenAI({
      apiKey: config.apiKey,
      webhookSecret: config.webhookSecret,
      baseURL: config.apiBaseUrl,
      // Call acceptance/rejection is not documented as idempotent. Let the signed
      // verified webhook delivery and our durable state machine own retries
      // instead of retrying a non-idempotent call action invisibly.
      maxRetries: 0,
    });
  }

  async verifyWebhook(rawBody, headers) {
    return this.#client.webhooks.unwrap(rawBody, headers);
  }

  async accept(callId) {
    await this.#client.realtime.calls.accept(assertCallId(callId), buildAcceptConfig(this.#config));
  }

  async reject(callId, statusCode) {
    await this.#client.realtime.calls.reject(assertCallId(callId), { status_code: statusCode });
  }

  async hangup(callId) {
    await this.#client.realtime.calls.hangup(assertCallId(callId));
  }
}
