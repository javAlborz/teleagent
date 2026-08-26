# Teleagent

Voice interface for Claude Code and OpenAI Codex over SIP.

Teleagent is the maintained continuation of the old Claude Phone project for the Hermes phone stack. The CLI command remains `claude-phone` for compatibility.

## What It Does

- Inbound calls: call an extension and talk to Claude or Codex
- Outbound calls: have your server call you with alerts or task results
- Per-extension personalities: different names, voices, and prompts per device

## Requirements

- 3CX cloud account or compatible SIP setup
- For legacy extensions: OpenAI-compatible TTS and STT endpoints
- For native full-duplex voice: an OpenAI API key with Realtime API access
- At least one agent CLI: authenticated Claude Code, authenticated Codex, or both
- macOS or Linux

## Quick Start

### 1. Install

```bash
curl -sSL https://raw.githubusercontent.com/javAlborz/teleagent/main/install.sh | bash
```

This installs dependencies, clones the repo to `~/.claude-phone-cli`, and creates the `claude-phone` command.

### 2. Configure

```bash
claude-phone setup
```

The setup wizard supports:

- `Voice Server`: voice services only
- `API Server`: Claude/Codex bridge only
- `Both`: all-in-one single-machine install

On API-hosting modes, setup also selects `Claude`, `Codex`, or both, records
provider-specific working directories, and offers only the corresponding model
profiles when a SIP device is created. Existing configs migrate as Claude-only
until the provider selection is changed explicitly.

### 3. Start

```bash
claude-phone start
```

## Deployment Modes

| Mode | Best For | Runs |
|------|----------|------|
| `Both` | Single hardened Linux host | guarded voice stack and isolated Claude/Codex controller |
| `Voice Server` | Retired | split-host credential routing is refused |
| `API Server` | Separate machine with the desired agent CLIs | `claude-api-server` only |

Do not split the credential-bearing voice and controller planes. The normal CLI
delegates voice start/stop to the dormant `teleagent-voice-stack.service`; it
does not invoke Compose directly. Production activation remains blocked until
the promotion gates in `docs/PHONE-AGENT-ARCHITECTURE.md` pass.

### Hermes resource envelope

The tracked Compose baseline keeps the voice runtime from starving the Hermes
jumpbox. `voice-app` and FreeSWITCH are each limited to 1 GiB RAM and 2 CPUs;
Drachtio is limited to 384 MiB RAM and 1 CPU. Each service also has a bounded
swap allowance and PID ceiling. These are hard containment ceilings, not
capacity targets; raise one only after measuring a legitimate call-path peak.
The host-side agent bridge and all of its CLI descendants are separately capped
by the tracked user unit at 6 GiB RAM, 1 GiB swap, 4 CPUs, and 1536 tasks.

## Common Commands

| Command | Description |
|---------|-------------|
| `claude-phone setup` | Interactive configuration |
| `claude-phone start` | Delegate voice activation to the guarded systemd unit |
| `claude-phone stop` | Coordinate panic and stop through the guarded unit |
| `claude-phone status` | Show service status |
| `claude-phone doctor` | Run health checks |
| `claude-phone logs [service]` | Tail logs |
| `claude-phone api-server [--port N]` | Start API server standalone |
| `claude-phone device add` | Add a device/extension |
| `claude-phone device list` | List devices |
| `claude-phone update` | Update Teleagent |

## Devices

Each SIP extension can have its own voice and personality:

```bash
claude-phone device add
```

Example:

- `9000`: general assistant
- `9002`: monitoring bot

The Hermes deployment provides paired fresh/resume profiles:

| Fresh | Resume | Agent | Runtime boundary |
| --- | --- | --- | --- |
| `1` | `11` | Claude Haiku | Read-only or approved workspace tools |
| `2` | `22` | Claude Sonnet | Read-only or approved workspace tools |
| `3` | `33` | Claude Opus | Read-only or approved workspace tools |
| `4` | `44` | Codex GPT-5.6 Luna | Read-only, low reasoning |
| `5` | `55` | Codex GPT-5.6 Terra | Workspace-write, medium reasoning |
| `6` | `66` | Codex GPT-5.6 Sol | Approved workspace mutation, high reasoning |
| `7` | `77` | OpenAI Realtime conductor | Directs any Claude/Codex profile |

