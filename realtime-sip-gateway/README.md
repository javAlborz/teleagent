# OpenAI Realtime SIP gateway canary

This directory is an isolated, **not activated** native-SIP canary for Teleagent. It receives a
signed OpenAI `realtime.call.incoming` webhook, accepts or rejects the call, and attaches a
server-side WebSocket to the existing Realtime call by `call_id`. OpenAI carries the SIP media;
this process receives control events, including raw Realtime events and SIP DTMF.

It does not modify or replace `voice-app`, FreeSWITCH, drachtio, the agent bridge, Asterisk, or
the current extension routes. Nothing in this package makes extension 70 or 7 live.

Official references used for the implementation:

- [Realtime API with SIP](https://developers.openai.com/api/docs/guides/realtime-sip)
- [Webhooks and server-side controls](https://developers.openai.com/api/docs/guides/realtime-server-controls)
- [Webhook signature verification](https://developers.openai.com/api/docs/guides/webhooks)
- [Agents SDK SIP transport](https://openai.github.io/openai-agents-js/guides/voice-agents/transport/)

## Data flow

```text
Asterisk extension 70
       | SIP/TLS + RTP + private X-Teleagent-PBX-Auth header
       v
OpenAI Realtime SIP
       | signed HTTPS webhook: realtime.call.incoming
       v
realtime-sip-gateway (loopback listener behind HTTPS ingress)
       | accept/reject through OpenAI API
       | sideband WSS by call_id
       v
raw lifecycle / DTMF events for a future deterministic controller
```

The package deliberately uses the official `openai` JavaScript SDK for webhook verification and
call lifecycle operations, and `ws` for the low-level sideband shown in the official SIP guide.
`better-sqlite3` provides the local synchronous transaction boundary required before any remote
call action.
It does not use the Agents SDK yet: the canary needs unmodified raw events and has no agent/tool
surface. If it later becomes a full Realtime agent, `OpenAIRealtimeSIP` is the supported upgrade
path.

## Safety defaults

- `SIP_GATEWAY_MODE=reject` is the default. Every valid incoming call is rejected through the
  Realtime Calls API until an operator explicitly selects `accept`.
- Accept mode requires a PBX-only, high-entropy 43-128-character base64url/hex
  `X-Teleagent-PBX-Auth` SIP header verified with a
  timing-safe comparison. Its secret is loaded from hardened secret configuration, is never
  persisted, and is independent of spoofable `From`/`To` values.
- `From` and `To` remain optional exact routing filters. `SIP_ALLOW_ALL_CALLERS=true` disables the
  default `From` routing filter; it never bypasses PBX authentication.
- One active call is allowed by default.
- Public HTTP concurrency is independently bounded to 32 sockets by default; the reviewed edge
  must impose a narrower path/method rule and a separately observed rate limit before promotion.
- The HTTP listener binds to `127.0.0.1`; a reviewed HTTPS proxy or tunnel must be added
  separately.
- The raw request body is verified with `client.webhooks.unwrap()` before it is parsed or acted
  upon.
- Verified webhook metadata, authenticated PBX principal, call admission, remote-action intents,
  sideband state, and call closure are persisted in a mode-`0600` SQLite database using WAL and
  `synchronous=FULL`.
- Production accepts only `/var/lib/teleagent-sip-gateway/gateway-state.sqlite3` on the exact
  service-owned `/var/lib/teleagent-sip-gateway` mount. The reviewed durable local filesystem must
  be 1-4 GiB and must not share a device with `/var/lib`.
- Startup and every genuinely new webhook or call row require at least the greater of 20% free or
  512 MiB. At that reserve the health endpoint and new signed deliveries return HTTP 503, while an
  exact already-admitted retry and crash-truth, cancellation, hangup, and closure updates remain
  writable. Capacity refusal never marks the SQLite database corrupt.
- Before opening that state or performing recovery, the gateway acquires a separate mode-`0600`
  SQLite lifetime lock in the private state directory. A duplicate process cannot inspect, adopt,
  or hang up the live owner's call; a crash releases the kernel lock so exactly one replacement can
  recover.
- Graceful shutdown releases that lifetime lock only after the HTTP listener, call/sideband
  gateway, and SQLite state have each proven quiescence. An ambiguous cleanup leaves the app
  permanently non-listening but retryable and retains the lock until a later successful cleanup or
  process death; a replacement can never start alongside uncertain resources.
- `accept_intent` is committed before the remote accept. A restart never repeats an ambiguous
  accept: it either adopts an already accepted call through the exact `call_id` sideband or
  attempts a conservative hangup and retains `outcome_unknown` if termination cannot be confirmed.
- API and WebSocket endpoints are pinned to the official OpenAI hosts unless a separate escape
  hatch is explicitly enabled.
- Raw events, transcripts, SIP headers, authorization headers, secrets, and DTMF digits are not
  logged. Consumers may subscribe to raw events in process.
- The health endpoint exposes counts and mode, not call IDs or credentials.
- Empty and obvious `example`, `test`, `changeme`, `replace-with`, `dummy`, and placeholder
  credentials fail startup before the listener binds.

## Install and test

Node 24 or later is required. The package lock records the exact installed `openai`, `ws`, and
`better-sqlite3` dependency graph.

```bash
cd /home/alborz/phone/teleagent/realtime-sip-gateway
npm ci
npm test
npm run test:coverage
```

The tests use injected SDK, WebSocket, filesystem, identity, and systemd fakes and make no OpenAI
API calls or host service changes.

On a dedicated host, the operator-facing installation surface is the fixed
infrastructure-owned handoff:

```bash
sudo /usr/bin/env -i HOME=/var/empty PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  /usr/local/libexec/teleagent-staging-handoff --source-check
# TELEAGENT_STAGING_SOURCE_OK
sudo /usr/bin/env -i HOME=/var/empty PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  /usr/local/libexec/teleagent-staging-handoff --install-disabled
# TELEAGENT_STAGING_INSTALLED_DISABLED_OK
sudo /usr/bin/env -i HOME=/var/empty PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  /usr/local/libexec/teleagent-staging-handoff --check
# TELEAGENT_STAGING_INSTALLED_DISABLED_OK
```

The handoff invokes the source-owned component modes only through the canonical
`/opt/teleagent/releases/sha256-*` root authenticated by the external approval.
The installed component-installer copy accepts only `--check`; it refuses
`--source-check` and `--install-disabled`. Never invoke an installer through
`/opt/teleagent/current`.

`--install-disabled` requires the exact durable mount to have been provisioned already. It installs
the root-owned static unit, sysusers/tmpfiles policy, verifier, manifest, and installer, but never
creates `ENABLE`, configuration, or credentials and never enables, starts, or restarts the unit.
All component modes reject source/installed drift; install and check also reject an active,
transitional, enableable, or unverifiable unit.
Source check executes the source verifier with only the authenticated immutable
`<release-root>/runtime/node/bin/node`; it never selects an owner's Node, `PATH` entry, or caller
override. The installed check requires `/usr/local/libexec/teleagent-node`.

On a fresh objectively empty mount, disabled installation creates the zero-length main and lifetime
lock database files with no-replace opens, service ownership, mode `0600`, and file/directory fsync,
then publishes the root-owned mode-`0444`
`/etc/teleagent/realtime-sip-gateway/STATE_INITIALIZED` marker. The marker binds both fixed paths,
mount device, inode birth identity, and service UID/GID. Systemd also supplies it to the service as
a read-only credential; the runtime compares it immediately before and after both path-only SQLite
opens. The singleton keeps its checked descriptor through the native open and rechecks it before
acquiring the SQLite lock. Reinstallation preserves marked nonempty state. A missing/replaced
database, tampered marker, or nonempty unmarked mount refuses instead of silently constructing a
fresh ledger. The remaining native SQLite path-open window is limited to a same-UID race inside the
API; the unique service identity and mode-`0700` mount exclude other host identities, and both
surrounding checks fail closed.

`.env.example` is the production-compatible template for the root-owned non-secret `config.env`.
It deliberately contains no secrets, file overrides, loader/Node hooks, credential-directory,
state-boundary, or custom-endpoint overrides. Activation accepts only its fixed non-secret keys as
unique, unquoted, nonempty, single-line assignments. Unknown, duplicate, malformed, loader,
credential, and boundary assignments fail closed. Direct secret environment variables are
supported for isolated local tests only. Production loads `OPENAI_API_KEY`,
`OPENAI_WEBHOOK_SECRET`, and `SIP_PBX_AUTH_SECRET` from hardened absolute files or systemd's
`$CREDENTIALS_DIRECTORY`. Accept mode refuses to start without the PBX credential. The static
[`teleagent-realtime-sip-gateway.service`](deploy/teleagent-realtime-sip-gateway.service) uses
`LoadCredential`, the absent-by-default `/etc/teleagent/realtime-sip-gateway/ENABLE` sentinel,
bounded CPU/memory/swap/tasks/file size, and the dedicated public-edge-only
`teleagent-sip-gateway` identity. Its root-only activation preflight revalidates the installed
policy, identity, initialized state, exact mount/reserve, sentinel, non-secret config, and credential
metadata without reading credential contents. A final `UnsetEnvironment=` removes loader, Node,
proxy, direct-secret, and secret-file override variables before privileged preflight. Activation
also binds the loaded static fragment to the exact installed unit, with no pending daemon reload or
drop-ins. The service mount namespace makes controller, worker/provider, privileged-action, voice,
and workspace state/runtime/config roots inaccessible. These masks are fail-closed: every protected
peer path must exist before activation, even when its peer unit is dormant.

The first systemd start command is the external host-owned
`verify-teleagent-release-closure --check-start-gate`, invoked with an empty
environment before the gateway's activation verifier. It cheaply binds the
start to current-boot approval, the selected release/manifest identity, and
installed runtime metadata; it never performs the serialized handoff's full
release scan or binary content hashing. The next root-only fixed-verifier
profile reauthenticates the projected gate and live selection, retains the
shared handoff lock in both parent and child, and runs the immutable activation
verifier through the selected release's bundled Node. The ordinary gateway
start independently repeats gate and lock validation.

The release authentication closure must bind `package.json`, `package-lock.json`, every runtime
import (`src/app.js`, `call-gateway.js`, `call-registry.js`, `config.js`, `gateway-singleton.js`,
`gateway-state-store.js`, `http-server.js`, `index.js`, `logger.js`, `openai-call-service.js`,
`sideband-session.js`, `sip-event.js`, `state-storage-boundary.js`, and `webhook-handler.js`), plus
the unit, sysusers, tmpfiles, verifier, component manifest, and installer under `deploy/`. The
component manifest pins every installed/root-executed policy asset including the installer; the
external release manifest binds the component manifest itself.

The ledger currently has no automatic retention job. Do not delete or VACUUM it under pressure.
Active, processing, `outcome_unknown`, and hangup-unconfirmed records are durable safety truth.
Archival/compaction is a P2 follow-up limited to completed ignored webhook rows older than a
reviewed provider retry horizon, plus `rejected` or `closed` calls with confirmed hangup and their
completed webhook rows. It must run offline, archive and hash rows first, prove restore, delete
call/webhook pairs in one transaction, and preserve the configured reserve throughout.

## HTTP surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Secret-free health, mode, and aggregate call counts |
| `POST` | `/webhooks/openai` | Signed OpenAI webhook receiver; JSON raw body only |

There is intentionally no unauthenticated call-list, event-stream, mode-change, hangup, or tool
endpoint.

## In-process event surface

`CallGateway` emits:

- `raw_event`: `{ callId, event }` for every parsed Realtime server event.
- `dtmf`: `{ callId, digit, receivedAt, rawEvent }` for SIP keypad events.
- `call_closed`: the sideband close lifecycle event.

DTMF is observation-only. In particular, `#`, `*`, and `9` do not approve, cancel, or execute
anything in this canary. Those meanings must be attached later by the deterministic Teleagent
state reducer, with extension 9 remaining independently enforced at Asterisk.

## Integration

See [`docs/CANARY-RUNBOOK.md`](docs/CANARY-RUNBOOK.md). The remaining work outside this isolated
package is:

1. deploy it under a dedicated, non-sudo controller identity;
2. publish only the webhook path through signed HTTPS ingress;
3. create the project webhook subscription;
4. add an Asterisk TLS SIP route for extension 70 only;
5. permit the currently documented OpenAI SIP signaling/media network paths;
6. connect raw DTMF/lifecycle events to the new deterministic controller;
7. run the canary matrix before changing extensions 7/77.

## Known API and delivery uncertainties

- The official API does not document an exactly-once guarantee or a separate read-only status
  probe for call acceptance. The gateway therefore commits intent before the remote call and never
  blindly re-accepts an ambiguous call. Records known to have passed accept use only the documented
  exact-`call_id` sideband attachment as an adoption attempt; failure goes to conservative hangup
  and, if hangup cannot be confirmed, durable `outcome_unknown` that continues consuming capacity.
- The sideband WebSocket closing is treated as the authoritative end of the control connection.
  A separate terminal server event is not assumed.
- OpenAI documents that `sip_headers` are delivered, but propagation of the private PBX header and
  exact Asterisk normalization must still be proven in the extension-70 spike. Accept mode must not
  be promoted until missing, wrong, duplicated, and caller-supplied credential-header cases all
  reject. `From`/`To` observations are routing data only.
- SIP call acceptance supports only a subset of turn-detection tuning. This canary uses semantic
  VAD with interruption and does not send the unsupported threshold, prefix-padding, or
  silence-duration fields called out by the current Agents SDK documentation.
- No real-account acceptance, DTMF, RTP, barge-in, or hangup test has been performed by this
  offline test suite.
