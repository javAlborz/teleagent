'use strict';

// Compatibility launcher for the two immutable, reviewed Hermes legacy images.
// Credentials enter Node memory after exec; Docker argv/environment stay clean.
const fs = require('node:fs');
const path = require('node:path');

const SECRET_ROOT = '/run/secrets';
const LOCK_FILE = '/app/execution-control/voice-execution.lock.json';
const STATE_FILE = '/app/state/voice-state.sqlite';
const REQUIRED = ['DRACHTIO_SECRET', 'FREESWITCH_SECRET', 'OPENAI_REALTIME_API_KEY', 'OUTBOUND_API_TOKEN'];
const OPTIONAL = ['SIP_AUTH_PASSWORD', 'TTS_API_KEY', 'STT_API_KEY'];
const FORBIDDEN = ['AGENT_API_TOKEN', 'CLAUDE_API_TOKEN', 'EXECUTOR_API_TOKEN', 'PRIVILEGED_ACTION_API_TOKEN',
  'VOICE_APPROVAL_SIGNING_KEY', 'VOICE_APPROVAL_SIGNING_KEY_FILE', 'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV',
  'ENV', 'LD_PRELOAD', 'LD_LIBRARY_PATH'];

function insist(ok, message) { if (!ok) throw new Error(message); }
function readSecret(name, required) {
  const file = path.join(SECRET_ROOT, name.toLowerCase().replaceAll('_', '-'));
  if (!fs.existsSync(file)) { insist(!required, 'A required voice credential is absent'); return null; }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const metadata = fs.fstatSync(fd);
    insist(metadata.isFile() && metadata.nlink === 1 && metadata.uid === 0 &&
      metadata.gid === process.getgid() && (metadata.mode & 0o777) === 0o440 &&
      metadata.size > 0 && metadata.size <= 4097, 'Voice credential metadata is unsafe');
    let value = fs.readFileSync(fd, 'utf8');
    if (value.endsWith('\n')) value = value.slice(0, -1);
    insist(!/[\r\n\0]/.test(value) && value.length > 0 && (!required || value.length >= 16),
      'Voice credential encoding or length is invalid');
    return value;
  } finally { fs.closeSync(fd); }
}
function checkLocked() {
  const directory = fs.lstatSync(path.dirname(LOCK_FILE));
  insist(directory.isDirectory() && directory.uid === 0 && (directory.mode & 0o022) === 0,
    'Shared panic-lock directory is unsafe');
  const fd = fs.openSync(LOCK_FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const metadata = fs.fstatSync(fd);
    insist(metadata.isFile() && metadata.uid === 0 && metadata.nlink === 1 &&
      (metadata.mode & 0o222) === 0 && metadata.size <= 4096, 'Shared panic-lock metadata is unsafe');
    insist(JSON.parse(fs.readFileSync(fd, 'utf8')).locked === true, 'Shared panic lock is not set');
    return { device: metadata.dev, inode: metadata.ino };
  } finally { fs.closeSync(fd); }
}
function databaseGate() {
  const metadata = fs.lstatSync(STATE_FILE);
  insist(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 &&
    metadata.uid === process.getuid() && (metadata.mode & 0o077) === 0,
    'Voice database metadata is unsafe');
  const Database = require('better-sqlite3');
  const database = new Database(STATE_FILE, { readonly: true, fileMustExist: true });
  try {
    insist(database.pragma('quick_check', { simple: true }) === 'ok' &&
      database.pragma('foreign_key_check').length === 0, 'Voice database integrity gate failed');
    const count = database.prepare(`SELECT
      (SELECT COUNT(*) FROM jobs WHERE status IN ('awaiting_approval','queued','running')) +
      (SELECT COUNT(*) FROM approvals WHERE status='pending') +
      (SELECT COUNT(*) FROM realtime_sessions WHERE status IN ('connecting','connected')) AS active`).get();
    insist(count.active === 0, 'Voice database has active work');
  } finally { database.close(); }
}
function mediaConnections() {
  const sockets = new Set(fs.readdirSync('/proc/1/fd').flatMap(name => {
    try { const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/1/fd/${name}`)); return match ? [match[1]] : []; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }));
  const connections = fs.readFileSync('/proc/1/net/tcp', 'utf8').split('\n').slice(1).map(line => line.trim().split(/\s+/));
  for (const port of [8021, 9022]) {
    const endpoint = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
    insist(connections.some(columns => columns[2] === endpoint && columns[3] === '01' && sockets.has(columns[9])),
      'The voice process lacks an established media-control connection');
  }
}
function main() {
  insist(process.getuid() !== 0 && process.getuid() !== 1000 && process.getgid() !== 0 && process.getgid() !== 1000,
    'The dedicated voice identity is required');
  insist(process.execArgv.length === 0 && process.argv.length === 3 && ['preflight', 'serve', 'health'].includes(process.argv[2]),
    'Invalid voice launcher arguments');
  for (const name of FORBIDDEN) insist(!process.env[name], 'An unreviewed execution setting is present');
  for (const name of [...REQUIRED, ...OPTIONAL]) insist(!process.env[name], 'A credential was supplied in the exec environment');
  for (const filename of ['/app/.env', '/app/voice-app/.env']) insist(!fs.existsSync(filename), 'Image contains a dotenv file');
  insist(process.env.HTTP_HOST === '127.0.0.1' && process.env.WS_HOST === '127.0.0.1' &&
    process.env.FREESWITCH_HOST === '127.0.0.1' && process.env.DRACHTIO_HOST === '127.0.0.1',
    'Voice network boundary drifted');
  insist(process.env.VOICE_STATE_DB_PATH === STATE_FILE && process.env.VOICE_APP_EXECUTION_LOCK_FILE === LOCK_FILE,
    'Voice state paths drifted');
  checkLocked();
  if (process.argv[2] === 'health') {
    mediaConnections();
    process.stdout.write('HERMES_VOICE_MEDIA_CONNECTED\n');
    return;
  }
  databaseGate();
  const credentials = {};
  for (const name of REQUIRED) credentials[name] = readSecret(name, true);
  for (const name of OPTIONAL) { const value = readSecret(name, false); if (value !== null) credentials[name] = value; }
  insist(credentials.DRACHTIO_SECRET !== credentials.FREESWITCH_SECRET, 'Media credentials must be distinct');
  if (process.argv[2] === 'preflight') {
    process.stdout.write('HERMES_VOICE_PREFLIGHT_OK\n');
    return;
  }
  for (const [name, value] of Object.entries(credentials)) process.env[name] = value;
  // Fixed empty general bridge authority, regardless of the image's old defaults.
  process.env.AGENT_API_TOKEN = '';
  process.env.CLAUDE_API_TOKEN = '';
  process.env.AGENT_LOG_SENSITIVE = 'false';
  process.env.CLAUDE_LOG_SENSITIVE = 'false';
  process.env.VOICE_PRIVILEGED_ACTIONS_ENABLED = 'false';
  process.env.AGENT_DURABLE_EXECUTOR_ENABLED = 'false';
  require('/app/voice-app/index.js');
}

module.exports = { checkLocked, databaseGate, readSecret, mediaConnections };
if (require.main === module) {
  try { main(); } catch {
    // Do not expose database contents, credential values, or parser excerpts.
    process.stderr.write('Hermes voice preflight refused the runtime contract.\n');
    process.exitCode = 1;
  }
}
