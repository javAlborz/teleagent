# Production Deployment Guide

Guide for deploying Teleagent in production environments.

> **Production activation contract:** build and attest the voice image in a
> release pipeline, install the reviewed tree at `/opt/teleagent/current`, and
> activate only through `teleagent-voice-stack.service`. The service accepts an
> exact OCI digest from the root-owned
> `/etc/teleagent-voice/voice-image.manifest.json` and runs Compose with
> `--no-build --pull never`. Direct `docker compose up`, a local build context,
> and split-host voice/controller operation are development or migration
> history and are not supported production paths.

## Architecture Overview

Teleagent consists of three long-running Docker containers, a one-shot
no-network credential preflight, and an optional agent bridge:

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

The guarded voice-stack launcher validates `DRACHTIO_SECRET` and
`FREESWITCH_SECRET`
before either control daemon is allowed to start. Both must be distinct,
base64url-safe random values of 32-128 characters; empty values, committed
examples, low-diversity strings, and reuse are fatal. The voice process repeats
the validation before constructing a network client. The checked-in
`.env.example` intentionally leaves both blank, so copying it cannot create a
known live control credential. Generate fresh values, for example with a
cryptographically secure password manager, and rotate both during cutover.
Legacy `SIP_AUTH_ID`/`SIP_AUTH_PASSWORD` environment values are ignored;
registration credentials live only in the mode-`0600` device configuration.

## Network Requirements

### Ports

| Port | Protocol | Service | Direction |
|------|----------|---------|-----------|
| 5060 | UDP | Local Asterisk SIP peer | Same-host loopback only |
| 5070 | UDP | Local Drachtio SIP peer | Same-host loopback only |
| 5080 | UDP | Local FreeSWITCH MRF peer | Same-host loopback only |
| 9022 | TCP | Drachtio application control | Same-host loopback only |
| 8021 | TCP | FreeSWITCH ESL control | Same-host loopback only |
| 3000 | TCP | Voice app HTTP API | Inbound (optional) |
| 3001 | TCP | FreeSWITCH AudioFork callback | Same-host loopback only |
| 3333 | TCP | Agent API server | Internal |
| 30000-30100 | UDP | Asterisk/FreeSWITCH RTP | Same-host loopback only |

### Firewall Rules

Do not expose these media ports with broad host firewall rules. The tracked
UID-bound loopback matrix in `docs/TELEAGENT-SIP-LOCAL-PEER-FENCE.md` is a
transitional sender/source defense; it does not authenticate the receiving
listener. TCP SIP is explicitly rejected. External PBX ingress belongs to the
separately reviewed Asterisk boundary. Production activation remains blocked
until per-service network namespaces provide receiver isolation and the
infrastructure-owned Asterisk RTP allocation is exactly attested.

### NAT Considerations

The hardened media stack is same-host and has no externally forwarded SIP/RTP
ports or media-stack `EXTERNAL_IP`. NAT and external trunk ingress terminate at
the separately reviewed Asterisk/PBX boundary.

## Docker Configuration

The CLI may render `~/.claude-phone/docker-compose.yml`, but production treats
that file as declarative input to the root-owned launcher, never as an
independent activation path. Both the preflight and voice-app services consume
the same exact `${TELEAGENT_VOICE_IMAGE}` digest injected only after the
launcher verifies its image ID, OCI source-revision label, and root-owned
release manifest. The generated services retain the canonical memory/CPU/PID
ceilings, dropped capabilities, no-new-privileges setting, read-only roots,
dedicated non-root voice/media UIDs, and loopback control defaults.

Voice deployments require exact, pairwise-distinct `teleagent-voice`,
`teleagent-drachtio`, and `teleagent-freeswitch` system users/groups plus the
infrastructure-owned `teleagent-asterisk` peer. All four are non-root, use
`nologin`, have no supplementary groups, and must not reuse UID/GID 1000 or a
provider/owner identity. Resolve every explicit Compose UID/GID binding from
those accounts; there is no default. Provision these host paths before start:

- `/etc/teleagent-voice/config`: root:`teleagent-voice`, mode `0750`;
- `/etc/teleagent-voice/config/devices.json`: root:`teleagent-voice`, mode `0440`;
- `/etc/teleagent-voice/credentials`: root:`teleagent-voice`, mode `0750`;
- each projected voice/SIP credential: root:`teleagent-voice`, mode `0440`, one link;
- `/var/lib/teleagent-voice`: the root of a dedicated 4–8 GiB filesystem,
  `teleagent-voice`:`teleagent-voice`, mode `0700`, with at least 512 MiB and
  20% free before activation.

A no-network `voice-runtime-preflight` runs under the voice UID/GID before
either Drachtio or FreeSWITCH. It securely opens the device configuration,
two distinct SIP credentials, and active non-authority runtime credentials
with `O_NOFOLLOW`; it also rejects any retired signer or privileged bearer
projection. It verifies owner/group/mode/link/type and state/config directories,
and fails the dependency graph closed before any SIP, media, or HTTP listener starts. It
mounts voice state read-only and is limited to 0.5 CPU, 256 MiB, no additional
swap, and 64 processes. It also requires the state and configuration mounts to
have distinct device IDs and verifies the 4–8 GiB state capacity/free-space
reserve with `statfs`. Independently, the host launcher requires the exact
`/var/lib/teleagent-voice` directory to be a canonical mountpoint on a device
different from its immediate `/var/lib` parent; a shared `/var` or `/srv`
filesystem does not qualify. The host launcher has an independent 512
MiB/128-task cgroup ceiling and rejects controller responses above 128 KiB.
Before activation intent or credential projection, it securely opens the source
voice-control token, authenticates `/operator/health`, requires exact canonical
read-only authority state with every retired verifier/proxy/bearer flag false,
and erases the token buffer on every outcome.
The long-lived voice process repeats the same check in its health endpoint and
after SIP/API authentication but before accepting each new inbound or outbound
call. Exhaustion returns 503 without reading caller identity, reserving a call,
or starting media/provider work; existing calls drain inside the hard storage
boundary.

All four Compose services use Docker's rotating `local` log driver with at
most three 10 MiB files each. This setting is part of the deployment contract;
do not rely on the daemon's unbounded default `json-file` driver. A failed
`docker compose up` leaves durable `panic_outcome_unknown` even when exact
project cleanup succeeds, and only the explicit offline recovery flow may
clear that activation evidence.

Drachtio and FreeSWITCH have read-only root filesystems. Every writable vendor
`VOLUME` is replaced by an explicit size-capped tmpfs with noexec, nosuid, and
nodev; FreeSWITCH uses a fixed read-only core configuration and a 101-port RTP
range. Run `scripts/test-media-images-read-only.sh` on the bounded CI runner
whenever either exact media-image digest, its entrypoint, or its mount contract
changes. The canary starts both daemons without a network namespace and proves
their loopback control sockets answer while the root filesystems remain
read-only. This canary is not proof that the vendor images work under the new
non-root media UIDs; dedicated real-call staging remains mandatory.

`voice-app` does not use Compose `env_file`. Compose reads `.env` for
interpolation, but passes only the reviewed names in the explicit service
environment mapping. Controller provider commands/profiles, worker paths,
executor databases and public trust anchors therefore do not enter the voice
container. `AGENT_API_TOKEN` and `CLAUDE_API_TOKEN` are fixed empty,
sensitive bridge logging is fixed off, and no approval private key or
privileged-action bearer is projected into voice. The SQLite and execution-lock paths are likewise fixed
to `/app/state/voice-state.sqlite` and
`/app/state/voice-execution.lock.json`. HTTP and AudioFork hosts are fixed to
`127.0.0.1`, non-loopback modes are fixed off, and the AudioFork peer override
is fixed empty. The protected host environment must omit all of those fixed
settings; the root launcher rejects even matching-value entries, and voice-app
rejects a missing, blank, or alternate container projection before opening
SQLite or a listener. The CLI-generated Compose uses the same contract.
The two SIP-trunk credentials likewise use fixed in-container paths and only
their host sources are configurable. They are never process environment
variables.
Run the generated stack only through `claude-phone start`, which delegates to
`teleagent-voice-stack.service`. Never invoke Compose from
`~/.claude-phone`; doing so bypasses the image, dependency, credential,
activation-state, panic, and crash-cleanup gates.

