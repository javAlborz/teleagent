# Hermes live-integration checkpoint — 2026-09-10

Status: independently reviewed and regression-validated source checkpoint.
**Not deployed or ready for full use.**
Base: `a5d0cfdab29e2a702ff836c4892b0e59dab6fdcd`.
Branch: `feat/hermes-live-integration-20260910`.
The owner's reboot deferral remains in force. The live execution plane remains
panic-locked; no credentials, routing, container, service, host policy or owner
session access were changed in this work.

## Confirmed defect and correction

Independent shared-host review identified an unsafe global provider admission
cleanup path. The launcher reported unproved cgroup termination or egress
revocation but still removed its global lock in `finally`. A different provider
could then be admitted. A lost registration reply also skipped revocation even
though registration might have committed.

Ten executable failure cases all reproduced the missing retained lock before
the runtime correction. The revised transaction:

- marks capability uncertainty **before** registration and model uncertainty
  **before** systemd submission;
- releases global admission only after successful helper completion, explicit
  cgroup quiescence, durable/quiescent revocation and credential-file cleanup;
- retains the fence after nonzero/abnormal helper exits even when the unit
  subsequently appears absent; a genuinely failed task may conservatively
  require global recovery;
- continues attempting revocation if credential cleanup itself fails;
- rejects malformed, missing or duplicate cgroup population evidence;
- fences and terminates the retained exact launch identity for **both** providers
  before global recovery enumerates visible units;
- requires an explicit successful replacing stop operation, not just an empty
  cgroup, so already-queued starts cannot survive cancellation;
- tolerates absent readiness only in global cleanup after stop/cgroup/egress
  proof, without inventing never-started or retry-safe history; normal status
  and termination still refuse missing evidence;
- binds recovery to the previously observed lock record and dead wrapper
  generation before unlinking it, while global panic remains in force.

This is a same-boot admission fence under `/run`, not reboot-persistent state or
a reboot acceptance result. Single-provider recovery does not clear it. The
egress tombstone contract preventing revoke-before-late-register reactivation is
also tested across SQLite reopen for both providers.

See [the worker boundary contract](WORKER-SESSION-BROKER.md#global-launch-admission-and-uncertain-cleanup)
for the cancellation-mask and cgroup evidence assumptions and primary sources.
The tests use actual launch/recovery functions and temporary lock/mask files,
but mocked systemd/provider operations. No live transient job, paid API call or
systemd crash canary was run.

## Validation record

- Initial pre-fix reproduction: all ten uncertainty cases failed the retained-
  lock oracle. These failures establish the defect; they are not a passing run.
- Review required a credential-cleanup-only oracle, queued-start cancellation,
  and real readiness-file recovery tests. Two queued-start/stop-proof tests
  reproduced failures before their correction. Replacing the permissive
  readiness mock exposed seven failing leaf cases before the cleanup-only fix.
- Final focused source: **95/95** tests passed (2.45 seconds), comprising 71
  boundary tests and 24 egress tests, including nested cases. The uncertainty
  matrix covers 17 cases; coverage also includes nine failed global recoveries,
  ten real readiness scenarios across both providers, strict normal missing-
  history refusal, and successful exact-ID recovery followed by a fresh
  different-provider admission. This supersedes, rather than adds to, earlier
  overlapping focused totals.
- The first full controller regression passed 327/330. All three failures were
  the still-old `provider-libexec.manifest` pin and the corresponding offline
  installer refusal. The pin is not updated until the replacement runtime is
  independently reviewed. This run is **not** a full regression pass.
- Independent review gave **source GO** for the exact final runtime, tests and
  contract below after all reported blockers were addressed. Only then was the
  one application source-manifest entry repinned. External host/release approval
  remains absent; the source manifest is not an activation permission.
- Final full regression on the exact reviewed source and repinned manifest:
  **346/346 controller tests** (160.79 seconds), **460/460 voice tests**
  (53.24 seconds), and **39/39 release/CI tests** (1.69 seconds). Total:
  **845 distinct tests**, with no failed, skipped or canceled tests. This total
  supersedes overlapping focused and earlier checkpoint counts.
- Both changed test files pass strict lint with no warnings. Runtime syntax and
  diff checks pass. Linting the extensionless runtime through a matching JS
  stdin path reports zero errors and two warnings (`UUID` unused and
  `reasoningEffort` prefer-const); the previous HEAD has the same two warnings.
  The runtime lint result is not described as warning-free.

Tests run sequentially through `scripts/hermes-safe-test`, with the inner
process checking `memory.max=536870912`, `memory.swap.max=0`, `pids.max=128` and
`cpu.max="100000 100000"`. No dependency versions were changed or downloaded;
temporary package-local links reuse the previous checkpoint's dependencies
after confirming both package-lock digests match. Peak cgroup memory was
126,472,192 charged bytes (not process RSS). QA exited successfully, and both
exact temporary dependency links were removed after checking their targets;
the dependency directories they referenced were not changed.

Reviewed source closure (SHA-256):

```text
deploy/worker-session/teleagent-provider-boundary
  b345402c962a46facf0c4206dbf9a67cf89dbdd278bb1e3bf36cb8707eb84256
claude-api-server/test/provider-boundary.test.js
  d382a365813218840159015e13fe801f10d411120b3136676580518c00fb21b8
claude-api-server/test/provider-egress-broker.test.js
  dd9a4922b14224dfe8f00e429c3321d1ce300874e33bcc0d176c405a28e08ffa
docs/WORKER-SESSION-BROKER.md
  e8aaed6d39cfb62cf46dcba0212b5fcca2d8adac50886684afd1ec7ac349533c
deploy/worker-session/provider-libexec.manifest
  72b21f343e51146cfe19b126a8035b72d831a6166a07741ed2db9a46210b5c4d
```

## Current deployment outcome and next gate

A read-only post-QA live check at approximately 19:11 UTC found the preserved voice, FreeSWITCH
and Drachtio container IDs unchanged, all running with zero restarts, execution
locked, and zero active Asterisk calls/channels. This is a startup/baseline
observation, not proof of full agent execution.

The shared-host review identified separate blockers that this source fix does
not claim to resolve: the world-readable handoff-lock protocol, receiver-safe
media/controller isolation, aggregate Hermes resource admission and dedicated
storage, and a reviewed activation/selection/rollback transaction. The current
dedicated-staging installer explicitly rejects Hermes and remains unchanged.

A non-authorizing Hermes read-only phase proposal is prepared separately in the
homelab worktree `fix/teleagent-hermes-isolation-20260910`, based on
`2ed6a137fe323427280d7162d901d5b0d82e8e42`, at
`docs/TELEAGENT_HERMES_READ_ONLY_PHASE.md`. Its two-file documentation-only review
passed, and it was committed locally as
`840cc5e8b541de9e2ca18711e1965dfe8039c77d`. That worktree is clean. It preserves
the external approval boundary and does not waive production or reboot gates.
No push, PR, profile commissioning or installation occurred. The prior
assessment worktree and dirty live application tree remain untouched.

Provider project selection and daily spending caps have been requested from the
owner for later paid canaries. That input is **not the only remaining blocker**.
The independent PBX adapter, controller approval wiring, executor first-effect
enforcement, attended full-function calls and final-release soak still require
implementation/deployment evidence. No new hardware requirement is established
by this work.
