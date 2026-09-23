#!/usr/local/libexec/teleagent-node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { requireRuntimeIntegration } = require('./media-application-boundary');

const IMMUTABLE_RELEASE_ROOT = /^\/opt\/teleagent\/releases\/sha256-[a-f0-9]{64}$/u;
// Unit starts receive this from the infrastructure-owned release launcher.
// The fallback keeps this file importable for source-only tests; main() never
// permits it for a live start, stop, cleanup, or recovery operation.
const APP_ROOT = process.env.TELEAGENT_RELEASE_ROOT || '/opt/teleagent/current';
const COMPOSE_FILE = `${APP_ROOT}/docker-compose.yml`;
const ENV_FILE = '/etc/teleagent-voice/voice-app.env';
const VOICE_IMAGE_MANIFEST = '/etc/teleagent-voice/voice-image.manifest.json';
const CREDENTIAL_ROOT = '/etc/teleagent-voice/credentials';
const RUNTIME_ROOT = '/run/teleagent-voice-stack';
const RUNTIME_SECRET_ROOT = `${RUNTIME_ROOT}/voice-secrets`;
const CONTROLLER_SOCKET = '/run/teleagent-controller/controller.sock';
const ACTIVATION_ROOT = '/var/lib/teleagent-voice-stack';
const ACTIVATION_STATE = `${ACTIVATION_ROOT}/activation-state.json`;
const WRAPPER = `${APP_ROOT}/deploy/voice-stack/teleagent-voice-stack-launch.js`;
const DOCKER = '/usr/bin/docker';
const IDENTITY_VERIFIER = '/usr/local/libexec/verify-voice-stack-identity';
const SYSTEMCTL = '/usr/bin/systemctl';
const SIP_FENCE = '/usr/local/libexec/teleagent-sip-local-peer-fence';
const PROVIDER_CLI_CHECK = '/usr/local/libexec/teleagent-provider-cli-check';
const SOURCE_PROVIDER_MANIFEST = `${APP_ROOT}/deploy/worker-session/provider-libexec.manifest`;
const INSTALLED_PROVIDER_MANIFEST = '/etc/teleagent/provider-runtime/provider-libexec.manifest';
const APPARMOR_PROFILES = '/sys/kernel/security/apparmor/profiles';
const HANDOFF_LOCK = '/run/teleagent-staging-handoff.lock';
const LIFECYCLE_LOCK_ENV = 'TELEAGENT_HANDOFF_LIFECYCLE_LOCK_FD';
const PROJECT = 'teleagent-voice';
const PROJECT_LABEL = `com.docker.compose.project=${PROJECT}`;
const IMAGE_REVISION_LABEL = 'org.opencontainers.image.revision';
const ACTIVATION_GENERATION_LABEL = 'com.teleagent.voice.activation-generation';
const CONTAINER_SLICE = 'teleagent-voice-containers.slice';
const VOICE_IDENTITY_SPECS = Object.freeze([
  Object.freeze({ key: 'voice', name: 'teleagent-voice', home: '/var/lib/teleagent-voice' }),
  Object.freeze({ key: 'drachtio', name: 'teleagent-drachtio', home: '/nonexistent' }),
  Object.freeze({ key: 'freeswitch', name: 'teleagent-freeswitch', home: '/nonexistent' }),
  // The PBX account is infrastructure-owned and deliberately is not created by
  // this bundle. A missing dedicated peer keeps the whole media stack dormant.
  Object.freeze({ key: 'asterisk', name: 'teleagent-asterisk', home: '/nonexistent' }),
]);
const VOICE_SERVICES = Object.freeze([
  'drachtio', 'freeswitch', 'voice-app', 'voice-runtime-preflight',
]);
const RUNNING_VOICE_SERVICES = Object.freeze(['drachtio', 'freeswitch', 'voice-app']);
const MAX_CONTROL_RESPONSE_BYTES = 128 * 1024;
const HOST_STATE_ROOT = '/var/lib/teleagent-voice';
const HOST_STATE_PARENT = '/var/lib';
const GIB = 1024n * 1024n * 1024n;
const MIB = 1024n * 1024n;
const MIN_STATE_CAPACITY_BYTES = 4n * GIB;
const MAX_STATE_CAPACITY_BYTES = 8n * GIB;
const MIN_STATE_FREE_BYTES = 512n * MIB;
const FIXED_VOICE_APP_BOUNDARY_ENV = Object.freeze({
  HTTP_HOST: '127.0.0.1',
  OUTBOUND_API_NON_LOOPBACK_ENABLED: 'false',
  VOICE_APPROVAL_CAPABILITY_ENABLED: 'false',
  VOICE_PRIVILEGED_ACTIONS_ENABLED: 'false',
  VOICE_APP_EXECUTION_LOCK_FILE: '/app/state/voice-execution.lock.json',
  VOICE_STATE_DB_PATH: '/app/state/voice-state.sqlite',
  WS_ALLOWED_PEERS: '',
  WS_CONNECT_HOST: '127.0.0.1',
  WS_HOST: '127.0.0.1',
  WS_NON_LOOPBACK_ENABLED: 'false',
});

const ACTIVATION_PHASES = new Set([
  'starting',
  'active',
  'stopping',
  'panic_outcome_unknown',
  'cleanup_outcome_unknown',
  'inactive',
]);
const PANIC_STATES = new Set([
  'not_requested', 'requested', 'quiesced', 'outcome_unknown', 'recovered',
]);
const CLEANUP_STATES = new Set(['required', 'proved', 'outcome_unknown']);

const CREDENTIALS = Object.freeze([
  ['drachtio-secret', 'teleagent-drachtio-secret', 'token', true],
  ['freeswitch-secret', 'teleagent-freeswitch-secret', 'token', true],
  ['executor-api-token', 'teleagent-executor-api-token', 'token', true],
  ['voice-control-token', 'teleagent-voice-control-token', 'token', true],
  ['openai-realtime-api-key', 'teleagent-openai-realtime-api-key', 'token', true],
  ['openai-safety-salt', 'teleagent-openai-safety-salt', 'token', true],
  ['outbound-api-token', 'teleagent-outbound-api-token', 'token', true],
  ['sip-ingress-password', 'teleagent-sip-ingress-password', 'token', true],
  ['sip-callback-password', 'teleagent-sip-callback-password', 'token', true],
]);

const PLACEHOLDER = /(?:replace[-_ ]?with|change[-_ ]?me|changeme|placeholder|example|dummy|your[-_ ]?(?:password|secret|token|api[-_ ]?key))/iu;

function refuse(message) {
  const error = new Error(message);
  error.code = 'VOICE_STACK_REFUSED';
  throw error;
}

function run(filename, args, {
  environment = {},
  capture = false,
  allowFailure = false,
  timeoutMs = 60000,
} = {}) {
  const result = spawnSync(filename, args, {
    encoding: 'utf8',
    env: environment,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    timeout: timeoutMs,
  });
  if (result.error) refuse('a fixed voice-stack dependency could not be executed');
  if (!allowFailure && result.status !== 0) refuse('a fixed voice-stack dependency rejected the operation');
  return result;
}

function fixedDockerEnvironment(settings = {}, imageManifest = null, activationGeneration = null) {
  if (activationGeneration !== null &&
      (!Number.isSafeInteger(activationGeneration) || activationGeneration < 1)) {
    refuse('the voice activation generation is invalid');
  }
  return Object.freeze({
    ...settings,
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: RUNTIME_ROOT,
    DOCKER_CONFIG: `${RUNTIME_ROOT}/docker-config`,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    ...(imageManifest ? { TELEAGENT_VOICE_IMAGE: imageManifest.runtimeReference } : {}),
    ...(activationGeneration === null ? {} : {
      TELEAGENT_VOICE_ACTIVATION_GENERATION: String(activationGeneration),
    }),
  });
}

function inspectRootPath(filename, { directory = false, mode = null, nlink = null } = {}) {
  let metadata;
  try { metadata = fs.lstatSync(filename); } catch { refuse('a required voice-stack path is missing'); }
  if (metadata.isSymbolicLink() || (directory ? !metadata.isDirectory() : !metadata.isFile()) ||
      metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 ||
      (mode !== null && (metadata.mode & 0o777) !== mode) ||
      (nlink !== null && metadata.nlink !== nlink)) {
    refuse('a required voice-stack path has unsafe metadata');
  }
  return metadata;
}

function exactNonnegativeBigInt(value) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  refuse('the dedicated voice-state filesystem reported invalid capacity');
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.gid === right.gid && (left.mode & 0o7777) === (right.mode & 0o7777);
}

function inspectCanonicalRootDirectory(fsModule, filename) {
  let metadata;
  try { metadata = fsModule.lstatSync(filename); } catch {
    refuse('a dedicated voice-state ancestor is missing');
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 ||
      metadata.gid !== 0 || (metadata.mode & 0o022) !== 0) {
    refuse('a dedicated voice-state ancestor has unsafe metadata');
  }
  let resolved;
  try { resolved = fsModule.realpathSync(filename); } catch {
    refuse('a dedicated voice-state ancestor is not canonical');
  }
  if (resolved !== filename) refuse('a dedicated voice-state ancestor is not canonical');
  return metadata;
}

