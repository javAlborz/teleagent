'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname,
  '../../deploy/worker-session/teleagent-provider-runtime'), 'utf8');

// Run the real runtime with a pid-only procfs fixture. Stop at workspace
// validation, after network admission but before any executable can launch.
function inspectNetwork({ devices = ['lo'], ipv4 = 'Iface Destination\n',
  ipv6 = '', unavailable = null } = {}) {
  let refusal = '';
  let spawned = false;
  const reads = [];
  const files = new Map([
    ['/proc/self/attr/current', 'teleagent-provider-model (enforce)\n'],
    ['/proc/self/status', 'NoNewPrivs:\t1\n' +
      ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map(x => `${x}:\t0000000000000000\n`).join('')],
    ['/sys/class/net/lo/type', '772\n'],
    ['/proc/self/net/route', ipv4],
    ['/proc/self/net/ipv6_route', ipv6],
  ]);
  const exit = new Error('fixture exit');
  const filesystem = {
    readFileSync(filename) {
      reads.push(filename);
      if (!files.has(filename) || filename === unavailable) {
        throw Object.assign(new Error('absent proc entry'), { code: 'ENOENT' });
      }
      return files.get(filename);
    },
    readdirSync(filename) { assert.equal(filename, '/sys/class/net'); return [...devices]; },
    existsSync() { return false; },
    realpathSync() { throw new Error('stop at workspace boundary'); },
  };
  const spawn = () => { spawned = true; throw new Error('unexpected executable launch'); };
  assert.throws(() => vm.runInNewContext(source, {
    require(name) {
      return { 'node:fs': filesystem, 'node:os': { userInfo: () => ({ username: 'teleagent-codex-worker' }) },
        'node:path': path, 'node:child_process': { spawn, spawnSync: spawn } }[name];
    },
    process: {
      argv: ['node', '/usr/local/libexec/teleagent-provider-runtime', '--provider', 'codex',
        '--launch-id', 'launch_' + '1'.repeat(32), '--mode', 'managed',
        '--access-mode', 'read-only', '--workspace', '/srv/teleagent-agent-workspaces/phone', '--'],
      getuid: () => 971, env: {}, stderr: { write: value => { refusal += value; } },
      exit: () => { throw exit; },
    },
  }), error => error === exit || (unavailable && error.code === 'ENOENT'));
  assert.equal(spawned, false);
  return { refusal, reads };
}

test('pid-only procfs admits the private process route view', () => {
  const result = inspectNetwork();
  assert.match(result.refusal, /workspace is unavailable/);
  assert.ok(result.reads.includes('/proc/self/net/route'));
  assert.ok(result.reads.includes('/proc/self/net/ipv6_route'));
  assert.ok(result.reads.every(p => !p.startsWith('/proc/net/')));
});

test('external interfaces and default routes remain denied', () => {
  assert.match(inspectNetwork({ devices: ['eth0', 'lo'] }).refusal, /not loopback-only/);
  assert.match(inspectNetwork({ ipv4: 'Iface Destination\neth0 00000000\n' }).refusal,
    /external IPv4 route/);
  assert.match(inspectNetwork({ ipv6: '0'.repeat(32) + ' 00 0 00 0 0 0 0 0 eth0\n' }).refusal,
    /external IPv6 route/);
});

test('missing IPv4 evidence refuses before launch; disabled IPv6 remains supported', () => {
  const missing = inspectNetwork({ unavailable: '/proc/self/net/route' });
  assert.equal(missing.refusal, '');
  assert.match(inspectNetwork({ unavailable: '/proc/self/net/ipv6_route' }).refusal,
    /workspace is unavailable/);
});

// Exercise the real argument-admission block independently of the root-only
// namespace setup, which is covered by the installed offline runtime probe.
function admittedCodexArgs(extra = []) {
  const { buildCodexArgs } = require('../agent-cli');
  const args = buildCodexArgs({ model: 'gpt-5.6-luna', reasoningEffort: 'low',
    sandbox: 'read-only', approvalPolicy: 'never',
    workingDirectory: '/srv/teleagent-agent-workspaces/phone' });
  const flagCheck = source.slice(source.indexOf('function requireExactFlag('),
    source.indexOf('requireRootJson(EMPTY_SETTINGS'));
  const admission = source.slice(source.indexOf('let providerArgs = args;'),
    source.indexOf('process.umask(0o027)'));
  return JSON.parse(vm.runInNewContext(`${flagCheck}\n${admission}\nJSON.stringify(providerArgs)`, {
    args: [...args, ...extra], provider: 'codex', mode: 'managed',
    spec: { baseUrl: 'http://127.0.0.1:18444/v1' },
    fail: message => { throw new Error(message); },
  }));
}

test('runtime pins Landlock and local egress independently of caller configuration', () => {
  const args = admittedCodexArgs();
  assert.equal(args.filter(value => value === 'features.use_legacy_landlock=true').length, 1);
  assert.ok(args.includes('model_provider="teleagent-egress"'));
  assert.ok(args.includes('model_providers.teleagent-egress.base_url="http://127.0.0.1:18444/v1"'));
  assert.ok(args.includes('read-only'));
  for (const extra of [
    ['--disable', 'use_legacy_landlock'], ['--disable=use_legacy_landlock'],
    ['--enable', 'unreviewed_feature'], ['--enable=unreviewed_feature'],
    ['-c', 'features.use_legacy_landlock=false'],
    ['--config', 'model_provider="openai"'],
  ]) assert.throws(() => admittedCodexArgs(extra), /cannot be overridden/);
});
