# Disabled host handoff

`teleagent-disabled-host-install` is the app-owned, workload-disabled consumer
of the separately authenticated host release gate. It does not authenticate a
release itself and never creates the gate. The homelab verifier must create
`/run/teleagent-release-gate/verified.json` for the current boot immediately
before invoking this handoff and must verify the release again afterward. The
gate is nonsecret host-owned integrity metadata: its root-owned directory is
mode `0755` and its single-link file is mode `0444`. Systemd separately projects
that file into a private mode-`0400` per-service credential.

The handoff has three exact modes:

```text
--source-check       TELEAGENT_HOST_SOURCE_OK
--install-disabled   TELEAGENT_HOST_INSTALLED_DISABLED
--check              TELEAGENT_HOST_INSTALLED_DISABLED_OK
```

Source checking runs before installed Node exists. It uses the authenticated
release Node only for the voice and realtime-SIP JavaScript verifiers, and
runs the worker, controller, realtime-SIP installer, and preinstalled SIP
fence source checks through fixed Bash. Installation requires both installed
Node paths to be root-owned, single-link, canonical, executable, and byte-equal
to the gated release runtime. The full byte comparison runs once at entry and
once at final handoff. After the entry comparison, the script captures each
release/installed runtime's exact device, inode, size, owner, group, mode, link
count, nanosecond mtime, and nanosecond ctime; intermediate mutation guards use
those cheap fingerprints to reject an in-place write or replacement without
repeatedly reading the large binaries.

Before installation, the script requires all activation sentinels to be absent
and these seven workload roots to be actual mount points on pairwise-distinct
devices. Every workload device differs from `/var/lib`; the workspace device
also differs from `/srv`:

```text
/var/lib/teleagent-worker-state
/var/lib/teleagent-provider-plane
/var/lib/teleagent-control
/var/lib/teleagent-privileged-action
/var/lib/teleagent-sip-gateway
/var/lib/teleagent-voice
/srv/teleagent-agent-workspaces
```

Fresh-host bootstrapping has one narrow security exception to the disabled-only
rule. The authenticated voice installer first creates the three app-owned host
identities, verifies the infrastructure-owned Asterisk identity, and installs
static voice assets while the voice service and slice remain disabled, inactive,
and dead. This narrow identity/static-asset bootstrap phase runs at the start of
both fresh and repeated handoffs. The authenticated SIP-fence installer then
installs, enables, and starts only the root-owned security fence. Every mutation
after that phase and the final handoff requires the exact fence to pass
`--check`. The remaining order is worker, provider CLI, controller/privileged
broker, then realtime SIP. Every component owns its own transactional rollback.

The fence is the aggregate's sole service activation. The handoff never starts,
enables, or restarts a workload, never imports or builds an image, never reads
credentials, and never creates an `ENABLE` sentinel. Each source-installer
process resolves its own actual immutable release entrypoint before reading
sibling assets, so a concurrent `/opt/teleagent/current` selector change cannot
mix an authenticated installer from one release with files from another. All
child commands run with an empty environment, `HOME=/var/empty`, bounded time,
and bounded captured output. Final checks require every workload unit to be
exactly loaded, static, inactive, and dead, with its exact
`/etc/systemd/system` fragment, no drop-ins, and no pending daemon reload; the
fence must separately be exact, enabled, active, and running.
Each combined manager query has a ten-second deadline and a 4,096-byte output
ceiling. The longer 120-second/128-KiB bounds remain reserved for real component
installation and verification children.

Run the isolated non-root regression suite only through the shared safety
wrapper:

```bash
scripts/hermes-safe-test node --test deploy/host/test-disabled-host-install.js
```