The contract lives in `lib/voice-app-runtime-env.js`. A regression derives all
production `voice-app` environment references and fails when a new key has no
reviewed pass-through or fixed-value disposition. Update that contract,
canonical Compose, and the CLI generator together.

Generated call audio is fixed to `/tmp/voice-audio` inside the private
mode-`0700`, size-bounded container tmpfs. Static beeps and hold music are baked
root-owned into the read-only image. Never restore host-writable audio or static
bind mounts: local agent processes could otherwise replace a media file with a
symlink into the signer or process environment. The loopback media handler
accepts only bounded audio filenames and extensions, opens with `O_NOFOLLOW`,
and verifies the already-open descriptor remains inside the canonical media
root before sending bytes.

The Drachtio, FreeSWITCH, and Node base images are pinned by registry digest.
Do not replace those references with floating tags. Update a digest only after
reviewing the upstream image and passing the real SIP, RTP, DTMF, barge-in, and
panic-stop canaries; record the reviewed digest in both the canonical Compose
file and the CLI generator in the same change.

### Network Mode

The current dormant three-service SIP/media bundle uses `network_mode: host`.
That is not the accepted production receiver boundary: the infrastructure
design must move each media service and Asterisk into a dedicated network
namespace with explicit links and ingress policy. The credential preflight
already uses `network_mode: none`:

```yaml
voice-app:
  network_mode: host
```

This transitional setting allows FreeSWITCH to bind RTP ports directly, but it
must not be promoted as receiver-isolated.

### RTP Port Range

FreeSWITCH is fixed to the closed interval 30000-30100:

```yaml
freeswitch:
  command: >
    --rtp-range-start 30000
    --rtp-range-end 30100
```

The sender fence assumes Asterisk never allocates an RTP source/listener port
in that interval. A statement about a nominal PBX/SBC default is not evidence:
the infrastructure gate must read the exact effective Asterisk configuration,
validate one closed numeric range, and prove it is disjoint from 30000-30100.

### Environment Variables

Key runtime settings (rows marked fixed must be absent from the generated host
environment):

