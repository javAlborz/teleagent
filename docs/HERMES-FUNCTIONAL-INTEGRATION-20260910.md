# Functional integration checkpoint — 2026-09-10

Status: independently reviewed and automatically validated source checkpoint;
not deployed and not full functionality. The September 8 checkpoint remains the base.
The current phone baseline is healthy and panic-locked. No reboot, service or
route change, credential provisioning, owner-session access, or purchase took
place during this work.

## Independent review and cancellation corrections

The owner approved using the existing independent reviewer on September 10.
The first review was NO-GO for the call-lifecycle checkpoint: a late cancel
could select a later task in the same call, its delayed media break could
interrupt result audio, and star was ignored during thinking feedback. The
PBX runtime slice had no concrete blocker; Hermes activation remained a
separate NO-GO. This review does not grant owner-session access.

Eight focused reproductions failed before the corrections and passed after:

- The legacy client now sends explicit `scope: "task"`. The controller rejects
  invalid scopes, missing/invalid task keys, and task-scoped session reset
  before effects. It does not call the whole-call active-request cancellation
  bucket. The dispatcher/store cancel only the exact call/key pair and retain
  the same atomic cancel-before-submit reservation. Default call-wide semantics
  remain available to existing lifecycle callers; panic behavior is unchanged.
- The media break is sent when cancellation is requested, never after the
  delayed HTTP response. The request captures its own turn key.
- Star during thinking TTS or playback prevents submission entirely. This
  local-only stop does not claim a remote task was canceled.

The broader focused selection passed 15/15, including the HTTP route with a
synthetic fixture-owned lease, cancellation reservations across database reopen,
delayed success/failure responses, and PBX crash boundaries. The PBX child now
writes a fixed boundary marker synchronously before its self-SIGKILL; the parent
requires that marker as well as the signal and recovered state.

Deploy these voice/controller changes only as one reviewed release. An older
controller ignores the scope field and is not a safe mixed-version target.
Current-hash full regression passed: controller **292/292** (154.03 seconds),
voice **460/460** (48.94 seconds), release/CI contracts **39/39** (1.73 seconds).
That is **791 distinct tests**, superseding the overlapping 782-test checkpoint
below. All 15 changed JavaScript files passed lint; shell syntax and diff checks
passed. The single serial batch verified its own 512 MiB, zero-swap, 128-task,
one-core limits and recorded a peak of 120,131,584 charged bytes, not process
RSS. The temporary dependency links have been removed, leaving their target
directories untouched; no QA process remains. The second independent review
gave **source GO** for the exact revised runtime/test hashes: all three reported
lifecycle blockers are closed, and the PBX kill-attribution improvement passed
review. Hermes deployment remains separately **NO-GO**. No image, live deployment,
service restart, or execution unlock has occurred. A post-QA live check again
found all three containers running with zero restarts, execution locked, and
zero Asterisk calls/channels.

Revised runtime/test hashes (the PBX runtime and job-broker files are unchanged):

```text
claude-api-server/server.js
  632c0b186ddf33c388a44a46d79916a8dfcd6f7c0a3ac1bd5f4f7014c61b7cef
claude-api-server/executor-task-store.js
  24028a4b91563b27a5659b20d21b3aed11b746a29bf968f4b3bb54b89813313b
claude-api-server/executor-task-dispatcher.js
  ef179c8cbf9cb2e06c66719e24077ec33fcc8a64463478d058bad19e716022b7
claude-api-server/test/executor-task-store.test.js
  ac91fc4c84d6d10068e94e159da0f10c3f435c6a6d0a9da22a90b4c7b67e2ca4
claude-api-server/test/scoped-auth.integration.test.js
  f2a9d2fd80a13538b3a5d9e7a565c4c39344309e39177e85f586800a1974acff
voice-app/lib/conversation-loop.js
  7f1b4880baac4699e152629e0d4ad1d2d4b203704fb08b52876691401059a728
voice-app/lib/claude-bridge.js
  892fb391c7c393b54b91a4f50eac8add1d9a5f455517c5b115fc0820c9619c4e
voice-app/test/claude-bridge.test.js
  997d2466e7979539ee912ca12b30379d37dc2f35f3fa4d1b545ebc141d8278e6
voice-app/test/conversation-loop-lifecycle.test.js
  79f1a6cf6171a736da822d4731400617343950654c43b0c0e637f258e86bfe56
voice-app/test/pbx-approval-attester.test.js
  f69db509daef4c500188d8d2cb4434459b113095b31e568f48e33e0e8da032bc
voice-app/test/fixtures/pbx-supersession-crash-child.js
  37f245ecc3853b0533bac6139621b2355fc27fb013de7bc2ecf599891e2d9e61
```

