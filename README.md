# Teleagent

Voice interface for Claude Code over SIP.

Teleagent is the maintained continuation of the old Claude Phone project for the Hermes phone stack. The CLI command remains `claude-phone` for compatibility.

## What It Does

- Inbound calls: call an extension and talk to Claude
- Outbound calls: have your server call you with alerts or task results
- Per-extension personalities: different names, voices, and prompts per device

## Requirements

- 3CX cloud account or compatible SIP setup
- OpenAI-compatible TTS endpoint
- OpenAI-compatible STT endpoint
- Claude Code CLI with an active subscription
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
- `API Server`: Claude bridge only
- `Both`: all-in-one single-machine install

### 3. Start

```bash
claude-phone start
```

## Deployment Modes

| Mode | Best For | Runs |
|------|----------|------|
| `Both` | Single always-on Mac/Linux host | `voice-app` and `claude-api-server` |
| `Voice Server` | Pi or dedicated SIP/voice box | `voice-app` and supporting containers |
| `API Server` | Separate machine with Claude Code | `claude-api-server` only |

If you split the deployment:

- On the voice host: `claude-phone setup` then `claude-phone start`
- On the API host: `claude-phone api-server`

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

## API

`voice-app` exposes these endpoints on port `3000`:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/outbound-call` | Start an outbound call |
| `GET` | `/api/call/:callId` | Get call status |
| `GET` | `/api/calls` | List active calls |
| `GET` | `/api/devices` | List devices |
| `GET` | `/api/device/:identifier` | Get one device |

See [Outbound API Reference](voice-app/README-OUTBOUND.md).

## Configuration

Speech services are configured through `.env`:

```bash
TTS_BASE_URL=http://127.0.0.1:18000/v1
TTS_VOICE=af_bella
STT_BASE_URL=http://127.0.0.1:18001/v1
```

User configuration lives in `~/.claude-phone/config.json` with restricted permissions.

Useful commands:

```bash
claude-phone config show
claude-phone config path
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
- [Claude Code Skill](docs/CLAUDE-CODE-SKILL.md)

## License

MIT
