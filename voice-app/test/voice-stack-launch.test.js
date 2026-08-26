'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertPanicQuiesced,
  assertVoiceExit,
  activationRequiresRecovery,
  cleanupEvidenceDisposition,
  cleanupExactProject,
  cleanupRequiresPanicRecovery,
  normalizeVoiceImageManifest,
  parseExactProjectContainerIds,
  renderTemplateContents,
  runOfflineRecovery,
  verifyVoiceImage,
} = require('../../deploy/voice-stack/teleagent-voice-stack-launch');

const IMAGE_MANIFEST = Object.freeze({
  version: 1,
  image: `registry.example/teleagent/voice-app@sha256:${'a'.repeat(64)}`,
  imageId: `sha256:${'b'.repeat(64)}`,
  sourceRevision: 'c'.repeat(40),
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
  ]) {
    assert.notEqual(startBody.indexOf(before), -1);
    assert.notEqual(startBody.indexOf(after), -1);
    assert.ok(startBody.indexOf(before) < startBody.indexOf(after));
  }
});

test('voice image release manifest is canonical, immutable, and resolved before use', () => {
  const encoded = `${JSON.stringify(IMAGE_MANIFEST)}\n`;
  assert.deepEqual(normalizeVoiceImageManifest(encoded), IMAGE_MANIFEST);
  for (const invalid of [
    { ...IMAGE_MANIFEST, image: 'registry.example/teleagent/voice-app:latest' },
    { ...IMAGE_MANIFEST, imageId: `sha256:${'z'.repeat(64)}` },
    { ...IMAGE_MANIFEST, sourceRevision: 'main' },
  ]) {
    assert.throws(() => normalizeVoiceImageManifest(`${JSON.stringify(invalid)}\n`),
      /immutable provenance/);
  }
  assert.throws(() => normalizeVoiceImageManifest(
    `{"version":1,"version":1,"image":"${IMAGE_MANIFEST.image}",` +
    `"imageId":"${IMAGE_MANIFEST.imageId}","sourceRevision":"${IMAGE_MANIFEST.sourceRevision}"}\n`
  ), /not canonical/);

  const calls = [];
  const runCommand = (_filename, args) => {
    calls.push(args);
    return {
      status: 0,
      stdout: args.includes('{{.Id}}') ? `${IMAGE_MANIFEST.imageId}\n` :
        `${IMAGE_MANIFEST.sourceRevision}\n`,
    };
  };
  assert.equal(verifyVoiceImage(IMAGE_MANIFEST, { runCommand, environment: {} }), true);
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
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
    phase: 'inactive', panic: 'recovered', cleanup: 'proved',
  }), false);
  assert.equal(activationRequiresRecovery({
    phase: 'inactive', panic: 'quiesced', cleanup: 'proved',
  }), false);
  assert.equal(cleanupRequiresPanicRecovery({
    phase: 'cleanup_outcome_unknown', panic: 'quiesced', cleanup: 'outcome_unknown',
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

test('offline recovery targets the fixed controller and retains partial or unavailable panic', async () => {
  const prior = { phase: 'panic_outcome_unknown', panic: 'outcome_unknown', cleanup: 'proved' };
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
  const sysusers = fs.readFileSync(path.join(deploy, 'teleagent-voice-stack.sysusers'), 'utf8');
  const tmpfiles = fs.readFileSync(path.join(deploy, 'teleagent-voice-stack.tmpfiles'), 'utf8');
  const compose = fs.readFileSync(path.join(deploy, '..', '..', 'docker-compose.yml'), 'utf8');
  assert.match(unit, /^Requires=.*teleagent-sip-local-peer-fence\.service/m);
  assert.match(unit, /^Requires=.*teleagent-agent-controller\.service/m);
  assert.match(unit, /^Requires=teleagent-worker-session\.service teleagent-provider-model-apparmor\.service$/m);
  assert.match(unit,
    /^ExecStartPre=\/usr\/local\/libexec\/verify-voice-stack-identity --installed-check$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/libexec\/teleagent-voice-stack-launch start$/m);
  assert.match(unit, /^ExecStop=\/usr\/local\/libexec\/teleagent-voice-stack-launch stop$/m);
  assert.match(unit, /^ExecStopPost=\/usr\/local\/libexec\/teleagent-voice-stack-launch cleanup$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.doesNotMatch(unit, /^Environment=.*(?:TOKEN|PASSWORD|SECRET|KEY)=/m);
  assert.doesNotMatch(unit, /^\[Install\]$/m);
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
    /! systemctl is-active --quiet docker\.service \|\| fail 'stop Docker before removing its SIP fence'/);
  assert.match(installer, /--source-check/);
});