## Earlier call-lifecycle checkpoint and completion gates

The owner subsequently asked to proceed with all seven readiness gates, keeping
the explicitly deferred reboot. A fresh check at `2026-09-10T16:47Z` found the
same healthy voice/media container IDs, zero restarts, a locked execution plane,
and zero Asterisk calls/channels. No live deployment has occurred in this
follow-up either. Review permission was requested at that stage and was
subsequently granted explicitly, as recorded above. Owner-session scope approval
is not inferred from a preselected answer.

Source inspection and executable legacy-call reproductions identified additional
functional defects:

- Identical questions in separate turns reused the old request-hash idempotency
  key and could return a stale result. Each legacy turn now has an explicit
  call/session/profile/turn-bound key. Retries and star cancellation use that
  same key; a later turn gets a different one. Realtime job IDs are unchanged.
- Hangup during thinking TTS generation or playback could still submit a task.
  The loop now rechecks the call before proceeding to agent submission.
- Legacy star handling unconditionally spoke `Stopped.` and discarded a
  successful result that won the cancellation race. It now distinguishes a
  confirmed cancellation, an unconfirmed request, an unknown execution outcome,
  and a verified result. Acceptance of the cancel HTTP request is not treated as
  proof of quiescence.
- An aborted local executor poll returned the same code as a canceled remote
  task. It now returns `EXECUTOR_WAIT_ABORTED` with task identity and an explicit
  reconciliation requirement. The voice job broker keeps that work nonterminal
  instead of recording a false cancellation or failure. Known terminal results
  retain their actual outcome.

The new reproductions failed before these changes (11 failures in the focused
15-test selection); the full bridge/lifecycle pair then passed 30/30. A separate
broker regression verifies the durable `reconciling` state. Final sequential
regression passed **288/288 controller tests** (156.64 seconds) and **455/455
voice tests** (48.00 seconds), including the 14 added tests. Changed JavaScript
lint, shell syntax and diff checks passed in the same capped invocation, whose
in-unit cgroup peak was 118,841,344 charged bytes. These are 743 distinct tests,
not 743 additional tests on top of the earlier overlapping suites. No fake
provider result counts as a real provider or handset canary.

The 39 release/CI/supply-chain contract tests subsequently passed in 1.85
seconds, bringing this follow-up's non-overlapping total to **782**. The earlier
host handoff result is retained separately and was not rerun or added again.
All follow-up QA units have exited. The temporary development dependency links
were removed after validation; their original dependency directories were
neither edited nor deleted. Recreate only those exact development links (or use
a clean package-local install) for tests whose child processes clear their
environment; `NODE_PATH` alone is insufficient for that subprocess case.

Initial follow-up review hashes, superseded where listed above:

```text
voice-app/lib/agent-job-broker.js
  c8f8fc41959f356f80ce7383d4f9cde8a9f78fbe509928914bea3cbd338c169c
voice-app/lib/claude-bridge.js
  48445ceb3e05a215c7d0378050b10a13b459ae669d1de4652c555dd39f369c04
voice-app/lib/conversation-loop.js
  cd06bdfdc987e446d6c120cf2d3a782a086ae2ea4701913ba83792934cb17b90
voice-app/test/agent-job-broker.test.js
  eee9f91c261a0618ffdab0ff655345592589623fd6457409bc05eb9d9827a8c3
voice-app/test/claude-bridge.test.js
  c8a5a5d68235fc005e2f311b3251e53ae3a33ff7e63fae415bbefcd1d3766695
voice-app/test/conversation-loop-lifecycle.test.js
  d69f0002b570103e4557caf389b5bada1c874231a22865426b2cc0f21660abb8
scripts/hermes-safe-test
  318e371b72aacc2c6f23cbcb129fb4a5b770e7c972dc997d591d9c217bfa6e97
```

The PBX runtime hashes below remain unchanged; the crash-test files have since
been strengthened. Final validation and current-hash source review passed, as
recorded above; deployment and activation are not approved by that result.
The new independent review and its corrections are recorded above; the older
evaluation-closure GO is not reused. No new image, deployment, provider
credential, approval sentinel, phone call, or reboot was performed.

The canonical test wrapper now enforces the owner's stricter 512 MiB, zero swap,
128-task, one-core limits while preserving its cross-worktree serialization
lock. The earlier full controller attempt passed 287/288: the one subprocess
deliberately erased `NODE_PATH`, so it could not find the shared development
SQLite dependency. No controller code or assertion was relaxed. Temporary local
dependency links to the previous checkout with identical package lock hashes
restore the normal package-local resolution; the affected subprocess test
passed unchanged. These links are development-only and must not enter a release.

