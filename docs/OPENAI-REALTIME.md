# OpenAI Realtime Voice Control Plane

Extensions `7` and `77` provide a Zeus-independent, full-duplex voice control
plane on Hermes. OpenAI Realtime owns the live conversation; Claude Code and
Codex remain the agents that inspect and analyze bounded state. Phone mutation,
deployment, existing-session delivery, and administration are disabled.

## Extensions and profiles

| Extension | Behavior |
| --- | --- |
| `7` | Start a fresh durable voice thread |
| `77` | Resume the newest non-expired thread for the same SIP caller |

The conductor can address all six managed profiles:

| Profile | Provider | Production capability | Bridge boundary |
| --- | --- | --- | --- |
| `claude-haiku` | Claude | Read-only | Phone Haiku read tools |
| `claude-sonnet` | Claude | Read-only | Phone Sonnet read tools |
| `claude-opus` | Claude | Read-only | Phone Opus read tools |
| `codex-luna` | Codex | Read-only | `read-only` sandbox |
| `codex-terra` | Codex | Read-only | `read-only` sandbox |
| `codex-sol` | Codex | Read-only | `read-only` sandbox |

When the caller names a profile, the request stays on that model profile. With
`auto`, the broker selects model strength and reasoning effort, never authority.
Codex uses `read-only` regardless of tier, and Claude receives only read tools.
Mutating, target-session, and privileged phone jobs are blocked pending an
independent PBX-attested approval authority.

## State ownership

State is intentionally split into three layers:

1. A voice thread owns the caller identity, selected profile, exact transcript
   events, preferences, jobs, approvals, usage ledger, and callback routing.
2. Each `(voice thread, profile)` pair owns an independent durable Claude or
   Codex provider session. Profiles never share hidden provider context.
3. Each OpenAI Realtime connection is ephemeral. A resumed call creates a new
   Realtime connection and receives bounded local context from the voice
   thread.

SQLite stores text events and operation audit rows append-only. Events are not
pruned to a rolling count; only the small context injected into a new Realtime
session is windowed. Raw audio is never recorded. The default database is
`/app/state/voice-state.sqlite`, backed by `VOICE_STATE_DIR` on Hermes.

The bridge receives an explicit provider session ID when continuing managed
work, so a bridge restart does not silently merge profiles. `fresh_session`
replaces only the named profile's mapping.

## App-owned tool surface

The Realtime model has no raw shell, arbitrary HTTP client, sudo token, or
provider session ID. Its tools are grouped as follows:

- Agent orchestration: send a message, hand off between profiles, list managed
  sessions, list/get jobs, or adopt sanitized tmux context into a managed
  session. Cancellation is intentionally app-owned through DTMF `*`, not a
  model-callable tool.
- Exact local state: read Teleagent phone transcript history, measured Realtime
  usage, and explicitly saved preferences. Phone history is deliberately
  distinct from provider-session history.
  Speaker-filtered quotations also carry the last ten transcript turns from
  both speakers, so recalling a Teleagent answer cannot mistake a caller-only
  selection for missing history. The current request and suppressed fragments
  are excluded from both views.
- Bounded inspection: ask the worker-owned broker to list/find/read files below
  approved worker workspace roots, inspect Git status, list/capture panes on
  the dedicated worker tmux socket, read redacted numbered chunks from the exact
  Codex or Claude provider log attached to a pane, inspect current provider
  task/output activity, and describe the bounded worker runtime. Docker,
  cluster, and root-visible reads would require typed privileged adapters, but
  that phone path is production-disabled.
- Utility actions: current weather and deterministic call termination.

Filesystem inspection resolves real paths, denies credential locations and
secret-like filenames, clips output, blocks binary files, and redacts common
credential forms. Tmux listings are hierarchical: sessions contain windows,
and windows contain panes. Pane capture remains screen visibility or an
explicit text handoff; it is never treated as provider history. The dedicated
history inspector instead maps the pane process tree to one exact open Codex
rollout or resolvable Claude transcript, parses only user/assistant text,
redacts it, and fails closed when the provider log cannot be mapped exactly.
Provider IDs and source filenames are not returned to Realtime. Numbered
chunks carry an app-owned continuation cursor so “next” cannot accidentally
repeat the prior chunk.

## Jobs, dormant approval substrate, and audit

`send_agent_message` returns a durable job ID immediately. One read-only job per
profile may be active in a thread, and independent profiles may run in parallel.

Every request is structurally classified as `read_only`, `mutating`, `high`,
or `privileged`. Informational requests such as “show release history” remain
read-only; an explicit follow-up action such as “then deploy it” does not.

