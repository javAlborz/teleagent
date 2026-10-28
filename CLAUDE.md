# Teleagent

Teleagent is a SIP phone interface for OpenAI Realtime, Claude Code, and OpenAI
Codex. The maintained CLI command remains `claude-phone` for compatibility with
the former Claude Phone project.

This file is the canonical repository guidance. Read it before changing the
call path, execution controller, authentication, approval flow, or deployment
artifacts.

## Current owner-session policy

The owner explicitly selected `native-session-permissions-v1`: instructions to
enrolled personal sessions are forwarded without an extra phone prompt or
keypad approval. The authenticated live handset call, protected controller
socket, exact enrollment, native process/session identity, host admission,
durable dispatch intent, duplicate suppression and emergency locks still apply.
The session keeps its native permissions; Teleagent neither changes them nor
answers native approval requests. An unrestricted session can act immediately.
There is no promise to classify free-form instructions into safe versus risky
actions. Managed phone jobs remain read-only and arbitrary privileged tools
remain unavailable.

The independently attested approval protocol below remains the historical and
unit-tested approval path. It is not the active policy for enrolled personal
session forwarding in this release. Never forge handset evidence to implement
the native policy; its controller-only forwarding route records no approval.

## Maintainer starting point

Read [Maintaining Teleagent](docs/MAINTAINING.md) for the repository boundaries,
call-path map, test selection, release sequence and handoff requirements. Source
merges, signed candidates, installed readiness and handset acceptance are
separate facts. Obtain live state from the installed operator and current host
runbooks; this guide is not an installation or recovery script.

## Product shape

- Extensions `7` and `77` use OpenAI Realtime for a full-duplex conductor. `7`
  starts a phone thread; `77` resumes durable phone state. They do not depend on
  the legacy STT/TTS path.
- The conductor can inspect enrolled personal Codex/Claude sessions and forward
  an authenticated caller's instruction using the native-session policy above.
  Enrollment and exact native identity are checked by the private broker.
- Managed provider jobs are a separate, read-only execution lane. Managed
  Claude/provider extensions must remain inactive until their matching host
  activation gates are accepted. Reading or forwarding to an enrolled personal
  Claude session does not activate a managed Claude worker.
- Runtime model names, profiles and routed extensions come from the reviewed
  configuration and selected release. Changing a model does not expand authority.
- The native public OpenAI SIP gateway remains a separate dormant canary until
  its ingress, PBX authentication and activation gates are explicitly reviewed.
- Outbound notification support in the source is not proof that its host lane
  is activated or that a callback reached a handset.

## Architecture and trust boundaries

```text
owner handset
    |
    v
Asterisk private PBX
    |
    +--> drachtio + FreeSWITCH + voice-app (unprivileged container)
             |          |
             |          +--> outbound WSS to OpenAI Realtime for 7/77
             |
             +--> authenticated root-owned controller Unix socket
                       |
                       +--> durable task executor
                       |       +--> fixed launcher -> teleagent-worker
                       |                    +--> Claude/Codex CLI
                       |
                       +--> private worker-session Unix-socket proxy
                       |       +--> worker-owned tmux sessions only
                       |
                       +--> exact enrolled owner-session broker
                       |       +--> existing personal Codex/Claude sessions
                       |
                       + - - retired privileged-action proxy boundary

exact-rule root broker (separate, dormant, and inaccessible to the controller)
```

The important split is capability-based:

- `voice-app` owns SIP/media, the Realtime API key, and durable phone state. It
  has no approval signing key, privileged-action bearer, sudo access,
  root-broker socket, general `/ask` bearer, or provider credentials.
- `claude-api-server` is the private controller. It owns durable managed executor
  state and scoped owner-session routing. Retired privileged-proxy access remains
  unavailable. It is not public ingress.
- `teleagent-worker` owns the bounded Claude/Codex workspace and provider
  processes. The controller reaches it only through the fixed root-owned
  launcher. Agent prompts go over stdin, never process argv.
- The worker-session broker runs as `teleagent-worker`, sees only its dedicated
  tmux socket and approved workspace roots, and receives no controller or root
  credential.
- The owner-session broker resolves enrolled native identities, preserves native
  permissions, and records delivery/completion separately. It must not use
  worker enrollment or broad tmux access as a substitute for that exact binding.
- The privileged-action broker runs separately as root, accepts only a private
  Unix socket, verifies signed canonical plans, and executes exact reviewed argv
  without a shell. Conversational agents never receive sudo or this socket.
- The optional native SIP gateway is a public-edge canary identity. It must not
  receive controller tools or infer caller authorization from a spoofable SIP
  `From` header.

Do not collapse these identities, mount a private broker socket into
`voice-app`, put a reusable bearer in an agent environment, share the owner's
tmux socket with the worker, or grant the worker broad sudo/group membership.