| Variable | Purpose |
|----------|---------|
| `EXTERNAL_IP` | Server LAN IP for RTP routing |
| `DRACHTIO_SECRET` | Required unique 32-128 character random Drachtio control secret; copied examples fail closed |
| `FREESWITCH_SECRET` | Required unique 32-128 character random FreeSWITCH control secret; must differ from every scoped credential |
| `AGENT_API_URL` | URL to claude-api-server (`CLAUDE_API_URL` is a compatibility alias) |
| `AGENT_API_BIND_HOST` | Controller bind host; defaults to `127.0.0.1` |
| `AGENT_API_NON_LOOPBACK_ENABLED` | Explicit reviewed opt-in required for a split-host non-loopback controller bind |
| `AGENT_API_TOKEN` | Controller-only bearer for general `/ask`, `/ask-structured`, and legacy non-phone lifecycle routes. Compose strips it and `CLAUDE_API_TOKEN` from `voice-app`. |
| `EXECUTOR_API_TOKEN` | Mandatory distinct 32-4096 byte bearer for durable phone submission, lookup, cancel, and panic; no general or legacy fallback. Unlock remains voice-control scoped. |
| `AGENT_DURABLE_EXECUTOR_ENABLED` | Require idempotent durable execution for phone managed-agent queries (default `true`); disabling it blocks voice execution rather than falling back to `/ask` |
| `AGENT_DURABLE_EXECUTOR_POLL_MS` | Durable task polling interval (default `500`, bounded to 10-5000 ms) |
| `AGENT_DURABLE_EXECUTOR_SUBMIT_TIMEOUT_MS` | Initial durable submit timeout (default `10000`, bounded to 1-30 seconds) |
| `WS_HOST` | Fixed application constant `127.0.0.1`; forbidden in the host environment |
| `WS_CONNECT_HOST` | Fixed application constant `127.0.0.1`; forbidden in the host environment |
| `WS_NON_LOOPBACK_ENABLED` | Fixed application constant `false`; forbidden in the host environment |
| `WS_ALLOWED_PEERS` | Fixed application constant empty; forbidden in the host environment and resolved to loopback peers |
| `TTS_BASE_URL` | OpenAI-compatible TTS base URL |
| `TTS_VOICE` | Default TTS voice name/id |
| `STT_BASE_URL` | OpenAI-compatible Whisper base URL |
| `DRACHTIO_SIP_TRANSPORT` | Contact transport for the local Asterisk trunk; Hermes defaults to `udp` |
| `OPENAI_REALTIME_API_KEY` | Dedicated clean 32-4096 byte non-placeholder key required for OpenAI Realtime extensions and callbacks; invalid values are treated as unconfigured |
| `OPENAI_REALTIME_MODEL` | Realtime speech-to-speech model; defaults to `gpt-realtime-2.1-mini` |
| `OPENAI_REALTIME_VOICE` | Realtime output voice; defaults to `marin` |
| `OPENAI_REALTIME_TRANSCRIPTION_MODEL` | Text transcript model used for durable context |
| `OPENAI_REALTIME_TRANSCRIPTION_PROMPT` | Stable domain guidance for telephony transcription |
| `OPENAI_REALTIME_TRANSCRIPTION_KEYWORDS` | Comma-separated static vocabulary; live tmux/conversation names are added at call start |
| `OPENAI_REALTIME_TRANSCRIPTION_LANGUAGES` | Comma-separated expected language codes |
| `OPENAI_REALTIME_TRANSCRIPTION_DELAY` | Transcription latency/quality tradeoff; `medium` is the default |
| `OPENAI_REALTIME_MAX_SPOKEN_WORDS` | Advisory spoken-response target recorded with limiter telemetry |
| `OPENAI_REALTIME_HARD_MAX_SPOKEN_WORDS` | High absolute runaway cutoff; defaults to 240 words |
| `OPENAI_REALTIME_NOISE_REDUCTION` | Input filter before VAD: `near_field` for Linphone handsets/headsets, `far_field` for speakerphones, or `off`; defaults to `near_field` |
| `OPENAI_REALTIME_RESPONSE_DEBOUNCE_MS` | Delay used to coalesce adjacent final transcript fragments; defaults to 500 ms |
| `OPENAI_REALTIME_CONTEXT_TOKEN_LIMIT` | Post-instruction Realtime context target before retention truncation |
| `OPENAI_REALTIME_CONTEXT_RETENTION_RATIO` | Fraction retained when long-call context is truncated |
| `VOICE_INSPECTION_ROOTS` | Host roots available to authenticated bounded read-only inspection |
| `VOICE_STATE_DIR` | Host directory mounted read/write for durable Realtime state |
| `VOICE_APP_UID` / `VOICE_APP_GID` | Required numeric IDs of the exact dedicated `teleagent-voice` account; no owner/1000 fallback |
| `VOICE_STATE_DB_PATH` | Fixed application constant `/app/state/voice-state.sqlite`; forbidden in the host environment |
| `EXECUTOR_TASK_DB_PATH` | Executor SQLite DB where task creation and replay nonce consumption commit atomically |
| `VOICE_AGENT_RECENT_OUTPUT_MS` | Provider-log freshness window used for the `generating` activity signal |
| `VOICE_APP_EXECUTION_LOCK_FILE` | Fixed application constant `/app/state/voice-execution.lock.json`; forbidden in the host environment |
| `VOICE_EXECUTION_LOCK_FILE` | Optional host bridge lock path; defaults to `voice-app/state/voice-execution.lock.json` |
| `VOICE_CONTROL_TOKEN` | Mandatory distinct bearer for status, unlock, and authenticated operator routes; no general-token fallback |
| `SIP_DOMAIN` | 3CX server FQDN |
| `SIP_REGISTRAR` | SIP registrar address |
| `SIP_TRUNK_HOST` | Exact server-owned outbound PBX hostname or IPv4 address; client routes are rejected |
| `SIP_TRUNK_PORT` | Required outbound PBX port (for Hermes local Asterisk: `5060`) |
| `SIP_TRUNK_TRANSPORT` | Required outbound transport: `udp`, `tcp`, or `tls` |
| `SIP_TRUNK_INGRESS_PASSWORD_HOST_FILE` | Required root:`teleagent-voice` mode-`0440` file containing Asterisk's dedicated inbound credential |
| `SIP_TRUNK_CALLBACK_PASSWORD_HOST_FILE` | Required root:`teleagent-voice` mode-`0440` file containing voice-app's distinct callback credential |

