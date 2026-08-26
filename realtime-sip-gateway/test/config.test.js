import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConfigError, loadConfig } from '../src/config.js';

const secrets = {
  OPENAI_API_KEY: 'sk-proj-A9v2Q7m4N8x6R3k1W5z0',
  OPENAI_WEBHOOK_SECRET: 'whsec_1234567890123456',
};
const pbxSecret = 'A9v2Q7m4N8x6R3k1W5z0C2b7D4f9H6j3K8p1T5y0U2i7O4s9';

test('reject mode is the default and uses official endpoints', () => {
  const config = loadConfig(secrets);
  assert.equal(config.mode, 'reject');
  assert.equal(config.apiBaseUrl, 'https://api.openai.com/v1');
  assert.equal(config.realtimeWsUrl, 'wss://api.openai.com/v1/realtime');
  assert.equal(config.maxActiveCalls, 1);
  assert.equal(config.maxHttpConnections, 32);
  assert.equal(
    config.stateDatabasePath,
    '/var/lib/teleagent-sip-gateway/gateway-state.sqlite3',
  );
});

test('public HTTP connection concurrency is bounded and validated', () => {
  assert.equal(loadConfig({ ...secrets, SIP_MAX_HTTP_CONNECTIONS: '7' }).maxHttpConnections, 7);
  assert.throws(
    () => loadConfig({ ...secrets, SIP_MAX_HTTP_CONNECTIONS: '0' }),
    /SIP_MAX_HTTP_CONNECTIONS must be between 1 and 1000/u,
  );
});

test('accept mode requires an exact caller allowlist by default', () => {
  assert.throws(
    () => loadConfig({
      ...secrets,
      SIP_GATEWAY_MODE: 'accept',
      SIP_PBX_AUTH_SECRET: pbxSecret,
    }),
    (error) => error instanceof ConfigError && /SIP_ALLOWED_FROM/u.test(error.message),
  );
});

test('accept mode permits an explicit exact caller', () => {
  const config = loadConfig({
    ...secrets,
    SIP_GATEWAY_MODE: 'accept',
    SIP_PBX_AUTH_SECRET: pbxSecret,
    SIP_ALLOWED_FROM: 'sip:canary@asterisk.test',
  });
  assert.deepEqual(config.allowedFrom, ['sip:canary@asterisk.test']);
  assert.equal(config.allowAllCallers, false);
  assert.equal(config.pbxPrincipal, 'hermes-private-pbx');
});

test('accept mode fails startup without a high-entropy private PBX credential', () => {
  assert.throws(
    () => loadConfig({
      ...secrets,
      SIP_GATEWAY_MODE: 'accept',
      SIP_ALLOWED_FROM: 'sip:canary@asterisk.test',
    }),
    /SIP_PBX_AUTH_SECRET/u,
  );
  assert.throws(
    () => loadConfig({
      ...secrets,
      SIP_GATEWAY_MODE: 'accept',
      SIP_ALLOWED_FROM: 'sip:canary@asterisk.test',
      SIP_PBX_AUTH_SECRET: 'too-short-for-a-pbx-secret',
    }),
    /at least 32 bytes/u,
  );
  assert.throws(
    () => loadConfig({
      ...secrets,
      SIP_GATEWAY_MODE: 'accept',
      SIP_ALLOWED_FROM: 'sip:canary@asterisk.test',
      SIP_PBX_AUTH_SECRET: 'a'.repeat(64),
    }),
    /sufficient character diversity/u,
  );
});

test('all controller credentials reject obvious deployment placeholders', () => {
  for (const [name, placeholder] of Object.entries({
    OPENAI_API_KEY: 'sk-replace-with-openai-api-key',
    OPENAI_WEBHOOK_SECRET: 'whsec_CHANGE_ME_webhook_secret',
    SIP_PBX_AUTH_SECRET: 'example-pbx-auth-secret-012345678901234567890',
  })) {
    assert.throws(
      () => loadConfig({
        ...secrets,
        SIP_GATEWAY_MODE: 'accept',
        SIP_ALLOWED_FROM: 'sip:canary@asterisk.test',
        SIP_PBX_AUTH_SECRET: pbxSecret,
        [name]: placeholder,
      }),
      (error) => error instanceof ConfigError
        && error.message === `${name} contains an obvious placeholder and cannot be used`,
    );
  }
});

test('custom OpenAI endpoint requires an explicit escape hatch', () => {
  assert.throws(
    () => loadConfig({ ...secrets, OPENAI_BASE_URL: 'https://example.test/v1' }),
    /SIP_ALLOW_CUSTOM_OPENAI_ENDPOINTS/u,
  );
  const config = loadConfig({
    ...secrets,
    OPENAI_BASE_URL: 'https://example.test/v1',
    OPENAI_REALTIME_WS_URL: 'wss://example.test/realtime',
    SIP_ALLOW_CUSTOM_OPENAI_ENDPOINTS: 'true',
  });
  assert.equal(config.apiBaseUrl, 'https://example.test/v1');
});

test('non-loopback HTTP bind requires an explicit escape hatch', () => {
  assert.throws(
    () => loadConfig({ ...secrets, SIP_GATEWAY_HOST: '0.0.0.0' }),
    /SIP_ALLOW_NON_LOOPBACK_BIND/u,
  );
  assert.equal(loadConfig({
    ...secrets,
    SIP_GATEWAY_HOST: '0.0.0.0',
    SIP_ALLOW_NON_LOOPBACK_BIND: 'true',
  }).host, '0.0.0.0');
});

