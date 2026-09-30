# Dormant PBX approval attestation contract

Status: source-only protocol, state machine and ARI adapter. Nothing in this
document or the modules below authorizes production phone mutation.

The live V49 deployment remains read-only. Source now includes a gated controller
runtime, typed voice routes/tools, a Unix-only attester API and owner-broker key
epoch checks. None has been installed or activated. The root-owned controller
enable file must match the exact protected authority epoch; without it the
controller retains V49 behavior and advertises no owner-session tools. Source
imports and passing synthetic tests are not production approval.

## Authority chain

The target protocol uses three separate Ed25519 roles and three
non-interchangeable artifacts:

1. The controller signs a short-lived `telereq1` arm. It binds the approval and
   job IDs, operation, request and canonical-plan hashes, target,
   provider/profile, exact spoken prompt and prompt hash, a random PBX call
   handle, validity window, and nonce.
2. An independently isolated PBX attester verifies and durably claims that arm.
   Its Asterisk adapter must play the supplied prompt, identify the exact
   handset and trunk legs, and observe RFC4733 `#` on the handset channel only
   after playback completes. The evidence issuer independently verifies the
   raw `telereq1` signature against its configured controller-arm public keys;
   it does not trust a structural verifier receipt. The attester signs the
   resulting `teleattest1` evidence with a different key.
3. A controller authority atomically verifies and consumes that evidence. It
   independently verifies both the raw `telereq1` and `teleattest1` signatures
   from configured public-key roles before replay admission. It may then sign
   one `telecap2` execution capability with a third key. The executor
   independently verifies every operation binding and atomically consumes the
   capability immediately at the effect boundary.

Voice has no private key in this chain and never receives `telecap2`. A model,
transcript, FreeSWITCH event, voice callback, or structurally similar
`{approved: true}` object cannot be converted into execution authority.

## PBX evidence

`lib/pbx-approval-protocol.js` defines the arm and evidence wire contracts.
Artifacts use canonical JSON segments, canonical base64url encoding, Ed25519,
bounded lifetimes, exact schemas, and 32-byte nonces. Verification rejects
unknown keys, wrong purpose or method, extra fields, noncanonical encoding,
signature changes, stale/future artifacts, and mismatched operation bindings.

The signed evidence carries and hashes the full PBX call-leg identity:

- infrastructure-owned PBX instance ID and Asterisk `linkedid`;
- handset channel `uniqueid` and endpoint;
- handset channel birth timestamp;
- distinct trunk channel `uniqueid`;
- bridge ID and reviewed dialed route.

It also binds the controller call handle, prompt and rendered-audio hashes,
playback event ID and start/completion timestamps, DTMF event ID and timestamp,
literal `#`, and the exact method
`asterisk-pjsip-handset-channel-rfc4733-v1`. Channel birth must precede
playback; playback start must be strictly earlier than playback completion;
playback must complete before DTMF; all events must occur inside the arm window;
evidence must be issued after the event and expire no later than the arm.

`teleattest1` binds the verified controller-arm key ID and SHA-256 SPKI
fingerprint as well as the raw arm digest. `telecap2` carries those same arm-key
bindings together with the PBX-attester key ID and fingerprint. The executor's
expected bindings therefore select all three signing roles instead of relying
on an unversioned key-map lookup.

The controller-side evidence verifier requires a caller-supplied synchronous
atomic replay consumer. Signature checking alone is never authorization.

`lib/telecap2-execution-capability.js` defines the dormant controller bridge and
execution verifier. The controller bridge constructs the PBX evidence verifier
internally from configured arm and attester public keys plus a synchronous
controller-owned replay store; callers cannot substitute a receipt-producing
verification callback. After both raw signatures verify and replay consumption
wins, the bridge copies the result through canonical JSON into an own-data,
deep-frozen controller receipt, snapshots every semantic issuance binding,
brands the receipt privately, and permits one issuance. Frozen accessors,
mutable aliases, structural lookalikes, and post-admission field changes are not
accepted. Controller-arm, PBX-attester, and execution key IDs and SPKI
fingerprints must be pairwise distinct. `telecap2` binds the consumed evidence
digest and both upstream key epochs plus every execution field; the execution
verifier requires all expected bindings and a synchronous atomic replay winner
before returning authorization. Evidence is marked spent before nonce
generation or signing so a local issuance failure cannot create an ambiguous
retry.

