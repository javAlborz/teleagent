# Extension-70 native SIP canary runbook

This is an integration plan, not evidence that the canary is deployed. Keep extensions 7/77 and
the existing drachtio/FreeSWITCH media path unchanged until every acceptance item passes.

## 1. Establish the controller boundary

Before adding public ingress:

1. Create a dedicated `teleagent-sip-gateway` system identity with no login shell, sudo, Docker,
   SSH-agent, or agent-worker group membership.
2. Install the authenticated release at `/opt/teleagent/current`; the component path is
   `/opt/teleagent/current/realtime-sip-gateway`, owned by root and not writable by the service
   user.
3. Provision a reviewed root-owned Node 24+ binary at
   `/usr/local/libexec/teleagent-node`. The candidate is the existing Node 24.13.0 runtime copied
   as an ordinary root-owned, non-group/world-writable file after recording its version and
   checksum. Do not execute the owner's NVM path at runtime: it is intentionally inaccessible
   under `ProtectHome=true`.
4. Provision an exact dedicated durable local filesystem at
   `/var/lib/teleagent-sip-gateway`. It must be 1-4 GiB, use ext4/XFS/Btrfs/F2FS/ZFS, have a
   different device from `/var/lib`, be owned by `teleagent-sip-gateway`, mode `0700`, and have at
   least `max(20%, 512 MiB)` free. The component installer deliberately does not format or mount
   storage; the authenticated host handoff must establish and persist this mount first.
5. Build `/etc/teleagent/realtime-sip-gateway/config.env` from `.env.example`, owned by root and
   mode `0600` in its mode-`0700` parent. Keep only unique, unquoted, nonempty assignments from the
   fixed non-secret allowlist. Unknown/duplicate keys, loader or Node hooks, direct secrets,
   `*_FILE`, credential-directory, state-boundary, and custom-endpoint overrides refuse activation.
   Put `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`, and a
   separately generated 32+-random-byte `SIP_PBX_AUTH_SECRET`, encoded as 43-128 base64url
   characters (64 hex characters is suitable), in distinct root-owned
   mode-`0400` source files and pass them with systemd `LoadCredential`.
6. Confirm Codex/Claude worker identities cannot read those credential sources, the systemd
   credential directory, the SQLite state database, or the controller process environment.

Run the component installer only after the external release-v2 authentication gate and exact mount
provisioning:

```bash
/opt/teleagent/current/realtime-sip-gateway/deploy/teleagent-realtime-sip-gateway-install --source-check
# exact stdout: SIP_GATEWAY_SOURCE_OK
/opt/teleagent/current/realtime-sip-gateway/deploy/teleagent-realtime-sip-gateway-install --install-disabled
# exact stdout: SIP_GATEWAY_INSTALLED_DISABLED
/usr/local/libexec/teleagent-realtime-sip-gateway-install --check
# exact stdout: SIP_GATEWAY_INSTALLED_DISABLED_OK
```

The installer is independently idempotent and transactionally publishes its six policy assets. It installs
only a static, inactive `teleagent-realtime-sip-gateway.service`, identity/directory policy,
manifest, verifier, and itself. It never creates configuration, credentials, or
`/etc/teleagent/realtime-sip-gateway/ENABLE`, and it never enables, starts, or restarts the unit.
Any active/transitional unit, systemd query failure, identity collision, metadata drift, ordinary
root-backed state directory, out-of-range filesystem, or exhausted reserve fails closed.
Its pre-runtime source check uses only the authenticated `<release-root>/runtime/node/bin/node`;
installed modes use only `/usr/local/libexec/teleagent-node`. Release orchestration separately
requires exact `SIP_GATEWAY_SOURCE_OK` and `SIP_GATEWAY_IDENTITY_SOURCE_OK` attestations.

Fresh disabled installation accepts only an objectively empty exact mount (an empty root-owned
`lost+found` is the sole filesystem exception). It creates zero-length, service-owned mode-`0600`
main and lifetime-lock database files with no-replace opens and fsync, then atomically publishes
the root-owned mode-`0444` `STATE_INITIALIZED` marker in the protected config directory. That
marker binds the mount device, fixed paths, inode birth identity, and service UID/GID. A reinstall
preserves a marked nonempty ledger. Missing/replaced files, marker drift, or nonempty unmarked state
refuses and requires explicit recovery; the installer never treats loss of durable truth as a new
deployment.
The marker is also a read-only service credential. Runtime rebinds both fixed database paths to its
device/inode/birth/owner identity immediately around the native SQLite opens; the singleton's
checked descriptor remains open through its SQLite open and is revalidated before the exclusive
lock is acquired.

## 2. Start in reject mode on loopback

Keep these settings initially:

```dotenv
SIP_GATEWAY_HOST=127.0.0.1
SIP_GATEWAY_PORT=3107
SIP_GATEWAY_MODE=reject
SIP_MAX_ACTIVE_CALLS=1
SIP_MAX_HTTP_CONNECTIONS=32
```

The reviewed unit alone fixes the state boundary, database path, and marker credential. Do not
repeat or override them in `config.env`.

Check locally:

```bash
curl --fail --silent http://127.0.0.1:3107/healthz
```

Expected: HTTP 200 with `"mode":"reject"`. Never paste secrets into a shell command, unit, or
environment file; load them through the service credential directory.

Activation is a separate operator-controlled step after `--check`: provision the root-owned
mode-`0600` non-secret `config.env`, the three root-owned mode-`0400` single-link credential source
files, and finally a root-owned mode-`0600` regular single-link `ENABLE` sentinel. Only then may the
static unit be started explicitly. Its `--activation-check` preflight verifies those metadata,
identity, state marker/files, mount bounds, and reserve without reading credential contents. Remove
the sentinel to make a later start fail closed; the installer never creates or removes it.
Preflight also proves the loaded systemd fragment is the exact static installed unit, with no
pending daemon reload or drop-ins and the dedicated user/group. The unit removes reviewed
loader/Node/proxy/direct-secret/file-override variables after loading `config.env`, before the
privileged verifier starts. Protected peer roots use fail-closed `InaccessiblePaths=`; provision
them first or activation intentionally refuses instead of silently omitting a mask.

The gateway returns HTTP 503 for health and for a genuinely new signed webhook after free space
falls below `max(20%, 512 MiB)`. Exact already-admitted webhook/call retries and recovery,
`outcome_unknown`, hangup-confirmation, cancellation, and closure writes continue below the
admission reserve. Restore headroom before admitting new calls; do not remove durable rows merely
to turn health green.

The service also creates a mode-`0600` lifetime-lock database beside the configured state
database. Do not delete or rotate that file during service operation. A second process using the
same state path must fail before it initializes state, attaches sideband, accepts, rejects, or
hangs up a call. The SQLite kernel lock is released automatically when the owning process exits,
including after `SIGKILL`; only then may one replacement recover the durable call state.
During graceful stop, the process releases the lock only after its HTTP listener, every call and
sideband, and the state database have conclusively quiesced. If shutdown reports an error, the
process remains non-listening, retains ownership, and may retry cleanup; do not start a replacement
or remove the lock file. If cleanup cannot be proven, terminate the fenced process and let the one
replacement perform durable startup recovery.

## 3. Publish only the webhook

Create a narrow public HTTPS route whose only upstream is:

```text
POST /webhooks/openai -> http://127.0.0.1:3107/webhooks/openai
```

Recommendations:

- Keep `/healthz` private.
- Do not place an interactive Cloudflare Access login in front of the webhook; OpenAI cannot
  complete it. Authenticity is enforced by the OpenAI webhook signature.
- Preserve the request body byte-for-byte and retain the `webhook-id`, `webhook-timestamp`, and
  `webhook-signature` headers.
- Set a request-body limit no larger than the application limit and disable proxy retries of POST
  requests unless their duplicate semantics are understood.
- Add a rate-limiting rule scoped exactly to `POST /webhooks/openai`. Start with a log-only action,
  measure legitimate signed test-event/retry bursts in Security Events, and set the threshold above
  that measured envelope before changing the action to block. Do not guess a threshold or count
  `/healthz` and unrelated hostnames in the same rule.
- Before activation, prove an unsigned burst is limited at the edge while a bounded signed retry
  burst reaches the application. Keep edge and origin logs metadata-only: never retain request
  bodies, `webhook-signature`, SIP headers, authorization headers, or credential values. Set a
  reviewed retention/volume budget and alert before aggregate security-event or journal volume can
  exhaust storage.
- Do not expose the Node listener on a public or Tailscale-wide bind address.

Create an OpenAI project webhook subscribed to `realtime.call.incoming`, install its signing secret
once in the root-owned mode-`0400` webhook credential source file used by `LoadCredential`, and
restart the controller. Use the dashboard's signed test-event facility where available. An unsigned
or modified request must return HTTP 400.

## 4. Add the Asterisk route as a canary only

The official destination is:

```text
sip:PROJECT_ID@sip.api.openai.com;transport=tls
```

where the project ID has the `proj_` prefix and belongs to the same project as the webhook and API
key. Add a new outbound TLS transport and extension **70** in the infrastructure repository.
Do not change 7, 77, 9, or the legacy 1-6 routes.

On that outbound extension-70 leg, first strip any caller-supplied
`X-Teleagent-PBX-Auth` header, then inject the private credential from an Asterisk-owned secret
source. Never place the credential in dialplan source, CLI output, ordinary environment files, or
logs. Asterisk must not forward this header anywhere except the reviewed OpenAI canary trunk.

