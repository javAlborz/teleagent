# Phone delivery work — 2026-09-19

The owner requested fast-tracked delivery of a fully functional phone setup.
This work continues from `37d3353` in a clean application worktree and from
current homelab main plus the missing `69637fd5` worker-contract change in a
separate infrastructure worktree. The live dirty application tree is preserved.

## Acceptance case from the latest call

The September 19 call at 08:45 UTC attempted `list_directory`. The deployed
baseline recorded `TOOL_ERROR`, with no job or approval. A separate read-only
controller probe returned `VOICE_CONTROL_AUTH_NOT_CONFIGURED`.

The candidate already has authenticated per-capability readiness checks.
This follow-up adds an awaited dispatch boundary so an inspection rejection
after a successful readiness probe keeps its specific code. Inspection errors
use bounded fixed explanations rather than raw controller/transport messages.
The desired real acceptance remains listing an explicitly approved useful
workspace, completing a scoped provider task, and hearing its verified result.

## Delivery tracking

| Work | Source | Independent review | Installed | Real acceptance |
| --- | --- | --- | --- | --- |
| Existing cancellation/global-admission corrections | September 10 checkpoint | Historical exact-source review | No | No |
| Privileged lifecycle coordination | Candidate implemented; cross-repository integration under validation | Pending | No | Disposable systemd identity/credential probe passed; full release commissioning pending |
| Specific truthful inspection failure | Candidate implemented | Pending | No | Latest real call retained as acceptance case |
| Receiver-safe media/controller transport | Remaining | Pending | No | No |
| Aggregate resource and bounded storage profile | Remaining | Pending | No | No |
| Real PBX adapter and approval/first-effect integration | Remaining | Pending | No | No |
| Trusted release, crash-safe activation and fresh rollback | Remaining | Pending | No | No |
| Attended feature matrix and final five-hour trial | After commissioning | Pending | No | No |

The private lifecycle design and its exact boundaries are documented in the
companion homelab `docs/TELEAGENT_LIFECYCLE_COORDINATOR.md`. Application startup
units, installers, root helper metadata checks, and release assertions move
together. Updated candidate pins are build inputs; they are not independent
host activation approval.

Pending owner input: exact useful workspace/session scope, Anthropic/OpenAI
project selection and daily spending limits, and permission to start a separate
independent review agent. These questions do not block ordinary implementation.
Hermes reboot remains deferred, and the live execution lock remains set until
an actual reviewed activation procedure is ready.

## Fast-track delivery order

1. **Select the first useful task and its scope.** Obtain the exact project
   directory, provider projects and spending bounds. Start with managed read-only
   work, one provider job globally, and a project summary or inspection whose
   result the owner can check. Prepare an isolated workspace copy after scope
   selection; do not substitute an empty fixture for useful project access.
2. **Finish the shared-host profile and release.** Independently review this
   lifecycle change, implement the protected controller transport and separate
   media receiver namespaces, then commission bounded durable filesystems and
   aggregate resource admission with recovery reserve. Current live free space
   or the sum of individual service limits is insufficient evidence. Finish the
   independent immutable release and crash-resumable selection/rollback path.
   The current dedicated-staging installer and non-promotable CI output cannot
   be relabeled as the Hermes evaluation profile.
3. **Deliver an attended useful call.** After disabled installation and negative
   boundary checks, deploy matched voice/controller versions with fresh rollback
   capture and a bounded phone interruption. Verify project inspection, a real
   provider task, spoken verified result, cancellation, resume, duplicate
   handling and restart uncertainty on the selected release.
4. **Complete approved actions and full acceptance.** Wire the independent
   Asterisk approval observer to canonical prompt completion and handset DTMF,
   controller issuance and executor first-effect enforcement. Verify replay,
   wrong-leg and interrupted-call rejection. Finish the final five-hour trial,
   explicit rollback and stop/start recovery. Keep reboot validation recorded
   as deferred. Native public SIP and existing owner sessions are separate
   choices and need not expand this first delivery milestone.

The current Hephaestus VM-backed build lane is still documented as low-trust,
persistent CI. It can supply build evidence; moving work there does not satisfy
the separate trusted ephemeral attestation requirement.

## Validation and review notes

- Full controller and voice suites: **810/810 passed**, no skipped or canceled
  tests, in 212.7 seconds, with peak cgroup charge 128,872,448 bytes.
- Host installation, refusal, rollback and lifecycle coverage: **81/81 passed**
  in 533.8 seconds, with peak cgroup charge 64,532,480 bytes.
- Release-contract tests: **39/39 passed**. The 42 current helper, installer and
  systemd file pins, verifier self-policy digest and installer verifier pins
  were also checked directly across both worktrees.
- Native SIP deployment/startup tests: **15/15 passed**, including real repeated
  SIGTERM delivery while graceful shutdown is pending. Signal handlers now
  remain installed so cgroup stop plus supervisor forwarding cannot bypass the
  bounded shutdown. This does not activate native SIP.
- Repository lint and the native SIP package lint passed. Both worktrees pass
  `git diff --check`.
- A disposable systemd probe passed with the existing controller identity,
  dummy credentials, private network and bounded resources. No probe units or
  runtime directories remained afterward. See the companion lifecycle document
  for the exact proof and remaining commissioning checks.

The first broad application run exposed stale controller installation pins;
those were corrected. Several fixture-agent failures were caused by a cleared
test PATH omitting Node, so the test runner now includes the selected Node 24
binary directory. One unchanged SQLite singleton contention test refused both
simultaneous initializers once; neither reached protected work. Eight subsequent
isolated retries and the complete application rerun passed. Preserve that
observation for review rather than treating retries as proof that every startup
schedule succeeds.

All ordinary test processes use the shared serial test wrapper with 512 MiB
memory, no swap, 128 tasks and one CPU. Temporary dependency links reuse exact
matching lockfiles for source QA only; they are not production build inputs.
No provider job, real approval, release promotion, execution unlock or phone
cutover has been performed by this change.
