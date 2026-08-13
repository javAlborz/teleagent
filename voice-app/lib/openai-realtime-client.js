'use strict';

const { EventEmitter } = require('node:events');
const { URL } = require('node:url');
const WebSocket = require('ws');

const DEFAULT_BASE_URL = 'wss://api.openai.com/v1/realtime';
const DEFAULT_MODEL = 'gpt-realtime-2.1-mini';
const DEFAULT_VOICE = 'marin';
const PCM_SAMPLE_RATE = 24000;

function getRealtimeApiKey(environment = process.env) {
  return String(environment.OPENAI_REALTIME_API_KEY || '').trim();
}

function buildRealtimeTools(profiles) {
  return [
    {
      type: 'function',
      name: 'start_agent_task',
      description: 'Start a durable Claude Code or Codex task. Returns immediately with a job ID. Use this for repository, coding, shell, infrastructure, or other agent work.',
      parameters: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            enum: profiles,
            description: 'The exact Claude or Codex profile that should perform the task.',
          },
          request: {
            type: 'string',
            description: 'A self-contained task request, including relevant paths, constraints, and desired outcome.',
          },
          fresh_session: {
            type: 'boolean',
            description: 'Start this profile without its prior hidden CLI context. Defaults to false.',
          },
          notify_when_complete: {
            type: 'string',
            enum: ['in_call', 'callback', 'resume'],
            description: 'How to deliver a result if the job outlives the current exchange. Defaults to in_call.',
          },
        },
        required: ['profile', 'request'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'get_agent_task',
      description: 'Get the durable status and voice-safe result of one agent job.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'cancel_agent_task',
      description: 'Cancel one agent job. Omit job_id to cancel the caller’s currently focused job.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'list_agent_tasks',
      description: 'List recent or active durable agent jobs in this voice thread.',
      parameters: {
        type: 'object',
        properties: {
          active_only: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  ];
}

function parseArguments(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return { _parse_error: error.message };
  }
}

class OpenAIRealtimeClient extends EventEmitter {
  constructor({
    apiKey,
    model = DEFAULT_MODEL,
    voice = DEFAULT_VOICE,
    baseUrl = DEFAULT_BASE_URL,
    transcriptionModel = 'gpt-live-transcribe',
    instructions,
    profiles = [],
    safetyIdentifier = null,
    organization = null,
    project = null,
    connectTimeoutMs = 15000,
    toolHandler = null,
    WebSocketImpl = WebSocket,
  } = {}) {
    super();
    if (!apiKey) throw new Error('An OpenAI Realtime API key is required');
    if (!instructions) throw new Error('Realtime conductor instructions are required');

    this.apiKey = apiKey;
    this.model = model;
    this.voice = voice;
    this.baseUrl = baseUrl;
    this.transcriptionModel = transcriptionModel;
    this.instructions = instructions;
    this.profiles = profiles;
    this.safetyIdentifier = safetyIdentifier;
    this.organization = organization;
    this.project = project;
    this.connectTimeoutMs = connectTimeoutMs;
    this.toolHandler = toolHandler;
    this.WebSocketImpl = WebSocketImpl;

    this.ws = null;
    this.sessionId = null;
    this.connected = false;
    this.closedByClient = false;
    this.responseActive = false;
    this.userSpeaking = false;
    this.pendingNotices = [];
    this.handledToolCalls = new Set();
    this.outputTranscripts = new Map();
    this.eventSequence = 0;
  }

  _nextEventId(prefix = 'teleagent') {
    this.eventSequence += 1;
    return `${prefix}_${Date.now()}_${this.eventSequence}`;
  }

  _buildUrl() {
    const url = new URL(this.baseUrl);
    url.searchParams.set('model', this.model);
    return url.toString();
  }

  _buildHeaders() {
    const headers = { Authorization: `Bearer ${this.apiKey}` };
    if (this.safetyIdentifier) headers['OpenAI-Safety-Identifier'] = this.safetyIdentifier;
    if (this.organization) headers['OpenAI-Organization'] = this.organization;
    if (this.project) headers['OpenAI-Project'] = this.project;
    return headers;
  }

  connect() {
    if (this.ws) throw new Error('Realtime client is already connected or connecting');
    this.closedByClient = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.close(4000, 'connect timeout');
        reject(new Error(`Timed out connecting to OpenAI Realtime after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      const ws = new this.WebSocketImpl(this._buildUrl(), { headers: this._buildHeaders() });
      this.ws = ws;

      const settleError = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      ws.on('open', () => {
        try {
          this._sendSessionUpdate();
        } catch (error) {
          settleError(error);
        }
      });

      ws.on('message', (data) => {
        let event;
        try {
          event = JSON.parse(data.toString());
        } catch (error) {
          this.emit('protocol_error', new Error(`Invalid OpenAI Realtime event: ${error.message}`));
          return;
        }

        this._handleEvent(event).catch((error) => this.emit('protocol_error', error));

        if (event.type === 'session.updated' && !settled) {
          settled = true;
          clearTimeout(timer);
          this.connected = true;
          resolve(event.session || {});
        }

        if (event.type === 'error' && !settled) {
          const message = event.error?.message || event.message || 'OpenAI Realtime rejected the session';
          settleError(new Error(message));
        }
      });

      ws.on('error', (error) => {
        this.emit('socket_error', error);
        settleError(error);
      });

      ws.on('close', (code, reason) => {
        this.connected = false;
        this.ws = null;
        const details = { code, reason: reason?.toString() || '', expected: this.closedByClient };
        if (!settled) settleError(new Error(`OpenAI Realtime connection closed (${code})`));
        this.emit('close', details);
      });
    });
  }

  _sendSessionUpdate() {
    const input = {
      format: { type: 'audio/pcm', rate: PCM_SAMPLE_RATE },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 700,
        create_response: true,
        interrupt_response: true,
      },
    };
    if (this.transcriptionModel) {
      input.transcription = { model: this.transcriptionModel };
    }

    this.sendEvent({
      event_id: this._nextEventId('session'),
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this.model,
        output_modalities: ['audio'],
        instructions: this.instructions,
        audio: {
          input,
          output: {
            format: { type: 'audio/pcm', rate: PCM_SAMPLE_RATE },
            voice: this.voice,
          },
        },
        tools: buildRealtimeTools(this.profiles),
        tool_choice: 'auto',
      },
    });
  }

  sendEvent(event) {
    const openState = this.WebSocketImpl.OPEN ?? WebSocket.OPEN;
    if (!this.ws || this.ws.readyState !== openState) {
      throw new Error('OpenAI Realtime WebSocket is not open');
    }
    this.ws.send(JSON.stringify(event));
  }

  appendAudio(audio) {
    if (!this.connected || !audio?.length) return false;
    const maxBufferedBytes = 2 * 1024 * 1024;
    if (Number(this.ws?.bufferedAmount || 0) > maxBufferedBytes) {
      this.emit('audio_backpressure', { bufferedAmount: this.ws.bufferedAmount });
      return false;
    }
    this.sendEvent({
      event_id: this._nextEventId('audio'),
      type: 'input_audio_buffer.append',
      audio: Buffer.from(audio).toString('base64'),
    });
    return true;
  }

  requestResponse(response = undefined) {
    if (this.responseActive) return false;
    const event = {
      event_id: this._nextEventId('response'),
      type: 'response.create',
    };
    if (response) event.response = response;
    this.responseActive = true;
    this.sendEvent(event);
    return true;
  }

  sendSystemNotice(content, { speak = true, force = false } = {}) {
    const notice = String(content || '').trim();
    if (!notice) return false;
    if (!force && (this.responseActive || this.userSpeaking)) {
      this.pendingNotices.push({ content: notice, speak });
      return false;
    }

    this.sendEvent({
      event_id: this._nextEventId('notice'),
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: notice }],
      },
    });
    if (speak) this.requestResponse();
    return true;
  }

  truncatePlayback({ itemId, audioEndMs }) {
    if (!itemId || !Number.isFinite(audioEndMs)) return false;
    this.sendEvent({
      event_id: this._nextEventId('truncate'),
      type: 'conversation.item.truncate',
      item_id: itemId,
      content_index: 0,
      audio_end_ms: Math.max(0, Math.floor(audioEndMs)),
    });
    return true;
  }

  cancelResponse() {
    if (!this.responseActive) return false;
    this.sendEvent({ event_id: this._nextEventId('cancel'), type: 'response.cancel' });
    return true;
  }

  close(code = 1000, reason = 'call ended') {
    this.closedByClient = true;
    this.connected = false;
    if (!this.ws) return;
    const openState = this.WebSocketImpl.OPEN ?? WebSocket.OPEN;
    const connectingState = this.WebSocketImpl.CONNECTING ?? WebSocket.CONNECTING;
    if (this.ws.readyState === openState || this.ws.readyState === connectingState) {
      this.ws.close(code, reason);
    }
  }

  async _handleEvent(event) {
    this.emit('server_event', event);

    switch (event.type) {
      case 'session.created':
        this.sessionId = event.session?.id || null;
        this.emit('session.created', event.session || {});
        break;

      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true;
        this.emit('speech_started', event);
        break;

      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false;
        this.emit('speech_stopped', event);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) this.emit('user_transcript', event.transcript, event);
        break;

      case 'response.created':
        this.responseActive = true;
        this.emit('response.created', event.response || {});
        break;

      case 'response.output_audio.delta':
        if (event.delta) {
          this.emit('audio', {
            audio: Buffer.from(event.delta, 'base64'),
            itemId: event.item_id || null,
            responseId: event.response_id || null,
          });
        }
        break;

      case 'response.output_audio_transcript.delta': {
        const key = event.item_id || event.response_id || 'current';
        this.outputTranscripts.set(key, `${this.outputTranscripts.get(key) || ''}${event.delta || ''}`);
        break;
      }

      case 'response.output_audio_transcript.done': {
        const key = event.item_id || event.response_id || 'current';
        const transcript = event.transcript || this.outputTranscripts.get(key) || '';
        this.outputTranscripts.delete(key);
        if (transcript) this.emit('assistant_transcript', transcript, event);
        break;
      }

      case 'response.done':
        this.responseActive = false;
        await this._handleResponseDone(event.response || {});
        break;

      case 'error':
        this.emit('api_error', event.error || event);
        break;

      default:
        break;
    }
  }

  async _handleResponseDone(response) {
    const calls = (response.output || []).filter((item) => item?.type === 'function_call');
    if (calls.length > 0) {
      for (const call of calls) {
        await this._handleToolCall(call);
      }
      this.requestResponse();
      return;
    }

    this.emit('response.done', response);
    this._flushNotice();
  }

  async _handleToolCall(call) {
    const callId = call.call_id || call.id;
    if (!callId || this.handledToolCalls.has(callId)) return;
    this.handledToolCalls.add(callId);

    const args = parseArguments(call.arguments);
    let output;
    if (args._parse_error) {
      output = {
        success: false,
        code: 'INVALID_TOOL_ARGUMENTS',
        message: `The tool arguments were not valid JSON: ${args._parse_error}`,
      };
    } else if (typeof this.toolHandler !== 'function') {
      output = { success: false, code: 'TOOLS_UNAVAILABLE', message: 'Agent tools are unavailable.' };
    } else {
      try {
        output = await this.toolHandler(call.name, args, { callId, itemId: call.id || null });
      } catch (error) {
        output = { success: false, code: 'TOOL_ERROR', message: error.message };
      }
    }

    this.sendEvent({
      event_id: this._nextEventId('tool'),
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(output ?? null),
      },
    });
    this.emit('tool.completed', { call, output });
  }

  _flushNotice() {
    if (this.responseActive || this.userSpeaking || this.pendingNotices.length === 0) return;
    const pending = this.pendingNotices.splice(0);
    const content = pending.map((notice) => notice.content).join('\n');
    this.sendSystemNotice(content, {
      speak: pending.some((notice) => notice.speak),
      force: true,
    });
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  OpenAIRealtimeClient,
  PCM_SAMPLE_RATE,
  buildRealtimeTools,
  getRealtimeApiKey,
  parseArguments,
};
