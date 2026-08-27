# Worker execution and session boundary

Teleagent never runs Claude or Codex under the controller identity. The
controller owns scoped API bearers and executor state. Production service
hardening removes legacy phone approval-verifier and privileged-proxy settings,
and denies the broker socket; those implementations are dormant test substrate.
Every provider launch therefore needs all of these independently enforced host
boundaries:

1. `teleagent-control` talks only to provider-specific supervisors over
   `/run/teleagent-provider-launch/{claude,codex}.sock`.
2. The supervisors run as `teleagent-{claude,codex}-supervisor`, admit one
   launch at a time, and ask the fixed root boundary to create one transient
   systemd cgroup. They hold no provider credential. Supervisors and egress
   brokers share the aggregate `teleagent-provider.slice`; model transients
   live in its tighter `teleagent-provider-model.slice` child so model pressure
   cannot consume the recovery plane or all staging-host CPU and memory.
3. Model/tool processes run as distinct
   `teleagent-{claude,codex}-worker` identities whose account homes are fixed
   beneath `/nonexistent`; there is no persistent provider home. Each launch
   gets a private tmpfs HOME, private network namespace, private `/run`, bounded
   resources, and no capabilities. Read-only launches mount the workspace
   read-only.
4. A different `teleagent-{claude,codex}-shim` identity is the only process in
   that namespace allowed to reach its matching provider-egress Unix socket.
   The model sees only a fixed nonsecret local API-key sentinel. A random
   launch capability remains shim-only.
5. `teleagent-{claude,codex}-egress` alone reads the real provider credential.
   It accepts only the pinned provider host, model, routes and request shapes,
   enforces conservative durable request/token budgets, strips untrusted auth,
   and revokes every launch capability on restart or shutdown.

Both provider worker identities are mandatory:

```dotenv
AGENT_WORKER_USER=
AGENT_CLAUDE_WORKER_USER=teleagent-claude-worker
AGENT_CODEX_WORKER_USER=teleagent-codex-worker
AGENT_CLAUDE_WORKER_HOME=/nonexistent/teleagent-claude-worker
AGENT_CODEX_WORKER_HOME=/nonexistent/teleagent-codex-worker
AGENT_PROVIDER_SUPERVISOR_CLIENT_PATH=/usr/local/libexec/teleagent-provider-supervisor-client
AGENT_WORKER_WORKSPACE_ROOT=/srv/teleagent-agent-workspaces
AGENT_WORKER_DEFAULT_WORKSPACE=/srv/teleagent-agent-workspaces/phone
```

`AGENT_WORKER_USER` is obsolete and a nonempty value is rejected. Missing or
unhealthy provider/session boundaries leave the HTTP process available only
for authenticated diagnostics. General `/ask`, phone execution, durable task
claims, provider launch, workspace inspection, and tmux delivery fail closed.
`AGENT_WORKER_LEGACY_SAME_UID_ENABLED=true` is only a non-ready rollback
indicator; it never authorizes a controller-UID provider child.

## Session-broker RPC surface

`teleagent-worker-session.socket` is systemd socket activated at
`/run/teleagent-worker-session/broker.sock`. Its filesystem owner is
`teleagent-session-broker`, its client group is exactly `teleagent-control`, and
its mode is 0660. The service, SQLite operation database, pane-status directory,
and tmux server/socket are owned by `teleagent-session-broker`; neither provider
worker can traverse or connect to them.

The broker exposes only:

- bounded reads from the exact root-provisioned
  `/srv/teleagent-agent-workspaces/phone` anchor; the workspace root must be an
  exact dedicated filesystem mount distinct from `/srv`, with more than 2 GiB
  total, at most 64 GiB total, and at least 2 GiB free. Its non-writable
  ancestors and crash-atomic root-owned global launch lock prevent mount-target
  substitution and sibling-filesystem exhaustion;
- its dedicated mode-0600 tmux socket
  `/run/teleagent-worker-session/tmux.sock`;
- sanitized provider-session history projected into broker-readable stores;
- exact prepare, durable operation-ID commit, interrupt, marker reconciliation,
  and a provider-accepted pane-creation handshake.

Docker, Kubernetes, private-network, root-filesystem, owner-home, controller,
and privileged-broker reads are not session-broker capabilities. Production
phone has no authority path for them. A future typed path also requires the
independently PBX-attested controller authority described in
`PHONE-AGENT-ARCHITECTURE.md`.

The operation store uses SQLite WAL plus `synchronous=FULL`. A delivery boundary
is persisted before tmux input; ambiguous delivery is reconciled and never
blindly resent. Restarted post-boundary operations remain outcome-unknown until
the exact pane/session marker and final provider response prove completion.

