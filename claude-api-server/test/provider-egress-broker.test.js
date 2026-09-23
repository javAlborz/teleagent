'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { REASONING_EFFORT_BY_MODEL } = require('../../lib/provider-model-contract');
const {
  ANTHROPIC_COUNT_BETAS,
  ANTHROPIC_COUNT_BETAS_BY_MODEL,
  ANTHROPIC_INFERENCE_BETAS,
  ANTHROPIC_INFERENCE_BETAS_BY_MODEL,
  PROVIDERS,
  TOKEN_RESERVATION_ENVELOPE,
  budgetStatus,
  capabilityHash,
  createProviderEgressBroker,
  normalizeAllowedAnthropicBeta,
  normalizePolicy,
  openBudgetStore,
  parseRequestBody,
  pruneBudgetHistory,
  recoverCapabilities,
  rejectUnsafeEnvironment,
  registerCapability,
  reserveBudget,
  revokeCapability,
  sanitizedHeaders,
  startProviderEgressBroker,
} = require('../provider-egress-broker');

const CAPABILITY = 'ab'.repeat(32);
const OTHER_CAPABILITY = 'cd'.repeat(32);
const LAUNCH_ID = 'launch_11111111111111111111111111111111';
const CODEX_THREAD_ID = '11111111-1111-4111-8111-111111111111';
const CODEX_TURN_ID = '22222222-2222-4222-8222-222222222222';

function capturedCodexClientMetadata() {
  return {
    thread_id: CODEX_THREAD_ID,
    root_turn_id: CODEX_TURN_ID,
    turn_id: CODEX_TURN_ID,
    session_id: CODEX_THREAD_ID,
    'x-codex-turn-metadata': '{"terminal":"bounded-local-capture"}',
    'x-codex-window-id': `w-${CODEX_THREAD_ID}`,
    'x-codex-installation-id': '33333333-3333-4333-8333-333333333333',
  };
}

function policy(provider = 'codex') {
  return {
    provider,
    allowedModels: provider === 'codex' ? ['gpt-5.6-sol'] : ['claude-sonnet-5'],
    allowedAnthropicBetaByModel: provider === 'claude'
      ? ANTHROPIC_COUNT_BETAS_BY_MODEL
      : {},
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
    maxConcurrent: 2,
    maxDailyRequests: 10,
    maxDailyReservedTokens: 100_000,
    maxOutputTokens: provider === 'claude' ? 64000 : 4096,
    maxLaunchRequests: 3,
    maxLaunchReservedTokens: provider === 'claude' ? 500_000 : 20_000,
    maxLaunchSeconds: 3600,
  };
}

test('pilot egress policies refuse a daily token allowance above the reviewed ceiling', () => {
  for (const provider of ['claude', 'codex']) {
    const filename = path.join(__dirname, '..', '..', 'deploy', 'worker-session',
      `provider-egress-${provider}.policy.example.json`);
    const source = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(normalizePolicy(source, provider).maxDailyReservedTokens, 100_000);
    assert.throws(() => normalizePolicy({ ...source, maxDailyReservedTokens: 100_001 }, provider),
      /maxDailyReservedTokens exceeds its hard bound/);
    for (const invalid of [0, '100000', null, undefined]) {
      assert.throws(() => normalizePolicy({ ...source, maxDailyReservedTokens: invalid }, provider),
        /maxDailyReservedTokens exceeds its hard bound or is missing/);
    }
  }
});

function harness(t, provider = 'codex') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-egress-'));
  const db = openBudgetStore(path.join(directory, 'budget.sqlite'), { uid: process.getuid() });
  // Broker-specific teardown is registered synchronously by each networked
  // test. Register the shared DB cleanup one microtask later so the broker can
  // durably revoke/drain before its backing connection closes.
  queueMicrotask(() => t.after(() => {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }));
  return { directory, db, policy: policy(provider) };
}

function register(db, selectedPolicy, overrides = {}) {
  const model = overrides.model || selectedPolicy.allowedModels[0];
  return registerCapability(db, selectedPolicy, {
    launchId: LAUNCH_ID,
    capability: CAPABILITY,
    expiresAtMs: Date.now() + 60_000,
    model,
    reasoningEffort: REASONING_EFFORT_BY_MODEL[model],
    routeKinds: selectedPolicy.provider === 'claude'
      ? ['inference', 'count_tokens']
      : ['inference'],
    mode: 'managed',
    ...overrides,
  });
}

function request(server, {
  method = 'POST',
  route,
  body = null,
  headers = {},
}) {
  const address = server.address();
  const payload = body === null
    ? null
    : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: address.address,
      port: address.port,
      method,
      path: route,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      let settled = false;
      const finish = (extra = {}) => {
        if (settled) return;
        settled = true;
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
          ...extra,
        });
      };
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', finish);
      res.once('aborted', () => finish({ aborted: true }));
      res.once('error', (error) => finish({ error }));
    });
    req.once('error', reject);
    req.end(payload || undefined);
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for provider egress test condition.');
}

function fakeHttps(calls) {
  return (options, callback) => {
    const upstream = new PassThrough();
    const chunks = [];
    upstream.on('data', (chunk) => chunks.push(chunk));
    upstream.setTimeout = () => upstream;
    upstream.once('finish', () => {
      calls.push({ options, body: Buffer.concat(chunks).toString('utf8') });
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      callback(response);
      response.end('{"ok":true}');
    });
    return upstream;
  };
}

test('capability registration is digest-only, timing-safe at use, and cancel-before-submit safe', (t) => {
  const { db, policy: selectedPolicy } = harness(t);
  selectedPolicy.allowedModels.push('gpt-5.6-luna');
  const expiresAtMs = Date.now() + 60_000;
  assert.deepEqual(register(db, selectedPolicy, { expiresAtMs }), {
    registered: true, idempotent: false,
  });
  assert.deepEqual(register(db, selectedPolicy, { expiresAtMs }), {
    registered: true, idempotent: true,
  });
  const row = db.prepare('SELECT * FROM provider_egress_capabilities').get();
  assert.equal(row.capability_hash, capabilityHash(CAPABILITY));
  assert.equal(row.model, 'gpt-5.6-sol');
  assert.equal(row.route_kinds_json, '["inference"]');
  assert.equal(row.mode, 'managed');
  assert.doesNotMatch(JSON.stringify(row), new RegExp(CAPABILITY));
  assert.throws(
    () => register(db, selectedPolicy, { capability: OTHER_CAPABILITY }),
    (error) => error.code === 'PROVIDER_CAPABILITY_CONFLICT'
  );
  assert.throws(
    () => register(db, selectedPolicy, { model: 'gpt-5.6-luna' }),
    (error) => error.code === 'PROVIDER_CAPABILITY_CONFLICT'
  );

  assert.throws(() => reserveBudget(db, selectedPolicy, {
    reservationId: 'reservation_tampered', launchId: LAUNCH_ID,
    capability: OTHER_CAPABILITY, model: 'gpt-5.6-sol', routeKind: 'inference',
    reasoningEffort: 'high',
    requestBytes: 100, reservedTokens: 200,
  }), (error) => error.code === 'PROVIDER_CAPABILITY_DENIED');
  assert.throws(() => reserveBudget(db, selectedPolicy, {
    reservationId: 'reservation_model_upgrade', launchId: LAUNCH_ID,
    capability: CAPABILITY, model: 'gpt-5.6-luna', routeKind: 'inference',
    reasoningEffort: 'low',
    requestBytes: 100, reservedTokens: 200,
  }), (error) => error.code === 'PROVIDER_CAPABILITY_DENIED');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_egress_reservations').get().count, 0);

  const canceledId = 'launch_22222222222222222222222222222222';
  assert.equal(revokeCapability(db, { launchId: canceledId }).tombstone, true);
  assert.throws(() => register(db, selectedPolicy, {
    launchId: canceledId, capability: OTHER_CAPABILITY,
    expiresAtMs: Date.now() + 60_000,
  }), (error) => error.code === 'PROVIDER_CAPABILITY_CONFLICT');
});

