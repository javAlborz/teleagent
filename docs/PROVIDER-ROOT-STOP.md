# Fixed provider stop for independent root recovery

The provider boundary now has one distinct stop-only operation:
`--action root-stop-all`. It reuses `panicAllProviderPlanes` and cannot select a
provider, launch ID, unit, path, workspace or command. It does not unlock, start
a model, restart a supervisor or acquire the normal start-preflight handoff lock.

Both real and effective UID must be 0. Node execution arguments must be empty.
The environment must contain exactly these four entries:

| Name | Exact value |
| --- | --- |
| HOME | `/var/empty` |
| PATH | `/usr/sbin:/usr/bin:/sbin:/bin` |
| LANG | `C.UTF-8` |
| LC_ALL | `C.UTF-8` |

All SUDO variables, Node overrides, release/path selectors, proxy settings and
inherited lifecycle descriptors are refused. The future independently admitted
root dispatcher must invoke the exact installed, reviewed and pinned helper
with this environment and fixed argv. A checkout does not provide that installed
authority. No sudoers rule, nonroot socket, sentinel or normal start gate is
added here; the existing session broker retains only its existing operations.
This root operation neither impersonates that broker nor manufactures SUDO_USER.

The existing transaction persists global panic before stop work, closes and
stops the two supervisor planes, retains their runtime masks, cancels retained
launch identities even when enumeration is empty, persists existing cancellation
tombstones and revokes capabilities. It clears a stale launch lock only after
the existing complete quiescence proof. The global panic remains set.

Existing egress recovery behavior is unchanged: the fixed egress control daemons
may be stopped and restarted to reconcile their durable ledgers while panic and
supervisor fences remain set. This does not grant a supervisor/model restart.
The JSON result preserves `accepted`, `persisted`, `quiesced` and the existing
per-plane evidence. Exit 0 requires persisted and quiesced; incomplete proof
returns 75, while authorization/persistence/inspection exceptions remain failures.
No result declares prior provider work safe to replay.

This is one recovery prerequisite, not a commissioned independent recovery
service. It supplies no new shared recovery fence, daemon, PBX peer identity,
voice-container inventory, immutable dispatcher, runtime installation, expanded
unit-identity proof or pressure/latency acceptance. Those remain separate work.
The installed source closure and stop authority must be independently admitted
without depending on normal-plane ENABLE sentinels or retaining the handoff lock
across systemd stop jobs. Synthetic tests exercise authorization, actual panic
dispatch with injected host operations, partial evidence and failures; no host
stop, systemd change or provider request ran during validation.
