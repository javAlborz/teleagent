# Hermes legacy voice lifecycle

This compatibility image adds one fixed credential/preflight bootstrap to an
immutable reviewed legacy base or candidate image. It does not deploy the
dedicated-staging architecture, enable execution, or add controller authority.
The homelab repository owns the Hermes systemd supervisor, Compose contract,
state migration and operator rollout evidence.

Run `node deploy/hermes-voice-runtime/build-hermes-images.cjs` from this clean
worktree. It builds with `--pull=false --network=none`, resolves fixed local tags
to the two reviewed immutable parent IDs before and after each build, and checks
the resulting layer ancestry. Only this directory is build context. Record the
sanitized build receipt and use the resulting immutable image IDs in the
root-owned host manifest. Never build from the dirty live phone checkout.

The nonlogin voice identity reads root-owned group-readable credential files
from `/run/secrets`. Secrets are read after Node exec; they do not appear in
Docker's command or environment metadata. The legacy app still receives its
expected process-local configuration values. General controller, executor,
privileged-action and approval credentials are absent.

Both the host controller and voice read the same root-owned, read-only locked
marker. Unlock remains unavailable for this bounded Hermes evaluation. Existing
panic responses must retain truthful PARTIAL behavior when a configured remote
plane cannot confirm quiescence. Do not treat this migration as proof of a working
privileged execution plane.

The preflight runs without networking and checks identity, protected files,
database integrity/inactive work and the shared panic lock. Voice startup repeats
these checks. Its writable mounts are limited to its canonical state and audio;
the shared lock and credentials are read-only. All SIP/media listeners remain on
loopback, under the existing root-owned PBX peer fence.

The `health` entrypoint proves that PID 1 owns established loopback sockets to
both 8021 and 9022. The host combines this with authenticated ESL and the
application's database/lock health endpoints. API-key configuration alone is
not a media-readiness signal.

Both actual images passed isolated startup/media/HTTP/locked-status validation;
the candidate also passed 21/21 Node 20 regressions. The baseline is installed on
Hermes with local stop/start and dependency recovery verified. Attended 7/77 call
canaries and the five-hour trial remain pending; a stopped candidate must not
share a running database writer with the baseline or bypass its supervisor.
The host reboot is explicitly deferred by the owner on 2026-09-07.
