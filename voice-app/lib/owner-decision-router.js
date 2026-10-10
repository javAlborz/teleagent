'use strict';

const https = require('node:https');
const { realtimeWebSocketOptions } = require('./voice-egress-transport');

const OWNER_DECISION_MODEL = 'gpt-6-luna';
const MAX_BODY_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

// A text-only decision call; it has no provider/session tools. The returned
// route still passes the voice client's provenance, revision and native gates.
class OwnerDecisionRouter {
  constructor({apiKey, project, organization, request = https.request,
    connectionOptions = realtimeWebSocketOptions, timeoutMs = 25000} = {}) {
    this.apiKey = apiKey;
    this.project = project;
    this.organization = organization;
    this.request = request;
    this.connectionOptions = connectionOptions;
    this.timeoutMs = timeoutMs;
  }

  decide(response, {signal} = {}) {
    const tool = response.tools?.[0];
    if (tool?.name !== 'route_turn' || typeof this.apiKey !== 'string' || !this.apiKey) {
      return Promise.reject(new Error('OWNER_DECISION_CONFIG'));
    }
    const body = Buffer.from(JSON.stringify({
      model: OWNER_DECISION_MODEL, store: false,
      instructions: response.instructions, input: response.input,
      tools: [{type: 'function', name: tool.name, description: tool.description,
        parameters: tool.parameters, strict: false}],
      tool_choice: {type: 'function', name: tool.name}, parallel_tool_calls: false,
      reasoning: {effort: 'medium'}, max_output_tokens: 8000,
    }));
    if (body.length > MAX_BODY_BYTES) return Promise.reject(new Error('OWNER_DECISION_CONTEXT_TOO_LARGE'));
    const agent = new https.Agent({keepAlive: false, maxSockets: 1, maxTotalSockets: 1});
    try {
      const connect = this.connectionOptions().createConnection;
      if (typeof connect !== 'function') throw new Error('missing admitted connector');
      agent.createConnection = connect;
    }
    catch { agent.destroy(); return Promise.reject(new Error('OWNER_DECISION_EGRESS_UNAVAILABLE')); }
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, result) => {
        clearTimeout(timer); agent.destroy();
        if (error) reject(error); else resolve(result);
      };
      const req = this.request({
        hostname: 'api.openai.com', port: 443, path: '/v1/responses', method: 'POST', agent, signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'Content-Length': body.length,
          ...(this.project ? {'OpenAI-Project': this.project} : {}),
          ...(this.organization ? {'OpenAI-Organization': this.organization} : {}),
        },
      }, res => {
        let bytes = 0; const chunks = [];
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) req.destroy(new Error('OWNER_DECISION_RESPONSE_TOO_LARGE'));
          else chunks.push(chunk);
        });
        res.on('error', () => finish(new Error('OWNER_DECISION_RESPONSE_FAILED')));
        res.on('end', () => {
          if (res.statusCode !== 200) return finish(new Error(`OWNER_DECISION_HTTP_${res.statusCode}`));
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const calls = value.output?.filter(item => item.type === 'function_call');
            if (value.status !== 'completed' || calls?.length !== 1 || calls[0].name !== 'route_turn') {
              return finish(new Error('OWNER_DECISION_INVALID_RESULT'));
            }
            finish(null, {id: value.id, calls, model: value.model, usage: value.usage});
          } catch { finish(new Error('OWNER_DECISION_INVALID_JSON')); }
        });
      });
      // Absolute deadline, including connect and a slow stream, not idle time.
      timer = setTimeout(() => req.destroy(new Error('OWNER_DECISION_TIMEOUT')), this.timeoutMs);
      req.on('error', error => finish(new Error(signal?.aborted ? 'OWNER_DECISION_ABORTED'
        : ['OWNER_DECISION_TIMEOUT', 'OWNER_DECISION_RESPONSE_TOO_LARGE'].includes(error?.message)
          ? error.message : 'OWNER_DECISION_REQUEST_FAILED')));
      req.end(body);
    });
  }
}

module.exports = {OwnerDecisionRouter, OWNER_DECISION_MODEL};
