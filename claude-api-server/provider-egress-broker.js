'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { validateProviderCredential } = require('../lib/provider-secret');
const {
  STATE_DIRECTORIES,
  createWorkerStateStorageGuard,
} = require('./worker-state-storage-boundary');
const {
  ANTHROPIC_COUNT_BETAS_BY_MODEL,
  ANTHROPIC_INFERENCE_BETAS_BY_MODEL,
  ANTHROPIC_VERSION,
  CLAUDE_MODELS,
  CODEX_MODELS,
  REASONING_EFFORT_BY_MODEL,
  anthropicBetasForModel,
} = require('../lib/provider-model-contract');

const MAX_POLICY_BYTES = 64 * 1024;
const MAX_CONTROL_BYTES = 64 * 1024;
const LAUNCH_ID = /^launch_[a-f0-9]{32}$/;
const LAUNCH_CAPABILITY = /^[a-f0-9]{64}$/;
const STORAGE_ADMISSIONS = new WeakMap();
const PROVIDERS = Object.freeze({
  claude: Object.freeze({
    user: 'teleagent-claude-egress',
    home: STATE_DIRECTORIES['claude-egress'],
    socket: '/run/teleagent-provider-egress/claude.sock',
    controlSocket: '/run/teleagent-provider-egress-control/claude.sock',
    database: `${STATE_DIRECTORIES['claude-egress']}/budget.sqlite`,
    policy: '/etc/teleagent/provider-egress/claude.json',
    upstreamHost: 'api.anthropic.com',
    routes: Object.freeze({
      '/v1/messages': Object.freeze({ kind: 'inference' }),
      '/v1/messages/count_tokens': Object.freeze({ kind: 'count_tokens' }),
    }),
  }),
  codex: Object.freeze({
    user: 'teleagent-codex-egress',
    home: STATE_DIRECTORIES['codex-egress'],
    socket: '/run/teleagent-provider-egress/codex.sock',
    controlSocket: '/run/teleagent-provider-egress-control/codex.sock',
    database: `${STATE_DIRECTORIES['codex-egress']}/budget.sqlite`,
    policy: '/etc/teleagent/provider-egress/codex.json',
    upstreamHost: 'api.openai.com',
    routes: Object.freeze({
      '/v1/responses': Object.freeze({ kind: 'inference' }),
    }),
  }),
});
// UTF-8 byte length is a conservative upper bound for byte-level tokenizer
// input tokens. Reserve additional fixed protocol/tool framing so enforcement
// never relies on the unsafe average-case bytes-per-token heuristic.
const TOKEN_RESERVATION_ENVELOPE = 1024;
// Conservative pilot rates in micro-USD per reserved token. These exceed the
// currently reviewed text-token rates for the exact allowed models and modes.
// Account billing remains authoritative; re-review these rates before release.
const COST_RATE_MICRO_USD_PER_TOKEN = Object.freeze({ claude: 30, codex: 45 });
// Reviewed 2026-09-26 against standard API pricing, including long-context
// output and cache-write prices. Keep at least 1.5x the highest token rate;
// charge every reserved input/output token at that model's ceiling.
const CODEX_COST_RATE_MICRO_USD_PER_TOKEN = Object.freeze({
  'gpt-5.6-luna': 3,
  'gpt-5.6-terra': 27,
  'gpt-5.6-sol': 45,
});
const MAX_DAILY_RESERVED_TOKENS = 200_000;
const MAX_DAILY_RESERVED_COST_MICRO_USD = 5_000_000;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPENAI_PROJECT_ID = /^proj_[A-Za-z0-9_-]{3,128}$/;
const PROVIDER_ROUTE_KINDS = Object.freeze({
  claude: Object.freeze(['inference', 'count_tokens']),
  codex: Object.freeze(['inference']),
});
// Backwards-compatible named exports for the Sonnet capture. The security
// decision itself is model-specific via anthropicBetasForModel().
const ANTHROPIC_INFERENCE_BETAS = ANTHROPIC_INFERENCE_BETAS_BY_MODEL['claude-sonnet-5'];
const ANTHROPIC_COUNT_BETAS = ANTHROPIC_COUNT_BETAS_BY_MODEL['claude-sonnet-5'];
const ANTHROPIC_BETA_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ANTHROPIC_BETA_HEADER_BYTES = 512;
const ALLOWED_RUNTIME_ENV = new Set([
  'HOME', 'PATH', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL',
  'TELEAGENT_PROVIDER',
  'PROVIDER_EGRESS_SOCKET_PATH', 'PROVIDER_EGRESS_CONTROL_SOCKET_PATH',
  'PROVIDER_EGRESS_DB_PATH', 'PROVIDER_EGRESS_POLICY_PATH',
  'LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES',
  'CREDENTIALS_DIRECTORY', 'INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID',
  'MEMORY_PRESSURE_WATCH', 'MEMORY_PRESSURE_WRITE',
  'PWD', 'TELEAGENT_RELEASE_ROOT',
]);

function codedError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function secureFile(filename, {
  uid = null,
  rootOwned = false,
  executable = false,
  maxBytes = null,
} = {}) {
  const metadata = fs.lstatSync(filename);
  const expectedUid = rootOwned ? 0 : uid;
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
      (expectedUid !== null && metadata.uid !== expectedUid) ||
      (metadata.mode & 0o022) !== 0 || (executable && (metadata.mode & 0o111) === 0) ||
      (maxBytes !== null && metadata.size > maxBytes)) {
    throw new Error('Provider egress trust file is unsafe.');
  }
  return metadata;
}

function groupGid(name, groupFile = '/etc/group') {
  const metadata = fs.lstatSync(groupFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0) throw new Error('System group database is unsafe.');
  const matches = fs.readFileSync(groupFile, 'utf8').split('\n').filter((line) => (
    line && !line.startsWith('#') && line.split(':', 1)[0] === name
  ));
  if (matches.length !== 1) throw new Error(`Required group ${name} is missing.`);
  const gid = Number.parseInt(matches[0].split(':')[2], 10);
  if (!Number.isInteger(gid)) throw new Error(`Group ${name} is invalid.`);
  return gid;
}

function rejectUnsafeEnvironment(environment) {
  const unsafe = Object.keys(environment).filter((name) => (
    String(environment[name] || '') !== '' && !ALLOWED_RUNTIME_ENV.has(name)
  ));
  if (unsafe.length) {
    throw new Error(`Provider egress refuses unsafe runtime environment names: ${unsafe.sort().join(', ')}.`);
  }
}

function validateCoordinatorEnvironment(environment, spec,
  selectedReleaseRoot = fs.realpathSync('/opt/teleagent/current')) {
  if (environment.PWD !== spec.home ||
      !/^\/opt\/teleagent\/releases\/sha256-[a-f0-9]{64}$/.test(selectedReleaseRoot) ||
      environment.TELEAGENT_RELEASE_ROOT !== selectedReleaseRoot) {
    throw new Error('Provider egress release coordinator environment is unsafe.');
  }
}

function normalizeAllowedAnthropicBeta(input, provider) {
  if (provider !== 'claude') {
    if (input !== undefined && (
      !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0
    )) {
      throw new Error('Provider egress Anthropic beta policy is invalid.');
    }
    return Object.freeze([]);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== CLAUDE_MODELS.length ||
      CLAUDE_MODELS.some((model) => {
        const expected = ANTHROPIC_COUNT_BETAS_BY_MODEL[model];
        const actual = input[model];
        return !Array.isArray(actual) || actual.length !== expected.length ||
          actual.some((token, index) => token !== expected[index]);
      })) {
    throw new Error('Provider egress Anthropic beta policy does not match the pinned Claude client.');
  }
  return ANTHROPIC_COUNT_BETAS_BY_MODEL;
}

function readPolicy(filename, provider) {
  secureFile(filename, { rootOwned: true, maxBytes: MAX_POLICY_BYTES });
  let input;
  try { input = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error('Provider egress policy is invalid JSON.'); }
  return normalizePolicy(input, provider);
}

