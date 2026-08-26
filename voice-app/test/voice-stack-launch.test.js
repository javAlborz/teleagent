'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertPanicQuiesced,
  assertVoiceExit,
  activationGenerationForTransition,
  activationRequiresRecovery,
  cleanupEvidenceDisposition,
  cleanupExactProject,
  cleanupRequiresPanicRecovery,
  normalizeActivationState,
  normalizeVoiceImageManifest,
  parseDockerCgroupInfo,
  parseVoiceContainerBoundary,
  parseVoiceEnvironmentFile,
  parseExactProjectContainerIds,
  requestJson,
  renderTemplateContents,
  requireDockerCgroupBoundary,
  runOfflineRecovery,
  startFailureDisposition,
  verifyBoundedHostStateFilesystem,
  verifyVoiceAppRuntimeContract,
  verifyVoiceImage,
  verifyExactProjectContainerBoundary,
  FIXED_VOICE_APP_BOUNDARY_ENV,
  MAX_CONTROL_RESPONSE_BYTES,
} = require('../../deploy/voice-stack/teleagent-voice-stack-launch');
const voiceAppRuntimeContract = require('../../lib/voice-app-runtime-env');

const IMAGE_MANIFEST = Object.freeze({
  version: 2,
  sourceRevision: 'c'.repeat(40),
  platform: 'linux/amd64',
  configDigest: `sha256:${'b'.repeat(64)}`,
  runtimeReference: `sha256:${'b'.repeat(64)}`,
  registryReference: null,
  registryManifestDigest: null,
});

const PROMOTED_IMAGE_MANIFEST = Object.freeze({
  ...IMAGE_MANIFEST,
  runtimeReference: `registry.example/teleagent/voice-app@sha256:${'a'.repeat(64)}`,
  registryReference: `registry.example/teleagent/voice-app@sha256:${'a'.repeat(64)}`,
  registryManifestDigest: `sha256:${'a'.repeat(64)}`,
});

function directoryMetadata({ uid = 0, gid = 0, mode = 0o755, dev = 100, ino = 1,
  symlink = false } = {}) {
  return {
    uid,
    gid,
    mode,
    dev,
    ino,
    isDirectory: () => !symlink,
    isSymbolicLink: () => symlink,
  };
}

function hostStateFilesystem({ stateDevice = 200, stateSymlink = false,
  replacementInode = null } = {}) {
  const ancestors = new Map([
    ['/', directoryMetadata({ ino: 1 })],
    ['/var', directoryMetadata({ ino: 2 })],
    ['/var/lib', directoryMetadata({ ino: 3 })],
  ]);
  let stateReads = 0;
  return {
    lstatSync(filename) {
      if (filename !== '/var/lib/teleagent-voice') return ancestors.get(filename);
      stateReads += 1;
      return directoryMetadata({
        uid: 989,
        gid: 989,
        mode: 0o700,
        dev: stateDevice,
        ino: stateReads > 1 && replacementInode !== null ? replacementInode : 4,
        symlink: stateSymlink,
      });
    },
    realpathSync(filename) { return filename; },
    statfsSync() {
      return { bsize: 4096n, blocks: 1048576n, bavail: 524288n };
    },
  };
}

test('root launcher requires the exact voice-state path to be a bounded submount', () => {
  assert.deepEqual(verifyBoundedHostStateFilesystem({ uid: 989, gid: 989 }, {
    fsModule: hostStateFilesystem(),
  }), {
    capacity: 4n * 1024n * 1024n * 1024n,
    available: 2n * 1024n * 1024n * 1024n,
    requiredFree: 858993460n,
  });

  assert.throws(() => verifyBoundedHostStateFilesystem({ uid: 989, gid: 989 }, {
    fsModule: hostStateFilesystem({ stateDevice: 100 }),
  }), /not an exact dedicated filesystem mountpoint/);
  assert.throws(() => verifyBoundedHostStateFilesystem({ uid: 989, gid: 989 }, {
    fsModule: hostStateFilesystem({ stateSymlink: true }),
  }), /mountpoint has unsafe metadata/);
  assert.throws(() => verifyBoundedHostStateFilesystem({ uid: 989, gid: 989 }, {
    fsModule: hostStateFilesystem({ replacementInode: 99 }),
  }), /changed during verification/);
});