### Explicit completion contract

These are the seven agreed gates, not completed milestones inferred from test
counts:

| Gate | Current state | Evidence still needed |
| --- | --- | --- |
| 1. Reviewed, reproducible deployment | Source review/regression passed; deployment incomplete | Authenticated artifact build/selection and fresh coordinated deployment/rollback record; the existing CI evidence is explicitly non-promotable |
| 2. Hermes isolation | Design/approval open; existing owner controller is NO-GO | Reviewed host-policy replacement with actual identities, storage/resource admission, receiver isolation and shared-lock enforcement; do not bypass the dedicated-host gate |
| 3. Useful phone agent operation | Component and fake-provider integration checks only | Real scoped inspection and read-only jobs, results, cancellation and permitted-session selection on the approved boundary |
| 4. Handset-approved changes | Core integration still unimplemented | Actual independent PBX adapter, controller arm/evidence wiring, executor/broker first-effect consumption and revocation; no phone-held signer or broad bearer |
| 5. Attended functional validation | Not run against this release | Positive/negative phone calls, audio/interruption checks, exact approval/cancellation outcomes and disconnect/recovery cases |
| 6. Operational validation | Earlier baseline trial is complete, not proof for this release | Final-version soak, service stop/start, state recovery and fresh controlled rollback; no replay of the September 7 transaction |
| 7. Reboot validation | Explicitly deferred by owner | A later authorized reboot with console recovery available; never mark it passed from service restarts |

The first useful activation is **read-only**. It must pass its deployment and
isolation checks but does not require granting mutation authority. Access to
existing owner sessions is a separate scope decision, not a prerequisite for
dedicated phone workspaces. The actual PBX/controller/executor integration is
engineering work still outstanding, not something user availability or a review
approval alone completes. No purchase is inferred or presently justified by
measured hardware capacity.

## Worktrees and preserved state

- Application: `/home/alborz/dev2/teleagent-hermes-functional-integration-20260910`,
  branch `fix/hermes-functional-integration-20260910`, base `6a5d097`.
- Host assessment: `/home/alborz/dev2/homelab-teleagent-hermes-assessment-20260910`,
  branch `fix/teleagent-hermes-assessment-20260910`, base `f0d00128` from freshly
  fetched homelab main. The assessment and docs index do not alter host policy.
- The earlier application `6a5d097` and host contract `69637fd5` worktrees are
  preserved. The old live tree under `/home/alborz/phone/teleagent` is untouched.
- The completed September 7 trial and rollback transaction are not reusable.

## Implemented approval-retry transition

The dormant PBX attester now accepts an explicitly signed replacement of an
already claimed pending/observed arm. It independently verifies the old and new
controller artifacts, preserves the exact approval/job/request/plan/prompt,
target and provider/profile, requires the same signing epoch, disallows deadline
extension, and requires fresh call and nonce identities. A fresh clock check
after durable publication prevents a slow commit from initiating an expired or
not-yet-valid call.

One SQLite immediate transaction invalidates the old arm and claims the new
one. Old identities remain replay tombstones. Late old-call observations and
evidence finalization fail. A conflicting replacement restores the unchanged
original state. Issued attempts cannot be replaced. A caller-owned outer
transaction cannot make uncommitted work look durable; failed rollback poisons
the store object. Ambiguous publication never authorizes a call retry.

The schema's one-active-approval index is exact and includes issued attempts.
The new schema refuses old or weakened tables instead of automatically migrating
them. No live database was opened through this constructor or changed.

This completes one missing state transition, not the Asterisk adapter, controller
authority, or execution integration. It does not cancel an already-started PBX
call, originate a new call, or make a phone approval authoritative in production.
See [the detailed approval contract](PBX-APPROVAL-ATTESTATION-CONTRACT.md).

## Earlier validation: approval-retry checkpoint

Tests use generated keys, synthetic approvals, fake PBX adapters, and temporary
SQLite databases. Real SIGKILL tests kill only their own fixture subprocesses
after each replacement mutation and immediately after commit; parent tests
reopen the WAL database and check exact states, replay refusal, and integrity.
Watchdog timeouts cannot count as injected-kill passes.

- Final full voice suite: **441/441 passed**, 71.59 seconds. This includes the
  **56 PBX attester tests/subtests**, not an additional independent 56 tests.
