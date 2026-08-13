# Production Deployment Guide

Guide for deploying Teleagent in production environments.

## Architecture Overview

Teleagent consists of three Docker containers and an optional agent bridge:

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Containers                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  drachtio   │  │ freeswitch  │  │     voice-app       │ │
│  │  (SIP)      │  │  (Media)    │  │   (Node.js app)     │ │
│  │  Port 5060  │  │ RTP 30000+  │  │   Port 3000         │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │     claude-api-server         │
              │   (Claude/Codex CLI bridge)   │
              │     Port 3333                 │
              └───────────────────────────────┘
```

The legacy call path sends completed utterances to separate STT and TTS
services. The OpenAI Realtime path streams 24 kHz PCM bidirectionally between
FreeSWITCH and OpenAI and uses the bridge only for Claude/Codex agent jobs.

## Network Requirements

### Ports

| Port | Protocol | Service | Direction |
|------|----------|---------|-----------|
| 5060 | UDP/TCP | SIP signaling (drachtio) | Inbound |
| 5070 | UDP/TCP | SIP signaling (if 3CX SBC present) | Inbound |
| 3000 | TCP | Voice app HTTP API | Inbound (optional) |
| 3333 | TCP | Agent API server | Internal |
| 30000-30100 | UDP | RTP audio (FreeSWITCH) | Bidirectional |

### Firewall Rules

For voice to work correctly, you must allow:

```bash
# SIP signaling
sudo ufw allow 5060/udp
sudo ufw allow 5060/tcp

# RTP audio (critical for audio to work)
sudo ufw allow 30000:30100/udp

# Voice app API (if exposing externally)
sudo ufw allow 3000/tcp
```

### NAT Considerations

The `EXTERNAL_IP` setting must be your server's LAN IP that can receive RTP packets. On NAT networks:

- Use your server's private IP (e.g., 192.168.1.50)
- Ensure RTP ports are forwarded if behind NAT
- 3CX handles NAT traversal for SIP; RTP is direct

## Docker Configuration

The CLI generates `~/.claude-phone/docker-compose.yml` automatically. Key settings:

### Network Mode

Voice-app uses `network_mode: host` for RTP to work correctly:

```yaml
voice-app:
  network_mode: host
```

This allows FreeSWITCH to bind RTP ports directly.

### RTP Port Range

FreeSWITCH uses ports 30000-30100 by default (configured to avoid conflict with 3CX SBC which uses 20000-20099):

```yaml
freeswitch:
  command: >
    --rtp-range-start 30000
    --rtp-range-end 30100
```

### Environment Variables

Key environment variables in the generated `.env`:

| Variable | Purpose |
|----------|---------|
| `EXTERNAL_IP` | Server LAN IP for RTP routing |
| `AGENT_API_URL` | URL to claude-api-server (`CLAUDE_API_URL` is a compatibility alias) |
| `AGENT_API_TOKEN` | Optional bearer token shared with the bridge |
| `TTS_BASE_URL` | OpenAI-compatible TTS base URL |
| `TTS_VOICE` | Default TTS voice name/id |
| `STT_BASE_URL` | OpenAI-compatible Whisper base URL |
| `OPENAI_REALTIME_API_KEY` | Required for OpenAI Realtime extensions and callbacks |
| `OPENAI_REALTIME_MODEL` | Realtime speech-to-speech model; defaults to `gpt-realtime-2.1` |
| `OPENAI_REALTIME_VOICE` | Realtime output voice; defaults to `marin` |
| `OPENAI_REALTIME_TRANSCRIPTION_MODEL` | Text transcript model used for durable context |
| `VOICE_STATE_DIR` | Host directory mounted read/write for durable Realtime state |
| `VOICE_STATE_DB_PATH` | SQLite path inside `voice-app` |
| `VOICE_APP_EXECUTION_LOCK_FILE` | Optional in-container emergency-stop lock path; defaults beside the SQLite state |
| `VOICE_EXECUTION_LOCK_FILE` | Optional host bridge lock path; defaults to `voice-app/state/voice-execution.lock.json` |
| `VOICE_CONTROL_TOKEN` | Optional dedicated bearer token for operator unlock; falls back to outbound/agent API tokens |
| `SIP_DOMAIN` | 3CX server FQDN |
| `SIP_REGISTRAR` | SIP registrar address |

## Split Deployment

### Voice Server (Pi/Linux)

Requirements:
- Docker and Docker Compose
- Network access to 3CX and API server
- Static IP recommended

The voice server runs Docker containers and connects to a remote API server:

```bash
claude-phone setup    # Select "Voice Server"
claude-phone start
```

### API Server (Mac/Linux with Claude Code and/or Codex)

Requirements:
- Node.js 18+
- At least one configured and authenticated agent CLI
- Network accessible from voice server

```bash
claude-phone api-server --port 3333
```

For persistent operation, use a process manager:

```bash
# Using pm2
npm install -g pm2
pm2 start "claude-phone api-server" --name claude-api