Legacy-call star cancellation uses explicit `scope: "task"` and the current
turn's durable idempotency key. The controller must select only that exact
call/key pair; the key is not merely a reservation alongside call-wide
cancellation. Whole-call cancellation remains a separate explicit/default
compatibility operation. Deploy the voice and controller changes as one
reviewed release: an older controller ignores the new scope field. Cancellation
acceptance or an aborted local wait never proves remote quiescence. Star during
thinking feedback suppresses submission locally; delayed cancel responses must
not issue media commands against result audio or a later turn.

## Authorization invariants

Three active HTTP bearer tokens are mandatory, clean, pairwise distinct, and
scoped:

| Credential | Routes |
| --- | --- |
| `AGENT_API_TOKEN` | general non-phone bridge routes |
| `EXECUTOR_API_TOKEN` | durable `/executor/**` routes |
| `VOICE_CONTROL_TOKEN` | `/voice-control/**`, operator, and unlock routes |

Controller route matching is case sensitive and rejects trailing slashes.
Keep those settings ahead of all middleware so handler matching and credential
scope classification agree, including the operator-only executor unlock route.

The privileged-action bearer and proxy implementation remain only as
unit-tested future substrate. The production controller service removes their
environment settings after `EnvironmentFile` processing and cannot access the
broker socket.

Committed example, placeholder, `changeme`, or `replace-with` values are
invalid. The production controller accepts only systemd's root-owned listener
at `/run/teleagent-controller/controller.sock`. Voice mounts its root-owned
directory read-only and retains the two scoped bearers; it cannot replace the
listener. This dedicated HTTP socket is separate from private worker/root
broker sockets. Voice clients never fall back to TCP, proxies, or redirects.
Direct development starts retain loopback binding; production state enforcement
requires `AGENT_API_TRANSPORT=systemd-unix`. Docker
Compose explicitly blanks the general and legacy Claude bearer inside
`voice-app`.

The managed `AgentJobBroker` path has no capability issuer or privileged bridge;
managed mutation and retired privileged execution stay unavailable. Enrolled
personal-session forwarding uses its separate native-session policy and broker.
Do not add a keypad prompt to that route based on the historical protocol below.
The retained attested capability primitives describe the historical/future
approval path, not authorization to activate a service:

1. Store the exact normalized request and canonical execution plan.
2. Have an independently isolated PBX attester, not `voice-app`, play the exact
   controller-canonical approval prompt and observe handset-side DTMF.
3. Persist request-bound prompt-completion and `#` evidence tied to the exact
   call leg; voice/FreeSWITCH events that voice can forge are insufficient.
4. Have a controller-owned authority atomically validate and consume that
   evidence, then issue a short-lived Ed25519 capability bound to job, call,
   request hash, canonical plan hash, target, provider/profile, key ID, expiry,
   and nonce.
5. The executor derives the SHA-256 SPKI fingerprint of the verifying public
   key and persists it with the admitting key ID. Immediately before the first
   external effect, both must still match the active verifier epoch—even when a
   replacement key reuses the same ID.
6. The executor or root broker atomically consumes replay state while inserting
   the durable work item. Raw capabilities and reusable credentials are never
   persisted.

The `telereq1`, `teleattest1` and `telecap2` contracts remain unit-tested
historical approval machinery. Installed ARI/attester services also participate
in owned shutdown and recovery; their presence does not imply that current
native-session forwarding requires an extra approval. Preserve these identities,
keys and signed proofs through the matching host authorities. See
`docs/PBX-APPROVAL-ATTESTATION-CONTRACT.md` for the attested protocol.

If that approval path is explicitly reactivated in a future reviewed policy,
call-start must invalidate an old arm and replay the exact prompt before rearming.
Early, clipped, cleared, lost, mismatched or timed-out evidence never authorizes
execution. Native forwarding never manufactures attested handset evidence.

Dial `9` is the independent emergency path. A STOPPED response is truthful only
after every configured execution plane has durably accepted the panic and is
quiesced. Partial failures stay locked and report PARTIAL. Unlock is refused
while durable work remains active.

## Durability and truthful outcomes

SQLite databases use WAL and `synchronous=FULL` for durable controller state.
Use compare-and-swap revisions and transactional outbox records for state
changes with external effects.

- Executor submission uses an exact idempotency key. Ambiguous POSTs are
  recovered with GET; never resend a one-time capability.
- Cancellation creates a durable reservation so a stale submit cannot start
  after cancel.
- Do not steal a live task lease during restart. Reconcile expired work with
  revision fencing and verify process PID/start identity before adoption.
- A crash or timeout after an external side effect may be `outcome_unknown`.
  Never rewrite uncertainty as a safe failure or silently retry a possibly
  executed mutation.
- Voice terminal state, audit/event rows, provider-session binding, and callback
  intent belong in one transaction. The callback drainer retries with a stable
  idempotency key and ACKs only an explicit queued response.
- Outbound dialing is restartable only before `dial_intent`. A crash after the
  intent becomes `outbound_outcome_unknown` and must not auto-redial.