Worker durability is isolated from the host root filesystem. Before activation,
the operator must provision `/var/lib/teleagent-worker-state` as an exact
dedicated filesystem mount between 1 GiB and 8 GiB, owned by `root:root` at mode
0751. Tmpfiles then creates private mode-0700 `session-broker`, `claude-egress`,
and `codex-egress` directories for the matching service identities. The broker
and egress units order themselves after that mount, and both activation checks
and every process startup prove that the exact state root has a different
device from `/var/lib`, that no role directory crosses to another device, and
that all ownership and modes remain exact.

Every new operation, pane identity, egress capability, and budget reservation
rechecks the filesystem. New durable work is refused when free space falls
below the larger of 512 MiB or 20 percent of total capacity. Startup refuses to
open any singleton or SQLite store below that reserve. While a service remains
running, existing idempotency records and panic, revocation, completion, and
outcome-unknown recovery remain writable so pressure cannot erase or misreport
crash truth. The session broker does not prune unresolved or terminal operation
truth; the dedicated mount is its hard host-containment boundary. Egress startup
removes only reservations and already-revoked capabilities older than 14 days,
never active or recent capability state. The broker is also capped at 512 MiB
RAM, zero swap, 128 tasks, and 50 percent of one CPU; egress services retain
their independent recovery-plane resource caps.

Provider supervisor panic and recovery state is isolated separately from both
the host root and worker/egress state. Before disabled installation, provision
`/var/lib/teleagent-provider-plane` as an exact dedicated durable local
ext-family, XFS, Btrfs, F2FS, or ZFS mount between 1 GiB and 4 GiB, owned by
`root:root` at mode 0751. Only those reviewed filesystem types are admitted;
every other type, including tmpfs and NFS, is refused. Tmpfiles creates
private mode-0700 `claude-supervisor` and `codex-supervisor` homes on that same
device, and the matching sysusers records use those homes. Installation,
checking, supervisor startup, worker-broker startup, and every new provider
launch reject a shared, replaceable, oversized, cross-device, or mis-owned
provider-plane path. Admission also preserves the larger of 512 MiB or 20
percent free. Supervisor startup and every provider launch additionally prove
that the workspace and provider-plane mount device IDs differ, so the two
provider-accessible workload roots cannot share one exhaustion boundary. Root
panic/recovery inspection remains permitted below that
admission reserve so existing cancellation and crash truth is not rewritten;
the mount is the containment boundary, and no audit/panic truth is pruned
automatically.

## Session parity and deliberate limits

Only sessions created on the broker-owned tmux socket are visible. Historical
owner/alborz sessions such as `main:phone` are intentionally invisible. The
broker rejects Codex interactive creation because pinned Codex 0.149.1 cannot
resume interactively while also ignoring persistent user/project configuration.
Managed Luna, Terra, and Sol launches remain available through clean
`codex exec` boundaries. Claude pane creation is serialized and becomes active
only after the supervisor reports the exact launch accepted.

This is not unrestricted Claude Code/Codex terminal parity. Provider workers
cannot directly reach the homelab or internet; all homelab mutations go through
the audited privileged broker, and provider API traffic goes only through the
matching bounded egress service.

## Source-only activation contract

The tracked units, sockets, slices, sysusers, tmpfiles, sudoers, digest-pinned
libexec policy, empty runtime configuration, and verification scripts under
`deploy/worker-session/` are dormant. A checkout may run the read-only source
check. Production mutation is reachable only through the fixed host handoff,
which invokes `--install-disabled` from the authenticated canonical
`/opt/teleagent/releases/sha256-*` root. The installed component copy is
check-only:

```sh
deploy/worker-session/teleagent-worker-session-install --source-check
/usr/local/libexec/teleagent-staging-handoff --install-disabled
/usr/local/libexec/teleagent-worker-session-install --check
```

