'use strict';

const { EventEmitter } = require('node:events');
const { URL } = require('node:url');
const WebSocket = require('ws');

const DEFAULT_BASE_URL = 'wss://api.openai.com/v1/realtime';
const DEFAULT_MODEL = 'gpt-realtime-2.1-mini';
const DEFAULT_VOICE = 'marin';
const PCM_SAMPLE_RATE = 24000;
const NON_TOOL_RESPONSE_PURPOSES = new Set([
  'approval_prompt',
  'farewell',
  'job_status',
  'system_notice',
]);

function responseMaySelectTool(purpose) {
  const value = String(purpose || '');
  if (!value || value.startsWith('notice:')) return false;
  return !NON_TOOL_RESPONSE_PURPOSES.has(value);
}

function getRealtimeApiKey(environment = process.env) {
  return String(environment.OPENAI_REALTIME_API_KEY || '').trim();
}

function buildRealtimeTools(profiles) {
  const profileEnum = ['auto', ...profiles];
  const taskProperties = {
    profile: {
      type: 'string',
      enum: profileEnum,
      description: 'Use an exact profile when the caller names one; otherwise use auto for capability-based routing.',
    },
    request: {
      type: 'string',
      description: 'The caller’s concrete objective, relevant paths, constraints, and desired validation. Preserve requested scope exactly.',
    },
    fresh_session: {
      type: 'boolean',
      description: 'False continues this profile’s durable managed session. True deliberately replaces it with a fresh provider session.',
    },
    notify_when_complete: {
      type: 'string',
      enum: ['in_call', 'callback', 'resume'],
      description: 'How to deliver the eventual result. Defaults to in_call.',
    },
  };
  return [
    {
      type: 'function',
      name: 'send_agent_message',
      description: 'Silently route a message to a Teleagent-managed Claude Code or Codex profile session as the first output item. Never use this for an existing tmux pane, named tmux window, or the current Codex/Claude thread; use send_agent_session_message for those.',
      parameters: {
        type: 'object',
        properties: taskProperties,
        required: ['request'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'send_agent_session_message',
      description: 'Send one exact message to the Codex or Claude provider session already attached to an exact tmux target. This always requires pound approval and reports success only after provider history verifies both delivery and the final response.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Use the stable_target returned by tmux/history tools whenever available; otherwise use an exact named target such as main:phone.',
          },
          message: {
            type: 'string',
            maxLength: 4000,
            description: 'The exact instruction or question to deliver to that existing provider conversation.',
          },
          notify_when_complete: {
            type: 'string',
            enum: ['in_call', 'callback', 'resume'],
          },
        },
        required: ['target', 'message'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'handoff_agent_session',
      description: 'Explicitly hand recent managed work from one Claude/Codex profile to a different profile using a structured brief.',
      parameters: {
        type: 'object',
        properties: {
          from_profile: { type: 'string', enum: profiles },
          to_profile: { type: 'string', enum: profiles },
          objective: { type: 'string' },
          fresh_session: { type: 'boolean' },
          notify_when_complete: { type: 'string', enum: ['in_call', 'callback', 'resume'] },
        },
        required: ['from_profile', 'to_profile', 'objective'],
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
    {
      type: 'function',
      name: 'list_agent_sessions',
      description: 'List only the six Teleagent-managed Claude/Codex profile sessions in this voice thread. This does not inspect arbitrary tmux-attached provider sessions and does not expose provider session IDs.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      type: 'function',
      name: 'list_runtime_sessions',
      description: 'List both namespaces together: Teleagent-managed profile sessions and live tmux-attached Codex/Claude processes. Use this whenever the caller says sessions without clearly naming one namespace.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Optional exact tmux session filter, such as main.' },
        },
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'get_voice_history',
      description: 'Read exact Teleagent phone-call transcript events from local SQLite. This is voice-call history only, never Codex or Claude provider-session history.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          role: { type: 'string', enum: ['user', 'assistant', 'tool'] },
          user_only: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'get_voice_usage',
      description: 'Report locally measured Realtime and transcription token usage for this durable voice thread, including cached tokens. This cannot read the OpenAI dashboard budget cap.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      type: 'function',
      name: 'list_preferences',
      description: 'List the caller’s explicitly saved durable preferences and wishlist items.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      type: 'function',
      name: 'remember_preference',
      description: 'Save a preference only after the caller explicitly states it as a preference or asks for it to be remembered. Never infer a preference from a question.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' }, value: { type: 'string' } },
        required: ['key', 'value'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'forget_preference',
      description: 'Delete one explicitly named durable preference.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'describe_runtime',
      description: 'Return authoritative Teleagent, Hermes, profile, transcript, emergency-control, and bounded inspection capabilities.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      type: 'function',
      name: 'get_homelab_status',
      description: 'Run a fixed read-only Hermes and k3s health snapshot without launching an agent.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      type: 'function',
      name: 'list_directory',
      description: 'List a directory through the bounded read-only Hermes inspector. Protected credential paths are denied.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'read_text_file',
      description: 'Read a small text file through the bounded read-only Hermes inspector. Secrets, credentials, binary files, and oversized output are denied or clipped.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, max_bytes: { type: 'integer', minimum: 256, maximum: 12000 } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'find_files',
      description: 'Find filenames below an approved Hermes root without launching an agent.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }, query: { type: 'string' },
          max_depth: { type: 'integer', minimum: 0, maximum: 8 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['path', 'query'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'git_status',
      description: 'Read Git branch and working-tree status for a repository below an approved Hermes root.',
      parameters: {
        type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'list_tmux_sessions',
      description: 'List a compact hierarchy: tmux sessions contain windows, and windows contain panes. Claude/Codex descendants are mapped to the owning pane. Optionally restrict to one exact session.',
      parameters: {
        type: 'object',
        properties: { session: { type: 'string', description: 'Optional exact tmux session name, such as main.' } },
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'inspect_tmux_pane',
      description: 'Read a bounded, redacted tail of one tmux pane. This is visibility only and is not provider-native continuation.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string' }, lines: { type: 'integer', minimum: 10, maximum: 120 } },
        required: ['target'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'inspect_agent_session_history',
      description: 'Read an exact, redacted, numbered chunk from the Codex or Claude provider session attached to one tmux pane. Defaults to the latest messages. This is not Teleagent phone history.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Exact tmux pane target, such as main:5.1 or main:phone.' },
          cursor: { type: 'integer', minimum: 0, maximum: 100000 },
          limit: { type: 'integer', minimum: 1, maximum: 12 },
          position: {
            type: 'string',
            enum: ['start', 'after', 'latest', 'before'],
            description: 'Use latest for the tail, before with a cursor for older messages, or start/after for forward reading.',
          },
          role: {
            type: 'string',
            enum: ['any', 'user', 'assistant'],
            description: 'Optional provider-message role filter.',
          },
        },
        required: ['target'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'get_latest_agent_session_message',
      description: 'Return the actual latest provider message of one role from an exact tmux-attached Codex or Claude conversation. For “I sent/said/wrote,” use role user; for what Codex or Claude replied, use assistant.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Exact tmux target, such as main:phone or main:5.1.' },
          role: {
            type: 'string',
            enum: ['any', 'user', 'assistant'],
            description: 'Use user for the caller’s message and assistant for the provider’s reply.',
          },
        },
        required: ['target'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'continue_agent_session_history',
      description: 'Read the next numbered provider-history chunk after inspect_agent_session_history. Use when the caller says next, continue, or asks for the rest.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      type: 'function',
      name: 'adopt_tmux_context',
      description: 'Capture sanitized tmux pane context and explicitly hand it to a managed agent profile. This does not pretend to resume an unknown provider session.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string' }, profile: { type: 'string', enum: profileEnum },
          objective: { type: 'string' }, lines: { type: 'integer', minimum: 10, maximum: 120 },
          fresh_session: { type: 'boolean' },
          notify_when_complete: { type: 'string', enum: ['in_call', 'callback', 'resume'] },
        },
        required: ['target', 'objective'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'get_weather',
      description: 'Get current weather for a named place from the bounded read-only weather service.',
      parameters: {
        type: 'object', properties: { location: { type: 'string' } }, required: ['location'], additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'end_call',
      description: 'End the SIP call after one brief farewell when the caller says goodbye, asks to hang up, or says they are done.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
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
    transcriptionPrompt = 'A private operator call about Teleagent on the phone through Linphone, Hermes, a homelab, repositories, the main tmux session, windows, panes, Claude Code, Codex, Kubernetes, and infrastructure.',
    transcriptionKeywords = [
      'Hermes', 'Teleagent', 'homelab', 'tmux', 'Claude Code', 'Codex',
      'Haiku', 'Sonnet', 'Opus', 'Luna', 'Terra', 'Sol', 'Kubernetes',
      'phone', 'Linphone', 'main', 'window', 'pane', 'phone-infra', 'FreeSWITCH', 'drachtio',
    ],
    transcriptionLanguages = ['en'],
    transcriptionDelay = 'medium',
    instructions,
    profiles = [],
    safetyIdentifier = null,
    organization = null,
    project = null,
    connectTimeoutMs = 15000,
    maxSpokenWords = 45,
    hardMaxSpokenWords = null,
    contextTokenLimit = 16000,
    contextRetentionRatio = 0.8,
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
    this.transcriptionPrompt = transcriptionPrompt;
    this.transcriptionKeywords = transcriptionKeywords;
    this.transcriptionLanguages = transcriptionLanguages;
    this.transcriptionDelay = transcriptionDelay;
    this.instructions = instructions;
    this.profiles = profiles;
    this.safetyIdentifier = safetyIdentifier;
    this.organization = organization;
    this.project = project;
    this.connectTimeoutMs = connectTimeoutMs;
    this.maxSpokenWords = Math.max(10, Number.parseInt(maxSpokenWords, 10) || 45);
    this.hardMaxSpokenWords = Math.max(
      this.maxSpokenWords + 1,
      Number.parseInt(hardMaxSpokenWords, 10) || this.maxSpokenWords * 2
    );
    this.contextTokenLimit = Math.max(4096, Number.parseInt(contextTokenLimit, 10) || 16000);
    const retentionRatio = Number.parseFloat(contextRetentionRatio);
    this.contextRetentionRatio = Number.isFinite(retentionRatio)
      ? Math.max(0.5, Math.min(retentionRatio, 1))
      : 0.8;
    this.toolHandler = toolHandler;
    this.WebSocketImpl = WebSocketImpl;

    this.ws = null;
    this.sessionId = null;
    this.connected = false;
    this.closedByClient = false;
    this.responseActive = false;
    this.cancelPending = false;
    this.userSpeaking = false;
    this.pendingNotices = [];
    this.pendingUserResponse = false;
    this.activeResponsePurpose = null;
    this.nextResponsePurpose = null;
    this.handledToolCalls = new Set();
    this.outputTranscripts = new Map();
    this.clippedResponses = new Set();
    this.limitedResponseIds = new Set();
    this.suppressedResponseIds = new Set();
    this.bufferedResponseAudio = new Map();
    this.bufferedAssistantTranscripts = new Map();
    this.activeResponseId = null;
    this.eventSequence = 0;
  }

  _responseKey(event = {}) {
    return event.response_id || event.response?.id || this.activeResponseId || 'current';
  }

  _bufferAudio(event, audio) {
    const responseId = this._responseKey(event);
    if (this.suppressedResponseIds.has(responseId)) return;
    const chunks = this.bufferedResponseAudio.get(responseId) || [];
    chunks.push({
      audio,
      itemId: event.item_id || null,
      responseId: event.response_id || this.activeResponseId || null,
    });
    this.bufferedResponseAudio.set(responseId, chunks);
  }

  _bufferAssistantTranscript(event, transcript) {
    const responseId = this._responseKey(event);
    if (this.suppressedResponseIds.has(responseId)) return;
    const transcripts = this.bufferedAssistantTranscripts.get(responseId) || [];
    transcripts.push({ transcript, event });
    this.bufferedAssistantTranscripts.set(responseId, transcripts);
  }

  _discardBufferedResponse(responseId, reason, { markSuppressed = false, toolCalls = 0 } = {}) {
    if (!responseId) return;
    const audio = this.bufferedResponseAudio.get(responseId) || [];
    const transcripts = this.bufferedAssistantTranscripts.get(responseId) || [];
    const audioBytes = audio.reduce((total, entry) => total + entry.audio.length, 0);
    this.bufferedResponseAudio.delete(responseId);
    this.bufferedAssistantTranscripts.delete(responseId);
    if (markSuppressed) this.suppressedResponseIds.add(responseId);
    if (audioBytes > 0 || transcripts.length > 0) {
      this.emit('response.output_suppressed', {
        responseId,
        reason,
        audioBytes,
        transcriptCount: transcripts.length,
        toolCalls,
      });
    }
  }

  _finalizeBufferedResponse(response = {}) {
    const responseId = response.id || this.activeResponseId || 'current';
    const calls = (response.output || []).filter((item) => item?.type === 'function_call');
    const status = String(response.status || 'completed');
    const wasLimited = this.limitedResponseIds.has(responseId);
    const wasSuppressed = this.suppressedResponseIds.has(responseId);
    const shouldDiscard = calls.length > 0 || wasSuppressed || (
      ['cancelled', 'failed', 'incomplete'].includes(status) && !wasLimited
    );

    if (shouldDiscard) {
      this._discardBufferedResponse(
        responseId,
        calls.length > 0 ? 'tool_selection' : (wasSuppressed ? 'caller_interrupt' : status),
        { toolCalls: calls.length }
      );
    } else {
      for (const output of this.bufferedResponseAudio.get(responseId) || []) {
        this.emit('audio', output);
      }
      for (const output of this.bufferedAssistantTranscripts.get(responseId) || []) {
        this.emit('assistant_transcript', output.transcript, output.event);
      }
      this.bufferedResponseAudio.delete(responseId);
      this.bufferedAssistantTranscripts.delete(responseId);
    }

    this.limitedResponseIds.delete(responseId);
    this.suppressedResponseIds.delete(responseId);
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
        type: 'semantic_vad',
        eagerness: 'low',
        create_response: false,
        // Teleagent classifies the completed transcript before deciding
        // whether caller audio is a real barge-in or a harmless backchannel.
        interrupt_response: false,
      },
    };
    if (this.transcriptionModel) {
      input.transcription = {
        model: this.transcriptionModel,
        prompt: this.transcriptionPrompt,
        keywords: this.transcriptionKeywords,
        languages: this.transcriptionLanguages,
        delay: this.transcriptionDelay,
      };
    }

    this.sendEvent({
      event_id: this._nextEventId('session'),
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this.model,
        output_modalities: ['audio'],
        instructions: this.instructions,
        truncation: {
          type: 'retention_ratio',
          retention_ratio: this.contextRetentionRatio,
          token_limits: { post_instructions: this.contextTokenLimit },
        },
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

  requestResponse(response = undefined, { purpose = 'general' } = {}) {
    if (this.responseActive) return false;
    const event = {
      event_id: this._nextEventId('response'),
      type: 'response.create',
    };
    if (response) event.response = response;
    this.responseActive = true;
    this.nextResponsePurpose = purpose;
    this.sendEvent(event);
    return true;
  }

  queueUserResponse({ purpose = 'user_turn' } = {}) {
    if (this.responseActive || this.userSpeaking) {
      this.pendingUserResponse = true;
      return false;
    }
    this.pendingUserResponse = false;
    return this.requestResponse(undefined, { purpose });
  }

  discardPendingUserResponse() {
    this.pendingUserResponse = false;
  }

  sendSystemNotice(content, {
    speak = true,
    force = false,
    key = null,
    priority = 0,
    supersedePurposes = [],
  } = {}) {
    const notice = String(content || '').trim();
    if (!notice) return false;
    if (this.responseActive && supersedePurposes.includes(this.activeResponsePurpose)) {
      this.cancelResponse();
    }
    if (!force && (this.responseActive || this.userSpeaking)) {
      const record = { content: notice, speak, key, priority };
      const existingIndex = key
        ? this.pendingNotices.findIndex((entry) => entry.key === key)
        : -1;
      if (existingIndex >= 0) this.pendingNotices.splice(existingIndex, 1, record);
      else this.pendingNotices.push(record);
      return false;
    }

    if (speak) {
      this.requestResponse({
        tool_choice: 'none',
        instructions: `One-time voice instruction. Follow it for this response only, then discard it: ${notice}`,
      }, { purpose: key ? `notice:${key}` : 'system_notice' });
    }
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
    if (!this.responseActive || this.cancelPending) return false;
    this.cancelPending = true;
    this.sendEvent({ event_id: this._nextEventId('cancel'), type: 'response.cancel' });
    return true;
  }

  close(code = 1000, reason = 'call ended') {
    this.closedByClient = true;
    this.connected = false;
    this.cancelPending = false;
    this.bufferedResponseAudio.clear();
    this.bufferedAssistantTranscripts.clear();
    this.limitedResponseIds.clear();
    this.suppressedResponseIds.clear();
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
        if (event.usage) {
          this.emit('usage', {
            kind: 'transcription',
            eventKey: `transcription:${event.event_id || `${event.item_id || 'unknown'}:${event.content_index || 0}`}`,
            model: this.transcriptionModel,
            usage: event.usage,
          });
        }
        if (event.transcript) this.emit('user_transcript', event.transcript, event);
        else this.emit('transcription.empty', event);
        break;

      case 'response.created':
        this.responseActive = true;
        this.cancelPending = false;
        this.activeResponsePurpose = this.nextResponsePurpose || this.activeResponsePurpose || 'server';
        this.nextResponsePurpose = null;
        this.activeResponseId = event.response?.id || null;
        this.emit('response.created', event.response || {});
        break;

      case 'response.output_audio.delta':
        if (event.delta) {
          const audio = Buffer.from(event.delta, 'base64');
          if (responseMaySelectTool(this.activeResponsePurpose)) this._bufferAudio(event, audio);
          else {
            this.emit('audio', {
              audio,
              itemId: event.item_id || null,
              responseId: event.response_id || null,
            });
          }
        }
        break;

      case 'response.output_audio_transcript.delta': {
        const key = event.item_id || event.response_id || 'current';
        const transcript = `${this.outputTranscripts.get(key) || ''}${event.delta || ''}`;
        this.outputTranscripts.set(key, transcript);
        const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
        const endsSentence = /[.!?](?:["')\]]+)?\s*$/.test(transcript);
        const mode = wordCount > this.hardMaxSpokenWords && endsSentence
          ? 'hard_sentence_boundary'
          : (wordCount > this.hardMaxSpokenWords * 2 ? 'absolute_hard_limit' : null);
        if (mode && !this.clippedResponses.has(key) && this.cancelResponse()) {
          this.clippedResponses.add(key);
          this.limitedResponseIds.add(this._responseKey(event));
          this.emit('response.clipped', {
            itemId: event.item_id || null,
            responseId: event.response_id || null,
            wordCount,
            softLimit: this.maxSpokenWords,
            hardLimit: this.hardMaxSpokenWords,
            mode,
          });
        }
        break;
      }

      case 'response.output_audio_transcript.done': {
        const key = event.item_id || event.response_id || 'current';
        const transcript = event.transcript || this.outputTranscripts.get(key) || '';
        this.outputTranscripts.delete(key);
        this.clippedResponses.delete(key);
        if (transcript) {
          if (responseMaySelectTool(this.activeResponsePurpose)) {
            this._bufferAssistantTranscript(event, transcript);
          } else {
            this.emit('assistant_transcript', transcript, event);
          }
        }
        break;
      }

      case 'response.done':
        this._finalizeBufferedResponse(event.response || {});
        this.responseActive = false;
        this.cancelPending = false;
        if (event.response?.usage) {
          this.emit('usage', {
            kind: 'response',
            eventKey: `response:${event.response.id || event.event_id || this._nextEventId('usage')}`,
            model: this.model,
            usage: event.response.usage,
          });
        }
        {
          const completedPurpose = this.activeResponsePurpose;
          this.activeResponsePurpose = null;
          this.activeResponseId = null;
          await this._handleResponseDone(event.response || {}, completedPurpose);
        }
        break;

      case 'conversation.item.truncated':
        this.emit('context.truncated', event);
        break;

      case 'conversation.item.deleted':
        this.emit('context.item_deleted', event);
        break;

      case 'error': {
        const error = event.error || event;
        if (error.code === 'response_cancel_not_active') {
          this.responseActive = false;
          this.cancelPending = false;
          this.emit('cancel_race', error);
          break;
        }
        this.emit('api_error', error);
        break;
      }

      default:
        break;
    }
  }

  async _handleResponseDone(response, purpose = null) {
    const calls = (response.output || []).filter((item) => item?.type === 'function_call');
    if (calls.length > 0) {
      const outputs = [];
      for (const call of calls) {
        const output = await this._handleToolCall(call);
        if (output) outputs.push(output);
      }
      const behaviors = outputs.map((output) => output.response_behavior).filter(Boolean);
      if (behaviors.includes('earcon_then_quiet') && outputs.every((output) => (
        output.response_behavior === 'earcon_then_quiet'
      ))) {
        this.emit('tools.silent', { calls, outputs });
        this._flushNotice();
        if (!this.responseActive && !this.userSpeaking && this.pendingUserResponse) {
          this.pendingUserResponse = false;
          this.requestResponse(undefined, { purpose: 'queued_user_turn' });
        }
        return;
      }
      const reportsPendingJob = outputs.some((output) => (
        ['awaiting_approval', 'queued', 'running'].includes(output?.job?.status) ||
        output?.jobs?.some?.((job) => ['awaiting_approval', 'queued', 'running'].includes(job.status))
      ));
      const nextPurpose = behaviors.includes('farewell_then_hangup')
        ? 'farewell'
        : (behaviors.includes('approval_prompt')
          ? 'approval_prompt'
          : (reportsPendingJob ? 'job_status' : 'tool_result'));
      if (nextPurpose === 'approval_prompt') {
        const prompt = outputs.find((output) => output?.spoken_approval_prompt)?.spoken_approval_prompt ||
          'Approval is required. Press pound to approve or star to cancel.';
        this.requestResponse({
          tool_choice: 'none',
          instructions: `Say exactly the following approval prompt and nothing else: ${JSON.stringify(prompt)}`,
        }, { purpose: nextPurpose });
      } else {
        this.requestResponse(undefined, { purpose: nextPurpose });
      }
      return;
    }

    this.emit('response.done', response, { purpose });
    this._flushNotice();
    if (!this.responseActive && !this.userSpeaking && this.pendingUserResponse) {
      this.pendingUserResponse = false;
      this.requestResponse(undefined, { purpose: 'queued_user_turn' });
    }
  }

  async _handleToolCall(call) {
    const callId = call.call_id || call.id;
    if (!callId || this.handledToolCalls.has(callId)) return null;
    this.handledToolCalls.add(callId);

    const args = parseArguments(call.arguments);
    const startedAt = Date.now();
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
    this.emit('tool.completed', { call, args, output, durationMs: Date.now() - startedAt });
    return output;
  }

  _flushNotice() {
    if (this.responseActive || this.userSpeaking || this.pendingNotices.length === 0) return;
    const pending = this.pendingNotices.splice(0).sort((left, right) => right.priority - left.priority);
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
  responseMaySelectTool,
};