test('root launcher closes fixed voice state/listener values against host overrides', () => {
  assert.equal(verifyVoiceAppRuntimeContract(voiceAppRuntimeContract), true);
  assert.deepEqual(FIXED_VOICE_APP_BOUNDARY_ENV, {
    HTTP_HOST: '127.0.0.1',
    OUTBOUND_API_NON_LOOPBACK_ENABLED: 'false',
    VOICE_APP_EXECUTION_LOCK_FILE: '/app/state/voice-execution.lock.json',
    VOICE_STATE_DB_PATH: '/app/state/voice-state.sqlite',
    WS_ALLOWED_PEERS: '',
    WS_CONNECT_HOST: '127.0.0.1',
    WS_HOST: '127.0.0.1',
    WS_NON_LOOPBACK_ENABLED: 'false',
  });

  assert.throws(() => verifyVoiceAppRuntimeContract({
    ...voiceAppRuntimeContract,
    VOICE_APP_FIXED_ENV: {
      ...voiceAppRuntimeContract.VOICE_APP_FIXED_ENV,
      VOICE_STATE_DB_PATH: '/tmp/teleagent/voice-state.sqlite',
    },
  }), /fixed state\/listener contract drifted/);
  assert.throws(() => verifyVoiceAppRuntimeContract({
    ...voiceAppRuntimeContract,
    VOICE_APP_RUNTIME_ENV_KEYS: [
      ...voiceAppRuntimeContract.VOICE_APP_RUNTIME_ENV_KEYS,
      'HTTP_HOST',
    ],
  }), /fixed state\/listener contract drifted/);

  const identity = { uid: 989, gid: 990 };
  const base = [
    'VOICE_APP_UID=989',
    'VOICE_APP_GID=990',
    'DEVICE_CONFIG_DIR=/etc/teleagent-voice/config',
    'VOICE_STATE_DIR=/var/lib/teleagent-voice',
    '',
  ].join('\n');
  assert.deepEqual(parseVoiceEnvironmentFile(base, identity, voiceAppRuntimeContract), {
    VOICE_APP_UID: '989',
    VOICE_APP_GID: '990',
    DEVICE_CONFIG_DIR: '/etc/teleagent-voice/config',
    VOICE_STATE_DIR: '/var/lib/teleagent-voice',
  });
  for (const [name, values] of Object.entries({
    VOICE_STATE_DB_PATH: ['', '/app/state/voice-state.sqlite', '/tmp/voice-state.sqlite'],
    VOICE_APP_EXECUTION_LOCK_FILE: ['', '/app/state/voice-execution.lock.json', '/tmp/voice.lock'],
    HTTP_HOST: ['', '127.0.0.1', '0.0.0.0'],
    WS_HOST: ['', '127.0.0.1', '0.0.0.0'],
    WS_CONNECT_HOST: ['', '127.0.0.1', '10.0.0.8'],
    WS_ALLOWED_PEERS: ['', '127.0.0.1', '10.0.0.8'],
    WS_NON_LOOPBACK_ENABLED: ['', 'false', 'true'],
    OUTBOUND_API_NON_LOOPBACK_ENABLED: ['', 'false', 'true'],
  })) {
    for (const value of values) {
      assert.throws(
        () => parseVoiceEnvironmentFile(
          `${base}${name}=${value}\n`, identity, voiceAppRuntimeContract
        ),
        /unreviewed setting/,
        `${name}=${value}`,
      );
    }
  }
});

test('stack shutdown refuses persisted-but-unquiesced panic and forced exits', () => {
  assert.equal(assertPanicQuiesced({ status: 200, body: { success: true } }), true);
  for (const response of [
    { status: 202, body: { success: true } },
    { status: 503, body: { success: false } },
    { status: 200, body: { success: false } },
  ]) assert.throws(() => assertPanicQuiesced(response), /full quiescence was not confirmed/);

  assert.equal(assertVoiceExit('exited 0'), true);
  for (const state of ['exited 1', 'exited 137', 'running 0', '']) {
    assert.throws(() => assertVoiceExit(state), /clean, quiescent shutdown/);
  }
});

test('failed stack start never clears panic evidence after Compose activation was attempted', () => {
  assert.deepEqual(startFailureDisposition(false), {
    phase: 'inactive', panic: 'not_requested', cleanup: 'proved',
  });
  assert.deepEqual(startFailureDisposition(true), {
    phase: 'panic_outcome_unknown', panic: 'outcome_unknown', cleanup: 'proved',
  });
  assert.throws(() => startFailureDisposition('yes'), /attempt evidence is invalid/);

  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'deploy', 'voice-stack', 'teleagent-voice-stack-launch.js'),
    'utf8',
  );
  const startBody = source.slice(source.indexOf('async function start()'),
    source.indexOf('async function stop()'));
  assert.ok(startBody.indexOf('activationAttempted = true') < startBody.indexOf("composeArgs('up'"));
  assert.match(startBody, /startFailureDisposition\(activationAttempted\)/);
  assert.doesNotMatch(startBody,
    /catch \(error\)[\s\S]*rollbackStartedStack\(environment\)[\s\S]*persistActivationState\('inactive'/);
});

test('root control client bounds advertised and streamed response bodies', async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/valid') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"success":true}');
      return;
    }
    if (request.url === '/advertised-too-large') {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_CONTROL_RESPONSE_BYTES + 1),
      });
      response.end('{}');
      return;
    }
    if (request.url === '/slow-trickle') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{');
      const interval = setInterval(() => response.write(' '), 10);
      response.once('close', () => clearInterval(interval));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write(Buffer.alloc(MAX_CONTROL_RESPONSE_BYTES, 0x20));
    response.end('x');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  assert.deepEqual(await requestJson({ method: 'GET', pathname: '/valid', port }), {
    status: 200,
    body: { success: true },
  });
  await assert.rejects(
    requestJson({ method: 'GET', pathname: '/advertised-too-large', port }),
    /exceeded its byte bound/,
  );
  await assert.rejects(
    requestJson({ method: 'GET', pathname: '/streamed-too-large', port }),
    /exceeded its byte bound/,
  );
  await assert.rejects(
    requestJson({ method: 'GET', pathname: '/slow-trickle', port, timeoutMs: 80 }),
    /total deadline/,
  );
});

