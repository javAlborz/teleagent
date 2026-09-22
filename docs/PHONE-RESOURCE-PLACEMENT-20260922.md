# Proposed shared-host profile and service placement

This is a reviewable trial proposal, not an installed allocation or independent
host approval. It implements the numerical proposal in the private infra
`docs/TELEAGENT_RESOURCE_ALLOCATION_20260922.md` as canonical data, including the
128 MiB/64-task media parent. No unit, installer, service, limit, filesystem or
activation state changes in this proposal. The dedicated staging refusal
remains intact.

The candidate input is
[`proposals/teleagent-resource-admission-hermes-20260922.json`](proposals/teleagent-resource-admission-hermes-20260922.json).
It is intentionally stored under documentation, with no automatic installation
or default-path fallback. A later independently reviewed installation would
place its approved exact bytes at `/etc/teleagent/resource-admission.json` and
bind its digest plus the complete unit/runtime/source closure to host authority.
The proposed exact file SHA-256 is
`463a5a1fce7a081dee67b9a521cc55276e296f70d0ba6f84178b8569035475d7`.

## Canonical accounting

The JSON uses exactly `JSON.stringify(profile) + '\n'`, decimal-string byte,
task and quota quantities, and integer PSI basis points. The production
`validateProfile` parser is the authority for structural validation.
On 2026-09-22 that production parser accepted these exact bytes, and explicit
BigInt checks verified every sum, reserve, admission floor and headroom figure
below. The single validation ran serially through `scripts/hermes-safe-test`,
asserting 512 MiB/zero swap/128 tasks/one CPU; peak charge was 11,911,168 bytes.
This was source data validation, without installing or applying the profile.

| Pool or direct child | Memory maximum, bytes | Tasks maximum |
| --- | ---: | ---: |
| `teleagent.slice` | 10,737,418,240 (10 GiB) | 2560 |
| `teleagent-provider.slice` | 5,368,709,120 (5 GiB) | 1024 |
| `teleagent-voice.slice` | 3,221,225,472 (3 GiB) | 1024 |
| `teleagent-agent-controller.service` | 805,306,368 (768 MiB) | 128 |
| `teleagent-worker-session.service` | 268,435,456 (256 MiB) | 64 |
| `teleagent-media.slice` | 134,217,728 (128 MiB) | 64 |
| `teleagent-recovery.slice` | 536,870,912 (512 MiB) | 64 |

Normal maxima sum to **9,797,894,144 bytes (9.125 GiB), 2304 tasks**.
Adding recovery gives **10,334,765,056 bytes (9.625 GiB), 2368 tasks**.
The parent therefore has **402,653,184 bytes (384 MiB), 192 tasks** unassigned.
This arithmetic protects the recovery allowance from the accounted normal
child ceilings; it does not reserve physical memory against unrelated pools.

The aggregate high threshold is 9,663,676,416 bytes (9 GiB), swap maximum zero,
and CPU quota 300,000 microseconds per 100,000 microseconds (300%). Every direct
child must have zero swap maximum and zero current swap charge. The aggregate
must have no direct processes. All descendants remain subject to complete
event inventory and topology observation.

Additional job allowance is **3,489,660,928 bytes (3.25 GiB), 416 tasks**.
Host headroom retained after adding that allowance is **2,147,483,648 bytes
(2 GiB)**, requiring at least **5,637,144,576 bytes (5.25 GiB) MemAvailable** at
admission. Provider pre-job charge cannot exceed **1,879,048,192 bytes
(1.75 GiB), 608 tasks**. Pool high imposes a pre-job memory ceiling of
**6,174,015,488 bytes (5.75 GiB)**; the pool task condition retains recovery
and the job allowance, permitting at most **2080 existing tasks**. Other
pressure/event/identity checks can refuse even below those ceilings.