The installer never creates `/etc/teleagent/worker-session/ENABLE`, enables a
unit, or starts/restarts a unit. It refuses active, failed, transitional, or
unknown unit state; after installation every unit must be exactly loaded,
inactive/dead, and static. Each unit is inspected with one sanitized,
10-second, 4096-byte-bounded systemd property snapshot that rejects missing,
duplicate, or unknown fields, stale loaded policy, and drop-ins. It also
verifies unique numeric UIDs/GIDs so a preexisting
account or group cannot alias two privilege planes. Before either
`--install-disabled` or `--check` returns its fixed success token, the installed
root provider boundary runs only its read-only `attest-workspace-storage` and
`attest-provider-plane-storage` actions. Those actions reuse the launch-time
storage validators and emit exactly `PROVIDER_WORKSPACE_STORAGE_OK` and
`PROVIDER_PLANE_STORAGE_OK` only when both dedicated mounts satisfy the
boundaries described above; they do not start a provider, create a capability,
or activate a unit. Source
checking validates the attestor bytes and wiring without claiming that an
offline release tree proves host mount state. Canonical release staging
normalizes executable sources to mode 0555 and data sources to 0444; the source
checker also accepts the non-writable-parent development variants 0755/0644.
Every worker, provider-supervisor, provider-egress, and libexec-install unit
runs the fixed host-owned release verifier with `--check-start-gate` as its
first execution directive under an empty environment. This cheap boot-time gate
validates the boot gate, current release, approval, manifest, and installed
runtime metadata without scanning or hashing the full release, then emits
`TELEAGENT_RELEASE_START_GATE_OK`. Each unit contains it exactly once as the
first `ExecStartPre`/`ExecStart` directive, contains no `ExecCondition` or
`ExecReload`, and snapshots the nonsecret, host-owned global gate into a
private mode-`0400` service credential with `LoadCredential`. Its
worker, provider-supervisor, and provider-egress units then call one closed
root-only `--preflight-component` profile. The fixed verifier reauthenticates
the snapshot and live release while retaining the shared handoff lock, and
runs only the mapped immutable storage/admission or credential helper through
the release's bundled Node. For provider egress, the verifier also securely
opens the selected `provider-api-key` from the same private systemd credential
directory and passes that descriptor only to the credential profile. The
helper proves that snapshot still equals the selected live source and that the
two live provider sources remain distinct. The helper inherits the relevant
descriptors for its whole read-only check, including parent-only verifier
failure. No supported credential writer exists; any future rotation writer
must take the exclusive handoff lock. The
ordinary sandboxed `ExecStart` then asks the fixed verifier to launch one named
component from that snapshot. The launcher verifies the exact immutable release
root and service identity, scrubs loader/runtime injection variables, and
`execve`s only the entrypoint and Node interpreter inside that root; no worker
start executes via `/opt/teleagent/current`. The full `--check-runtime` scan
remains serialized at release handoff rather than being amplified across
service prestarts.
The root provider-CLI installer and checker treat the pinned Claude binary,
Codex wrapper, and Codex vendor binary as opaque bytes: they verify exact
owner, mode, link count, size, path, and digest but never execute them, including
for `--version`. Captured version strings remain release provenance. The later
managed provider canary is the sole activation execution proof and runs through
the unprivileged supervisor/worker boundary.

Any entry named `.provider-cli-stage-*` under
`/opt/teleagent/agent-tools` is fail-closed evidence of an interrupted CLI
install. Do not retry installation or activate the provider plane. First prove
the provider plane is quiescent; then root must inspect the entry and remove
only the exact reviewed orphan before retrying. The installer and checker never
delete an orphan automatically.

Activation is a later, explicit root operation. It requires a root review,
provider-specific credentials with project-side billing limits plus local
conservative request/reserved-token allowances, the activation sentinel, and a
clean run of
`/usr/local/libexec/verify-worker-session-boundary --installed-check`. The
verifier repeats both storage attestations after verifying the installed
libexec digest closure. Both the worker broker and provider supervisor units
also run the root attestations as an `ExecStartPre`, so activation cannot bypass
a missing, shared, oversized, or low-free-space workspace or provider-plane
mount. The
verifier then exercises the real split UIDs, socket/DB/tmux DAC denials,
fixed-anchor provider canaries, private-runtime socket mask, provider egress,
and zero-capability model runtime. Do not add provider workers to
`teleagent-control` or `teleagent-provider-launch`, expose the root broker, copy
provider credentials into worker homes, or make owner tmux sockets visible.

Each provider canary captures rather than forwards provider stdout/stderr,
enforces a 16 KiB combined-output ceiling and a 60-second absolute deadline,
and accepts only the provider-specific final protocol evidence for the exact
text `PROVIDER_CANARY_OK`. Successful verification receives only the fixed
`PROVIDER_CANARY_ATTESTED <provider>` line. On a deadline or output violation,
the canary kills its supervisor client and waits on a bounded close fence; the
supervisor's established client-loss path reserves provider termination and
checks the launch cgroup. A canary failure never claims that recovery or cgroup
quiescence has completed.

The local allowance is not actual token usage, dollar spend, or remaining
OpenAI/Anthropic project balance. Provider billing dashboards remain
authoritative; Teleagent reports only bounded local request and conservative
reserved-token counters.