Production voice has no approval issuer or privileged bridge and receives no
signing key or privileged-action bearer. Read-only jobs remain available;
mutating jobs, existing-session delivery, and privileged jobs fail at creation.
The retained state/capability libraries model a dormant future flow in which
only one operation per thread could wait for approval and the caller would hear
its bounded scope once. These controls do not grant production authority:

- `#` would approve only that exact focused job after independent attestation.
- `*` rejects or cancels the focused job.
- Dialing `9` outside the conversation activates the persistent global
  voice-execution lock and kills all voice-originated Claude/Codex work.

The future authority must not trust voice's DTMF or playout events. An isolated
PBX attester must play the controller-canonical prompt, observe handset-side
`#`, and submit durable evidence bound to the job, normalized request SHA-256,
canonical plan hash, exact target/provider/profile, prompt hash, call leg,
event ordering, and expiry. Only the controller-owned authority may validate
and consume that evidence, sign a short-lived capability, and dispatch it
internally. Existing-conversation delivery additionally binds the stable tmux
pane ID and provider-log fingerprint. The executor/root broker still atomically
consume replay state with durable insertion and independently revalidate the
request/plan; signature verification alone is never execution authorization.
Until that authority exists, direct and Realtime calls both fail closed for
mutation. The legacy local approval-state behavior below is retained for unit
validation only and is not accepted as production authorization.

The approval marker is accepted only on the exact AudioFork WebSocket attached
to that call with a fresh one-use 32-byte credential. A pathless or unsolicited
WebSocket cannot create a session, observe a queued marker, or echo an ACK. The
correlated FreeSWITCH/mod_audio_fork `playout` marker proves that the media
server consumed the marked queue position; it is not evidence that the physical
handset rendered or the caller heard the audio.

Request, approval, start, cancellation/emergency stop, completion, and failure
events are written to an append-only operation audit. Direct Realtime tool
completions, spoken-output limiting, suppressed pre-tool speech, empty
transcription observations, suppressed noise/backchannels, and context
truncation/deletion events are also recorded as redacted metadata; tool result
bodies and captured pane/file content are deliberately excluded.

## Conversation behavior

The input uses OpenAI `near_field` noise reduction followed by medium-eagerness
semantic VAD, with automatic response creation and interruption disabled.
Teleagent waits for a completed, substantive transcript and creates exactly one
response itself. Missing or fragmentary transcriptions are ignored quietly.

- Raw VAD starts are provisional and never destroy playout. Recognizable partial
  transcript text
  (an explicit interruption or a substantive phrase) stops active speech early;
  final transcript handling remains the fallback. The app stops playback, discards
  late response audio, and reports its playback-duration estimate with an item
  truncation. Backchannels, fragmentary transcripts, and likely acoustic
  copies of the current assistant response are suppressed. None of these actions
  cancels background agent jobs. Partial text never creates a response or sends
  an instruction. Its arrival depends on transcription timing; there is no
  claim of a fixed interruption latency. Stale/completed-turn deltas are ignored.
- Automatic personal-session readback waits for phone playback to drain, final
  transcription to arrive, and the 250 ms response debounce to finish. It also
  rechecks these conditions after reading the native result.
- Set `OPENAI_REALTIME_VAD_EAGERNESS=low` for more patient turn detection;
  `medium` is the conversational default. These settings do not enable automatic
  tool execution or cancel native work.
- Tool-capable responses are held at the audio boundary until the response is
  known to contain no function call. If one selects a tool, any attempted
  spoken preamble is discarded and only the post-tool answer can reach the
  phone.
- Accepted asynchronous jobs produce one acknowledgement tone and no duplicate
  “started” sentence.
- “Stay quiet until it is done” produces a tone and silence until the
  authoritative completion notice.
- Keyed, prioritized notices replace stale job status before speech and use
  per-response instructions, so completed-job and clarification text does not
  remain as a permanent system item in the conversation.
- Completion notice state is durable. Interrupted or failed announcements are
  retried on the call or the next resumed call and are marked delivered only
  after a completed Realtime response.
- Normal replies target fewer than 25 words. The 35-word setting remains an
  advisory/telemetry threshold, while a separate 240-word absolute guard stops
  only genuinely runaway output. A limit lets already-generated audio drain;
  it never sends `killAudio` or conversation truncation. Completed audio is
  also not killed after it has drained. Those destructive playout actions are
  reserved for a substantive caller interruption.
- Provider transcripts are returned in numbered chunks of at most twelve
  messages. Reads default to the actual tail, preserve absolute message numbers,
  expose authoritative totals, support user/assistant role filters, and walk
  backward or forward from the stored cursor without replaying a chunk.
