'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '../../..');
const evaluationRoot = path.join(repositoryRoot, 'evaluation/hermes-preview');
const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

test('facade has a fixed Unix socket and no raw-state or live-health dependency', () => {
  const server = read('evaluation/hermes-preview/server.js');
  const requires = [...server.matchAll(/require\('([^']+)'\)/gu)].map((match) => match[1]);

  assert.match(server,
    /const RUNTIME_SOCKET = '\/run\/teleagent-evaluation\/facade\.sock';/u);
  assert.match(server, /const SNAPSHOT_FILE = '\/snapshot\/summary\.json';/u);
  assert.match(server, /server\.listen\(RUNTIME_SOCKET/u);
  assert.deepEqual(requires.filter((name) => name.startsWith('.')).sort(), [
    './runtime-files', './snapshot-schema',
  ]);
  assert.doesNotMatch(server,
    /aggregate-store|\.\/health|node:sqlite|voice-state|realtime-health|127\.0\.0\.1|:3000|:3333/u);
  assert.doesNotMatch(server, /\bfetch\s*\(/u);
  assert.doesNotMatch(server, /\/api\/(?:call|dispatch|unlock|session|ask|executor|privileged)/u);
});

test('collectors split raw database and live network while composition remains offline', () => {
  const evidenceCollector = read('evaluation/hermes-preview/collect-evidence.js');
  const healthCollector = read('evaluation/hermes-preview/collect-health.js');
  const composer = read('evaluation/hermes-preview/compose-snapshot.js');
  const wrapper = read('scripts/hermes-evaluation-preview');

  assert.match(evidenceCollector, /readAggregateEvidence/u);
  assert.match(evidenceCollector, /\/run\/teleagent-evaluation-epoch/u);
  assert.doesNotMatch(evidenceCollector, /readLoopbackHealth|fetch\s*\(/u);
  assert.match(healthCollector, /readLoopbackHealth/u);
  assert.doesNotMatch(healthCollector, /aggregate|sqlite|voice-state|TOKEN/u);
  assert.match(composer, /composeSnapshot/u);
  assert.doesNotMatch(composer, /aggregate-store|\.\/health|fetch\s*\(|node:sqlite/u);

  const evidenceBody = wrapper.slice(
    wrapper.indexOf('run_evidence_collector() {'),
    wrapper.indexOf('run_health_collector() {'),
  );
  const healthBody = wrapper.slice(
    wrapper.indexOf('run_health_collector() {'),
    wrapper.indexOf('run_snapshot_composer() {'),
  );
  const composerBody = wrapper.slice(
    wrapper.indexOf('run_snapshot_composer() {'),
    wrapper.indexOf('collect_and_publish_snapshot() {'),
  );
  const facadeBody = wrapper.slice(
    wrapper.indexOf('run_facade() {'),
    wrapper.indexOf('print_url() {'),
  );
  assert.match(evidenceBody, /--unshare-net/u);
  assert.match(evidenceBody, /--ro-bind "\$live_state_directory" \/state/u);
  assert.match(evidenceBody, /--ro-bind "\$trial_epoch_file" \/run\/teleagent-evaluation-epoch/u);
  assert.doesNotMatch(evidenceBody, /token_file|health\.js/u);
  assert.doesNotMatch(healthBody, /--unshare-net|live_state_directory|trial_epoch_file|token_file/u);
  assert.match(healthBody, /health\.js/u);
  assert.match(composerBody, /--unshare-net/u);
  assert.doesNotMatch(composerBody,
    /live_state_directory|evaluation_directory\/health\.js|token_file/u);
  assert.match(facadeBody, /--unshare-net/u);
  assert.match(facadeBody, /--bind "\$socket_directory" \/run\/teleagent-evaluation/u);
  assert.match(facadeBody, /--ro-bind "\$public_snapshot_directory" \/snapshot/u);
  assert.match(facadeBody, /--ro-bind "\$token_file" \/run\/teleagent-evaluation-token/u);
  assert.doesNotMatch(facadeBody,
    /live_state_directory|aggregate-store|health\.js|collect-(?:health|evidence)|\/state/u);
});

test('browser keeps the token in memory and invalidates stale safety output', () => {
  const app = read('evaluation/hermes-preview/static/app.js');
  const html = read('evaluation/hermes-preview/static/index.html');
  const favicon = read('evaluation/hermes-preview/static/favicon.svg');

  assert.match(app, /window\.location\.hash/u);
  assert.match(app, /window\.history\.replaceState/u);
  assert.match(app, /X-Teleagent-Evaluation-Token/u);
  assert.match(app, /method: 'GET'/u);
  assert.match(app, /function invalidateDashboard/u);
  assert.match(app, /dashboard\.hidden = true/u);
  assert.match(app, /badge\.textContent = 'Unknown'/u);
  assert.match(app, /const SNAPSHOT_TTL_MS = 75_000/u);
  assert.match(app, /new AbortController\(\)/u);
  assert.match(app, /visibilitychange/u);
  assert.match(app, /pageshow/u);
  assert.match(app, /window\.addEventListener\('focus'/u);
  assert.doesNotMatch(app, /localStorage|sessionStorage|document\.cookie|method: ['"]POST/u);
  assert.doesNotMatch(html, /<form|<audio|<video/iu);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/u);
  assert.match(favicon, /<svg[^>]+viewBox="0 0 32 32"/u);
  assert.match(html, /Snapshot composed/u);
  assert.match(html, /Trial began · fixed epoch/u);
  assert.match(html, /Current evidence window began · max 14 days/u);
  assert.match(html, /No purchase or production is authorized here/u);
});

test('operator wrapper fixes provenance, namespaces, cached refresh, and route cleanup', () => {
  const wrapperPath = path.join(repositoryRoot, 'scripts/hermes-evaluation-preview');
  const wrapper = fs.readFileSync(wrapperPath, 'utf8');
  const syntax = spawnSync('/usr/bin/bash', ['-n', wrapperPath], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  assert.match(wrapper, /export PATH='\/usr\/bin:\/bin'/u);
  assert.match(wrapper, /readonly https_port=8491/u);
  assert.match(wrapper, /facade_socket="\$socket_directory\/facade\.sock"/u);
  assert.match(wrapper, /cleanup_pending_file="\$private_directory\/cleanup-pending"/u);
  assert.match(wrapper, /trial_epoch_file="\$persistent_state_directory\/trial-epoch"/u);
  assert.match(wrapper, /set -o noclobber/u);
  assert.match(wrapper, /600:24:1/u);
  assert.match(wrapper, /snapshot_refresh_seconds=30/u);
  assert.match(wrapper, /evaluation-up/u);
  assert.match(wrapper, /evaluation-down-if/u);
  assert.doesNotMatch(wrapper, /\bup "\$https_port"|down-if "\$https_port"/u);
  assert.match(wrapper, /readonly preview_lifetime='5h'/u);
  assert.match(wrapper, /readonly watchdog_lifetime='5h10m'/u);
  assert.match(
    wrapper,
    /--property="RuntimeMaxSec=\$preview_lifetime" --property=TimeoutStopSec=10s/u,
  );
  assert.match(wrapper, /CPUQuota=100%/u);
  assert.match(wrapper, /MemoryMax=1536M/u);
  assert.match(wrapper, /MemorySwapMax=128M/u);
  assert.match(wrapper, /TasksMax=192/u);
  assert.match(wrapper, /NoNewPrivileges=yes/u);
  assert.match(wrapper, /RestrictSUIDSGID=yes/u);
  assert.match(wrapper, /LockPersonality=yes/u);
  assert.match(wrapper, /RestrictAddressFamilies=AF_UNIX AF_INET AF_NETLINK/u);
  assert.match(
    wrapper,
    /--property="RuntimeMaxSec=\$watchdog_lifetime" --property=TimeoutStopSec=5s/u,
  );
  assert.match(
    wrapper,
    /--unit="\$expiry_unit_base" --on-active="\$preview_lifetime" \\\n\s+--timer-property=AccuracySec=1s/u,
  );
  assert.doesNotMatch(wrapper, /RuntimeMaxSec=2h(?:10m)?|--on-active=2h/u);
  assert.match(wrapper, /RuntimeMaxSec=2m/u);
  assert.match(wrapper, /Restart=on-failure/u);
  assert.match(wrapper, /health_failures.*-ge 3/u);
  assert.match(wrapper, /--unix-socket "\$facade_socket"/u);
  assert.doesNotMatch(wrapper, /\/usr\/bin\/tailscale|\btailscale\s+(?:serve|funnel|set)\b/u);

  const startBody = wrapper.slice(wrapper.indexOf('start_preview() {'), wrapper.indexOf('stop_preview() {'));
  assert.ok(startBody.indexOf('watchdog_unit') < startBody.indexOf('preview_command evaluation-up'));
  assert.ok(startBody.indexOf('expiry_unit_base') < startBody.indexOf('preview_command evaluation-up'));
  assert.ok(startBody.indexOf('teardown_preview_state') < startBody.indexOf('stop_cleanup_guards'));
  assert.match(startBody, /abort_published_start 'fixed Unix-socket preview route/u);
  assert.doesNotMatch(startBody, /remove_exact_route \|\| true/u);
  assert.match(startBody,
    /if ! launch_url="\$\(print_url\)"; then\s+abort_published_start/u);
  const teardownBody = wrapper.slice(
    wrapper.indexOf('teardown_preview_state() {'),
    wrapper.indexOf('watchdog_teardown() {'),
  );
  assert.ok(teardownBody.indexOf('mark_cleanup_pending') < teardownBody.indexOf('remove_exact_route'));
  assert.ok(teardownBody.indexOf('remove_exact_route') < teardownBody.indexOf('stop_main_unit'));
  assert.ok(teardownBody.indexOf('stop_main_unit') < teardownBody.indexOf('unlink_facade_socket'));
  assert.ok(teardownBody.indexOf('unlink_facade_socket') < teardownBody.indexOf('erase_runtime_files'));
  assert.match(teardownBody, /route_status.*main_status.*socket_status.*files_status/su);
  assert.match(teardownBody, /clear_cleanup_pending/u);
  const abortBody = wrapper.slice(
    wrapper.indexOf('abort_published_start() {'),
    wrapper.indexOf('start_preview() {'),
  );
  assert.match(abortBody, /if teardown_preview_state; then/u);
  assert.match(abortBody, /cleanup guards were retained for retry/u);
  const stopBody = wrapper.slice(wrapper.indexOf('stop_preview() {'), wrapper.indexOf('expire_preview() {'));
  assert.ok(stopBody.indexOf('teardown_preview_state') < stopBody.indexOf('stop_cleanup_guards'));
  const expiryBody = wrapper.slice(wrapper.indexOf('expire_preview() {'), wrapper.indexOf('show_status() {'));
  assert.match(expiryBody, /if ! teardown_preview_state; then\s+return 1/u);
  const watchBody = wrapper.slice(wrapper.indexOf('watch_preview() {'), wrapper.indexOf('abort_unpublished_start() {'));
  assert.match(watchBody, /watchdog_teardown/u);
  assert.ok(watchBody.indexOf('cleanup_pending_present') < watchBody.indexOf('facade_healthy'));
  assert.match(wrapper, /if \[ "\$\{BASH_SOURCE\[0\]\}" = "\$0" \]; then\s+main "\$@"/u);

  const serviceBody = wrapper.slice(wrapper.indexOf('run_service() {'), wrapper.indexOf('watch_preview() {'));
  assert.doesNotMatch(serviceBody, /sudo|preview_helper/u);
});

test('root package exposes the focused evaluation suite', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.scripts['test:evaluation'],
    'node --test --test-concurrency=1 evaluation/hermes-preview/test/*.test.js');
  assert.match(packageJson.scripts.test, /npm run test:evaluation/u);
  assert.equal(fs.statSync(evaluationRoot).isDirectory(), true);
});