# Using systemd (Linux)
# Create /etc/systemd/system/claude-api.service
```

## Monitoring

### Health Checks

```bash
# Overall status
claude-phone status

# Comprehensive diagnostics
claude-phone doctor

# Container health
docker ps
docker compose logs -f

# Realtime readiness and durable-state health
curl -fsS http://127.0.0.1:3000/api/realtime-health

# Emergency-stop status and authenticated operator unlock
npm run voice-control -- status
npm run voice-control -- unlock
```

### Log Locations

```bash
# All logs
claude-phone logs

# Specific service
claude-phone logs voice-app
claude-phone logs drachtio
claude-phone logs freeswitch
```

### Key Log Messages

**Healthy startup:**
```
[SIP] Connected to drachtio
[SIP] Registered extension 9000 with 3CX
[HTTP] Server listening on port 3000
```

**Common errors:**
```
# Wrong external IP
AUDIO RTP REPORTS ERROR: [Bind Error]

# SIP registration failed
Registration failed: 401 Unauthorized

# API server unreachable
Error connecting to agent API
```

## Security Considerations

### API Keys

- Config file has restricted permissions (chmod 600)
- Keep `OPENAI_REALTIME_API_KEY` only in the server-side `.env`; it is never needed on a SIP handset or by agent children
- Realtime audio is streamed and not written to the durable SQLite database
- Realtime callbacks may reopen a voice thread only for the same caller identity
- Never commit `~/.claude-phone/config.json` to version control
- Use environment variables in CI/CD pipelines

### Network Security

- Voice app API (port 3000) should not be publicly exposed without authentication
- Agent API server (port 3333) should only be accessible from the voice server
- Codex Luna/Terra deploy requests are denied; reserve the Sol extension for privileged work
- Dial `9` from the authenticated owner handset to persistently lock all new
  phone-originated dispatch and terminate every tracked phone-originated agent
  process group. Unlock only from the local operator CLI after reviewing logs.
- Give Terra a narrow `PHONE_CODEX_TERRA_WORKING_DIR`; its `workspace-write` sandbox is rooted there
- The bridge removes SIP, speech, and bridge-control secrets from Codex child environments. This reduces accidental inheritance but is not a host-level secret boundary when the service account can read the underlying files.
- Consider VPN for split deployments across networks

### SIP Security

- Use strong passwords for SIP extensions
- 3CX provides TLS for signaling; verify it's enabled
- Monitor for unusual call patterns

## Troubleshooting

### No Audio

1. Verify `EXTERNAL_IP` matches your server's LAN IP
2. Check RTP ports (30000-30100) are open
3. Ensure `network_mode: host` is set for voice-app
4. Check FreeSWITCH logs for RTP errors

### OpenAI Realtime Extension Returns 503

1. Verify `OPENAI_REALTIME_API_KEY` is present in the `voice-app` environment
2. Check `curl -fsS http://127.0.0.1:3000/api/realtime-health`
3. Confirm outbound HTTPS/WSS access to `api.openai.com`
4. Inspect `docker compose logs voice-app` for Realtime session errors

The Realtime path does not depend on `TTS_BASE_URL` or `STT_BASE_URL`. An outage
of those services affects the legacy extensions but not Realtime extensions.

### SIP Registration Fails

1. Verify 3CX extension credentials
2. Check SIP domain and registrar settings
3. Ensure port 5060 (or 5070) is not blocked
4. Verify no other service is using the SIP port

### API Server Connection Issues

1. Verify API server is running: `curl http://API_IP:3333/health`
2. Check firewall allows port 3333
3. Verify URL in voice server config matches API server

## Backup and Recovery

### Configuration Backup

```bash
claude-phone backup
```

Backups are stored in `~/.claude-phone/backups/` with timestamps.

### Recovery

```bash
claude-phone restore
```

Interactive selection of available backups.

### Manual Backup

```bash
cp -r ~/.claude-phone ~/.claude-phone.backup
```

## Updating

```bash
claude-phone update
```

This pulls the latest code and restarts services. Configuration is preserved.

## Uninstalling

```bash
claude-phone uninstall
```

This removes:
- Docker containers and images
- CLI installation
- Optionally: configuration files
