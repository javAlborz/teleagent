# Personal-session conversation architecture

The MVP lets the owner list, read, and instruct existing Codex/Claude sessions
through the working SIP phone path. Conversation should retain context across
ordinary follow-ups. The controller remains responsible for enrollment, native
identity, permissions, durable delivery, and operation-bound replies.

## Decision

Use GPT-6 Luna medium for typed session decisions and exact conversational text.
Keep the existing Realtime mini connection for speech and audio lifecycle. Do not
migrate the media stack to GPT-Live in this release.

GPT-Live is a reasonable later frontend: its client-delegation mode supports an
application-owned reasoning backend. It still requires the application to retain
context and enforce actions, and changes speech/playback events. It has not been
benchmarked here. The present failure was conversation interpretation, and the
working phone transport need not change to correct it. See the official
[delegation guide](https://developers.openai.com/api/docs/guides/live-delegation)
and [migration guide](https://developers.openai.com/api/docs/guides/live-migration).

The separation also avoids making the voice model independently reinterpret the
text model's answer. Next-step answers can present an exact draft; a subsequent
“send that” refers to that application record. A missing draft or message asks
for content instead of forwarding a trailing word. See
[the runtime contract](OPENAI-REALTIME.md#personal-session-conversation-decisions).

## Evaluation on 2026-10-07

The first deployed call exposed a configuration gap: the probes below forced
managed execution unavailable, while authenticated production health reported
both managed and personal-session capabilities available. The old mode inference
therefore selected the managed router, not Luna. Those probes did not establish
the production decision path.

Conversation mode now comes explicitly from authenticated owner-plane health
and survives the capability snapshot used by call construction. Managed executor
readiness remains truthful and cannot change the personal prompt, flat schema or
default decision backend. A call-start `realtime_conversation_configured` audit
records the chosen mode, transport and model without credentials or content.
Integration checks must exercise health derivation, snapshot, call construction
and default backend together, including a healthy managed executor and emergency
locks. Model/audio probes must use that same health-derived configuration with
only native delivery and media peers simulated.

### Temporary unavailability and recovery

The October 22 call exposed a second selection failure: unavailable native health
omitted its configured delivery policy, so the voice snapshot discarded the
personal-session mode and selected the managed read-only conversation. The empty
managed-session list then gave a misleading answer about existing personal
sessions. Host pressure was observed just before the call; its exact initial
health failure was not retained and must not be inferred as proven.

Extensions 7/77 now keep the personal-session conversation regardless of initial
readiness. Controller health retains its configured native policy while withdrawing
availability, and emits only a bounded failure code. Conversation selection does
not grant authority. Invalid health, emergency locks and failed admission continue
to prevent owner tools and delivery.

Each new caller turn performs one bounded readiness refresh before its decision.
Unavailable turns receive a fixed temporary-unavailability response, without a
model decision, empty-inventory claim, managed-session substitution or instruction.
Recovery does not replay a failed request: a new caller turn is required. An
interruption or hangup during the refresh fences late results. Tool dispatch
still independently checks current readiness. The call audit records sanitized
availability and failure codes, never raw health bodies, credentials or exception
messages. Regression coverage includes actual call construction, failed-start
recovery in the same client, late checks and unchanged delivery gates.

Replay the failed call's contextual shortening, referenced step and literal
single-word sends. A clarification referring to earlier content is not itself a
message to forward. A presented next-step draft retains the recipient's complete
instruction, including “Reply exactly,” separately from phone readback requests.

These are bounded engineering probes, not statistical performance guarantees.
The initial 25 cases included failed-call phrasing, contextual summaries,
referential sends, exact questions, negation, target corrections, history
ordinals, delivery versus reply reads, reminders, presence, and goodbye.

| Candidate | Exact routing cases passed | Observation |
| --- | ---: | --- |
| Realtime mini, argument-string schema | 15/25 | Missing provenance and message extraction mistakes |
| Realtime mini, flat typed schema | 18/25 | Continued extraction, reminder and ordinal failures |
| Realtime full, low reasoning | 21/25 | Some unnecessary drafts and missed reply reads |
| Realtime full, medium reasoning | 22/25 | One short reply follow-up became a synthetic send |
| GPT-6 Luna, medium reasoning | 24/25 | Remaining inferred message was refused by the application |

Prompts and validation evolved during these diagnostic runs, so the table is not
an isolated model-only comparison. Failed evidence was retained; no failed run
was used to authorize a release.

The production decision adapter then passed 35/35 observable outcomes across the
original cases plus additional phrasing: 34 exact model routes and one safe
application clarification. Median decision latency was 1,413 ms; maximum was
7,122 ms in that run. The test used the real API and production decision/dispatch
code with simulated session actions.

A subsequent multi-turn audio test passed contextual next-step explanation,
interruption, a send referring to the message just presented, a short reply
follow-up without another send, completion readback, a separate delivery check,
and goodbye after audio drained. It used actual generated caller audio,
transcription, semantic VAD, Luna decisions, Realtime speech and application audio
framing. The single simulated delivery contained the intended complete message,
not a trailing connective. SIP and the native session backend were simulated.

All probes ran serially within host resource bounds. Live approval, delivery,
attestation, and phone-session counts were unchanged by the probes. Raw call audio
was not saved. Protected release validation and current live verification remain
separate obligations; these results alone are not handset acceptance.

## Durable plans for multiple personal sessions

### Missing names and target corrections

The October 23 call named Charlie, which was not an enrolled agent, and then
changed the target to phone A. Repeated generic target questions lost the useful
distinction between an unknown name and a missing name. Separately, native
discovery had retained a stale Codex worker identity after connecting to the
daemon supervisor's control socket instead of its live WebSocket worker.

Named requests now reach the live application lookup even when a name is absent
from the startup hint. An unknown target is named in the response, the message
stays unsent, and its exact text remains in the task journal. A subsequent target
correction can reference that text with fresh caller authorization. Replaced
unsent tasks are marked superseded, including when their destination changes;
their old references cannot replay delivery. Status questions never authorize a
send, and uncertain delivery remains uncertain rather than being reported unsent.

The call audit records bounded clarification reasons and requested labels, plus
whether startup inventory was available. It does not add message bodies or raw
native diagnostics. Host discovery separately distinguishes the worker listener
by its executable, arguments and owned socket inode. It preserves org-session
exclusions when an existing frontend executable has been replaced on disk.

Eleven real Responses decision scenarios passed on October 23, covering unknown
names, unclear replies, target corrections, status questions, stale identity,
explicit retry after recovery and goodbye. Production task persistence and
duplicate fencing also have offline regression coverage. Native delivery was
simulated inside an isolated network namespace; live delivery, approval,
attestation and call counters were unchanged. These checks do not establish SIP,
speech playback or handset acceptance.

A routed caller turn can contain an ordered plan with separate tasks for each
session. The app records the complete plan before dispatch, executes serially,
and retains delivery and work status separately. The model uses session names
for latest results and short application task references for earlier requests;
the app resolves controller receipt IDs. A result after a send in the same plan
binds that new send. A failed or unstarted send cannot fall back to an old greeting.

Phone-thread state persists selected sessions, named groups, message references
and task outcomes in SQLite with compare-and-swap revisions. Resume never replays
instructions. Interruption fences unstarted tasks; a fresh caller request can
continue them without repeating accepted or uncertain deliveries. Lost responses
retain preallocated operation IDs for status reconciliation. Readback watches use
one serial scheduler and never start an agent or resend an instruction.

Exact dictation retains the original caller bytes. Natural delegation can compose
a faithful instruction, bound to a current caller authorization excerpt. Reusing
a task message also requires current caller authorization. Native output, older
conversation and saved task state provide context, never independent authority.
The existing native permission, enrollment, identity and emergency gates remain
in charge of every delivery. Managed execution remains read-only.

The bounded task journal retains unfinished work; terminal snapshots are collected
first. This is an application-state/resource bound, not a daily usage allowance.
The phone still cannot answer native approval requests or promise live token
streaming. Native replies and terminal failure states can report progress and
blockers; absence of a reply does not prove either completion or a specific blocker.

Cross-host session enrollment is a separate deployment boundary. Its first target
must be selected and its local broker/identity checks installed before the phone
can advertise those sessions. It must preserve host-qualified names and exact
native identity, keep transport credentials outside voice, and never accept a
model-selected SSH destination. The present catalog and broker remain local to
Hermes. New-session creation, a dashboard and media replacement are deferred.

### Candidate evidence, October 10

The focused production-path suite passed 199 tests. A 12-turn real Responses
conversation passed group creation, three-target sends/reads, delivery checks,
message references, natural delegation, phone-thread reload, a failed target,
quoted-output handling and goodbye. Its native backend and SIP/audio peers were
simulated; live delivery, approval, attestation and call counts did not change.
Two earlier diagnostic runs are preserved: a copied long receipt became invalid,
and a send-then-read plan exposed a missing intra-plan dependency. The final
implementation resolves latest receipts internally and binds reads within plans.
This evidence does not replace signed deployment or physical handset acceptance.
