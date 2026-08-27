'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const INSTALLER = path.join(
  __dirname, '../../deploy/worker-session/teleagent-provider-libexec-install'
);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-provider-libexec-test-'));
  fs.chmodSync(root, 0o700);
  const log = path.join(root, 'systemctl.log');
  fs.writeFileSync(log, '');
  const cgroup = path.join(root, 'cgroup', 'provider-test');
  fs.mkdirSync(cgroup, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cgroup, 'cgroup.events'), 'populated 0\nfrozen 0\n');
  const systemctl = path.join(root, 'systemctl');
  fs.writeFileSync(systemctl, `#!/bin/sh
set -eu
scenario=\${FAKE_SYSTEMCTL_SCENARIO:-success}
case "\${1:-}" in
  show)
    property=\${3#--property=}
    printf '%s\\t%s\\n' "$property" "\${2:-}" >> "$FAKE_SYSTEMCTL_LOG"
    if [ "$scenario" = query-failure ] && [ "$property" = ActiveState ]; then exit 1; fi
    case "$property" in
      LoadState) [ "$scenario" = missing ] && printf 'not-found\\n' || printf 'loaded\\n' ;;
      UnitFileState) [ "$scenario" = enabled ] && printf 'enabled\\n' || printf 'static\\n' ;;
      ActiveState) [ "$scenario" = active ] && printf 'active\\n' || printf 'inactive\\n' ;;
      SubState) [ "$scenario" = transitional ] && printf 'start-pre\\n' || printf 'dead\\n' ;;
      ControlGroup) printf '/provider-test\\n' ;;
      *) exit 64 ;;
    esac
    ;;
  list-units)
    printf 'list-units\\n' >> "$FAKE_SYSTEMCTL_LOG"
    [ "$scenario" != list-failure ] || exit 1
    [ "$scenario" != transient ] || printf 'teleagent-provider-launch-claude-dead.service loaded inactive dead\\n'
    ;;
  *) exit 64 ;;
esac
`, { mode: 0o700 });
  fs.chmodSync(systemctl, 0o700);
  return { root, systemctl, log, cgroupEvents: path.join(cgroup, 'cgroup.events') };
}

function runCheck(value, scenario) {
  return spawnSync(INSTALLER, ['--quiescence-check'], {
    cwd: '/',
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      TELEAGENT_PROVIDER_LIBEXEC_TEST_ONLY: '1',
      TELEAGENT_PROVIDER_LIBEXEC_TEST_ROOT: value.root,
      TELEAGENT_PROVIDER_LIBEXEC_TEST_SYSTEMCTL: value.systemctl,
      FAKE_SYSTEMCTL_SCENARIO: scenario,
      FAKE_SYSTEMCTL_LOG: value.log,
    },
  });
}

test('provider libexec updater proves exact inactive units, empty cgroups, and zero transients', (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const result = runCheck(value, 'success');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'PROVIDER_LIBEXEC_QUIESCENT_OK\n');
  const units = [
    'teleagent-worker-session.service',
    'teleagent-worker-session.socket',
    'teleagent-provider-supervisor@claude.service',
    'teleagent-provider-supervisor@codex.service',
    'teleagent-provider-supervisor@claude.socket',
    'teleagent-provider-supervisor@codex.socket',
    'teleagent-provider-egress@claude.service',
    'teleagent-provider-egress@codex.service',
    'teleagent-provider-egress@claude.socket',
    'teleagent-provider-egress@codex.socket',
    'teleagent-provider-egress-control@claude.socket',
    'teleagent-provider-egress-control@codex.socket',
  ];
  assert.deepEqual(fs.readFileSync(value.log, 'utf8').trim().split('\n'), [
    ...units.flatMap((unit) => [
      `LoadState\t${unit}`,
      `UnitFileState\t${unit}`,
      `ActiveState\t${unit}`,
      `SubState\t${unit}`,
      `ControlGroup\t${unit}`,
    ]),
    'list-units',
  ]);
});

test('provider libexec updater fails closed on every unit, cgroup, and enumeration ambiguity', (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  for (const scenario of [
    'missing', 'enabled', 'active', 'transitional',
    'query-failure', 'list-failure', 'transient',
  ]) {
    const result = runCheck(value, scenario);
    assert.equal(result.status, 75, `${scenario}: ${result.stderr}`);
  }
  fs.writeFileSync(value.cgroupEvents, 'populated 1\nfrozen 0\n');
  const populated = runCheck(value, 'success');
  assert.equal(populated.status, 75, populated.stderr);
  assert.match(populated.stderr, /cgroup is populated/);
});
