# Shared-host provider admission

This is a source candidate for the first managed, read-only phone job. It is
not a commissioned Hermes allocation. No live limits, filesystems, service
assignments or activation state were changed. There is deliberately no default
resource profile and no environment variable that bypasses admission.

`deploy/worker-session/teleagent-resource-admission` is imported by the fixed
root provider boundary. The existing root-owned global launch fence still
admits only one Claude/Codex model job in total, retaining the fence whenever
model or egress quiescence is uncertain. Resource observation happens under
that fence, before capability registration and again immediately before the
model's systemd start request. Both observations sample for 250 ms. A refusal
after registration must revoke the capability before the fence can be removed.

Panic, cancellation, status and cleanup do not read the admission profile or
resource evidence. A missing/malformed profile, missing cgroup, pressure,
exhausted reserve, or observation failure refuses only new launches. It never
turns uncertainty about prior effects into a retry-safe result.

## Exact host-owned profile

The fixed path is `/etc/teleagent/resource-admission.json`. The file and its
ancestors must be root-owned, not writable by other identities, and free of
symlink substitution. Files are read with `O_NOFOLLOW` and `O_NONBLOCK`, bounded
to 16 KiB (128 KiB only for kernel mount metadata), and checked for metadata changes. JSON uses exactly
`JSON.stringify(profile) + '\n'`; duplicate keys, extra fields and alternative
numeric forms are refused. Byte/count/quota quantities are decimal **strings**;
pressure thresholds are integer basis points (100 means 1%).

| Field | Required meaning |
| --- | --- |
| `schema` | Exactly `teleagent.resource-admission.v1` |
| `hostname` | Exactly `hermes`, matched against the kernel hostname |
| `pool` | Exact `memoryHighBytes`, `memoryMaxBytes`, `tasksMax`, `cpuQuotaMicros`, `cpuPeriodMicros` for `/teleagent.slice` |
| `normalChildren` | Array of exact direct-child `name`, `memoryMaxBytes`, `tasksMax` entries |
| `recovery` | Exact `memoryMaxBytes` and `tasksMax` for `teleagent-recovery.slice` |
| `hostReserveBytes` | Host memory headroom retained after admitting the model; at least the recovery memory allowance |
| `launchMemoryHeadroomBytes` | Complete maximum additional job charge; at least the existing 3 GiB model maximum, including any further launch overhead in the approved allocation |
| `launchTasksHeadroom` | Additional job tasks; at least the existing 384-task model bound, plus reviewed overhead |
| `maxSomePressureBasisPoints` | Maximum some-memory PSI average and sample stall fraction |
| `maxFullPressureBasisPoints` | Maximum full-memory PSI average and sample stall fraction, no greater than the some threshold |

All normal child memory maxima **plus** the recovery maximum must fit inside
the pool memory maximum; task maxima obey the same rule. This ensures bounded
normal children cannot consume the recovery allowance inside this pool. An
immediate pool child missing from the profile, or a required child missing
from the kernel hierarchy, refuses admission. The aggregate pool must have no
direct processes. Pool and every direct child must have zero swap maximum and
zero current swap charge. The aggregate memory high threshold, hard maximum,
task maximum and finite CPU quota must match the exact profile.

Required normal children are:

- `teleagent-provider.slice`, which contains both supervisors, egress services
  and the model slice;
- `teleagent-voice.slice`, the parent of `teleagent-voice-containers.slice`;
- `teleagent-agent-controller.service`;
- `teleagent-worker-session.service`.

Other normal children, including an applicable voice lifecycle unit, must have
their exact caps listed too. Slice names follow systemd's direct-child naming
rule; an extra dash introduces another slice ancestor. Services such as the
controller and worker must be assigned explicitly to `Slice=teleagent.slice`.
An installed, finite `teleagent.slice` and `teleagent-voice.slice` are required;
the old provider/voice/controller per-service caps alone cannot satisfy this
contract. A recovery service must actually run inside the bounded recovery
slice and remain operable under load; merely creating that slice is not
operational proof.

The allocation and exact profile digest belong in the independent host release
approval and startup verification. Root ownership alone does not establish
external approval. Installation must add this helper to the provider libexec
manifest and both release source closures, then repin the changed boundary.
No manifest or authority pins are changed in this candidate.

## Kernel evidence and limits of the observation

The collector requires the cgroup v2 filesystem magic, the host cgroup
namespace, canonical root-owned paths, stable cgroup identities, and domain
cgroups. It strictly parses memory/task counters, pressure lines and
`/proc/meminfo`; absent evidence is never interpreted as zero. It verifies:

