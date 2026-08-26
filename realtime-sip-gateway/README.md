# OpenAI Realtime SIP gateway canary

This directory is an isolated, **not deployed** native-SIP canary for Teleagent. It receives a
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

The tests use injected SDK and WebSocket fakes and make no OpenAI API calls.

Starting the server requires real, server-side credentials:

```bash
cp .env.example /secure/location/realtime-sip-gateway.env
node --env-file=/secure/location/realtime-sip-gateway.env src/index.js
```

Do not put the real environment file in this repository. Direct secret environment variables are
supported for local development only. Production loads `OPENAI_API_KEY`,
`OPENAI_WEBHOOK_SECRET`, and `SIP_PBX_AUTH_SECRET` from hardened absolute files or systemd's
`$CREDENTIALS_DIRECTORY`. Accept mode refuses to start without the PBX credential. The example service in
[`deploy/realtime-sip-gateway.service.example`](deploy/realtime-sip-gateway.service.example)
uses `LoadCredential`, an absent-by-default activation sentinel, and the dedicated,
public-edge-only `teleagent-sip-gateway` identity.

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
