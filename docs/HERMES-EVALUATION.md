# Hermes isolated evaluation lane

This lane gathers one bounded part of the evidence needed before buying another
host: **does the phone agent show enough repeat usefulness and reliability to
be machine-eligible for a dedicated-node trial?** Machine eligibility is not a
purchase decision. The lane is not a phone-control surface and authorizes
neither a host purchase nor production.

## Split-process evidence boundary

No network-facing process can read the live database or query a loopback-trusted
phone service. Snapshot refresh is fixed at 30 seconds and has three isolated
stages:

1. A one-shot evidence collector runs in Bubblewrap with its network namespace
   unshared. It sees the live voice-state directory read-only and the single
   persistent trial-epoch file. Its stdout contains aggregate evidence only.
2. A separate one-shot health collector retains the host network solely to read
   the three fixed loopback health URLs. It sees no database, home directory,
   launch token, epoch, or facade snapshot. Its stdout contains an allowlist of
   booleans and the provider count only.
3. A network-isolated composer validates both sanitized outputs, discards every
   unknown field, constructs the scorecard, and atomically publishes one mode
   `0600` snapshot. The snapshot expires after 75 seconds.

The long-running Node facade has an unshared network namespace and listens only
on the fixed Unix socket
`/run/user/1000/teleagent-hermes-evaluation-preview/facade.sock`. It sees only
its static source/assets, one launch-token file, the socket directory, and the
read-only directory containing the sanitized composed snapshot. It has no
database, state-directory, health-client, production-service, or home mount.
Requests only read the cached snapshot; no request can trigger a collector.

The reviewed preview helper publishes fixed Tailnet HTTPS port `8491` directly
to that fixed Unix socket. Generic helper commands refuse port `8491`. A stale
route after a reboot points to a socket path inside the operator's mode-`0700`
runtime directory, not to a reusable unprivileged TCP port.

The facade accepts only `GET` and `HEAD`, limits itself to 16 connections, four
in-flight requests, 20 requests per socket, and 120 total requests per minute,
and uses short header/request/socket timeouts. The browser receives no-store,
default-deny CSP, frame/MIME/referrer protections, and a permissions policy that
disables microphone, camera, geolocation, display capture, and USB.

## Trial provenance

The first operator `start` that passes host/runtime preflight creates exactly one
persistent file before launching any evaluation process:

```text
/home/alborz/.local/state/teleagent-hermes-evaluation-preview/trial-epoch
```

It must remain a single regular file owned by UID 1000, mode `0600`, with one
link and an exact 24-byte UTC timestamp. The wrapper uses no-clobber creation and
never removes or rewrites it during start, stop, expiry, or snapshot refresh.
The offline collector receives only that file, mounted read-only.

Every database query is bounded on both sides. Its lower bound is the later of
the persistent trial epoch and the evidence collector's sample time minus 14
days; its upper bound is that sample time. Pre-epoch history and future
timestamps cannot satisfy a gate.
The response exposes the collection and window provenance:

- `evidenceSampledAt`: the upper bound used by every database query;
- `healthSampledAt`: the time of the separate loopback-health sample;
- `trialStartedAt`: the unchanged persistent trial epoch;
- `windowStartedAt`: the rolling lower bound actually used by the queries.

The UI labels these values **Trial began · fixed epoch** and **Current evidence
window began · max 14 days**. This distinction keeps the trial start truthful
after the 14-day window begins rolling. A new trial epoch requires a separate
reviewed operator decision; the normal wrapper deliberately provides no reset
command.

## Launch token

The wrapper creates a 32-byte random token encoded as exactly 43 base64url
characters in its private runtime directory. The facade requires a single
regular UID-1000-owned, mode-`0600`, one-link file with the exact shape.

The token is delivered after `#token=`. URL fragments do not reach Tailscale or
the HTTP server. Browser code immediately removes the fragment from the address
bar, holds the token only in memory, and sends it in the
`X-Teleagent-Evaluation-Token` header for `/api/summary`. It is never written to
cookies or browser storage. Treat the printed URL as a short-lived secret.

The page labels `generatedAt` as **Snapshot composed**, displays the snapshot's
age and remaining validity, and locally hides the entire dashboard at
`expiresAt` without waiting for another HTTP request. Summary fetches have a
five-second abort deadline. Visibility, page-show, and focus events recheck the
deadline so a browser timer suspended in the background cannot revive expired
green output.

## Known current Hermes limitation

The legacy voice runtime currently running on Hermes predates the hardened
`state.capacity.ok` health field. The collector therefore emits
`capacityHealthy: null`. The dashboard displays this as **Unknown ·
unsupported**, not unhealthy: missing proof does not show that capacity is
exhausted.

The distinction does not weaken the gate. Machine eligibility is intentionally
blocked until a hardened runtime explicitly reports healthy capacity telemetry.
The bounded Hermes trial may continue accumulating session, turn, and usage
aggregates in the meantime. Latency, barge-in, usefulness, and privacy remain
manual observations recorded outside the lane. Starting this evaluation lane
does not deploy or restart the phone runtime.