The CLI creates four independent random credentials (the three active
controller scopes plus outbound control), persists them only in mode-`0600`
configuration, and reuses them across regeneration. The three active scoped
HTTP credentials are mandatory and pairwise distinct. Duplicate
configured values make the controller refuse startup; a missing or malformed
scope keeps public `/health` at `503 not_ready` and its private routes fail
closed. Placeholder/example strings are invalid. Device configuration contains
SIP registration credentials and must be installed root:`teleagent-voice`
mode `0440`; the CLI never makes the owner account the voice runtime.

Every AudioFork callback URL contains a fresh 32-byte, one-use, in-memory attach
credential bound to the exact pending call and a maximum 30-second expectation.
Pathless, unsolicited, expired, reused, wrong-peer, and mismatched-call
connections are closed without creating or replacing a media session. The
credential can transiently appear in FreeSWITCH diagnostics, so those logs
remain private and short-retained; voice-app redacts the URL and never persists
or logs it. The downstream marker used for approval is a correlated media-server
queue acknowledgement, not proof that a physical handset rendered or heard it.
Voice-app refuses startup when `DEBUG` enables any `drachtio:*` namespace
(including wildcard patterns). Those dependency traces can print the Drachtio
control secret, callback Digest password/Authorization, or the one-time
AudioFork callback credential. A broad wildcard is accepted only with the
complete `-drachtio:*` exclusion; keep SIP and FreeSWITCH protocol tracing
disabled in production.

## Deployment Topology

Production is co-located: the credential-bearing voice stack reaches the
durable controller only on fixed loopback, while provider jobs execute through
the isolated worker-session plane and private provider sockets. The CLI rejects
the former `voice-server` and `pi-split` modes. A separate staging machine or
VM must reproduce this topology with independent PBX routes, credentials,
budgets, state, and ports; do not simulate staging beside the live Hermes
listeners.

## Monitoring

### Health Checks

```bash
# Overall status
claude-phone status

# Comprehensive diagnostics
claude-phone doctor

# Guarded unit and exact project containers
systemctl status teleagent-voice-stack.service
docker container ls --all --filter label=com.docker.compose.project=teleagent-voice
journalctl -u teleagent-voice-stack.service -f

# Realtime readiness and durable-state health
curl -fsS http://127.0.0.1:3000/api/realtime-health

# Emergency-stop status and authenticated operator unlock
npm run voice-control -- status
npm run voice-control -- unlock

# Exact text transcript, jobs, authorization audit, and measured usage
npm run voice-history -- --limit 500
```

The Realtime health response reports only whether signed approval capabilities
are enabled and whether mutating voice jobs are blocked. It never returns a key
ID, key material, capability token, or token digest.

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
- Transcript, authorization audit, and Realtime usage rows are append-only; exported files use mode `0600`
- Realtime callbacks may reopen a voice thread only for the same caller identity
- Never commit `~/.claude-phone/config.json` to version control
- Use environment variables in CI/CD pipelines

### Approval capability status