- Standalone acknowledgement backchannels do not trigger another answer.
  Adjacent transcript completions are coalesced for 350 ms, while deterministic
  fragment-only transcripts receive one short clarification instead of a guess.
- If the caller reports a cut-off answer, Teleagent restates the complete prior
  answer once instead of adding repeated apologies or status notices.
- Duplicate assistant transcript events are suppressed by OpenAI item/response
  identity, so a legitimate repeated sentence in a later turn is retained.
- “Goodbye,” “I am done,” or “end the call” produces one short farewell and
  then destroys the SIP dialog. Questions about whether hang-up is possible do
  not end the call.

Local hang-up resolves the call lifecycle before attempting SIP signaling, so
cleanup cannot depend on Drachtio emitting a local `destroy` event. Hermes uses
an explicit UDP Contact transport to match its Asterisk trunk, and cleanup also
closes the Realtime socket, audio-fork WebSocket, media bug, and endpoint.

Transcription is biased with Hermes/Teleagent/model/domain keywords plus live
tmux session, window, and provider-conversation names discovered at call start.
If a term is still unclear, the conductor asks one short clarification instead
of inventing a path or command.

## Usage, budget, and prompt caching

Realtime `response.done` and transcription usage records are persisted locally,
including text, audio, and cached input-token details. Ask the conductor for
voice usage or run the history command below.

This ledger measures consumption; it cannot read the remaining project budget
configured in the OpenAI dashboard. Doing that would require a separate,
broader organization billing credential, which is deliberately not given to
the phone service.

Realtime conversation context is stateful, and OpenAI reports cached input
tokens when caching applies. Teleagent keeps the stable conductor instructions
before caller-specific history to maximize reusable prefixes. There is no
service-side switch that forces every Realtime turn to be cached; inspect the
persisted `cached_input_tokens` rather than assuming a hit.

Retention-ratio truncation bounds the live conversation after the stable
instructions. The default post-instruction context target is 16,000 tokens with
a 0.8 retention ratio, reducing repeated oversized tool context on long calls.
Server-reported item truncation and deletion events are written to the local
audit so context loss can be correlated with transcript behavior.

## Configuration

```bash
OPENAI_REALTIME_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_TRANSCRIPTION_MODEL=gpt-live-transcribe
OPENAI_REALTIME_TRANSCRIPTION_PROMPT=A private operator call about Teleagent on the phone through Linphone, Hermes, a homelab, repositories, the main tmux session, windows, panes, Claude Code, Codex, Kubernetes, and infrastructure.
OPENAI_REALTIME_TRANSCRIPTION_KEYWORDS=Hermes,Teleagent,homelab,tmux,Claude Code,Codex,Haiku,Sonnet,Opus,Luna,Terra,Sol,Kubernetes,phone,Linphone,main,window,pane,phone-infra,FreeSWITCH,drachtio,freestio,pound,star,approve,cancel
OPENAI_REALTIME_TRANSCRIPTION_LANGUAGES=en
OPENAI_REALTIME_TRANSCRIPTION_DELAY=medium
OPENAI_REALTIME_MAX_SPOKEN_WORDS=35
OPENAI_REALTIME_HARD_MAX_SPOKEN_WORDS=240
OPENAI_REALTIME_NOISE_REDUCTION=near_field
OPENAI_REALTIME_VAD_EAGERNESS=medium
OPENAI_REALTIME_RESPONSE_DEBOUNCE_MS=250
OPENAI_REALTIME_CONTEXT_TOKEN_LIMIT=16000
OPENAI_REALTIME_CONTEXT_RETENTION_RATIO=0.8
OPENAI_SAFETY_IDENTIFIER_SALT=replace-with-random-secret
VOICE_INSPECTION_ROOTS=/var/lib/teleagent-control
VOICE_APP_UID=<id -u teleagent-voice>
VOICE_APP_GID=<id -g teleagent-voice>
VOICE_STATE_DIR=/var/lib/teleagent-isolated-voice
VOICE_AGENT_RECENT_OUTPUT_MS=5000
```

The database and execution-lock paths are fixed application constants at
`/app/state/voice-state.sqlite` and
`/app/state/voice-execution.lock.json`. Voice HTTP and AudioFork hosts are fixed
to `127.0.0.1`, non-loopback modes are fixed off, and the peer override is fixed
empty. Omit all of those path/listener settings from the host environment; the
launcher and application both reject missing or drifted container projections.

The caller number is hashed before use as `OpenAI-Safety-Identifier`. Keep the
dedicated Realtime key, API bridge token, and explicit salt in the server-side
`.env` with mode `0600`. They are not passed to agent subprocesses.

