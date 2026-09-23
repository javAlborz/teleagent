# Privileged phone actions

This path is a separate two-phase control plane. The Realtime conversational
worker and the Claude/Codex workers never receive root, sudo, the broker Unix
socket, the Ed25519 private key, or a reusable privileged bearer.

Status: the phone path is production-disabled. Voice has neither a signer nor
the privileged proxy bearer; the controller service discards legacy proxy and
verifier settings after `EnvironmentFile` processing and cannot access the
broker socket. The code below is retained typed-policy and recovery substrate,
not an activation procedure.

## Request and approval flow

The future independently attested flow is:

1. The controller turns a typed request into one canonical action plan:
   exact argv array (never a shell string), target, cwd, timeout, impact/risk,
   and expected observable result.
2. An isolated PBX attester—not voice or a voice-controlled FreeSWITCH event
   source—plays the controller-canonical prompt and durably attests later
   handset-side `#` for the exact call leg and request.
3. A controller-owned authority validates and atomically consumes that evidence,
   then issues a short-lived Ed25519 capability bound to the full
   canonical plan hash, call/job, target, provider/profile, method, timestamps,
   and a random nonce.
4. The controller dispatches internally over the private broker socket. Voice
   receives neither the capability nor a privileged bearer/socket membership.
5. The root broker verifies policy and signature, atomically consumes a keyed
   replay fingerprint and inserts the durable action/audit/outbox records, then
   executes the exact argv without a shell. It never stores the capability,
   bearer, raw nonce, or reusable token digest.
6. Ambiguous POST outcomes are recovered only with GET by idempotency key. The
   one-time capability is never POSTed again.

Early `#`, interrupted/clipped speech, transcript normalization, response/item
mismatch, and expired approvals all remain blocked. A disconnected call leaves
an unarmed approval that extension 77 can replay exactly until its TTL. Three
unverifiable replay attempts cancel it without execution.

## Supported plans

- `systemctl` and `journalctl` use fixed local executable paths and root policy
  unit/action allowlists.
- `ssh` reaches Hera directly. Aphrodite, Dionysus, Prometheus, Atlas,
  Hephaestus, and Zeus use the fixed Hermes -> Hera -> named-host route. Zeus is
  explicitly Windows; Linux-only uptime/systemd actions are rejected for it.
- `kubectl` uses the approved SSH route to Hera and fixed
  `/usr/local/bin/kubectl` path.
- `argv` is a deliberately disabled-by-default exact-rule adapter. It accepts
  an argv array only when the entire canonical argv and cwd match a root-owned,
  pre-reviewed rule: no shell, eval, PATH lookup, whitespace-bearing tokens,
  metacharacters, shells/interpreters/env/sudo, credential flags/headers,
  sensitive trust/key operands, or command dispatchers such as `find`,
  `xargs`, and `systemd-run`. At execution time the executable must still be a
  canonical root-owned, non-group/world-writable regular file below an
  explicitly allowed root.

There is no spontaneous or "unlisted" argv mode. A local rule is exact:

```json
{
  "enabled": true,
  "allowed_executable_roots": ["/usr/bin", "/usr/local/bin"],
  "exact_rules": [
    { "argv": ["/usr/bin/systemctl", "is-active", "example.service"], "cwd": "/" }
  ]
}
```

Named-host exact argv similarly requires a complete host-specific `exact_rules`
entry. Remote sudo, when explicitly enabled for a Linux host, accepts only the
fixed `/usr/bin/sudo -n <canonical executable> ...` prefix and the complete
resulting argv must match the rule. Legacy unlisted-mode policy fields are
rejected if enabled.

Privileged stdout and stderr are never persisted or returned to voice/OpenAI.
The broker stores only bounded byte/line counts, truncation metadata, and a
SHA-256 digest after applying its streaming bounds. This digest-only rule also
applies to typed read adapters such as `systemctl status` and `journalctl`,
whose otherwise arbitrary output can contain credentials. The canonical safe
expected-result description is spoken on success; detailed output remains
available only through a separate, locally reviewed operator workflow.

## Truthful crash and cancellation semantics

- Cancellation while still queued is terminal `canceled`; no process ran.
- Once execution intent/process spawn is durable, timeout, cancellation,
  nonzero exit, broker shutdown, or restart without a verified postcondition is
  terminal `outcome_unknown`. The action is never resent.
- Observation failure after an exit-zero action is also `outcome_unknown`.
- The broker takes a SQLite `BEGIN IMMEDIATE` writer lock before recovery and
  retains it for its process lifetime. A second broker waits at most 250 ms
  before refusing; this also lets one owner win a simultaneous stale-database
  startup without two shared readers deadlocking on an exclusive upgrade.
- Before every spawn the broker durably records a one-use process-marker hash;
  after spawn it also records the exact Linux PID, `/proc` start time, and
  process group. On restart, a persistent recovery panic is established before
  the Unix socket listens or any new claim is possible. The broker binds only
  matching marker/identity records, sends TERM then KILL to their exact process
  groups, and waits for verified zero. Ambiguous identity or an unreadable
  process leaves recovery blocked and health at 503. Even successful cleanup
  leaves ordinary panic locked for root-local review.