function normalizePolicy(input, provider) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Provider egress policy is invalid.');
  }
  const allowedModels = Array.isArray(input.allowedModels)
    ? [...new Set(input.allowedModels.map(String))]
    : [];
  const allowedAnthropicBetaByModel = normalizeAllowedAnthropicBeta(
    input.allowedAnthropicBetaByModel,
    provider
  );
  const positive = (name, fallback, max) => {
    const value = Number.parseInt(input[name], 10);
    const normalized = Number.isSafeInteger(value) && value > 0 ? value : fallback;
    if (normalized > max) throw new Error(`Provider egress ${name} exceeds its hard bound.`);
    return normalized;
  };
  if (!Number.isSafeInteger(input.maxDailyReservedTokens) ||
      input.maxDailyReservedTokens <= 0 ||
      input.maxDailyReservedTokens > MAX_DAILY_RESERVED_TOKENS) {
    throw new Error('Provider egress maxDailyReservedTokens exceeds its hard bound or is missing.');
  }
  if (!Number.isSafeInteger(input.maxDailyReservedCostMicroUsd) ||
      input.maxDailyReservedCostMicroUsd <= 0 ||
      input.maxDailyReservedCostMicroUsd > MAX_DAILY_RESERVED_COST_MICRO_USD) {
    throw new Error('Provider egress maxDailyReservedCostMicroUsd exceeds its hard bound or is missing.');
  }
  const expectedModels = provider === 'claude' ? CLAUDE_MODELS : CODEX_MODELS;
  const openaiProjectId = input.openaiProjectId ?? null;
  if ((provider === 'codex' && openaiProjectId !== null &&
       (typeof openaiProjectId !== 'string' || !OPENAI_PROJECT_ID.test(openaiProjectId))) ||
      (provider === 'claude' && openaiProjectId !== null)) {
    throw new Error('Provider egress OpenAI project identity is invalid.');
  }
  if (input.version !== 1 || input.provider !== provider ||
      allowedModels.length !== expectedModels.length ||
      allowedModels.some((model, index) => (
        !SAFE_MODEL.test(model) || model !== expectedModels[index]
      ))) {
    throw new Error('Provider egress policy identity is invalid.');
  }
  return Object.freeze({
    provider,
    openaiProjectId,
    allowedModels: Object.freeze(allowedModels),
    allowedAnthropicBetaByModel: Object.freeze(allowedAnthropicBetaByModel),
    maxRequestBytes: positive('maxRequestBytes', 2 * 1024 * 1024, 4 * 1024 * 1024),
    maxResponseBytes: positive('maxResponseBytes', 8 * 1024 * 1024, 32 * 1024 * 1024),
    maxConcurrent: positive('maxConcurrent', 2, 8),
    maxDailyRequests: positive('maxDailyRequests', 100, 1000),
    maxDailyReservedTokens: input.maxDailyReservedTokens,
    maxDailyReservedCostMicroUsd: input.maxDailyReservedCostMicroUsd,
    maxOutputTokens: positive('maxOutputTokens', provider === 'claude' ? 64000 : 32768, 131072),
    maxLaunchRequests: positive('maxLaunchRequests', 16, 128),
    maxLaunchReservedTokens: positive('maxLaunchReservedTokens', 250_000, 2_000_000),
    maxLaunchSeconds: positive('maxLaunchSeconds', 3600, 7200),
  });
}

function socketPathForFd(fd) {
  const inode = String(fs.fstatSync(fd).ino);
  const matches = fs.readFileSync('/proc/net/unix', 'utf8').split('\n').slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[6] === inode && fields.length >= 8 ? [fields.slice(7).join(' ')] : [];
  });
  if (matches.length !== 1 || !matches[0].startsWith('/')) {
    throw new Error('Provider egress inherited an unbound listener.');
  }
  return path.resolve(matches[0]);
}

function normalizeConfig(environment = process.env, {
  uid = process.getuid(),
  gid = process.getgid(),
  username = os.userInfo().username,
  pid = process.pid,
  clientGid = null,
} = {}) {
  const provider = String(environment.TELEAGENT_PROVIDER || '').trim();
  const spec = PROVIDERS[provider];
  if (!spec || uid === 0 || gid === 0 || username !== spec.user || environment.HOME !== spec.home) {
    throw new Error('Provider egress identity does not match its fixed provider.');
  }
  rejectUnsafeEnvironment(environment);
  validateCoordinatorEnvironment(environment, spec);
  if (String(environment.LISTEN_PID || '') !== String(pid) || environment.LISTEN_FDS !== '2') {
    throw new Error('Provider egress requires its data and root-control systemd sockets.');
  }
  const names = String(environment.LISTEN_FDNAMES || '').split(':');
  const expectedNames = [`egress-${provider}`, `egress-control-${provider}`];
  if (names.length !== 2 || expectedNames.some((name) => !names.includes(name))) {
    throw new Error('Provider egress inherited the wrong socket names.');
  }
  const fdByName = Object.fromEntries(names.map((name, index) => [name, 3 + index]));
  const dataFd = fdByName[`egress-${provider}`];
  const controlFd = fdByName[`egress-control-${provider}`];
  if (!fs.fstatSync(dataFd).isSocket() || !fs.fstatSync(controlFd).isSocket() ||
      socketPathForFd(dataFd) !== spec.socket ||
      socketPathForFd(controlFd) !== spec.controlSocket) {
    throw new Error('Provider egress inherited the wrong socket paths.');
  }
  const expectedClientGid = clientGid ?? groupGid(`teleagent-${provider}-egress-client`);
  const dataSocket = fs.lstatSync(spec.socket);
  const controlSocket = fs.lstatSync(spec.controlSocket);
  if (!dataSocket.isSocket() || dataSocket.isSymbolicLink() || dataSocket.uid !== 0 ||
      dataSocket.gid !== expectedClientGid || (dataSocket.mode & 0o777) !== 0o660 ||
      !controlSocket.isSocket() || controlSocket.isSymbolicLink() || controlSocket.uid !== 0 ||
      controlSocket.gid !== 0 || (controlSocket.mode & 0o777) !== 0o600) {
    throw new Error('Provider egress socket ownership boundary is unsafe.');
  }
  for (const [actual, expected, name] of [
    [environment.PROVIDER_EGRESS_SOCKET_PATH, spec.socket, 'PROVIDER_EGRESS_SOCKET_PATH'],
    [environment.PROVIDER_EGRESS_CONTROL_SOCKET_PATH, spec.controlSocket,
      'PROVIDER_EGRESS_CONTROL_SOCKET_PATH'],
    [environment.PROVIDER_EGRESS_DB_PATH, spec.database, 'PROVIDER_EGRESS_DB_PATH'],
    [environment.PROVIDER_EGRESS_POLICY_PATH, spec.policy, 'PROVIDER_EGRESS_POLICY_PATH'],
  ]) {
    if (String(actual || expected) !== expected) throw new Error(`${name} is fixed.`);
  }
  const credentialDirectory = path.resolve(String(environment.CREDENTIALS_DIRECTORY || ''));
  const credentialPath = path.join(credentialDirectory, 'provider-api-key');
  if (credentialDirectory !== `/run/credentials/teleagent-provider-egress@${provider}.service`) {
    throw new Error('Provider egress credential directory is unavailable.');
  }
  const credentialMetadata = secureFile(credentialPath, { maxBytes: 4096 });
  // The infrastructure startup coordinator attests the exact one-service ACL
  // on every start. For that projection, group-read is the ACL mask, not an
  // additional group grant. Other credential locations remain forbidden.
  const privateOwnerMode = [0, uid].includes(credentialMetadata.uid) &&
    (credentialMetadata.mode & 0o7777) === 0o400;
  const systemdAclMode = credentialMetadata.uid === 0 && credentialMetadata.gid === 0 &&
    (credentialMetadata.mode & 0o7777) === 0o440;
  if (!privateOwnerMode && !systemdAclMode) {
    throw new Error('Provider egress credential ownership is unsafe.');
  }
  // Do not trim: leading/trailing whitespace is malformed credential material,
  // not harmless file formatting. Validation errors never include the value.
  const credential = validateProviderCredential(fs.readFileSync(credentialPath));
  const policy = readPolicy(spec.policy, provider);
  return Object.freeze({ provider, spec, uid, gid, dataFd, controlFd, credential, policy });
}