Do not provision or mount an approval private key or privileged-action bearer
into voice. The production controller also discards legacy verifier/proxy
environment settings after reading `runtime.env` and cannot reach the root
broker socket. The capability/key-loading modules remain unit-test substrate,
not an activation path. Old verifier keys must be revoked so a formerly exposed
voice key cannot be paired with the executor bearer to regain mutation.

### Existing tmux agent sessions

Managed voice-profile sessions and worker-owned tmux-attached provider sessions
are deliberately separate. `list_runtime_sessions` shows both namespaces.
Only sessions on `/run/teleagent-worker-session/tmux.sock` are in scope;
owner/alborz sessions such as `main:phone` are intentionally invisible.
`get_latest_agent_session_message` reads the actual latest provider message,
not a pane placeholder or the first log page.

Sending to an existing tmux conversation is production-disabled because voice
cannot obtain an independently attested capability. The retained unit-level
flow resolves numeric or named aliases to a stable tmux pane ID and binds the
pane, message hash, provider-log fingerprint, and configured approval window.
Delivery would wait for a provider idle boundary and
uses a private tmux buffer so the message is not present in process arguments.
Canceling during that wait leaves the pre-existing task untouched.
The job completes only after that same provider log verifies the exact user
message and a provider-final assistant response. A changed pane binding fails
closed. If `*` races with an already-finished response, completion wins and is
reported truthfully. If the exact message was delivered before interruption,
the result explicitly says delivery occurred without a verified final reply so
the caller does not unknowingly retry the side effect. `*` and the global `9`
send Ctrl-C only to work that was actually submitted to the targeted pane.

## Operations

```bash
curl -fsS http://127.0.0.1:3000/api/realtime-health
curl -fsS http://127.0.0.1:3333/health
docker compose logs -f voice-app
npm run voice-history -- --limit 500
npm run voice-history -- --thread vt_... --json --output /tmp/voice-thread.json
npm run voice-control -- status
npm run voice-control -- unlock
```

The history export contains exact text, jobs, audit rows, and measured usage;
files written with `--output` use mode `0600`. The health endpoint does not
open a billable Realtime connection.

After a voice-app restart, stale Realtime media sessions close, while durable
read-only managed work is recovered by idempotency key without blind
resubmission. Legacy target work that already crossed its durable delivery
attempt boundary is limited to GET-only reconciliation; pre-effect legacy
target or mutation work fails against the current disabled authority. Pending
legacy approvals never become production authorization. Completed jobs,
transcript history, preferences, usage, audit, and provider session mappings
remain durable.

### Saved context across response stages