Use current OpenAI SIP documentation when setting firewall rules. Signaling uses outbound TLS on
port 5061 and media has separately documented address/port ranges; do not copy stale IP ranges
from this file. Preserve extension 9 as a local Asterisk panic path that does not depend on OpenAI.

Place a call while the gateway is still in reject mode. Confirm:

- the webhook signature verifies;
- the call ID and sanitized lifecycle appear in controller logs;
- the Calls API rejects the call with the configured SIP status;
- a repeated `webhook-id` does not invoke rejection twice;
- no controller secret reaches logs or agent workers, and the PBX credential appears only on the
  protected outbound SIP leg.

Capture the exact signed webhook's `From` and `To` values for routing filters. Put the expected
`From` into `SIP_ALLOWED_FROM`; optionally put the extension-70 destination into `SIP_ALLOWED_TO`.
These values are spoofable and never establish identity. Before accept mode, use signed webhook
fixtures to prove that a missing, wrong, duplicated, or caller-injected PBX credential rejects with
403 while the configured credential binds only the local `SIP_PBX_PRINCIPAL` to durable call state.

## 5. Enable one accepted canary call

After reviewing the allowlist, set:

```dotenv
SIP_GATEWAY_MODE=accept
SIP_ALLOWED_FROM=<exact signed webhook From value>
SIP_ALLOWED_TO=<exact signed webhook To value, if stable>
SIP_PBX_PRINCIPAL=hermes-private-pbx
```

`SIP_PBX_AUTH_SECRET` must come from `LoadCredential`; do not add it to the environment file.

Restart and verify `/healthz` before placing one call. The test matrix is:

| Test | Pass condition |
|---|---|
| Inbound audio | Caller speech is understood without the custom PCM bridge |
| Outbound audio | Greeting and responses are audible once, without clipping |
| Barge-in | Caller speech interrupts output cleanly |
| DTMF `#` | One `dtmf` event with digit `#`; no action is executed |
| DTMF `*` | One `dtmf` event with digit `*`; no action is executed |
| DTMF `9` | Asterisk local panic route remains independent; do not rely on sideband `9` |
| Normal hangup | Sideband closes and active-call count returns to zero |
| Sideband failure | Accepted call is hung up rather than continuing without control |
| Duplicate webhook | No second call action occurs |
| Capacity | A second concurrent call is rejected with 486 |
| Crash after accept intent | Restart never calls accept again; it conservatively hangs up |
| Restart after confirmed accept | Exact `call_id` sideband adoption succeeds, or call is hung up |
| Unknown remote outcome | Health is degraded and the call continues consuming capacity |
| Durable dedupe | Completed webhook IDs and call close survive process restart |
| Privacy | No raw transcript, SIP header collection, DTMF digit, or secret appears in default logs |

Record first-audio latency, interruption latency, call duration, Realtime tokens/minute, and any
missing or renamed raw events. These observations determine whether the official Agents SDK
transport is useful for the next iteration.

## 6. Connect orchestration only after media passes

The first controller integration should consume `raw_event` and `dtmf` in process. It must not add
shell tools directly to the Realtime session. Route caller turns into the deterministic state
reducer, and bind `#` approval to a signed, one-time capability for one already-focused job.

Do not migrate extension 7/77 until the separate controller/worker/privileged-executor boundary
and durable executor protocol are operational.

## Rollback

1. Return `SIP_GATEWAY_MODE` to `reject`.
2. Remove or disable only extension 70's Asterisk route.
3. Remove the public webhook route or disable the OpenAI webhook subscription.
4. Keep extension 9 and all existing routes unchanged.
5. Preserve the SQLite state database and sanitized logs for diagnosis; rotate the webhook or PBX
   secret if either may have been exposed.

## Durable-state archival and compaction (not yet implemented)

There is intentionally no automatic delete or VACUUM path in this canary. The dedicated mount and
admission reserve contain disk exhaustion without discarding crash truth. Until a separately
reviewed P2 archival tool exists, preserve the entire ledger.

The only candidate rows for future offline archival are completed non-call/ignored webhooks older
than the measured OpenAI retry horizon, and call/webhook pairs whose call is `rejected` or `closed`,
has `hangup_confirmed=1`, and whose webhook is completed. Never compact `verified`, `processing`,
active, `outcome_unknown`, hangup-unconfirmed, or otherwise unresolved rows. Stop the static unit,
prove no lifetime-lock owner, copy the candidate rows to an immutable hashed archive, test restore,
then delete the call/webhook pair in one transaction and checkpoint incrementally. A retention
window must be based on documented or measured provider retry behavior, not an assumed number of
days.