function openBudgetStore(filename, {
  uid = process.getuid(),
  gid = process.getgid(),
  storageAdmission = null,
} = {}) {
  const directory = path.dirname(filename);
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      metadata.uid !== uid || metadata.gid !== gid || (metadata.mode & 0o077) !== 0) {
    throw new Error('Provider egress state directory is unsafe.');
  }
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_egress_capabilities (
      launch_id TEXT PRIMARY KEY,
      capability_hash TEXT UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'canceled')),
      expires_at_ms INTEGER NOT NULL,
      max_requests INTEGER NOT NULL CHECK (max_requests > 0),
      max_reserved_tokens INTEGER NOT NULL CHECK (max_reserved_tokens > 0),
      used_requests INTEGER NOT NULL DEFAULT 0 CHECK (used_requests >= 0),
      used_reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (used_reserved_tokens >= 0),
      model TEXT,
      route_kinds_json TEXT,
      mode TEXT,
      reasoning_effort TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS provider_egress_reservations (
      reservation_id TEXT PRIMARY KEY,
      launch_id TEXT NOT NULL REFERENCES provider_egress_capabilities(launch_id),
      budget_day TEXT NOT NULL,
      model TEXT NOT NULL,
      route_kind TEXT NOT NULL,
      reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
      request_bytes INTEGER NOT NULL CHECK (request_bytes > 0),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS provider_egress_reservations_day
      ON provider_egress_reservations(budget_day, model);
    CREATE TABLE IF NOT EXISTS provider_egress_cost_reservations (
      reservation_id TEXT PRIMARY KEY REFERENCES provider_egress_reservations(reservation_id)
        ON DELETE CASCADE,
      reserved_cost_micro_usd INTEGER NOT NULL CHECK (reserved_cost_micro_usd > 0)
    ) STRICT;
  `);
  const capabilityColumns = new Set(db.prepare(
    'PRAGMA table_info(provider_egress_capabilities)'
  ).all().map((column) => column.name));
  for (const [name, definition] of [
    ['model', 'TEXT'],
    ['route_kinds_json', 'TEXT'],
    ['mode', 'TEXT'],
    ['reasoning_effort', 'TEXT'],
  ]) {
    if (!capabilityColumns.has(name)) {
      db.exec(`ALTER TABLE provider_egress_capabilities ADD COLUMN ${name} ${definition}`);
    }
  }
  if (storageAdmission !== null) {
    if (typeof storageAdmission !== 'function') {
      db.close();
      throw new Error('Provider egress storage admission guard is invalid.');
    }
    STORAGE_ADMISSIONS.set(db, storageAdmission);
  }
  return db;
}

function assertNewProviderStateAdmission(db) {
  const admission = STORAGE_ADMISSIONS.get(db);
  if (!admission) return;
  try {
    admission();
  } catch (error) {
    if (error?.code === 'WORKER_STATE_CAPACITY_EXHAUSTED') {
      throw codedError(
        'PROVIDER_STATE_CAPACITY_EXHAUSTED',
        'Provider state reserve is exhausted; new durable work is refused.',
        503
      );
    }
    throw codedError('PROVIDER_STATE_BOUNDARY_INVALID', 'Provider state boundary is unavailable.', 503);
  }
}

function capabilityHash(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashesEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left || '') || !/^[a-f0-9]{64}$/.test(right || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function budgetDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function costRateFor(policy, model = null) {
  const rate = policy.provider === 'codex' && model !== null
    ? CODEX_COST_RATE_MICRO_USD_PER_TOKEN[model]
    : COST_RATE_MICRO_USD_PER_TOKEN[policy.provider];
  if (!Number.isSafeInteger(rate) || rate <= 0 ||
      !Number.isSafeInteger(policy.maxDailyReservedCostMicroUsd) ||
      policy.maxDailyReservedCostMicroUsd <= 0 ||
      policy.maxDailyReservedCostMicroUsd > MAX_DAILY_RESERVED_COST_MICRO_USD) {
    throw codedError('PROVIDER_COST_POLICY_INVALID', 'Provider cost policy is unavailable.', 503);
  }
  return rate;
}

function dailyReservations(db, day) {
  const totals = db.prepare(`
    SELECT COUNT(*) AS requests, COALESCE(SUM(r.reserved_tokens), 0) AS tokens,
           COUNT(c.reservation_id) AS costRows,
           COALESCE(SUM(c.reserved_cost_micro_usd), 0) AS reservedCostMicroUsd
    FROM provider_egress_reservations AS r
    LEFT JOIN provider_egress_cost_reservations AS c ON c.reservation_id = r.reservation_id
    WHERE r.budget_day = ?
  `).get(day);
  if (totals.requests !== totals.costRows ||
      !Number.isSafeInteger(totals.requests) || totals.requests < 0 ||
      !Number.isSafeInteger(totals.tokens) || totals.tokens < 0 ||
      !Number.isSafeInteger(totals.reservedCostMicroUsd) ||
      totals.reservedCostMicroUsd < 0) {
    throw codedError('PROVIDER_COST_LEDGER_INCOMPLETE',
      'Provider cost reservations are incomplete.', 503);
  }
  return totals;
}

function registerCapability(db, policy, {
  launchId,
  capability,
  expiresAtMs,
  model,
  routeKinds,
  mode = 'managed',
  reasoningEffort,
  maxRequests = policy.maxLaunchRequests,
  maxReservedTokens = policy.maxLaunchReservedTokens,
  now = new Date(),
}) {
  if (!LAUNCH_ID.test(launchId || '') || !LAUNCH_CAPABILITY.test(capability || '') ||
      !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now.getTime() ||
      expiresAtMs > now.getTime() + policy.maxLaunchSeconds * 1000 ||
      !Number.isSafeInteger(maxRequests) || maxRequests <= 0 || maxRequests > policy.maxLaunchRequests ||
      !Number.isSafeInteger(maxReservedTokens) || maxReservedTokens <= 0 ||
      maxReservedTokens > policy.maxLaunchReservedTokens ||
      !policy.allowedModels.includes(model) || mode !== 'managed' ||
      reasoningEffort !== REASONING_EFFORT_BY_MODEL[model] ||
      !Array.isArray(routeKinds) || routeKinds.length !== PROVIDER_ROUTE_KINDS[policy.provider].length ||
      routeKinds.some((kind, index) => kind !== PROVIDER_ROUTE_KINDS[policy.provider][index])) {
    throw codedError('PROVIDER_CAPABILITY_INVALID', 'Provider launch capability is invalid.', 403);
  }
  const digest = capabilityHash(capability);
  const routeKindsJson = JSON.stringify(routeKinds);
  const transaction = db.transaction(() => {
    const existing = db.prepare(
      'SELECT * FROM provider_egress_capabilities WHERE launch_id = ?'
    ).get(launchId);
    if (existing) {
      if (existing.state === 'active' && hashesEqual(existing.capability_hash, digest) &&
          existing.expires_at_ms === expiresAtMs && existing.max_requests === maxRequests &&
          existing.max_reserved_tokens === maxReservedTokens && existing.model === model &&
          existing.route_kinds_json === routeKindsJson && existing.mode === mode &&
          existing.reasoning_effort === reasoningEffort) {
        return { registered: true, idempotent: true };
      }
      throw codedError('PROVIDER_CAPABILITY_CONFLICT', 'Provider launch capability conflicts.', 409);
    }
    assertNewProviderStateAdmission(db);
    db.prepare(`
      INSERT INTO provider_egress_capabilities (
        launch_id, capability_hash, state, expires_at_ms, max_requests,
        max_reserved_tokens, model, route_kinds_json, mode, reasoning_effort, created_at
      ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      launchId, digest, expiresAtMs, maxRequests, maxReservedTokens,
      model, routeKindsJson, mode, reasoningEffort, now.toISOString()
    );
    return { registered: true, idempotent: false };
  });
  return transaction.immediate();
}

function revokeCapability(db, { launchId, now = new Date(), state = 'canceled' }) {
  if (!LAUNCH_ID.test(launchId || '') || !['revoked', 'canceled'].includes(state)) {
    throw codedError('PROVIDER_CAPABILITY_INVALID', 'Provider launch identity is invalid.', 403);
  }
  const transaction = db.transaction(() => {
    const existing = db.prepare(
      'SELECT state FROM provider_egress_capabilities WHERE launch_id = ?'
    ).get(launchId);
    if (!existing) {
      db.prepare(`
        INSERT INTO provider_egress_capabilities (
          launch_id, capability_hash, state, expires_at_ms, max_requests,
          max_reserved_tokens, created_at, revoked_at
        ) VALUES (?, NULL, 'canceled', 0, 1, 1, ?, ?)
      `).run(launchId, now.toISOString(), now.toISOString());
      return { persisted: true, alreadyRevoked: false, tombstone: true };
    }
    if (existing.state !== 'active') {
      return { persisted: true, alreadyRevoked: true, tombstone: existing.state === 'canceled' };
    }
    db.prepare(`
      UPDATE provider_egress_capabilities
      SET state = ?, capability_hash = NULL, revoked_at = ?
      WHERE launch_id = ? AND state = 'active'
    `).run(state, now.toISOString(), launchId);
    return { persisted: true, alreadyRevoked: false, tombstone: state === 'canceled' };
  });
  return transaction.immediate();
}

function recoverCapabilities(db, { now = new Date() } = {}) {
  const result = db.prepare(`
    UPDATE provider_egress_capabilities
    SET state = 'revoked', capability_hash = NULL, revoked_at = ?
    WHERE state = 'active'
  `).run(now.toISOString());
  return { persisted: true, revokedCount: result.changes };
}

function pruneBudgetHistory(db, { now = new Date(), retentionDays = 14 } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !Number.isSafeInteger(retentionDays) || retentionDays < 7 || retentionDays > 31) {
    throw codedError('PROVIDER_STATE_RETENTION_INVALID', 'Provider state retention is invalid.', 500);
  }
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const transaction = db.transaction(() => {
    const reservations = db.prepare(`
      DELETE FROM provider_egress_reservations
      WHERE substr(created_at, 1, 10) < ? AND EXISTS (
        SELECT 1 FROM provider_egress_capabilities
        WHERE provider_egress_capabilities.launch_id = provider_egress_reservations.launch_id
          AND provider_egress_capabilities.state != 'active'
          AND provider_egress_capabilities.revoked_at IS NOT NULL
          AND substr(provider_egress_capabilities.revoked_at, 1, 10) < ?
      )
    `).run(cutoff, cutoff).changes;
    const capabilities = db.prepare(`
      DELETE FROM provider_egress_capabilities
      WHERE state != 'active' AND revoked_at IS NOT NULL AND substr(revoked_at, 1, 10) < ?
        AND NOT EXISTS (
          SELECT 1 FROM provider_egress_reservations
          WHERE provider_egress_reservations.launch_id = provider_egress_capabilities.launch_id
        )
    `).run(cutoff).changes;
    return { cutoff, reservations, capabilities };
  });
  return transaction.immediate();
}

