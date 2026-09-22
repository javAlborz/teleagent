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
to 16 KiB, and checked for metadata changes. JSON uses exactly
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
- no new aggregate memory-limit/OOM/task-limit event, boot change, cgroup
  replacement or profile change appears during observation.

The kernel's `/proc/pressure/memory` is intentionally mode `0666`: writes
register per-descriptor PSI triggers, without modifying the observed pressure
counters. This exact root-owned path is accepted only after checking the
procfs filesystem type and canonical root-owned ancestors. The exception does
not apply to profiles or cgroup files, which remain non-writable by other UIDs.

Cumulative old limit events do not permanently disable admission. A newly
increased or reset event counter does refuse it. Samples outside the bounded
200 ms–2 s interval refuse as stale/invalid. Successful admission returns only
a profile digest and bounded decision metadata.

An admission sample is not a host-wide reservation. Other host services can
grow after admission. The normal-child cap accounting protects the recovery
allowance **inside Teleagent's pool**; it does not grant memory protection
against unrelated pools, and CPU quota is a ceiling, not a CPU reservation.
The host allocation must separately account for other system/user pools,
recovery CPU service, root recovery routing, and runtime monitoring. This
candidate cannot claim installed recovery availability without those proofs.
Kernel semantics are documented in the [cgroup v2 reference](https://docs.kernel.org/admin-guide/cgroup-v2.html)
and [PSI reference](https://docs.kernel.org/accounting/psi.html).

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

On 2026-09-22 the resource-admission and provider-boundary suites passed
102/102 tests in 1.89 seconds, using the serial `scripts/hermes-safe-test`
wrapper. The runner asserted 512 MiB memory, zero swap, 128 tasks and one CPU;
peak cgroup charge was 50,876,416 bytes. Runtime syntax and diff checks passed.
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