- `KillMode=control-group` kills surviving descendants on service failure as a
  second containment boundary, but that does not prove whether a side effect
  occurred. Linux `/proc` process identity and process-group semantics are a
  required activation boundary; the broker fails closed elsewhere.
- Panic atomically cancels queued work and requests cancellation of running
  work. The controller persists its voice/executor lock before forwarding the
  root panic, and privileged submission refuses either controller lock. The
  root panic also fences the precheck/submit race atomically. Dial 9 reports
  STOPPED only after both executor and root planes report quiescence; otherwise
  it remains locked and reports PARTIAL. There is intentionally no
  phone/network root-panic unlock endpoint.

## Dormant source deployment

The tracked unit has no `[Install]` section and requires an absent-by-default
`/etc/teleagent/privileged-action/ENABLE` sentinel. No source checkout action
installs, enables, starts, or creates a secret.

Artifacts:

- `deploy/privileged-action/teleagent-privileged-action.service`
- `deploy/privileged-action/teleagent-privileged-action.sysusers`
- `deploy/privileged-action/teleagent-privileged-action.tmpfiles`
- `deploy/privileged-action/policy.example.json`
- `privileged-action-broker/`

The following broker prerequisites remain useful for offline validation, but
they do not authorize phone activation:

1. Install the pinned broker dependencies with its own `package-lock.json` and
   package-local `node_modules` into the root-owned deployment tree. `NODE_PATH`
   and sibling/global dependency resolution are forbidden.
2. provision the exact dedicated 1-8 GiB durable filesystem at
   `/var/lib/teleagent-privileged-action`, then run the digest-pinned combined
   disabled installer in `deploy/controller` as described in
   `CONTROLLER-DEPLOYMENT.md`;
3. verify
   `/run/teleagent-privileged-action` is `0750 root:teleagent-control`;
4. install a reviewed `0600 root:root` policy and explicitly choose every
   allowed unit, namespace/resource, host/action, and exact argv rule;
5. install the matching approval public key and an independent 32-byte replay
   fingerprint key as `root:root 0400/0600` files;
6. keep the `ENABLE` sentinel absent and do not provision a voice/controller
   privileged bearer or proxy settings. Activation remains blocked until the
   independent attester/controller design and its real-call recovery tests are
   reviewed.

The broker's first start command is the external host-owned release
`--check-start-gate`, invoked with an empty environment before Node. It cheaply
revalidates the current-boot approval/gate, selected release and manifest
identity, plus installed runtime metadata; full release scanning remains the
serialized disabled-handoff responsibility.

The unit is `User=root`, `Group=root`, with only `teleagent-control` as a
supplementary group. There is deliberately no `RuntimeDirectory=`: tmpfiles is
the sole owner of the socket-directory metadata. The broker has explicit CPU,
memory, swap, task, I/O, file-size, descriptor, and core-dump bounds; an empty
capability bounding set; and read/write access only to its private run and
durable-state roots. The pinned Node 24 runtime is invoked with `--jitless`, so
V8 does not allocate executable memory and the unit's
`MemoryDenyWriteExecute=yes` policy remains compatible. Its own package-local
`better-sqlite3` native addon must be present in the immutable release.

The privileged database, replay fingerprints, panic/recovery state,
`outcome_unknown`, append-only audit, and outbox are never deleted by retention.
The separate filesystem bounds total host exposure. New submissions fail with
507 below the greater of 20 percent or 512 MiB free, while exact retries,
cancellation, panic, recovery, and terminal truth retain the reserved space.

Do not mount the socket into Docker or add `teleagent-sip-gateway`/voice-app to
`teleagent-control`.

## Root-local panic recovery

Stop the broker and inspect local status first:

```sh
sudo systemctl stop teleagent-privileged-action.service
sudo env TELEAGENT_PRIVILEGED_STATE_BOUNDARY=required \
  PRIVILEGED_ACTION_DB_PATH=/var/lib/teleagent-privileged-action/actions.sqlite \
  /opt/teleagent/node/bin/node /opt/teleagent/current/privileged-action-broker/control.js status
```

After investigating every `outcome_unknown`, unlock only with the local command:

```sh
sudo env TELEAGENT_PRIVILEGED_STATE_BOUNDARY=required \
  PRIVILEGED_ACTION_DB_PATH=/var/lib/teleagent-privileged-action/actions.sqlite \
  /opt/teleagent/node/bin/node /opt/teleagent/current/privileged-action-broker/control.js unlock-panic
```

The broker must first complete its startup child-recovery pass. The local
command never kills or guesses about an orphan itself: it refuses a live broker
socket, a persistent recovery barrier, an unverifiable `/proc` scan, any marked
privileged child, any unresolved durable process record, or any durable
running/cancel-requested action. It conservatively terminalizes otherwise
stranded execution intent as `outcome_unknown` and appends the unlock
audit/outbox record.