const DENIED_PROVIDER_TOOL_IDENTITY = /^(?:web[_-]?(?:search|fetch)|mcp|computer|container|code[_-]?(?:interpreter|execution)|file[_-]?search|image[_-]?generation|background)(?:[_:-]|$)/i;
const DENIED_PROVIDER_CAPABILITY_KEYS = new Set([
  'background', 'mcp_servers', 'mcpservers', 'server_url', 'server_label',
  'connector_id', 'container', 'computer', 'hosted_tool', 'hosted_tools',
]);
const CODEX_ADDITIONAL_TOOL_FIELDS = Object.freeze({
  namespace: new Set(['type', 'name', 'description', 'tools']),
  function: new Set(['type', 'name', 'description', 'parameters', 'strict']),
  custom: new Set(['type', 'name', 'description', 'format']),
});
const TOP_LEVEL_REQUEST_FIELDS = Object.freeze({
  claude: Object.freeze({
    inference: new Set([
      'context_management', 'max_tokens', 'messages', 'metadata', 'model',
      'output_config', 'stream', 'system', 'thinking', 'tools',
    ]),
    count_tokens: new Set(['messages', 'model', 'system', 'tools']),
  }),
  codex: Object.freeze({
    inference: new Set([
      'client_metadata', 'include', 'input', 'model', 'parallel_tool_calls',
      'prompt_cache_key', 'reasoning', 'store', 'stream', 'text', 'tool_choice',
      'max_output_tokens',
    ]),
  }),
});

function assertExactTopLevelRequest(body, provider, routeKind) {
  const allowed = TOP_LEVEL_REQUEST_FIELDS[provider]?.[routeKind];
  if (!allowed || !body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => !allowed.has(key)) ||
      !Object.hasOwn(body, 'model') || !Object.hasOwn(body, provider === 'codex' ? 'input' : 'messages')) {
    throw codedError(
      'PROVIDER_REQUEST_SHAPE_DENIED',
      'Provider request fields are outside the pinned client schema.',
      403
    );
  }
}

function assertNoDuplicateJsonMembers(source) {
  let index = 0;
  const skipWhitespace = () => {
    while (index < source.length && /[\u0020\u0009\u000a\u000d]/u.test(source[index])) index += 1;
  };
  const readString = () => {
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === '\\') index += 2;
      else if (source[index] === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      } else index += 1;
    }
    throw codedError('PROVIDER_EGRESS_REQUEST_INVALID', 'Provider request JSON is invalid.');
  };
  const readValue = () => {
    skipWhitespace();
    if (source[index] === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (source[index] === '}') { index += 1; return; }
      while (index < source.length) {
        skipWhitespace();
        const key = readString();
        if (keys.has(key)) {
          throw codedError(
            'PROVIDER_REQUEST_SHAPE_DENIED',
            'Provider request contains a duplicate JSON member.',
            403
          );
        }
        keys.add(key);
        skipWhitespace();
        index += 1; // JSON.parse already proved this byte is a colon.
        readValue();
        skipWhitespace();
        if (source[index] === '}') { index += 1; return; }
        index += 1; // JSON.parse already proved this byte is a comma.
      }
      return;
    }
    if (source[index] === '[') {
      index += 1;
      skipWhitespace();
      if (source[index] === ']') { index += 1; return; }
      while (index < source.length) {
        readValue();
        skipWhitespace();
        if (source[index] === ']') { index += 1; return; }
        index += 1;
      }
      return;
    }
    if (source[index] === '"') {
      readString();
      return;
    }
    while (index < source.length && !/[\u0020\u0009\u000a\u000d,\]}]/u.test(source[index])) {
      index += 1;
    }
  };
  readValue();
}

function providerToolDenied(message = 'Provider-hosted tools are disabled by policy.') {
  throw codedError('PROVIDER_HOSTED_TOOL_DENIED', message, 403);
}

function assertNoNestedProviderCapabilities(value) {
  const pending = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if ((visited += 1) > 20_000) providerToolDenied('Provider request structure exceeds policy.');
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const type = typeof current.type === 'string' ? current.type : '';
    const name = typeof current.name === 'string'
      ? current.name
      : (typeof current.function?.name === 'string' ? current.function.name : '');
    if (DENIED_PROVIDER_TOOL_IDENTITY.test(type) || DENIED_PROVIDER_TOOL_IDENTITY.test(name)) {
      providerToolDenied();
    }
    for (const [rawKey, nested] of Object.entries(current)) {
      const key = rawKey.toLowerCase();
      if (DENIED_PROVIDER_CAPABILITY_KEYS.has(key) &&
          nested !== undefined && nested !== null && nested !== false) {
        providerToolDenied();
      }
      pending.push(nested);
    }
  }
}

function assertCodexAdditionalTools(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) ||
      item.type !== 'additional_tools' || item.role !== 'developer' ||
      !Array.isArray(item.tools) || item.tools.length === 0 || item.tools.length > 128 ||
      Object.keys(item).some((key) => !['type', 'role', 'tools'].includes(key))) {
    providerToolDenied('Codex additional tools envelope is outside policy.');
  }
  let count = 0;
  const inspect = (tool, depth = 0) => {
    count += 1;
    if (count > 512 || depth > 4 || !tool || typeof tool !== 'object' || Array.isArray(tool)) {
      providerToolDenied('Codex additional tools envelope is outside policy.');
    }
    const type = String(tool.type || '');
    const fields = CODEX_ADDITIONAL_TOOL_FIELDS[type];
    if (!fields || !/^[A-Za-z0-9_.:-]{1,128}$/.test(String(tool.name || '')) ||
        Object.keys(tool).some((key) => !fields.has(key))) {
      providerToolDenied('Codex additional tool definition is outside policy.');
    }
    if (type === 'namespace') {
      if (!Array.isArray(tool.tools) || tool.tools.length === 0 || tool.tools.length > 128) {
        providerToolDenied('Codex tool namespace is outside policy.');
      }
      for (const nested of tool.tools) inspect(nested, depth + 1);
    } else if (tool.tools !== undefined) {
      providerToolDenied('Codex leaf tool definition is outside policy.');
    }
    assertNoNestedProviderCapabilities(tool);
  };
  for (const tool of item.tools) inspect(tool);
}

function providerContentDenied() {
  throw codedError(
    'PROVIDER_REMOTE_CONTENT_DENIED',
    'Provider-fetched remote or stored content is disabled by policy.',
    403
  );
}

const PROVIDER_ITEM_ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const PROVIDER_CORRELATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_CLIENT_METADATA_FIELDS = Object.freeze([
  'thread_id',
  'root_turn_id',
  'turn_id',
  'session_id',
  'x-codex-turn-metadata',
  'x-codex-window-id',
  'x-codex-installation-id',
]);

function providerClientEnvelopeDenied() {
  throw codedError(
    'PROVIDER_CLIENT_ENVELOPE_DENIED',
    'Provider client control fields are outside the pinned wire contract.',
    403
  );
}

function exactObjectKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
}

function boundedPrintableString(value, maxBytes = 4096) {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes && !/[\u0000-\u001f\u007f]/u.test(value);
}

function normalizeCapturedClientEnvelope(body, provider, routeKind) {
  if (routeKind !== 'inference') return;
  if (provider === 'codex') {
    if (body.client_metadata !== undefined) {
      if (!exactObjectKeys(body.client_metadata, CODEX_CLIENT_METADATA_FIELDS) ||
          CODEX_CLIENT_METADATA_FIELDS.some((key) => (
            !boundedPrintableString(body.client_metadata[key])
          )) ||
          ['thread_id', 'root_turn_id', 'turn_id', 'session_id', 'x-codex-installation-id']
            .some((key) => !PROVIDER_CORRELATION_UUID.test(body.client_metadata[key])) ||
          !PROVIDER_ITEM_ID.test(body.client_metadata['x-codex-window-id'])) {
        providerClientEnvelopeDenied();
      }
      // These client-generated identifiers are useful to the local CLI but
      // would correlate otherwise independent Teleagent jobs at the provider.
      delete body.client_metadata;
    }
    if (body.prompt_cache_key !== undefined) {
      if (!PROVIDER_CORRELATION_UUID.test(String(body.prompt_cache_key))) {
        providerClientEnvelopeDenied();
      }
      // Fresh jobs deliberately do not share provider cache identity.
      delete body.prompt_cache_key;
    }
    if (body.include !== undefined && (
      !Array.isArray(body.include) || body.include.length !== 1 ||
      body.include[0] !== 'reasoning.encrypted_content'
    )) providerClientEnvelopeDenied();
    if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== false) {
      providerClientEnvelopeDenied();
    }
    if (body.stream !== undefined && body.stream !== true) providerClientEnvelopeDenied();
    if (body.tool_choice !== undefined && body.tool_choice !== 'auto') {
      providerClientEnvelopeDenied();
    }
    if (body.text !== undefined && (
      !exactObjectKeys(body.text, ['verbosity']) || body.text.verbosity !== 'low'
    )) providerClientEnvelopeDenied();
    return;
  }
  if (provider !== 'claude') return;
  if (body.metadata !== undefined) {
    if (!exactObjectKeys(body.metadata, ['user_id']) ||
        !boundedPrintableString(body.metadata.user_id, 512)) {
      providerClientEnvelopeDenied();
    }
    // Do not let the provider correlate a fresh job through the CLI's local
    // installation/user identifier.
    delete body.metadata;
  }
  if (body.stream !== undefined && body.stream !== true) providerClientEnvelopeDenied();
  if (body.context_management !== undefined && (
    !exactObjectKeys(body.context_management, ['edits']) ||
    !Array.isArray(body.context_management.edits) ||
    body.context_management.edits.length !== 1 ||
    !exactObjectKeys(body.context_management.edits[0], ['type']) ||
    body.context_management.edits[0].type !== 'clear_thinking_20251015'
  )) providerClientEnvelopeDenied();
}

