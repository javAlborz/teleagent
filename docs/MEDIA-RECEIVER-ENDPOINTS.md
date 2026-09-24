# Receiver endpoint projection

`deploy/voice-stack/media-receiver-endpoints.js` renders the existing reviewed
`teleagent.receiver-safe-sip-media-topology.v1` (and its explicit v2 extension) into deterministic configuration
templates and voice client/listener settings. It changes no Compose file,
running service, volume, firewall, route, credential or activation gate. Output
always says `readyToLaunch: false`.

The renderer reuses the strict topology validator, checks the entire Docker
network configuration digest against the application admission contract, and
requires each namespace and application UID to match its admitted anchor.
Receiver and policy link addresses must be literal RFC1918 addresses on the
validated distinct /30 links. Unknown/missing fields, reordered services,
missing flows, broad port intervals, shared addresses or mismatched generations
refuse before output.

`prepareProtectedReceiverEndpoints(releaseRoot)` reads only fixed root-protected
`/etc/teleagent-media/docker-network.json`, requires canonical JSON, and obtains
independent bootstrap admission through the existing protected application
boundary module. The authority must validate the complete external edge and
anchor configuration. A caller-supplied topology is not authorization; the pure
`renderReceiverEndpoints(config, applicationContract)` is suitable for source
review/testing. Neither function writes or installs its output.

## Mapped loopback assumptions

| Surface | Existing source | Rendered value from topology |
| --- | --- | --- |
| Drachtio admin | `127.0.0.1:9022` | Drachtio service address, TCP9022; voice client uses the same address |
| Drachtio SIP contact and advertised IP | `127.0.0.1:5070` | Drachtio service address, UDP5070 only |
| FreeSWITCH inbound ESL | `127.0.0.1:8021`, `loopback.auto` | FreeSWITCH service address, TCP8021; a deny-by-default ACL permits only voice `/32` |
| FreeSWITCH SIP/advertised SIP | `127.0.0.1:5080` | FreeSWITCH service address, UDP5080; SIP ACL permits only Drachtio `/32` |
| FreeSWITCH RTP/advertised RTP | `127.0.0.1`, 30000–30100 | FreeSWITCH service address and the exact topology RTP interval |
| Voice audiofork | `127.0.0.1:3001`, loopback peers | Voice service address, TCP3001; exactly the FreeSWITCH address is an allowed peer |
| Outbound SIP trunk target | `127.0.0.1:5060` | Asterisk service address, UDP5060; Drachtio sends SIP on behalf of voice |

