'use strict';

// Owner-run isolated image contract checks. All mounted state and credentials
// are synthetic. No running production service or lock is called or modified.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', DOCKER_CONFIG: '/var/empty' };
function insist(ok, message) { if (!ok) throw new Error(message); }
function command(program, args, timeout = 20000) {
  const r = spawnSync(program, args, { env, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  insist(!r.error && r.status === 0, `Isolated contract check failed: ${path.basename(program)}`);
  return r.stdout;
}
function docker(...args) { return command('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args]); }
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function main() {
  insist(process.getuid() === 0 && process.argv.length === 4 && process.argv.slice(2).every(id => /^sha256:[a-f0-9]{64}$/.test(id)),
    'Supply the two reviewed immutable image IDs as the owner');
  const fixture = fs.mkdtempSync('/tmp/teleagent-hermes-bootstrap-fixture-');
  const testIds = [];
  fs.chmodSync(fixture, 0o755);
  try {
    for (const name of ['state', 'secrets', 'lock']) fs.mkdirSync(`${fixture}/${name}`, { mode: name === 'lock' ? 0o755 : 0o750 });
    fs.chownSync(`${fixture}/state`, 65534, 65534);
    fs.chownSync(`${fixture}/secrets`, 0, 65534);
    fs.writeFileSync(`${fixture}/lock/voice-execution.lock.json`, '{"locked":true,"reason":"synthetic_test"}\n', { mode: 0o444 });
    for (const name of ['drachtio-secret', 'freeswitch-secret', 'openai-realtime-api-key', 'outbound-api-token']) {
      const file = `${fixture}/secrets/${name}`;
      fs.writeFileSync(file, `SYNTHETIC-NONFUNCTIONAL-${name}`, { mode: 0o440 });
      fs.chownSync(file, 0, 65534);
    }
    const database = `${fixture}/state/voice-state.sqlite`;
    command('/usr/bin/sqlite3', ['-init', '/dev/null', database,
      'PRAGMA journal_mode=WAL; CREATE TABLE jobs(status TEXT); CREATE TABLE approvals(status TEXT); CREATE TABLE realtime_sessions(status TEXT);']);
    fs.chownSync(database, 65534, 65534); fs.chmodSync(database, 0o600);
    const controllerSource = '/home/alborz/phone/teleagent/lib/voice-execution-control.js';
    const controllerBytes = fs.readFileSync(controllerSource);
    fs.writeFileSync(`${fixture}/controller-lock.cjs`, controllerBytes, { mode: 0o444 });
    const rootLockTest = `const assert=require('node:assert/strict');const {VoiceExecutionControl}=require(${JSON.stringify(`${fixture}/controller-lock.cjs`)});const c=new VoiceExecutionControl({lockFile:${JSON.stringify(`${fixture}/lock/voice-execution.lock.json`)}});assert.equal(c.getStatus().persistent,true);assert.equal(c.getStatus().locked,true);assert.equal(c.lock().persistent,true);assert.equal(c.unlock().locked,true);assert.equal(c.markRemotePanicPending().locked,true);assert.equal(c.getStatus().persistent,false);process.stdout.write('CONTROLLER_LOCK_FAIL_CLOSED\\n');`;
    insist(command('/usr/bin/setpriv', ['--reuid', '1000', '--regid', '1000', '--clear-groups', '--no-new-privs',
      '/usr/local/libexec/teleagent-node', '-e', rootLockTest]).trim() === 'CONTROLLER_LOCK_FAIL_CLOSED', 'Host controller lock contract failed');
    const common = ['--rm', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '128', '--user', '65534:65534',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
      '--mount', `type=bind,src=${fixture}/state,dst=/app/state`,
      '--mount', `type=bind,src=${fixture}/lock,dst=/app/execution-control,readonly`,
      '--mount', `type=bind,src=${fixture}/secrets,dst=/run/secrets,readonly`,
      ...Object.entries({ HTTP_HOST: '127.0.0.1', WS_HOST: '127.0.0.1', DRACHTIO_HOST: '127.0.0.1', FREESWITCH_HOST: '127.0.0.1',
        VOICE_STATE_DB_PATH: '/app/state/voice-state.sqlite', VOICE_APP_EXECUTION_LOCK_FILE: '/app/execution-control/voice-execution.lock.json' }).flatMap(([name, value]) => ['--env', `${name}=${value}`])];
    const pidOne = `const net=require('node:net');const assert=require('node:assert/strict');const {VoiceExecutionControl}=require('/app/lib/voice-execution-control.js');const c=new VoiceExecutionControl({lockFile:'/app/execution-control/voice-execution.lock.json'});assert.equal(c.getStatus().locked,true);assert.equal(c.getStatus().persistent,true);assert.equal(c.lock().persistent,true);assert.equal(c.unlock().locked,true);let connected=0;for(const port of [8021,9022]){const server=net.createServer(()=>{});server.listen(port,'127.0.0.1',()=>{const socket=net.connect(port,'127.0.0.1',()=>{if(++connected===2)process.stdout.write('SYNTHETIC_MEDIA_READY\\n')});socket.on('error',()=>process.exit(2));});}`;
    for (const image of process.argv.slice(2)) {
      insist(docker('run', ...common, image, 'preflight').trim() === 'HERMES_VOICE_PREFLIGHT_OK', 'Image preflight failed');
      const id = docker('run', '--detach', ...common, '--entrypoint', '/usr/local/bin/node', image, '-e', pidOne).trim();
      insist(/^[a-f0-9]{64}$/.test(id), 'Synthetic container ID is invalid');
      testIds.push(id);
      const deadline = Date.now() + 10000;
      let ready = false;
      while (Date.now() < deadline) {
        const logs = docker('logs', '--tail', '5', id);
        if (logs.includes('SYNTHETIC_MEDIA_READY')) { ready = true; break; }
        await wait(100);
      }
      insist(ready, 'Synthetic media did not start');
      insist(docker('exec', id, '/usr/local/bin/node', '/app/voice-app/hermes-bootstrap.cjs', 'health').trim() === 'HERMES_VOICE_MEDIA_CONNECTED',
        'Actual image PID-1 socket health check failed');
      const inspection = JSON.parse(docker('container', 'inspect', id))[0];
      insist(inspection.Config.Env.every(value => !/^(DRACHTIO_SECRET|FREESWITCH_SECRET|OPENAI_REALTIME_API_KEY|OUTBOUND_API_TOKEN)=/.test(value)),
        'Synthetic test found a Docker credential environment entry');
      docker('stop', '--time', '3', id);
      testIds.splice(testIds.indexOf(id), 1);
      process.stdout.write(`ISOLATED_IMAGE_CONTRACT_OK ${image}\n`);
    }
    process.stdout.write(`CONTROLLER_LOCK_SOURCE_SHA256 ${crypto.createHash('sha256').update(controllerBytes).digest('hex')}\n`);
  } finally {
    for (const id of testIds) { try { docker('stop', '--time', '3', id); } catch {} }
    insist(fixture.startsWith('/tmp/teleagent-hermes-bootstrap-fixture-') && fs.lstatSync(fixture).uid === 0, 'Synthetic cleanup target changed');
    fs.rmSync(fixture, { recursive: true });
  }
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
