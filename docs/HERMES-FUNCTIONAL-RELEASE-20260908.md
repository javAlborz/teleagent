# Functional release checkpoint — 2026-09-08

Status: implementation and automated validation only. Not deployed, not an
all-features release, and not a replacement for the completed trial evidence.
Hermes reboot remains deferred. Execution remains panic-locked.

## User-visible defect and change

The September 8 call's `list_runtime_sessions` failed because the restored old
voice baseline contacted an operator route without configured scoped auth. It
discarded locally available saved-session records when that dependency failed.
No agent work ran. The temporary compatibility candidate had a local fallback,
but the five-hour trial correctly rolled that candidate back at its deadline.

The new implementation carries the fix forward onto the hardened source base:

- Probe authenticated `/operator/health` and independently `/executor/health`.
  Never use public readiness, a general bearer, a POST, a redirect, environment
  proxying, or an unlock as an availability proof. Probes have 1.5-second timeouts
  and 32-KiB response bounds; unknown/legacy/unsafe health fails closed.
- Filter the routing enum to verified capabilities and provide the actual JSON
  argument schemas, not just action names. Check direct calls too. Recheck
  readiness immediately before each remote action; server authorization still
  owns the effect boundary. Missing capabilities do not disable local tools.
- Return saved managed-session records even if worker inspection is unavailable
  or fails after a successful probe. Mark unavailable sections explicitly; do
  not present them as empty live lists or saved records as running processes.
- Share the current worker's exact inspection allowlist with voice routing.
  A healthy worker does not imply host/cluster or provider-history access.
  Keep targeted delivery and privileged actions unavailable independently of
  readiness. Scope worker results to `teleagent-worker`, never all Hermes tmux.
- Preserve a discovered stable pane identity on subsequent pane reads.
- Use the actual worker `output` field for explicit context adoption, label it
  untrusted reference data, and refuse missing stable capture evidence before
  creating a job. The legacy `content` lookup would otherwise send `undefined`.
- Include tmux terminology without needing an authenticated dynamic lookup.
  Exclude forbidden keyword characters, keep static hints ahead of configured
  hints, and do not perform dynamic inspection when the controller is absent.
- Close media without opening a provider connection if the handset hangs up
  during the new bounded startup probes.

The schema/hint changes follow the official [Realtime function-calling guide](https://developers.openai.com/api/docs/guides/realtime-conversations#function-calling)
and [transcription context contract](https://developers.openai.com/api/docs/guides/realtime-transcription#add-transcription-context).
Keyword hints are not proof of accurate recognition. A real attended call must
still verify the words, speech timing, interruption behavior, and two-way audio.
No model, voice, VAD policy, or speech-to-speech transport was changed here.

## Actual feature boundaries

| Feature | This checkpoint | Remaining activation/implementation requirement |
| --- | --- | --- |
| Voice conversation, local history/usage/preferences | Existing behavior retained; session fallback fixed in source | Fresh voice release and attended 7/77 canaries |
| Worker file/Git/tmux inspection | Routed only after scoped health and exact worker-contract checks | Dedicated staging worker/controller and credentials |
| Fresh read-only managed jobs | Separate executor-scope proof before routing | Real isolated provider canary and explicit unlock after review |
| Existing owner Hermes sessions/history | Not exposed by the worker | Owner scope decision and a separately reviewed read-only access path |
| Mutation, targeted delivery, privileged work | Still unavailable | Independent PBX adapter, controller authority, first-effect capability integration and real negative/positive call tests |

The last row is unfinished implementation, not a credential toggle. See
[the PBX approval contract](PBX-APPROVAL-ATTESTATION-CONTRACT.md). This checkpoint
does not claim that those features have been completed.

## Validation and provenance

Application branch: `fix/hermes-functional-release-20260908`, base `05a0086`.
Companion homelab branch: `fix/teleagent-functional-contract-20260908`, base
`5a4fd95a`. The new shared module must be present in both independently defined
host release closures. The companion change updates source-policy and verifier
pins; it is not installed and invalidates no live gate.

Automated tests use generated fixture credentials, temporary/in-memory state,
fake Realtime/provider responses, and bounded local test servers. They do not
access the live phone database, owner tmux socket, provider credentials, or make
paid calls. Tests run sequentially under MemoryMax=512M, MemorySwapMax=0,
TasksMax=128, CPUQuota=100%. The cap was also asserted from the test process's
own cgroup before the full run.

- Final full voice tests: 399/399 passed (46.84 seconds).
- Focused worker broker/service and scoped-controller auth tests: 32/32 passed
  (6.38 seconds).
- Changed JavaScript lint and `git diff --check`: passed.
- Application release/CI/supply-chain contract tests: 39/39 passed (1.64 seconds).
- Host handoff full run: 68/69 passed (519.22 seconds). The only failure was the
  old literal 131-path count after adding the new shared module. The count and
  test name were updated to 132 and the affected test passed on rerun (0.07
  seconds). Runtime verifier/launcher bytes did not change after the full run;
  a new full host-suite pass against the final test-file hash is not claimed.
- Application/host source-closure equality (132 paths), embedded verifier pin,
  shell syntax, and both worktrees' diff checks: passed.
- Independent current-hash review and live call canaries: not performed.

The initial broad run passed 395/397: two source metadata tests rejected the new
checkout's group-write umask. Only this newly created worktree's tracked modes
were normalized to 0644/0755; the repeated full run passed. An earlier focused
test had an `undefined` versus `null` fixture expectation; corrected and covered
by the full run. Neither failure was treated as a pass.

The final sequential batch (399 voice + 32 worker/auth + 39 application release
tests + the corrected host test, plus lint) completed successfully in 58.50
seconds. No provider, phone, or live-host activation test was performed.

## Next gate

The home runbook's dedicated staging handoff expressly forbids activation of
the new controller/worker architecture on Hermes. A separately isolated machine
or VM with its own credentials, state, budgets and PBX route is required; none
is selected. Do not weaken that gate, buy a host, provision a VM, unlock phone
execution, or mount the owner tmux socket by inference from "proceed".

Before any production replacement, review current source hashes, complete the
scoped inspection/agent-work staging proofs, and create fresh rollback and
dependency evidence. Never reuse the completed September 7 transaction. Preserve
the dirty `/home/alborz/phone/teleagent` tree and the retained trial containers.
