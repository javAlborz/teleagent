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

The model profile permits anonymous stream socketpairs for Node child-process
I/O. Abstract Unix connection/listener operations remain denied.
Same-profile process metadata reads let the runtime record its child PID and
start time before acknowledging spawn. Ptrace attachment/control and metadata
access to other profiles are not granted.
AppArmor checks pathname sockets through file-write permissions, so model
writes are limited to its private `/tmp`, the admitted workspace, and standard
terminal devices. The private mounts and pre-launch rejection of workspace
sockets are part of this boundary; the profile must not be used alone against
an arbitrary host workspace. See the [AppArmor Unix socket rules](https://apparmor.net/man/3.0/apparmor.d/#unix-socket-rules).

The attended activation verifier creates a root-owned world-connectable socket
at `/run/teleagent-visible-host-socket-probe.sock`. An optional read-only bind
projects this exact fixture into the private runtime. The verifier first proves
the worker UID can connect without the model profile; the model runtime then
requires an AppArmor denial. The fixture stays outside the socket-free
workspace. Its listener and path are removed on verifier exit. Route checks use
`/proc/self/net` so they inspect the launch namespace with `ProcSubset=pid`.

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

## Global launch admission and uncertain cleanup

The root-only `.global-provider-launch.lock` in
`/run/teleagent-provider-capabilities` serializes both providers. It is a
crash-atomically published **same-boot admission fence**, not a PID-lifetime
mutex or proof of reboot recovery. A wrapper exit, dead PID, capability expiry,
or empty unit enumeration cannot by itself authorize the next launch.

The launcher marks capability uncertainty before the registration RPC and model
uncertainty before submitting `systemd-run`. It releases admission only after a
successful helper completion, explicit cgroup quiescence, durable/quiescent
egress revocation, and successful credential-file cleanup. Nonzero or abnormal
helper exits are conservatively treated as ambiguous submission, even if a
later snapshot says the unit is absent. This can require global recovery after
a genuinely failed task; it never silently assumes that task is still running
or successfully stopped. Missing, malformed, duplicate, or unreadable
`cgroup.events` population evidence is not proof of an empty cgroup. The kernel
defines `populated 0` as no live process in the group or its descendants.
[Kernel cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html#un-populated-notification).

An interrupted registration still requires revocation: the egress broker writes
a durable cancellation tombstone even for an unknown launch ID, so a late
registration cannot reactivate it. Recovery retains the global panic, stops and
masks both supervisors, and cancels the retained exact launch identity for both
provider names before enumerating visible units. The version-1 lock deliberately
does not name the provider. Termination always requires a successful exact-unit
`stop --job-mode=replace` as well as empty cgroup and quiescent egress evidence;
an inactive unit can still have a queued start job. Missing or failed stop proof
keeps admission and readiness evidence fenced. Both exact cancellation masks
remain for the boot;
the global fence is removed only after both model/egress planes are quiescent,
the recorded wrapper generation is dead, and the captured lock record is still
identical. Single-provider recovery does not clear this global fence.

Global panic alone may clean an exact absent readiness record after all three
stop/cgroup/egress proofs succeed. This handles the other provider's never-owned
record and repeated cleanup of already-removed records. The result marks history
unavailable; it does not claim the provider never ran. Ordinary status and
per-launch termination still reject missing history, and unsafe or malformed
existing records are never treated as absent. The allowance has no CLI or
environment switch.

The delayed-submission protection uses the existing systemd cancellation-mask
primitive. In upstream systemd v255, `StartTransientUnit` loads the named unit
and requires it to be pristine; a masked unit is excluded by that check.
[Transient creation](https://github.com/systemd/systemd/blob/v255/src/core/dbus-manager.c#L987),
[pristine-unit check](https://github.com/systemd/systemd/blob/v255/src/core/unit.c#L5153).
Hermetic tests exercise real temporary lock/mask files and the actual launch and
recovery functions with mocked systemd/provider operations. This is not a live
systemd cancellation canary or a Hermes activation approval.

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
conservative request, reserved-token, and reserved-cost allowances, the activation sentinel, and a
clean run of
`/usr/local/libexec/verify-worker-session-boundary --installed-check`. The
root-owned single-link mode-`0444` file
`/etc/teleagent/provider-runtime/enabled-providers` selects exactly `codex`
or `claude,codex`, followed by one newline. The controller's root-owned
`/etc/teleagent/controller/runtime.env` must contain exactly the matching
`AGENT_PROVIDERS=` assignment. The root-owned
`/etc/teleagent-isolated-voice/voice-app.env` must also contain the same
`AGENT_PROVIDERS=` assignment and a valid `OPENAI_PROJECT=proj_...` assignment.
The voice launcher checks both before starting Compose, and Compose passes them
to the voice app. The worker activation verifier also checks that the voice
`OPENAI_PROJECT` exactly matches Codex's root-owned egress policy project ID.
In `codex` mode, the verifier
requires Claude's key, policy, sockets, and units to be absent or inactive;
the Codex credential preflight does not require a dummy Claude key. In the
full two-provider mode, start the Claude supervisor socket explicitly before
running the verifier, and use the full two-provider canary acknowledgment.
Neither mode makes the release or phone ready without the remaining gates.
The
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

The local allowance is an estimate, not actual token usage, dollar spend, or
remaining OpenAI/Anthropic project balance. Provider billing dashboards remain
authoritative. The durable SQLite ledger reserves request bytes plus the
maximum output tokens and an envelope for every admitted request, including
failed upstream requests. It charges those reserved tokens at a fixed
conservative ceiling of $30 per million for Claude and $45 per million for
Codex, with a hard policy ceiling of $5 in reserved cost per provider per UTC
day. The gate rejects multimodal content, hosted tools, and caller-selected
premium service tiers. Codex requests explicitly use the OpenAI `default`
service tier so a project-wide Fast setting cannot silently change their
price. Those rates cover the admitted standard text traffic. A
missing legacy cost row fails closed. The policy examples also cap each
provider at 200,000 reserved tokens per UTC day. No local ledger guarantees a
provider invoice ceiling: verify current model rates, project/workspace
credential binding, and provider-side monthly hard limits before activating
either credential. Recheck these fixed rates if the allowed models or provider
prices change. The September 23, 2026 rate review used the providers'
[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
and [OpenAI API pricing](https://developers.openai.com/api/docs/pricing);
the fixed allowances deliberately exceed standard text-token rates for the
allowed models at that review.

For the first account-bound, Codex-only pilot, use the owner-selected OpenAI
`phone` project and its approved $10 monthly limit with standard processing.
In the [OpenAI project settings](https://developers.openai.com/api/docs/guides/spend-limits),
open Limits > Spend, confirm the monthly amount, turn on **Enforce a hard limit**,
and verify the saved setting. A spend alert alone does not stop traffic, and
hard-limit enforcement can lag enough for a small amount of extra usage. Bind its
project-scoped API key through the protected host credential path. A Claude
workspace and key are only needed when activating the later six-profile,
two-provider release; give that workspace its own spend limit before use.
The Codex policy example has `openaiProjectId: null`, which makes Codex
requests fail before budget reservation. After account verification, set the
exact `proj_...` ID in the root-owned policy; the broker then sends the fixed
`OpenAI-Project` header and rejects caller-selected project or organization
headers. This guards against accidentally billing an account default. The
real provider canary must confirm that the dedicated project accepts the
service-account key and header together. OpenAI documents that this header
selects a project when a key otherwise resolves an account default in its
[Terraform provider guide](https://developers.openai.com/api/docs/guides/terraform).
The repository contains no account IDs or keys, so neither account binding
nor vendor limit is asserted by this source policy. OpenAI's
[spend-limit instructions](https://developers.openai.com/api/docs/guides/spend-limits)
and Claude's [workspace limits](https://platform.claude.com/docs/en/manage-claude/workspaces)
describe those account controls.