function verifyBoundedHostStateFilesystem(identity, {
  fsModule = fs,
  stateRoot = HOST_STATE_ROOT,
  stateParent = HOST_STATE_PARENT,
} = {}) {
  if (!identity || !Number.isSafeInteger(identity.uid) || !Number.isSafeInteger(identity.gid) ||
      identity.uid <= 0 || identity.gid <= 0) {
    refuse('the dedicated voice-state identity is invalid');
  }
  for (const ancestor of ['/', '/var', stateParent]) {
    inspectCanonicalRootDirectory(fsModule, ancestor);
  }
  let before;
  try { before = fsModule.lstatSync(stateRoot); } catch {
    refuse('the dedicated voice-state mountpoint is missing');
  }
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== identity.uid ||
      before.gid !== identity.gid || (before.mode & 0o777) !== 0o700) {
    refuse('the dedicated voice-state mountpoint has unsafe metadata');
  }
  let resolved;
  try { resolved = fsModule.realpathSync(stateRoot); } catch {
    refuse('the dedicated voice-state mountpoint is not canonical');
  }
  if (resolved !== stateRoot) refuse('the dedicated voice-state mountpoint is not canonical');
  const parent = inspectCanonicalRootDirectory(fsModule, stateParent);
  if (before.dev === parent.dev) {
    refuse('the voice-state path is not an exact dedicated filesystem mountpoint');
  }
  let statistics;
  try { statistics = fsModule.statfsSync(stateRoot, { bigint: true }); } catch {
    refuse('the dedicated voice-state filesystem capacity is unverifiable');
  }
  const blockSize = exactNonnegativeBigInt(statistics?.bsize);
  const blocks = exactNonnegativeBigInt(statistics?.blocks);
  const availableBlocks = exactNonnegativeBigInt(statistics?.bavail);
  if (blockSize === 0n || blocks === 0n || availableBlocks > blocks) {
    refuse('the dedicated voice-state filesystem reported invalid capacity');
  }
  const capacity = blockSize * blocks;
  const available = blockSize * availableBlocks;
  if (capacity < MIN_STATE_CAPACITY_BYTES || capacity > MAX_STATE_CAPACITY_BYTES) {
    refuse('the dedicated voice-state filesystem must have a 4-8 GiB hard capacity');
  }
  const percentageReserve = (capacity + 4n) / 5n;
  const requiredFree = percentageReserve > MIN_STATE_FREE_BYTES
    ? percentageReserve
    : MIN_STATE_FREE_BYTES;
  if (available < requiredFree) {
    refuse('the dedicated voice-state filesystem free-space reserve is exhausted');
  }
  let after;
  try { after = fsModule.lstatSync(stateRoot); } catch {
    refuse('the dedicated voice-state mountpoint changed during verification');
  }
  if (!sameInode(before, after)) {
    refuse('the dedicated voice-state mountpoint changed during verification');
  }
  return Object.freeze({ capacity, available, requiredFree });
}

function normalizeVoiceImageManifest(source) {
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : String(source);
  if (Buffer.byteLength(text) > 4096 || /\r|\0/u.test(text)) {
    refuse('the voice image manifest has invalid encoding');
  }
  let manifest;
  try { manifest = JSON.parse(text); } catch { refuse('the voice image manifest is invalid'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      JSON.stringify(Object.keys(manifest)) !== JSON.stringify([
        'version', 'sourceRevision', 'platform', 'configDigest', 'runtimeReference',
        'registryReference', 'registryManifestDigest',
      ]) || text !== `${JSON.stringify(manifest)}\n`) {
    refuse('the voice image manifest is not canonical');
  }
  if (manifest.version !== 2 || manifest.platform !== 'linux/amd64' ||
      !/^sha256:[a-f0-9]{64}$/u.test(manifest.configDigest) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(manifest.sourceRevision)) {
    refuse('the voice image manifest does not identify reviewed immutable provenance');
  }
  const registryReference = manifest.registryReference;
  const registryDigest = manifest.registryManifestDigest;
  if (registryReference === null || registryDigest === null) {
    if (registryReference !== null || registryDigest !== null ||
        manifest.runtimeReference !== manifest.configDigest) {
      refuse('the offline voice image manifest is not bound to its config digest');
    }
  } else if (typeof registryReference !== 'string' ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u.test(registryReference) ||
      !/^sha256:[a-f0-9]{64}$/u.test(registryDigest) ||
      !registryReference.endsWith(`@${registryDigest}`) ||
      manifest.runtimeReference !== registryReference) {
    refuse('the promoted voice image manifest is not bound to one registry manifest');
  }
  return Object.freeze({ ...manifest });
}

function readVoiceImageManifest() {
  const metadata = inspectRootPath(VOICE_IMAGE_MANIFEST, { mode: 0o400, nlink: 1 });
  if (metadata.size < 128 || metadata.size > 4096) {
    refuse('the voice image manifest has an unsafe size');
  }
  return normalizeVoiceImageManifest(fs.readFileSync(VOICE_IMAGE_MANIFEST));
}

function verifyVoiceImage(manifest, {
  runCommand = run,
  environment = fixedDockerEnvironment(),
} = {}) {
  const identity = runCommand(DOCKER, [
    'image', 'inspect', '--format', '{{.Id}}', manifest.runtimeReference,
  ], { capture: true, environment, timeoutMs: 10000 });
  if (identity.status !== 0 || identity.stdout.trim() !== manifest.configDigest) {
    refuse('the resolved voice image ID differs from the reviewed manifest');
  }
  const revision = runCommand(DOCKER, [
    'image', 'inspect', '--format', `{{index .Config.Labels "${IMAGE_REVISION_LABEL}"}}`,
    manifest.runtimeReference,
  ], { capture: true, environment, timeoutMs: 10000 });
  if (revision.status !== 0 || revision.stdout.trim() !== manifest.sourceRevision) {
    refuse('the resolved voice image source revision differs from the reviewed manifest');
  }
  const platform = runCommand(DOCKER, [
    'image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', manifest.runtimeReference,
  ], { capture: true, environment, timeoutMs: 10000 });
  if (platform.status !== 0 || platform.stdout.trim() !== manifest.platform) {
    refuse('the resolved voice image platform differs from the reviewed manifest');
  }
  return true;
}

function resolveVoiceIdentities({ runCommand = run } = {}) {
  const result = runCommand(IDENTITY_VERIFIER, [
    '--installed-identities', '--source-root', `${APP_ROOT}/deploy/voice-stack`,
  ], {
    capture: true,
    allowFailure: true,
    environment: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
    timeoutMs: 10000,
  });
  const output = String(result.stdout || '');
  if (result.status !== 0 || Buffer.byteLength(output) > 4096 || /\r|\0/u.test(output) ||
      !output.endsWith('\n')) {
    refuse('the installed voice identity authority is unavailable');
  }
  const rows = output.slice(0, -1).split('\n');
  if (rows.length !== VOICE_IDENTITY_SPECS.length) {
    refuse('the installed voice identity authority result is incomplete');
  }
  const identities = {};
  for (let index = 0; index < VOICE_IDENTITY_SPECS.length; index += 1) {
    const spec = VOICE_IDENTITY_SPECS[index];
    const fields = rows[index].split('\t');
    if (fields.length !== 4 || fields[0] !== spec.key || fields[1] !== spec.name ||
        !/^[1-9][0-9]*$/u.test(fields[2]) || !/^[1-9][0-9]*$/u.test(fields[3])) {
      refuse('the installed voice identity authority result is malformed');
    }
    const uid = Number(fields[2]);
    const gid = Number(fields[3]);
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) ||
        uid > 2147483647 || gid > 2147483647 || uid === 1000 || gid === 1000) {
      refuse('the installed voice identity authority result is unsafe');
    }
    identities[spec.key] = Object.freeze({ name: spec.name, uid, gid });
  }
  const entries = Object.values(identities);
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if ([entries[right].uid, entries[right].gid].includes(entries[left].uid) ||
          [entries[right].uid, entries[right].gid].includes(entries[left].gid)) {
        refuse('the voice and media identities are numerically reused');
      }
    }
  }
  return Object.freeze(identities);
}

function composeIdentitySettings(identities) {
  if (!identities?.voice || !identities?.drachtio || !identities?.freeswitch) {
    refuse('the Compose media identity set is incomplete');
  }
  return Object.freeze({
    VOICE_APP_UID: String(identities.voice.uid),
    VOICE_APP_GID: String(identities.voice.gid),
    DRACHTIO_UID: String(identities.drachtio.uid),
    DRACHTIO_GID: String(identities.drachtio.gid),
    FREESWITCH_UID: String(identities.freeswitch.uid),
    FREESWITCH_GID: String(identities.freeswitch.gid),
  });
}