test('protected media templates require every exact placeholder once', () => {
  const template = path.join(__dirname, '..', '..', 'deploy', 'voice-stack', 'drachtio.conf.xml.template');
  const source = fs.readFileSync(template, 'utf8');
  const rendered = renderTemplateContents(source, {
    __DRACHTIO_SECRET__: 'sentinel_0123456789abcdef_ABCDEFGH',
    __DRACHTIO_EXTERNAL_IP__: '127.0.0.1',
    __DRACHTIO_SIP_PORT__: '5070',
    __DRACHTIO_SIP_TRANSPORT__: 'udp',
  });
  assert.doesNotMatch(rendered, /__[A-Z0-9_]+__/);
  assert.match(rendered, /<admin port="9022" secret="sentinel_/);
  assert.throws(
    () => renderTemplateContents(source, { __DRACHTIO_SECRET__: 'only-one-replacement' }),
    /unresolved/,
  );
});

test('wrapper never puts credentials in Docker argv or inherited environment', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'deploy', 'voice-stack', 'teleagent-voice-stack-launch.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /composeArgs\([^)]*(?:secret|token|password)/i);
  assert.match(source, /--env-file', '\/dev\/null'/);
  assert.match(source, /--no-build', '--pull', 'never'/);
  assert.match(source, /assertPanicQuiesced\(panic\)[\s\S]*assertVoiceExit\(inspection\)[\s\S]*composeArgs\('down'/);
  assert.match(source, /requireControllerReady\(\)/);
  assert.match(source, /body\?\.ready !== true/);
  assert.match(source, /teleagent-provider-cli-check/);
  assert.match(source, /teleagent-provider-model \(enforce\)/);
  assert.match(source, /teleagent-sip-local-peer-fence/);
  assert.match(source, /label=\$\{PROJECT_LABEL}/);
  assert.match(source, /container', 'rm', '--force'/);
  assert.match(source, /cleanup could not prove zero project containers and listeners/);
  assert.match(source, /persistActivationState\('panic_outcome_unknown'/);
  assert.doesNotMatch(source, /Preserve containers and projected credentials/);

  const startBody = source.slice(source.indexOf('async function start()'),
    source.indexOf('async function stop()'));
  for (const [before, after] of [
    ['activationRequiresRecovery(readActivationState())', 'cleanupExactProject()'],
    ['verifyVoiceImage(imageManifest)', 'readCredentialSet(identity, settings)'],
    ["persistActivationState('starting'", "composeArgs('up'"],
    ['beginActivation: true', "composeArgs('up'"],
    ['requireActiveUnit(CONTAINER_SLICE)', "composeArgs('up'"],
    ['requireDockerCgroupBoundary()', "composeArgs('up'"],
    ['verifyExactProjectContainerBoundary(startingState.activationGeneration',
      "persistActivationState('active'"],
    ['resolveVoiceIdentity()', 'verifyBoundedHostStateFilesystem(identity)'],
    ['verifyBoundedHostStateFilesystem(identity)', 'readEnvironmentFile(identity)'],
  ]) {
    assert.notEqual(startBody.indexOf(before), -1);
    assert.notEqual(startBody.indexOf(after), -1);
    assert.ok(startBody.indexOf(before) < startBody.indexOf(after));
  }
});

test('voice image release manifest is canonical, immutable, and resolved before use', () => {
  const encoded = `${JSON.stringify(IMAGE_MANIFEST)}\n`;
  assert.deepEqual(normalizeVoiceImageManifest(encoded), IMAGE_MANIFEST);
  assert.deepEqual(normalizeVoiceImageManifest(
    `${JSON.stringify(PROMOTED_IMAGE_MANIFEST)}\n`
  ), PROMOTED_IMAGE_MANIFEST);
  for (const invalid of [
    { ...IMAGE_MANIFEST, runtimeReference: 'registry.example/teleagent/voice-app:latest' },
    { ...IMAGE_MANIFEST, configDigest: `sha256:${'z'.repeat(64)}` },
    { ...IMAGE_MANIFEST, sourceRevision: 'main' },
    { ...IMAGE_MANIFEST, platform: 'linux/arm64' },
    { ...PROMOTED_IMAGE_MANIFEST, registryManifestDigest: `sha256:${'d'.repeat(64)}` },
    { ...PROMOTED_IMAGE_MANIFEST, runtimeReference: IMAGE_MANIFEST.configDigest },
  ]) {
    assert.throws(() => normalizeVoiceImageManifest(`${JSON.stringify(invalid)}\n`),
      /(?:immutable provenance|not bound)/);
  }
  assert.throws(() => normalizeVoiceImageManifest(
    `{"version":2,"version":2,"sourceRevision":"${IMAGE_MANIFEST.sourceRevision}",` +
    `"platform":"linux/amd64","configDigest":"${IMAGE_MANIFEST.configDigest}",` +
    `"runtimeReference":"${IMAGE_MANIFEST.runtimeReference}","registryReference":null,` +
    `"registryManifestDigest":null}\n`
  ), /not canonical/);

  const calls = [];
  const runCommand = (_filename, args) => {
    calls.push(args);
    return {
      status: 0,
      stdout: args.includes('{{.Id}}') ? `${IMAGE_MANIFEST.configDigest}\n` :
        args.includes('{{.Os}}/{{.Architecture}}') ? `${IMAGE_MANIFEST.platform}\n` :
          `${IMAGE_MANIFEST.sourceRevision}\n`,
    };
  };
  assert.equal(verifyVoiceImage(IMAGE_MANIFEST, { runCommand, environment: {} }), true);
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
    ['image', 'inspect', '--format'],
    ['image', 'inspect', '--format'],
    ['image', 'inspect', '--format'],
  ]);
  assert.throws(() => verifyVoiceImage(IMAGE_MANIFEST, {
    environment: {},
    runCommand: () => ({ status: 0, stdout: 'sha256:unreviewed\n' }),
  }), /resolved voice image ID differs/);
});

test('exact-project cleanup removes only the guarded Compose project and proves zero', () => {
  const identifier = 'd'.repeat(64);
  let listings = 0;
  const calls = [];
  const runCommand = (_filename, args) => {
    calls.push(args);
    if (args[0] === 'container' && args[1] === 'ls') {
      listings += 1;
      return { status: 0, stdout: listings === 1 ? `${identifier}\n` : '' };
    }
    return { status: 0, stdout: `${identifier}\n` };
  };
  assert.equal(cleanupExactProject({ runCommand, environment: {} }), 1);
  assert.deepEqual(calls[1], ['container', 'rm', '--force', identifier]);
  assert.ok(calls[0].includes('label=com.docker.compose.project=teleagent-voice'));
  assert.deepEqual(parseExactProjectContainerIds(`${identifier}\n`), [identifier]);
  assert.throws(() => parseExactProjectContainerIds('voice-app\n'), /listing is invalid/);
});

test('activation state is canonical, image-bound, generation-monotonic, and missing-safe', () => {
  const active = {
    version: 2,
    project: 'teleagent-voice',
    activationGeneration: 7,
    phase: 'active',
    previousPhase: 'starting',
    panic: 'not_requested',
    cleanup: 'required',
    imageManifest: IMAGE_MANIFEST,
    panicOutcomeUnknownAt: null,
    interruptedStartRecoveredAt: null,
    updatedAt: '2026-08-26T12:34:56.789Z',
  };
  assert.deepEqual(normalizeActivationState(`${JSON.stringify(active)}\n`), active);
  assert.equal(activationGenerationForTransition(active, false), 7);
  assert.equal(activationGenerationForTransition(active, true), 8);
  assert.equal(activationGenerationForTransition(null, true), 1);
  assert.throws(() => activationGenerationForTransition({
    ...active, activationGeneration: Number.MAX_SAFE_INTEGER,
  }, true), /generation is exhausted or invalid/);
  for (const invalid of [
    { ...active, activationGeneration: 0 },
    { ...active, activationGeneration: 0, imageManifest: null },
    {
      ...active,
      activationGeneration: 0,
      phase: 'stopping',
      panic: 'requested',
      imageManifest: null,
    },
    { ...active, activationGeneration: 7.5 },
    { ...active, phase: 'inactive' },
    { ...active, updatedAt: 'today' },
    { ...active, updatedAt: '9999-99-99T99:99:99.999Z' },
    { ...active, unexpected: true },
  ]) {
    assert.throws(() => normalizeActivationState(`${JSON.stringify(invalid)}\n`),
      /durable voice activation/);
  }
  assert.throws(() => normalizeActivationState(JSON.stringify(active, null, 2)),
    /durable voice activation/);

  const legacy = {
    version: 1,
    project: 'teleagent-voice',
    phase: 'inactive',
    previousPhase: 'stopping',
    panic: 'quiesced',
    cleanup: 'proved',
    image: PROMOTED_IMAGE_MANIFEST.runtimeReference,
    imageId: IMAGE_MANIFEST.configDigest,
    sourceRevision: IMAGE_MANIFEST.sourceRevision,
    panicOutcomeUnknownAt: null,
    interruptedStartRecoveredAt: null,
    updatedAt: '2026-08-26T12:34:56.789Z',
  };
  const normalizedLegacy = normalizeActivationState(`${JSON.stringify(legacy)}\n`);
  assert.equal(normalizedLegacy.version, 1);
  assert.equal(activationRequiresRecovery(normalizedLegacy), true);
  assert.equal(cleanupRequiresPanicRecovery(normalizedLegacy), true);
  assert.equal(activationRequiresRecovery(null), true);
  assert.equal(cleanupRequiresPanicRecovery(null), true);
});

test('activation state replacement is file-synced, renamed, then directory-synced', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'deploy', 'voice-stack', 'teleagent-voice-stack-launch.js'),
    'utf8',
  );
  const body = source.slice(source.indexOf('function atomicWriteActivationState('),
    source.indexOf('function activationRequiresRecovery('));
  const fileSync = body.indexOf('fs.fsyncSync(descriptor)');
  const rename = body.indexOf('fs.renameSync(temporary, ACTIVATION_STATE)');
  const directorySync = body.indexOf('fs.fsyncSync(directory)');
  assert.ok(fileSync >= 0 && rename > fileSync && directorySync > rename);
  assert.match(body, /O_EXCL[\s\S]*O_NOFOLLOW/);
  assert.match(body, /fs\.rmSync\(temporary, \{ force: true \}\)/);
});