test('revoke before a delayed register stays canceled across store reopen for both providers', async (t) => {
  for (const provider of ['claude', 'codex']) {
    await t.test(provider, (t) => {
      const { directory, db, policy: selectedPolicy } = harness(t, provider);
      assert.deepEqual(revokeCapability(db, { launchId: LAUNCH_ID }), {
        persisted: true, alreadyRevoked: false, tombstone: true,
      });
      db.close();
      const reopened = openBudgetStore(path.join(directory, 'budget.sqlite'), { uid: process.getuid() });
      try {
        assert.throws(() => register(reopened, selectedPolicy), { code: 'PROVIDER_CAPABILITY_CONFLICT' });
        assert.deepEqual(reopened.prepare(
          'SELECT state, capability_hash FROM provider_egress_capabilities WHERE launch_id = ?'
        ).get(LAUNCH_ID), { state: 'canceled', capability_hash: null });
        assert.equal(reopened.pragma('integrity_check', { simple: true }), 'ok');
      } finally {
        reopened.close();
      }
    });
  }
});

test('credential broker refuses Node/TLS debug injection without echoing secret values', () => {
  for (const name of [
    'NODE_DEBUG', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_ENV_PROXY', 'SSLKEYLOGFILE',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'https_proxy',
    'ALL_PROXY', 'NO_PROXY', 'LD_PRELOAD',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_TOKEN',
    'CUSTOM_TOKEN', 'CUSTOM_SECRET', 'CUSTOM_PASSWORD', 'CUSTOM_KEY',
    'GITHUB_PAT', 'AWS_ACCESS_KEY_ID', 'DATABASE_URL', 'KUBECONFIG',
  ]) {
    assert.throws(() => rejectUnsafeEnvironment({ [name]: 'credential-sentinel-value' }),
      /unsafe runtime environment names/);
  }
  assert.doesNotThrow(() => rejectUnsafeEnvironment({
    CREDENTIALS_DIRECTORY: '/run/credentials/teleagent-provider-egress@claude.service',
    TELEAGENT_PROVIDER: 'claude',
    HOME: PROVIDERS.claude.home,
    LISTEN_PID: '1234',
    LISTEN_FDS: '2',
    LISTEN_FDNAMES: 'egress-claude:egress-control-claude',
    INVOCATION_ID: 'f'.repeat(32),
  }));
  const modulePath = path.join(__dirname, '..', 'provider-egress-broker.js');
  const child = spawnSync(process.execPath, ['-e', `
    const { rejectUnsafeEnvironment } = require(${JSON.stringify(modulePath)});
    try { rejectUnsafeEnvironment(process.env); } catch (error) {
      process.stderr.write(error.message);
      process.exit(77);
    }
  `], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      NODE_DEBUG: 'http,https,net,tls',
      PROVIDER_KEY_SENTINEL: 'real-upstream-credential-sentinel',
    },
  });
  assert.equal(child.status, 77);
  assert.match(child.stderr, /NODE_DEBUG/);
  assert.doesNotMatch(child.stderr, /real-upstream-credential-sentinel/);
});

test('per-launch and daily reservations are atomic and expose only sanitized budget totals', (t) => {
  const { db, policy: selectedPolicy } = harness(t);
  register(db, selectedPolicy, { maxRequests: 2, maxReservedTokens: 1000 });
  for (let index = 0; index < 2; index += 1) {
    reserveBudget(db, selectedPolicy, {
      reservationId: `reservation_${index}`, launchId: LAUNCH_ID,
      capability: CAPABILITY, model: 'gpt-5.6-sol', routeKind: 'inference',
      reasoningEffort: 'high',
      requestBytes: 100, reservedTokens: 400,
    });
  }
  assert.throws(() => reserveBudget(db, selectedPolicy, {
    reservationId: 'reservation_exhausted', launchId: LAUNCH_ID,
    capability: CAPABILITY, model: 'gpt-5.6-sol', routeKind: 'inference',
    reasoningEffort: 'high',
    requestBytes: 100, reservedTokens: 1,
  }), (error) => error.code === 'PROVIDER_LAUNCH_BUDGET_EXHAUSTED');
  const status = budgetStatus(db, selectedPolicy);
  assert.equal(status.usedRequests, 2);
  assert.equal(status.usedReservedTokens, 800);
  assert.deepEqual(status.models, [{ model: 'gpt-5.6-sol', requests: 2, reservedTokens: 800 }]);
  assert.doesNotMatch(JSON.stringify(status), /capability|credential|prompt|path/i);
});

test('provider state reserve blocks new capabilities and reservations but not revocation', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-egress-capacity-'));
  let exhausted = false;
  const db = openBudgetStore(path.join(directory, 'budget.sqlite'), {
    uid: process.getuid(),
    gid: process.getgid(),
    storageAdmission() {
      if (exhausted) {
        const error = new Error('state reserve exhausted');
        error.code = 'WORKER_STATE_CAPACITY_EXHAUSTED';
        throw error;
      }
    },
  });
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const selectedPolicy = policy();
  const expiresAtMs = Date.now() + 60_000;
  assert.equal(register(db, selectedPolicy, { expiresAtMs }).registered, true);
  exhausted = true;
  assert.equal(register(db, selectedPolicy, { expiresAtMs }).idempotent, true);
  assert.throws(() => register(db, selectedPolicy, {
    launchId: 'launch_99999999999999999999999999999999',
    capability: OTHER_CAPABILITY,
  }), { code: 'PROVIDER_STATE_CAPACITY_EXHAUSTED' });
  assert.throws(() => reserveBudget(db, selectedPolicy, {
    reservationId: 'reservation_capacity', launchId: LAUNCH_ID,
    capability: CAPABILITY, model: 'gpt-5.6-sol', routeKind: 'inference',
    reasoningEffort: 'high', requestBytes: 100, reservedTokens: 200,
  }), { code: 'PROVIDER_STATE_CAPACITY_EXHAUSTED' });
  assert.equal(revokeCapability(db, { launchId: LAUNCH_ID }).persisted, true);
  assert.equal(recoverCapabilities(db).persisted, true);
});

