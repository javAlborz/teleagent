# Outbound Calling API

API reference for initiating outbound calls from Claude Phone.

## Overview

The outbound calling API allows your server to call phone numbers and deliver messages. Use cases:

- Server alerts ("Your disk is 95% full")
- Automated notifications
- Two-way conversations triggered by events

## Authentication

`OUTBOUND_API_TOKEN` is mandatory, must be a clean random value of at least 32
bytes, and protects outbound control routes exclusively through
`Authorization: Bearer <token>`. Legacy `X-API-Key` credentials are rejected.

The HTTP API defaults to `127.0.0.1`. Binding it elsewhere is refused unless
`OUTBOUND_API_NON_LOOPBACK_ENABLED=true` is explicitly reviewed and configured.

## Hermes Local PBX Note

On Hermes, outbound calls to the local Asterisk trunk use the exact route
`SIP_TRUNK_HOST=127.0.0.1`, `SIP_TRUNK_PORT=5060`, and
`SIP_TRUNK_TRANSPORT=udp`. All three values are required and validated before
the voice process opens SIP or HTTP. The API deliberately rejects `dialUri`:
neither a caller nor an inbound SIP `Contact` header may override the configured
PBX authority or steer device digest credentials to another host.
The callback request always uses the dedicated `teleagent-voice` SIP Digest
credential loaded from the fixed read-only trunk-secret mount. Device
registration credentials are never reused. Asterisk-to-voice assistant INVITEs
use a different `teleagent-asterisk` credential and are authenticated before
any call state is created.

## Endpoints

### POST /api/outbound-call

Initiate an outbound call.

**Request:**

```json
{
  "idempotencyKey": "automation-run-20260825-0001",
  "to": "+15551234567",
  "message": "Hello from your server",
  "mode": "announce",
  "device": "Morpheus",
  "callerId": "+15559876543",
  "timeoutSeconds": 30
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `idempotencyKey` | Yes | Clean unique operation key; must exactly match the `Idempotency-Key` header |
| `to` | Yes | Phone number in E.164 format |
| `message` | Yes | Text to speak (max 1000 chars) |
| `mode` | No | `announce` (default) or `conversation` |
| `device` | No | Device name for voice/personality |
| `callerId` | No | Caller ID to display |
| `timeoutSeconds` | No | Ring timeout 5-120 (default: 30) |

**Response:**

```json
{
  "success": true,
  "queued": true,
  "callId": "abc123-uuid",
  "status": "queued",
  "message": "Call durably queued"
}
```

The request and stable `callId` are persisted before this response. Exact
retries return the same `callId`; the same key with different content returns
`409 idempotency_conflict`. A restart before the dial intent is safely resumed.
A restart after the dial intent is recorded as `outbound_outcome_unknown` and
is never automatically redialed, because SIP delivery may already have begun.
It also creates a persistent recovery barrier: the outbound plane remains
locked and will not claim even previously queued calls until an operator has
verified PBX and media quiescence offline. The barrier cannot be cleared by an
HTTP request or by the voice-control bearer.
Arbitrary status webhook destinations are not accepted. Agent completion
callbacks use the local durable callback outbox and this same idempotent API.
The callback outbox is atomically linked to the stable `callId` in the same DB
transaction as reservation. Queue acceptance is only a handoff—not delivery.
The notification becomes delivered only when the outbound call reaches
`completed`; failed/canceled delivery remains failed and ambiguous delivery
remains `outcome_unknown` without blind redial.

`completed` currently proves the outbound conversation ended normally. It does
not yet prove a dedicated result-specific FreeSWITCH playout marker was heard;
that stronger receipt is tracked as a future hardening item.

### GET /api/outbound-status

Returns the sanitized outbound plane state. During recovery ambiguity it
returns `503`, `recoveryRequired: true`, and only the affected stable call IDs.
Stored messages, context, credentials, and dial URIs are never returned.

### Offline recovery barrier resolution

Do this only after independently confirming that the exact call has no live
PBX dialog or media endpoint. Stop `voice-app`, then run as root against the
mode-`0600` state database:

```bash
sudo npm run outbound-recovery -- \
  --db /absolute/path/to/voice-state.sqlite \
  --call-id <exact-call-id> \
  --confirm PBX_AND_MEDIA_QUIESCENCE_VERIFIED
