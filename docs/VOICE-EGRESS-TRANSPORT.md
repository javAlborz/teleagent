# Fixed Unix voice egress — dormant source candidate

The voice entrypoint requires a second independent record,
`/run/teleagent-media/voice-egress.json`, after media admission and before any
secret-bearing client. It has no writer here. Both the launcher activation gate
and the infrastructure unit refusal remain. No credential, provider request,
service installation, live mount or route is supplied by this change.

`lib/voice-egress-runtime.js` validates canonical root-owned JSON and every
protected ancestor, requires the same admitted image/media generation and exact
current boot/UID/PID/start/network namespace identity, and binds the approved
TLS CA bundle and independent host listener evidence. The image source closure
now includes the egress consumers, actual pinned ws implementation and Axios
Node adapter as part of the media record's independent approved source list.
The egress record schema is `teleagent.voice-egress-admission.v1`, with exact
fields `generation`, `mediaGeneration`, `imageId`, `identity`, `socketGid`,
`caDigest`, `listenerEvidenceDigest`, and `services`. `services` contains exactly
`realtime`, `tts` and `stt`; each admitted listener is a distinct `{device,inode}`
pair. Speech entries must both be null or both admitted. Their presence must
match the existing legacy-speech opt-in before startup.

Every connect rechecks the record, process/media generation, root-owned socket
directory, actual socket type, root UID/admitted voice GID,0660 mode, single link
and exact inode/device. The fixed paths are:

| Service | Unix path | Application request |
|---|---|---|
| Realtime | `/run/teleagent-voice-egress/realtime.sock` | Verified TLS to `api.openai.com`, WSS `/v1/realtime?model=gpt-realtime-2.1-mini` |
| TTS | `/run/teleagent-voice-egress/tts.sock` | POST `/v1/audio/speech`; optional GET `/v1/audio/voices` |
| STT | `/run/teleagent-voice-egress/stt.sock` | POST `/v1/audio/transcriptions` |

The future host transaction must mount only the exact protected directory,
read-only, into voice-app and admit that sandbox/mount change. Other workloads
receive no socket mount. No DNS, provider route or new IP flow is required in
the voice namespace, and no Compose or volume change is included here.

## TLS and fixed client behavior

The pinned ws client accepts an explicit `createConnection`, while its default
TLS factory clears `socketPath`. Node24 uses a supplied connection factory with
an unset agent; `agent:false` would create a new default agent and defeat it.
`voice-egress-transport.js` therefore keeps `agent:undefined` and constructs
TLS directly over the fixed Unix path. It fixes SNI to `api.openai.com`, enables
certificate verification with standard hostname checking and the admitted CA
roots, requires TLS1.2 or later, and advertises HTTP/1.1 ALPN. The WSS URL,
model, bearer ownership and optional OpenAI headers stay unchanged. Redirects
are explicitly disabled; no TCP fallback, proxy variable, custom caller path
or plaintext ws+unix mode exists. Admission is rechecked before connect and on
TLS completion before HTTP can send the bearer.

TTS reuses Axios with exact `socketPath`, `proxy:false`, zero redirects and the
existing text/audio/time limits. STT replaces the default native fetch transport
with the already pinned Axios Node transport over its separate Unix socket;
it retains the same multipart WAV/model/language/response fields,30-second
timeout and10MiB audio/64KiB response bounds. Multipart overhead is bounded at
64KiB beyond the existing audio maximum. Both use a private HTTP agent capped at
eight sockets with keepalive disabled, which shutdown destroys. Test-only injected fetch behavior
remains available to existing source tests; the entrypoint never injects it.
No speech bearer is introduced. Plain speech HTTP still depends on the
authenticated SSH transit and admitted private backend ownership.

Shutdown synchronously prevents new egress, aborts outstanding speech requests
and destroys tracked TLS sockets. Existing call/broker drain handling remains;
closing a local transport alone does not prove independent provider quiescence,
spend enforcement or an upstream completed cancellation.

## Independent host gates still absent

`listenerEvidenceDigest` must refer to independently reviewed host evidence
binding actual listener process/start/cgroup/source, native relay/SSH tool and
unit closure, destination and DNS policy, socket/mount ownership, resource
admission, retained handles and the durable start/restart/stop generation. An
application stat of a socket cannot prove these properties. No source fixture,
self-reported digest or writable sentinel may create that authority. The record
writer/start handshake and lifetime monitor remain unimplemented and activation
is unconditionally refused.

The paired infra source defines a disabled native `systemd-socket-proxyd` unit
for the exact OpenAI443 target, capped at eight connections. It does not decrypt
TLS, acquire the voice credential, or impose HTTP path/model/duration/spend
limits. Realtime scope and budget commissioning remain explicit prerequisites.
The dedicated SSH speech-forward component stays a detailed dormant contract
because the existing shared-tunnel source does not identify an admitted SSH
key path/account/Hera host-key closure. Neither the shared tunnel nor any
credential/configuration file was modified or read.

Before readiness can become true, commission all listener identities/lifetimes,
the host resolver and image CA trust, aggregate resource limits, bounded enabled
speech health checks through the exact Unix paths, and an authorized bounded
Realtime canary. Socket existence or a local connect is insufficient. Effective
PBX/RTP/handset evidence and the launcher transaction gates remain unchanged.

The focused tests use synthetic protected metadata and temporary local Unix
TLS/HTTP servers with generated test-only certificates. They exercise actual
pinned ws and Axios code, wrong certificates, redirects, absent or changed
authority/socket identity, TLS-time revocation, response bounds and shutdown.
They do not contact OpenAI, Hera, Zeus, Omen or any production listener.