- Shutdown first stops new accepts/claims, then boundedly drains tracked work,
  then releases leases and closes SQLite.
- Existing tmux delivery is completed only from exact provider-log evidence.
  After delivery starts, ambiguous interruption is never represented as
  "not delivered" and the message is never blindly resent.

Exactly-once external SIP delivery or physical speech is not achievable across
all crash points. Persist honest unknown states and require reconciliation.

## Privileged actions

Privileged plans use typed adapters (`systemctl`, `journalctl`, fixed SSH/Hera
routing, and fixed kubectl routing) or a complete exact reviewed argv/cwd rule.
There is no unlisted/spontaneous argv mode. Shells, interpreters, `env`, `sudo`
as a user-supplied executable, and dispatchers such as `find`, `xargs`, and
`systemd-run` are denied.

The root broker never returns or persists stdout/stderr previews. It stores only
bounded byte/line counts, truncation metadata, and a digest. Voice speaks the
canonical expected-result description; detailed root output requires a local
reviewed retrieval workflow.

See [docs/PRIVILEGED-ACTIONS.md](docs/PRIVILEGED-ACTIONS.md).

## Repository map

- `voice-app/`: SIP/media runtime, Realtime conductor, approvals, durable voice
  state, callback/outbound outbox, and scoped bridge clients.
- `claude-api-server/`: private HTTP controller, durable executor, worker
  launcher, operator/session proxy, approval verifier, and panic coordinator.
- `privileged-action-broker/`: root-only exact-plan policy, verifier, durable
  store, executor, and Unix-socket service.
- `realtime-sip-gateway/`: isolated native OpenAI SIP canary and webhook state.
- `lib/`: shared canonical plan, authorization, execution-environment, and
  approval-capability modules.
- `deploy/`: source-only policies and hardened service examples.
- `cli/`: compatibility installer and `claude-phone` command.
- `docs/OPENAI-REALTIME.md`: detailed conductor behavior and configuration.
- `voice-app/DEPLOYMENT.md`: service deployment and credential guidance.

The host systemd source lives in the sibling homelab repository. A release must
deploy each service together with the shared `lib/` modules it imports; the
individual npm package directories are not standalone source closures.

## Development workflow

Use Node 24 for aggregate validation, matching CI and the committed service
package engines. Read the lockfiles before installing dependencies. On Hermes,
first inspect whole-host headroom and use `scripts/hermes-safe-test` serially;
its limits do not make overlapping agent workloads safe.

```bash
npm test
npm run lint
git diff --check
```

The root test delegates to CLI, API server, voice app, privileged broker, and
native SIP suites. Deployable services keep committed lockfiles and production
installation uses `npm ci --omit=dev`. When changing a lock, also run a clean
production install/native-module import and `npm audit` for that package.

Useful focused commands:

```bash
npm run test:cli
npm run test:api-server
npm run test:voice-app
npm --prefix privileged-action-broker test
npm --prefix realtime-sip-gateway run check
```

Preserve unrelated dirty-worktree changes. Add crash-boundary, replay,
cross-scope-auth, cancellation-race, and restart tests for changes to durable or
privileged flows. Do not weaken a fail-closed activation gate merely to make a
development environment report ready.

## Configuration and operations

`.env.example` documents variables; it intentionally contains nonfunctional
placeholders. Secrets belong in ignored mode-`0600` files or systemd
`LoadCredential`, never Git, command argv, logs, transcripts, or agent prompts.
No approval private key belongs in voice. Production controller and root trust
anchors for the retired phone signer must remain absent/revoked. Attested signing
keys stay with their reviewed controller/attester authority; executor/root
verifiers receive only the corresponding public key. Preserve installed recovery
keys through the matching host procedures.

On the managed Hermes installation, start with the installed authenticated
operator. Storage inspection writes a small dry-run receipt but deletes nothing:

```bash
sudo teleagent-ops status
sudo teleagent-ops storage
```

New host services are sentinel-gated and installed disabled. Source readiness
does not authorize identity migration, provider login, port cutover, DNS,
Cloudflare Tunnel, OpenAI webhook subscription, SIP routing, service start, or
creation of an activation sentinel. Existing private controller/native-session
services have their own established activation state; preserve it. New or dormant
public SIP and privileged lanes remain gated by their documented acceptance.

## Documentation

- [Maintaining Teleagent](docs/MAINTAINING.md)
- [README.md](README.md)
- [docs/OPENAI-REALTIME.md](docs/OPENAI-REALTIME.md)
- [docs/PRIVILEGED-ACTIONS.md](docs/PRIVILEGED-ACTIONS.md)
- [voice-app/DEPLOYMENT.md](voice-app/DEPLOYMENT.md)
- [voice-app/README-OUTBOUND.md](voice-app/README-OUTBOUND.md)
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- [CONSTITUTION.md](CONSTITUTION.md)
