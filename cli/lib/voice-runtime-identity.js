import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const VOICE_RUNTIME_USER = 'teleagent-voice';
export const VOICE_RUNTIME_HOME = '/var/lib/teleagent-voice';
export const MEDIA_RUNTIME_SPECS = Object.freeze({
  drachtio: Object.freeze({ name: 'teleagent-drachtio', home: '/nonexistent' }),
  freeswitch: Object.freeze({ name: 'teleagent-freeswitch', home: '/nonexistent' }),
});
export const VOICE_RUNTIME_PATH_BINDINGS = Object.freeze({
  DEVICE_CONFIG_DIR: '/etc/teleagent-voice/config',
  VOICE_STATE_DIR: '/var/lib/teleagent-voice',
  SIP_TRUNK_INGRESS_PASSWORD_HOST_FILE:
    '/etc/teleagent-voice/credentials/sip-ingress-password',
  SIP_TRUNK_CALLBACK_PASSWORD_HOST_FILE:
    '/etc/teleagent-voice/credentials/sip-callback-password',
});
const NON_LOGIN_SHELLS = new Set(['/usr/sbin/nologin', '/sbin/nologin']);

export class VoiceRuntimeIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VoiceRuntimeIdentityError';
    this.code = 'VOICE_RUNTIME_IDENTITY_INVALID';
  }
}

export const VOICE_RUNTIME_MIGRATION_GUIDANCE =
  'Provision distinct dedicated non-login teleagent-voice, teleagent-drachtio, and ' +
  'teleagent-freeswitch system users/groups, set their explicit Compose UID/GID bindings, ' +
  'and install both SIP trunk credentials as ' +
  'root:teleagent-voice mode 0440. On Hermes, run the reviewed homelab ' +
  'check-hermes-teleagent-voice-identity.sh --require-ready audit before retrying.';

function invalid(reason) {
  throw new VoiceRuntimeIdentityError(
    `Dedicated voice runtime is not ready: ${reason}. ${VOICE_RUNTIME_MIGRATION_GUIDANCE}`
  );
}

function parseNumericIdentity(value, label) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(text)) invalid(`${label} is not a non-root numeric ID`);
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed > 2147483647 || parsed === 1000) {
    invalid(`${label} must not be root or the legacy owner ID 1000`);
  }
  return parsed;
}

export function normalizeVoiceRuntimeIdentity(identity) {
  if (!identity || typeof identity !== 'object' || identity.name !== VOICE_RUNTIME_USER) {
    invalid(`the exact ${VOICE_RUNTIME_USER} identity was not resolved`);
  }
  const uid = parseNumericIdentity(identity.uid, 'teleagent-voice UID');
  const gid = parseNumericIdentity(identity.gid, 'teleagent-voice GID');
  if (identity.home !== VOICE_RUNTIME_HOME) invalid('teleagent-voice home is not private');
  if (!NON_LOGIN_SHELLS.has(identity.shell)) invalid('teleagent-voice has a login shell');
  return Object.freeze({
    name: VOICE_RUNTIME_USER,
    uid,
    gid,
    home: VOICE_RUNTIME_HOME,
    shell: identity.shell,
  });
}

function normalizeMediaIdentity(identity, spec) {
  if (!identity || typeof identity !== 'object' || identity.name !== spec.name) {
    invalid(`the exact ${spec.name} identity was not resolved`);
  }
  const uid = parseNumericIdentity(identity.uid, `${spec.name} UID`);
  const gid = parseNumericIdentity(identity.gid, `${spec.name} GID`);
  if (identity.home !== spec.home) invalid(`${spec.name} home is not private`);
  if (!NON_LOGIN_SHELLS.has(identity.shell)) invalid(`${spec.name} has a login shell`);
  return Object.freeze({ name: spec.name, uid, gid, home: spec.home, shell: identity.shell });
}

export function normalizeMediaRuntimeIdentities(mediaIdentities, voiceIdentity) {
  const voice = normalizeVoiceRuntimeIdentity(voiceIdentity);
  const normalized = Object.fromEntries(Object.entries(MEDIA_RUNTIME_SPECS).map(([key, spec]) => [
    key, normalizeMediaIdentity(mediaIdentities?.[key], spec),
  ]));
  const entries = [voice, ...Object.values(normalized)];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if ([entries[right].uid, entries[right].gid].includes(entries[left].uid) ||
          [entries[right].uid, entries[right].gid].includes(entries[left].gid)) {
        invalid('the voice and media numeric identities are reused');
      }
    }
  }
  return Object.freeze(normalized);
}