test('provider state retention prunes only old revoked accounting history', (t) => {
  const { db, policy: selectedPolicy } = harness(t);
  const old = new Date('2026-07-01T00:00:00.000Z');
  const recent = new Date('2026-08-20T00:00:00.000Z');
  const oldActiveLaunchId = 'launch_33333333333333333333333333333333';
  const recentRevokedLaunchId = 'launch_22222222222222222222222222222222';
  register(db, selectedPolicy, {
    expiresAtMs: old.getTime() + 60_000,
    now: old,
  });
  reserveBudget(db, selectedPolicy, {
    reservationId: 'reservation_old', launchId: LAUNCH_ID,
    capability: CAPABILITY, model: 'gpt-5.6-sol', routeKind: 'inference',
    reasoningEffort: 'high', requestBytes: 100, reservedTokens: 200,
    now: old,
  });
  revokeCapability(db, { launchId: LAUNCH_ID, now: old });
  register(db, selectedPolicy, {
    launchId: oldActiveLaunchId,
    capability: 'ef'.repeat(32),
    expiresAtMs: old.getTime() + 60_000,
    now: old,
  });
  reserveBudget(db, selectedPolicy, {
    reservationId: 'reservation_old_active', launchId: oldActiveLaunchId,
    capability: 'ef'.repeat(32), model: 'gpt-5.6-sol', routeKind: 'inference',
    reasoningEffort: 'high', requestBytes: 100, reservedTokens: 200,
    now: old,
  });
  register(db, selectedPolicy, {
    launchId: recentRevokedLaunchId,
    capability: OTHER_CAPABILITY,
    expiresAtMs: recent.getTime() + 60_000,
    now: recent,
  });
  reserveBudget(db, selectedPolicy, {
    reservationId: 'reservation_recent', launchId: recentRevokedLaunchId,
    capability: OTHER_CAPABILITY, model: 'gpt-5.6-sol', routeKind: 'inference',
    reasoningEffort: 'high', requestBytes: 100, reservedTokens: 200,
    now: recent,
  });
  revokeCapability(db, { launchId: recentRevokedLaunchId, now: recent });
  assert.deepEqual(pruneBudgetHistory(db, {
    now: new Date('2026-08-26T00:00:00.000Z'),
  }), {
    cutoff: '2026-08-12',
    reservations: 1,
    capabilities: 1,
  });
  assert.deepEqual(db.prepare(
    'SELECT launch_id, state FROM provider_egress_capabilities ORDER BY launch_id'
  ).all(), [
    { launch_id: recentRevokedLaunchId, state: 'canceled' },
    { launch_id: oldActiveLaunchId, state: 'active' },
  ]);
  assert.deepEqual(db.prepare(
    'SELECT reservation_id FROM provider_egress_reservations ORDER BY reservation_id'
  ).all(), [
    { reservation_id: 'reservation_old_active' },
    { reservation_id: 'reservation_recent' },
  ]);
});

test('input reservations use a worst-case byte bound plus output and fixed framing', (t) => {
  const { db, policy: selectedPolicy } = harness(t);
  const bodyBuffer = Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol',
    reasoning: { effort: 'high' },
    max_output_tokens: 64,
    // Deliberately token-hostile random/code-like text: the bound must not
    // assume prose compresses to one token per three or four bytes.
    input: Array.from({ length: 900 }, (_, index) => String.fromCharCode(33 + (index % 90))).join(''),
  }));
  const parsed = parseRequestBody(bodyBuffer, 'codex', selectedPolicy, 'inference');
  assert.equal(
    parsed.reservedTokens,
    parsed.requestBytes + 64 + TOKEN_RESERVATION_ENVELOPE,
  );

  register(db, selectedPolicy, { maxReservedTokens: parsed.reservedTokens - 1 });
  assert.throws(() => reserveBudget(db, selectedPolicy, {
    reservationId: 'reservation_worst_case', launchId: LAUNCH_ID,
    capability: CAPABILITY, model: parsed.model, routeKind: 'inference',
    reasoningEffort: parsed.reasoningEffort,
    requestBytes: bodyBuffer.length, reservedTokens: parsed.reservedTokens,
  }), (error) => error.code === 'PROVIDER_LAUNCH_BUDGET_EXHAUSTED');

  const normal = Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol', reasoning: { effort: 'high' },
    max_output_tokens: 16, input: 'ordinary request',
  }));
  const normalParsed = parseRequestBody(normal, 'codex', selectedPolicy, 'inference');
  assert.equal(
    normalParsed.reservedTokens,
    normalParsed.requestBytes + 16 + TOKEN_RESERVATION_ENVELOPE
  );
});

test('provider-hosted search, MCP, computer, container, and background work are denied before spend', async (t) => {
  const { db, policy: selectedPolicy } = harness(t);
  register(db, selectedPolicy);
  const deniedBodies = [
    { model: 'gpt-5.6-sol', input: 'x', tools: [{ type: 'web_search_preview' }] },
    { model: 'gpt-5.6-sol', input: 'x', tools: [{ type: 'mcp', server_url: 'https://example.test' }] },
    { model: 'gpt-5.6-sol', input: 'x', tools: [{ type: 'computer_use_preview' }] },
    { model: 'gpt-5.6-sol', input: 'x', tools: [{ type: 'code_interpreter', container: 'auto' }] },
    { model: 'gpt-5.6-sol', input: 'x', background: true },
  ];
  for (const body of deniedBodies) {
    assert.throws(
      () => parseRequestBody(Buffer.from(JSON.stringify(body)), 'codex', selectedPolicy, 'inference'),
      (error) => error.code === 'PROVIDER_HOSTED_TOOL_DENIED' && error.status === 403
    );
  }
  const capturedCodexBody = {
    client_metadata: capturedCodexClientMetadata(),
    include: ['reasoning.encrypted_content'],
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [
          {
            type: 'namespace', name: 'functions', description: 'Local client tools',
            tools: [
              {
                type: 'custom', name: 'exec', description: 'Run bounded local work',
                format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' },
              },
              {
                type: 'function', name: 'wait', description: 'Wait locally', strict: false,
                parameters: { type: 'object', properties: {}, additionalProperties: false },
              },
            ],
          },
        ],
      },
      {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'Inspect the workspace.' }],
      },
    ],
    model: 'gpt-5.6-sol',
    parallel_tool_calls: false,
    prompt_cache_key: CODEX_THREAD_ID,
    reasoning: { effort: 'high', context: 'all_turns' },
    store: false,
    stream: true,
    text: { verbosity: 'low' },
    tool_choice: 'auto',
    max_output_tokens: 16,
  };
  assert.equal(parseRequestBody(
    Buffer.from(JSON.stringify(capturedCodexBody)),
    'codex',
    selectedPolicy,
    'inference'
  ).model, 'gpt-5.6-sol', 'the pinned Codex additional_tools envelope must remain compatible');

  const nestedDenied = [
    { type: 'web_search_preview', name: 'search' },
    { type: 'function', name: 'safe_name', server_url: 'https://attacker.invalid' },
    { type: 'custom', name: 'mcp_connector' },
  ];
  for (const maliciousTool of nestedDenied) {
    const malicious = structuredClone(capturedCodexBody);
    malicious.input[0].tools[0].tools.push(maliciousTool);
    assert.throws(
      () => parseRequestBody(Buffer.from(JSON.stringify(malicious)), 'codex', selectedPolicy, 'inference'),
      (error) => error.code === 'PROVIDER_HOSTED_TOOL_DENIED' && error.status === 403
    );
  }
  const misplaced = structuredClone(capturedCodexBody);
  misplaced.input[1].tools = [{ type: 'function', name: 'hidden' }];
  assert.throws(
    () => parseRequestBody(Buffer.from(JSON.stringify(misplaced)), 'codex', selectedPolicy, 'inference'),
    (error) => error.code === 'PROVIDER_HOSTED_TOOL_DENIED'
  );

  const calls = [];
  const broker = createProviderEgressBroker({
    config: {
      provider: 'codex', spec: PROVIDERS.codex, policy: selectedPolicy,
      credential: 'upstream-secret-that-never-returns',
    },
    db,
    httpsRequest: fakeHttps(calls),
  });
  t.after(() => broker.close());
  await new Promise((resolve) => broker.dataServer.listen(0, '127.0.0.1', resolve));
  const denied = await request(broker.dataServer, {
    route: '/v1/responses',
    headers: {
      'x-teleagent-launch-id': LAUNCH_ID,
      'x-teleagent-launch-capability': CAPABILITY,
    },
    body: {
      ...capturedCodexBody,
      input: capturedCodexBody.input.map((item, index) => index === 0 ? {
        ...item,
        tools: [{
          ...item.tools[0],
          tools: [...item.tools[0].tools, { type: 'mcp', server_url: 'https://attacker.invalid' }],
        }],
      } : item),
    },
  });
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_egress_reservations').get().count, 0);
});