The renderer preserves the reviewed FreeSWITCH codec, session/task pacing,
storage-independent core settings and disabled TLS settings. SIP `bind-params`
explicitly selects UDP; the topology firewall independently enforces its exact
UDP tuples. Event Socket binds the selected interface with NAT mapping disabled
and bind failure fatal. Named ACLs contain only exact `/32` peers, not a whole
private subnet. These are supported configuration forms in the official
[Drachtio server documentation](https://www.drachtio.org/docs/drachtio-server),
[FreeSWITCH ACL documentation](https://developer.signalwire.com/freeswitch/integration/acls/),
[Event Socket documentation](https://developer.signalwire.com/freeswitch/integration/event-socket/)
and [Sofia profile documentation](https://developer.signalwire.com/freeswitch/users-and-endpoints/sip-profiles/).

Output includes five XML documents, the exact proposed voice environment,
audiofork options, inbound ESL target, source-template hashes, topology digest
and projection digest. The two existing credential markers
`__DRACHTIO_SECRET__` and `__FREESWITCH_SECRET__` remain unresolved. This renderer
accepts no secret and cannot produce authenticated installable configuration.
Future protected credential projection must insert those values and publish
root-owned read-only files under the retained lifecycle fence.

The existing `lib/voice-app-runtime-env.js`,
`voice-app/lib/media-control-endpoints.js`, launcher environment guard and
runtime projection still enforce their old loopback contract. They intentionally
reject these proposed isolated settings until the coordinated consumer change
is reviewed. The launcher's unconditional early refusal remains unchanged.

## Required topology revision and runtime work

The eight-listener, nine-flow v1 topology is insufficient for the actual pinned
runtime. Two concrete missing connections were found while mapping callers:

1. `drachtio-fsmrf` 4.1.2's `lib/mrf.js` uses `listenPort || 0` for a reverse ESL
   listener. `lib/mediaserver.js` binds that listener and inserts its advertised
   address/port into `X-esl-outbound` during endpoint creation. The existing
   app pins the address to loopback but leaves the port dynamic. The proposed
   v2 choice is the **voice service address, TCP3002**, with explicit
   `listenAddress`, `listenPort`, `advertisedAddress` and `advertisedPort`.
2. FreeSWITCH fetches private TTS/generated audio, beeps and hold music from
   voice HTTP3000. `http-server.js`, `tts-service.js` and
   `conversation-loop.js` contain loopback/localhost URL assumptions. The
   proposed v2 receiver is the **voice service address, TCP3000**, exposing only
   media GET/HEAD routes to the exact FreeSWITCH peer. Simply rebinding today's
   mixed HTTP API listener would be insufficient: media routes currently deny
   non-loopback clients, and control/outbound routes must not be exposed to the
   media peer. Use a dedicated media receiver or an explicitly separated route
   policy, preserve confined/no-follow file serving and private caching, and
   derive every playback URL from the admitted receiver.

Both v2 flows are FreeSWITCH→voice only: exact FreeSWITCH UID, ingress
veth and source address; TCP source ports49152–65535; exact voice destination
interface/address and destination3000 or3002. Only conntrack-established replies
return. No listener can select a dynamic port, wildcard address, hostname or
arbitrary peer. The separately versioned
`teleagent.receiver-safe-sip-media-topology.v2` contains exactly ten listeners
and eleven initiating flows. Its matching infra rules retain default-drop,
source-UID and exact interface/address/port filtering. A v1 record cannot
acquire v2 permissions, and a v2 record missing either addition is refused.
The topology digest and independent Asterisk evidence must explicitly bind v2;
v1 evidence cannot be reused.

For v1, the renderer keeps `reverseEsl` and `privateHttpAudio` null. For v2 it
emits explicit reverse ESL bind/advertisement options and media-only HTTP
metadata. The media HTTP receiver permits GET/HEAD on the exact voice service IP;
its control counterpart remains a separate `127.0.0.1:3000` bind. Wildcard binds,
control/API dispatch and redirects are prohibited. HTTP verifies accepted socket
source and local destination against the admitted generation. The native reverse
ESL listener relies on independently verified v2 kernel policy for cross-namespace
FreeSWITCH admission. The same-authority voice workload can connect locally via
loopback and already holds the ESL control credential; media receipt is never
independent handset approval. See [the dormant runtime consumers](MEDIA-RECEIVER-RUNTIME.md).
`readyToLaunch` stays false and the launcher's unconditional gate stays intact
for both versions.

The remaining work also includes Realtime WSS and legacy STT/TTS egress,
protected runtime/credential consumers, readiness and panic transport, exact
Asterisk lifetime/edge/RTP attestation, durable authority and retained process
handles through the whole start/rollback transaction. No provider or host
default route is introduced here. Independent image/config interpretation,
isolated Docker/packet/process acceptance and handset canaries remain required.

## Validation

The source suite validates deterministic digests, independently parses generated
XML, checks exact listeners/ACLs/RTP, ties every rendered receiver to the
existing packet-policy model, and rejects missing/inconsistent inputs and
cross-generation configuration. Alternate RFC1918 link fixtures prove that
addresses are derived rather than hardcoded. Existing runtime guards and the
activation refusal are tested unchanged. The tests run serially under
`scripts/hermes-safe-test`; they open no network sockets and call no Docker,
FreeSWITCH, Drachtio or provider services. A passing fixture is not live
connectivity, effective configuration or activation evidence.
