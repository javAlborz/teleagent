'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildClaudeArgs, buildCodexArgs } = require('../agent-cli');
const { parseInvocation } = require('../provider-supervisor-client');
const { buildCanaryInvocation } = require('../../deploy/worker-session/teleagent-provider-canary');

const DEPLOY = path.join(__dirname, '..', '..', 'deploy', 'worker-session');
const VOICE_DEPLOY = path.join(__dirname, '..', '..', 'deploy', 'voice-stack');

function source(name) {
  return fs.readFileSync(path.join(DEPLOY, name), 'utf8');
}

test('session broker, RPC socket, state DB, and tmux socket exclude provider identities', () => {
  const voiceService = fs.readFileSync(
    path.join(VOICE_DEPLOY, 'teleagent-voice-stack.service'),
    'utf8',
  );
  const service = source('teleagent-worker-session.service');
  const socket = source('teleagent-worker-session.socket');
  const tmpfiles = source('teleagent-worker-session.tmpfiles');
  const paneEntry = source('teleagent-session-pane-entry');
  const providerService = source('teleagent-provider-supervisor@.service');
  const providerSlice = source('teleagent-provider.slice');
  const providerModelSlice = source('teleagent-provider-model.slice');
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
    /^d \/var\/lib\/teleagent-worker-state 0751 root root -$/m);
  assert.match(tmpfiles,
    /^d \/var\/lib\/teleagent-worker-state\/session-broker 0700 teleagent-session-broker teleagent-session-broker -$/m);
  assert.match(service,
    /^Environment=WORKER_SESSION_DB_PATH=\/var\/lib\/teleagent-worker-state\/session-broker\/operations\.sqlite$/m);
  assert.match(service, /^MemoryHigh=384M$/m);
  assert.match(service, /^MemoryMax=512M$/m);
  assert.match(service,
    /^RequiresMountsFor=\/var\/lib\/teleagent-worker-state \/var\/lib\/teleagent-provider-plane$/m);
  assert.match(service, /^MemorySwapMax=0$/m);
  assert.match(service, /^TasksMax=128$/m);
  assert.match(service, /^CPUQuota=50%$/m);
  assert.match(service, /^IOAccounting=yes$/m);
  assert.match(service,
    /^ExecStartPre=\+\/usr\/bin\/python3 -I \/usr\/local\/libexec\/verify-teleagent-release-closure --preflight-component worker-session \$\{CREDENTIALS_DIRECTORY\}\/teleagent-release-gate$/m);
  assert.doesNotMatch(service,
    /^ExecStartPre=.*\/usr\/local\/libexec\/teleagent-provider-boundary/m);
  assert.match(service, /^ReadOnlyPaths=.*\/var\/lib\/teleagent-provider-plane/m);
  assert.doesNotMatch(service, /^ReadWritePaths=.*\/var\/lib\/teleagent-provider-plane/m);
  assert.match(voiceService, /^InaccessiblePaths=.*\/var\/lib\/teleagent-worker-state$/m);
  assert.doesNotMatch(voiceService, /\/var\/lib\/teleagent-session-broker/);
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
  assert.doesNotMatch(providerService,
    /^ExecStartPre=.*teleagent-provider-boundary --action recover/m);
  assert.match(fs.readFileSync(
    path.join(__dirname, '..', 'provider-supervisor-service.js'),
    'utf8',
  ),
    /const recovery = await boundaryControl\.recover\(config\.provider\);/);
  assert.match(providerService,
    /^ExecStartPre=\+\/usr\/bin\/python3 -I \/usr\/local\/libexec\/verify-teleagent-release-closure --preflight-component provider-supervisor-%i \$\{CREDENTIALS_DIRECTORY\}\/teleagent-release-gate$/m);
  assert.match(egressService,
    /^ExecStartPre=\+\/usr\/bin\/python3 -I \/usr\/local\/libexec\/verify-teleagent-release-closure --preflight-component provider-egress-%i \$\{CREDENTIALS_DIRECTORY\}\/teleagent-release-gate$/m);
  assert.doesNotMatch(egressService,
    /^ExecStartPre=.*teleagent-provider-egress-credential-check/m);
  assert.match(providerService,
    /^Environment=HOME=\/var\/lib\/teleagent-provider-plane\/%i-supervisor$/m);
  assert.match(providerService,
    /^RequiresMountsFor=\/var\/lib\/teleagent-provider-plane$/m);
  assert.match(providerService, /^ReadWritePaths=\/var\/lib\/teleagent-provider-plane /m);
  assert.doesNotMatch(providerService, /\/var\/lib\/teleagent-%i-supervisor/);
  assert.match(providerService, /^LimitCORE=0$/m);
  assert.match(providerService, /^Slice=teleagent-provider\.slice$/m);
  assert.match(providerService, /^MemoryMax=512M$/m);
  assert.match(providerService, /^MemorySwapMax=0$/m);
  assert.match(providerService, /^CPUQuota=25%$/m);
  for (const protectedPath of [
    '/etc/teleagent/provider-egress-secrets',
    '/etc/teleagent/privileged-action',
    '/etc/teleagent-voice',
    '/var/lib/teleagent-control',
    '/var/lib/teleagent-privileged-action',
    '/var/lib/teleagent-worker-state',
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
  assert.match(providerBoundary, /'Slice=teleagent-provider-model\.slice'/);
  assert.match(providerBoundary, /'MemoryHigh=2G'/);
  assert.match(providerBoundary, /'MemoryMax=3G'/);
  assert.match(providerBoundary, /'MemorySwapMax=0'/);
  assert.match(providerBoundary, /'TasksMax=384'/);
  assert.match(providerBoundary, /'CPUQuota=150%'/);
  assert.match(providerBoundary, /'IOWeight=25'/);
  assert.match(providerSlice, /^ConditionPathExists=\/etc\/teleagent\/worker-session\/ENABLE$/m);
  assert.match(providerSlice, /^CPUQuota=250%$/m);
  assert.match(providerSlice, /^MemoryHigh=5G$/m);
  assert.match(providerSlice, /^MemoryMax=6G$/m);
  assert.match(providerSlice, /^MemorySwapMax=0$/m);
  assert.match(providerSlice, /^TasksMax=1024$/m);
  assert.match(providerSlice, /^IOAccounting=yes$/m);
  assert.match(providerSlice, /^IOWeight=25$/m);
  assert.doesNotMatch(providerSlice, /^\[Install\]$/m);
  assert.match(providerModelSlice,
    /^ConditionPathExists=\/etc\/teleagent\/worker-session\/ENABLE$/m);
  assert.match(providerModelSlice, /^CPUQuota=200%$/m);
  assert.match(providerModelSlice, /^MemoryHigh=3G$/m);
  assert.match(providerModelSlice, /^MemoryMax=4G$/m);
  assert.match(providerModelSlice, /^MemorySwapMax=0$/m);
  assert.match(providerModelSlice, /^TasksMax=768$/m);
  assert.doesNotMatch(providerModelSlice, /^\[Install\]$/m);
  assert.match(providerBoundary, /'LimitCORE=0'/);
  assert.match(providerBoundary, /InaccessiblePaths=\/opt\/teleagent\/current/);
  assert.doesNotMatch(boundaryRuntime, /require\([^)]*provider-child-lifecycle/s);
  assert.match(boundaryRuntime,
    /const SHIM = '\/usr\/local\/libexec\/teleagent-provider-egress-shim'/);
  assert.match(libexecManifest, /teleagent-provider-boundary-runtime/);
  assert.match(libexecManifest, /teleagent-provider-egress-shim/);
  assert.match(libexecManifest,
    /deploy\/worker-session\/teleagent-provider-canary teleagent-provider-canary 0755/);
  assert.match(libexecManifest,
    /teleagent-provider-egress-credential-check teleagent-provider-egress-credential-check 0755/);
  assert.match(libexecManifest,
    /deploy\/worker-session\/teleagent-provider-model\.apparmor teleagent-provider-model\.apparmor 0444/);
  assert.match(libexecManifest, /teleagent-provider-cli-check/);
  assert.match(libexecManifest, /teleagent-provider-cli-install/);
  assert.match(libexecManifest, /teleagent-provider-cli\.manifest\.json/);
  assert.match(providerBoundary,
    /createGlobalLaunchLock\(input\.launchId\)[\s\S]*validateProviderStorageIsolation\(\)[\s\S]*checkProviderCli\(input\.provider\)/);
  assert.match(providerBoundary,
    /function attestWorkspaceStorageBoundary[\s\S]*validateStorage\(WORKSPACE_ROOT\)/);
  assert.match(providerBoundary,
    /WORKSPACE_STORAGE_ATTESTATION = 'PROVIDER_WORKSPACE_STORAGE_OK'/);
  assert.match(providerBoundary,
    /input\.action === 'attest-workspace-storage'[\s\S]*attestWorkspaceStorageBoundary\(\)/);
  assert.match(providerBoundary,
    /input\.action === 'assert-supervisor-start-admitted'[\s\S]*assertSupervisorStartAdmitted\(\)/);
  assert.match(providerBoundary,
    /function assertSupervisorStartAdmitted[\s\S]*validateStorageIsolation\(\)[\s\S]*panicLocked\(\)/);
  assert.match(providerBoundary,
    /function validateProviderPlaneStorageBoundary[\s\S]*PROVIDER_PLANE_ROOT/);
  assert.match(providerBoundary, /MIN_PROVIDER_PLANE_CAPACITY_BYTES/);
  assert.match(providerBoundary, /MAX_PROVIDER_PLANE_CAPACITY_BYTES/);
  assert.match(providerBoundary, /MIN_PROVIDER_PLANE_FREE_BYTES/);
  assert.match(providerBoundary,
    /input\.action === 'attest-provider-plane-storage'[\s\S]*attestProviderPlaneStorageBoundary\(\)/);
  assert.match(libexecInstall, /read -r digest source target mode extra/);
  assert.match(libexecInstall, /requires zero transient launch units/);
  assert.match(libexecInstall, /source digest is unreviewed/);
  assert.match(libexecInstall, /^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m);
  assert.match(libexecInstall, /--property="\$2" --value/);
  assert.match(libexecInstall, /unit_file_state.*static/);
  assert.match(libexecInstall, /sub_state.*dead/);
  assert.match(libexecInstall, /provider cgroup is populated/);
  assert.doesNotMatch(libexecInstall, /systemctl is-active/);
  assert.match(apparmorInstall,
    /^source_profile=\/usr\/local\/libexec\/teleagent-provider-model\.apparmor$/m);
  assert.match(apparmorInstall, /root:root:444/);
  assert.match(libexecUnit,
    /^LoadCredential=teleagent-release-gate:\/run\/teleagent-release-gate\/verified\.json$/m);
  assert.match(libexecUnit,
    /^ExecStart=\/usr\/bin\/python3 -I \/usr\/local\/libexec\/verify-teleagent-release-closure --start-component provider-libexec-install \$\{CREDENTIALS_DIRECTORY\}\/teleagent-release-gate$/m);
  assert.doesNotMatch(libexecUnit, /^ExecStart=.*\/opt\/teleagent\/current/m);
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
  assert.match(egressService, /^Slice=teleagent-provider\.slice$/m);
  assert.match(egressService, /^MemoryMax=512M$/m);
  assert.match(egressService, /^RequiresMountsFor=\/var\/lib\/teleagent-worker-state$/m);
  assert.match(egressService, /^MemorySwapMax=0$/m);
  assert.match(egressService, /^CPUQuota=25%$/m);
  assert.match(egressService,
    /^Environment=PROVIDER_EGRESS_DB_PATH=\/var\/lib\/teleagent-worker-state\/%i-egress\/budget\.sqlite$/m);
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
  assert.match(tmpfiles, /^d \/var\/lib\/teleagent-provider-plane 0751 root root -$/m);
  assert.match(tmpfiles,
    /^d \/var\/lib\/teleagent-provider-plane\/claude-supervisor 0700 teleagent-claude-supervisor teleagent-claude-supervisor -$/m);
  assert.match(tmpfiles,
    /^d \/var\/lib\/teleagent-provider-plane\/codex-supervisor 0700 teleagent-codex-supervisor teleagent-codex-supervisor -$/m);
  assert.doesNotMatch(tmpfiles, /^d \/var\/lib\/teleagent-(?:claude|codex)-supervisor /m);
  assert.match(tmpfiles,
    /^d \/var\/lib\/teleagent-worker-state\/claude-egress 0700 teleagent-claude-egress teleagent-claude-egress -$/m);
  assert.match(tmpfiles,
    /^d \/var\/lib\/teleagent-worker-state\/codex-egress 0700 teleagent-codex-egress teleagent-codex-egress -$/m);
  assert.match(credentialCheck, /validateProviderCredential/);
  assert.match(credentialCheck, /providerCredentialsEqual/);
  assert.match(credentialCheck, /providerCredentialsEqual\(claude, codex\)/);
  assert.match(credentialCheck,
    /validateCredentialSnapshot\(provider, projectedCredential, credentials\)/);
  assert.doesNotMatch(credentialCheck, /\/opt\/teleagent\/current|require\([^)]*provider-secret/);
  assert.match(credentialCheck, /directoryMetadata\.gid !== 0/);
  assert.match(credentialCheck, /before\.gid !== 0 \|\| before\.nlink !== 1/);
  assert.match(credentialCheck, /O_NOFOLLOW/);
  assert.doesNotMatch(credentialCheck, /process\.(?:stdout|stderr).*credentials\[/);
});

test('activation verification requires clean provider homes, synthetic DAC denial, and controller success', () => {
  const verifier = source('verify-worker-session-boundary');
  assert.match(verifier, /^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m);
  assert.match(verifier, /^unset ENV BASH_ENV CDPATH LD_PRELOAD/m);
  assert.match(verifier, /^umask 077$/m);
  assert.match(verifier, /--source-check\|--installed-check/);
  assert.match(verifier,
    /fixed_entrypoint=\/usr\/local\/libexec\/verify-worker-session-boundary/);
  assert.match(verifier, /verify-worker-session-identity --installed-check/);
  assert.match(verifier, /state_root=\/var\/lib\/teleagent-worker-state/);
  assert.match(verifier, /worker state is not an exact dedicated mount/);
  assert.match(verifier, /state_max=\$\(\(8 \* 1024 \* 1024 \* 1024\)\)/);
  assert.match(verifier, /state_reserve=.*512 \* 1024 \* 1024/);
  assert.match(verifier, /state_reserve=\$\(\(state_capacity \/ 5\)\)/);
  assert.match(verifier, /session-broker claude-egress codex-egress/);
  assert.match(verifier, /expected_libexec_targets=[\s\S]*teleagent-provider-egress-credential-check/);
  assert.match(verifier, /provider libexec manifest closure is incomplete/);
  assert.match(verifier,
    /teleagent-provider-boundary --action attest-workspace-storage/);
  assert.match(verifier, /PROVIDER_WORKSPACE_STORAGE_OK/);
  assert.match(verifier,
    /teleagent-provider-boundary --action attest-provider-plane-storage/);
  assert.match(verifier, /PROVIDER_PLANE_STORAGE_OK/);
  assert.match(verifier,
    /\/var\/lib\/teleagent-provider-plane\/(?:claude|codex)-supervisor/);
  assert.match(verifier, /WORKER_SESSION_BOUNDARY_SOURCE_OK/);
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
  assert.doesNotMatch(verifier, /\.teleagent-config-boundary-probe/);
  assert.doesNotMatch(verifier, /malformed = \[|hook-executed/);
  assert.match(verifier,
    /visible_socket_probe="\$workspace\/\.teleagent-visible-host-socket-probe\.sock"/);
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
  assert.match(verifier, /\/usr\/local\/libexec\/teleagent-provider-canary claude "\$workspace"/);
  assert.match(verifier, /\/usr\/local\/libexec\/teleagent-provider-canary codex "\$workspace"/);
  assert.match(verifier,
    /grep -Fx -- 'PROVIDER_CANARY_ATTESTED claude'/);
  assert.match(verifier,
    /grep -Fx -- 'PROVIDER_CANARY_ATTESTED codex'/);
  assert.doesNotMatch(verifier, /grep -q PROVIDER_CANARY_OK/);
  assert.doesNotMatch(verifier,
    /\/opt\/teleagent\/current\/deploy\/worker-session\/teleagent-provider-canary/);
});

test('activation canaries use the exact production clean-config argument builders', () => {
  const canarySource = source('teleagent-provider-canary');
  assert.doesNotMatch(canarySource, /require\([^)]*agent-cli|\.\.\/\.\.\/claude-api-server/);
  assert.match(canarySource, /const FIXED_WORKSPACE = '\/srv\/teleagent-agent-workspaces\/phone'/);
  assert.match(canarySource, /MAX_COMBINED_OUTPUT_BYTES = 16 \* 1024/);
  assert.match(canarySource, /CANARY_DEADLINE_MS = 60 \* 1000/);
  assert.match(canarySource, /POST_KILL_CLOSE_MS = 2 \* 1000/);
  assert.match(canarySource, /stdio: \['pipe', 'pipe', 'pipe'\]/);
  assert.doesNotMatch(canarySource, /stdio: \[[^\]]*'inherit'/);
  assert.match(canarySource, /event\.type === 'item\.started'/);
  assert.match(canarySource, /event\.type === 'item\.updated'/);
  assert.match(canarySource, /event\.type === 'item\.completed'/);
  assert.match(canarySource, /event\.type === 'turn\.completed'/);
  assert.match(canarySource, /PROVIDER_CANARY_ATTESTED \$\{provider\}/);
  const workspace = '/srv/teleagent-agent-workspaces/phone';
  const claudeArgv = buildCanaryInvocation('claude', workspace);
  const codexArgv = buildCanaryInvocation('codex', workspace);
  assert.deepEqual(
    claudeArgv.slice(claudeArgv.indexOf('--') + 1),
    buildClaudeArgs({
      model: 'claude-sonnet-5',
      permissionMode: 'dontAsk',
      tools: ['Read', 'Glob', 'Grep'],
      allowedTools: ['Read', 'Glob', 'Grep'],
    }),
  );
  assert.deepEqual(
    codexArgv.slice(codexArgv.indexOf('--') + 1),
    buildCodexArgs({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      workingDirectory: workspace,
    }),
  );
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
  assert.throws(
    () => buildCanaryInvocation('claude', `${workspace}/nested`),
    /exact provider workspace/
  );
});

test('provider and supervisor identities are distinct and only the workspace is shared', () => {
  const sysusers = source('teleagent-worker-session.sysusers');
  const tmpfiles = source('teleagent-worker-session.tmpfiles');
  assert.match(sysusers, /^g teleagent-provider-launch -$/m);
  for (const provider of ['claude', 'codex']) {
    assert.match(sysusers, new RegExp(
      `^u teleagent-${provider}-supervisor - .* /var/lib/teleagent-provider-plane/${provider}-supervisor /usr/sbin/nologin$`,
      'm'
    ));
    assert.match(sysusers, new RegExp(
      `^u teleagent-${provider}-worker - .* /nonexistent/teleagent-${provider}-worker /usr/sbin/nologin$`,
      'm',
    ));
    assert.match(sysusers, new RegExp(`^u teleagent-${provider}-shim `, 'm'));
    assert.match(sysusers, new RegExp(`^u teleagent-${provider}-egress `, 'm'));
    assert.doesNotMatch(tmpfiles, new RegExp(`/var/lib/teleagent-${provider}-worker`));
    assert.match(tmpfiles, new RegExp(
      `^d /var/lib/teleagent-provider-plane/${provider}-supervisor 0700 teleagent-${provider}-supervisor teleagent-${provider}-supervisor -$`,
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
