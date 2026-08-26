# Teleagent CLI

Command-line interface for Teleagent. The executable remains `claude-phone` for compatibility.

## Installation

### One-Line Install

```bash
curl -sSL https://raw.githubusercontent.com/javAlborz/teleagent/main/install.sh | bash
```

### Manual Install

```bash
git clone https://github.com/javAlborz/teleagent.git
cd claude-phone/cli
npm ci
npm link
```

## Setup Wizard

```bash
claude-phone setup
```

The wizard guides you through configuration based on your deployment type:

### Voice Server

The split-host voice/controller mode is retired. Credential-bearing voice
traffic must be co-located with the guarded controller on fixed loopback; the
configuration generator refuses `voice-server` and `pi-split` deployment modes.

Voice setup and start require a pre-provisioned, non-login
`teleagent-voice` system account. The CLI resolves its exact UID/GID and never
falls back to the invoking owner or UID/GID 1000. Install device configuration
and the approval/SIP credentials under `/etc/teleagent-voice` with the
root:`teleagent-voice` modes documented in `voice-app/DEPLOYMENT.md`, and use
`/var/lib/teleagent-voice` for durable state. Missing identity or unsafe
metadata stops startup before Docker opens a listener.

### API Server

Select this when setting up the agent API bridge on a machine with Claude Code,
OpenAI Codex, or both.

**What it asks for:**
- Enabled providers (`Claude`, `Codex`, or both)
- Provider commands and working directories
- API server port (default: 3333)

**What `claude-phone start` does:**
- Starts claude-api-server on the configured port

**Note:** You can also just run `claude-phone api-server` without setup - it defaults to port 3333.

### Both (All-in-One)

Select this for a single machine running everything.

**What it asks for:**
1. TTS endpoint URL and default voice
2. STT endpoint URL
3. 3CX SIP domain and registrar
4. Device configuration
5. Server LAN IP, API port, and HTTP port

**What `claude-phone start` does:**
- Delegates voice activation to `teleagent-voice-stack.service`; it never runs
  Compose directly.
- Starts the compatibility API process only in legacy/development installs.

The production unit is deliberately dormant and fails closed until its
root-owned image manifest, exact runtime identities, protected credentials,
SIP fence, isolated provider plane, and controller readiness all validate.

### Pi Auto-Detection

The former Pi split-host path is retained only as migration context and is
rejected by hardened configuration generation. Do not use it for a production
voice/controller boundary.

## Commands

### Setup & Configuration

```bash
claude-phone setup              # Interactive configuration wizard
claude-phone setup --skip-prereqs   # Skip prerequisite checks
claude-phone config show        # Display config (secrets redacted)
claude-phone config path        # Show config file location (~/.claude-phone/config.json)
claude-phone config reset       # Reset config (creates backup first)
```

### Service Management

```bash
claude-phone start              # Delegate voice start to the guarded systemd unit
claude-phone stop               # Panic/quiesce, then stop through that unit
claude-phone status             # Show service status
claude-phone doctor             # Health check for dependencies and services
claude-phone api-server         # Start API server standalone (default port 3333)
claude-phone api-server -p 4000 # Start on custom port
```

### Device Management

```bash
claude-phone device add         # Add a new device/extension
claude-phone device list        # List configured devices
claude-phone device remove <name>   # Remove a device by name
```

### Logs

```bash
claude-phone logs               # Tail all service logs
claude-phone logs voice-app     # Voice app only
claude-phone logs drachtio      # SIP server only
claude-phone logs freeswitch    # Media server only
```

### Backup & Recovery

```bash
claude-phone backup             # Create timestamped backup
claude-phone restore            # Restore from backup (interactive)
```

### Maintenance

```bash
claude-phone update             # Update Claude Phone to latest
claude-phone uninstall          # Complete removal
```

## Configuration Files

All configuration is stored in `~/.claude-phone/`:

```
~/.claude-phone/
├── config.json           # Main configuration (chmod 600)
├── docker-compose.yml    # Generated Docker config
├── .env                  # Generated environment file
├── server.pid            # API server process ID
└── backups/              # Configuration backups
```

The generated `voice-app` service does not inherit this `.env` wholesale.
Compose uses it only to resolve an explicit, source-tested voice runtime
allowlist. General Claude/Codex bridge bearers remain empty in the container,
sensitive bridge logging is forced off, and the approval signer always uses
the fixed read-only `/run/secrets/teleagent-approval-private.pem` mount. Start
the generated stack through the CLI, or run Compose from `~/.claude-phone`, so
the protected `.env` is used for interpolation.

### Config Structure

```json
{
  "version": "1.1.0",
  "installationType": "both",
  "agents": {
    "providers": ["claude", "codex"],
    "claude": {
      "command": "claude",
      "workingDirectory": "/home/example"
    },
    "codex": {
      "command": "codex",
      "workingDirectory": "/home/example",
      "approvalPolicy": "never",
      "luna": {
        "model": "gpt-5.6-luna",
        "reasoningEffort": "low",
        "sandbox": "read-only",
        "workingDirectory": "/home/example"
      },
      "terra": {
        "model": "gpt-5.6-terra",
        "reasoningEffort": "medium",
        "sandbox": "workspace-write",
        "workingDirectory": "/home/example/phone"
      },
      "sol": {
        "model": "gpt-5.6-sol",
        "reasoningEffort": "high",
        "sandbox": "danger-full-access",
        "workingDirectory": "/home/example"
      }
    }
  },
  "api": {
    "tts": {
      "baseUrl": "http://127.0.0.1:18000/v1",
      "apiKey": "not-needed",
      "model": "kokoro",
      "defaultVoice": "af_bella",
      "validated": true
    },
    "stt": {
      "baseUrl": "http://127.0.0.1:18001/v1",
      "apiKey": "not-needed",
      "model": "whisper-1",
      "validated": true
    }
  },
  "sip": {
    "domain": "your-3cx.3cx.us",
    "registrar": "192.168.1.100",
    "transport": "udp"
  },
  "server": {
    "claudeApiPort": 3333,
    "httpPort": 3000,
    "externalIp": "192.168.1.50"
  },
  "devices": [{
    "name": "Morpheus",
    "extension": "9000",
    "voiceId": "af_bella",
    "sessionType": "phone-codex-terra",
    "prompt": "You are Morpheus..."
  }],
  "deployment": {
    "mode": "both"
  }
}
```

## Split Deployment

The former Raspberry Pi voice-host / remote API-host topology is retired. The
hardened voice app and controller must share fixed loopback on one Linux host;
provider execution is isolated behind the local controller instead of moving
credential-bearing voice traffic across the LAN.

## Requirements

- **Node.js 24+** - Required for deployed Teleagent services (the standalone
  compatibility CLI remains Node 18-capable)
- **Docker** - Required for the guarded all-in-one voice stack
- **At least one authenticated agent CLI** - Claude Code, OpenAI Codex, or both, for API Server or Both modes

`claude-phone doctor` checks only configured providers. For Codex it verifies
both `codex --version` and `codex login status` and gives the device-auth command
when a headless host needs authentication.

## Development

```bash
# Run tests
npm test

# Lint
npm run lint
```

## License

MIT