test('pinned client envelopes accept current CLI controls and strip cross-job correlation', () => {
  const codexPolicy = policy('codex');
  const codexBody = {
    client_metadata: capturedCodexClientMetadata(),
    include: ['reasoning.encrypted_content'],
    input: 'fresh local job',
    model: 'gpt-5.6-sol',
    parallel_tool_calls: false,
    prompt_cache_key: CODEX_THREAD_ID,
    reasoning: { effort: 'high', context: 'all_turns' },
    store: false,
    stream: true,
    text: { verbosity: 'low' },
    tool_choice: 'auto',
  };
  const parsedCodex = parseRequestBody(
    Buffer.from(JSON.stringify(codexBody)), 'codex', codexPolicy, 'inference'
  );
  assert.equal(parsedCodex.reasoningEffort, 'high');
  assert.equal(Object.hasOwn(parsedCodex.body, 'client_metadata'), false);
  assert.equal(Object.hasOwn(parsedCodex.body, 'prompt_cache_key'), false);
  assert.doesNotMatch(parsedCodex.canonicalBuffer.toString('utf8'), /thread_id|prompt_cache_key/);

  const codexMutations = [
    { reasoning: { effort: 'high', context: 'none' } },
    { parallel_tool_calls: true },
    { text: { verbosity: 'medium' } },
    { include: ['reasoning.encrypted_content', 'message.output_text.logprobs'] },
    { prompt_cache_key: 'shared-cache-key' },
    { client_metadata: { ...capturedCodexClientMetadata(), attacker: 'value' } },
  ];
  for (const mutation of codexMutations) {
    assert.throws(
      () => parseRequestBody(
        Buffer.from(JSON.stringify({ ...codexBody, ...mutation })),
        'codex', codexPolicy, 'inference'
      ),
      (error) => ['PROVIDER_CLIENT_ENVELOPE_DENIED', 'PROVIDER_REASONING_EFFORT_DENIED']
        .includes(error.code)
    );
  }

  const claudePolicy = {
    ...policy('claude'),
    allowedModels: [
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5',
      'claude-opus-5',
    ],
  };
  const sharedClaude = {
    context_management: { edits: [{ type: 'clear_thinking_20251015' }] },
    messages: [],
    metadata: { user_id: 'teleagent-local-installation' },
    stream: true,
  };
  const claudeBodies = [
    {
      ...sharedClaude,
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 32000,
      thinking: { type: 'enabled', budget_tokens: 31999, display: 'omitted' },
    },
    ...['claude-sonnet-5', 'claude-opus-5'].map((model) => ({
      ...sharedClaude,
      model,
      max_tokens: 64000,
      output_config: { effort: 'high' },
      thinking: { type: 'adaptive', display: 'omitted' },
    })),
  ];
  for (const body of claudeBodies) {
    const parsed = parseRequestBody(
      Buffer.from(JSON.stringify(body)), 'claude', claudePolicy, 'inference'
    );
    assert.equal(Object.hasOwn(parsed.body, 'metadata'), false);
    assert.doesNotMatch(parsed.canonicalBuffer.toString('utf8'), /teleagent-local-installation/);
  }
  for (const mutation of [
    { metadata: { user_id: 'local', extra: 'correlator' } },
    { stream: false },
    { context_management: { edits: [{ type: 'unreviewed_edit' }] } },
  ]) {
    assert.throws(
      () => parseRequestBody(Buffer.from(JSON.stringify({
        ...claudeBodies[1],
        ...mutation,
      })), 'claude', claudePolicy, 'inference'),
      (error) => error.code === 'PROVIDER_CLIENT_ENVELOPE_DENIED'
    );
  }
  assert.throws(
    () => parseRequestBody(Buffer.from(JSON.stringify({
      ...claudeBodies[0], max_tokens: 31999,
    })), 'claude', claudePolicy, 'inference'),
    (error) => error.code === 'PROVIDER_REASONING_EFFORT_DENIED'
  );
});

