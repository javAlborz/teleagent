# Controller and durable control-plane deployment

The host controller and privileged broker are separate trust planes with
separate bounded filesystems. Source deployment is deliberately dormant: both
units are static, both activation sentinels are absent by default, and the
installer never starts, enables, or restarts a unit.

## Durable-state contract

Provision both exact mountpoints before installing this plane:

- `/var/lib/teleagent-control`: a dedicated durable local 2-8 GiB filesystem,
  owned `teleagent-control:teleagent-control` and mode `0700` after mounting;
- `/var/lib/teleagent-privileged-action`: a different dedicated durable local
  1-8 GiB filesystem, owned `root:root` and mode `0700` after mounting.

Each mount must have a different device from `/var/lib`, resolve canonically,
and use a reviewed local durable filesystem (ext4, XFS, Btrfs, F2FS, or ZFS).
Use `nodev,nosuid,noexec` where supported. A project directory, ordinary
`/var/lib` directory, overlay/tmpfs, network filesystem, or shared root volume
is rejected. At startup and before every new submission, free space must be at
least the greater of 20 percent and 512 MiB.

The controller mount contains:

- `executor-tasks.sqlite`, including task/idempotency/panic/audit history;
- `voice-execution.lock.json`, an exact canonical explicit locked or unlocked
  record which is never deleted in hardened mode;
- SQLite WAL/SHM files while SQLite requires them.

The privileged mount contains `actions.sqlite`, including actions,
idempotency, capability replay fingerprints, process/recovery truth,
`outcome_unknown`, panic, append-only audit, and outbox history. These trust
records are not pruned. The filesystem bound and low-water admission protect
the host while leaving reserved capacity for cancellation, panic, recovery,
and terminal truth. Archive a quiesced whole state filesystem under a separate
reviewed design; never delete individual database, lock, marker, audit, panic,
or replay files to recover space.

## Authenticated disabled installation

First complete the worker-session disabled install. The controller installer
requires the worker service, AppArmor loader, and both provider socket units to
be exactly loaded, static, inactive, and dead.

With all three sentinels absent (`worker-session`, `controller`, and
`privileged-action`), provision and mount both filesystems, then run:

```sh
sudo /opt/teleagent/current/deploy/controller/teleagent-control-plane-install \
  --source-check
sudo /opt/teleagent/current/deploy/controller/teleagent-control-plane-install \
  --install-disabled
sudo /usr/local/libexec/verify-teleagent-control-plane --installed-check
```

The digest-pinned installer transactionally installs only the two units,
tmpfiles/sysusers declarations, manifest, installer, and verifier. It proves
exact `LoadState=loaded`, `UnitFileState=static`, `ActiveState=inactive`, and
`SubState=dead` after `daemon-reload`. It never invokes `start`, `enable`, or
`restart`.

On objectively empty mounted filesystems, the installer creates and fsyncs the
two zero-length SQLite roots, the explicit canonical controller unlocked
record, and root-owned `STATE_INITIALIZED` markers. Publication uses exclusive
temporary files, exact metadata checks, hard-link no-replace publication, and
file/directory fsync. Once a marker exists, a missing database or controller
lock is treated as lost trust evidence and reinstall refuses—even if the mount
looks empty. A nonempty unmarked mount also refuses.

The initial `locked:false` record is intentional only for an objectively empty
mount: there is no prior execution or panic evidence to preserve, and installation
still leaves the service disabled with every activation sentinel absent. After
initialization, unlocked is always an explicit durable state transition; absence
of the record never means unlocked and can never be reinitialized by reinstall.

The combined installer is intentionally separate from
`teleagent-worker-session-install`; the aggregate homelab/release handoff must
invoke it explicitly after provisioning these mounts.

## Configuration and activation

Install `/etc/teleagent/controller/runtime.env` as a canonical root-owned
`0600` regular file. It carries only the scoped controller tokens and reviewed
worker/privileged proxy settings. Do not place provider credentials there. The
unit fixes and the application revalidates `HOME`, database/lock paths,
loopback binding, and the hardened state-boundary mode; alternate paths are
rejected.

The privileged policy and public/replay keys remain as documented in
`PRIVILEGED-ACTIONS.md`. Its socket directory comes only from tmpfiles as
`0750 root:teleagent-control`; systemd `RuntimeDirectory` ownership management
must not be added. The broker keeps primary group `root` for root-owned state
and receives `teleagent-control` only as a supplementary group so it can
publish the `0660` controller socket without `CAP_CHOWN`.

After the installed verifier is green:

1. create and activate the worker-session sentinel/units using the reviewed
   worker activation procedure;
2. create `/etc/teleagent/privileged-action/ENABLE` as `0600 root:root` and
   start the privileged unit explicitly;
3. create `/etc/teleagent/controller/ENABLE` as `0600 root:root` and start the
   controller unit explicitly;
4. require controller and broker health before activating the voice stack.

Do not create a sentinel until the immediately preceding verifier and canary
is green. Neither unit has an `[Install]` section.

## Failure and recovery

Low capacity returns HTTP 507 for a genuinely new submission. Exact
idempotent retries remain readable and do not consume another capability;
panic, cancellation, recovery, and terminalization remain writable from the
reserved space. Health becomes not-ready whenever mount identity, metadata,
filesystem type/capacity, free-space admission, or a state file is unsafe.

In hardened mode, corrupt, missing, linked, non-`0600`, noncanonical, or
transition-pending controller lock state prevents startup. Panic and unlock
replace the explicit record atomically, fsync the file and parent, recheck
inode/metadata, and preserve an unresolved transition fence on ambiguous
failure. Unlock writes `locked:false`; it never unlinks the state file.

If a marker or trust-state file is missing, stop. Do not reinitialize it.
Restore the complete verified filesystem snapshot or investigate and migrate
it with an explicitly reviewed recovery procedure.