```

The command takes the same process-lifetime owner fence used by `voice-app`, so
it refuses to run while a dial worker is active. It clears only the named
barrier, leaves the call itself `outcome_unknown`, and appends a high-risk audit
record. There is deliberately no network equivalent of this operation.

### GET /api/call/:callId

Get status of a specific call.

**Response:**

```json
{
  "success": true,
  "data": {
    "callId": "abc123-uuid",
    "to": "+15551234567",
    "state": "completed",
    "mode": "announce",
    "createdAt": "2025-01-01T12:00:00.000Z",
    "answeredAt": "2025-01-01T12:00:05.234Z",
    "endedAt": "2025-01-01T12:00:15.678Z",
    "duration": 10
  }
}
```

### GET /api/calls

List the most recent durable call records (up to 100).

**Response:**

```json
{
  "success": true,
  "count": 2,
  "calls": [
    { "callId": "...", "to": "...", "state": "playing" },
    { "callId": "...", "to": "...", "state": "dialing" }
  ]
}
```

### POST /api/call/:callId/hangup

Durably cancel a queued call or request teardown of an active call. A queued
cancellation is an atomic tombstone, so it cannot race into the dial worker.
An active cancellation returns `202` until SIP/media teardown is confirmed.

**Response:**

```json
{
  "success": true,
  "message": "Call hangup initiated",
  "callId": "abc123-uuid"
}
```

## Call States

| State | Description |
|-------|-------------|
| `queued` | Call created, not yet dialing |
| `dialing` | SIP INVITE sent, waiting for answer |
| `playing` | Call answered, playing message |
| `cancel_requested` | Cancellation persisted; teardown confirmation pending |
| `canceled` | Cancellation and local SIP/media teardown confirmed |
| `completed` | Call finished successfully |
| `failed` | Call failed (busy, no answer, error) |
| `outcome_unknown` | A post-intent crash or teardown ambiguity prevents a safe retry |

## Call Modes

### Announce Mode (Default)

Plays the message and hangs up:

```bash
curl -X POST http://localhost:3000/api/outbound-call \
  -H "Authorization: Bearer $OUTBOUND_API_TOKEN" \
  -H "Idempotency-Key: alert-run-0001" \
  -H "Content-Type: application/json" \
  -d '{
    "idempotencyKey": "alert-run-0001",
    "to": "+15551234567",
    "message": "Alert: Your server storage is at 95 percent."
  }'
```

### Conversation Mode

Plays the message, then allows back-and-forth conversation:

```bash
curl -X POST http://localhost:3000/api/outbound-call \
  -H "Authorization: Bearer $OUTBOUND_API_TOKEN" \
  -H "Idempotency-Key: conversation-run-0001" \
  -H "Content-Type: application/json" \
  -d '{
    "idempotencyKey": "conversation-run-0001",
    "to": "+15551234567",
    "message": "Alert: Your server storage is at 95 percent. Would you like me to clean up old logs?",
    "mode": "conversation",
    "device": "Morpheus"
  }'
```

## Error Responses

```json
{
  "success": false,
  "error": "Invalid phone number format"
}
```

| Error | Cause |
|-------|-------|
| `Invalid phone number format` | `to` not in E.164 format |
| `Message is required` | Missing `message` field |
| `Message too long` | Message exceeds 1000 chars |
| `Call not found` | Invalid `callId` |
| `service_unavailable` | SIP/media server not ready |

## Failure Reasons

When a call fails, the `reason` field indicates why:

| Reason | Description |
|--------|-------------|
| `busy` | Recipient busy (SIP 486) |
| `no_answer` | No answer within timeout (SIP 480/408) |
| `not_found` | Number not found (SIP 404) |
| `rejected` | Call rejected (SIP 603) |
| `service_unavailable` | Server error (SIP 503) |

## Examples

### Basic Alert

```bash
curl -X POST http://localhost:3000/api/outbound-call \
  -H "Authorization: Bearer $OUTBOUND_API_TOKEN" \
  -H "Idempotency-Key: backup-run-0001" \
  -H "Content-Type: application/json" \
  -d '{
    "idempotencyKey": "backup-run-0001",
    "to": "+15551234567",
    "message": "Your backup job completed successfully."
  }'
```

### Check Status

```bash
# Get call status
curl -H "Authorization: Bearer $OUTBOUND_API_TOKEN" \
  http://localhost:3000/api/call/abc123-uuid

# List all active calls
curl -H "Authorization: Bearer $OUTBOUND_API_TOKEN" \
  http://localhost:3000/api/calls
```

## Integration Examples

### Home Assistant

```yaml
rest_command:
  call_alert:
    url: "http://VOICE_SERVER:3000/api/outbound-call"
    method: POST
    headers:
      Authorization: "Bearer YOUR_OUTBOUND_API_TOKEN"
      Idempotency-Key: "{{ idempotency_key }}"
    content_type: "application/json"
    payload: '{"idempotencyKey": "{{ idempotency_key }}", "to": "+15551234567", "message": "{{ message }}"}'
```

### Automation Note

`/api/query` is no longer part of `voice-app`.

Automation that wants to call you should invoke `/api/outbound-call` directly after making its own decision about whether a call is needed.

### Shell Script

```bash
#!/bin/bash
PHONE="+15551234567"
MESSAGE="Disk space critical on server1"
IDEMPOTENCY_KEY="$(uuidgen)"

curl -s -X POST http://localhost:3000/api/outbound-call \
  -H "Authorization: Bearer $OUTBOUND_API_TOKEN" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"idempotencyKey\": \"$IDEMPOTENCY_KEY\", \"to\": \"$PHONE\", \"message\": \"$MESSAGE\"}"
```