- host `MemAvailable` covers the whole prospective job plus host reserve;
- the aggregate stays below `memory.high`, and the aggregate hard memory/task
  bounds retain the explicit recovery allowance after adding the job;
- the provider slice has enough headroom of its own;
- host and aggregate memory PSI averages and new stall totals remain below the
  exact profile thresholds;
- no new memory-limit/OOM/task-limit event in the pool or any descendant, boot change, cgroup
  replacement or profile change appears during observation.

The event inventory includes every nested service/container cgroup, not only
the profile's direct children. Each snapshot enumerates the complete tree twice
and matches group paths, device/inode identities, directory modification/change
times and child names. The two observation snapshots must retain that same
inventory. Every group must expose valid `memory.events` and `pids.events`;
missing counters, new/removed groups, replacements, changed event fields and
counter resets refuse admission. Enumeration streams at most 512 entries per
directory, with at most 256 groups including the pool and 16 descendant levels.
Exceeding any bound refuses new work; none can be changed through environment.
Directory timestamps provide supporting evidence only: a transient cgroup can
vanish without leaving a usable timestamp change. The independent topology
observer described below is mandatory; timestamps never replace it.

Bounded `/proc/self/mountinfo` evidence must identify one full-root cgroup-v2
mount at `/sys/fs/cgroup`, with no subordinate mounts and only supported
superblock options. Its exact identity/options must stay unchanged throughout
the observation. A read-only canonical view, such as `ProtectControlGroups`
provides, is sufficient; resource observation never requires weakening it.
`memory_localevents` and `pids_localevents` are explicitly
recognized and supported by sampling each group. Default PID-event propagation
is deliberately not inferred from absent mount flags: Linux 6.8 records fork
limit failures locally, while newer kernels can aggregate them. This collector
therefore requires no `pids.events.local` file or kernel upgrade. See the
[kernel mount-option contract](https://docs.kernel.org/admin-guide/cgroup-v2.html#mounting)
and [Linux 6.8 PID controller implementation](https://github.com/torvalds/linux/blob/v6.8/kernel/cgroup/pids.c).

The kernel's `/proc/pressure/memory` is intentionally mode `0666`: writes
register per-descriptor PSI triggers, without modifying the observed pressure
counters. This exact root-owned path is accepted only after checking the
procfs filesystem type and canonical root-owned ancestors. The exception does
not apply to profiles or cgroup files, which remain non-writable by other UIDs.

Cumulative old limit events do not permanently disable admission. A newly
increased or reset event counter does refuse it. Samples outside the bounded
200 ms–2 s interval refuse as stale/invalid. Successful admission returns only
a profile digest and bounded decision metadata.

The PSI stall denominator covers only the timed wait between snapshots; the
actual counter observation interval contains that entire wait. This gives a
conservative fraction and prevents slow evidence reads from diluting observed
pressure. Total collection, including final profile revalidation, must still
finish within two seconds.

An admission sample is not a host-wide reservation. Other host services can
grow after admission. The normal-child cap accounting protects the recovery
allowance **inside Teleagent's pool**; it does not grant memory protection
against unrelated pools, and CPU quota is a ceiling, not a CPU reservation.
The host allocation must separately account for other system/user pools,
recovery CPU service, root recovery routing, and runtime monitoring. This
candidate cannot claim installed recovery availability without those proofs.
Kernel semantics are documented in the [cgroup v2 reference](https://docs.kernel.org/admin-guide/cgroup-v2.html)
and [PSI reference](https://docs.kernel.org/accounting/psi.html).

## Required topology observer

New admission requires the fixed root-owned, single-link mode `0555` helper
`/usr/local/libexec/teleagent-resource-topology-watch`, installed from
`deploy/worker-session/teleagent-resource-topology-watch`. The provider invokes
only `/usr/bin/python3 -I` with that fixed source path, a fixed working directory
and a two-variable locale environment. Production accepts no caller paths,
arguments or configurable scope. Missing or unsafe helper evidence refuses
new work without a fallback. Panic, cancellation, status and cleanup do not
start the observer.

The isolated Python helper uses standard-library `ctypes` to retain one raw,
nonblocking inotify descriptor and open directory descriptors for the complete
fixed `/sys/fs/cgroup/teleagent.slice` subtree. Each directory is watched through
its retained `/proc/self/fd` identity before it is enumerated. Unique watch and
device/inode identities, safe permissions, a single device, 256 groups,
16 descendant levels, 512 entries per directory, 1,024 bytes per relative path
and a 128 KiB readiness frame are mandatory. Setup events poison the observation;
the observer never adopts newly created directories or takes a new baseline.
Readiness binds the boot ID and every relative path plus decimal-string
device/inode identity to both admission snapshots.

Any nonempty raw event read, EOF or read error refuses admission. This includes
create/delete/move, self replacement, attribute changes, ignored watches,
unmount and queue overflow. Following the second snapshot and final profile
check, the parent sends one unpredictable nonce-bearing `CHECK` command. The
helper synchronously drains the raw queue and emits exactly one matching
receipt. The parent accepts it only after a clean, reaped helper exit; missing,
partial, repeated or extra protocol output and helper death all refuse.
Observation ends at that final drain. It is not an atomic reservation through
the subsequent systemd start request.

The helper has its own three-second deadline, and the parent enforces a
2.5-second protocol deadline plus at most 500 ms to confirm cleanup. The
existing two-second total resource-observation bound still applies. Every
parent failure kills and awaits its exact child. The helper closes inherited
descriptors beyond its pipes and installs `PR_SET_PDEATHSIG` with a parent-ID
recheck to close the setup race. Cleanup uncertainty cannot grant admission.

Installation must bind this helper's exact source digest and executable mode
into the provider libexec manifest, both release source closures and independent
host release authority. The trusted execution closure includes the selected
`/usr/bin/python3`, standard library, `_ctypes`, libc and required shared
libraries; these must be covered by host runtime integrity and startup checks.
This introduces no generated binary and fabricates neither a binary artifact
nor an approved installation. Existing root-owned mount and procfs integrity
checks remain required. Inotify cannot prove that a transient mount overlay
never occurred; accepted host authority must control the observer's mount
namespace and replacement permissions.

Ordinary-directory kernel tests prove raw create/delete/rename notifications,
setup churn refusal, a vanished nested directory between identical snapshots,
parent death and deadline cleanup. Overflow, ignored-watch, unmount, EOF and
read-error refusal use injected raw-read fixtures, not induced kernel overflow
or live cgroup operations. Exact Ubuntu-kernel cgroup notifications, the
installed service's procfs/mount view and lifecycle control of the final
observation-to-launch interval require separate acceptance before activation.

## Durable storage remains a separate gate

Resource admission does not replace existing storage checks. The provider
plane currently requires its own durable local 1–4 GiB filesystem with a
free-space reserve of at least 512 MiB or 20%, whichever is greater. The exact
workspace filesystem must be distinct, at most 64 GiB, with at least 2 GiB
available. Those checks still run before every provider launch.

Commissioning must select the actual bounded backing storage and exact scope
for controller SQLite/WAL, voice SQLite/WAL and recordings/outbox, provider
supervisor histories, egress durability, and the selected workspace. A large
shared filesystem with free space does not implement separate quotas. Bind
the selected filesystem identities, capacities and retention/backup rules to
the host profile; prove low-space refusal while panic and cleanup remain
usable, WAL-safe migration and restore, and recovery when a state filesystem
is full. Preserve all existing FreeSWITCH volumes. No storage is allocated or
migrated by this change.

## Validation and remaining acceptance

The final resource-admission and topology-observer suites passed 70/70 focused
tests on 2026-09-22 in 10.581 seconds. The serial `scripts/hermes-safe-test`
runner asserted 512 MiB memory, zero swap, 128 tasks and one CPU; peak cgroup
charge was 66,043,904 bytes. These tests used synthetic resource metadata and
disposable ordinary directories, without creating or changing live cgroups.

On 2026-09-22 the resource-admission and provider-boundary suites passed
104/104 tests in 1.88 seconds, using the serial `scripts/hermes-safe-test`
wrapper. The runner asserted 512 MiB memory, zero swap, 128 tasks and one CPU;
peak cgroup charge was 50,733,056 bytes. Runtime syntax and diff checks passed.
The new helper and changed tests passed strict lint; provider-boundary runtime
lint retained its two previously documented warnings and had no errors.

Separate read-only checks confirmed the actual Hermes procfs/cgroup2 magic
values, root ownership and permissions of system.slice controller files, and
successful parsing of current host/pool PSI, memory/task events and meminfo.
These checks found the legitimate procfs PSI mode exception described above.
They do not prove the absent aggregate profile or service assignments.

Focused tests cover malformed and missing evidence, ownership and namespace
failures, finite child caps, recovery budgeting, pressure/event deltas,
changed identities, admission under the global fence, revocation on a second
refusal and retention of uncertain fences. The collector tests use synthetic
kernel files and root metadata; they neither impersonate actual installed
service identities nor change live cgroups.

Before activation, independently review the exact allocation and code, install
the full closure disabled, verify real unit/cgroup membership and source
identities, and exercise memory/task pressure plus controller/panic recovery
under the actual commissioned profile. The phone task remains unavailable
until those host, workspace, storage, provider-budget and release gates pass.