- Scoped HTTP auth, worker-session service and proxy: **32/32 passed**, 10.70 seconds.
- Application release/CI/supply-chain contracts: **39/39 passed**, 3.70 seconds.
- Changed JavaScript lint and application diff check: passed.
- Full 69-test host handoff suite against the unchanged corrected September 8
  companion checkout: **69/69 passed**, 508.02 seconds. This closes the earlier
  incomplete full-suite rerun; the verifier and harness were unchanged during
  this run. It does not establish a real-host deployment or hardware crash proof.
- Host assessment docs/governance validation: passed. Initial checks identified a
  missing docs-index link and group-write permissions from the new checkout
  umask. The index link was added and only this newly created assessment
  worktree's tracked permissions were normalized before the successful rerun.

That is **581 non-overlapping tests** across these four suites. Earlier 436-test
voice and 21-test API runs also passed but are not added again. The final
sequential voice/API/release/lint/docs batch completed in 96.39 seconds. Its
in-unit cgroup measurement reported a peak of 77,201,408 charged bytes. The task's
test services have finished; no test process is intentionally left running.

The test units use MemoryMax=512M, MemorySwapMax=0, TasksMax=128, CPUQuota=100%,
bounded runtime and control-group cleanup. The API/release batch verified those
limits from its own cgroup before testing; the final batch repeated that proof.
Voice, API/release, and host behavioral suites ran sequentially. Dependencies
were reused read-only from the preceding functional worktree with the identical
voice lockfile; no dependency version, provider login, or live environment file
was changed. Post-exit systemd memory-peak summaries are not used as a measured
application RSS claim.

Earlier PBX review hashes (runtime unchanged; crash-test hashes superseded above):

```text
lib/pbx-approval-attester-store.js
  ee4dfe88f35de6927f1e0547190802d970c7ff63e87ac4c6e8ec1942cb4547a2
lib/pbx-approval-attester.js
  c3c1b8c127e2657a4cbd05aaeea1887fdfdbc17f8914d1487f28fd809d4edba6
voice-app/test/pbx-approval-attester.test.js
  772f36e547a2d8b8b810fd3cfb9176bcd5d889e11184465487ab844f236da611
voice-app/test/fixtures/pbx-supersession-crash-child.js
  7128d653f81062611e89799d9172b6365c455536955e452e23ba83106ce17a18
```

Host companion verifier hash:
`bfd0661ea386ef693749a5d3f2f3c984a8a00118d083fcae4bd326ca1d4722cf`.
Host companion full-suite harness hash:
`3b634c220676c6cca6412f995570b7b1d807bda42f595efbce8baa93a83b6336`.

## PBX findings and adapter planning boundary

Read-only checks found Asterisk 20.6.0, ARI modules loaded but its HTTP server
disabled, and AMI enabled only on loopback port 5038. Endpoint 1001 reports
`dtmf_mode=rfc4733`; it had no listed contact at the check. That is not a reason
to change registration state or place an unattended canary.

The official [Asterisk 20 DTMFEnd event contract](https://docs.asterisk.org/Asterisk_20_Documentation/API_Documentation/AMI_Events/DTMFEnd/)
provides channel/linked IDs, digit, duration, and received-versus-sent direction.
Those fields alone do not prove prompt completion or establish the caller's
authority. [ARI playback documentation](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-REST-Interface-ARI/Introduction-to-ARI-and-Channels/ARI-and-Channels-Simple-Media-Manipulation/)
describes correlated playback completion events; using ARI on this host would
require a separately reviewed PBX control endpoint and call-control route. No
AMI credential was displayed or used, and ARI was not enabled.

## Remaining gates and user choices

The Hermes assessment found a legacy controller running in the owner's account
without the new service hardening, plus a near-soft-limit owner resource pool.
There is no established hardware purchase requirement, but no safe activation
proof for that controller either. The assessment lists the identity, storage,
network receiver, resource-admission, and shared-lock changes needed before a
Hermes-specific deployment policy could be approved. The current dedicated-host
gate remains unchanged.

The exact owner-session inspection scope remains outstanding, so no owner
bridge is added. Permission to use the existing independent reviewer was
explicitly granted; the corrected current-hash source review passed. That source
checkpoint is not an artifact selection, deployment, or live authority grant.

Still required: complete the real PBX adapter/call quiescence, controller
authority and executor/broker first-effect integration, choose and validate the
deployment boundary, perform independently reviewed installation/activation,
run attended functional canaries, then cut over with fresh rollback evidence.
Hermes's reboot remains explicitly deferred and reboot recovery is not a pass.
