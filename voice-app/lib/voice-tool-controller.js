'use strict';

const { URL } = require('node:url');

const EXPLICIT_PREFERENCE = /\b(?:remember|save|record|add\b.*\b(?:wishlist|list|preference)|i\s+(?:want|prefer)|please\s+(?:always|never)|from now on|should\s+(?:always|be|use|have))\b/i;

const WEATHER_CODES = Object.freeze({
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'foggy with frost', 51: 'light drizzle', 53: 'drizzle',
  55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'rain showers',
  81: 'rain showers', 82: 'heavy rain showers', 85: 'snow showers',
  86: 'heavy snow showers', 95: 'thunderstorms', 96: 'thunderstorms with hail',
  99: 'severe thunderstorms with hail',
});

function safeToolError(error) {
  return {
    success: false,
    code: error.code || 'TOOL_ERROR',
    message: error.message || 'The tool failed.',
  };
}

function voiceSafeSessionHistory(events) {
  return events.map((event) => ({
    id: event.id,
    role: event.role,
    kind: event.kind,
    text: event.content,
    at: event.created_at,
  }));
}

async function fetchJson(url, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'Teleagent/1.0 voice-weather' },
    signal: globalThis.AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Weather service returned ${response.status}`);
  return response.json();
}

async function getWeather(location, fetchImpl = globalThis.fetch) {
  const requested = String(location || '').trim();
  if (!requested) throw Object.assign(new Error('A weather location is required.'), { code: 'LOCATION_REQUIRED' });
  const geocodeUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
  geocodeUrl.searchParams.set('name', requested);
  geocodeUrl.searchParams.set('count', '1');
  geocodeUrl.searchParams.set('language', 'en');
  geocodeUrl.searchParams.set('format', 'json');
  const geocode = await fetchJson(geocodeUrl, fetchImpl);
  const place = geocode.results?.[0];
  if (!place) throw Object.assign(new Error(`I could not locate ${requested}.`), { code: 'LOCATION_NOT_FOUND' });

  const weatherUrl = new URL('https://api.open-meteo.com/v1/forecast');
  weatherUrl.searchParams.set('latitude', place.latitude);
  weatherUrl.searchParams.set('longitude', place.longitude);
  weatherUrl.searchParams.set('current', 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m');
  weatherUrl.searchParams.set('timezone', 'auto');
  const weather = await fetchJson(weatherUrl, fetchImpl);
  const current = weather.current || {};
  return {
    location: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
    observed_at: current.time || null,
    conditions: WEATHER_CODES[current.weather_code] || 'unknown conditions',
    temperature: current.temperature_2m,
    temperature_unit: weather.current_units?.temperature_2m || '°C',
    feels_like: current.apparent_temperature,
    wind_speed: current.wind_speed_10m,
    wind_unit: weather.current_units?.wind_speed_10m || 'km/h',
    source: 'Open-Meteo',
  };
}

class VoiceToolController {
  constructor({
    stateStore,
    jobBroker,
    agentBridge,
    voiceThreadId,
    realtimeSessionId,
    callerId,
    fetchImpl = globalThis.fetch,
  }) {
    this.stateStore = stateStore;
    this.jobBroker = jobBroker;
    this.agentBridge = agentBridge;
    this.voiceThreadId = voiceThreadId;
    this.realtimeSessionId = realtimeSessionId;
    this.callerId = callerId;
    this.fetchImpl = fetchImpl;
    this.agentHistoryContinuation = null;
    this.targetBindings = new Map();
  }

  async _inspect(action, args = {}) {
    const response = await this.agentBridge.inspectOperator(action, args);
    if (!response.success) {
      throw Object.assign(new Error(response.error || 'Operator inspection failed.'), { code: response.code });
    }
    const result = { success: true, ...response.result };
    this._rememberTargetBindings(result, args.target || null);
    return result;
  }

  _rememberTargetBindings(result, requestedTarget = null) {
    const remember = (entry, alias = null) => {
      const stableTarget = entry?.stable_target;
      if (!stableTarget) return;
      const binding = {
        stableTarget,
        canonicalTarget: entry.target || null,
        namedTarget: entry.named_target || null,
        conversationName: entry.conversation_name || null,
      };
      for (const key of [alias, entry.target, entry.named_target, stableTarget]) {
        const normalized = String(key || '').trim();
        if (normalized) this.targetBindings.set(normalized, binding);
      }
    };

    remember(result, requestedTarget);
    for (const session of result?.sessions || []) {
      for (const window of session.windows || []) {
        for (const pane of window.panes || []) {
          remember({
            ...pane,
            conversation_name: window.name || null,
          });
        }
      }
    }
  }

  _stableTarget(target) {
    const requested = String(target || '').trim();
    return this.targetBindings.get(requested)?.stableTarget || requested;
  }

  _latestMessageRole(requestedRole) {
    const latestCallerTurn = this.stateStore.getLatestUserEvent(this.voiceThreadId)?.content || '';
    if (/\b(?:my|i|we)\b.{0,30}\b(?:sent|said|asked|wrote|typed|submitted|told)\b|\b(?:message|prompt)\s+i\s+sent\b/i.test(latestCallerTurn)) {
      return 'user';
    }
    if (/\b(?:you|codex|claude|agent|assistant)\b.{0,30}\b(?:reply|replied|respond|responded|say|said|answer|answered|write|wrote)\b|\b(?:codex|claude|agent|assistant)(?:'s)?\s+(?:reply|response|answer|message)\b/i.test(latestCallerTurn)) {
      return 'assistant';
    }
    return requestedRole || 'assistant';
  }

  _rememberHistoryContinuation(history, target, limit) {
    const chunk = history?.chunk || {};
    if (chunk.direction === 'backward' && chunk.has_older && chunk.previous_cursor) {
      this.agentHistoryContinuation = {
        target,
        cursor: chunk.previous_cursor,
        limit,
        position: 'before',
        role: chunk.role || 'any',
      };
      return;
    }
    if (chunk.direction === 'forward' && chunk.has_newer && chunk.next_cursor) {
      this.agentHistoryContinuation = {
        target,
        cursor: chunk.next_cursor,
        limit,
        position: 'after',
        role: chunk.role || 'any',
      };
      return;
    }
    this.agentHistoryContinuation = null;
  }

  async handle(name, args, context) {
    try {
      switch (name) {
        case 'send_agent_message':
        case 'start_agent_task':
          return this.jobBroker.startAgentTask({
            voiceThreadId: this.voiceThreadId,
            realtimeSessionId: this.realtimeSessionId,
            toolCallId: context.callId,
            profile: args.profile || 'auto',
            request: args.request,
            freshSession: Boolean(args.fresh_session),
            notificationMode: args.notify_when_complete || 'in_call',
          });

        case 'handoff_agent_session':
          return this.jobBroker.handoffAgentTask({
            voiceThreadId: this.voiceThreadId,
            realtimeSessionId: this.realtimeSessionId,
            toolCallId: context.callId,
            fromProfile: args.from_profile,
            toProfile: args.to_profile,
            objective: args.objective,
            freshSession: Boolean(args.fresh_session),
            notificationMode: args.notify_when_complete || 'in_call',
          });

        case 'send_agent_session_message':
          {
            const requestedTarget = args.target;
            const result = await this.jobBroker.startTargetedSessionTask({
              voiceThreadId: this.voiceThreadId,
              realtimeSessionId: this.realtimeSessionId,
              toolCallId: context.callId,
              target: this._stableTarget(requestedTarget),
              message: args.message,
              notificationMode: args.notify_when_complete || 'in_call',
            });
            this._rememberTargetBindings(result, requestedTarget);
            return result;
          }

        case 'get_agent_task':
          return this.jobBroker.getAgentTask(this.voiceThreadId, args.job_id);
        case 'cancel_agent_task':
          return {
            canceled: false,
            code: 'DTMF_STAR_REQUIRED',
            message: 'For safety, press star to cancel the focused operation. Voice alone cannot cancel it.',
          };
        case 'list_agent_tasks':
          return this.jobBroker.listAgentTasks(this.voiceThreadId, { activeOnly: Boolean(args.active_only) });
        case 'list_agent_sessions':
          return {
            ...this.jobBroker.listAgentSessions(this.voiceThreadId),
            profiles: this.jobBroker.listProfileDetails(),
          };
        case 'list_runtime_sessions': {
          const tmux = await this._inspect('list_tmux_sessions', {
            session: args.session || null,
          });
          return {
            success: true,
            managed: {
              ...this.jobBroker.listAgentSessions(this.voiceThreadId),
              profiles: this.jobBroker.listProfileDetails(),
              meaning: 'Teleagent-managed durable provider sessions for this voice thread.',
            },
            tmux: {
              ...tmux,
              meaning: 'Live tmux-attached processes on Hermes; process mapping is authoritative even when pane text looks idle.',
            },
          };
        }

        case 'get_voice_history': {
          const role = args.user_only ? 'user' : (args.role || null);
          const events = this.stateStore.listCallerEvents(this.callerId, {
            limit: Math.max(1, Math.min(Number.parseInt(args.limit, 10) || 20, 50)),
            role,
          });
          return { success: true, events: voiceSafeSessionHistory(events), audio_recorded: false };
        }

        case 'get_voice_usage':
          return {
            success: true,
            usage: this.stateStore.getRealtimeUsageSummary({ threadId: this.voiceThreadId }),
            budget_remaining: null,
            budget_note: 'Measured usage is available locally. Remaining project budget must be checked in the OpenAI usage dashboard because this service has no organization billing credential.',
          };

        case 'list_preferences':
          return {
            success: true,
            preferences: this.stateStore.listPreferences(this.callerId).map((entry) => ({
              key: entry.preference_key,
              value: entry.value,
              updated_at: entry.updated_at,
            })),
          };

        case 'remember_preference': {
          const latest = this.stateStore.getLatestUserEvent(this.voiceThreadId);
          if (!latest || !EXPLICIT_PREFERENCE.test(latest.content)) {
            return {
              success: false,
              code: 'EXPLICIT_CONFIRMATION_REQUIRED',
              message: 'Ask the caller to state this as a preference or explicitly ask to remember it.',
            };
          }
          const preference = this.stateStore.setPreference({
            callerId: this.callerId,
            key: args.key,
            value: args.value,
            sourceText: latest.content,
          });
          this.stateStore.appendAuditEvent({
            voiceThreadId: this.voiceThreadId,
            realtimeSessionId: this.realtimeSessionId,
            callerId: this.callerId,
            action: 'preference_saved',
            riskLevel: 'read_only',
            scopeText: `${preference.preference_key}: ${JSON.stringify(preference.value)}`,
          });
          return { success: true, key: preference.preference_key, value: preference.value };
        }

        case 'forget_preference':
          return { success: true, deleted: this.stateStore.deletePreference(this.callerId, args.key) };

        case 'describe_runtime': {
          const runtime = await this._inspect('describe_runtime');
          return {
            ...runtime,
            voice_runtime: 'Teleagent voice-app on Hermes',
            transcript_storage: 'Local append-only SQLite text events; raw audio is not recorded.',
            profiles: this.jobBroker.listProfileDetails(),
            emergency_controls: { pound: 'approve focused operation', star: 'cancel focused job', nine: 'global emergency stop' },
          };
        }
        case 'get_homelab_status': return this._inspect('homelab_status');
        case 'list_directory': return this._inspect('list_directory', {
          ...args,
          limit: Math.max(1, Math.min(Number.parseInt(args.limit, 10) || 80, 200)),
        });
        case 'read_text_file': return this._inspect('read_text_file', {
          ...args,
          max_bytes: Math.max(256, Math.min(Number.parseInt(args.max_bytes, 10) || 12000, 12000)),
        });
        case 'find_files': return this._inspect('find_files', {
          ...args,
          limit: Math.max(1, Math.min(Number.parseInt(args.limit, 10) || 50, 50)),
        });
        case 'git_status': return this._inspect('git_status', args);
        case 'list_tmux_sessions': return this._inspect('list_tmux_sessions', args);
        case 'inspect_tmux_pane': return this._inspect('inspect_tmux_pane', {
          ...args,
          lines: Math.max(10, Math.min(Number.parseInt(args.lines, 10) || 40, 120)),
        });
        case 'inspect_agent_session_history': {
          const limit = Math.max(1, Math.min(Number.parseInt(args.limit, 10) || 6, 12));
          const target = this._stableTarget(args.target);
          const history = await this._inspect('inspect_agent_session_history', {
            target,
            cursor: Math.max(0, Math.min(Number.parseInt(args.cursor, 10) || 0, 100000)),
            limit,
            position: args.position || 'latest',
            role: args.role || 'any',
          });
          this._rememberHistoryContinuation(history, history.stable_target || target, limit);
          return history;
        }
        case 'get_latest_agent_session_message': {
          const role = this._latestMessageRole(args.role);
          const target = this._stableTarget(args.target);
          const history = await this._inspect('inspect_agent_session_history', {
            target,
            cursor: 0,
            limit: 1,
            position: 'latest',
            role,
          });
          this._rememberHistoryContinuation(history, history.stable_target || target, 1);
          return {
            ...history,
            latest_message: history.messages?.[0] || null,
          };
        }
        case 'continue_agent_session_history': {
          if (!this.agentHistoryContinuation) {
            return {
              success: false,
              code: 'NO_HISTORY_CONTINUATION',
              message: 'There is no remaining provider-history chunk. Inspect a Codex or Claude tmux pane first.',
            };
          }
          const continuation = { ...this.agentHistoryContinuation };
          const history = await this._inspect('inspect_agent_session_history', continuation);
          this._rememberHistoryContinuation(history, continuation.target, continuation.limit);
          return history;
        }

        case 'adopt_tmux_context': {
          const inspection = await this._inspect('inspect_tmux_pane', {
            target: args.target,
            lines: Math.max(10, Math.min(Number.parseInt(args.lines, 10) || 40, 120)),
          });
          const request = `[ADOPTED TMUX CONTEXT]\n` +
            `Tmux target: ${inspection.target}\n` +
            `This is a sanitized context handoff, not native provider-session continuation.\n` +
            `${inspection.content}\n` +
            `[END ADOPTED TMUX CONTEXT]\n\n` +
            `Objective: ${String(args.objective || 'Inspect the current state and continue safely').slice(0, 1200)}`;
          return this.jobBroker.startAgentTask({
            voiceThreadId: this.voiceThreadId,
            realtimeSessionId: this.realtimeSessionId,
            toolCallId: context.callId,
            profile: args.profile || 'auto',
            request,
            freshSession: Boolean(args.fresh_session),
            notificationMode: args.notify_when_complete || 'in_call',
          });
        }

        case 'get_weather':
          return { success: true, weather: await getWeather(args.location, this.fetchImpl) };

        case 'end_call':
          return {
            success: true,
            end_call: true,
            response_behavior: 'farewell_then_hangup',
            message: 'Say one brief goodbye now. Do not ask another question.',
          };

        default:
          return { success: false, code: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` };
      }
    } catch (error) {
      return safeToolError(error);
    }
  }
}

module.exports = {
  EXPLICIT_PREFERENCE,
  VoiceToolController,
  getWeather,
  safeToolError,
};