test('provider persistence, premium tier selection, and remote content references are denied', () => {
  const codexPolicy = policy('codex');
  const baseCodex = {
    model: 'gpt-5.6-sol',
    reasoning: { effort: 'high' },
    max_output_tokens: 16,
    input: [{
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'Inspect local text.' }],
    }],
    store: false,
  };
  for (const mutation of [
    { store: true },
    { previous_response_id: 'resp_prior' },
    { conversation: 'conversation_prior' },
    { service_tier: 'priority' },
  ]) {
    assert.throws(
      () => parseRequestBody(Buffer.from(JSON.stringify({ ...baseCodex, ...mutation })),
        'codex', codexPolicy, 'inference'),
      (error) => ['PROVIDER_STATE_DENIED', 'PROVIDER_SERVICE_TIER_DENIED'].includes(error.code)
    );
  }

  const remoteCodexItems = [
    { type: 'input_image', image_url: 'https://attacker.invalid/image.png' },
    { type: 'image_url', url: 'https://attacker.invalid/image.png' },
    { type: 'input_file', file_id: 'file-prior' },
    { type: 'file_id', id: 'file-prior' },
  ];
  for (const item of remoteCodexItems) {
    assert.throws(
      () => parseRequestBody(Buffer.from(JSON.stringify({
        ...baseCodex,
        input: [item],
      })), 'codex', codexPolicy, 'inference'),
      (error) => error.code === 'PROVIDER_REMOTE_CONTENT_DENIED'
    );
  }

  const localSchema = structuredClone(baseCodex);
  localSchema.input.unshift({
    type: 'additional_tools', role: 'developer', tools: [{
      type: 'namespace', name: 'functions', tools: [{
        type: 'function', name: 'inspect_local_metadata',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' }, file_id: { type: 'string' } },
        },
      }],
    }],
  });
  assert.equal(parseRequestBody(
    Buffer.from(JSON.stringify(localSchema)), 'codex', codexPolicy, 'inference'
  ).model, 'gpt-5.6-sol', 'local client schema property names are not fetched content');

  const capturedToolRoundTrip = {
    ...baseCodex,
    input: [
      {
        type: 'function_call',
        id: 'fc_local_read_1',
        call_id: 'call_local_read_1',
        name: 'read_workspace',
        arguments: '{"path":"README.md"}',
        internal_chat_message_metadata_passthrough: { local: true },
      },
      {
        type: 'function_call_output',
        id: 'fco_local_read_1',
        call_id: 'call_local_read_1',
        output: [{ type: 'input_text', text: 'bounded local function result' }],
      },
      {
        type: 'custom_tool_call',
        id: 'ctc_local_exec_2',
        call_id: 'call_local_exec_2',
        name: 'exec',
        input: 'rg --files',
        status: 'completed',
        internal_chat_message_metadata_passthrough: null,
      },
      {
        type: 'custom_tool_call_output',
        id: 'ctco_local_exec_2',
        call_id: 'call_local_exec_2',
        output: [{ type: 'input_text', text: 'bounded local custom-tool result' }],
      },
      baseCodex.input[0],
    ],
  };
  assert.equal(parseRequestBody(
    Buffer.from(JSON.stringify(capturedToolRoundTrip)), 'codex', codexPolicy, 'inference'
  ).model, 'gpt-5.6-sol', 'pinned local tool-result round trips remain compatible');
  for (const item of [
    { type: 'item_reference', id: 'provider-state-item' },
    {
      type: 'function_call_output', id: 'fco_local_read_1', call_id: 'call_local_read_1',
      output: [{ type: 'image_url', image_url: 'https://attacker.invalid/result.png' }],
    },
    {
      type: 'custom_tool_call_output', id: 'ctco_local_exec_2', call_id: 'call_local_exec_2',
      output: [{ type: 'input_text', text: 'visible' }], file_id: 'provider-file',
    },
    {
      type: 'custom_tool_call', id: 'ctc_local_exec_2', call_id: 'call_local_exec_2',
      name: 'exec', input: 'safe', status: 'completed',
      internal_chat_message_metadata_passthrough: { file_id: 'provider-file' },
    },
  ]) {
    assert.throws(
      () => parseRequestBody(Buffer.from(JSON.stringify({
        ...baseCodex,
        input: [item],
      })), 'codex', codexPolicy, 'inference'),
      (error) => error.code === 'PROVIDER_REMOTE_CONTENT_DENIED'
    );
  }

  const claudePolicy = policy('claude');
  const claudeHeadersIndependentBody = {
    model: 'claude-sonnet-5', max_tokens: 16,
    messages: [{ role: 'user', content: [] }],
  };
  for (const block of [
    { type: 'image', source: { type: 'url', url: 'https://attacker.invalid/a.png' } },
    { type: 'document', source: { type: 'file_id', file_id: 'file-prior' } },
    { type: 'input_image', image_url: 'https://attacker.invalid/a.png' },
  ]) {
    assert.throws(
      () => parseRequestBody(Buffer.from(JSON.stringify({
        ...claudeHeadersIndependentBody,
        messages: [{ role: 'user', content: [block] }],
      })), 'claude', claudePolicy, 'inference'),
      (error) => error.code === 'PROVIDER_REMOTE_CONTENT_DENIED'
    );
  }
  assert.throws(
    () => parseRequestBody(Buffer.from(JSON.stringify({
      ...claudeHeadersIndependentBody,
      service_tier: 'priority',
    })), 'claude', claudePolicy, 'inference'),
    (error) => error.code === 'PROVIDER_SERVICE_TIER_DENIED'
  );
});

test('ambiguous duplicate and unknown top-level JSON members are denied before accounting', async (t) => {
  const { db, policy: selectedPolicy } = harness(t);
  register(db, selectedPolicy);
  const calls = [];
  const broker = createProviderEgressBroker({
    config: {
      provider: 'codex', spec: PROVIDERS.codex, policy: selectedPolicy,
      credential: 'upstream-secret-that-never-returns',
    },
    db,
    httpsRequest: fakeHttps(calls),
  });
  t.after(() => broker.close());
  await new Promise((resolve) => broker.dataServer.listen(0, '127.0.0.1', resolve));
  const raw = Buffer.from(
    '{"model":"attacker-model","model":"gpt-5.6-sol",' +
    '"max_output_tokens":999999,"max_output_tokens":16,' +
    '"background":true,"background":false,' +
    '"tools":[{"type":"web_search"}],"tools":[{"type":"function","name":"local_read",' +
    '"parameters":{"type":"object","server_url":"https://attacker.invalid","server_url":null}}],' +
    '"input":"inspect"}'
  );
  const response = await request(broker.dataServer, {
    route: '/v1/responses',
    headers: {
      'x-teleagent-launch-id': LAUNCH_ID,
      'x-teleagent-launch-capability': CAPABILITY,
    },
    body: raw,
  });
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM provider_egress_reservations'
  ).get().count, 0);

  for (const duplicateOnly of [
    '{"model":"gpt-5.6-sol","model":"gpt-5.6-sol","reasoning":{"effort":"high"},"max_output_tokens":16,"input":"inspect"}',
    '{"model":"gpt-5.6-sol","reasoning":{"effort":"low","effort":"high"},"max_output_tokens":16,"input":"inspect"}',
  ]) {
    assert.throws(
      () => parseRequestBody(Buffer.from(duplicateOnly), 'codex', selectedPolicy, 'inference'),
      (error) => error.code === 'PROVIDER_REQUEST_SHAPE_DENIED' && error.status === 403
    );
  }
});

test('shutdown destroys a never-ending data body after durable revoke and before upstream', async (t) => {
  const { db, policy: selectedPolicy } = harness(t);
  register(db, selectedPolicy);
  let upstreamCalls = 0;
  const broker = createProviderEgressBroker({
    config: {
      provider: 'codex', spec: PROVIDERS.codex, policy: selectedPolicy,
      credential: 'upstream-secret-that-never-returns',
    },
    db,
    httpsRequest: () => {
      upstreamCalls += 1;
      throw new Error('shutdown-fenced request reached upstream');
    },
  });
  await new Promise((resolve) => broker.dataServer.listen(0, '127.0.0.1', resolve));
  const address = broker.dataServer.address();
  const body = Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol', reasoning: { effort: 'high' },
    max_output_tokens: 16, input: 'must not leave the host',
  }));
  let req;
  const responseDone = new Promise((resolve) => {
    req = http.request({
      host: address.address,
      port: address.port,
      agent: false,
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
        connection: 'close',
        'content-length': body.length,
        'x-teleagent-launch-id': LAUNCH_ID,
        'x-teleagent-launch-capability': CAPABILITY,
      },
    }, (res) => {
      res.resume();
      res.once('end', resolve);
    });
    req.once('error', resolve);
  });
  req.write(body.subarray(0, 1));
  await waitFor(() => broker.status().active === 1);
  const closing = broker.close();
  await Promise.all([responseDone, closing]);
  assert.equal(upstreamCalls, 0);
  assert.equal(broker.status().active, 0);
  assert.equal(db.prepare(
    'SELECT state FROM provider_egress_capabilities WHERE launch_id = ?'
  ).get(LAUNCH_ID).state, 'revoked');
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM provider_egress_reservations'
  ).get().count, 0);
});