function assertNoRemoteReferenceTree(value) {
  const pending = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if ((visited += 1) > 1024) providerContentDenied();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const type = String(current.type || '').toLowerCase();
    if (['item_reference', 'input_image', 'image_url', 'input_file', 'file_id'].includes(type)) {
      providerContentDenied();
    }
    for (const [rawKey, nested] of Object.entries(current)) {
      const key = rawKey.toLowerCase();
      if (['url', 'image_url', 'file_id', 'previous_response_id', 'conversation'].includes(key) &&
          nested !== null && nested !== undefined) providerContentDenied();
      pending.push(nested);
    }
  }
}

function assertCodexCallMetadata(item) {
  const metadata = item.internal_chat_message_metadata_passthrough;
  if (metadata === undefined || metadata === null) return;
  if (typeof metadata !== 'object' || Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 8192) {
    providerContentDenied();
  }
  assertNoRemoteReferenceTree(metadata);
}

function assertCodexTextOutput(output) {
  if (typeof output === 'string') return;
  if (!Array.isArray(output) || output.length === 0 ||
      output.some((block) => (
        !block || typeof block !== 'object' || Array.isArray(block) ||
        block.type !== 'input_text' || typeof block.text !== 'string' ||
        Object.keys(block).some((key) => !['type', 'text'].includes(key))
      ))) providerContentDenied();
}

function assertNoProviderFetchedContent(body, provider) {
  if (provider === 'codex') {
    if (typeof body?.input === 'string') return;
    if (!Array.isArray(body?.input) || body.input.length === 0) providerContentDenied();
    for (const item of body.input) {
      if (item?.type === 'additional_tools') continue;
      if (['function_call', 'custom_tool_call'].includes(item?.type)) {
        const functionCall = item.type === 'function_call';
        const fields = functionCall
          ? ['type', 'id', 'call_id', 'name', 'arguments',
            'internal_chat_message_metadata_passthrough']
          : ['type', 'id', 'call_id', 'name', 'namespace', 'input', 'status',
            'internal_chat_message_metadata_passthrough'];
        const payload = functionCall ? item.arguments : item.input;
        if (!PROVIDER_ITEM_ID.test(String(item.id || '')) ||
            !PROVIDER_ITEM_ID.test(String(item.call_id || '')) ||
            !/^[A-Za-z0-9_.:-]{1,128}$/.test(String(item.name || '')) ||
            typeof payload !== 'string' ||
            (item.namespace !== undefined &&
              (functionCall || item.namespace !== 'functions' || item.name !== 'exec')) ||
            (!functionCall && item.status !== 'completed') ||
            Object.keys(item).some((key) => !fields.includes(key))) providerContentDenied();
        assertCodexCallMetadata(item);
        continue;
      }
      if (['function_call_output', 'custom_tool_call_output'].includes(item?.type)) {
        if (!PROVIDER_ITEM_ID.test(String(item.id || '')) ||
            !PROVIDER_ITEM_ID.test(String(item.call_id || '')) ||
            Object.keys(item).some((key) => ![
              'type', 'id', 'call_id', 'output', 'internal_chat_message_metadata_passthrough',
            ].includes(key))) {
          providerContentDenied();
        }
        assertCodexCallMetadata(item);
        assertCodexTextOutput(item.output);
        continue;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          item.type !== 'message' || !['developer', 'user'].includes(item.role) ||
          !Array.isArray(item.content) ||
          Object.keys(item).some((key) => !['type', 'role', 'content', 'id'].includes(key))) {
        providerContentDenied();
      }
      for (const block of item.content) {
        if (!block || typeof block !== 'object' || Array.isArray(block) ||
            block.type !== 'input_text' || typeof block.text !== 'string' ||
            Object.keys(block).some((key) => !['type', 'text'].includes(key))) {
          providerContentDenied();
        }
      }
    }
    return;
  }

  if (provider !== 'claude') return;
  const blocks = [];
  if (Array.isArray(body?.system)) blocks.push(...body.system);
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (Array.isArray(message?.content)) blocks.push(...message.content);
  }
  let visited = 0;
  while (blocks.length > 0) {
    const block = blocks.pop();
    if (!block || typeof block !== 'object') continue;
    if ((visited += 1) > 1024) providerContentDenied();
    if (Array.isArray(block)) {
      blocks.push(...block);
      continue;
    }
    const type = String(block.type || '').toLowerCase();
    if (['image', 'document', 'audio', 'video', 'input_image', 'image_url',
      'input_file', 'file_id'].includes(type) ||
        block.image_url !== undefined || block.file_id !== undefined ||
        (block.source && typeof block.source === 'object' &&
          ['base64', 'url', 'file', 'file_id'].includes(String(block.source.type || '').toLowerCase()))) {
      providerContentDenied();
    }
    blocks.push(...Object.values(block));
  }
}

function assertProviderStatePolicy(body, provider) {
  if (Object.hasOwn(body || {}, 'service_tier')) {
    throw codedError(
      'PROVIDER_SERVICE_TIER_DENIED',
      'Caller-selected provider service tiers are disabled by policy.',
      403
    );
  }
  if (provider !== 'codex') return;
  if (body.store === undefined) body.store = false;
  if (body.store !== false ||
      (body.previous_response_id !== undefined && body.previous_response_id !== null) ||
      (body.conversation !== undefined && body.conversation !== null)) {
    throw codedError(
      'PROVIDER_STATE_DENIED',
      'Provider-side persisted or cross-response state is disabled by policy.',
      403
    );
  }
}

function requestReasoningEffort(body, provider, model, routeKind) {
  if (routeKind === 'count_tokens') return null;
  const expected = REASONING_EFFORT_BY_MODEL[model];
  if (!expected) {
    throw codedError('PROVIDER_EGRESS_MODEL_DENIED', 'Provider model is outside policy.', 403);
  }
  if (provider === 'claude') {
    if (expected === 'default') {
      const thinking = body.thinking;
      if (model !== 'claude-haiku-4-5-20251001' || body.max_tokens !== 32000 ||
          body.output_config !== undefined ||
          !exactObjectKeys(thinking, ['type', 'budget_tokens', 'display']) ||
          thinking.type !== 'enabled' || thinking.budget_tokens !== 31999 ||
          thinking.display !== 'omitted') {
        throw codedError(
          'PROVIDER_REASONING_EFFORT_DENIED',
          'Claude effort does not match the pinned model contract.',
          403
        );
      }
      return expected;
    }
    const outputConfig = body.output_config;
    const thinking = body.thinking;
    if (!['claude-sonnet-5', 'claude-opus-5'].includes(model) || body.max_tokens !== 64000 ||
        !outputConfig || typeof outputConfig !== 'object' || Array.isArray(outputConfig) ||
        outputConfig.effort !== expected ||
        Object.keys(outputConfig).some((key) => key !== 'effort') ||
        !thinking || typeof thinking !== 'object' || Array.isArray(thinking) ||
        thinking.type !== 'adaptive' || thinking.display !== 'omitted' ||
        Object.keys(thinking).length !== 2) {
      throw codedError(
        'PROVIDER_REASONING_EFFORT_DENIED',
        'Claude effort does not match the pinned model contract.',
        403
      );
    }
    return expected;
  }
  const reasoning = body.reasoning;
  if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning) ||
      reasoning.effort !== expected ||
      Object.keys(reasoning).some((key) => !['effort', 'context'].includes(key)) ||
      (reasoning.context !== undefined && reasoning.context !== 'all_turns')) {
    throw codedError(
      'PROVIDER_REASONING_EFFORT_DENIED',
      'Codex reasoning effort does not match the launch capability.',
      403
    );
  }
  return expected;
}