function defaultLookup(database, name) {
  try {
    return execFileSync('/usr/bin/getent', [database, name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 16 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

function defaultSupplementaryGroups(name) {
  try {
    return execFileSync('/usr/bin/id', ['-G', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 16 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

export function resolveVoiceRuntimeIdentity({
  platform = process.platform,
  currentUid = typeof process.getuid === 'function' ? process.getuid() : null,
  lookup = defaultLookup,
  supplementaryGroups = defaultSupplementaryGroups,
} = {}) {
  if (platform !== 'linux') invalid('the hardened voice runtime requires Linux system identities');

  const passwd = String(lookup('passwd', VOICE_RUNTIME_USER) || '');
  if (passwd.includes('\n')) invalid('teleagent-voice passwd lookup returned multiple records');
  const passwdFields = passwd.split(':');
  if (passwdFields.length !== 7 || passwdFields[0] !== VOICE_RUNTIME_USER) {
    invalid('teleagent-voice does not exist');
  }
  const identity = normalizeVoiceRuntimeIdentity({
    name: passwdFields[0],
    uid: passwdFields[2],
    gid: passwdFields[3],
    home: passwdFields[5],
    shell: passwdFields[6],
  });
  if (Number.isInteger(currentUid) && currentUid !== 0 && identity.uid === currentUid) {
    invalid('teleagent-voice reuses the invoking owner identity');
  }

  const group = String(lookup('group', VOICE_RUNTIME_USER) || '');
  if (group.includes('\n')) invalid('teleagent-voice group lookup returned multiple records');
  const groupFields = group.split(':');
  if (groupFields.length !== 4 || groupFields[0] !== VOICE_RUNTIME_USER) {
    invalid('teleagent-voice primary group does not exist');
  }
  const groupGid = parseNumericIdentity(groupFields[2], 'teleagent-voice group GID');
  if (groupGid !== identity.gid) invalid('teleagent-voice primary group does not match its user');
  if (groupFields[3] !== '') invalid('teleagent-voice credential group has supplementary members');

  const groupIds = String(supplementaryGroups(VOICE_RUNTIME_USER) || '')
    .split(/\s+/u)
    .filter(Boolean);
  if (groupIds.length !== 1 || groupIds[0] !== String(identity.gid)) {
    invalid('teleagent-voice belongs to supplementary groups');
  }
  return identity;
}

export function resolveMediaRuntimeIdentities({
  voiceIdentity,
  platform = process.platform,
  currentUid = typeof process.getuid === 'function' ? process.getuid() : null,
  lookup = defaultLookup,
  supplementaryGroups = defaultSupplementaryGroups,
} = {}) {
  if (platform !== 'linux') invalid('the hardened media runtime requires Linux system identities');
  const resolved = {};
  for (const [key, spec] of Object.entries(MEDIA_RUNTIME_SPECS)) {
    const passwd = String(lookup('passwd', spec.name) || '');
    if (passwd.includes('\n')) invalid(`${spec.name} passwd lookup returned multiple records`);
    const passwdFields = passwd.split(':');
    if (passwdFields.length !== 7 || passwdFields[0] !== spec.name) {
      invalid(`${spec.name} does not exist`);
    }
    const identity = normalizeMediaIdentity({
      name: passwdFields[0], uid: passwdFields[2], gid: passwdFields[3],
      home: passwdFields[5], shell: passwdFields[6],
    }, spec);
    if (Number.isInteger(currentUid) && currentUid !== 0 && identity.uid === currentUid) {
      invalid(`${spec.name} reuses the invoking owner identity`);
    }
    const group = String(lookup('group', spec.name) || '');
    if (group.includes('\n')) invalid(`${spec.name} group lookup returned multiple records`);
    const groupFields = group.split(':');
    if (groupFields.length !== 4 || groupFields[0] !== spec.name) {
      invalid(`${spec.name} primary group does not exist`);
    }
    const groupGid = parseNumericIdentity(groupFields[2], `${spec.name} group GID`);
    if (groupGid !== identity.gid) invalid(`${spec.name} primary group does not match its user`);
    if (groupFields[3] !== '') invalid(`${spec.name} credential group has supplementary members`);
    const groupIds = String(supplementaryGroups(spec.name) || '').split(/\s+/u).filter(Boolean);
    if (groupIds.length !== 1 || groupIds[0] !== String(identity.gid)) {
      invalid(`${spec.name} belongs to supplementary groups`);
    }
    resolved[key] = identity;
  }
  return normalizeMediaRuntimeIdentities(resolved, voiceIdentity);
}

export function resolveVoiceRuntimeIdentityForInstallation(
  installationType,
  resolver = resolveVoiceRuntimeIdentity,
) {
  return installationType === 'api-server' ? null : resolver();
}

export function resolveVoiceRuntimeIdentitiesForInstallation(
  installationType,
  voiceResolver = resolveVoiceRuntimeIdentity,
  mediaResolver = resolveMediaRuntimeIdentities,
) {
  if (installationType === 'api-server') return null;
  const voiceIdentity = voiceResolver();
  const mediaIdentities = mediaResolver({ voiceIdentity });
  return Object.freeze({ voiceIdentity, mediaIdentities });
}

function exactEnvValue(source, key) {
  const matches = source.split(/\r?\n/u).filter((line) => line.startsWith(`${key}=`));
  if (matches.length !== 1) invalid(`generated .env must contain exactly one ${key}`);
  return matches[0].slice(key.length + 1);
}

export function assertVoiceRuntimeEnvFile(envPath, identity, fsModule = fs) {
  const normalized = normalizeVoiceRuntimeIdentity(identity);
  let metadata;
  let source;
  try {
    metadata = fsModule.lstatSync(envPath);
    source = fsModule.readFileSync(envPath, 'utf8');
  } catch {
    invalid('generated Compose environment is missing or unreadable');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink?.() || metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== 0o600) {
    invalid('generated Compose environment metadata is unsafe');
  }
  if (exactEnvValue(source, 'VOICE_APP_UID') !== String(normalized.uid) ||
      exactEnvValue(source, 'VOICE_APP_GID') !== String(normalized.gid)) {
    invalid('generated Compose environment has stale voice UID/GID bindings');
  }
  for (const [key, expected] of Object.entries(VOICE_RUNTIME_PATH_BINDINGS)) {
    if (exactEnvValue(source, key) !== expected) {
      invalid(`generated Compose environment has stale ${key} binding`);
    }
  }
  return normalized;
}
