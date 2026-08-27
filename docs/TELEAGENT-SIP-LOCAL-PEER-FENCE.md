# Teleagent local SIP peer fence

Loopback is a routing address, not an identity boundary. The fence therefore
resolves four exact, pairwise-distinct, non-root host identities:
`teleagent-voice`, `teleagent-drachtio`, `teleagent-freeswitch`, and the
infrastructure-owned `teleagent-asterisk`. Missing, root/1000, or numerically
reused identities make reconciliation fail closed. The application bundle
does not create the Asterisk account.

The private nftables output table constrains the originating socket UID for
both directions of every local hop: UDP SIP 5060/5070/5080, TCP admin/ESL/AudioFork
9022/8021/3001, and UDP RTP 30000-30100. TCP SIP on 5060/5070/5080 is rejected
because the reviewed topology is UDP-only. Drachtio's 5070 listener admits
responses from Asterisk and FreeSWITCH; the other directions each admit one
exact sender.

This table is sender/source defense only. An nftables `output` rule with
`meta skuid` authenticates the local socket that emitted a packet; it cannot
authenticate the process that owns the destination listener. If a reviewed
daemon exits, another same-host process can bind its vacated UDP port and
receive packets that the sender rule admitted. The table is therefore not a
receiver-isolation boundary and does not by itself justify FreeSWITCH
`auth-calls=false`.

The RTP rules also assume that Asterisk's allocated RTP source/listener range
is disjoint from FreeSWITCH's exact `30000-30100` range. In particular, the
source-port rule would reject Asterisk media sourced from that range. This
repository neither owns nor attests the deployed Asterisk range. A
root/infrastructure-owned check must bind Asterisk's exact effective RTP
configuration and prove the two closed intervals do not overlap before any
activation evidence can pass.

This does not replace SIP Digest on either trunk. The helper replaces its
private table in one atomic
nft batch, serializes operations through a root-owned flock, repairs drift,
and retains the last exact rules on ordinary service stop. UFW owns different
tables and cannot flush this table during reload.

The tracked bundle is source-only and inactive. Validate it without host
changes:

```sh
/opt/teleagent/current/deploy/voice-stack/teleagent-sip-local-peer-fence-install --source-check
```

The installer resolves its own actual entrypoint once and reads the helper,
unit, and version descriptor only beside that resolved file. A concurrent
change to `/opt/teleagent/current` therefore cannot combine installer bytes
from one release with fence assets from another.

Source validation is not promotion evidence. Production activation remains
blocked on a receiver-safe boundary: dedicated per-service network namespaces
for Drachtio, FreeSWITCH, voice-app, and the infrastructure-owned Asterisk peer,
with explicit links/routes and fail-closed ingress policy, plus the exact
Asterisk RTP-range attestation above. That topology is intentionally not
installed by this application bundle. The pinned media images also require a
dedicated staging run under the resolved non-root UIDs, including SIP/RTP/DTMF
and restart testing. The release blockers
`receiver-safe-sip-media-network-boundary-and-asterisk-rtp-attestation-are-not-implemented`
and `dedicated-staging-proof-including-non-root-media-containers-is-missing`
remain open.

The dormant `lib/sip-media-boundary-contract.js` module makes the prospective
receiver contract testable without changing the host. It accepts only the
canonical four-service namespace/UID/veth/address topology, fixed listener and
directional-flow tuples, initiator-only TCP rules whose reverse packets require
conntrack-established state, and a disjoint Asterisk RTP range. Its Asterisk
observation must be Ed25519-signed and bound to both a host-owned expected
topology digest and the supplied exact topology, expected boot ID, expected
effective-configuration digest, namespace identity, link/address tuple, time
window, and one-time nonce. The validator requires a synchronous atomic replay
consumer. The module is unimported by production,
does not create namespaces, veth links, routes, firewall policy, or Asterisk
configuration, and does not close either blocker.

An operator may use `--install` only while `teleagent-voice-stack.service` is
stopped. The source descriptor binds the current helper/unit digests and one
reviewed legacy pair. A descriptor-less target is adopted only when both bytes
match one of those pairs; partial, tampered, and unknown targets are refused.
Install, upgrade, and removal copy the prior reviewed bundle into a root-only
rollback area, then publish an fsync-backed versioned transaction marker before
their first target mutation. Any ordinary failure or termination restores the
prior exact bytes, descriptor, nft table, and enabled/active state. After an
untrappable `SIGKILL` or power loss, the next mutating installer invocation
performs the same recovery before continuing. `--check` refuses an unresolved
marker or a missing/mismatched current descriptor rather than claiming a
partial activation is healthy.

Rollback does not rely on Bash `errexit`: each durable write, rename, unlink,
directory sync, service transition, and cleanup propagates failure explicitly.
The marker's operation and phase constrain every acceptable helper, unit, and
descriptor state. Unknown or concurrently replaced bytes are never overwritten;
the unit remains inactive and the marker plus exact retry artifacts remain for
operator recovery. A first-install rollback durably records successful table
removal before it deletes the only helper capable of retrying that removal.

`--check` verifies source/install drift and then uses one time- and
output-bounded service-manager query to bind the running monitor to the exact
enabled `/etc/systemd/system/teleagent-sip-local-peer-fence.service` fragment.
It requires loaded/active/running state, root user and group, no drop-ins, and
no pending daemon reload before asking the helper to verify the exact kernel
table. A runtime or generator fragment cannot satisfy this check. `--remove`
validates the installed descriptor rather than requiring it to match a newer
source bundle, additionally requires Docker stopped, and is the only path that
deletes the retained rules. The optional Hermes-wide Docker dependency drop-in
remains infrastructure policy and is not installed by this application bundle.