function openCredential(filename, { gid, kind }) {
  let descriptor = null;
  let contents = null;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.uid !== 0 || metadata.gid !== gid ||
        metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o440 ||
        metadata.size < 32 || metadata.size > (kind === 'privateKey' ? 16384 : 4097)) {
      refuse('a protected voice credential has unsafe metadata');
    }
    contents = fs.readFileSync(descriptor);
    if (contents.includes(0)) refuse('a protected voice credential is invalid');
    let contentLength = contents.length;
    if (contents[contentLength - 1] === 0x0a) contents[--contentLength] = 0;
    if (contents[contentLength - 1] === 0x0d) contents[--contentLength] = 0;
    contents = contents.subarray(0, contentLength);
    if (kind === 'privateKey') {
      const key = crypto.createPrivateKey(contents);
      if (key.asymmetricKeyType !== 'ed25519') refuse('the approval signing key is invalid');
    } else {
      const value = contents.toString('utf8');
      if (!/^[\x21-\x7e]{32,4096}$/u.test(value) || PLACEHOLDER.test(value) ||
          new Set(value).size < 8) {
        refuse('a protected voice credential is invalid');
      }
    }
    const ownedContents = contents;
    contents = null;
    return ownedContents;
  } catch (error) {
    if (contents) contents.fill(0);
    if (error?.code === 'VOICE_STACK_REFUSED') throw error;
    refuse('a protected voice credential is missing or unreadable');
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* an invalid close never authorizes startup */ }
    }
  }
}

function verifyVoiceAppRuntimeContract(runtimeContract) {
  if (!runtimeContract || typeof runtimeContract !== 'object' ||
      typeof runtimeContract.assertVoiceAppRuntimeEnvironment !== 'function' ||
      !runtimeContract.VOICE_APP_FIXED_ENV ||
      !Array.isArray(runtimeContract.VOICE_APP_RUNTIME_ENV_KEYS) ||
      runtimeContract.VOICE_STATE_DB_PATH !== FIXED_VOICE_APP_BOUNDARY_ENV.VOICE_STATE_DB_PATH ||
      runtimeContract.VOICE_EXECUTION_LOCK_FILE !==
        FIXED_VOICE_APP_BOUNDARY_ENV.VOICE_APP_EXECUTION_LOCK_FILE) {
    refuse('the voice application runtime contract is incomplete');
  }
  for (const [name, expected] of Object.entries(FIXED_VOICE_APP_BOUNDARY_ENV)) {
    if (runtimeContract.VOICE_APP_FIXED_ENV[name] !== expected ||
        runtimeContract.VOICE_APP_RUNTIME_ENV_KEYS.includes(name)) {
      refuse('the voice application fixed state/listener contract drifted');
    }
  }
  let proven;
  try {
    proven = runtimeContract.assertVoiceAppRuntimeEnvironment(
      runtimeContract.VOICE_APP_FIXED_ENV
    );
  } catch {
    refuse('the voice application fixed state/listener contract is invalid');
  }
  if (proven?.stateDbPath !== FIXED_VOICE_APP_BOUNDARY_ENV.VOICE_STATE_DB_PATH ||
      proven?.executionLockFile !==
        FIXED_VOICE_APP_BOUNDARY_ENV.VOICE_APP_EXECUTION_LOCK_FILE ||
      proven?.httpHost !== '127.0.0.1' || proven?.wsHost !== '127.0.0.1' ||
      proven?.wsConnectHost !== '127.0.0.1' || proven?.wsAllowedPeers !== '' ||
      proven?.wsNonLoopbackEnabled !== false) {
    refuse('the voice application fixed state/listener result drifted');
  }
  return true;
}

function parseVoiceEnvironmentFile(source, identities, runtimeContract) {
  if (/\r|\0/u.test(source)) refuse('the voice environment file has invalid encoding');
  verifyVoiceAppRuntimeContract(runtimeContract);
  const allowed = new Set([
    ...runtimeContract.VOICE_APP_RUNTIME_ENV_KEYS,
    'VOICE_APP_UID', 'VOICE_APP_GID', 'DRACHTIO_UID', 'DRACHTIO_GID',
    'FREESWITCH_UID', 'FREESWITCH_GID', 'DEVICE_CONFIG_DIR', 'VOICE_STATE_DIR',
  ]);
  const settings = {};
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) refuse('the voice environment file contains an invalid line');
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || !allowed.has(name) ||
        /(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY)(?:$|_)/u.test(name) ||
        /[\u0000-\u001f\u007f]/u.test(value) || Object.hasOwn(settings, name)) {
      refuse('the voice environment file contains an unreviewed setting');
    }
    settings[name] = value;
  }
  const expectedIdentities = composeIdentitySettings(identities);
  if (Object.entries(expectedIdentities).some(([name, value]) => settings[name] !== value) ||
      settings.DEVICE_CONFIG_DIR !== '/etc/teleagent-voice/config' ||
      settings.VOICE_STATE_DIR !== '/var/lib/teleagent-voice') {
    refuse('the voice environment identity or path contract drifted');
  }
  return settings;
}

function readEnvironmentFile(identities) {
  inspectRootPath(ENV_FILE, { mode: 0o600 });
  const source = fs.readFileSync(ENV_FILE, 'utf8');
  const runtimeContract = require(`${APP_ROOT}/lib/voice-app-runtime-env.js`);
  return parseVoiceEnvironmentFile(source, identities, runtimeContract);
}

function readCredentialSet(identity) {
  inspectRootPath(CREDENTIAL_ROOT, { directory: true });
  const credentials = new Map();
  const comparable = [];
  try {
    for (const [sourceName, runtimeName, kind] of CREDENTIALS) {
      const sourcePath = path.join(CREDENTIAL_ROOT, sourceName);
      const value = openCredential(sourcePath, { gid: identity.gid, kind });
      credentials.set(runtimeName, value);
      if (kind === 'token') comparable.push([sourceName, value]);
    }
    for (let i = 0; i < comparable.length; i += 1) {
      for (let j = i + 1; j < comparable.length; j += 1) {
        const left = crypto.createHash('sha256').update(comparable[i][1]).digest();
        const right = crypto.createHash('sha256').update(comparable[j][1]).digest();
        if (crypto.timingSafeEqual(left, right)) refuse('voice credentials must be pairwise distinct');
      }
    }
    return credentials;
  } catch (error) {
    for (const value of credentials.values()) value.fill(0);
    throw error;
  }
}

function renderTemplateContents(source, replacements) {
  let result = String(source);
  for (const [placeholder, replacement] of Object.entries(replacements)) {
    const count = result.split(placeholder).length - 1;
    if (count !== 1) refuse('a protected media template placeholder drifted');
    result = result.replace(placeholder, replacement);
  }
  if (/__[A-Z0-9_]+__/u.test(result)) refuse('a protected media template is unresolved');
  return result;
}

function renderTemplate(templatePath, replacements) {
  inspectRootPath(templatePath);
  return renderTemplateContents(fs.readFileSync(templatePath, 'utf8'), replacements);
}

function atomicReplaceFile(filename, contents, { mode, uid, gid }) {
  const temporary = `${filename}.new-${process.pid}`;
  fs.writeFileSync(temporary, contents, { mode, flag: 'wx' });
  fs.chownSync(temporary, uid, gid);
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, filename);
}

