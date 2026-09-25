# Independent PBX adapter feasibility — 2026-09-22

The current AMI/ARI event surface cannot, by itself, satisfy the dormant
contract's exact `asterisk-pjsip-handset-channel-rfc4733-v1` assertion. No new
signing adapter or production enablement is supplied by this investigation.
The first useful **read-only** phone call does not require this approval
authority; authenticated inspection and read-only provider execution should
continue independently. This finding concerns handset-approved mutation.

This is a precise missing-provenance finding, not a claim that a safe Asterisk
adapter is impossible. A candidate AMI/AsyncAGI design is described below. It
requires PBX boundary work and exact-version negative-call evidence before it
can truthfully issue the existing evidence type.

## Installed-version applicability

Three bounded read-only CLI queries on September 22 returned:

- `core show version`: Asterisk
  `20.6.0~dfsg+~cs6.13.40431414-2build5`, built April 15, 2024.
- `module show like res_pjsip_dtmf_info.so`: one module, running.
- `module show like app_senddtmf.so`: one module, running.

They were executed with the existing `hermes-asterisk` container's Asterisk CLI.
No configuration, credential, private log, transcript or call payload was read.
No module was unloaded; no call, provider request, listener or routing change
was made. The cited upstream **20.6.0** source matches the reported upstream
version, but is not an attestation of the distro-patched deployed binary.
Commissioning must bind the exact package/image and its reviewed source.

The earlier September 19 report found loopback AMI without TLS and disabled
Asterisk HTTP/ARI. Those topology observations were not repeated here and
must be rechecked before choosing a transport.

## Why received DTMF is insufficient

`res_pjsip_dtmf_info.c`'s `dtmf_info_incoming_request` accepts supported SIP INFO
bodies and queues a channel `AST_FRAME_DTMF`. It does not consult the endpoint's
`dtmf_mode`. Consequently, seeing `dtmf_mode=rfc4733` in endpoint configuration
does not by itself establish that a received digit used RTP telephone events.
The relevant live module is loaded. [Asterisk 20.6.0 INFO implementation](https://github.com/asterisk/asterisk/blob/20.6.0/res/res_pjsip_dtmf_info.c#L76)

`PlayDTMF` also supports `Receive`, which queues an emulated received digit on
the selected channel. Thus an AMI `DTMFEnd` associated with the correct handset
channel can still originate from a control action. The ability to choose that
channel is why control-plane isolation matters in addition to channel ID
checks. [Asterisk 20.6.0 PlayDTMF implementation](https://github.com/asterisk/asterisk/blob/20.6.0/apps/app_senddtmf.c)

AMI `DTMFBegin`/`DTMFEnd` expose channel snapshots, digit, direction and duration,
but no RTP source, negotiated telephone-event payload, or transport provenance.
`Direction: Received` is a channel direction, not an RFC4733 certificate.
[Asterisk 20.6.0 AMI digit event construction](https://github.com/asterisk/asterisk/blob/20.6.0/main/manager_channels.c#L844)

ARI's `ChannelDtmfReceived` reports digit completion and duration rather than a
separate start event. Replacing AMI with ARI therefore does not resolve the
provenance question. [Asterisk ARI event schema](https://github.com/asterisk/asterisk/blob/20.6.0/rest-api/api-docs/events.json)

Requiring both a fresh received begin and end may exclude particular INFO or
emulated-end paths. It is a useful candidate check, but it is not independently
proven here as a complete source discriminator. The channel core handles
missing beginnings and duration emulation; audit the actual event-emission
paths as well as the internal frame conversions. Do not infer that every
internal emulated begin necessarily becomes an AMI received-begin event.
[Asterisk 20.6.0 channel DTMF handling](https://github.com/asterisk/asterisk/blob/20.6.0/main/channel.c#L3640)

The unsafe shortcut is setting the protocol's literal `dtmf_source` field after
checking only the endpoint name, received direction, and `#`. That would add an
unproven claim to otherwise valid cryptographic evidence. Signing does not
repair the missing observation.

## Concrete candidate design and remaining work

Use a separately authenticated attester control connection to Asterisk, with
voice/media identities unable to connect, inspect its credentials, or invoke
other PBX control actions. A TCP loopback address shared with those identities
is insufficient receiver isolation. TLS with a pinned PBX identity or a
protected local transport should bind the receiver before authentication.

The attester should learn each fresh handset `Newchannel` and its eventual
two-leg bridge from its own continuous event stream. Bind the fixed authenticated
PJSIP endpoint, exact unique ID/linked ID, birth, route, trunk and bridge. Mint a
random opaque call handle for the controller. Never accept this mapping from
voice, caller ID text, a SIP header, or an arbitrary callback. Disconnect,
overflow, transfer, rename and an unexpected bridge member invalidate pending
collection. Reconnect requires a fresh independently observed call; it must not
reconstruct approval from voice's prior state.

For approval, atomically claim the controller-signed arm through the existing
durable attester store before any PBX effect. Move the exact handset channel
out of the voice bridge into a fixed private AsyncAGI context. Confirm that the
channel actually left the bridge and entered that context. Keep the voice
trunk unable to route into or inject events into this context. Ambiguous
redirects or disconnects consume the arm; they do not retry playback or
pretend the call is quiescent.

Render the exact signed prompt inside the attester's trusted boundary and
publish immutable audio in a directory writable by neither voice nor its media
receiver. Bind the rendered audio hash and exact sample count. AsyncAGI provides
command IDs and command-completion results, so the adapter can correlate a
specific `STREAM FILE` operation rather than a generic playback callback.
Use escape digits so barge-in aborts, require full successful sample completion,
then start a bounded wait for a fresh digit. A result acknowledging queued work
is not playback completion. [AsyncAGI command results](https://docs.asterisk.org/Asterisk_20_Documentation/API_Documentation/AMI_Events/AsyncAGIExec/),
[stream and wait implementation](https://github.com/asterisk/asterisk/blob/20.6.0/res/res_agi.c)

Before declaring a received begin/end pair to be RFC4733, close provenance by
one of two reviewed approaches:

1. Audit and pin the exact PBX image, endpoint/media settings, loaded-module
   set, dialplan and every control identity. Prove that non-RTP input paths
   cannot generate an admissible pair on the isolated handset channel. If
   disabling INFO or other injection modules is required, provision that in
   an isolated test PBX first; do not unload shared live modules casually.
2. Add a PBX-owned ingress observer that reports authenticated handset RTP
   telephone-event provenance before it becomes a generic channel DTMF frame.
   Bind its source/session generation and event order to the playback arm.
   Generic user events from an unrestricted AMI writer are insufficient.

Only then implement the evidence-returning adapter against that admitted
profile. It must reject a missing/early/held digit, wrong-leg digit, replayed
event, clipped/failed prompt, unexpected call transition, timeout, backward
clock and any observation-stream gap. Any failure leaves the durable arm spent
or uncertain; signed replacement follows the existing supersession contract.

## Isolated acceptance cases

Pin the test PBX image and use dummy controller/attester keys, synthetic prompts
and a test handset; no executor effects are needed to test this boundary.
Exercise positive handset RTP `#` only after complete playback, then the same
digit via SIP INFO, AMI receive injection, voice-trunk media, the wrong channel,
before playback, held across completion, and after timeout. Independently prove
audio substitution refusal, transfer/reconnect refusal, duplicate replay
rejection and crash refusal at claim/playback/observation/finalization.

The current investigation did not run those calls and does not count unit
fixtures as that evidence. No generic adapter stub, signer, unit, release pin,
approval gate or activation default was changed. Continue the isolated
read-only commissioning path while this separate authority work is completed.