test('every exact Compose service proves the durable generation and aggregate cgroup parent', () => {
  assert.deepEqual(parseDockerCgroupInfo('systemd\t2\n'), {
    cgroupDriver: 'systemd', cgroupVersion: 2,
  });
  for (const invalid of ['cgroupfs\t2\n', 'systemd\t1\n', 'systemd\t2', 'systemd\t2\nextra\n']) {
    assert.throws(() => parseDockerCgroupInfo(invalid), /systemd cgroup-v2 boundary/);
  }
  const dockerInfoCalls = [];
  assert.deepEqual(requireDockerCgroupBoundary({
    environment: {},
    runCommand: (_filename, args) => {
      dockerInfoCalls.push(args);
      return { status: 0, stdout: 'systemd\t2\n' };
    },
  }), { cgroupDriver: 'systemd', cgroupVersion: 2 });
  assert.deepEqual(dockerInfoCalls, [[
    'info', '--format', '{{.CgroupDriver}}\t{{.CgroupVersion}}',
  ]]);
  assert.throws(() => requireDockerCgroupBoundary({
    environment: {},
    runCommand: () => ({ status: 1, stdout: '' }),
  }), /Docker cgroup boundary is unverifiable/);

  const generation = 9;
  const services = ['voice-runtime-preflight', 'drachtio', 'freeswitch', 'voice-app'];
  const evidence = services.map((service) =>
    `${service}\t${generation}\tteleagent-voice-containers.slice`).join('\n') + '\n';
  assert.deepEqual(parseVoiceContainerBoundary(evidence, generation), [...services].sort());
  for (const invalid of [
    evidence.replace('\t9\t', '\t8\t'),
    evidence.replace('teleagent-voice-containers.slice', 'system.slice'),
    evidence.replace('voice-app\t9', 'drachtio\t9'),
    evidence.split('\n').slice(0, 3).join('\n'),
  ]) {
    assert.throws(() => parseVoiceContainerBoundary(invalid, generation),
      /aggregate boundary|escaped/);
  }

  const identifiers = ['a', 'b', 'c', 'd'].map((value) => value.repeat(64));
  const calls = [];
  assert.equal(verifyExactProjectContainerBoundary(generation, {
    environment: {},
    runCommand: (_filename, args) => {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'ls') {
        return { status: 0, stdout: `${identifiers.join('\n')}\n` };
      }
      return { status: 0, stdout: evidence };
    },
  }), 4);
  assert.deepEqual(calls[1].slice(-4), identifiers);
  assert.match(calls[1][3], /activation-generation/);
  assert.match(calls[1][3], /CgroupParent/);
});

