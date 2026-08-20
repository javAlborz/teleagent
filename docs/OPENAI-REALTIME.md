# OpenAI Realtime Voice Control Plane

Extensions `7` and `77` provide a Zeus-independent, full-duplex voice control
plane on Hermes. OpenAI Realtime owns the live conversation; Claude Code and
Codex remain the agents that inspect, edit, test, deploy, and administer the
homelab.

## Extensions and profiles

| Extension | Behavior |
| --- | --- |
| `7` | Start a fresh durable voice thread |
| `77` | Resume the newest non-expired thread for the same SIP caller |

The conductor can address all six managed profiles:

| Profile | Provider | Capability | Bridge boundary |
| --- | --- | --- | --- |
| `claude-haiku` | Claude | Read | Phone Haiku tools |
| `claude-sonnet` | Claude | Write | Phone Sonnet tools |
| `claude-opus` | Claude | Admin | Phone Opus tools |
| `codex-luna` | Codex | Read | `read-only` sandbox |
| `codex-terra` | Codex | Write | `workspace-write` sandbox |
| `codex-sol` | Codex | Admin | `danger-full-access` sandbox |

When the caller names a profile, the request stays on that profile or is
rejected if the profile is underscoped. With `auto`, the broker keeps the
currently selected provider and chooses its read, write, or admin tier.
Complex read-only reviews may use the provider's admin-tier model without
receiving mutation authorization. At execution time, every read-only phone job
is additionally downgraded: Codex uses `read-only` regardless of tier, and
Claude loses `Write`, `Edit`, `Task`, and `Bash`. The normal tier boundary is
restored only for a scoped mutation approved with `#`.

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
- Bounded inspection: list/find/read files below approved roots, inspect Git
  status, list/capture tmux panes, read redacted numbered chunks from the exact
  Codex or Claude provider log attached to a pane, describe Hermes, and run a
  fixed read-only homelab health snapshot.
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

## Jobs, mutation approval, and audit

`send_agent_message` returns a durable job ID immediately. One job per profile
may be active in a thread, and independent read-only profiles may run in
parallel. Mutating jobs serialize through one workspace mutex.

Every request is structurally classified as `read_only`, `mutating`, `high`,
or `privileged`. Informational requests such as “show release history” remain
read-only; an explicit follow-up action such as “then deploy it” does not.

Only one operation per thread can wait for approval. The caller hears its
bounded scope once:

- `#` approves that exact focused job.
- `*` rejects or cancels the focused job.
- Dialing `9` outside the conversation activates the persistent global
  voice-execution lock and kills all voice-originated Claude/Codex work.

Approval records bind the DTMF decision to the job ID, normalized request
SHA-256, risk level, timestamp, and scope. Existing-conversation delivery also
binds the stable tmux pane ID and provider-log fingerprint. The broker adds the
authorization envelope only after `#`; the authenticated bridge independently
rejects any non-read-only `phone-*` request without a fresh matching envelope.
Direct speed-dial calls therefore cannot bypass the extension-7 approval flow
for mutations. A spoken “cancel” never executes cancellation; Teleagent asks
the caller to press `*`.

Request, approval, start, cancellation/emergency stop, completion, and failure
events are written to an append-only operation audit. Direct Realtime tool
completions, spoken-output limiting, suppressed pre-tool speech, empty
transcription observations, untranscribed-turn fallbacks, and context
truncation/deletion events are also recorded as redacted metadata; tool result
bodies and captured pane/file content are deliberately excluded.

## Conversation behavior

The input uses low-eagerness semantic VAD with automatic response creation
disabled. Teleagent waits for the completed transcript and creates exactly one
response itself; a short fallback covers a missing transcription event.

- Semantic VAD does not interrupt merely because the microphone detects
  speech. Teleagent waits for the transcript: a standalone backchannel keeps
  playout intact, while a substantive caller turn stops local playout, cancels
  the active response, and reports the amount actually heard with an item
  truncation. Neither action cancels background agent jobs.
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
- Normal replies target fewer than 25 words. The 35-word setting remains an
  advisory/telemetry threshold. Generation is clipped only after the separate
  60-word hard threshold reaches a sentence boundary, or after twice that hard
  threshold when punctuation never arrives. A limit lets already-generated
  audio drain; it never sends `killAudio` or conversation truncation. Completed
  audio is also not killed after it has drained. Those destructive playout
  actions are reserved for a substantive caller interruption.
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
OPENAI_REALTIME_HARD_MAX_SPOKEN_WORDS=60
OPENAI_REALTIME_RESPONSE_DEBOUNCE_MS=350
OPENAI_REALTIME_CONTEXT_TOKEN_LIMIT=16000
OPENAI_REALTIME_CONTEXT_RETENTION_RATIO=0.8
OPENAI_SAFETY_IDENTIFIER_SALT=replace-with-random-secret
VOICE_INSPECTION_ROOTS=/home/alborz/phone,/home/alborz/dev,/home/alborz/dev2,/home/alborz/ufst
VOICE_STATE_DIR=./voice-app/state
VOICE_STATE_DB_PATH=/app/state/voice-state.sqlite
```

The caller number is hashed before use as `OpenAI-Safety-Identifier`. Keep the
dedicated Realtime key, API bridge token, and explicit salt in the server-side
`.env` with mode `0600`. They are not passed to agent subprocesses.

### Existing tmux agent sessions

Managed voice-profile sessions and live tmux-attached provider sessions are
deliberately separate. `list_runtime_sessions` shows both namespaces.
`get_latest_agent_session_message` reads the actual latest provider message,
not a pane placeholder or the first log page.

Sending to an existing tmux conversation uses `send_agent_session_message` and
always requires `#`, even for a question. The first inspection resolves numeric
or named aliases to a stable tmux pane ID, and later reads, approval, and writes
stay on that pane even if window indexes move. The approval names the provider
conversation and binds the stable pane, message hash, provider-log fingerprint,
and 15-minute approval window. Delivery waits for a provider idle boundary and
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

After a voice-app restart, queued/running jobs and stale connecting/connected
Realtime calls are marked failed because their in-process executions and media
cannot be reconstructed safely. Affected voice threads return to idle and the
recovery is audited. Completed jobs, pending approvals, transcript history,
preferences, usage, audit, and provider session mappings remain durable.
