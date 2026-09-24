# Dormant PBX approval attestation contract

Status: fixture-only protocol and state-machine substrate. Nothing in this
document or the modules below authorizes production phone mutation.

Production voice remains read-only. The dormant implementation is deliberately
not imported by `voice-app`, the controller, the executor, the privileged
broker, or a service entrypoint. It has no unit, environment setting, secret,
socket, SIP account, Asterisk adapter, route, or enable sentinel.

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

The adapter interface is intentionally only a contract:

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
2. Implement and review the real Asterisk adapter, including authenticated AMI
   or ARI access, exact PJSIP handset-channel attribution, reconnect behavior,
   event ordering, and durable crash recovery.
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