const ACTIVATION_STATE_KEYS_V2 = Object.freeze([
  'version', 'project', 'activationGeneration', 'phase', 'previousPhase', 'panic', 'cleanup',
  'imageManifest', 'panicOutcomeUnknownAt', 'interruptedStartRecoveredAt', 'updatedAt',
]);
const ACTIVATION_STATE_KEYS_V3 = Object.freeze([
  ...ACTIVATION_STATE_KEYS_V2, 'containerOwnership',
]);
const LEGACY_ACTIVATION_STATE_KEYS = Object.freeze([
  'version', 'project', 'phase', 'previousPhase', 'panic', 'cleanup', 'image', 'imageId',
  'sourceRevision', 'panicOutcomeUnknownAt', 'interruptedStartRecoveredAt', 'updatedAt',
]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function validTimestamp(value, { nullable = false } = {}) {
  if (value === null && nullable) return true;
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function validActivationEvidence(state) {
  if (state.phase === 'inactive') {
    return state.cleanup === 'proved' &&
      ['not_requested', 'quiesced', 'recovered'].includes(state.panic);
  }
  if (['starting', 'active'].includes(state.phase)) {
    return state.panic === 'not_requested' && state.cleanup === 'required';
  }
  if (state.phase === 'stopping') {
    return ['requested', 'quiesced'].includes(state.panic) && state.cleanup === 'required';
  }
  if (state.phase === 'panic_outcome_unknown') {
    return ['requested', 'outcome_unknown'].includes(state.panic) &&
      ['required', 'proved'].includes(state.cleanup);
  }
  return state.phase === 'cleanup_outcome_unknown' &&
    PANIC_STATES.has(state.panic) && state.cleanup === 'outcome_unknown';
}

function normalizeLegacyActivationState(state, text) {
  if (JSON.stringify(Object.keys(state)) !== JSON.stringify(LEGACY_ACTIVATION_STATE_KEYS) ||
      text !== `${JSON.stringify(state)}\n` || state.project !== PROJECT ||
      !ACTIVATION_PHASES.has(state.phase) ||
      (state.previousPhase !== null && !ACTIVATION_PHASES.has(state.previousPhase)) ||
      !PANIC_STATES.has(state.panic) || !CLEANUP_STATES.has(state.cleanup) ||
      !validTimestamp(state.panicOutcomeUnknownAt, { nullable: true }) ||
      !validTimestamp(state.interruptedStartRecoveredAt, { nullable: true }) ||
      !validTimestamp(state.updatedAt)) {
    refuse('the legacy durable voice activation state is invalid');
  }
  const allImageFieldsNull = state.image === null && state.imageId === null &&
    state.sourceRevision === null;
  const allImageFieldsValid =
    typeof state.image === 'string' &&
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u.test(state.image) &&
    typeof state.imageId === 'string' && /^sha256:[a-f0-9]{64}$/u.test(state.imageId) &&
    typeof state.sourceRevision === 'string' &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(state.sourceRevision);
  if ((!allImageFieldsNull && !allImageFieldsValid) || !validActivationEvidence(state)) {
    refuse('the legacy durable voice activation state is invalid');
  }
  return Object.freeze({ ...state });
}

function normalizeActivationState(source) {
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : String(source);
  if (Buffer.byteLength(text) > 8192 || /\r|\0/u.test(text)) {
    refuse('the durable voice activation state has invalid encoding');
  }
  let state;
  try { state = JSON.parse(text); } catch {
    refuse('the durable voice activation state is unreadable');
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    refuse('the durable voice activation state is invalid');
  }
  if (state.version === 1) return normalizeLegacyActivationState(state, text);
  const expectedKeys = state.version === 2 ? ACTIVATION_STATE_KEYS_V2 : ACTIVATION_STATE_KEYS_V3;
  if (![2, 3].includes(state.version) || state.project !== PROJECT ||
      JSON.stringify(Object.keys(state)) !== JSON.stringify(expectedKeys) ||
      text !== `${JSON.stringify(state)}\n` ||
      !Number.isSafeInteger(state.activationGeneration) || state.activationGeneration < 0 ||
      !ACTIVATION_PHASES.has(state.phase) ||
      (state.previousPhase !== null && !ACTIVATION_PHASES.has(state.previousPhase)) ||
      !PANIC_STATES.has(state.panic) || !CLEANUP_STATES.has(state.cleanup) ||
      !validTimestamp(state.panicOutcomeUnknownAt, { nullable: true }) ||
      !validTimestamp(state.interruptedStartRecoveredAt, { nullable: true }) ||
      !validTimestamp(state.updatedAt) || !validActivationEvidence(state)) {
    refuse('the durable voice activation state is invalid');
  }
  let imageManifest = null;
  if (state.imageManifest !== null) {
    if (typeof state.imageManifest !== 'object' || Array.isArray(state.imageManifest)) {
      refuse('the durable voice activation image binding is invalid');
    }
    imageManifest = normalizeVoiceImageManifest(`${JSON.stringify(state.imageManifest)}\n`);
  }
  if ((state.activationGeneration === 0) !== (imageManifest === null)) {
    refuse('the durable voice activation generation is not bound to one image');
  }
  if (['starting', 'active', 'stopping'].includes(state.phase) &&
      state.activationGeneration < 1) {
    refuse('the durable voice activation state has no generation truth');
  }
  if (state.version === 3) {
    if (state.containerOwnership !== null) {
      normalizeContainerOwnership(state.containerOwnership, state.activationGeneration,
        imageManifest?.configDigest);
    } else if (state.phase === 'active') {
      refuse('active voice containers lack retained ownership');
    }
  }
  return Object.freeze({ ...state, imageManifest });
}

function readActivationState() {
  inspectRootPath(ACTIVATION_ROOT, { directory: true, mode: 0o700 });
  if (!fs.existsSync(ACTIVATION_STATE)) return null;
  const metadata = inspectRootPath(ACTIVATION_STATE, { mode: 0o600, nlink: 1 });
  if (metadata.size < 2 || metadata.size > 8192) {
    refuse('the durable voice activation state has an unsafe size');
  }
  return normalizeActivationState(fs.readFileSync(ACTIVATION_STATE));
}

function atomicWriteActivationState(state) {
  inspectRootPath(ACTIVATION_ROOT, { directory: true, mode: 0o700 });
  if (fs.existsSync(ACTIVATION_STATE)) {
    inspectRootPath(ACTIVATION_STATE, { mode: 0o600, nlink: 1 });
  }
  const payload = Buffer.from(`${JSON.stringify(state)}\n`);
  if (payload.length > 8192) refuse('the durable voice activation state is too large');
  const temporary = `${ACTIVATION_STATE}.new-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(descriptor, payload);
    fs.fchownSync(descriptor, 0, 0);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, ACTIVATION_STATE);
    const directory = fs.openSync(ACTIVATION_ROOT,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the original failure */ }
    if (error?.code === 'VOICE_STACK_REFUSED') throw error;
    refuse('the durable voice activation state could not be committed');
  }
}

function activationRequiresRecovery(state) {
  if (!state || ![2, 3].includes(state.version)) return true;
  if (state.phase !== 'inactive' || state.cleanup !== 'proved') return true;
  return !['not_requested', 'quiesced', 'recovered'].includes(state.panic);
}

function cleanupRequiresPanicRecovery(state) {
  if (!state || ![2, 3].includes(state.version)) return true;
  if (state.panic === 'outcome_unknown' || state.phase === 'panic_outcome_unknown') return true;
  const panicProved = ['quiesced', 'recovered'].includes(state.panic);
  return !panicProved && [
    'starting', 'active', 'stopping', 'cleanup_outcome_unknown',
  ].includes(state.phase);
}

function cleanupEvidenceDisposition(state) {
  if (cleanupRequiresPanicRecovery(state)) {
    return Object.freeze({
      phase: 'panic_outcome_unknown',
      panic: 'outcome_unknown',
      cleanup: 'proved',
    });
  }
  return Object.freeze({ phase: 'inactive', panic: null, cleanup: 'proved' });
}

function activationGenerationForTransition(previous, beginActivation) {
  if (typeof beginActivation !== 'boolean') {
    refuse('the voice activation generation transition is invalid');
  }
  const previousGeneration = [2, 3].includes(previous?.version) ? previous.activationGeneration : 0;
  if (!Number.isSafeInteger(previousGeneration) || previousGeneration < 0 ||
      (beginActivation && previousGeneration === Number.MAX_SAFE_INTEGER)) {
    refuse('the voice activation generation is exhausted or invalid');
  }
  return previousGeneration + (beginActivation ? 1 : 0);
}

function persistActivationState(phase, {
  imageManifest = null,
  panic = null,
  cleanup = null,
  beginActivation = false,
  now = new Date(),
} = {}) {
  if (!ACTIVATION_PHASES.has(phase)) refuse('the voice activation phase is invalid');
  if ((phase === 'starting') !== beginActivation) {
    refuse('the voice activation generation transition is invalid');
  }
  const previous = readActivationState();
  const nextPanic = panic || previous?.panic || 'not_requested';
  const nextCleanup = cleanup || previous?.cleanup || 'required';
  if (!PANIC_STATES.has(nextPanic) || !CLEANUP_STATES.has(nextCleanup)) {
    refuse('the voice activation evidence is invalid');
  }
  const activationGeneration = activationGenerationForTransition(previous, beginActivation);
  const nextImageManifest = imageManifest ||
    ([2, 3].includes(previous?.version) ? previous.imageManifest : null);
  if ((activationGeneration === 0) !== (nextImageManifest === null) ||
      (beginActivation && imageManifest === null)) {
    refuse('the voice activation generation is not bound to one image');
  }
  const timestamp = new Date(now).toISOString();
  const state = {
    version: 3,
    project: PROJECT,
    activationGeneration,
    phase,
    previousPhase: previous?.phase || null,
    panic: nextPanic,
    cleanup: nextCleanup,
    imageManifest: nextImageManifest,
    panicOutcomeUnknownAt: phase === 'panic_outcome_unknown' ? timestamp :
      previous?.panicOutcomeUnknownAt || null,
    interruptedStartRecoveredAt: phase === 'inactive' && previous?.phase === 'starting' ?
      timestamp : previous?.interruptedStartRecoveredAt || null,
    updatedAt: timestamp,
    containerOwnership: beginActivation ? null : previous?.version === 3 ?
      previous.containerOwnership : null,
  };
  normalizeActivationState(`${JSON.stringify(state)}\n`);
  atomicWriteActivationState(state);
  return Object.freeze(state);
}

function projectRuntime(identities, credentials) {
  const identity = identities.voice;
  inspectRootPath(RUNTIME_ROOT, { directory: true });
  const staging = `${RUNTIME_ROOT}/voice-secrets.new-${process.pid}`;
  fs.mkdirSync(staging, { mode: 0o750 });
  fs.chownSync(staging, 0, identity.gid);
  try {
    for (const [runtimeName, contents] of credentials) {
      const target = path.join(staging, runtimeName);
      fs.writeFileSync(target, contents, { mode: 0o440, flag: 'wx' });
      fs.chownSync(target, 0, identity.gid);
      fs.chmodSync(target, 0o440);
    }
    if (fs.existsSync(RUNTIME_SECRET_ROOT)) refuse('a prior voice secret projection still exists');
    fs.renameSync(staging, RUNTIME_SECRET_ROOT);

    const drachtio = credentials.get('teleagent-drachtio-secret').toString('utf8');
    const freeswitch = credentials.get('teleagent-freeswitch-secret').toString('utf8');
    atomicReplaceFile(`${RUNTIME_ROOT}/drachtio.conf.xml`, renderTemplate(
      `${APP_ROOT}/deploy/voice-stack/drachtio.conf.xml.template`,
      {
        __DRACHTIO_SECRET__: drachtio,
        __DRACHTIO_EXTERNAL_IP__: '127.0.0.1',
        __DRACHTIO_SIP_PORT__: '5070',
        __DRACHTIO_SIP_TRANSPORT__: 'udp',
      },
    ), { mode: 0o440, uid: 0, gid: identities.drachtio.gid });
    atomicReplaceFile(`${RUNTIME_ROOT}/freeswitch-event-socket.conf.xml`, renderTemplate(
      `${APP_ROOT}/deploy/voice-stack/freeswitch-event-socket.conf.xml.template`,
      { __FREESWITCH_SECRET__: freeswitch },
    ), { mode: 0o440, uid: 0, gid: identities.freeswitch.gid });
    ensureDockerConfigDirectory();
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    for (const value of credentials.values()) value.fill(0);
  }
}

function ensureDockerConfigDirectory() {
  inspectRootPath(RUNTIME_ROOT, { directory: true, mode: 0o700 });
  const dockerConfig = `${RUNTIME_ROOT}/docker-config`;
  if (fs.existsSync(dockerConfig)) {
    inspectRootPath(dockerConfig, { directory: true, mode: 0o700 });
    return;
  }
  fs.mkdirSync(dockerConfig, { mode: 0o700 });
  fs.chownSync(dockerConfig, 0, 0);
  fs.chmodSync(dockerConfig, 0o700);
}

function composeArgs(...args) {
  return ['compose', '--project-name', PROJECT, '--env-file', '/dev/null', '--file', COMPOSE_FILE, ...args];
}

function requestJson({
  method,
  pathname,
  token = null,
  body = null,
  timeoutMs = 5000,
  port = 3000,
  socketPath = null,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let absoluteTimer = null;
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      if (absoluteTimer) clearTimeout(absoluteTimer);
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (absoluteTimer) clearTimeout(absoluteTimer);
      reject(error);
    };
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      ...(socketPath ? { socketPath } : { host: '127.0.0.1', port }),
      method,
      path: pathname,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: timeoutMs,
    }, (response) => {
      const advertised = response.headers['content-length'];
      if (advertised !== undefined &&
          (typeof advertised !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(advertised) ||
           BigInt(advertised) > BigInt(MAX_CONTROL_RESPONSE_BYTES))) {
        fail(new Error('voice control response exceeded its byte bound'));
        response.destroy();
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_CONTROL_RESPONSE_BYTES) {
          fail(new Error('voice control response exceeded its byte bound'));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('aborted', () => fail(new Error('voice control response was aborted')));
      response.on('error', fail);
      response.on('end', () => {
        if (settled) return;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          succeed({ status: response.statusCode, body: parsed });
        } catch { fail(new Error('voice control returned invalid JSON')); }
      });
    });
    absoluteTimer = setTimeout(() => {
      request.destroy(new Error('voice control exceeded its total deadline'));
    }, timeoutMs);
    request.on('timeout', () => request.destroy(new Error('voice control timed out')));
    request.on('error', fail);
    if (payload) request.end(payload); else request.end();
  });
}

function startFailureDisposition(activationAttempted) {
  if (typeof activationAttempted !== 'boolean') {
    refuse('voice activation attempt evidence is invalid');
  }
  return activationAttempted ? Object.freeze({
    phase: 'panic_outcome_unknown',
    panic: 'outcome_unknown',
    cleanup: 'proved',
  }) : Object.freeze({
    phase: 'inactive',
    panic: 'not_requested',
    cleanup: 'proved',
  });
}

function requireProviderInstallClosure() {
  inspectRootPath(SOURCE_PROVIDER_MANIFEST, { mode: 0o444 });
  inspectRootPath(INSTALLED_PROVIDER_MANIFEST, { mode: 0o444 });
  const source = fs.readFileSync(SOURCE_PROVIDER_MANIFEST);
  const installed = fs.readFileSync(INSTALLED_PROVIDER_MANIFEST);
  if (source.length !== installed.length || !crypto.timingSafeEqual(source, installed)) {
    refuse('the provider libexec manifest is absent or unreviewed');
  }
  const targets = new Set();
  for (const line of installed.toString('utf8').trim().split('\n')) {
    const [digest, _sourcePath, target, mode, extra] = line.split(' ');
    if (extra !== undefined || !/^[a-f0-9]{64}$/u.test(digest || '') ||
        !(['teleagent-resource-admission', 'teleagent-resource-topology-watch'].includes(target) || /^teleagent-provider-[A-Za-z0-9.-]+$/u.test(target || '')) ||
        !(target === 'teleagent-resource-topology-watch' ? mode === '0555' : ['0755', '0444'].includes(mode)) || targets.has(target)) {
      refuse('the installed provider manifest is invalid');
    }
    targets.add(target);
    const artifact = `/usr/local/libexec/${target}`;
    inspectRootPath(artifact, { mode: Number.parseInt(mode, 8) });
    const actual = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    if (actual !== digest) refuse('a provider libexec artifact is absent or unreviewed');
  }
  if (!targets.has('teleagent-provider-model.apparmor')) {
    refuse('the provider model profile is outside the reviewed install closure');
  }
  inspectRootPath(APPARMOR_PROFILES);
  const profiles = fs.readFileSync(APPARMOR_PROFILES, 'utf8').split('\n');
  if (!profiles.includes('teleagent-provider-model (enforce)')) {
    refuse('the provider model AppArmor profile is not enforced');
  }
}

async function requireControllerReady(controlToken, { request = requestJson } = {}) {
  if (!Buffer.isBuffer(controlToken)) {
    refuse('the controller readiness credential is invalid');
  }
  try {
    if (controlToken.length < 32 || controlToken.length > 4096) {
      refuse('the controller readiness credential is invalid');
    }
    const response = await request({
      method: 'GET',
      pathname: '/operator/health',
      token: controlToken.toString('utf8'),
      socketPath: CONTROLLER_SOCKET,
      timeoutMs: 2000,
    });
    const body = response.body;
    if (response.status !== 200 || body?.ready !== true ||
        body?.service !== 'claude-api-server' ||
        body?.phoneAuthority?.mode !== 'read_only' ||
        body?.phoneAuthority?.status !== 'disabled_pending_independent_pbx_attester' ||
        body?.approvalCapabilities?.verifierConfigured !== false ||
        body?.authentication?.privilegedActionConfigured !== false ||
        body?.authentication?.privilegedActionRequired !== false ||
        body?.authentication?.allActiveScopesConfiguredAndDistinct !== true ||
        body?.privilegedActions?.enabled !== false ||
        body?.privilegedActions?.proxyConfigured !== false ||
        body?.privilegedActions?.authConfigured !== false) {
      refuse('the agent controller is not in the canonical read-only phone authority mode');
    }
  } finally {
    controlToken.fill(0);
  }
}

async function requireExecutorReady(executorToken, { request = requestJson } = {}) {
  if (!Buffer.isBuffer(executorToken)) {
    refuse('the executor readiness credential is invalid');
  }
  try {
    if (executorToken.length < 32 || executorToken.length > 4096) {
      refuse('the executor readiness credential is invalid');
    }
    const response = await request({
      method: 'GET',
      pathname: '/executor/health',
      token: executorToken.toString('utf8'),
      socketPath: CONTROLLER_SOCKET,
      timeoutMs: 2000,
    });
    if (response.status !== 200 || response.body?.ready !== true ||
        response.body?.service !== 'claude-api-server' ||
        response.body?.scope !== 'executor' || response.body?.status !== 'ready') {
      refuse('the durable executor scope is not ready for read-only phone work');
    }
  } finally {
    executorToken.fill(0);
  }
}

async function waitForHealth() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const health = await requestJson({ method: 'GET', pathname: '/api/realtime-health', timeoutMs: 1000 });
      if (health.status === 200 && health.body?.status === 'healthy' && health.body?.configured === true) return;
    } catch { /* bounded retry */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  refuse('the voice runtime did not become ready');
}

function requireActiveUnit(unit) {
  const result = run(SYSTEMCTL, ['is-active', '--quiet', unit], {
    capture: true,
    allowFailure: true,
    environment: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' },
  });
  if (result.status !== 0) refuse('a required voice-stack dependency is not active');
}

function removeRuntimeProjection() {
  fs.rmSync(RUNTIME_SECRET_ROOT, { recursive: true, force: true });
  for (const filename of [
    `${RUNTIME_ROOT}/drachtio.conf.xml`,
    `${RUNTIME_ROOT}/freeswitch-event-socket.conf.xml`,
  ]) fs.rmSync(filename, { force: true });
}

function parseExactProjectContainerIds(output) {
  const text = String(output || '');
  if (Buffer.byteLength(text) > 8192) {
    refuse('the exact voice project container listing is unbounded');
  }
  const identifiers = text.trim() ? text.trim().split('\n') : [];
  if (identifiers.length > 16 || identifiers.some((identifier) =>
    !/^[a-f0-9]{64}$/u.test(identifier)) || new Set(identifiers).size !== identifiers.length) {
    refuse('the exact voice project container listing is invalid');
  }
  return identifiers;
}

function listExactProjectContainerIds(runCommand, environment) {
  const listing = runCommand(DOCKER, [
    'container', 'ls', '--all', '--no-trunc', '--quiet', '--filter', `label=${PROJECT_LABEL}`,
  ], { capture: true, allowFailure: true, environment, timeoutMs: 10000 });
  if (listing.status !== 0) refuse('Docker could not enumerate the exact voice project');
  return parseExactProjectContainerIds(listing.stdout);
}

function parseDockerCgroupInfo(output) {
  const text = String(output || '');
  if (Buffer.byteLength(text) > 128 || text !== 'systemd\t2\n') {
    refuse('Docker is not using the reviewed systemd cgroup-v2 boundary');
  }
  return Object.freeze({ cgroupDriver: 'systemd', cgroupVersion: 2 });
}

function requireDockerCgroupBoundary({
  runCommand = run,
  environment = fixedDockerEnvironment(),
} = {}) {
  const information = runCommand(DOCKER, [
    'info', '--format', '{{.CgroupDriver}}\t{{.CgroupVersion}}',
  ], { capture: true, allowFailure: true, environment, timeoutMs: 10000 });
  if (information.status !== 0) {
    refuse('the Docker cgroup boundary is unverifiable');
  }
  return parseDockerCgroupInfo(information.stdout);
}

function parseVoiceContainerBoundary(output, activationGeneration, identities) {
  if (!Number.isSafeInteger(activationGeneration) || activationGeneration < 1) {
    refuse('the voice activation generation is invalid');
  }
  const text = String(output || '');
  if (Buffer.byteLength(text) > 8192 || /\r|\0/u.test(text)) {
    refuse('the voice container boundary evidence is invalid');
  }
  const rows = text.trim() ? text.trim().split('\n').map((line) => line.split('\t')) : [];
  if (rows.length !== VOICE_SERVICES.length || rows.some((fields) => fields.length !== 5)) {
    refuse('the exact voice services are not all inside the aggregate boundary');
  }
  const expectedUsers = Object.freeze({
    'voice-runtime-preflight': `${identities?.voice?.uid}:${identities?.voice?.gid}`,
    drachtio: `${identities?.drachtio?.uid}:${identities?.drachtio?.gid}`,
    freeswitch: `${identities?.freeswitch?.uid}:${identities?.freeswitch?.gid}`,
    'voice-app': `${identities?.voice?.uid}:${identities?.voice?.gid}`,
  });
  const services = rows.map(([
    service, generation, cgroupParent, configuredUser, configuredSupplementaryGroups,
  ]) => {
    if (!VOICE_SERVICES.includes(service) || generation !== String(activationGeneration) ||
        cgroupParent !== CONTAINER_SLICE || configuredUser !== expectedUsers[service] ||
        !['null', '[]'].includes(configuredSupplementaryGroups) ||
        configuredUser.startsWith('0:') || configuredUser.endsWith(':0')) {
      refuse('a voice container escaped its activation generation, identity, or aggregate boundary');
    }
    return service;
  });
  if (new Set(services).size !== VOICE_SERVICES.length) {
    refuse('the exact voice services are not all inside the aggregate boundary');
  }
  return Object.freeze([...services].sort());
}

function normalizeContainerOwnership(record, activationGeneration, voiceImageConfigDigest) {
  const services = [...VOICE_SERVICES].sort();
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      JSON.stringify(Object.keys(record)) !== JSON.stringify([
        'version', 'activationGeneration', 'services',
      ]) || record.version !== 1 || record.activationGeneration !== activationGeneration ||
      !Array.isArray(record.services) || record.services.length !== services.length ||
      !/^sha256:[a-f0-9]{64}$/u.test(voiceImageConfigDigest || '')) {
    refuse('the retained voice container ownership is invalid');
  }
  const seen = new Set();
  for (let index = 0; index < services.length; index += 1) {
    const row = record.services[index];
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        JSON.stringify(Object.keys(row)) !== JSON.stringify(['service', 'containerId', 'imageId']) ||
        row.service !== services[index] || !/^[a-f0-9]{64}$/u.test(row.containerId || '') ||
        !/^sha256:[a-f0-9]{64}$/u.test(row.imageId || '') || seen.has(row.containerId) ||
        (row.service === 'voice-app' && row.imageId !== voiceImageConfigDigest)) {
      refuse('the retained voice container ownership is invalid');
    }
    seen.add(row.containerId);
  }
  return Object.freeze(record);
}

function parseCreatedContainerOwnership(output, identifiers, activationGeneration, voiceImageConfigDigest) {
  const text = String(output || '');
  if (Buffer.byteLength(text) > 8192 || /\r|\0/u.test(text) || !text.endsWith('\n') ||
      !Array.isArray(identifiers) || identifiers.length !== VOICE_SERVICES.length) {
    refuse('created voice container ownership is unverifiable');
  }
  const rows = text.trimEnd().split('\n').map((line) => line.split('\t'));
  if (rows.length !== identifiers.length || rows.some((row) => row.length !== 4) ||
      text !== rows.map((row) => row.join('\t')).join('\n') + '\n') {
    refuse('created voice container ownership is incomplete');
  }
  const seenIds = new Set();
  const entries = rows.map(([containerId, service, generation, imageId]) => {
    if (!identifiers.includes(containerId) || seenIds.has(containerId) ||
        generation !== String(activationGeneration) || !VOICE_SERVICES.includes(service)) {
      refuse('created voice container ownership differs from the admitted generation');
    }
    seenIds.add(containerId);
    return { service, containerId, imageId };
  }).sort((left, right) => left.service < right.service ? -1 : left.service > right.service ? 1 : 0);
  return normalizeContainerOwnership({ version: 1, activationGeneration, services: entries },
    activationGeneration, voiceImageConfigDigest);
}

function captureCreatedContainerOwnership(activationGeneration, voiceImageConfigDigest, {
  runCommand = run,
  environment = fixedDockerEnvironment(),
} = {}) {
  const identifiers = listExactProjectContainerIds(runCommand, environment);
  if (identifiers.length !== VOICE_SERVICES.length) {
    refuse('the exact voice container set is incomplete');
  }
  const inspection = runCommand(DOCKER, [
    'container', 'inspect', '--format',
    `{{.Id}}\t{{index .Config.Labels "com.docker.compose.service"}}\t` +
      `{{index .Config.Labels "${ACTIVATION_GENERATION_LABEL}"}}\t{{.Image}}`,
    ...identifiers,
  ], { capture: true, allowFailure: true, environment, timeoutMs: 10000 });
  if (inspection.status !== 0) refuse('created voice container inspection failed');
  return parseCreatedContainerOwnership(inspection.stdout, identifiers,
    activationGeneration, voiceImageConfigDigest);
}

function persistCreatedContainerOwnership(ownership) {
  const previous = readActivationState();
  if (previous?.version !== 3 || previous.phase !== 'starting' ||
      previous.containerOwnership !== null) {
    refuse('created voice container ownership has no single starting transaction');
  }
  normalizeContainerOwnership(ownership, previous.activationGeneration,
    previous.imageManifest.configDigest);
  const updated = { ...previous, updatedAt: new Date().toISOString(), containerOwnership: ownership };
  normalizeActivationState(`${JSON.stringify(updated)}\n`);
  atomicWriteActivationState(updated);
  return updated;
}

function parseProcessIdentityStatus(source, expectedIdentity) {
  const text = String(source || '');
  if (Buffer.byteLength(text) > 64 * 1024 || /\r|\0/u.test(text) ||
      !expectedIdentity || !Number.isSafeInteger(expectedIdentity.uid) ||
      !Number.isSafeInteger(expectedIdentity.gid)) {
    refuse('a running voice process identity is unverifiable');
  }
  const fields = {};
  for (const label of ['Uid', 'Gid']) {
    const matches = text.split('\n').filter((line) => line.startsWith(`${label}:`));
    if (matches.length !== 1) refuse('a running voice process identity is ambiguous');
    const values = matches[0].slice(label.length + 1).trim().split(/\s+/u);
    if (values.length !== 4 || values.some((value) => !/^[1-9][0-9]*$/u.test(value))) {
      refuse('a running voice process identity is malformed');
    }
    fields[label] = values.map(Number);
  }
  const groupMatches = text.split('\n').filter((line) => line.startsWith('Groups:'));
  if (groupMatches.length !== 1) refuse('a running voice process identity is ambiguous');
  // /proc/PID/status reports supplementary groups here; the primary GID is
  // already bound by all four Gid fields above. Compose GroupAdd is forbidden,
  // so any value in Groups is an identity-boundary escape.
  const supplementaryGroups = groupMatches[0].slice('Groups:'.length).trim();
  if (supplementaryGroups !== '') {
    refuse('a running voice process has an unexpected supplementary group');
  }
  if (fields.Uid.some((value) => value !== expectedIdentity.uid) ||
      fields.Gid.some((value) => value !== expectedIdentity.gid)) {
    refuse('a running voice process escaped its configured host identity');
  }
  return true;
}

function verifyRunningProjectProcessIdentities(identities, {
  runCommand = run,
  environment = fixedDockerEnvironment(),
  fsModule = fs,
} = {}) {
  const identifiers = listExactProjectContainerIds(runCommand, environment);
  if (identifiers.length !== VOICE_SERVICES.length) {
    refuse('the exact voice services are not all running inside the identity boundary');
  }
  const inspectArgs = [
    'container', 'inspect', '--format',
    '{{index .Config.Labels "com.docker.compose.service"}}\t' +
      '{{.State.Status}}\t{{.State.Pid}}\t{{.State.ExitCode}}',
    ...identifiers,
  ];
  const inspect = () => runCommand(DOCKER, inspectArgs, {
    capture: true, allowFailure: true, environment, timeoutMs: 10000,
  });
  const before = inspect();
  if (before.status !== 0 || Buffer.byteLength(String(before.stdout || '')) > 8192 ||
      /\r|\0/u.test(String(before.stdout || ''))) {
    refuse('the running voice process identities are unverifiable');
  }
  const rows = String(before.stdout || '').trim().split('\n').map((line) => line.split('\t'));
  if (rows.length !== VOICE_SERVICES.length || rows.some((row) => row.length !== 4) ||
      new Set(rows.map((row) => row[0])).size !== VOICE_SERVICES.length) {
    refuse('the running voice process identity evidence is incomplete');
  }
  const expected = {
    drachtio: identities?.drachtio,
    freeswitch: identities?.freeswitch,
    'voice-app': identities?.voice,
  };
  for (const [service, status, pidText, exitCode] of rows) {
    if (service === 'voice-runtime-preflight') {
      if (status !== 'exited' || pidText !== '0' || exitCode !== '0') {
        refuse('the one-shot voice preflight did not exit cleanly');
      }
      continue;
    }
    if (!RUNNING_VOICE_SERVICES.includes(service) || status !== 'running' || exitCode !== '0' ||
        !/^[1-9][0-9]*$/u.test(pidText)) {
      refuse('a long-running voice process is not running exactly');
    }
    try {
      parseProcessIdentityStatus(
        fsModule.readFileSync(`/proc/${pidText}/status`, 'utf8'), expected[service]
      );
    } catch (error) {
      if (error?.code === 'VOICE_STACK_REFUSED') throw error;
      refuse('a running voice process identity is unreadable');
    }
  }
  const after = inspect();
  if (after.status !== 0 || after.stdout !== before.stdout) {
    refuse('a running voice process changed during identity verification');
  }
  return RUNNING_VOICE_SERVICES.length;
}

function verifyExactProjectContainerBoundary(activationGeneration, identities, {
  runCommand = run,
  environment = fixedDockerEnvironment(),
} = {}) {
  const identifiers = listExactProjectContainerIds(runCommand, environment);
  if (identifiers.length !== VOICE_SERVICES.length) {
    refuse('the exact voice services are not all inside the aggregate boundary');
  }
  const inspection = runCommand(DOCKER, [
    'container', 'inspect', '--format',
    `{{index .Config.Labels "com.docker.compose.service"}}\t` +
    `{{index .Config.Labels "${ACTIVATION_GENERATION_LABEL}"}}\t` +
      '{{.HostConfig.CgroupParent}}\t{{.Config.User}}\t{{json .HostConfig.GroupAdd}}',
    ...identifiers,
  ], { capture: true, allowFailure: true, environment, timeoutMs: 10000 });
  if (inspection.status !== 0) refuse('the voice container boundary is unverifiable');
  parseVoiceContainerBoundary(inspection.stdout, activationGeneration, identities);
  return identifiers.length;
}

function cleanupExactProject({
  runCommand = run,
  environment = fixedDockerEnvironment(),
} = {}) {
  const identifiers = listExactProjectContainerIds(runCommand, environment);
  if (identifiers.length > 0) {
    const removal = runCommand(DOCKER, ['container', 'rm', '--force', ...identifiers], {
      capture: true,
      allowFailure: true,
      environment,
      timeoutMs: 15000,
    });
    if (removal.status !== 0) refuse('Docker could not remove the exact voice project');
  }
  if (listExactProjectContainerIds(runCommand, environment).length !== 0) {
    refuse('voice-stack cleanup could not prove zero project containers and listeners');
  }
  return identifiers.length;
}

function rollbackStartedStack(environment) {
  try {
    run(DOCKER, composeArgs('down', '--timeout', '10', '--remove-orphans'), {
      environment,
      capture: true,
      allowFailure: true,
      timeoutMs: 20000,
    });
  } catch { /* exact label cleanup below is the authoritative fallback */ }
  cleanupExactProject({ environment });
  removeRuntimeProjection();
}

async function start() {
  // Receiver namespaces require coordinated endpoint/health/PBX integration.
  // Source candidates cannot fall back to the old shared host-network plane.
  requireRuntimeIntegration();
  for (const filename of [APP_ROOT, COMPOSE_FILE, `${APP_ROOT}/lib/voice-app-runtime-env.js`]) {
    inspectRootPath(filename, { directory: filename === APP_ROOT });
  }
  if (fs.existsSync(`${APP_ROOT}/.env`) || fs.existsSync(`${APP_ROOT}/voice-app/.env`)) {
    refuse('dotenv files are forbidden in the deployed voice stack');
  }
  if (activationRequiresRecovery(readActivationState())) {
    refuse('durable voice activation evidence requires explicit offline recovery');
  }
  requireActiveUnit('docker.service');
  requireActiveUnit(CONTAINER_SLICE);
  ensureDockerConfigDirectory();
  requireDockerCgroupBoundary();
  cleanupExactProject();
  removeRuntimeProjection();

  const imageManifest = readVoiceImageManifest();
  verifyVoiceImage(imageManifest);
  requireActiveUnit('teleagent-sip-local-peer-fence.service');
  requireActiveUnit('teleagent-agent-controller.service');
  requireActiveUnit('teleagent-agent-controller.socket');
  run(SIP_FENCE, ['check'], {
    environment: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  });
  requireProviderInstallClosure();
  for (const provider of ['claude', 'codex']) {
    run(PROVIDER_CLI_CHECK, ['--provider', provider], {
      environment: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    });
  }
  const identities = resolveVoiceIdentities();
  const identity = identities.voice;
  verifyBoundedHostStateFilesystem(identity);
  const settings = readEnvironmentFile(identities);
  const controllerControlToken = openCredential(
    path.join(CREDENTIAL_ROOT, 'voice-control-token'),
    { gid: identity.gid, kind: 'token' }
  );
  await requireControllerReady(controllerControlToken);
  const executorReadinessToken = openCredential(
    path.join(CREDENTIAL_ROOT, 'executor-api-token'),
    { gid: identity.gid, kind: 'token' }
  );
  await requireExecutorReady(executorReadinessToken);
  const startingState = persistActivationState('starting', {
    imageManifest,
    panic: 'not_requested',
    cleanup: 'required',
    beginActivation: true,
  });
  const environment = fixedDockerEnvironment(
    settings, imageManifest, startingState.activationGeneration
  );
  let activationAttempted = false;
  try {
    const credentials = readCredentialSet(identity);
    projectRuntime(identities, credentials);
    run(DOCKER, composeArgs('config', '--quiet'), { environment });
    // Container creation is the first activating Docker mutation. Inspect the
    // immutable configured identities before any service process may start.
    activationAttempted = true;
    run(DOCKER, composeArgs('create', '--no-build', '--pull', 'never'), { environment });
    verifyExactProjectContainerBoundary(
      startingState.activationGeneration, identities, { environment }
    );
    const ownership = captureCreatedContainerOwnership(
      startingState.activationGeneration, imageManifest.configDigest, { environment }
    );
    persistCreatedContainerOwnership(ownership);
    if (JSON.stringify(captureCreatedContainerOwnership(
      startingState.activationGeneration, imageManifest.configDigest, { environment }
    )) !== JSON.stringify(ownership)) {
      refuse('created voice container identities changed before start');
    }
    // `up` retains Compose's preflight completion dependency after the
    // separately inspected create phase.
    run(DOCKER, composeArgs('up', '--detach', '--no-build', '--pull', 'never'), { environment });
    if (JSON.stringify(captureCreatedContainerOwnership(
      startingState.activationGeneration, imageManifest.configDigest, { environment }
    )) !== JSON.stringify(ownership)) {
      refuse('Compose replaced a retained voice container identity during start');
    }
    verifyRunningProjectProcessIdentities(identities, { environment });
    await waitForHealth();
    verifyRunningProjectProcessIdentities(identities, { environment });
    verifyExactProjectContainerBoundary(
      startingState.activationGeneration, identities, { environment }
    );
    persistActivationState('active', {
      imageManifest,
      panic: 'not_requested',
      cleanup: 'required',
    });
  } catch (error) {
    try {
      rollbackStartedStack(environment);
      const disposition = startFailureDisposition(activationAttempted);
      persistActivationState(disposition.phase, {
        imageManifest,
        panic: disposition.panic,
        cleanup: disposition.cleanup,
      });
    } catch (rollbackError) {
      try {
        persistActivationState('cleanup_outcome_unknown', {
          imageManifest,
          panic: 'outcome_unknown',
          cleanup: 'outcome_unknown',
        });
      } catch { /* retain the rollback refusal as the primary failure */ }
      throw rollbackError;
    }
    throw error;
  }
}

async function stop() {
  let activationEvidenceError = null;
  let stoppingState = null;
  try {
    stoppingState = persistActivationState('stopping', {
      panic: 'requested', cleanup: 'required',
    });
  } catch (error) {
    activationEvidenceError = error;
  }
  let identities;
  let identity;
  let settings;
  let tokenBuffer;
  try {
    identities = resolveVoiceIdentities();
    identity = identities.voice;
    settings = readEnvironmentFile(identities);
    tokenBuffer = openCredential(path.join(CREDENTIAL_ROOT, 'voice-control-token'), {
      gid: identity.gid,
      kind: 'token',
    });
  } catch (error) {
    try {
      persistActivationState('panic_outcome_unknown', {
        panic: 'outcome_unknown',
        cleanup: 'required',
      });
    } catch { /* retain the prerequisite refusal as the primary failure */ }
    throw error;
  }
  let panic;
  try {
    panic = await requestJson({
      method: 'POST',
      pathname: '/api/voice-control/stop',
      token: tokenBuffer.toString('utf8'),
      body: { source: 'teleagent_voice_stack', reason: 'systemd_voice_stack_stop' },
      timeoutMs: 15000,
    });
    assertPanicQuiesced(panic);
  } catch (error) {
    try {
      persistActivationState('panic_outcome_unknown', {
        panic: 'outcome_unknown',
        cleanup: 'required',
      });
    } catch { /* retain the panic refusal as the primary failure */ }
    throw error;
  } finally {
    tokenBuffer.fill(0);
  }
  if (activationEvidenceError) throw activationEvidenceError;
  stoppingState = persistActivationState('stopping', { panic: 'quiesced', cleanup: 'required' });
  const imageManifest = stoppingState.imageManifest;
  const environment = fixedDockerEnvironment(
    settings, imageManifest, stoppingState.activationGeneration
  );
  try {
    run(DOCKER, composeArgs('stop', '--timeout', '25', 'voice-app'), {
      environment,
      timeoutMs: 40000,
    });
    const inspection = run(DOCKER, [
      'inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', 'voice-app',
    ], { capture: true, environment, timeoutMs: 10000 }).stdout.trim();
    assertVoiceExit(inspection);
    run(DOCKER, composeArgs('down', '--timeout', '10', '--remove-orphans'), {
      environment,
      timeoutMs: 20000,
    });
    cleanupExactProject({ environment });
    removeRuntimeProjection();
    persistActivationState('inactive', { imageManifest, panic: 'quiesced', cleanup: 'proved' });
  } catch (error) {
    try {
      persistActivationState('cleanup_outcome_unknown', {
        imageManifest,
        panic: 'quiesced',
        cleanup: 'outcome_unknown',
      });
    } catch { /* retain the stop failure as the primary failure */ }
    throw error;
  }
}

function cleanup() {
  let priorState = null;
  let stateReadError = null;
  try { priorState = readActivationState(); } catch (error) { stateReadError = error; }
  const disposition = cleanupEvidenceDisposition(priorState);
  try {
    cleanupExactProject();
    removeRuntimeProjection();
    if (stateReadError) throw stateReadError;
    persistActivationState(disposition.phase, {
      panic: disposition.panic,
      cleanup: disposition.cleanup,
    });
  } catch (error) {
    if (!stateReadError) {
      try {
        persistActivationState('cleanup_outcome_unknown', {
          panic: disposition.panic,
          cleanup: 'outcome_unknown',
        });
      } catch { /* retain the cleanup refusal as the primary failure */ }
    }
    throw error;
  }
}

async function runOfflineRecovery(priorState, {
  requireUnit = requireActiveUnit,
  ensureDockerConfig = ensureDockerConfigDirectory,
  cleanupProject = cleanupExactProject,
  removeProjection = removeRuntimeProjection,
  loadControlToken = () => {
    const identity = resolveVoiceIdentities().voice;
    return openCredential(path.join(CREDENTIAL_ROOT, 'voice-control-token'), {
      gid: identity.gid,
      kind: 'token',
    });
  },
  request = requestJson,
  persist = persistActivationState,
} = {}) {
  if (!activationRequiresRecovery(priorState)) {
    refuse('the voice stack has no unresolved activation evidence to recover');
  }
  requireUnit('docker.service');
  ensureDockerConfig();
  cleanupProject();
  removeProjection();
  requireUnit('teleagent-agent-controller.service');
  const tokenBuffer = loadControlToken();
  if (!Buffer.isBuffer(tokenBuffer)) refuse('the recovery control credential is invalid');
  try {
    persist('panic_outcome_unknown', {
      panic: 'requested',
      cleanup: 'proved',
    });
    const panic = await request({
      method: 'POST',
      pathname: '/voice-control/stop',
      token: tokenBuffer.toString('utf8'),
      body: { source: 'teleagent_voice_stack', reason: 'offline_activation_recovery' },
      timeoutMs: 15000,
      socketPath: CONTROLLER_SOCKET,
    });
    assertPanicQuiesced(panic);
  } catch (error) {
    try {
      persist('panic_outcome_unknown', {
        panic: 'outcome_unknown',
        cleanup: 'proved',
      });
    } catch { /* retain the recovery refusal as the primary failure */ }
    throw error;
  } finally {
    tokenBuffer.fill(0);
  }
  persist('inactive', { panic: 'recovered', cleanup: 'proved' });
}

async function recover() {
  await runOfflineRecovery(readActivationState());
}

function requireLifecycleLock(operation, {
  environment = process.env,
  filesystem = fs,
} = {}) {
  const value = environment[LIFECYCLE_LOCK_ENV];
  if (!['stop', 'recover'].includes(operation)) {
    if (value !== undefined) refuse('the voice lifecycle lock was supplied to an unsupported operation');
    return null;
  }
  if (!/^(?:[3-9]|[1-9][0-9]+)$/u.test(value || '')) {
    refuse('the fixed host verifier did not retain the voice lifecycle lock');
  }
  const descriptor = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(descriptor) || descriptor > 1_000_000) {
    refuse('the voice lifecycle lock descriptor is invalid');
  }
  let descriptorMetadata;
  let pathMetadata;
  try {
    descriptorMetadata = filesystem.fstatSync(descriptor);
    pathMetadata = filesystem.lstatSync(HANDOFF_LOCK);
  } catch {
    refuse('the voice lifecycle lock is unavailable');
  }
  if (!descriptorMetadata.isDirectory() || !pathMetadata.isDirectory() ||
      descriptorMetadata.dev !== pathMetadata.dev || descriptorMetadata.ino !== pathMetadata.ino ||
      pathMetadata.uid !== 0 || pathMetadata.gid !== 0 || (pathMetadata.mode & 0o7777) !== 0o700) {
    refuse('the voice lifecycle lock identity is unsafe');
  }
  delete environment[LIFECYCLE_LOCK_ENV];
  return descriptor;
}

function assertPanicQuiesced(panic) {
  if (panic?.status !== 200 || panic.body?.success !== true) {
    refuse('voice panic was persisted but full quiescence was not confirmed');
  }
  return true;
}

function assertVoiceExit(inspection) {
  if (inspection !== 'exited 0') {
    refuse('voice-app did not prove a clean, quiescent shutdown');
  }
  return true;
}

async function main() {
  const operation = process.argv[2];
  if (process.geteuid() !== 0 || !IMMUTABLE_RELEASE_ROOT.test(APP_ROOT) ||
      process.env.TELEAGENT_RELEASE_ROOT !== APP_ROOT ||
      fs.realpathSync(process.execPath) !== `${APP_ROOT}/runtime/node/bin/node` ||
      fs.realpathSync(process.argv[1] || '') !== WRAPPER || process.execArgv.length !== 0 ||
      process.argv.length !== 3 || !['start', 'stop', 'cleanup', 'recover'].includes(operation)) {
    refuse('the voice-stack wrapper must run as root through one gated immutable release');
  }
  requireLifecycleLock(operation);
  if (operation === 'start') await start();
  else if (operation === 'stop') await stop();
  else if (operation === 'recover') await recover();
  else cleanup();
}

module.exports = {
  assertPanicQuiesced,
  assertVoiceExit,
  activationGenerationForTransition,
  activationRequiresRecovery,
  cleanupEvidenceDisposition,
  cleanupExactProject,
  cleanupRequiresPanicRecovery,
  captureCreatedContainerOwnership,
  normalizeActivationState,
  normalizeContainerOwnership,
  normalizeVoiceImageManifest,
  parseDockerCgroupInfo,
  parseVoiceEnvironmentFile,
  parseExactProjectContainerIds,
  parseCreatedContainerOwnership,
  parseProcessIdentityStatus,
  parseVoiceContainerBoundary,
  resolveVoiceIdentities,
  requestJson,
  requireLifecycleLock,
  renderTemplate,
  renderTemplateContents,
  requireControllerReady,
  requireDockerCgroupBoundary,
  requireExecutorReady,
  runOfflineRecovery,
  startFailureDisposition,
  verifyBoundedHostStateFilesystem,
  verifyVoiceAppRuntimeContract,
  verifyExactProjectContainerBoundary,
  verifyRunningProjectProcessIdentities,
  verifyVoiceImage,
  FIXED_VOICE_APP_BOUNDARY_ENV,
  MAX_CONTROL_RESPONSE_BYTES,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Voice stack refused: ${error.message}\n`);
    process.exitCode = 1;
  });
}
