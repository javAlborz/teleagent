# Independent PBX panic listener

This source provides a separate, stop-only controller receiver for Asterisk. It
does not install or activate a PBX route, grant phone execution approval, or prove
that any deployed phone stack has stopped. Production activation remains gated
by the exact release closure and commissioning evidence.

## Receiver and identity

| Item | Exact value |
| --- | --- |
| Socket unit | `teleagent-pbx-panic.socket` |
| Unix pathname | `/run/teleagent-pbx-panic/panic.sock` |
| Descriptor name | `pbx-panic` |
| Socket owner, group, mode | `root`, `teleagent-asterisk`, `0660` |
| Parent owner, group, mode | `root`, `root`, `0755` |
| Allowed requests | `POST /voice-control/stop`, `POST /voice-control/stop?response=plain` |

The normal controller listener remains separately owned by `root` with group
`teleagent-voice`. The PBX group grants no normal controller access. The panic
listener accepts no other method, path, encoded spelling, trailing slash, or
extra query parameter, even when the caller supplies a bearer. Denied requests
never reach Express. A private WeakSet grants emergency identity only while an
admitted request is being handled; caller headers and object properties cannot
grant it. Generic Unix connections are not loopback identities.

`pbxPanicListenOptions({ environment, pid, fileSystem })` validates exactly two
inherited sockets named `agent-controller` and `pbx-panic`, in either order. It
checks the current `LISTEN_PID`, root-controlled pathname and parents, dedicated
group, socket mode, and the inherited descriptor's listening Unix pathname in
`/proc/net/unix`. It returns `{ fd, exclusive: true }` without binding a new
pathname. Any mismatch refuses startup; there is no TCP fallback.

## Controller and installation integration

Root-owned release installation must include this module and socket unit in its
exact source/install pins. Provision the dedicated group without adding the
voice identity. Add this line to the root-owned tmpfiles declaration:

```text
d /run/teleagent-pbx-panic 0755 root root -
```

The controller service requires and orders itself after both socket units, and
explicitly declares:

```ini
[Service]
Sockets=teleagent-agent-controller.socket teleagent-pbx-panic.socket
```

Socket activation and inherited descriptors are separate service relationships;
see the upstream [systemd service definition of Sockets=](https://github.com/systemd/systemd/blob/v255/man/systemd.service.xml#L1002).
The root startup coordinator must retain exactly two named descriptors, transfer
them to the dropped-identity child, rewrite `LISTEN_PID` for that child, and close
its own descriptor copies. The normal listener must select its descriptor by
name too. Neither descriptor may survive into provider children.

Create one gate beside the second HTTP server:

```js
const panicGate = createPbxPanicRequestGate(app);
const panicServer = http.createServer(panicGate.dispatch);
panicServer.listen(pbxPanicListenOptions());
```

Only `panicGate.isPbxPanicRequest(req)` may supply the tokenless Unix panic
exception in authentication middleware. It grants no unlock or health access.
Both servers participate in startup failure cleanup, shutdown admission closure,
bounded drain, and forced connection closure. Validate both listeners before
opening either one. This module does not own application startup or shutdown.

## Future PBX route

Mount `/run/teleagent-pbx-panic` into only the independently controlled Asterisk
container, at the same pathname and read-only, with host numeric
`teleagent-asterisk` supplementary group membership. Mount the directory rather
than its socket inode so a root socket-unit restart remains visible. Give the
PBX neither the normal controller socket nor a controller bearer. A read-only
directory mount still permits connecting to its socket; host directory ownership
prevents pathname replacement by either application identity.

The PBX panic route must invoke a fixed, root-owned helper with no call-derived
arguments. The helper's controller request is exactly:

```sh
/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/curl --disable --silent --fail \
  --unix-socket /run/teleagent-pbx-panic/panic.sock \
  --proxy '' --noproxy '*' --max-redirs 0 --connect-timeout 1 --max-time 20 \
  --request POST --header 'Content-Type: application/json' \
  --data-binary '{"source":"pbx_independent_panic","reason":"phone_panic"}' \
  --write-out '\n%{http_code}' \
  'http://localhost/voice-control/stop?response=plain'
```

`localhost` is only the HTTP Host value; the connection uses the exact Unix
pathname. Do not retry against a TCP address, follow redirects, add a bearer, or
derive the URL/path/body from a caller or voice response. A successful controller
result requires all three conditions: curl exits zero, HTTP status is exactly
200, and the entire body is exactly `STOPPED`. Every other outcome, including a
timeout after accepting the stop, is `PARTIAL`. Suppress response diagnostics
from phone playback. Repeated stops are permitted; they never unlock execution.

For dialplan integration, use `TrySystem(/usr/local/libexec/teleagent-pbx-panic)`
with that fixed helper path. The helper exits zero only after the strict result
check above, otherwise nonzero; capture `SYSTEMSTATUS` immediately before any
other system command. Asterisk distinguishes successful execution, execution
failure, and a nonzero helper exit as documented by
[TrySystem](https://docs.asterisk.org/Asterisk_20_Documentation/API_Documentation/Dialplan_Applications/TrySystem/).
This is a future helper contract, not an installed helper or activated dialplan.

The controller stops its owned execution planes. The independent PBX route must
also preserve the existing voice-local stop and combine both results. Announce
whole-phone `STOPPED` only when voice-local persistence/quiescence and this
controller result are both confirmed. If voice is unavailable and its local
outcome cannot be proved independently, announce `PARTIAL` even if the controller
returned `STOPPED`. The controller fallback must still run when the voice request
fails. Never describe this transport as independent handset approval evidence;
see [the separate approval feasibility report](PBX-ADAPTER-FEASIBILITY-20260922.md).

## Verification before any live route

The module tests use disposable Unix HTTP listeners and mocked root metadata.
They prove request isolation and failure handling, not installed identity or
live PBX routing. Run them serially through `scripts/hermes-safe-test` with the
512 MiB/no-swap/128-task/one-CPU envelope.

On an isolated commissioning deployment, first check installed hashes, group
membership, socket ownership, both inherited descriptor names, and the payload
child's dropped identity. Use `GET /voice-control/stop` and `GET /health` on the
panic listener for non-mutating HTTP refusal checks: both must return 403.
Connecting can socket-activate the service, so do not use these checks against a
dormant live deployment. Verify a normal voice identity cannot connect to this
socket, and a PBX identity cannot connect to the normal controller socket.

Only then run explicitly scheduled stop/repeated-stop cases against disposable
work. Cover controller crash, each remote cancellation failure, PBX socket
replacement refusal, and unavailable voice. A timeout or partial result must
retain the lock and must never produce a successful whole-phone announcement.
These checks do not require approval signing keys or real provider requests.