test('shutdown destroys a never-ending control registration and leaves no active capability', async (t) => {
  const { db, policy: selectedPolicy } = harness(t);
  const broker = createProviderEgressBroker({
    config: {
      provider: 'codex', spec: PROVIDERS.codex, policy: selectedPolicy,
      credential: 'upstream-secret-that-never-returns',
    },
    db,
  });
  await new Promise((resolve) => broker.controlServer.listen(0, '127.0.0.1', resolve));
  const address = broker.controlServer.address();
  const body = Buffer.from(JSON.stringify({
    version: 1,
    provider: 'codex',
    launchId: LAUNCH_ID,
    capability: CAPABILITY,
    expiresAtMs: Date.now() + 60_000,
    model: 'gpt-5.6-sol',
    routeKinds: ['inference'],
    mode: 'managed',
  }));
  let req;
  let responseStatus = null;
  const responseDone = new Promise((resolve) => {
    req = http.request({
      host: address.address,
      port: address.port,
      agent: false,
      method: 'POST',
      path: '/v1/control/register',
      headers: {
        'content-type': 'application/json',
        connection: 'close',
        'content-length': body.length,
      },
    }, (res) => {
      responseStatus = res.statusCode;
      res.resume();
      res.once('end', resolve);
    });
    req.once('error', resolve);
  });
  req.write(body.subarray(0, 1));
  await waitFor(() => broker.status().pendingRequests === 1);
  const closing = broker.close();
  await Promise.all([responseDone, closing]);
  assert.notEqual(responseStatus, 201);
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM provider_egress_capabilities WHERE state = 'active'"
  ).get().count, 0);
  assert.equal(broker.status().pendingRequests, 0);
});

test('Codex exact responses inject the bearer while uncaptured compaction stays disabled', async (t) => {
  const { db, policy: selectedPolicy } = harness(t);
  register(db, selectedPolicy);
  const calls = [];
  const config = {
    provider: 'codex',
    spec: PROVIDERS.codex,
    policy: selectedPolicy,
    credential: 'upstream-secret-that-never-returns',
  };
  const broker = createProviderEgressBroker({ config, db, httpsRequest: fakeHttps(calls) });
  t.after(() => broker.close());
  await new Promise((resolve) => broker.dataServer.listen(0, '127.0.0.1', resolve));
  const headers = {
    'x-teleagent-launch-id': LAUNCH_ID,
    'x-teleagent-launch-capability': CAPABILITY,
    authorization: 'Bearer untrusted-client-value',
  };
  const inference = await request(broker.dataServer, {
    route: '/v1/responses', headers,
    body: {
      model: 'gpt-5.6-sol', reasoning: { effort: 'high' },
      max_output_tokens: 200, input: 'not persisted',
    },
  });
  assert.equal(inference.status, 200);
  const compact = await request(broker.dataServer, {
    route: '/v1/responses/compact', headers,
    body: { model: 'gpt-5.6-sol', input: 'locally replayed compact input', store: false },
  });
  assert.equal(compact.status, 403);
  assert.deepEqual(calls.map((call) => call.options.path), ['/v1/responses']);
  for (const call of calls) {
    assert.equal(call.options.hostname, 'api.openai.com');
    assert.equal(call.options.headers.authorization, 'Bearer upstream-secret-that-never-returns');
    assert.equal(call.options.headers['x-teleagent-launch-capability'], undefined);
  }
  assert.doesNotMatch(inference.body + compact.body, /upstream-secret|ab{10}/);

  const forbidden = await request(broker.dataServer, {
    route: '/v1/chat/completions', headers,
    body: { model: 'gpt-5.6-sol' },
  });
  assert.equal(forbidden.status, 403);
  const websocket = await request(broker.dataServer, {
    method: 'GET', route: '/v1/responses', headers,
  });
  assert.equal(websocket.status, 403);

  const serializedRows = JSON.stringify({
    capabilities: db.prepare('SELECT * FROM provider_egress_capabilities').all(),
    reservations: db.prepare('SELECT * FROM provider_egress_reservations').all(),
  });
  assert.doesNotMatch(serializedRows, /upstream-secret|not persisted|untrusted-client|abababab/);
});

test('Claude messages and count_tokens are exact while revocation and recovery deny reuse', async (t) => {
  const { db, policy: selectedPolicy } = harness(t, 'claude');
  register(db, selectedPolicy);
  const calls = [];
  const broker = createProviderEgressBroker({
    config: {
      provider: 'claude', spec: PROVIDERS.claude, policy: selectedPolicy,
      credential: 'anthropic-upstream-secret-value',
    },
    db,
    httpsRequest: fakeHttps(calls),
  });
  t.after(() => broker.close());
  await new Promise((resolve) => broker.dataServer.listen(0, '127.0.0.1', resolve));
  const headers = {
    'x-teleagent-launch-id': LAUNCH_ID,
    'x-teleagent-launch-capability': CAPABILITY,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': ANTHROPIC_INFERENCE_BETAS.join(','),
  };
  assert.equal((await request(broker.dataServer, {
    route: '/v1/messages?beta=true', headers,
    body: {
      model: 'claude-sonnet-5', output_config: { effort: 'high' },
      thinking: { type: 'adaptive', display: 'omitted' },
      max_tokens: 64000, messages: [],
    },
  })).status, 200);
  assert.equal((await request(broker.dataServer, {
    route: '/v1/messages/count_tokens?beta=true',
    headers: {
      ...headers,
      'anthropic-beta': ANTHROPIC_COUNT_BETAS.join(','),
    },
    body: { model: 'claude-sonnet-5', messages: [] },
  })).status, 200);
  assert.deepEqual(calls.map((call) => call.options.path), [
    '/v1/messages?beta=true', '/v1/messages/count_tokens?beta=true',
  ]);
  assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].options.headers['anthropic-beta'], ANTHROPIC_INFERENCE_BETAS.join(','));
  assert.equal(calls[1].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[1].options.headers['anthropic-beta'], ANTHROPIC_COUNT_BETAS.join(','));
  assert.equal(revokeCapability(db, { launchId: LAUNCH_ID, state: 'revoked' }).persisted, true);
  assert.equal((await request(broker.dataServer, {
    route: '/v1/messages?beta=true', headers,
    body: {
      model: 'claude-sonnet-5', output_config: { effort: 'high' },
      thinking: { type: 'adaptive', display: 'omitted' },
      max_tokens: 64000, messages: [],
    },
  })).status, 401);

  const second = 'launch_33333333333333333333333333333333';
  register(db, selectedPolicy, { launchId: second, capability: OTHER_CAPABILITY });
  assert.equal(recoverCapabilities(db).revokedCount, 1);
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM provider_egress_capabilities WHERE state = 'active'"
  ).get().count, 0);
});

