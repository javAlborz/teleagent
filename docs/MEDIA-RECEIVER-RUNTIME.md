# Isolated receiver consumers — dormant source candidate

The voice entrypoint now waits on a fixed root-owned, group-readable FIFO at
`/run/teleagent-media/voice-start.fifo` before reading runtime admission or
constructing a secret-bearing client. The host must send exactly one canonical
64-hex generation followed by a newline and close the FIFO; the entrypoint
requires the subsequently loaded protected runtime record to name that same
generation. The FIFO and record directory are intended to be mounted read-only
from `/run/teleagent-isolated-voice-stack/admission`. An absent FIFO leaves the
voice entrypoint closed in every mode, and the launcher still refuses activation.
The admitted v2 projection supplies
Drachtio control, FreeSWITCH ESL and fixed reverse ESL, audiofork, generated TTS,
beeps and hold-music URLs. The launcher still refuses activation unconditionally.
No host record writer, authority mint, credential, Docker operation or live
commissioning is supplied by this entrypoint change.

## Independent admission input

`lib/media-receiver-runtime.js` reads only
`/run/teleagent-media/receiver-runtime.json`. Its complete ancestor chain and
regular, single-link file must be root-owned, without group/other write or
symlinks. Canonical JSON prevents duplicate-key and representation ambiguity.
The schema is `teleagent.media-receiver-runtime-admission.v1`; the exact fields
are validated in source:

- `generation`: independent authority's 64-hex lifecycle generation.
- `imageId`, v2 `topologySchema`/`topologyDigest`, `effectivePolicyDigest`, and
  `rendererClosureDigest`: independently admitted SHA-256 identities.
- `identity`: exact boot ID, non-root system UID, namespace-visible PID, process start ticks, and network
  namespace device/inode of the consuming voice process.
- `projection` and `projectionDigest`: the complete reviewed renderer output,
  still with `readyToLaunch: false`, matching the independently admitted topology.
- `approvedRuntimeSources`: exact eighteen-path map named by `REQUIRED_SOURCES`,
  including the actual pinned `drachtio-fsmrf` implementation. Every value is
  compared to bytes read from root-protected `/app` files before use.

These are inputs from the external authority, not evidence invented by the
consumer. `projection.sourceDigests` cannot authorize a template or executable.
The image recipe removes group/other write from `/app`, including application
code and dependencies, so shared-checkout permissions cannot weaken source
ownership checks. This recipe change has not been built or deployed.
Before publishing any record, the independently commissioned host transaction
must admit the whole immutable image, its dependency closure and sandbox; verify
the loaded renderer, topology validator, placement module and all four template
bytes against the reviewed release closure; bind their digest as
`rendererClosureDigest`; validate complete rendered/effective config; and verify
the real v2 kernel rules, routes, links, anchor/workload task inventory, retained
PID/namespace handles and durable global fence for this exact generation. The
authority must map `namespacePid` through the verified host process's `NSpid`
list and PID namespace to its retained host PID, rather than treating start
ticks as unique across processes. An
unverified digest merely copied into a root file does not meet that contract.
The application cannot independently observe Docker image identity or effective
nft rules; those proofs belong to the external host transaction.

The entrypoint side of the start handshake is present, but no host writer or
publication transaction is implemented. The authority must arrange and observe
the blocked voice process identity while retaining its start fence, publish the
exact record in the protected read-only mount, signal that exact generation,
and retain/revoke authority through startup, restart and teardown. No
environment-variable path, caller-supplied fixture or writable volume may supply
this record. Existing environment validation stays strict; endpoint overrides
come only from the admitted projection, not environment settings. Installing
this entrypoint without commissioned admission fails closed.

## HTTP and playback

The control HTTP server remains `127.0.0.1:3000`. A separate native HTTP server
binds only the admitted voice service IPv4 address on TCP3000. It verifies the
actual accepted socket's exact FreeSWITCH source IP and source port49152–65535,
voice destination IP and port3000 for each request and after async file opening.
Host and forwarding headers are never identity. Only GET/HEAD of
`/audio-files/:filename` or confined `/static/*` media is allowed. There is no
Express control/API dispatch, upload, proxying or redirect. Queries, fragments,
absolute URLs, percent encoding, traversal, unknown extensions, bodies, protocol
upgrades and other methods are refused. Files use no-follow, nonblocking opens,
regular-file/size checks and confinement of the already-open descriptor. Each
stream ends at its checked size, so later file growth cannot extend a response. Generated
media is `no-store`; static media caching is private.

The listener bounds connections32, backlog32, headers8KiB, requests/socket16,
headers5s, request10s, idle socket15s and keepalive1s. These bounds do not prove
instant revocation of an already streaming response: the external lifecycle must
close/drain the listener and terminate the workload when revoking a generation.
New requests and every generated playback URL recheck the protected admission
bytes and current process identity. Source-only module users retain the old
loopback URL default; the production entrypoint requires and installs the
admitted runtime before any media work.

Startup checks the exact bound listener address before acceptance. A terminal
fence prevents startup from creating later resources or reopening SIP admission
if shutdown began while listener readiness was pending. Shutdown aborts pending
binds and closes active media sockets; the existing bounded transport-close
result includes this listener. This does not replace the still-required complete
readiness, panic and generation-lifetime commissioning proofs.

## Reverse ESL scope

The pinned library's public `listenAddress`, `listenPort`, `advertisedAddress`
and `advertisedPort` are set to the admitted voice address and TCP3002. The
client connects only to admitted FreeSWITCH TCP8021 with the existing credential
and `drachtio_mrf` profile. No interface autodetection, dynamic port, wildcard,
extra proxy or modified dependency is used.

Cross-namespace initiators are restricted by the independently verified v2
policy to the exact FreeSWITCH UID/interface/source/destination/ports. Native
`drachtio-fsmrf` has no public pre-parse peer admission hook. The service UID can
connect to its own receiver through loopback; this is the explicitly trusted
same-authority voice workload, which already holds ESL control credentials.
Neither these media events nor an FS peer tuple proves independent handset
identity, prompt completion, DTMF approval or permission to execute work.

## Remaining acceptance work

The host start/rollback/restart transaction, protected credential/template
installation, effective image configuration, all listener readiness and panic
transport, SIP trunk endpoint/authentication projection, Asterisk lifecycle and
effective RTP evidence remain commissioning gates. So do exact provider WSS,
legacy TTS/STT and outbound SIP egress with DNS/CA dependencies, isolated packet
and actual Docker acceptance, resource acceptance and handset canaries. No host
default route or provider permission is added here. All three FreeSWITCH volume
definitions, controller transport and the launcher activation refusal remain.

The focused source suite uses synthetic root metadata/authority records,
temporary media files and unprivileged local listener tests. It exercises
generation/source/endpoint drift, exact peers, path confinement, GET/HEAD, bind
errors, native pending-bind cancellation and deferred-startup shutdown. These
results are source validation, never live admission or phone delivery evidence.