test('secrets and identifiers reject whitespace or control characters', () => {
  assert.throws(() => loadConfig({ ...secrets, OPENAI_API_KEY: 'not valid secret value' }));
  assert.throws(() => loadConfig({ ...secrets, OPENAI_REALTIME_MODEL: 'bad/model' }));
  assert.throws(() => loadConfig({ ...secrets, SIP_GATEWAY_HOST: '127.0.0.1\nBAD' }));
});

test('secrets can be loaded from the systemd credentials directory', (context) => {
  const credentialsDirectory = mkdtempSync(path.join(tmpdir(), 'teleagent-sip-credentials-'));
  context.after(() => rmSync(credentialsDirectory, { recursive: true, force: true }));
  writeFileSync(path.join(credentialsDirectory, 'OPENAI_API_KEY'), `${secrets.OPENAI_API_KEY}\n`, {
    mode: 0o400,
  });
  writeFileSync(
    path.join(credentialsDirectory, 'OPENAI_WEBHOOK_SECRET'),
    `${secrets.OPENAI_WEBHOOK_SECRET}\n`,
    { mode: 0o400 },
  );

  const config = loadConfig({ CREDENTIALS_DIRECTORY: credentialsDirectory });
  assert.equal(config.apiKey, secrets.OPENAI_API_KEY);
  assert.equal(config.webhookSecret, secrets.OPENAI_WEBHOOK_SECRET);
});

test('a placeholder in a hardened credential file still fails startup', (context) => {
  const credentialsDirectory = mkdtempSync(path.join(tmpdir(), 'teleagent-placeholder-secret-'));
  context.after(() => rmSync(credentialsDirectory, { recursive: true, force: true }));
  writeFileSync(
    path.join(credentialsDirectory, 'OPENAI_API_KEY'),
    'sk-replace-with-openai-api-key',
    { mode: 0o400 },
  );
  writeFileSync(
    path.join(credentialsDirectory, 'OPENAI_WEBHOOK_SECRET'),
    secrets.OPENAI_WEBHOOK_SECRET,
    { mode: 0o400 },
  );

  assert.throws(
    () => loadConfig({ CREDENTIALS_DIRECTORY: credentialsDirectory }),
    /OPENAI_API_KEY contains an obvious placeholder/u,
  );
});

test('accept-mode PBX credential can be loaded from the hardened systemd credential file', (context) => {
  const credentialsDirectory = mkdtempSync(path.join(tmpdir(), 'teleagent-pbx-credentials-'));
  context.after(() => rmSync(credentialsDirectory, { recursive: true, force: true }));
  for (const [name, value] of Object.entries({
    ...secrets,
    SIP_PBX_AUTH_SECRET: pbxSecret,
  })) {
    writeFileSync(path.join(credentialsDirectory, name), `${value}\n`, { mode: 0o400 });
  }
  const config = loadConfig({
    CREDENTIALS_DIRECTORY: credentialsDirectory,
    SIP_GATEWAY_MODE: 'accept',
    SIP_ALLOWED_FROM: 'sip:canary@asterisk.test',
  });
  assert.equal(config.pbxAuthSecret, pbxSecret);
});

test('an explicit secret file must be absolute and cannot override a direct secret', (context) => {
  const credentialsDirectory = mkdtempSync(path.join(tmpdir(), 'teleagent-sip-secret-file-'));
  context.after(() => rmSync(credentialsDirectory, { recursive: true, force: true }));
  const apiKeyFile = path.join(credentialsDirectory, 'api-key');
  writeFileSync(apiKeyFile, secrets.OPENAI_API_KEY, { mode: 0o400 });

  assert.throws(
    () => loadConfig({
      ...secrets,
      OPENAI_API_KEY_FILE: apiKeyFile,
    }),
    /cannot both be set/u,
  );
  assert.throws(
    () => loadConfig({
      OPENAI_API_KEY_FILE: 'relative-api-key',
      OPENAI_WEBHOOK_SECRET: secrets.OPENAI_WEBHOOK_SECRET,
    }),
    /absolute path/u,
  );
});

test('secret files must be regular and bounded', (context) => {
  const credentialsDirectory = mkdtempSync(path.join(tmpdir(), 'teleagent-sip-secret-bounds-'));
  context.after(() => rmSync(credentialsDirectory, { recursive: true, force: true }));
  const directoryPath = path.join(credentialsDirectory, 'not-a-file');
  mkdirSync(directoryPath);

  assert.throws(
    () => loadConfig({
      OPENAI_API_KEY_FILE: directoryPath,
      OPENAI_WEBHOOK_SECRET: secrets.OPENAI_WEBHOOK_SECRET,
    }),
    /regular file/u,
  );
});

test('secret files reject group-readable credentials and hard links', (context) => {
  const credentialsDirectory = mkdtempSync(path.join(tmpdir(), 'teleagent-sip-secret-mode-'));
  context.after(() => rmSync(credentialsDirectory, { recursive: true, force: true }));
  const looseFile = path.join(credentialsDirectory, 'loose-api-key');
  writeFileSync(looseFile, secrets.OPENAI_API_KEY, { mode: 0o440 });
  assert.throws(
    () => loadConfig({
      OPENAI_API_KEY_FILE: looseFile,
      OPENAI_WEBHOOK_SECRET: secrets.OPENAI_WEBHOOK_SECRET,
    }),
    /no group or other permissions/u,
  );

  const linkedFile = path.join(credentialsDirectory, 'linked-api-key');
  writeFileSync(linkedFile, secrets.OPENAI_API_KEY, { mode: 0o400 });
  const secondLink = path.join(credentialsDirectory, 'second-link');
  linkSync(linkedFile, secondLink);
  assert.throws(
    () => loadConfig({
      OPENAI_API_KEY_FILE: linkedFile,
      OPENAI_WEBHOOK_SECRET: secrets.OPENAI_WEBHOOK_SECRET,
    }),
    /one link/u,
  );
});