test('interrupted activation remains recovery-gated until coordinated panic is proven', () => {
  const unknownStates = [
    { phase: 'starting', panic: 'not_requested', cleanup: 'required' },
    { phase: 'active', panic: 'not_requested', cleanup: 'required' },
    { phase: 'stopping', panic: 'requested', cleanup: 'required' },
    { phase: 'panic_outcome_unknown', panic: 'outcome_unknown', cleanup: 'proved' },
  ];
  for (const state of unknownStates) {
    assert.equal(activationRequiresRecovery(state), true);
    assert.equal(cleanupRequiresPanicRecovery(state), true);
  }
  assert.equal(activationRequiresRecovery({
    version: 2, phase: 'inactive', panic: 'recovered', cleanup: 'proved',
  }), false);
  assert.equal(activationRequiresRecovery({
    version: 2, phase: 'inactive', panic: 'quiesced', cleanup: 'proved',
  }), false);
  assert.equal(cleanupRequiresPanicRecovery({
    version: 2, phase: 'cleanup_outcome_unknown', panic: 'quiesced', cleanup: 'outcome_unknown',
  }), false);

  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'deploy', 'voice-stack', 'teleagent-voice-stack-launch.js'),
    'utf8',
  );
  const recoverBody = source.slice(source.indexOf('async function runOfflineRecovery'),
    source.indexOf('async function recover()'));
  for (const [before, after] of [
    ['cleanupProject()', "pathname: '/voice-control/stop'"],
    ['assertPanicQuiesced(panic)', "panic: 'recovered'"],
  ]) {
    assert.notEqual(recoverBody.indexOf(before), -1);
    assert.notEqual(recoverBody.indexOf(after), -1);
    assert.ok(recoverBody.indexOf(before) < recoverBody.indexOf(after));
  }
  assert.doesNotMatch(recoverBody, /unlock/);
});