Realtime `response.create.instructions` replaces the session instructions for
that response. Routing, direct speech, and tool-result speech therefore include
the conductor instructions before their stage-specific instructions. This keeps
saved phone context and authority guidance available after a redial. A farewell
still uses an empty input and only its one-time goodbye instruction, so saved
answers cannot leak into hangup speech. The API contract is documented in
[Realtime client events](https://developers.openai.com/api/reference/resources/realtime/client-events#response.create).


### Enrolled personal session names

When the independently gated owner-session capability is available, call startup
loads the authenticated enrollment labels into routing and transcription context.
This is a pronunciation hint, not a liveness check or delivery authorization.
Reading a named conversation uses `inspect_owner_session`; sending an instruction
uses `request_owner_instruction`. The voice contracts require `session_label`,
not a model-generated identifier. Each action resolves the current inventory.

An unknown or ambiguous label asks the caller to clarify among enrolled labels;
it never chooses a similar name, substitutes phone history, or switches to the
worker's tmux scope. Tool audits retain the bounded, redacted selector and error
code, but never instruction text or native conversation contents. Instruction
delivery still requires the independent PBX readback and fresh handset approval
on an authenticated SRTP call.


### Personal-session follow-ups

Named membership questions use `list_owner_sessions` with `session_label`.
The app speaks a verified enrollment result; it does not imply native liveness.
List and delivery-status speech are checked before audio reaches SIP.

The router receives up to 32 application-owned instruction references from the
current call, with stable send order, target label and operation ID. This keeps
“the first message” distinct from the latest message after multiple sends.
References contain no message text, grant no authority, and require a fresh
`get_owner_instruction` lookup. Older dropped references and ambiguous requests
require clarification; they never trigger a resend. Explicit membership and ordinal-delivery questions have a narrow read-only
routing rule, bound to the completed caller turn. Short follow-ups use the last
queried operation only while that delivery remains the focus. These rules never
select a send action. A new call starts without these references. Acceptance still does not prove that the native agent finished.

Reply and output questions instead use `inspect_owner_session` with `history`
enabled. The focused session comes from a successful send/status/read, and the
application resolves its label against fresh enrollment. After a reply read,
“what about now?” and “recheck” inspect the same session again. An unrelated or
failed action clears that focus. Each read speaks only the newest native turn;
an accepted delivery receipt is never used as evidence that no reply exists.

### Personal-session follow-ups

Say “Ask Drizzy what is ten times ten and read it back when done” to request
an in-call reply notification. Teleagent preserves the question, records one
native delivery, and checks its reply serially every five seconds while the
call is quiet. It requires the stored target, native identity, delivery record,
and matching user operation marker; Codex also requires the acknowledged turn
ID. Another user message in the same turn prevents attribution. An old or
unrelated reply is never a substitute. The bounded native history can omit an
older result, in which case Teleagent cannot confirm it through this path.

Only one requested automatic readback is active per call. A new watch replaces
the previous watch, and a repeated reminder about the same operation does not
send it again. Checking continues while the call remains open, without adding
a task-duration limit. Call termination or transport loss stops checking without
cancelling the agent's work; this feature does not
promise a callback or restart-persistent notification. A manual reply read is
still available afterwards.

Explicit session corrections override the previous focus. Ambiguous compound
targets require clarification. Voice sends must preserve a message extractable
from the caller's current transcript; uncertain, fragmented or rewritten text
requires clarification before anything is sent. Native permissions and approval
prompts remain unchanged.

### Caller routing isolation

Each routing response receives only the accepted final caller text, plus
application-owned session focus and instruction references. Quoted history is
excluded from routing input. `conversation: "none"` alone only prevents writing
the routing result into the conversation; the explicit `input` also excludes
old conversation content, as described in the [Realtime conversation guide](https://developers.openai.com/api/docs/guides/realtime-conversations).

Ordinary session-list requests and explicit send/message commands have local
routing rules. Spoken spacing such as “phone A” resolves only to a unique known
label. A continuing “and…” fragment joins an unfinished send before dispatch;
a late or canceled routing response cannot execute the superseded request.
After dispatch, additions never resend or rewrite that instruction. Unclear
additions ask for a complete new message. Message-validation failures speak a
checked clarification, not a claim that session tools are unavailable.

### Personal session conversation controls

A complete farewell such as “goodbye” or “please end the call” ends a call.
Farewell words inside a forwarded instruction (for example, “send phoneA a
message saying I’m done”) remain message content. Queued notices wait for
speech and its final transcription before continuing.

Named-session history supports first, previous, and second-to-last messages.
Message ordinals count user and assistant text messages; “reply” selects
assistant messages only. “One before that” continues the last selection.
Reads remain bounded to six native Codex turns or a 256 KiB Claude history
window, with at most a 2,000-character redacted message excerpt. The first
message is read from the beginning, not the oldest item in a recent tail.
Unavailable selections are reported explicitly, never replaced by a newer reply.

Session inventory reads all names that fit in one response. For long catalogs,
“next sessions” continues the list. For automatic readback, say “read the reply
when it finishes” with the instruction; Teleagent acknowledges the watch.
The watch lasts during this call and does not promise a callback or cancel
native work when the call ends.

Fetched replies remain available as bounded, call-local quoted context for
follow-up explanations and detailed readback. Ordinary questions preserve the
selected session. The quotation is supplied only to speech with tools disabled;
action routing receives the caller's request and session references, never the
quoted instructions. Current-status requests still perform a fresh read. A new
read or instruction clears the old snapshot, including when that read fails,
and ending the call clears the context. Longer readbacks preserve concrete
steps instead of replacing them with a statement that a sequence exists.

Playback echo suppression requires a contiguous repeated phrase of at least
three words. Shared vocabulary alone does not suppress a caller's clarification,
and short repeated choices remain eligible caller turns. Text matching cannot
perfectly distinguish physical echo from an intentional verbatim repetition.
# V68 synthetic speech findings

Unknown or ambiguous enrolled names produce a short, transcript-verified
clarification. Prior reply excerpts cannot replace that question with an access
refusal. A caller command starting with “Call …” that asks for a reply or message
is ambiguous: it asks whether to send or read, without doing either. A fresh
explicit request is required; the app never silently changes “call” to “tell”.
Recognized send connectors such as “saying,” are removed before forwarding while
the actual message remains a substring of the caller transcript.

These cases came from real-audio synthetic tests using installed conversation
code and OpenAI Realtime, with simulated SIP/media peers and native sessions.
Such tests do not establish handset acoustics, actual SIP/SRTP teardown, or
native-agent delivery. Keep their evidence separate from live call acceptance.