Production voice approval is disabled. Do not provision or mount an approval
private key or privileged-action bearer into `voice-app`, and do not configure
legacy `VOICE_APPROVAL_*` or privileged proxy enable settings. Voice constructs
its job broker with null issuer/bridge values, so read-only jobs remain
available while mutation, tmux delivery, and privileged work fail closed.

The capability, exact binding, replay, and broker-policy libraries remain
unit-test substrate. Future activation requires an isolated PBX attester that
plays the controller-canonical prompt and durably proves later handset-side
DTMF for the exact request/call leg. A controller-owned authority must validate
and consume that evidence and dispatch internally; neither signer nor
capability may enter voice. Revoke all public trust for the former voice-held
key before relying on this disabled boundary.

### Network Security

- Voice app API (port 3000) should not be publicly exposed without authentication
- Agent API server (port 3333) should only be accessible from the voice server
- Every Claude/Codex profile is read-only from production voice; no profile or
  extension grants deployment or privileged authority
- Non-read-only `phone-*` bridge requests and existing tmux delivery are
  production-blocked; voice has no authority that can create their required
  capability. The future attested design additionally binds tmux approval to a
  stable pane ID and provider-log fingerprint.
- Claude/Codex execution plus filesystem/Git/tmux inspection requires the
  worker-session broker, separate provider supervisors/workers, and private
  egress identities. There is no persistent shared worker home and no
  controller-UID execution fallback. Owner/alborz sessions such as
  `main:phone` are intentionally out of scope.
- The Realtime model has bounded read-only inspection tools, not arbitrary
  shell or HTTP access. Credential paths and secret-like filenames are denied.
- Root actions remain unavailable to phone. The dormant private broker and
  future typed-policy substrate are documented in
  [`docs/PRIVILEGED-ACTIONS.md`](../docs/PRIVILEGED-ACTIONS.md). Never mount its
  Unix socket into voice-app or add the public SIP identity to `teleagent-control`.
- Dial `9` from the authenticated owner handset to persistently lock all new
  phone-originated dispatch and terminate every tracked phone-originated agent
  process group. Unlock only from the local operator CLI after reviewing logs.
- Give every profile a narrow working directory even though production phone execution forces all Codex tiers to `read-only`
- The bridge removes SIP, speech, and bridge-control secrets from Codex child environments. This reduces accidental inheritance but is not a host-level secret boundary when the service account can read the underlying files.
- Consider VPN for split deployments across networks

### SIP Security

- Use strong passwords for SIP extensions.
- The local Asterisk/voice trust boundary uses mutual SIP Digest. IP or
  loopback origin is never sufficient: every inbound assistant INVITE is
  authenticated before caller identity, device, thread, audio, or approval
  state is read, and every callback carries a separate credential only after
  the exact configured PBX host, port, and transport are revalidated.
- The deployed Asterisk 20.6/PJProject 2.13 peer supports MD5 Digest, not RFC
  7616 SHA-256. The shared values are therefore random 256-bit credentials (not
  human passwords), with one-use nonces, `qop=auth`, a short nonce lifetime,
  and timing-safe verification. Keep the provider and host-local network
  fences; Digest authenticates the peer but does not encrypt signaling.
- Provision two distinct credentials with `openssl rand -hex 32`. Store them in
  untracked root-owned files, mode `0440`, whose group is exactly the voice
  runtime GID. Provider worker UIDs must not be members of that group. Set both
  `SIP_TRUNK_*_PASSWORD_HOST_FILE` values in the Teleagent and Asterisk Compose
  interpolation files. Missing values are hard Compose errors.
- Never place either trunk password in `.env`, PJSIP templates, dialplan
  headers, process arguments, or logs. Asterisk renders a mode-`0600` include
  in `/run/asterisk`; voice-app reads fixed read-only mounts before opening any
  SIP or HTTP listener.
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
4. Inspect `journalctl -u teleagent-voice-stack.service` and the exact
   `teleagent-voice` project container logs for Realtime session errors; do not
   start or recreate containers manually

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