function assertNoProviderHostedTools(body, provider = null) {
  if (body?.background !== undefined && body.background !== false && body.background !== null) {
    throw codedError(
      'PROVIDER_HOSTED_TOOL_DENIED',
      'Background provider execution is disabled by policy.',
      403
    );
  }
  for (const key of ['mcp_servers', 'mcpServers', 'container', 'computer']) {
    if (body?.[key] !== undefined && body[key] !== null && body[key] !== false) {
      throw codedError(
        'PROVIDER_HOSTED_TOOL_DENIED',
        'Provider-hosted tools are disabled by policy.',
        403
      );
    }
  }
  const inspectTool = (tool) => {
    if (typeof tool === 'string') {
      if (DENIED_PROVIDER_TOOL_IDENTITY.test(tool)) {
        throw codedError(
          'PROVIDER_HOSTED_TOOL_DENIED',
          'Provider-hosted tools are disabled by policy.',
          403
        );
      }
      return;
    }
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return;
    const type = String(tool.type || '');
    const name = String(tool.name || tool.function?.name || '');
    if ((type && !['function', 'custom'].includes(type)) ||
        DENIED_PROVIDER_TOOL_IDENTITY.test(type) || DENIED_PROVIDER_TOOL_IDENTITY.test(name) ||
        tool.server_url !== undefined || tool.server_label !== undefined ||
        tool.connector_id !== undefined || tool.container !== undefined) {
      throw codedError(
        'PROVIDER_HOSTED_TOOL_DENIED',
        'Provider-hosted tools are disabled by policy.',
        403
      );
    }
  };
  if (body?.tools !== undefined && !Array.isArray(body.tools)) {
    throw codedError('PROVIDER_HOSTED_TOOL_DENIED', 'Provider tools must be an array.', 403);
  }
  for (const tool of body?.tools || []) inspectTool(tool);
  if (body?.tool_choice && typeof body.tool_choice === 'object') {
    const choiceType = String(body.tool_choice.type || '');
    const choiceName = String(body.tool_choice.name || body.tool_choice.function?.name || '');
    if (DENIED_PROVIDER_TOOL_IDENTITY.test(choiceType) || DENIED_PROVIDER_TOOL_IDENTITY.test(choiceName) ||
        body.tool_choice.server_url !== undefined ||
        body.tool_choice.server_label !== undefined ||
        body.tool_choice.connector_id !== undefined ||
        body.tool_choice.container !== undefined) {
      throw codedError(
        'PROVIDER_HOSTED_TOOL_DENIED',
        'Provider-hosted tools are disabled by policy.',
        403
      );
    }
  } else if (typeof body?.tool_choice === 'string') inspectTool(body.tool_choice);
  for (const included of Array.isArray(body?.include) ? body.include : []) inspectTool(included);
  if (provider === 'codex' && Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (item?.type === 'additional_tools') assertCodexAdditionalTools(item);
      else if (item && typeof item === 'object' && Object.hasOwn(item, 'tools')) {
        providerToolDenied('Codex tools are only allowed in the exact developer envelope.');
      }
    }
  }
  // Defense in depth for every request shape, including provider-specific
  // nested input items. This catches dangerous identity or endpoint fields at
  // any depth even if a future client relocates tool declarations.
  assertNoNestedProviderCapabilities(body);
}

function parseRequestBody(buffer, provider, policy, routeKind) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > policy.maxRequestBytes) {
    throw codedError('PROVIDER_EGRESS_REQUEST_INVALID', 'Provider request size is invalid.', 413);
  }
  let body;
  const source = buffer.toString('utf8');
  try { body = JSON.parse(source); }
  catch { throw codedError('PROVIDER_EGRESS_REQUEST_INVALID', 'Provider request JSON is invalid.'); }
  assertNoDuplicateJsonMembers(source);
  assertNoProviderHostedTools(body, provider);
  assertProviderStatePolicy(body, provider);
  assertExactTopLevelRequest(body, provider, routeKind);
  normalizeCapturedClientEnvelope(body, provider, routeKind);
  assertNoProviderFetchedContent(body, provider);
  const model = String(body?.model || '');
  if (!policy.allowedModels.includes(model)) {
    throw codedError('PROVIDER_EGRESS_MODEL_DENIED', 'Provider model is outside policy.', 403);
  }
  const reasoningEffort = requestReasoningEffort(body, provider, model, routeKind);
  let outputTokens;
  if (routeKind === 'count_tokens') outputTokens = 1;
  else if (routeKind === 'compact') outputTokens = policy.maxOutputTokens;
  else {
    outputTokens = provider === 'claude'
      ? Number.parseInt(body.max_tokens, 10)
      : (Object.hasOwn(body, 'max_output_tokens') ? body.max_output_tokens : policy.maxOutputTokens);
  }
  if (!Number.isSafeInteger(outputTokens) || outputTokens <= 0 || outputTokens > policy.maxOutputTokens) {
    throw codedError('PROVIDER_EGRESS_OUTPUT_DENIED', 'Provider output token bound is invalid.', 403);
  }
  // An omitted tier can inherit Fast mode from the OpenAI project. The caller
  // cannot select a tier, and the broker pins standard processing explicitly
  // before reserving its standard text-token cost allowance.
  if (provider === 'codex') {
    body.service_tier = 'default';
    // The reserved output allowance must also constrain the upstream. The
    // pinned CLI omits this field; omission must never mean unbounded output.
    body.max_output_tokens = outputTokens;
  }
  // Never forward the ambiguous raw JSON bytes. Upstreams may apply a
  // different first/last-wins rule to duplicate object members than V8 did
  // during validation. Serialize the one validated object and reserve using
  // the larger representation so canonicalization cannot reduce accounting.
  const canonicalBuffer = Buffer.from(JSON.stringify(body));
  const requestBytes = Math.max(buffer.length, canonicalBuffer.length);
  const reservedTokens = requestBytes + outputTokens + TOKEN_RESERVATION_ENVELOPE;
  return {
    body,
    model,
    reasoningEffort,
    outputTokens,
    reservedTokens,
    requestBytes,
    canonicalBuffer,
  };
}