test('offline recovery initializes missing state and retains partial or unavailable panic', async () => {
  const prior = null;
  const successEvents = [];
  const successToken = Buffer.from('r'.repeat(32));
  const successPersisted = [];
  await runOfflineRecovery(prior, {
    requireUnit: (unit) => successEvents.push(`unit:${unit}`),
    ensureDockerConfig: () => successEvents.push('docker-config'),
    cleanupProject: () => successEvents.push('containers-zero'),
    removeProjection: () => successEvents.push('projection-removed'),
    loadControlToken: () => successToken,
    persist: (phase, evidence) => successPersisted.push({ phase, ...evidence }),
    request: async (options) => {
      successEvents.push('controller-panic');
      assert.equal(options.method, 'POST');
      assert.equal(options.pathname, '/voice-control/stop');
      assert.equal(options.port, 3333);
      assert.equal(successEvents.indexOf('containers-zero') <
        successEvents.indexOf('controller-panic'), true);
      return { status: 200, body: { success: true } };
    },
  });
  assert.deepEqual(successPersisted, [
    { phase: 'panic_outcome_unknown', panic: 'requested', cleanup: 'proved' },
    { phase: 'inactive', panic: 'recovered', cleanup: 'proved' },
  ]);
  assert.equal(successToken.every((byte) => byte === 0), true);

  for (const request of [
    async () => ({ status: 503, body: { success: false } }),
    async () => { throw new Error('fake controller unavailable'); },
  ]) {
    const persisted = [];
    const token = Buffer.from('s'.repeat(32));
    await assert.rejects(runOfflineRecovery(prior, {
      requireUnit: () => {},
      ensureDockerConfig: () => {},
      cleanupProject: () => {},
      removeProjection: () => {},
      loadControlToken: () => token,
      persist: (phase, evidence) => persisted.push({ phase, ...evidence }),
      request,
    }));
    assert.deepEqual(persisted.at(-1), {
      phase: 'panic_outcome_unknown',
      panic: 'outcome_unknown',
      cleanup: 'proved',
    });
    assert.equal(token.every((byte) => byte === 0), true);
  }
});