## Durable attester state

`lib/pbx-approval-attester.js` defines the dormant attester orchestration
contract. It claims an arm synchronously before contacting the adapter, records
the validated PBX event tuple before signing, and durably finalizes the evidence
digest before returning it. Any adapter, validation, storage, issuance, or
finalization failure consumes the attempted arm or otherwise fails closed; it
does not retry a possibly observed confirmation.

`lib/pbx-approval-attester-store.js` supplies fixture memory storage and an
injected-SQLite implementation. The SQLite schema uses unique constraints for
arm digest, arm nonce, call handle, playback ID, DTMF event ID, and evidence
digest, with one-way `pending` to `observed` to `issued` transitions. An exact
partial unique index permits only one non-superseded arm per approval ID;
issued arms remain in that uniqueness boundary. Pending or observed arms may
instead transition irreversibly to `superseded` during atomic replacement.
It stores hashes and bounded identifiers, not raw signed tokens, prompts, or
audio.

The SQLite adapter creates this schema atomically only when its main-schema
table, expiry-index, and active-approval-index names are all absent. On every open it then requires
the exact reviewed table DDL, column/primary-key layout, unique-index closure,
state `CHECK`, both named indexes, and absence of table triggers in both the main and
temporary schemas. A weaker, extra, unreviewed partial-index, trigger-modified, or
same-name pre-existing schema fails closed; the adapter does not repair or
migrate it. Every prepared state transition is explicitly qualified to the
SQLite `main` schema, so a temporary same-name table cannot intercept replay
state. Writes require a standalone connection with `inTransaction === false`;
an outer transaction cannot make an uncommitted claim appear durable before
PBX work starts. The connection owner remains responsible for protected storage,
WAL mode, and `synchronous=FULL` before real use. Older exact schemas fail closed;
this change deliberately supplies no live-data migration.

The adapter interface is now implemented by a source-only ARI client, call
catalog/router and approval collector in `claude-api-server/pbx-ari-*.js`.
They are not imported by the production controller or voice service. There is
still no reviewed live namespace, ARI configuration, signing-key installation,
attester service or production controller integration.

The ARI path reserves one owner call, validates the authenticated PJSIP endpoint
and exact handset/trunk/bridge identities, and binds the trunk SIP Call-ID to an
opaque PBX handle. Only the fixed 7/77 conductor trunks can be originated. A
connection loss never redials or adopts an old call. During approval, the handset
is detached from voice's bridge, hears an independently rendered canonical
prompt, and can authorize only with a new pound press after complete playback.
A digit begun before completion, even if released afterward, is refused. The
collector rejects wrong-leg digits, substituted/short/failed playback, transfers,
replaced channels, expired arms and failed bridge restoration.

`pbx-local-speech.js` supplies deterministic local speech using a fixed reviewed
eSpeak NG executable and argument list. Text goes only to stdin; no model,
network credential, SSML mode, shell, or user-selected path participates. The
bounded streaming WAV is converted to 24 kHz PCM without a codec subprocess.
`pbx-prompt-renderer.js` hashes the audio, bounds retained files, deletes it after
collection, and only collects correctly hashed orphans after fifteen minutes.
The files are explicitly mode 0640 even under a restrictive service umask so the
PBX's dedicated audio group can read them. Synthetic tests establish bytes and
lifecycle; attended acceptance still establishes intelligibility and handset
playback. The former OpenAI speech client was removed before activation.

