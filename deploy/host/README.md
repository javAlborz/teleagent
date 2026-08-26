# Disabled host handoff

`teleagent-disabled-host-install` is the app-owned, disabled-only consumer of
the separately authenticated host release gate. It does not authenticate a
release itself and never creates the gate. The homelab verifier must create
`/run/teleagent-release-gate/verified.json` for the current boot immediately
before invoking this handoff and must verify the release again afterward.

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
to the gated release runtime.

Before installation, between mutations, and at final handoff the script
requires all activation sentinels to be absent, the preinstalled SIP fence to
pass `--check`, and these seven workload roots to be actual mount points on
pairwise-distinct devices. Every workload device differs from `/var/lib`; the
workspace device also differs from `/srv`:

```text
/var/lib/teleagent-worker-state
/var/lib/teleagent-provider-plane
/var/lib/teleagent-control
/var/lib/teleagent-privileged-action
/var/lib/teleagent-sip-gateway
/var/lib/teleagent-voice
/srv/teleagent-agent-workspaces
```

The install sequence is worker, provider CLI, controller/privileged broker,
realtime SIP, then voice. Every component owns its own transactional rollback.
The aggregate never starts, enables, restarts, imports, or builds anything; it
never reads credentials or creates an `ENABLE` sentinel. All child commands
run with an empty environment, `HOME=/var/empty`, bounded time, and bounded
captured output. Final checks require every dormant unit to be exactly loaded,
static, inactive, and dead, with its exact `/etc/systemd/system` fragment, no
drop-ins, and no pending daemon reload.

Run the isolated non-root regression suite only through the shared safety
wrapper:

```bash
scripts/hermes-safe-test node --test deploy/host/test-disabled-host-install.js
```
