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
| `Both` | Single always-on Mac/Linux host | `voice-app` and the Claude/Codex bridge |
| `Voice Server` | Pi or dedicated SIP/voice box | `voice-app` and supporting containers |
| `API Server` | Separate machine with the desired agent CLIs | `claude-api-server` only |

If you split the deployment:

- On the voice host: `claude-phone setup` then `claude-phone start`
- On the API host: `claude-phone api-server`

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
| `claude-phone start` | Start configured services |
| `claude-phone stop` | Stop services |
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
| `1` | `11` | Claude Haiku | Configured read/troubleshooting tools |
| `2` | `22` | Claude Sonnet | Configured edit/troubleshooting tools |
| `3` | `33` | Claude Opus | Operator-grade Claude tools |
| `4` | `44` | Codex GPT-5.6 Luna | Read-only, low reasoning |
| `5` | `55` | Codex GPT-5.6 Terra | Workspace-write, medium reasoning |
| `6` | `66` | Codex GPT-5.6 Sol | Full access, high reasoning |
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

Codex Luna and Terra cannot auto-escalate a deployment request. The bridge
instructs the caller to dial `6`; only Sol may enter the privileged Codex deploy
profile.

Extensions `7` and `77` use OpenAI's native speech-to-speech Realtime API.
They do not call the separately hosted TTS or STT services, so they remain
usable while Zeus speech services are unavailable. `7` creates a fresh durable
voice thread; `77` restores the most recent thread for the same caller. Within
that thread, Claude Haiku/Sonnet/Opus and Codex Luna/Terra/Sol each keep a
separate provider session. See [OpenAI Realtime Voice](docs/OPENAI-REALTIME.md).

The Realtime conductor can route automatically by capability, hand work
between profiles, inspect bounded filesystem/Git/tmux/runtime state, read exact
phone history or redacted numbered chunks from a pane-attached Codex/Claude
provider session, retain explicit preferences, report measured token
usage, fetch current weather, and actually hang up. Accepted background work
uses one acknowledgement tone and stays quiet until an authoritative result.
Tmux inspection returns sessions, windows, and panes hierarchically, maps
node-wrapped Claude/Codex descendants to the owning pane, and never treats TUI
placeholder text as provider history. It also returns a stable pane ID; later
history reads and writes use that identity rather than a window index that may
move.

An existing tmux-attached Claude or Codex conversation is a separate namespace
from the six Teleagent-managed profile sessions. Ask for “all runtime sessions”
to see both. To direct an existing conversation, name its exact target (for
example, `main:phone`) and the exact message. Teleagent fingerprints the bound
provider log before approval, reads the target and message once, waits for `#`,
waits for any pre-existing target task to become idle, pastes through a private
tmux buffer, and reports completion only after the same provider log contains
both the exact user message and a final assistant reply.
If `*` races with completion, the verified completion wins; if delivery occurred
before interruption, Teleagent says so explicitly rather than claiming the
message never went out. Voice requests to cancel only prompt for `*`. Dial `9`
to interrupt every voice-originated task and persistently lock further
execution.

Any voice-originated mutation—including deploy, publish, restart, and sudo—must
be created through `7/77`. The app speaks the exact focused scope; `#` approves
that job and `*` cancels it. The authenticated bridge independently verifies a
fresh job/request hash before starting a non-read-only `phone-*` request.
Consequently, direct profile extensions `1` through `6` remain useful for
read-only conversations but cannot bypass the scoped Realtime approval flow.
The bridge also forces every read-only Codex job into `read-only` and removes
Claude mutation tools even when Opus or Sol was named explicitly.

## API

`voice-app` exposes these endpoints on port `3000`:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/outbound-call` | Start an outbound call |
| `GET` | `/api/call/:callId` | Get call status |
| `GET` | `/api/calls` | List active calls |
| `GET` | `/api/devices` | List devices |
| `GET` | `/api/device/:identifier` | Get one device |
| `GET` | `/api/realtime-health` | Check Realtime configuration and state storage |
| `POST` | `/api/voice-control/stop` | Loopback-only global emergency stop |
| `GET` | `/api/voice-control/status` | Read the local voice execution lock |
| `POST` | `/api/voice-control/unlock` | Authenticated operator unlock |

See [Outbound API Reference](voice-app/README-OUTBOUND.md).

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
OPENAI_REALTIME_HARD_MAX_SPOKEN_WORDS=60
OPENAI_REALTIME_RESPONSE_DEBOUNCE_MS=350
OPENAI_REALTIME_CONTEXT_TOKEN_LIMIT=16000
OPENAI_REALTIME_CONTEXT_RETENTION_RATIO=0.8
VOICE_INSPECTION_ROOTS=/home/alborz/phone,/home/alborz/dev,/home/alborz/dev2,/home/alborz/ufst
VOICE_STATE_DIR=./voice-app/state
VOICE_STATE_DB_PATH=/app/state/voice-state.sqlite
```

Keep the local Drachtio Contact transport aligned with the Asterisk trunk. The
Hermes default is `DRACHTIO_SIP_TRANSPORT=udp`; this ensures app-originated BYE
requests use the same transport as the UDP-only local trunk.

The voice app prefers the provider-neutral bridge names while accepting the
legacy Claude names:

```bash
AGENT_API_URL=http://127.0.0.1:3333
AGENT_API_TOKEN=replace-with-random-token
AGENT_PROVIDERS=claude,codex
```

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
- [Claude Code Skill](docs/CLAUDE-CODE-SKILL.md)

## License

MIT