function reserveBudget(db, policy, {
  reservationId,
  launchId,
  capability,
  model,
  reasoningEffort,
  routeKind,
  requestBytes,
  reservedTokens,
  now = new Date(),
}) {
  const day = budgetDay(now);
  const costRate = costRateFor(policy, model);
  const reservedCostMicroUsd = reservedTokens * costRate;
  if (!Number.isSafeInteger(reservedTokens) || reservedTokens <= 0 ||
      !Number.isSafeInteger(reservedCostMicroUsd)) {
    throw codedError('PROVIDER_COST_RESERVATION_INVALID', 'Provider cost reservation is invalid.', 403);
  }
  const digest = capabilityHash(capability);
  const transaction = db.transaction(() => {
    const launch = db.prepare(
      'SELECT * FROM provider_egress_capabilities WHERE launch_id = ?'
    ).get(launchId);
    let routeKinds = null;
    try { routeKinds = JSON.parse(launch?.route_kinds_json || 'null'); }
    catch { routeKinds = null; }
    if (!launch || launch.state !== 'active' || launch.expires_at_ms <= now.getTime() ||
        !hashesEqual(launch.capability_hash, digest) || launch.model !== model ||
        (routeKind !== 'count_tokens' && launch.reasoning_effort !== reasoningEffort) ||
        launch.mode !== 'managed' || !Array.isArray(routeKinds) || !routeKinds.includes(routeKind)) {
      throw codedError('PROVIDER_CAPABILITY_DENIED', 'Provider launch capability is unavailable.', 401);
    }
    if (launch.used_requests >= launch.max_requests ||
        launch.used_reserved_tokens + reservedTokens > launch.max_reserved_tokens) {
      throw codedError('PROVIDER_LAUNCH_BUDGET_EXHAUSTED', 'Provider launch budget is exhausted.', 429);
    }
    const totals = dailyReservations(db, day);
    if (totals.requests >= policy.maxDailyRequests ||
        totals.tokens + reservedTokens > policy.maxDailyReservedTokens) {
      throw codedError('PROVIDER_EGRESS_BUDGET_EXHAUSTED', 'Provider daily budget is exhausted.', 429);
    }
    if (totals.reservedCostMicroUsd + reservedCostMicroUsd >
        policy.maxDailyReservedCostMicroUsd) {
      throw codedError('PROVIDER_EGRESS_COST_BUDGET_EXHAUSTED',
        'Provider daily cost allowance is exhausted.', 429);
    }
    assertNewProviderStateAdmission(db);
    db.prepare(`
      INSERT INTO provider_egress_reservations (
        reservation_id, launch_id, budget_day, model, route_kind,
        reserved_tokens, request_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reservationId, launchId, day, model, routeKind,
      reservedTokens, requestBytes, now.toISOString()
    );
    db.prepare(`
      INSERT INTO provider_egress_cost_reservations (
        reservation_id, reserved_cost_micro_usd
      ) VALUES (?, ?)
    `).run(reservationId, reservedCostMicroUsd);
    db.prepare(`
      UPDATE provider_egress_capabilities
      SET used_requests = used_requests + 1,
          used_reserved_tokens = used_reserved_tokens + ?
      WHERE launch_id = ? AND state = 'active'
    `).run(reservedTokens, launchId);
  });
  transaction.immediate();
}

function budgetStatus(db, policy, now = new Date()) {
  const day = budgetDay(now);
  const total = dailyReservations(db, day);
  const costRateMicroUsdPerToken = costRateFor(policy);
  const models = db.prepare(`
    SELECT model, COUNT(*) AS requests, COALESCE(SUM(reserved_tokens), 0) AS reservedTokens
    FROM provider_egress_reservations WHERE budget_day = ?
    GROUP BY model ORDER BY model
  `).all(day);
  return {
    budgetDay: day,
    usedRequests: total.requests,
    remainingRequests: Math.max(0, policy.maxDailyRequests - total.requests),
    usedReservedTokens: total.tokens,
    remainingReservedTokens: Math.max(0, policy.maxDailyReservedTokens - total.tokens),
    costRateMicroUsdPerToken,
    usedReservedCostMicroUsd: total.reservedCostMicroUsd,
    remainingReservedCostMicroUsd: Math.max(
      0, policy.maxDailyReservedCostMicroUsd - total.reservedCostMicroUsd
    ),
    costRatesMicroUsdPerToken: Object.fromEntries(
      policy.allowedModels.map((model) => [model, costRateFor(policy, model)])
    ),
    models,
  };
}

function normalizedAnthropicHeaders(incoming, _policy = {}, routeKind = 'inference', model = '') {
  const rawVersion = incoming['anthropic-version'];
  if (Array.isArray(rawVersion) || String(rawVersion || '').trim() !== ANTHROPIC_VERSION) {
    throw codedError(
      'PROVIDER_ANTHROPIC_HEADER_DENIED',
      'The Anthropic protocol version is outside policy.',
      403
    );
  }
  const headers = { 'anthropic-version': ANTHROPIC_VERSION };
  const rawBeta = incoming['anthropic-beta'];
  if (rawBeta === undefined || rawBeta === '') {
    throw codedError('PROVIDER_ANTHROPIC_HEADER_DENIED', 'Anthropic beta negotiation is required.', 403);
  }
  if (Array.isArray(rawBeta) || Buffer.byteLength(String(rawBeta), 'utf8') > MAX_ANTHROPIC_BETA_HEADER_BYTES) {
    throw codedError('PROVIDER_ANTHROPIC_HEADER_DENIED', 'Anthropic beta negotiation is outside policy.', 403);
  }
  const betaTokens = String(rawBeta).split(',').map((token) => token.trim());
  const expected = anthropicBetasForModel(model, routeKind);
  if (!expected) {
    throw codedError('PROVIDER_EGRESS_MODEL_DENIED', 'Provider model is outside policy.', 403);
  }
  const allowed = new Set(expected);
  if (betaTokens.length === 0 || betaTokens.some((token) => !ANTHROPIC_BETA_TOKEN.test(token)) ||
      new Set(betaTokens).size !== betaTokens.length ||
      betaTokens.length !== expected.length || betaTokens.some((token) => !allowed.has(token))) {
    throw codedError('PROVIDER_ANTHROPIC_HEADER_DENIED', 'Anthropic beta negotiation is outside policy.', 403);
  }
  headers['anthropic-beta'] = expected.join(',');
  return headers;
}

function exactUpstreamPath(provider, url) {
  if (provider === 'claude') {
    if (['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname) &&
        url.search === '?beta=true') {
      return `${url.pathname}?beta=true`;
    }
    throw codedError('PROVIDER_EGRESS_PATH_DENIED', 'Provider path is outside policy.', 403);
  }
  if (!url.search) return url.pathname;
  throw codedError('PROVIDER_EGRESS_PATH_DENIED', 'Provider path is outside policy.', 403);
}

function sanitizedHeaders(
  provider,
  incoming,
  credential,
  policy = {},
  routeKind = 'inference',
  model = ''
) {
  const headers = {
    'content-type': 'application/json',
    accept: String(incoming.accept || 'text/event-stream, application/json').slice(0, 200),
    'user-agent': 'teleagent-provider-egress/1',
  };
  if (provider === 'claude') {
    headers['x-api-key'] = credential;
    Object.assign(headers, normalizedAnthropicHeaders(incoming, policy, routeKind, model));
  } else {
    if (incoming['openai-project'] !== undefined ||
        incoming['openai-organization'] !== undefined) {
      throw codedError('PROVIDER_PROJECT_HEADER_DENIED',
        'Caller-selected provider project is outside policy.', 403);
    }
    if (typeof policy.openaiProjectId !== 'string' ||
        !OPENAI_PROJECT_ID.test(policy.openaiProjectId)) {
      throw codedError('PROVIDER_PROJECT_UNBOUND',
        'OpenAI project binding is unavailable.', 503);
    }
    headers.authorization = `Bearer ${credential}`;
    headers['openai-project'] = policy.openaiProjectId;
  }
  return headers;
}

function jsonResponse(res, status, value) {
  const payload = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function jsonError(res, error) {
  jsonResponse(res, Number.isInteger(error?.status) ? error.status : 502, {
    success: false,
    code: String(error?.code || 'PROVIDER_EGRESS_FAILED').slice(0, 100),
    error: 'The bounded provider egress request was refused.',
  });
}

async function readJson(req, maxBytes = MAX_CONTROL_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw codedError('PROVIDER_CONTROL_INVALID', 'Control frame is too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw codedError('PROVIDER_CONTROL_INVALID', 'Control frame is invalid.'); }
}

function createProviderEgressBroker({
  config,
  db,
  httpsRequest = https.request,
  randomId = () => crypto.randomBytes(24).toString('hex'),
} = {}) {
  if (!config?.spec || !config?.policy || !config?.credential || !db?.prepare) {
    throw new Error('Provider egress broker configuration is required.');
  }
  let active = 0;
  let closing = false;
  let closePromise = null;
  const requests = new Set();
  const upstreamsByLaunch = new Map();

  const trackUpstream = (launchId, upstream) => {
    let resolveDone;
    const entry = {
      upstream,
      done: new Promise((resolve) => { resolveDone = resolve; }),
      resolved: false,
      responseStarted: false,
    };
    const entries = upstreamsByLaunch.get(launchId) || new Set();
    entries.add(entry);
    upstreamsByLaunch.set(launchId, entries);
    entry.release = () => {
      if (entry.resolved) return;
      entry.resolved = true;
      entries.delete(entry);
      if (entries.size === 0) upstreamsByLaunch.delete(launchId);
      resolveDone();
    };
    upstream.once('close', () => {
      if (!entry.responseStarted) entry.release();
    });
    upstream.once('error', entry.release);
    return entry;
  };

  const abortLaunch = async (launchId) => {
    const entries = [...(upstreamsByLaunch.get(launchId) || [])];
    for (const entry of entries) {
      entry.response?.destroy(codedError(
        'PROVIDER_EGRESS_REVOKED',
        'Provider launch response was revoked.',
        503
      ));
      entry.upstream.destroy(codedError(
        'PROVIDER_EGRESS_REVOKED',
        'Provider launch egress was revoked.',
        503
      ));
    }
    await Promise.all(entries.map((entry) => entry.done));
    return !upstreamsByLaunch.has(launchId);
  };

  const abortAll = async () => {
    const launchIds = [...upstreamsByLaunch.keys()];
    const results = await Promise.all(launchIds.map(abortLaunch));
    return results.every(Boolean) && upstreamsByLaunch.size === 0;
  };
  const dataServer = http.createServer((req, res) => {
    const run = (async () => {
      if (closing) throw codedError('PROVIDER_EGRESS_DRAINING', 'Provider egress is draining.', 503);
      if (active >= config.policy.maxConcurrent) {
        throw codedError('PROVIDER_EGRESS_CONCURRENCY_EXHAUSTED', 'Provider concurrency is exhausted.', 429);
      }
      const url = new URL(req.url, 'http://provider-egress');
      const route = config.spec.routes[url.pathname];
      if (req.method !== 'POST' || !route) {
        throw codedError('PROVIDER_EGRESS_PATH_DENIED', 'Provider path is outside policy.', 403);
      }
      const upstreamPath = exactUpstreamPath(config.provider, url);
      const launchId = String(req.headers['x-teleagent-launch-id'] || '');
      const capability = String(req.headers['x-teleagent-launch-capability'] || '');
      if (!LAUNCH_ID.test(launchId) || !LAUNCH_CAPABILITY.test(capability)) {
        throw codedError('PROVIDER_CAPABILITY_DENIED', 'Provider launch capability is unavailable.', 401);
      }
      active += 1;
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > config.policy.maxRequestBytes) {
            throw codedError('PROVIDER_EGRESS_REQUEST_INVALID', 'Provider request is too large.', 413);
          }
          chunks.push(chunk);
        }
        const bodyBuffer = Buffer.concat(chunks);
        const parsed = parseRequestBody(bodyBuffer, config.provider, config.policy, route.kind);
        // Header policy is part of the exact provider capability boundary.
        // Validate it before reserving budget so rejected protocol/beta
        // negotiation cannot spend a launch allowance.
        const upstreamHeaders = sanitizedHeaders(
          config.provider,
          req.headers,
          config.credential,
          config.policy,
          route.kind,
          parsed.model
        );
        if (closing) {
          throw codedError('PROVIDER_EGRESS_DRAINING', 'Provider egress is draining.', 503);
        }
        reserveBudget(db, config.policy, {
          reservationId: randomId(), launchId, capability,
          model: parsed.model, routeKind: route.kind,
          reasoningEffort: parsed.reasoningEffort,
          requestBytes: parsed.requestBytes, reservedTokens: parsed.reservedTokens,
        });
        await new Promise((resolve, reject) => {
          const upstream = httpsRequest({
            hostname: config.spec.upstreamHost,
            port: 443,
            method: 'POST',
            path: upstreamPath,
            headers: {
              ...upstreamHeaders,
              'content-length': parsed.canonicalBuffer.length,
            },
            timeout: 30_000,
          }, (upstreamResponse) => {
            tracked.responseStarted = true;
            tracked.response = upstreamResponse;
            const release = () => tracked.release();
            res.writeHead(upstreamResponse.statusCode || 502, {
              'content-type': String(upstreamResponse.headers['content-type'] || 'application/json'),
              'cache-control': 'no-store',
            });
            let responseBytes = 0;
            upstreamResponse.on('data', (chunk) => {
              responseBytes += chunk.length;
              if (responseBytes > config.policy.maxResponseBytes) {
                upstreamResponse.destroy(codedError(
                  'PROVIDER_EGRESS_RESPONSE_TOO_LARGE',
                  'Provider response exceeded its bound.',
                  502
                ));
                return;
              }
              res.write(chunk);
            });
            upstreamResponse.once('end', () => { release(); res.end(); resolve(); });
            upstreamResponse.once('error', (error) => { release(); reject(error); });
          });
          const tracked = trackUpstream(launchId, upstream);
          upstream.once('timeout', () => upstream.destroy(new Error('upstream timeout')));
          upstream.once('error', (error) => { tracked.release(); reject(error); });
          upstream.end(parsed.canonicalBuffer);
        });
      } finally {
        active -= 1;
      }
    })();
    requests.add(run);
    void run.catch((error) => {
      if (!res.headersSent) jsonError(res, error);
      else res.destroy();
    }).finally(() => requests.delete(run));
  });

  const controlServer = http.createServer((req, res) => {
    const run = (async () => {
      const assertControlOpen = () => {
        if (closing) {
          throw codedError('PROVIDER_EGRESS_DRAINING', 'Provider egress is draining.', 503);
        }
      };
      assertControlOpen();
      const url = new URL(req.url, 'http://provider-control');
      if (url.search) throw codedError('PROVIDER_CONTROL_INVALID', 'Control path is invalid.', 403);
      if (req.method === 'GET' && url.pathname === '/v1/control/budget') {
        return jsonResponse(res, 200, { success: true, provider: config.provider,
          ...budgetStatus(db, config.policy) });
      }
      if (req.method !== 'POST') throw codedError('PROVIDER_CONTROL_INVALID', 'Control method is invalid.', 403);
      const input = await readJson(req);
      // Uploading the control frame is asynchronous. Close may have started
      // after admission, so fence again and immediately next to every durable
      // mutation below.
      assertControlOpen();
      if (input?.version !== 1 || input.provider !== config.provider) {
        throw codedError('PROVIDER_CONTROL_INVALID', 'Control identity is invalid.', 403);
      }
      if (url.pathname === '/v1/control/register') {
        assertControlOpen();
        const result = registerCapability(db, config.policy, {
          launchId: String(input.launchId || ''),
          capability: String(input.capability || ''),
          expiresAtMs: Number(input.expiresAtMs),
          model: String(input.model || ''),
          reasoningEffort: String(input.reasoningEffort || ''),
          routeKinds: Array.isArray(input.routeKinds) ? input.routeKinds.map(String) : null,
          mode: String(input.mode || ''),
          maxRequests: Number(input.maxRequests || config.policy.maxLaunchRequests),
          maxReservedTokens: Number(
            input.maxReservedTokens || config.policy.maxLaunchReservedTokens
          ),
        });
        return jsonResponse(res, 201, { success: true, ...result });
      }
      if (url.pathname === '/v1/control/revoke') {
        assertControlOpen();
        const result = revokeCapability(db, {
          launchId: String(input.launchId || ''),
          state: input.reason === 'completed' ? 'revoked' : 'canceled',
        });
        const quiesced = await abortLaunch(String(input.launchId || ''));
        return jsonResponse(res, 200, { success: quiesced, ...result, quiesced });
      }
      if (url.pathname === '/v1/control/recover') {
        assertControlOpen();
        const result = recoverCapabilities(db);
        const quiesced = await abortAll();
        return jsonResponse(res, 200, { success: quiesced, ...result, quiesced });
      }
      throw codedError('PROVIDER_CONTROL_INVALID', 'Control path is invalid.', 403);
    })();
    requests.add(run);
    void run.catch((error) => {
      if (!res.headersSent) jsonError(res, error);
      else res.destroy();
    }).finally(() => requests.delete(run));
  });

  return Object.freeze({
    server: dataServer,
    dataServer,
    controlServer,
    status: () => ({
      ready: !closing,
      active,
      activeLaunches: upstreamsByLaunch.size,
      pendingRequests: requests.size,
    }),
    abortLaunch,
    abortAll,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      // Revoke every launch before the first abort snapshot. A request already
      // blocked in body upload cannot reserve after the adjacent closing fence
      // above, and a stale capability cannot be reused after restart.
      recoverCapabilities(db);
      closePromise = (async () => {
        const stopped = [dataServer, controlServer].map((server) => (
          server.listening ? new Promise((resolve) => server.close(resolve)) : Promise.resolve()
        ));
        // server.close() stops new connections but intentionally waits for
        // admitted request bodies. A local client could otherwise hold a
        // partial upload forever and outlive systemd's bounded stop window.
        // Capabilities are already durably revoked above, so immediately tear
        // down every admitted HTTP connection and let each tracked handler
        // settle before the final recovery fence.
        dataServer.closeAllConnections?.();
        controlServer.closeAllConnections?.();
        await abortAll();
        await Promise.allSettled([...requests]);
        await abortAll();
        // No handler can now pass either control mutation fence. Revoke once
        // more after every admitted handler settles so clean shutdown cannot
        // leave an active capability behind.
        recoverCapabilities(db);
        await Promise.all(stopped);
        if (requests.size !== 0 || upstreamsByLaunch.size !== 0 || active !== 0) {
          throw new Error('Provider egress shutdown did not reach local quiescence.');
        }
      })();
      return closePromise;
    },
  });
}

async function startProviderEgressBroker({
  config = normalizeConfig(),
  openStore = openBudgetStore,
  createBroker = createProviderEgressBroker,
  createStorageGuard = createWorkerStateStorageGuard,
  verifySocketPaths = true,
} = {}) {
  const storage = createStorageGuard({
    role: `${config.provider}-egress`,
    expectedUid: config.uid,
    expectedGid: config.gid,
  });
  storage.assertNewWork();
  const db = openStore(config.spec.database, {
    uid: config.uid,
    gid: config.gid,
    storageAdmission: () => storage.assertNewWork(),
  });
  // A broker-only crash must never resurrect a bearer capability whose prior
  // request outcome may be ambiguous. Revoke synchronously before either
  // inherited listener becomes ready; the still-running provider process then
  // receives a deterministic 401 and is terminated by its launch boundary.
  let startupRecovery;
  try {
    startupRecovery = recoverCapabilities(db);
    pruneBudgetHistory(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const broker = createBroker({ config, db });
  try {
    await Promise.all([
      new Promise((resolve, reject) => {
        broker.dataServer.once('error', reject);
        broker.dataServer.listen({ fd: config.dataFd, exclusive: false }, resolve);
      }),
      new Promise((resolve, reject) => {
        broker.controlServer.once('error', reject);
        broker.controlServer.listen({ fd: config.controlFd, exclusive: false }, resolve);
      }),
    ]);
    if (verifySocketPaths && (socketPathForFd(config.dataFd) !== config.spec.socket ||
        socketPathForFd(config.controlFd) !== config.spec.controlSocket)) {
      throw new Error('Provider egress adopted the wrong socket.');
    }
  } catch (error) {
    await broker.close();
    db.close();
    throw error;
  }
  return Object.freeze({
    ...broker,
    storage,
    startupRecovery: Object.freeze({ ...startupRecovery }),
    async close() {
      await broker.close();
      db.close();
    },
  });
}

if (require.main === module) {
  let broker;
  startProviderEgressBroker().then((started) => {
    broker = started;
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => void broker.close().then(
        () => process.exit(0),
        () => process.exit(1)
      ));
    }
  }).catch((error) => {
    process.stderr.write(`Provider egress startup failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  PROVIDERS,
  TOKEN_RESERVATION_ENVELOPE,
  ANTHROPIC_COUNT_BETAS,
  ANTHROPIC_COUNT_BETAS_BY_MODEL,
  ANTHROPIC_INFERENCE_BETAS,
  ANTHROPIC_INFERENCE_BETAS_BY_MODEL,
  budgetDay,
  budgetStatus,
  assertNoProviderHostedTools,
  capabilityHash,
  createProviderEgressBroker,
  hashesEqual,
  groupGid,
  normalizeConfig,
  normalizeAllowedAnthropicBeta,
  normalizePolicy,
  openBudgetStore,
  parseRequestBody,
  readPolicy,
  rejectUnsafeEnvironment,
  validateCoordinatorEnvironment,
  recoverCapabilities,
  pruneBudgetHistory,
  registerCapability,
  reserveBudget,
  revokeCapability,
  sanitizedHeaders,
  exactUpstreamPath,
  socketPathForFd,
  startProviderEgressBroker,
};