Dial `9` from the authenticated owner handset to activate the global voice
emergency stop. It immediately locks new phone-originated dispatch, cancels
pending jobs, and terminates running phone-originated Claude/Codex process
groups. The lock persists across service restarts and does not stop unrelated
terminal or API sessions.

Review and clear the lock locally on Hermes:

```bash
npm run voice-control -- status
npm run voice-control -- unlock
```

Deploy/publish requests are unavailable until a separate audited tool/action
broker exists. They fail before approval consumption and provider launch; Sol
does not receive direct GitHub, cluster, or homelab network access.

Extensions `7` and `77` use OpenAI's native speech-to-speech Realtime API.
They do not call the separately hosted TTS or STT services, so they remain
usable while Zeus speech services are unavailable. `7` creates a fresh durable
voice thread; `77` restores the most recent thread for the same caller. Within
that thread, Claude Haiku/Sonnet/Opus and Codex Luna/Terra/Sol each keep a
separate provider session. See [OpenAI Realtime Voice](docs/OPENAI-REALTIME.md).

The Realtime conductor can route automatically by capability, hand work
between profiles, inspect bounded worker-workspace/Git/tmux state, read exact
phone history or redacted numbered chunks from a pane-attached Codex/Claude
provider session, retain explicit preferences, report measured token
usage, fetch current weather, and actually hang up. Accepted background work
uses one acknowledgement tone and stays quiet until an authoritative result.
Tmux inspection returns sessions, windows, and panes hierarchically, maps
node-wrapped Claude/Codex descendants to the owning pane, and never treats TUI
placeholder text as provider history. It also returns a stable pane ID; later
history reads and writes use that identity rather than a window index that may
move.

An existing worker-owned tmux-attached Claude conversation is a
separate namespace from the six Teleagent-managed profile sessions. Ask for
“all runtime sessions” to see both. To direct an existing conversation, name
its exact target on `/run/teleagent-worker-session/tmux.sock` and the exact
message. Historical owner/alborz sessions such as `main:phone` are
intentionally invisible, and interactive Codex panes remain disabled. Teleagent fingerprints the bound
provider log before approval, reads the target and message once, waits for `#`,
waits for any pre-existing target task to become idle, pastes through a private
tmux buffer, and reports completion only after the same provider log contains
both the exact user message and a final assistant reply.
If `*` races with completion, the verified completion wins; if delivery occurred
before interruption, Teleagent says so explicitly rather than claiming the
message never went out. Voice requests to cancel only prompt for `*`. Dial `9`
to interrupt every voice-originated task and persistently lock further
execution.

Any supported voice-originated workspace mutation or root action must be
created through `7/77`. Deploy/publish remains explicitly unavailable. The app speaks the focused scope; `#`
approves that job and `*` cancels it. Ordinary agent mutations use the durable
non-root executor. Root actions use the separate exact-argv root broker and a
second authenticated controller proxy; conversational Claude/Codex workers
never receive sudo or the broker socket. See
[Privileged phone actions](docs/PRIVILEGED-ACTIONS.md).
Every Claude/Codex launch crosses its provider-specific worker/supervisor/egress
boundary, and filesystem/Git/tmux inspection crosses the distinct
`teleagent-session-broker` boundary; there is no controller-UID fallback.
See [Worker execution and sessions](docs/WORKER-SESSION-BROKER.md).
Consequently, direct profile extensions `1` through `6` remain useful for
read-only conversations but cannot bypass the scoped Realtime approval flow.
The bridge also forces every read-only Codex job into `read-only` and removes
Claude mutation tools even when Opus or Sol was named explicitly.

## API

