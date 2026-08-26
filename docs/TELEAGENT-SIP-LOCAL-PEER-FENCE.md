# Teleagent local SIP peer fence

Loopback is a routing address, not an identity boundary. Without a kernel
owner fence, any local non-root process could impersonate the voice app or PBX
on the unauthenticated side of a local SIP hop.

The dedicated nftables table rejects non-root traffic to the fixed UDP peers:

- port 5060 admits only the root-owned PBX side;
- port 5070 admits only the root-owned Drachtio side.

This does not replace SIP Digest on either trunk. It is defense in depth for
the remaining local hop. The helper replaces its private table in one atomic
nft batch, serializes operations through a root-owned flock, repairs drift,
and retains the last exact rules on ordinary service stop. UFW owns different
tables and cannot flush this table during reload.

The tracked bundle is source-only and inactive. Validate it without host
changes:

```sh
/opt/teleagent/current/deploy/voice-stack/teleagent-sip-local-peer-fence-install --source-check
```

An operator may use `--install` only while `teleagent-voice-stack.service` is
stopped. Installation publishes a root-only, fsync-backed transaction marker
before its first target mutation. Any ordinary failure or termination rolls
back to the prior inactive and enabled/disabled state; after an untrappable
`SIGKILL` or power loss, the next `--install` performs the same exact recovery
before retrying. `--check` refuses an unresolved marker rather than claiming a
partial activation is healthy.

`--check` verifies source/install drift and then uses one time- and
output-bounded service-manager query to bind the running monitor to the exact
enabled `/etc/systemd/system/teleagent-sip-local-peer-fence.service` fragment.
It requires loaded/active/running state, root user and group, no drop-ins, and
no pending daemon reload before asking the helper to verify the exact kernel
table. A runtime or generator fragment cannot satisfy this check. `--remove`
additionally requires Docker stopped; it is the only path that deletes the
retained rules. The optional Hermes-wide Docker dependency drop-in remains
infrastructure policy and is not installed by this application bundle.