test('pinned Claude request shape permits only the exact beta query and reviewed beta headers', async (t) => {
  const { db, policy: selectedPolicy } = harness(t, 'claude');
  selectedPolicy.maxOutputTokens = 64000;
  selectedPolicy.maxLaunchReservedTokens = 100_000;
  register(db, selectedPolicy);
  const calls = [];
  const broker = createProviderEgressBroker({
    config: {
      provider: 'claude', spec: PROVIDERS.claude, policy: selectedPolicy,
      credential: 'anthropic-upstream-secret-value',
    },
    db,
    httpsRequest: fakeHttps(calls),
  });
  t.after(() => broker.close());
  await new Promise((resolve) => broker.dataServer.listen(0, '127.0.0.1', resolve));
  const beta = ANTHROPIC_INFERENCE_BETAS.join(',');
  const countBeta = ANTHROPIC_COUNT_BETAS.join(',');
  const headers = {
    'x-teleagent-launch-id': LAUNCH_ID,
    'x-teleagent-launch-capability': CAPABILITY,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': beta,
  };
  const capturedBody = {
    context_management: { edits: [{ type: 'clear_thinking_20251015' }] },
    max_tokens: 64000,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect status.' }] }],
    metadata: { user_id: 'teleagent-test' },
    model: 'claude-sonnet-5',
    output_config: { effort: 'high' },
    stream: true,
    system: [{ type: 'text', text: 'Use only local client tools.', cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive', display: 'omitted' },
    tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }],
  };
  const accepted = await request(broker.dataServer, {
    route: '/v1/messages?beta=true', headers, body: capturedBody,
  });
  assert.equal(accepted.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.path, '/v1/messages?beta=true');
  assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].options.headers['anthropic-beta'], beta);
  const countAccepted = await request(broker.dataServer, {
    route: '/v1/messages/count_tokens?beta=true',
    headers: { ...headers, 'anthropic-beta': countBeta },
    body: {
      model: capturedBody.model,
      messages: capturedBody.messages,
      system: capturedBody.system,
      tools: capturedBody.tools,
    },
  });
  assert.equal(countAccepted.status, 200);
  assert.equal(calls[1].options.path, '/v1/messages/count_tokens?beta=true');
  assert.equal(calls[1].options.headers['anthropic-beta'], countBeta);
  const reservations = db.prepare(
    'SELECT COUNT(*) AS count FROM provider_egress_reservations'
  ).get().count;

  for (const route of [
    '/v1/messages?beta=false',
    '/v1/messages?beta=true&extra=1',
    '/v1/messages?beta=true&beta=true',
    '/v1/messages/count_tokens?beta=false',
  ]) {
    const denied = await request(broker.dataServer, { route, headers, body: capturedBody });
    assert.equal(denied.status, 403);
    assert.equal(JSON.parse(denied.body).code, 'PROVIDER_EGRESS_PATH_DENIED');
  }
  assert.equal(calls.length, 2);
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM provider_egress_reservations'
  ).get().count, reservations, 'noncanonical beta query must be denied before spend');
});

test('Claude protocol headers are pinned and beta negotiation is exact before budget spend', async (t) => {
  const { db, policy: selectedPolicy } = harness(t, 'claude');
  assert.deepEqual(
    normalizeAllowedAnthropicBeta(ANTHROPIC_COUNT_BETAS_BY_MODEL, 'claude'),
    ANTHROPIC_COUNT_BETAS_BY_MODEL
  );
  for (const invalidPolicy of [
    undefined,
    { ...ANTHROPIC_COUNT_BETAS_BY_MODEL, 'claude-sonnet-5': ANTHROPIC_INFERENCE_BETAS },
    { ...ANTHROPIC_COUNT_BETAS_BY_MODEL, extra: ['unreviewed-beta-2026-01-01'] },
    {
      ...ANTHROPIC_COUNT_BETAS_BY_MODEL,
      'claude-sonnet-5': [...ANTHROPIC_COUNT_BETAS].reverse(),
    },
  ]) {
    assert.throws(
      () => normalizeAllowedAnthropicBeta(invalidPolicy, 'claude'),
      /does not match the pinned Claude client/
    );
  }
  register(db, selectedPolicy);
  const calls = [];
  const broker = createProviderEgressBroker({
    config: {
      provider: 'claude', spec: PROVIDERS.claude, policy: selectedPolicy,
      credential: 'anthropic-upstream-secret-value',
    },
    db,
    httpsRequest: fakeHttps(calls),
  });
  t.after(() => broker.close());
  await new Promise((resolve) => broker.dataServer.listen(0, '127.0.0.1', resolve));
  const baseHeaders = {
    'x-teleagent-launch-id': LAUNCH_ID,
    'x-teleagent-launch-capability': CAPABILITY,
  };
  const valid = await request(broker.dataServer, {
    route: '/v1/messages?beta=true',
    headers: {
      ...baseHeaders,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': ANTHROPIC_INFERENCE_BETAS.join(','),
    },
    body: {
      model: 'claude-sonnet-5', output_config: { effort: 'high' },
      thinking: { type: 'adaptive', display: 'omitted' },
      max_tokens: 64000, messages: [],
    },
  });
  assert.equal(valid.status, 200);
  assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].options.headers['anthropic-beta'], ANTHROPIC_INFERENCE_BETAS.join(','));
  const reservationCount = db.prepare(
    'SELECT COUNT(*) AS count FROM provider_egress_reservations'
  ).get().count;

  const deniedHeaders = [
    { 'anthropic-beta': ANTHROPIC_INFERENCE_BETAS.join(',') },
    { 'anthropic-version': '2024-01-01', 'anthropic-beta': ANTHROPIC_INFERENCE_BETAS.join(',') },
    { 'anthropic-version': '2023-06-01, 2023-06-01', 'anthropic-beta': ANTHROPIC_INFERENCE_BETAS.join(',') },
    { 'anthropic-version': '2023-06-01' },
    { 'anthropic-version': '2023-06-01', 'anthropic-beta': ANTHROPIC_INFERENCE_BETAS.slice(0, -1).join(',') },
    { 'anthropic-version': '2023-06-01', 'anthropic-beta': `${ANTHROPIC_INFERENCE_BETAS.join(',')},unknown-beta-2026-01-01` },
    { 'anthropic-version': '2023-06-01', 'anthropic-beta': `${ANTHROPIC_INFERENCE_BETAS.join(',')},${ANTHROPIC_INFERENCE_BETAS[0]}` },
    { 'anthropic-version': '2023-06-01', 'anthropic-beta': `${ANTHROPIC_INFERENCE_BETAS.join(',')}${'x'.repeat(513)}` },
    { 'anthropic-version': '2023-06-01', 'anthropic-beta': ANTHROPIC_COUNT_BETAS.join(',') },
  ];
  for (const untrusted of deniedHeaders) {
    const denied = await request(broker.dataServer, {
      route: '/v1/messages?beta=true',
      headers: { ...baseHeaders, ...untrusted },
      body: {
        model: 'claude-sonnet-5', output_config: { effort: 'high' },
        thinking: { type: 'adaptive', display: 'omitted' },
        max_tokens: 64000, messages: [],
      },
    });
    assert.equal(denied.status, 403);
    assert.equal(JSON.parse(denied.body).code, 'PROVIDER_ANTHROPIC_HEADER_DENIED');
  }
  assert.equal(calls.length, 1, 'denied header negotiation must never reach Anthropic');
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM provider_egress_reservations'
  ).get().count, reservationCount, 'denied header negotiation must not reserve budget');

  const missingCountToken = await request(broker.dataServer, {
    route: '/v1/messages/count_tokens?beta=true',
    headers: {
      ...baseHeaders,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': ANTHROPIC_INFERENCE_BETAS.join(','),
    },
    body: { model: 'claude-sonnet-5', messages: [] },
  });
  assert.equal(missingCountToken.status, 403);
  assert.equal(JSON.parse(missingCountToken.body).code, 'PROVIDER_ANTHROPIC_HEADER_DENIED');
  assert.equal(calls.length, 1);
});

test('each pinned Claude model requires its own offline-captured beta contract', () => {
  for (const [model, betas] of Object.entries(ANTHROPIC_INFERENCE_BETAS_BY_MODEL)) {
    const accepted = sanitizedHeaders('claude', {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': betas.join(','),
    }, 'upstream-credential', policy('claude'), 'inference', model);
    assert.equal(accepted['anthropic-beta'], betas.join(','));

    const other = Object.entries(ANTHROPIC_INFERENCE_BETAS_BY_MODEL)
      .find(([candidate]) => candidate !== model)[1];
    assert.throws(
      () => sanitizedHeaders('claude', {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': other.join(','),
      }, 'upstream-credential', policy('claude'), 'inference', model),
      /outside policy/
    );
  }
});