`voice-app` exposes these endpoints on port `3000`:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/outbound-call` | Durably queue an idempotent outbound call |
| `GET` | `/api/outbound-status` | Read sanitized outbound readiness and recovery-barrier state |
| `GET` | `/api/call/:callId` | Get call status |
| `GET` | `/api/calls` | List active calls |
| `GET` | `/api/devices` | List devices |
| `GET` | `/api/device/:identifier` | Get one device |
| `GET` | `/api/realtime-health` | Check Realtime configuration and state storage |
| `POST` | `/api/voice-control/stop` | Loopback-only global emergency stop |
| `GET` | `/api/voice-control/status` | Read the local voice execution lock |
| `POST` | `/api/voice-control/unlock` | Authenticated operator unlock |

See [Outbound API Reference](voice-app/README-OUTBOUND.md).

The local Asterisk/voice SIP trunks are mutually authenticated with two
distinct root-owned file credentials. A loopback source address, caller ID, or
SIP `Contact` header grants no voice-agent authority; an inbound INVITE is
authenticated before any caller, thread, media, or approval state exists.
Unprovisioned credential mounts default to `/dev/null`, so the voice service
fails before opening listeners.

## Configuration

Speech services are configured through `.env`:

```bash
TTS_BASE_URL=http://127.0.0.1:18000/v1
TTS_VOICE=af_bella
STT_BASE_URL=http://127.0.0.1:18001/v1
```

Native Realtime voice is configured independently:

```bash
OPENAI_REALTIME_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_TRANSCRIPTION_MODEL=gpt-live-transcribe
OPENAI_REALTIME_TRANSCRIPTION_DELAY=medium
OPENAI_REALTIME_MAX_SPOKEN_WORDS=35
OPENAI_REALTIME_HARD_MAX_SPOKEN_WORDS=240
OPENAI_REALTIME_NOISE_REDUCTION=near_field
OPENAI_REALTIME_RESPONSE_DEBOUNCE_MS=500
OPENAI_REALTIME_CONTEXT_TOKEN_LIMIT=16000
OPENAI_REALTIME_CONTEXT_RETENTION_RATIO=0.8
VOICE_INSPECTION_ROOTS=/var/lib/teleagent-control
VOICE_APP_UID=<id -u teleagent-voice>
VOICE_APP_GID=<id -g teleagent-voice>
VOICE_STATE_DIR=/var/lib/teleagent-voice
VOICE_APPROVAL_CAPABILITY_ENABLED=false
VOICE_APPROVAL_SIGNING_KEY_FILE=/run/secrets/teleagent-approval-private.pem
VOICE_APPROVAL_SIGNING_KEY_ID=controller-2026-01
VOICE_APPROVAL_CAPABILITY_TTL_SECONDS=120
VOICE_APPROVAL_KEY_ID=controller-2026-01
VOICE_APPROVAL_PUBLIC_KEY_FILE=/secure/executor/teleagent-approval-public.pem
EXECUTOR_TASK_DB_PATH=/var/lib/teleagent-control/executor-tasks.sqlite
```

The mounted host state directory remains explicit, but its in-container
database and execution-lock files are application constants:
`/app/state/voice-state.sqlite` and
`/app/state/voice-execution.lock.json`. The HTTP and AudioFork listeners are
likewise fixed to `127.0.0.1`. Host environment files must omit the corresponding
path, host, peer, and non-loopback variables; the launcher rejects them even
when their value happens to match the fixed contract.

Mutating voice work uses short-lived Ed25519 capabilities bound to the approved
job, request and execution-plan hashes, target, provider, and profile. Keep the
controller private key in a root:`teleagent-voice` mode-`0440`, single-link file
mounted read-only at the fixed in-container path; never put it in `.env`, the repository, agent prompts,
or worker environments. Until the executor has the matching public key and a
durable replay store, leave `VOICE_APPROVAL_CAPABILITY_ENABLED=false`. That mode
keeps read-only voice use available and fails every mutation closed.

The executor opens its public key with symlink protection and rejects writable
or incorrectly owned trust anchors. Replay nonce consumption and durable task
creation share one SQLite transaction, so an insert failure cannot burn an
approval without creating its task.

Keep the local Drachtio Contact transport aligned with the Asterisk trunk. The
Hermes default is `DRACHTIO_SIP_TRANSPORT=udp`; this ensures app-originated BYE
requests use the same transport as the UDP-only local trunk.

The voice app prefers the provider-neutral bridge names while accepting the
legacy Claude names:

```bash
AGENT_API_URL=http://127.0.0.1:3333
AGENT_API_BIND_HOST=127.0.0.1
AGENT_API_NON_LOOPBACK_ENABLED=false
AGENT_API_TOKEN=replace-with-distinct-general-token-at-least-32-bytes
EXECUTOR_API_TOKEN=replace-with-distinct-executor-token-at-least-32-bytes
PRIVILEGED_ACTION_API_TOKEN=replace-with-distinct-privileged-token-at-least-32-bytes
PRIVILEGED_ACTION_PROXY_ENABLED=false
PRIVILEGED_ACTION_PROXY_SOCKET_PATH=/run/teleagent-privileged-action/broker.sock
VOICE_PRIVILEGED_ACTIONS_ENABLED=false
VOICE_CONTROL_TOKEN=replace-with-distinct-control-token-at-least-32-bytes
AGENT_PROVIDERS=claude,codex
AGENT_DURABLE_EXECUTOR_ENABLED=true
```

All four bearers are mandatory on the host controller and must be clean,
pairwise-distinct 32-4096 byte tokens. `AGENT_API_TOKEN` protects ordinary
non-public bridge routes and no longer falls back to `CLAUDE_API_TOKEN`.
`EXECUTOR_API_TOKEN` protects every `/executor` route and does not accept the
general or legacy token. Docker Compose explicitly blanks `AGENT_API_TOKEN` and
`CLAUDE_API_TOKEN` inside `voice-app`; the voice process receives only its
executor, voice-control, and privileged-action capabilities. The controller
refuses startup if scoped tokens are reused, and `/health` remains
`503 not_ready` until all four controller credentials are installed.
Committed placeholder/example values are treated as unconfigured. The phone
controller and voice app are fixed to loopback; non-loopback agent API routing
is not a supported phone deployment boundary.

Durable `managed_ask` submission is phone-only: an absent, unknown, or non-phone
profile is rejected before task creation or one-time approval consumption.
Non-phone automation continues through the synchronous general bridge. The
executor capability may submit, cancel, and panic durable phone work, but both
`/voice-control/unlock` and the compatibility `/executor/panic/unlock` route
require `VOICE_CONTROL_TOKEN` and refuse to unlock until durable work is truly
quiesced.

Phone-managed queries are submitted with a deterministic idempotency key and
polled through the bridge's durable executor. If the submit response is lost,
the voice app looks up that same key instead of resending the approval. Raw
approval capabilities are transported only on the initial authenticated submit
and are never included in client logs or persisted durable task records. Non-phone
API callers continue to use the synchronous `/ask` endpoint. The voice bridge
fails closed when `AGENT_DURABLE_EXECUTOR_ENABLED=false`; it never falls back to
`/ask` because it does not hold the general bearer. A repeated submit returns
the existing task only when its sanitized managed request matches exactly, and
it does not consume another capability. Voice cancellation and cleanup use
`/voice-control/session/cancel` and `/voice-control/session/end` under the
dedicated voice-control bearer.

Codex phone profiles use the normal Codex CLI login for the service account.
Use device authorization when the API host is headless:

```bash
codex login
# Headless alternative:
codex login --device-auth
codex login status
```

See the official [Codex authentication guide](https://learn.chatgpt.com/docs/auth)
and [CLI command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

Their models, reasoning efforts, profile-specific working directories, and sandboxes are set with
the `PHONE_CODEX_*` variables documented in `.env.example`. The bridge runs
phone requests with approval policy `never`; Luna/Terra/Sol capability is
therefore determined by their explicit `read-only`, `workspace-write`, and
`danger-full-access` sandbox settings.

On Ubuntu hosts with `kernel.apparmor_restrict_unprivileged_userns=1`, install
the repository's narrow Bubblewrap launcher profile and reload AppArmor:

```bash
sudo install -o root -g root -m 0644 deploy/apparmor/usr.bin.bwrap /etc/apparmor.d/usr.bin.bwrap
sudo apparmor_parser -r /etc/apparmor.d/usr.bin.bwrap
```

This keeps the host-wide restriction enabled while allowing Codex's read-only
Bubblewrap sandbox to create its own user namespace. Read-only voice jobs also
enable native Codex web search and ignore interactive user escalation settings.

User configuration lives in `~/.claude-phone/config.json` with restricted permissions.

Useful commands:

```bash
claude-phone config show
claude-phone config path
npm run voice-history -- --limit 500
npm run voice-control -- status
```

## Troubleshooting

Start with:

```bash
claude-phone doctor
claude-phone status
claude-phone logs
```

See [Troubleshooting Guide](docs/TROUBLESHOOTING.md) for common issues.

## Development

```bash
npm test
npm run lint
```

## Documentation

- [CLI Reference](cli/README.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Outbound API](voice-app/README-OUTBOUND.md)
- [Deployment](voice-app/DEPLOYMENT.md)
- [OpenAI Realtime Voice](docs/OPENAI-REALTIME.md)
- [Privileged phone actions](docs/PRIVILEGED-ACTIONS.md)
- [Claude Code Skill](docs/CLAUDE-CODE-SKILL.md)

## License

MIT