test('subprocess SIGKILL after durable start intent retains panic outcome unknown', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-stack-sigkill-'));
  const stateFile = path.join(directory, 'activation.json');
  let child = null;
  t.after(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    fs.writeFileSync(process.argv[1], JSON.stringify({
      phase: 'starting', panic: 'not_requested', cleanup: 'required'
    }));
    process.stdout.write('START_INTENT_DURABLE\\n');
    setInterval(() => {}, 1000);
  `, stateFile], {
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('start-intent child did not become ready')), 2000);
    child.stdout.once('data', (chunk) => {
      clearTimeout(timer);
      if (chunk.toString('utf8') !== 'START_INTENT_DURABLE\n') {
        reject(new Error('start-intent child emitted an invalid readiness marker'));
        return;
      }
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const exited = once(child, 'exit');
  assert.equal(child.kill('SIGKILL'), true);
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');

  const prior = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(cleanupEvidenceDisposition(prior), {
    phase: 'panic_outcome_unknown',
    panic: 'outcome_unknown',
    cleanup: 'proved',
  });
  assert.equal(activationRequiresRecovery(cleanupEvidenceDisposition(prior)), true);
});

test('cleanup primitive is control-independent and fails closed when Docker is unavailable', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'deploy', 'voice-stack', 'teleagent-voice-stack-launch.js'),
    'utf8',
  );
  const cleanupBody = source.slice(source.indexOf('function cleanup()'),
    source.indexOf('async function runOfflineRecovery('));
  assert.doesNotMatch(cleanupBody, /requestJson|openCredential|readEnvironmentFile|readVoiceImageManifest/);
  assert.match(cleanupBody, /cleanupEvidenceDisposition\(priorState\)/);
  assert.match(cleanupBody, /persistActivationState\(disposition\.phase/);
  assert.throws(() => cleanupExactProject({
    environment: {},
    runCommand: () => ({ status: 1, stdout: '', stderr: 'unavailable' }),
  }), /could not enumerate the exact voice project/);
});

test('dormant systemd gate binds the private voice identity and every prerequisite', () => {
  const deploy = path.join(__dirname, '..', '..', 'deploy', 'voice-stack');
  const unit = fs.readFileSync(path.join(deploy, 'teleagent-voice-stack.service'), 'utf8');
  const containerSlice = fs.readFileSync(
    path.join(deploy, 'teleagent-voice-containers.slice'), 'utf8'
  );
  const sysusers = fs.readFileSync(path.join(deploy, 'teleagent-voice-stack.sysusers'), 'utf8');
  const tmpfiles = fs.readFileSync(path.join(deploy, 'teleagent-voice-stack.tmpfiles'), 'utf8');
  const compose = fs.readFileSync(path.join(deploy, '..', '..', 'docker-compose.yml'), 'utf8');
  assert.match(unit, /^Requires=.*teleagent-sip-local-peer-fence\.service/m);
  assert.match(unit, /^Requires=.*teleagent-agent-controller\.service/m);
  assert.match(unit, /^Requires=teleagent-worker-session\.service teleagent-provider-model-apparmor\.service$/m);
  assert.match(unit, /^Requires=teleagent-voice-containers\.slice$/m);
  assert.match(unit, /^After=teleagent-voice-containers\.slice$/m);
  assert.match(unit,
    /^ExecStartPre=\/usr\/local\/libexec\/verify-voice-stack-identity --installed-check$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/libexec\/teleagent-voice-stack-launch start$/m);
  assert.match(unit, /^ExecStop=\/usr\/local\/libexec\/teleagent-voice-stack-launch stop$/m);
  assert.match(unit, /^ExecStopPost=\/usr\/local\/libexec\/teleagent-voice-stack-launch cleanup$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^CPUQuota=100%$/m);
  assert.match(unit, /^MemoryHigh=384M$/m);
  assert.match(unit, /^MemoryMax=512M$/m);
  assert.match(unit, /^MemorySwapMax=0$/m);
  assert.match(unit, /^TasksMax=128$/m);
  assert.match(unit, /^IOWeight=50$/m);
  assert.doesNotMatch(unit, /^Environment=.*(?:TOKEN|PASSWORD|SECRET|KEY)=/m);
  assert.doesNotMatch(unit, /^\[Install\]$/m);
  assert.doesNotMatch(containerSlice, /^\[Install\]$/m);
  for (const expected of [
    /^StopWhenUnneeded=yes$/m,
    /^CPUQuota=300%$/m,
    /^MemoryHigh=2560M$/m,
    /^MemoryMax=3G$/m,
    /^MemorySwapMax=0$/m,
    /^TasksMax=1024$/m,
    /^IOWeight=50$/m,
  ]) assert.match(containerSlice, expected);
  assert.match(sysusers,
    /^u teleagent-voice - "Teleagent private voice orchestrator" \/var\/lib\/teleagent-voice \/usr\/sbin\/nologin$/m);
  assert.match(tmpfiles,
    /^d \/etc\/teleagent-voice\/credentials 0750 root teleagent-voice -$/m);
  assert.match(tmpfiles,
    /^d \/var\/lib\/teleagent-voice 0700 teleagent-voice teleagent-voice -$/m);
  assert.match(tmpfiles, /^d \/var\/lib\/teleagent-voice-stack 0700 root root -$/m);
  assert.match(tmpfiles, /^d \/run\/teleagent-voice-stack 0700 root root -$/m);
  assert.equal((compose.match(/image: "\$\{TELEAGENT_VOICE_IMAGE:\?/g) || []).length, 2);
  assert.doesNotMatch(compose, /^\s+build:/m);
  const preflight = compose.slice(
    compose.indexOf('  voice-runtime-preflight:'),
    compose.indexOf('\n  drachtio:'),
  );
  for (const expected of [
    /^    mem_limit: 256m$/m,
    /^    memswap_limit: 256m$/m,
    /^    cpus: 0\.5$/m,
    /^    pids_limit: 64$/m,
    /^      core: 0$/m,
    /VOICE_STATE_DIR[^\n]+:\/app\/state:ro"$/m,
  ]) assert.match(preflight, expected);
  for (const service of ['voice-runtime-preflight', 'drachtio', 'freeswitch', 'voice-app']) {
    const match = compose.match(new RegExp(
      `^  ${service}:\\n[\\s\\S]*?(?=^  [a-z][^\\n]*:\\n|(?![\\s\\S]))`,
      'm',
    ));
    assert.ok(match, service);
    const block = match[0];
    assert.match(block, /^    cgroup_parent: teleagent-voice-containers\.slice$/m, service);
    assert.match(block,
      /^      com\.teleagent\.voice\.activation-generation: "\$\{TELEAGENT_VOICE_ACTIVATION_GENERATION:\?/m,
      `${service} activation generation`,
    );
    assert.match(block, /^    read_only: true$/m, `${service} root filesystem`);
    assert.match(block, /^    logging:$/m, service);
    assert.match(block, /^      driver: local$/m, service);
    assert.match(block, /^        max-size: "10m"$/m, service);
    assert.match(block, /^        max-file: "3"$/m, service);
    const scratchMounts = block.match(/^      - \/[^\n]+$/gm) || [];
    const tmpfsRemainder = block.slice(block.indexOf('    tmpfs:\n') + '    tmpfs:\n'.length);
    const nextKey = tmpfsRemainder.search(/^    [a-z_][a-z0-9_-]*:/m);
    const tmpfsBlock = tmpfsRemainder.slice(0, nextKey === -1 ? undefined : nextKey);
    const tmpfsMounts = tmpfsBlock.match(/^      - \/[^\n]+$/gm) || [];
    assert.ok(tmpfsMounts.length > 0, `${service} bounded scratch mounts`);
    for (const mount of tmpfsMounts) {
      assert.match(mount, /(?:rw|ro),noexec,nosuid,nodev,/u, `${service} tmpfs security`);
      assert.match(mount, /size=[1-9][0-9]*$/u, `${service} tmpfs size`);
    }
    assert.ok(scratchMounts.length >= tmpfsMounts.length, service);
  }
  const drachtio = compose.slice(compose.indexOf('  drachtio:'), compose.indexOf('\n  freeswitch:'));
  const freeswitch = compose.slice(compose.indexOf('  freeswitch:'), compose.indexOf('\n  voice-app:'));
  assert.match(drachtio, /^    mem_limit: 384m\n    memswap_limit: 384m$/m);
  assert.match(drachtio, /^      - \/config:[^\n]+size=1048576$/m);
  assert.match(freeswitch, /^    mem_limit: 1g\n    memswap_limit: 1g$/m);
  for (const mountpoint of ['db', 'log', 'recordings', 'run', 'sounds']) {
    assert.match(freeswitch, new RegExp(
      `^      - \/usr\/local\/freeswitch\/${mountpoint}:[^\\n]+size=[1-9][0-9]*$`, 'm'));
  }
  assert.match(freeswitch,
    /switch\.conf\.xml:\/usr\/local\/freeswitch\/conf\/autoload_configs\/switch\.conf\.xml:ro/);
  const switchConfig = fs.readFileSync(path.join(deploy, '..', '..', 'freeswitch',
    'switch.conf.xml'), 'utf8');
  assert.match(switchConfig, /name="rtp-start-port" value="30000"/);
  assert.match(switchConfig, /name="rtp-end-port" value="30100"/);
  assert.match(switchConfig, /name="max-sessions" value="32"/);
  const entrypoint = fs.readFileSync(path.join(deploy, '..', '..', 'freeswitch',
    'entrypoint.sh'), 'utf8');
  assert.doesNotMatch(entrypoint, /\bsed\b/);
  assert.match(entrypoint, /accepts only its reviewed fixed entrypoint/);
  assert.match(entrypoint, /-storage \/tmp\/freeswitch-storage/);
  const mediaCanaryPath = path.join(deploy, '..', '..', 'scripts',
    'test-media-images-read-only.sh');
  const mediaCanary = fs.readFileSync(mediaCanaryPath, 'utf8');
  assert.equal(fs.statSync(mediaCanaryPath).mode & 0o777, 0o755);
  assert.match(mediaCanary, /--network none/);
  assert.equal((mediaCanary.match(/--read-only/g) || []).length, 2);
  assert.equal((mediaCanary.match(/--cap-drop ALL/g) || []).length, 2);
  assert.equal((mediaCanary.match(/--security-opt no-new-privileges/g) || []).length, 2);
  for (const digest of [
    'c03001e7c01ead29d0026245d0b42a9ebc8eefb0ff9bd180f5ff1f72be6da457',
    '7a6ce26834ff1b8eb27e97f3b9db72980a511e83ef01897097ca92a0f2d5eb62',
  ]) {
    assert.match(compose, new RegExp(digest));
    assert.match(mediaCanary, new RegExp(digest));
  }
});

test('voice launcher projects the exact eleven reviewed credential classes', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'deploy', 'voice-stack', 'teleagent-voice-stack-launch.js'),
    'utf8',
  );
  const matches = [...source.matchAll(/^  \['([^']+)', 'teleagent-[^']+', '(?:token|privateKey)', (?:true|false)\],$/gm)];
  assert.deepEqual(matches.map((entry) => entry[1]), [
    'drachtio-secret',
    'freeswitch-secret',
    'executor-api-token',
    'voice-control-token',
    'privileged-action-api-token',
    'openai-realtime-api-key',
    'openai-safety-salt',
    'outbound-api-token',
    'voice-approval-private.pem',
    'sip-ingress-password',
    'sip-callback-password',
  ]);
});

test('SIP fence bundle is app-local, atomic, and removal is Docker-quiesced', () => {
  const deploy = path.join(__dirname, '..', '..', 'deploy', 'voice-stack');
  const helper = fs.readFileSync(path.join(deploy, 'teleagent-sip-local-peer-fence'), 'utf8');
  const installer = fs.readFileSync(path.join(deploy, 'teleagent-sip-local-peer-fence-install'), 'utf8');
  const unit = fs.readFileSync(path.join(deploy, 'teleagent-sip-local-peer-fence.service'), 'utf8');
  assert.match(helper, /type filter hook output priority -200; policy accept;/);
  assert.match(helper, /127\.0\.0\.1 udp dport 5060 meta skuid != 0/);
  assert.match(helper, /127\.0\.0\.1 udp dport 5070 meta skuid != 0/);
  assert.match(helper, /printf '%s\\n' "\$\{ruleset\}" \| "\$\{nft_bin\}" -f -/);
  assert.match(unit, /^Before=teleagent-voice-stack\.service$/m);
  assert.match(unit, /^CapabilityBoundingSet=CAP_NET_ADMIN$/m);
  assert.match(installer,
    /\[\[ "\$\(unit_active_state docker\.service\)" == inactive \]\] \|\| fail 'stop Docker before removing its SIP fence'/);
  assert.doesNotMatch(installer, /"\$\{target_helper\}" reconcile/);
  const installStart = installer.indexOf('install_fence()');
  const installBody = installer.slice(
    installStart,
    installer.indexOf('\nvalidate_source\n', installStart),
  );
  const enableIndex = installBody.indexOf('"${systemctl_bin}" enable --now "${unit}"');
  assert.ok(enableIndex >= 0);
  assert.ok(enableIndex < installBody.lastIndexOf('  check_live\n'));
  assert.match(installer, /trap transaction_exit EXIT/);
  assert.match(installer, /trap 'exit 143' TERM/);
  assert.match(installer, /transaction_marker=.*install\.transaction/);
  assert.match(installer, /phase=\(prepared\|files\|activation\)/);
  assert.match(installer, /systemctl_bin\}" disable --now "\$\{unit\}"/);
  assert.match(installer, /prior inactive state restored/);
  assert.match(unit, /^RuntimeDirectory=teleagent-sip-local-peer-fence$/m);
  assert.match(unit, /^RuntimeDirectoryMode=0700$/m);
  assert.match(installer, /--source-check/);
});
