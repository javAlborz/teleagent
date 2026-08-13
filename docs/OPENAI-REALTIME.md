# OpenAI Realtime Voice

Teleagent exposes a native full-duplex OpenAI voice conductor alongside the
existing turn-based Claude and Codex extensions.

## Extensions

| Extension | Behavior |
| --- | --- |
| `7` | Create a fresh durable voice thread, defaulting to Codex Terra |
| `77` | Resume the newest non-expired voice thread owned by the same caller |

Both extensions can direct any of these independent profiles:

- `claude-haiku`, `claude-sonnet`, `claude-opus`
- `codex-luna`, `codex-terra`, `codex-sol`

OpenAI handles the live conversation and speech. It does not replace Claude
Code or Codex as the coding/runtime agent; it calls a small application-owned
tool surface that queues work through the existing agent bridge.

## State ownership

State has three deliberately separate layers:

1. A **voice thread** owns caller identity, selected profile, short text
   summary, recent job history, and callback routing.
2. Each `(voice thread, agent profile)` owns a separate Claude or Codex provider
   session. Switching profiles never passes one provider's hidden session ID to
   another provider.
3. Each OpenAI Realtime connection is ephemeral. On resume, Teleagent creates a
   new Realtime session and supplies the local text summary and job status.

SQLite stores threads, Realtime session metadata, per-profile provider session
mappings, jobs, approvals, and the latest 100 text events per thread. It does
not store raw call audio. The default persistent path is
`/app/state/voice-state.sqlite`, backed by the `VOICE_STATE_DIR` host mount.

Provider session IDs are sent explicitly to the bridge on resume, so a
`claude-api-server` process restart does not silently merge or lose the local
profile mapping. A fresh-profile request creates a new provider session key.

## Agent job lifecycle

Realtime has exactly four app-owned tools:

- `start_agent_task`
- `get_agent_task`
- `cancel_agent_task`
- `list_agent_tasks`

There is no arbitrary shell tool exposed to the voice model. The chosen Claude
or Codex profile retains its existing bridge permissions and sandbox.

`start_agent_task` returns immediately with a durable job ID. One job per
profile may be active in a voice thread, while different profiles can run in
parallel. Tool retries are idempotent by Realtime session and tool-call ID.

Requests that look mutating wait in `awaiting_approval`; press `#` to approve
the oldest pending request. Approved mutations share an application mutex so
two mutating jobs do not write the workspace concurrently. Read-only jobs can
run concurrently. Press `*` to cancel the focused pending or running job.

Speech barge-in only interrupts the conductor's current audio. It does not
cancel an agent job. Teleagent stops FreeSWITCH playout and sends an OpenAI
conversation truncation event so the server's conversation matches what the
caller actually heard.

Jobs can report completion in the active call, remain available for a resumed
call, or request a Realtime callback. A callback reopens the exact voice thread
only when its caller identity matches the outbound target.

## Configuration

```bash
OPENAI_REALTIME_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_TRANSCRIPTION_MODEL=gpt-live-transcribe
OPENAI_SAFETY_IDENTIFIER_SALT=replace-with-random-secret
VOICE_STATE_DIR=./voice-app/state
VOICE_STATE_DB_PATH=/app/state/voice-state.sqlite
```

Optional account routing headers are `OPENAI_ORGANIZATION` and
`OPENAI_PROJECT`. `OPENAI_REALTIME_BASE_URL` exists for compatible test
gateways; production normally uses OpenAI's default WebSocket endpoint.

The caller number is hashed before it is used as the OpenAI safety identifier.
When `OPENAI_SAFETY_IDENTIFIER_SALT` is omitted, Teleagent uses the dedicated
Realtime key as a local salt. Keep the key and any explicit salt in the
server-side `.env` and restrict that file to the service account.

## Operations

```bash
curl -fsS http://127.0.0.1:3000/api/realtime-health
docker compose logs -f voice-app
```

The health response distinguishes local state health from API-key
configuration. It does not make a billable OpenAI connection. If
`OPENAI_REALTIME_API_KEY` is absent, Realtime calls fail before answer with SIP `503`;
the legacy extensions continue to behave independently.

On a voice-app restart, queued or running jobs are marked failed because the
in-process execution cannot be reconstructed safely. Completed jobs, pending
approvals, text context, and provider session mappings remain durable.