ARI's `ChannelDtmfReceived` identifies a channel, not the DTMF transport. Setting
`dtmf_mode=rfc4733` alone is insufficient: the Asterisk PJSIP INFO module also
queues DTMF frames. The independent host boundary must disable that module,
exclude in-band/alternate control sources, and prove those settings before any
arm. The adapter requires a host boundary checker; it cannot manufacture RFC4733
proof from an event. Root-owned PBX configuration, namespace/credential controls,
and real negative SIP INFO/RTP tests remain activation blockers.

Primary references: [ARI DTMF](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-REST-Interface-ARI/Introduction-to-ARI-and-Channels/ARI-and-Channels-Handling-DTMF/),
[ARI playback](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-REST-Interface-ARI/Introduction-to-ARI-and-Channels/ARI-and-Channels-Simple-Media-Manipulation/),
[Asterisk INFO implementation](https://github.com/asterisk/asterisk/blob/master/res/res_pjsip_dtmf_info.c),
and [PJSIP encrypted media](https://docs.asterisk.org/Deployment/Secure-Calling/Secure-Calling-Tutorial/).
The installed Hermes PBX was observed as Asterisk 20.6.0 with ARI inactive; no
configuration or call routing was changed during source validation.

The dormant entrypoint `attest(replacementArmToken, previousArmToken)` verifies
both raw controller artifacts. Replacement must preserve the approval/job,
operation, request/plan hashes, target, provider/profile, exact prompt, signing
key ID and fingerprint, and original deadline. It requires a fresh arm nonce
and call handle. A changed request needs a separate approval; supersession is
not a way to change the operation, rotate keys, or extend its consent window.

The SQLite store uses one `BEGIN IMMEDIATE` transaction to mark the exact
pending/observed old arm `superseded` and claim the replacement. It retains the
old arm's nonce, call, playback, and DTMF identities as replay tombstones until
expiry. Conflicts roll back both changes. Issued, absent, already superseded,
expired, or time-regressed predecessors refuse replacement. A failed rollback
poisons that store object, including after an external rollback, until a fresh
validated store is opened. An ambiguous commit result is an error, never
permission to contact the PBX.

The replacement adapter is called only after that transaction commits and a
fresh strict clock check confirms the collection window is still open; a slow
lock/fsync or backward clock cannot initiate a call outside that window. A late
old callback cannot record an observation or finalize evidence. A crash after
commit but before collection leaves the replacement claimed; retrying that
same arm refuses before any call. Actual call quiescence, controller-driven
replacement selection, and real Asterisk crash/reconnect behavior are still
unimplemented promotion work. No already-started call is automatically redialed
or asserted to have hung up by this fixture-only state transition.

```text
collectApproval({
  approvalId, armSha256, pbxCallHandle,
  prompt, promptSha256, notBeforeMs, expiresAtMs
}) -> exact signed-evidence observation fields
```

No generic SIP or FreeSWITCH adapter is acceptable. A future implementation
must use an infrastructure-owned Asterisk control identity that voice cannot
reach, identify the handset PJSIP channel rather than merely a bridge or trunk
event, and prove that the prompt playback and RFC4733 event came from that same
live call context.

## What remains before activation

The following are still mandatory and keep
`independent-pbx-attested-request-bound-approval-authority-is-not-implemented`
open:

1. Place the PBX attester in its own reviewed Unix/network/credential boundary
   and provision three independently managed key epochs.
2. Install and accept the source ARI adapter with authenticated private access,
   independently enforced RFC4733-only attribution, real event ordering, and
   durable crash recovery. Synthetic event tests do not close this gate.
3. Integrate arm creation and evidence consumption into the controller without
   making voice a trusted intermediary.
4. Integrate `telecap2` consumption at the durable executor and privileged
   broker's first-effect transaction, including key-epoch revocation.
5. Prove negative and positive calls, replay, prompt substitution, wrong-leg
   DTMF, barge-in, transfer, reconnect, restart, and crash windows on dedicated
   staging.
6. Review and deliberately add units, accounts, secrets, policy, release
   closure, install procedures, and promotion evidence only after those proofs
   exist.

Focused Hermes tests exercise only generated keys, in-memory/temporary SQLite,
and fake adapter observations. They make no call and modify no host state.

## Controller and phone integration (source only)

The phone supplies its received trunk SIP Call-ID, never the FreeSWITCH media
UUID or a model-selected call ID. Four separate owner tools list enrollment,
inspect one exact native session, request independently attested instruction
delivery, and read its durable status. Legacy managed tasks remain read-only.
The voice bearer cannot supply evidence, capabilities, native endpoint paths or
a native session identifier. Native history is bounded and redacted.

Each approval within one live call receives a fresh one-use PBX handle, because
the attester replay store uniquely consumes a call handle. Handles expire after
120 seconds, cannot revive an ended call, and do not extend a conversation limit.
The private API has only call lookup, attest and panic operations; it accepts no
TCP requests, raw ARI commands or invented events. Panic is durable.

The controller and broker recheck a root-owned three-key epoch before admitting
work. The controller's private keys and PBX key live in separate directories;
voice receives neither. All new transitive source imports are in the immutable
release closure, which still needs independent infrastructure co-approval.

An owner-session panic locks future phone delivery but does not terminate the
personal agent. Global stop must report PARTIAL until every configured plane
proves quiescence. Owner recovery remains an explicit operator procedure; the
legacy unlock route cannot silently unlock this plane. Native acceptance is
not completion; ambiguous delivery uses status-only reconciliation, never resend.

Remaining promotion gates include host units and disabled installation, actual
PBX/local-speech boundary attestation, RFC4733 transport and RTP-source isolation,
SIP Call-ID correlation, guarded route migration, recovery and attended playback
plus fresh-pound acceptance. The installed Asterisk 20.6 does not expose the
newer per-endpoint RTP port-range option. Do not infer packet-source isolation
from a channel-scoped ARI digit or from dtmf_mode alone.

The approval adapter also requires `CHANNEL(rtp,secure,audio)=1` before playback
and before accepting the observed digit. This prevents plain or downgraded RTP
from authorizing work even if an event names the handset channel. The boundary
must prove authenticated SRTP configuration and confidential handset signaling
(the existing private Tailnet path), plus disabled SIP INFO and in-band DTMF.
An unencrypted conversation can remain useful, but cannot approve instructions.

### Owner-plane service deployment

The source units under `deploy/owner-plane` add two fixed Node entrypoints and a
fixed systemd ARI socket proxy. They are installed disabled, with no boot enable
section. The infrastructure verifier must independently approve their unit
hashes and entrypoint profiles before a signed release can start them.

The two Node services share the existing bounded voice slice; they do not add
unreviewed children to the exact aggregate provider-admission topology. The ARI
relay shares the existing media slice. All retain their own smaller limits.

The session broker runs as the personal owner to reach the native providers'
owner-only Unix sockets. It is trusted code, with no model or generic RPC/shell
route. Its mount view exposes enrolled project paths and native session records;
this is not a security boundary against other processes already running as the
same owner. Personal agents retain their existing account permissions. The
controller reaches only its root-owned typed listener and receives no provider
credential or native socket.

The PBX attester uses a separate identity, private state and signing key. It
reaches ARI through an attester-only Unix socket; the fixed proxy runs in the
PBX network namespace as the existing PBX identity and targets loopback only.
No new voice-to-PBX management route is added. An infrastructure-owned preflight
must verify the actual PBX configuration, authenticated handset media, immutable
mounts, installed speech packages and current process identities before issuing
the current-boot boundary receipt. The receipt is rechecked before approval.

Phone session controls require fresh successful health from both independent
services with the same authority epoch. Probes are serial, throttled and never
inspect or launch a native agent. Lost connectivity or stale readiness withdraws
the capability. Operator recovery checks the independent durable locks separately
from the global phone lock; this does not automatically clear any panic lock.

These sources do not constitute an installed or accepted owner plane. Real
packet rejection, handset audio/DTMF, native delivery and recovery acceptance
remain deployment requirements.