The controller observation is also deliberately connectivity-only while the
persistent voice panic is held. Its `/health` endpoint responds but intentionally
reports not-ready under that fence. The UI therefore says **Responded ·
readiness fenced**; it does not claim that this is a controller health pass.

## Operate on Hermes

```bash
cd /home/alborz/dev2/teleagent-architecture-20260826
scripts/hermes-evaluation-preview start
scripts/hermes-evaluation-preview status
scripts/hermes-evaluation-preview url
scripts/hermes-evaluation-preview stop
```

`start` collects the first snapshot and proves the Unix facade healthy before
arming both the route watchdog and bounded two-hour expiry timer. It verifies
both guards active before invoking the helper's fixed `evaluation-up`. A failure
before publication leaves no new route. After publication, every failure path
first creates a private `cleanup-pending` marker and attempts the same verified
teardown: remove and recheck the exact route, stop and recheck the main unit,
unlink and recheck the fixed socket, and remove the token, readiness marker, and
cached snapshot. The wrapper clears `cleanup-pending` and reports success only
when every postcondition holds. Otherwise it returns an error without claiming
the backend stopped and retains the watchdog and expiry path for retry.

The watchdog polls the Unix facade and reacts after three consecutive failures.
It uses that same route, process, socket, and file teardown. Any unresolved
postcondition makes the watchdog fail and restart, and unlinking the socket
causes subsequent health probes to fail even if a main-unit stop request did not
take effect. A restarted watchdog checks `cleanup-pending` before accepting a
healthy facade, so simultaneous route, process, socket, and file-cleanup failure
cannot return it to monitoring mode. Normal stop and expiry use the same state
machine; cleanup guards are stopped only after teardown succeeds. The trial
epoch persists.

The outer transient service has a hard two-hour lifetime, one-CPU quota,
1536-MB memory limit, 128-MB swap limit, 192-task limit, and 256-file-descriptor
limit. It is not network-facing. It serially launches the short-lived
collectors and owns the network-isolated facade cgroup. Neither the facade nor a
collector invokes `sudo` or the preview helper.

## Machine eligibility scorecard

The machine gates evaluate only rows inside the current evidence window:

| Gate | Threshold |
| --- | --- |
| Persistent voice panic | explicitly locked and persistent |
| Evidence store | offline aggregate query succeeds |
| Voice health | endpoint explicitly healthy |
| Realtime health | endpoint, configuration, state, and capacity all explicitly true |
| Controller connectivity | fixed loopback endpoint responded; readiness remains intentionally fenced by panic |
| Sessions | at least 5 terminal current-window sessions and no open/unknown sessions |
| Days with sessions | activity on at least 3 current-window days |
| Conversation depth | at least 15 accepted user transcript events |
| Session reliability | at least 90% of closed/failed sessions closed normally |
| Accounting | at least one validated response record with positive tokens |

Missing panic proof always says to stop and restore the lock. Unavailable
database evidence produces a distinct **repair the evidence lane** decision and
null/unknown metrics, never fake zeroes. A reported `false` capacity value is
**Unhealthy · reported**; a missing legacy value is **Unknown · unsupported**.
Both block machine eligibility, but only the former is an observed unhealthy
state.

All machine gates passing yields only **machine evidence threshold met**. Every
response carries `manualReviewRequired: true`, `investmentAuthorized: false`,
and `productionAuthorized: false`. The dashboard is a machine eligibility
signal, not an automated go/no-go or purchase approval.

A time-boxed dedicated-node trial requires all three decisions outside this
surface:

1. every machine gate passes;
2. the latency, barge-in, usefulness, expected-cost, and privacy rubric is
   completed and recorded separately;
3. the trial budget is explicitly approved.

Passing those prerequisites authorizes, at most, a separately executed and
time-boxed node trial. It does not authorize daily use or production.

The dashboard displays the manual rubric but does not store answers. A refresh
failure hides the old dashboard and marks the safety state unknown. The local
`expiresAt` deadline independently hides it if refresh is delayed, hung, or
suspended.

Agent jobs are displayed as completed/total and are explicitly descriptive, not
scored. Zero jobs can still pass the machine evidence score because persistent
panic intentionally prevents this lane from proving agent execution. Days with
sessions show activity across dates, not distinct or returning caller identity.
Token values are usage accounting, not provider billing or a cost estimate.
None of these aggregates authorizes work, replays requests, or exposes content.
The lane does not prove caller identity, hardened execution, mutation safety,
purchase value, or production readiness.

## Validate without launching

```bash
scripts/hermes-safe-test npm run test:evaluation
scripts/hermes-safe-test npx eslint evaluation/hermes-preview
git diff --check
```

The focused suite uses disposable databases and ephemeral test listeners. It
checks the production schema contract, pre-epoch/future exclusion, strict health
proof, malformed accounting, snapshot sanitization/expiry, token and epoch file
metadata, HTTP bounds, and static import/mount separation. Browser tests use a
fake clock to cover distinct fixed-epoch/rolling-window dates, legacy-capacity
unknown versus reported unhealthy, failed refresh, local expiry without a
fetch, suspended-timer resume, and a hung fetch abort. The suite does not read
the live database, publish a route, or launch the fixed runtime service.