test('revoke aborts and drains the exact in-flight upstream before reporting quiescent', async (t) => {
  const { db, policy: selectedPolicy } = harness(t);
  register(db, selectedPolicy);
  let upstreamRequest;
  let upstreamResponse;
  let responseStartedResolve;
  const responseStarted = new Promise((resolve) => { responseStartedResolve = resolve; });
  const httpsRequest = (_options, callback) => {
    upstreamRequest = new PassThrough();
    upstreamRequest.setTimeout = () => upstreamRequest;
    upstreamRequest.once('finish', () => {
      upstreamResponse = new PassThrough();
      upstreamResponse.statusCode = 200;
      upstreamResponse.headers = { 'content-type': 'text/event-stream' };
      callback(upstreamResponse);
      upstreamResponse.write('data: still-running\n\n');
      responseStartedResolve();
    });
    return upstreamRequest;
  };
  const broker = createProviderEgressBroker({
    config: {
      provider: 'codex', spec: PROVIDERS.codex, policy: selectedPolicy,
      credential: 'upstream-secret-that-never-returns',
    },
    db,
    httpsRequest,
  });
  t.after(() => broker.close());
  await Promise.all([
    new Promise((resolve) => broker.dataServer.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => broker.controlServer.listen(0, '127.0.0.1', resolve)),
  ]);
  const inFlight = request(broker.dataServer, {
    route: '/v1/responses',
    headers: {
      'x-teleagent-launch-id': LAUNCH_ID,
      'x-teleagent-launch-capability': CAPABILITY,
    },
    body: {
      model: 'gpt-5.6-sol', reasoning: { effort: 'high' },
      max_output_tokens: 200, input: 'work',
    },
  }).catch((error) => ({ error }));
  await responseStarted;
  assert.equal(broker.status().activeLaunches, 1);

  const revoke = await request(broker.controlServer, {
    route: '/v1/control/revoke',
    body: { version: 1, provider: 'codex', launchId: LAUNCH_ID, reason: 'canceled' },
  });
  const result = JSON.parse(revoke.body);
  assert.equal(revoke.status, 200);
  assert.equal(result.persisted, true);
  assert.equal(result.quiesced, true);
  assert.equal(upstreamRequest.destroyed, true);
  assert.equal(upstreamResponse.destroyed, true);
  assert.equal(broker.status().activeLaunches, 0);
  await inFlight;
});

test('panic recovery drains every provider upstream before its quiescent ACK', async (t) => {
  const { db, policy: selectedPolicy } = harness(t);
  register(db, selectedPolicy);
  const responses = [];
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const broker = createProviderEgressBroker({
    config: {
      provider: 'codex', spec: PROVIDERS.codex, policy: selectedPolicy,
      credential: 'upstream-secret-that-never-returns',
    },
    db,
    httpsRequest(_options, callback) {
      const upstream = new PassThrough();
      upstream.setTimeout = () => upstream;
      upstream.once('finish', () => {
        const response = new PassThrough();
        responses.push(response);
        response.statusCode = 200;
        response.headers = { 'content-type': 'text/event-stream' };
        callback(response);
        response.write('data: accepted-upstream\n\n');
        startedResolve();
      });
      return upstream;
    },
  });
  t.after(() => broker.close());
  await Promise.all([
    new Promise((resolve) => broker.dataServer.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => broker.controlServer.listen(0, '127.0.0.1', resolve)),
  ]);
  const data = request(broker.dataServer, {
    route: '/v1/responses',
    headers: {
      'x-teleagent-launch-id': LAUNCH_ID,
      'x-teleagent-launch-capability': CAPABILITY,
    },
    body: {
      model: 'gpt-5.6-sol', reasoning: { effort: 'high' },
      max_output_tokens: 200, input: 'work',
    },
  });
  await started;
  const recovered = await request(broker.controlServer, {
    route: '/v1/control/recover',
    body: { version: 1, provider: 'codex' },
  });
  const result = JSON.parse(recovered.body);
  assert.equal(result.persisted, true);
  assert.equal(result.quiesced, true);
  assert.equal(result.revokedCount, 1);
  assert.equal(responses[0].destroyed, true);
  assert.equal(broker.status().activeLaunches, 0);
  assert.equal((await data).aborted, true);
});

test('broker process startup revokes persisted launch capabilities before either listener is ready', async (t) => {
  const { db, policy: selectedPolicy } = harness(t);
  register(db, selectedPolicy);
  const order = [];
  const listeners = () => ({
    listening: false,
    once() {},
    listen(_options, callback) {
      order.push('listen');
      this.listening = true;
      callback();
    },
  });
  const dataServer = listeners();
  const controlServer = listeners();
  const broker = {
    dataServer,
    controlServer,
    async close() {},
  };
  const started = await startProviderEgressBroker({
    config: {
      provider: 'codex',
      uid: process.getuid(),
      gid: process.getgid(),
      spec: { ...PROVIDERS.codex, database: path.join(t.mock ? '' : '/', 'unused') },
      policy: selectedPolicy,
      credential: 'upstream-secret-that-never-returns',
      dataFd: 3,
      controlFd: 4,
    },
    createStorageGuard() {
      order.push('storage_checked');
      return { assertNewWork() { order.push('storage_admitted'); } };
    },
    openStore() {
      order.push('store_opened');
      return {
        ...db,
        prepare: (...args) => db.prepare(...args),
        transaction: (...args) => db.transaction(...args),
        close() {},
      };
    },
    createBroker() {
      const active = db.prepare(
        "SELECT COUNT(*) AS count FROM provider_egress_capabilities WHERE state = 'active'"
      ).get().count;
      order.push(`create:${active}`);
      return broker;
    },
    verifySocketPaths: false,
  });
  t.after(() => started.close());

  assert.deepEqual(order, [
    'storage_checked',
    'storage_admitted',
    'store_opened',
    'create:0',
    'listen',
    'listen',
  ]);
  assert.equal(started.startupRecovery.persisted, true);
  assert.equal(started.startupRecovery.revokedCount, 1);
  const row = db.prepare(
    'SELECT state, capability_hash FROM provider_egress_capabilities WHERE launch_id = ?'
  ).get(LAUNCH_ID);
  assert.deepEqual(row, { state: 'revoked', capability_hash: null });
  assert.throws(() => reserveBudget(db, selectedPolicy, {
    reservationId: 'reservation_after_restart',
    launchId: LAUNCH_ID,
    capability: CAPABILITY,
    model: 'gpt-5.6-sol',
    routeKind: 'inference',
    requestBytes: 100,
    reservedTokens: 200,
  }), (error) => error.code === 'PROVIDER_CAPABILITY_DENIED');
});

test('provider startup refuses exhausted state before opening SQLite', async () => {
  const calls = [];
  const capacityError = Object.assign(new Error('state reserve exhausted'), {
    code: 'WORKER_STATE_CAPACITY_EXHAUSTED',
  });
  await assert.rejects(startProviderEgressBroker({
    config: {
      provider: 'codex',
      uid: 1234,
      gid: 1235,
      spec: PROVIDERS.codex,
    },
    createStorageGuard() {
      calls.push('storage_checked');
      return {
        assertNewWork() {
          calls.push('storage_refused');
          throw capacityError;
        },
      };
    },
    openStore() { calls.push('store_opened'); },
    verifySocketPaths: false,
  }), { code: 'WORKER_STATE_CAPACITY_EXHAUSTED' });
  assert.deepEqual(calls, ['storage_checked', 'storage_refused']);
});
