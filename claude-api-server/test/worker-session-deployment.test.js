'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseInvocation } = require('../provider-supervisor-client');
const { buildCanaryInvocation } = require('../../deploy/worker-session/teleagent-provider-canary');

const DEPLOY = path.join(__dirname, '..', '..', 'deploy', 'worker-session');

function source(name) {
  return fs.readFileSync(path.join(DEPLOY, name), 'utf8');
}

test('session broker, RPC socket, state DB, and tmux socket exclude provider identities', () => {
  const service = source('teleagent-worker-session.service');
  const socket = source('teleagent-worker-session.socket');
  const tmpfiles = source('teleagent-worker-session.tmpfiles');
  const paneEntry = source('teleagent-session-pane-entry');
  const providerService = source('teleagent-provider-supervisor@.service');
  const providerSocket = source('teleagent-provider-supervisor@.socket');
  const providerBoundary = source('teleagent-provider-boundary');
  const boundaryRuntime = source('teleagent-provider-boundary-runtime');
  const providerRuntime = source('teleagent-provider-runtime');
  const emptySettings = source('provider-runtime-empty-settings.json');
  const emptyMcp = source('provider-runtime-empty-mcp.json');
  const egressService = source('teleagent-provider-egress@.service');
  const egressSocket = source('teleagent-provider-egress@.socket');
  const egressControlSocket = source('teleagent-provider-egress-control@.socket');
  const sudoers = source('teleagent-provider-supervisors.sudoers');
  const credentialCheck = source('teleagent-provider-egress-credential-check');
  const libexecManifest = source('provider-libexec.manifest');
  const libexecInstall = source('teleagent-provider-libexec-install');
  const libexecUnit = source('teleagent-provider-libexec-install.service');
  const apparmorInstall = source('teleagent-provider-apparmor-install');

  assert.match(service, /^User=teleagent-session-broker$/m);
  assert.match(service, /^Group=teleagent-session-broker$/m);
  assert.match(service,
    /^SupplementaryGroups=teleagent-agent-workspace teleagent-provider-launch$/m);
  assert.doesNotMatch(service, /^User=teleagent-worker$/m);
  assert.match(socket, /^SocketUser=teleagent-session-broker$/m);
  assert.match(socket, /^SocketGroup=teleagent-control$/m);
  assert.match(socket, /^SocketMode=0660$/m);
  assert.match(tmpfiles,
    /^d \/run\/teleagent-worker-session 0750 teleagent-session-broker teleagent-control -$/m);
  assert.match(tmpfiles,
    /^d \/run\/teleagent-worker-session\/pane-status 0700 teleagent-session-broker teleagent-session-broker -$/m);
  assert.match(tmpfiles,
    /^d \/var\/lib\/teleagent-session-broker 0700 teleagent-session-broker teleagent-session-broker -$/m);
  assert.match(paneEntry, /id -un.*teleagent-session-broker/);
  assert.match(paneEntry, /teleagent-provider-supervisor-client/);
  assert.match(paneEntry, /provider acceptance status boundary is unsafe/);
  assert.match(paneEntry, /exec 3>"\$status_file"/);
  assert.doesNotMatch(paneEntry, /exec \/usr\/bin\/sudo/);
  assert.match(providerService, /^User=teleagent-%i-supervisor$/m);
  assert.doesNotMatch(providerService, /^SupplementaryGroups=.*teleagent-provider-launch/m);
  assert.match(providerService, /^RestrictAddressFamilies=AF_UNIX$/m);
  assert.match(providerService, /^ReadOnlyPaths=.*teleagent-agent-workspaces$/m);
  assert.doesNotMatch(providerService, /^ReadWritePaths=.*teleagent-%i-worker/m);
  assert.doesNotMatch(providerService, /^ReadWritePaths=.*teleagent-agent-workspaces/m);
  assert.match(providerService, /^ExecStartPre=.*teleagent-provider-boundary --action recover/m);
  assert.match(providerService,
    /^ExecStartPre=\+\/usr\/local\/libexec\/teleagent-provider-boundary --action assert-supervisor-start-admitted$/m);
  assert.match(providerService, /^LimitCORE=0$/m);
  for (const protectedPath of [
    '/etc/teleagent/provider-egress-secrets',
    '/etc/teleagent/privileged-action',
    '/etc/teleagent-voice',
    '/var/lib/teleagent-control',
    '/var/lib/teleagent-privileged-action',
    '/var/lib/teleagent-claude-egress',
    '/var/lib/teleagent-codex-egress',
  ]) {
    assert.match(providerService, new RegExp(
      `^InaccessiblePaths=.*${protectedPath.replaceAll('/', '\\/')}`,
      'm',
    ));
  }
  assert.match(providerBoundary, /'PrivateNetwork=yes'/);
  assert.match(providerBoundary, /'TemporaryFileSystem=\/run:ro,nodev,nosuid,noexec'/);
  assert.match(providerBoundary, /BindReadOnlyPaths=.*egressSocket/);
  assert.doesNotMatch(providerBoundary, /ReadOnlyPaths=.*\/run\/teleagent-provider-egress /);
  assert.match(providerBoundary, /'KillMode=control-group'/);
  assert.match(providerBoundary, /'MemoryMax=4G'/);
  assert.match(providerBoundary, /'TasksMax=512'/);
  assert.match(providerBoundary, /'LimitCORE=0'/);
  assert.match(providerBoundary, /InaccessiblePaths=\/opt\/teleagent\/current/);
  assert.doesNotMatch(boundaryRuntime, /require\([^)]*provider-child-lifecycle/s);
  assert.match(boundaryRuntime,
    /const SHIM = '\/usr\/local\/libexec\/teleagent-provider-egress-shim'/);
  assert.match(libexecManifest, /teleagent-provider-boundary-runtime/);
  assert.match(libexecManifest, /teleagent-provider-egress-shim/);
  assert.match(libexecManifest,
    /deploy\/worker-session\/teleagent-provider-model\.apparmor teleagent-provider-model\.apparmor 0444/);
  assert.match(libexecManifest, /teleagent-provider-cli-check/);
  assert.match(libexecManifest, /teleagent-provider-cli-install/);
  assert.match(libexecManifest, /teleagent-provider-cli\.manifest\.json/);
  assert.match(providerBoundary,
    /checkProviderCli\(input\.provider\)[\s\S]*validateWorkspaceStorageBoundary\(\)/);
  assert.match(libexecInstall, /read -r digest source target mode extra/);
  assert.match(libexecInstall, /requires zero transient launch units/);
  assert.match(libexecInstall, /source digest is unreviewed/);
  assert.match(apparmorInstall,
    /^source_profile=\/usr\/local\/libexec\/teleagent-provider-model\.apparmor$/m);
  assert.match(apparmorInstall, /root:root:444/);
  assert.match(libexecUnit,
    /^ExecStart=\/usr\/local\/libexec\/teleagent-provider-libexec-install$/m);
  assert.match(providerBoundary, /InaccessiblePaths=.*teleagent-privileged-action/);
  assert.match(providerBoundary, /InaccessiblePaths=.*teleagent-voice/);
  assert.match(providerBoundary, /LoadCredential=provider-launch-capability/);
  assert.match(providerBoundary, /capabilityRevoked.*revoked\?\.persisted.*revoked\?\.quiesced/s);
  assert.match(boundaryRuntime, /'--no-new-privs'/);
  assert.match(boundaryRuntime, /'--bounding-set=-all'/);
  assert.match(boundaryRuntime, /'--inh-caps=-all'/);
  assert.match(boundaryRuntime, /'--ambient-caps=-all'/);
  assert.match(boundaryRuntime, /TELEAGENT_PROVIDER_SHIM_CAPABILITY: capability/);
  assert.doesNotMatch(boundaryRuntime,
    /dropTo\(spec\.runtimeUser[\s\S]*TELEAGENT_PROVIDER_(?:SHIM_)?CAPABILITY: capability/);
  assert.match(providerRuntime, /credentials must be absent/);
  assert.match(providerRuntime, /launch capabilities must be absent from the model runtime/);
  assert.match(providerRuntime, /teleagent-local-provider-key/);
  assert.match(providerRuntime, /forbidden host Unix socket/);
  assert.match(providerRuntime, /ANTHROPIC_BASE_URL/);
  assert.match(providerRuntime, /supports_websockets=false/);
  assert.match(providerRuntime, /CLAUDE_FIXED_FLAGS/);
  assert.match(providerRuntime, /--ignore-user-config/);
  assert.match(providerRuntime, /prepareLaunchConfig/);
  assert.match(providerRuntime, /CODEX_HOME: launchConfig/);
  assert.match(providerRuntime, /CLAUDE_CONFIG_DIR: launchConfig/);
  assert.deepEqual(JSON.parse(emptySettings), {});
  assert.deepEqual(JSON.parse(emptyMcp), { mcpServers: {} });
  assert.match(tmpfiles,
    /^C \/etc\/teleagent\/provider-runtime\/empty-settings\.json 0444 root root - \/opt\/teleagent\/current\/deploy\/worker-session\/provider-runtime-empty-settings\.json$/m);
  assert.match(tmpfiles,
    /^C \/etc\/teleagent\/provider-runtime\/empty-mcp\.json 0444 root root - \/opt\/teleagent\/current\/deploy\/worker-session\/provider-runtime-empty-mcp\.json$/m);

  assert.match(egressService, /^User=teleagent-%i-egress$/m);
  assert.match(egressService, /^LoadCredential=provider-api-key:/m);
  assert.match(egressService, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
  assert.match(egressService, /^IPAddressDeny=localhost$/m);
  for (const range of [
    '10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16',
    '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7', 'fe80::/10',
  ]) assert.match(egressService, new RegExp(`^IPAddressDeny=${range.replace('/', '\\/')}$`, 'm'));
  assert.match(egressService,
    /^BindReadOnlyPaths=\/run\/systemd\/resolve\/resolv\.conf:\/etc\/resolv\.conf$/m);
  assert.match(egressService, /^InaccessiblePaths=.*teleagent-agent-workspaces/m);
  assert.match(egressSocket, /^SocketGroup=teleagent-%i-egress-client$/m);
  assert.match(egressSocket, /^SocketMode=0660$/m);
  assert.match(egressControlSocket, /^SocketGroup=root$/m);
  assert.match(egressControlSocket, /^SocketMode=0600$/m);
  assert.match(providerSocket, /^SocketUser=root$/m);
  assert.match(providerSocket, /^SocketGroup=teleagent-provider-launch$/m);
  assert.match(providerSocket, /^DirectoryMode=0711$/m);
  assert.match(sudoers,
    /^teleagent-claude-supervisor ALL=\(root\).*teleagent-provider-boundary \*$/m);
  assert.match(sudoers,
    /^teleagent-codex-supervisor ALL=\(root\).*teleagent-provider-boundary \*$/m);
  assert.match(sudoers,
    /^teleagent-session-broker ALL=\(root\) NOPASSWD: .* --action panic-all$/m);
  assert.match(sudoers,
    /^teleagent-session-broker ALL=\(root\) NOPASSWD: .* --action recover-root-panic$/m);
  assert.doesNotMatch(sudoers, /teleagent-session-broker .* --action (?:unlock|recover)(?!-root-panic)/);
  assert.doesNotMatch(sudoers, /teleagent-(?:claude|codex)-worker ALL=/);
  assert.doesNotMatch(socket + service + tmpfiles, /SocketGroup=teleagent-worker/);
  assert.doesNotMatch(service, /SupplementaryGroups=.*teleagent-control/);
  assert.match(tmpfiles, /^d \/run\/teleagent-provider-launch 0711 root root -$/m);
  assert.match(tmpfiles, /^d \/var\/lib\/teleagent-provider-plane 0700 root root -$/m);
  assert.match(credentialCheck, /validateProviderCredential/);
  assert.match(credentialCheck, /providerCredentialsEqual/);
  assert.match(credentialCheck, /credentials\.claude, credentials\.codex/);
  assert.doesNotMatch(credentialCheck, /process\.(?:stdout|stderr).*credentials\[/);
});

test('activation verification requires clean provider homes, synthetic DAC denial, and controller success', () => {
  const verifier = source('verify-worker-session-boundary');
  assert.match(verifier, /teleagent-claude-worker teleagent-codex-worker/);
  assert.match(verifier, /other_home/);
  assert.match(verifier, /EXPECTED_DENIAL/);
  assert.match(verifier, /controller_user=teleagent-control/);
  assert.match(verifier, /id -Gn "\$controller_user"/);
  assert.match(verifier, /CONTROLLER_CONNECTED/);
  assert.match(verifier, /broker\.sock/);
  assert.match(verifier, /tmux\.sock/);
  assert.match(verifier, /operations\.sqlite/);
  assert.match(verifier, /voice-app\/audio/);
  assert.match(verifier, /provider-egress-secrets/);
  assert.match(verifier, /provider runtime authentication material must be absent/);
  assert.match(verifier, /\/var\/lib\/teleagent-claude-worker\/\.claude\/\.credentials\.json/);
  assert.match(verifier, /\/var\/lib\/teleagent-claude-worker\/\.claude\.json/);
  assert.match(verifier, /\/var\/lib\/teleagent-codex-worker\/\.codex\/auth\.json/);
  assert.match(verifier, /mktemp -d \/run\/teleagent-provider-auth-probe/);
  assert.match(verifier, /auth_denial_probe/);
  assert.match(verifier, /root:root:600/);
  for (const identity of [
    'teleagent-control', 'teleagent-session-broker',
    'teleagent-claude-supervisor', 'teleagent-codex-supervisor',
    'teleagent-claude-worker', 'teleagent-codex-worker',
    'teleagent-claude-shim', 'teleagent-codex-shim',
    'teleagent-claude-egress', 'teleagent-codex-egress',
  ]) {
    assert.match(verifier, new RegExp(`assert_exact_groups ${identity}(?: |\\n)`));
  }
  assert.match(verifier, /ISOLATED_ROLE_BOUNDARY_OK/);
  assert.match(verifier, /teleagent-provider-egress-control\/claude\.sock/);
  assert.match(verifier, /teleagent-provider-egress-control\/codex\.sock/);
  assert.doesNotMatch(verifier,
    /const auth = \[\s*"\/var\/lib\/teleagent-(?:claude|codex)-worker/s);
  assert.match(verifier, /teleagent-provider-host-socket-probe\.sock/);
  assert.match(verifier, /teleagent-visible-host-socket-probe\.sock/);
  assert.match(verifier, /VISIBLE_SOCKET_DAC_ALLOWED/);
  assert.match(verifier, /\.teleagent-config-boundary-probe/);
  assert.match(verifier, /malformed = \[/);
  assert.match(verifier, /hook-executed/);
  assert.match(verifier, /teleagent-provider-egress\/claude\.sock/);
  assert.match(verifier, /NoNewPrivs/);
  assert.match(verifier, /CapBnd/);
  assert.match(verifier, /PROVIDER_CANARY/);
  assert.match(verifier, /codex resume --help/);
  assert.match(verifier, /claude --help/);
  assert.match(verifier, /teleagent-provider-cli-check --provider claude/);
  assert.match(verifier, /teleagent-provider-cli-check --provider codex/);
  assert.match(verifier, /teleagent-provider-supervisor@\$\{provider\}\.service/);
  assert.match(verifier, /teleagent-provider-egress@\$\{provider\}\.service/);
  assert.match(verifier, /stat -c '%U:%G:%a'.*teleagent-provider-launch/);
  assert.match(verifier, /teleagent-provider-canary claude/);
  assert.match(verifier, /teleagent-provider-canary codex/);
});

test('activation canaries use the exact production clean-config argument builders', () => {
  const workspace = '/srv/teleagent-agent-workspaces/phone';
  const claudeArgv = buildCanaryInvocation('claude', workspace);
  const codexArgv = buildCanaryInvocation('codex', workspace);
  const claude = parseInvocation(claudeArgv);
  const codex = parseInvocation(codexArgv);
  assert.equal(claude.accessMode, 'read-only');
  assert.equal(codex.accessMode, 'read-only');
  assert.deepEqual(claude.args.slice(0, 2), ['-p', '--bare']);
  assert.ok(claude.args.includes('claude-sonnet-5'));
  assert.ok(codex.args.includes('gpt-5.6-luna'));
  for (const flag of ['--bare', '--safe-mode', '--strict-mcp-config']) {
    assert.equal(claude.args.includes(flag), true);
  }
  assert.deepEqual(
    claude.args.slice(claude.args.indexOf('--mcp-config'), claude.args.indexOf('--mcp-config') + 2),
    ['--mcp-config', '/etc/teleagent/provider-runtime/empty-mcp.json'],
  );
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--strict-config']) {
    assert.equal(codex.args.includes(flag), true);
  }
});

test('provider and supervisor identities are distinct and only the workspace is shared', () => {
  const sysusers = source('teleagent-worker-session.sysusers');
  const tmpfiles = source('teleagent-worker-session.tmpfiles');
  assert.match(sysusers, /^g teleagent-provider-launch -$/m);
  for (const provider of ['claude', 'codex']) {
    assert.match(sysusers, new RegExp(`^u teleagent-${provider}-supervisor `, 'm'));
    assert.match(sysusers, new RegExp(
      `^u teleagent-${provider}-worker - .* /nonexistent/teleagent-${provider}-worker /usr/sbin/nologin$`,
      'm',
    ));
    assert.match(sysusers, new RegExp(`^u teleagent-${provider}-shim `, 'm'));
    assert.match(sysusers, new RegExp(`^u teleagent-${provider}-egress `, 'm'));
    assert.doesNotMatch(tmpfiles, new RegExp(`/var/lib/teleagent-${provider}-worker`));
    assert.match(tmpfiles, new RegExp(
      `^d /var/lib/teleagent-${provider}-supervisor 0700 teleagent-${provider}-supervisor teleagent-${provider}-supervisor -$`,
      'm'
    ));
  }
  assert.doesNotMatch(sysusers, /^m teleagent-(?:claude|codex)-worker teleagent-provider-launch$/m);
  assert.doesNotMatch(sysusers, /^m teleagent-(?:claude|codex)-supervisor teleagent-provider-launch$/m);
  assert.doesNotMatch(sysusers, /^m teleagent-(?:claude|codex)-worker teleagent-(?:claude|codex)-egress-client$/m);
  assert.match(sysusers, /^m teleagent-claude-shim teleagent-claude-egress-client$/m);
  assert.match(sysusers, /^m teleagent-codex-shim teleagent-codex-egress-client$/m);
  assert.match(tmpfiles,
    /^d \/srv\/teleagent-agent-workspaces 0751 root teleagent-agent-workspace -$/m);
  assert.match(tmpfiles,
    /^d \/srv\/teleagent-agent-workspaces\/phone 2770 root teleagent-agent-workspace -$/m);
});

test('workspace parent permissions prevent launch-path rename and symlink substitution', () => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'workspace-parent-'));
  const child = path.join(directory, 'phone');
  fs.mkdirSync(child);
  fs.chmodSync(directory, 0o551);
  try {
    assert.throws(
      () => fs.renameSync(child, path.join(directory, 'replaced')),
      (error) => ['EACCES', 'EPERM'].includes(error.code),
    );
    assert.throws(
      () => fs.symlinkSync('/tmp', path.join(directory, 'other')),
      (error) => ['EACCES', 'EPERM'].includes(error.code),
    );
  } finally {
    fs.chmodSync(directory, 0o700);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
