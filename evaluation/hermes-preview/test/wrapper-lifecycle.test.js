'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '../../..');
const wrapperPath = path.join(repositoryRoot, 'scripts/hermes-evaluation-preview');

function runProbe(body, environment = {}) {
  const result = spawnSync('/usr/bin/bash', [
    '--noprofile', '--norc', '-c', `source "$1"\n${body}`, 'probe', wrapperPath,
  ], {
    encoding: 'utf8',
    env: { ...process.env, BASH_ENV: '', ...environment },
    maxBuffer: 1024 * 1024,
    timeout: 3000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

test('teardown attempts every postcondition and fails on simultaneous route and stop failure', () => {
  const probe = runProbe(String.raw`
calls=''
mark_cleanup_pending() { calls="$calls marker"; return "$MOCK_MARK"; }
remove_exact_route() { calls="$calls route"; return "$MOCK_ROUTE"; }
stop_main_unit() { calls="$calls main"; return "$MOCK_MAIN"; }
unlink_facade_socket() { calls="$calls socket"; return "$MOCK_SOCKET"; }
erase_runtime_files() { calls="$calls files"; return "$MOCK_FILES"; }
clear_cleanup_pending() { calls="$calls clear"; return "$MOCK_CLEAR"; }
if teardown_preview_state; then result=0; else result=$?; fi
printf 'result=%s;calls=%s\n' "$result" "$calls"
  `, {
    MOCK_MARK: '0',
    MOCK_ROUTE: '2',
    MOCK_MAIN: '1',
    MOCK_SOCKET: '0',
    MOCK_FILES: '0',
    MOCK_CLEAR: '0',
  });

  assert.equal(probe.stdout, 'result=1;calls= marker route main socket files');
  assert.match(probe.stderr, /teardown postconditions are incomplete/u);
});

test('teardown succeeds only when marker, route, unit, socket, and files are all clean', () => {
  for (const failing of ['mark', 'route', 'main', 'socket', 'files', 'clear']) {
    const environment = {
      MOCK_MARK: '0',
      MOCK_ROUTE: '0',
      MOCK_MAIN: '0',
      MOCK_SOCKET: '0',
      MOCK_FILES: '0',
      MOCK_CLEAR: '0',
    };
    environment[`MOCK_${failing.toUpperCase()}`] = '1';
    const probe = runProbe(String.raw`
mark_cleanup_pending() { return "$MOCK_MARK"; }
remove_exact_route() { return "$MOCK_ROUTE"; }
stop_main_unit() { return "$MOCK_MAIN"; }
unlink_facade_socket() { return "$MOCK_SOCKET"; }
erase_runtime_files() { return "$MOCK_FILES"; }
clear_cleanup_pending() { return "$MOCK_CLEAR"; }
if teardown_preview_state; then result=0; else result=$?; fi
printf '%s\n' "$result"
`, environment);
    assert.equal(probe.stdout, '1', failing);
  }

  const clean = runProbe(String.raw`
mark_cleanup_pending() { return 0; }
remove_exact_route() { return 0; }
stop_main_unit() { return 0; }
unlink_facade_socket() { return 0; }
erase_runtime_files() { return 0; }
clear_cleanup_pending() { return 0; }
if teardown_preview_state; then result=0; else result=$?; fi
printf '%s\n' "$result"
`);
  assert.equal(clean.stdout, '0');
  assert.equal(clean.stderr, '');
});

test('route removal trusts verified absence rather than the helper command exit', () => {
  const probeBody = String.raw`
preview_command() { return "$MOCK_COMMAND"; }
route_class() { printf '%s\n' "$MOCK_ROUTE_CLASS"; }
if remove_exact_route; then result=0; else result=$?; fi
printf '%s\n' "$result"
`;

  assert.equal(runProbe(probeBody, {
    MOCK_COMMAND: '1', MOCK_ROUTE_CLASS: 'absent',
  }).stdout, '0');
  const stillPublished = runProbe(probeBody, {
    MOCK_COMMAND: '0', MOCK_ROUTE_CLASS: 'exact',
  });
  assert.equal(stillPublished.stdout, '2');
  assert.match(stillPublished.stderr, /route absence was not verified/u);
  for (const unresolved of ['unknown', 'conflict']) {
    assert.equal(runProbe(probeBody, {
      MOCK_COMMAND: '0', MOCK_ROUTE_CLASS: unresolved,
    }).stdout, '2');
  }
});

test('main stop trusts the verified unit state rather than the stop command exit', () => {
  const probeBody = String.raw`
systemctl_user() {
  case "$1" in
    stop) return "$MOCK_STOP" ;;
    show) printf '%s\n' "$MOCK_STATE"; return "$MOCK_SHOW" ;;
    *) return 99 ;;
  esac
}
if stop_main_unit; then result=0; else result=$?; fi
printf '%s\n' "$result"
`;

  assert.equal(runProbe(probeBody, {
    MOCK_STOP: '1', MOCK_STATE: 'inactive', MOCK_SHOW: '0',
  }).stdout, '0');
  assert.equal(runProbe(probeBody, {
    MOCK_STOP: '1', MOCK_STATE: 'failed', MOCK_SHOW: '0',
  }).stdout, '0');
  assert.equal(runProbe(probeBody, {
    MOCK_STOP: '0', MOCK_STATE: 'active', MOCK_SHOW: '0',
  }).stdout, '1');
  for (const unresolved of ['activating', 'deactivating']) {
    assert.equal(runProbe(probeBody, {
      MOCK_STOP: '0', MOCK_STATE: unresolved, MOCK_SHOW: '0',
    }).stdout, '1');
  }
  assert.equal(runProbe(probeBody, {
    MOCK_STOP: '0', MOCK_STATE: 'inactive', MOCK_SHOW: '1',
  }).stdout, '1');
});

test('manual stop retains guards when teardown is incomplete', () => {
  const probe = runProbe(String.raw`
guard_calls=0
teardown_preview_state() { return 1; }
stop_cleanup_guards() { guard_calls=$((guard_calls + 1)); return 0; }
if stop_preview; then result=0; else result=$?; fi
printf 'result=%s;guards=%s\n' "$result" "$guard_calls"
`);
  assert.equal(probe.stdout, 'result=1;guards=0');
  assert.match(probe.stderr, /cleanup guards were retained for retry/u);
  assert.doesNotMatch(probe.stderr, /preview stopped/u);
});

test('abort, expiry, and watchdog retain retry behavior after teardown failure', () => {
  const abortProbe = runProbe(String.raw`
guard_calls=0
teardown_preview_state() { return 1; }
stop_cleanup_guards() { guard_calls=$((guard_calls + 1)); return 0; }
fail() { printf 'failure=%s\n' "$*"; return 97; }
if abort_published_start 'publish failed'; then result=0; else result=$?; fi
printf 'result=%s;guards=%s\n' "$result" "$guard_calls"
`);
  assert.equal(abortProbe.stdout,
    'failure=publish failed; teardown is incomplete and cleanup guards were retained for retry\n' +
    'result=97;guards=0');

  const expiryProbe = runProbe(String.raw`
systemctl_calls=0
teardown_preview_state() { return 1; }
systemctl_user() { systemctl_calls=$((systemctl_calls + 1)); return 0; }
if expire_preview; then result=0; else result=$?; fi
printf 'result=%s;systemctl=%s\n' "$result" "$systemctl_calls"
`);
  assert.equal(expiryProbe.stdout, 'result=1;systemctl=0');

  const watchdogProbe = runProbe(String.raw`
teardown_preview_state() { return 1; }
if watchdog_teardown; then result=0; else result=$?; fi
printf '%s\n' "$result"
`);
  assert.equal(watchdogProbe.stdout, '1');
});

test('watchdog resets consecutive failures and returns failed teardown for systemd retry', () => {
  const probe = runProbe(String.raw`
health_call=0
teardown_calls=0
require_lifecycle_commands() { :; }
systemctl_user() { [ "$1" = 'is-active' ]; }
cleanup_pending_present() { return 1; }
facade_healthy() {
  health_call=$((health_call + 1))
  case "$health_call" in 3) return 0 ;; *) return 1 ;; esac
}
wait_watch_interval() { :; }
acquire_cleanup_lock() { return 0; }
watchdog_teardown() { teardown_calls=$((teardown_calls + 1)); return 1; }
if watch_preview; then result=0; else result=$?; fi
printf 'result=%s;health=%s;teardown=%s\n' "$result" "$health_call" "$teardown_calls"
`);
  assert.equal(probe.stdout, 'result=1;health=6;teardown=1');
});

test('watchdog tears down immediately after the main unit becomes inactive', () => {
  const probe = runProbe(String.raw`
health_call=0
teardown_calls=0
require_lifecycle_commands() { :; }
systemctl_user() { return 1; }
cleanup_pending_present() { return 1; }
facade_healthy() { health_call=$((health_call + 1)); return 0; }
acquire_cleanup_lock() { return 0; }
watchdog_teardown() { teardown_calls=$((teardown_calls + 1)); return 0; }
if watch_preview; then result=0; else result=$?; fi
printf 'result=%s;health=%s;teardown=%s\n' "$result" "$health_call" "$teardown_calls"
`);
  assert.equal(probe.stdout, 'result=0;health=0;teardown=1');
});

test('watchdog restart retries pending teardown without accepting facade health', () => {
  const probe = runProbe(String.raw`
health_calls=0
teardown_calls=0
require_lifecycle_commands() { :; }
systemctl_user() { [ "$1" = 'is-active' ]; }
cleanup_pending_present() { return 0; }
facade_healthy() { health_calls=$((health_calls + 1)); return 0; }
acquire_cleanup_lock() { return 0; }
watchdog_teardown() { teardown_calls=$((teardown_calls + 1)); return 1; }
if watch_preview; then result=0; else result=$?; fi
printf 'result=%s;health=%s;teardown=%s\n' "$result" "$health_calls" "$teardown_calls"
`);
  assert.equal(probe.stdout, 'result=1;health=0;teardown=1');
});

test('manual stop shuts guards down only after teardown succeeds', () => {
  const probe = runProbe(String.raw`
calls=''
teardown_preview_state() { calls="$calls teardown"; return 0; }
stop_cleanup_guards() { calls="$calls guards"; return 0; }
if stop_preview; then result=0; else result=$?; fi
printf 'result=%s;calls=%s\n' "$result" "$calls"
`);
  assert.equal(probe.stdout,
    'Hermes evaluation preview stopped; route, socket, process, token, and cache are absent.\n' +
    'result=0;calls= teardown guards');
});

test('published abort removes state and stops guards before reporting launch failure', () => {
  const probe = runProbe(String.raw`
teardown_preview_state() { printf 'teardown\n'; return 0; }
stop_cleanup_guards() { printf 'guards\n'; return 0; }
fail() { printf 'failure=%s\n' "$*"; exit 97; }
if (abort_published_start 'launch URL failed'); then result=0; else result=$?; fi
printf 'result=%s\n' "$result"
`);
  assert.equal(probe.stdout,
    'teardown\nguards\nfailure=launch URL failed\nresult=97');
});

test('expiry and guard stops use verified inactive postconditions', () => {
  const expiryProbe = runProbe(String.raw`
teardown_preview_state() { return 0; }
systemctl_user() {
  case "$1" in
    stop) return 1 ;;
    show) printf 'inactive\n'; return 0 ;;
    *) return 99 ;;
  esac
}
if expire_preview; then result=0; else result=$?; fi
printf '%s\n' "$result"
`);
  assert.equal(expiryProbe.stdout, '0');

  const guardProbe = runProbe(String.raw`
systemctl_user() {
  case "$1" in
    stop) return "$MOCK_STOP" ;;
    show)
      printf '%s\n' "$MOCK_STATE"
      return "$MOCK_SHOW"
      ;;
    *) return 99 ;;
  esac
}
if stop_cleanup_guards; then result=0; else result=$?; fi
printf '%s\n' "$result"
`, { MOCK_STOP: '1', MOCK_STATE: 'inactive', MOCK_SHOW: '0' });
  assert.equal(guardProbe.stdout, '0');

  const activeGuard = runProbe(String.raw`
systemctl_user() {
  case "$1" in
    stop) return 0 ;;
    show) printf 'active\n'; return 0 ;;
    *) return 99 ;;
  esac
}
if stop_cleanup_guards; then result=0; else result=$?; fi
printf '%s\n' "$result"
`);
  assert.equal(activeGuard.stdout, '1');
});