PSI thresholds are 100 basis points some-memory (1.00%) and 20 basis points
full-memory (0.20%), for all recorded averages and the conservative short
sample fraction. These are initial review thresholds, not measured latency
guarantees. Existing one-global-job fencing and each model's 3 GiB/384-task
hard cap remain required.

## Exact cgroup placement to implement after review

All paths below are relative to `/sys/fs/cgroup`. These are target placements;
the table does not assert that the units exist or are assigned this way today.

| Target parent/path | Accounted processes and required change |
| --- | --- |
| `/teleagent.slice` | New structural aggregate slice. No direct processes. Keep the complete required direct-child set present while admission is usable. |
| `/teleagent.slice/teleagent-provider.slice` | Both `teleagent-provider-supervisor@{claude,codex}.service` and `teleagent-provider-egress@{claude,codex}.service` already select this slice. Reduce parent max from 6 to 5 GiB; keep 1024 tasks and zero swap. |
| `.../teleagent-provider.slice/teleagent-provider-model.slice` | Retain the existing nested model slice and each fixed transient model service beneath it. Preserve global admission and individual model caps; a slice name with another dash denotes this deeper ancestry. |
| `.../teleagent-provider.slice/teleagent-provider-libexec-install.service` | Add explicit `Slice=teleagent-provider.slice`, finite startup-helper caps and zero swap. Install/verification completes before job admission; no permanent direct-child requirement is created for this empty oneshot. |
| `.../teleagent-provider.slice/teleagent-provider-model-apparmor.service` | Same accounted provider placement, finite startup-helper caps and zero swap. Preserve its fixed authority and ordering. |
| `/teleagent.slice/teleagent-voice.slice` | New structural voice parent, 3 GiB/1024 tasks/zero swap. It accounts for both container and voice-lifecycle charges. |
| `.../teleagent-voice.slice/teleagent-voice-containers.slice/docker-<ID>.scope` | Preserve all four exact Compose services' `cgroup_parent: teleagent-voice-containers.slice`; verify actual Docker systemd-driver cgroup identities. Their memory caps sum to 2688 MiB. |
| `.../teleagent-voice.slice/teleagent-voice-stack.service` | Add explicit voice-parent placement and review lower lifecycle caps. Its current 512 MiB/128-task service is otherwise a separate unaccounted host charge. The launch/stop/cleanup subprocesses inherit this service boundary. |
| `.../teleagent-voice.slice/teleagent-sip-local-peer-fence.service` | Account this currently uncapped required monitor under the voice parent with finite caps, while it remains part of the reviewed dependency graph. A replacement/removal requires its own topology and closure review. |
| `/teleagent.slice/teleagent-agent-controller.service` | Add `Slice=teleagent.slice`; reduce max from 3 GiB/512 tasks to 768 MiB/128 tasks. Choose a reviewed high threshold below 768 MiB. Both protected HTTP listeners remain charged here. |
| `/teleagent.slice/teleagent-worker-session.service` | Add `Slice=teleagent.slice`; reduce max from 512 MiB/128 tasks to 256 MiB/64 tasks. Choose a reviewed high threshold below 256 MiB. Broker-owned descendants must remain charged here. |
| `/teleagent.slice/teleagent-media.slice/docker-<anchor-ID>.scope` | New structural media parent. Four exact inert anchors retain 16 MiB/eight tasks each and `--cgroup-parent teleagent-media.slice`, as required by the Docker-anchor candidate. |
| `.../teleagent-media.slice/teleagent-media-coordinator.service` | Proposed fixed bounded lifecycle unit for reviewed network/anchor coordination. No such unit is claimed implemented here. Its command, authority, caps and cleanup require separate source review. |
| `/teleagent.slice/teleagent-recovery.slice/teleagent-recovery.service` | Proposed independent recovery service. The structural slice and real service must both exist and stay reachable while normal work is exhausted. The service implementation/authority is an explicit unresolved delivery item. |

An exact first implementation can review these additional **interior** trial
budgets without changing the canonical direct-child sums:

- Provider install and AppArmor oneshots: each 128 MiB/32 tasks, zero swap,
  active only during reviewed startup. Both supervisor/egress pairs retain
  their existing 512 MiB/128-task caps. Their sums are shared ceilings under
  the 5 GiB parent, not simultaneous physical reservations.
- Voice containers: retain the current 3 GiB/1024-task aggregate ceiling and
  existing per-container hard caps. Voice lifecycle: propose 256 MiB/64 tasks;
  SIP peer-fence: propose 32 MiB/16 tasks. The 3 GiB voice parent bounds their
  combined actual charge. Even the existing four per-container task caps sum
  to 1344, so aggregate task exhaustion must be tested; individual ceilings
  are not promised simultaneous capacity.
- Media: four anchors total 64 MiB/32 tasks; propose one coordinator ceiling
  of 64 MiB/32 tasks. That exactly accounts for the proposed 128 MiB/64-task
  media parent, including the coordinator's own tool subprocesses.
- Recovery: the independent service and all of its own tools must fit within
  the 512 MiB/64-task recovery parent. Do not charge ordinary installation or
  model work to this allowance merely because it is available.

These interior numbers are estimates for review, not measured acceptance.
Container daemons and other shared host infrastructure may consume resources
outside the pool; admission's host headroom condition and host allocation
review must account for them. Merely placing the Docker client inside a slice
does not move the Docker daemon into it.

Sockets and inactive empty oneshots are not permanent process cgroups to list
as profile children. Structural slices need explicit lifetime dependencies;
`StopWhenUnneeded` must not erase a required parent during usable admission.
After disabled installation, startup verifies the exact direct-child set and
each live descendant's placement. Unknown children, missing required parents,
unexpected delegation or mutable topology refuse new jobs.

The privileged-action broker is outside this read-only trial's active scope.
Do not start it under the shared-host profile. Enabling it needs a separate
accounted allocation, source/authority review and acceptance; its storage
placeholder does not authorize a running service.

## Recovery and commissioning boundaries

The existing panic listener runs inside the controller cgroup. Its stop-only
admission bypass does not place it in the recovery allowance or prove it can
serve while that controller cgroup is exhausted. The independent recovery
service must have its own narrowly authenticated stop/status transport,
immutable fixed target inventory and verified stop/cleanup outcomes, with
uncertainty retained. This document does not implement or authorize that API.

The 300% aggregate CPU quota is a ceiling. Existing normal child quotas can
consume it; CPU weights alone do not reserve recovery execution once the
parent is throttled. Independent review must choose and test a bounded recovery
latency policy, such as reviewed normal-plane CPU budgeting and the recovery
service's priority. No owner-pool reduction, owner-session stop or host-wide
CPU reservation is implied by this proposal.

The observed 15.248 GiB physical memory can contain a 10 GiB pool plus a 2 GiB
headroom floor, but the existing owner pool's 11 GiB cap and unrelated services
prevent treating those independent ceilings as simultaneous guarantees. Both
the future pool's steady state and the reduced controller/broker/lifecycle
budgets remain unmeasured. Require startup, active-call/task, cancellation,
restart and recovery acceptance under the exact reviewed allocation.

The production topology observer passed a separately reviewed one-shot probe
on actual Hermes kernel `6.8.0-139-generic` under an isolated safe-test cgroup:
baseline succeeded, exact raw CREATE/DELETE/ATTRIB masks were observed, and
transient create-delete between equal inventories caused refusal. All owned
empty test children were removed with identity-bound nonrecursive cleanup.
This proves controlled kernel delivery only. The installed provider's read-only
mount view, immutable Python/runtime closure, mount ownership and final
observation-to-launch control still require acceptance.

Before any source unit change, coordinate the exact unit list with the release
owner so all changed unit digests and mirrored app/infra closure manifests can
be repinned together. Existing protection flags and staging refusal must not
be relaxed to make this proposal pass. Storage, useful workspace, provider
budget and phone/audio acceptance remain separate gates.
