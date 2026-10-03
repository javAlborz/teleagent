# Native owner-session control

## Phone feedback

When an instruction is awaiting the independent PBX prompt, the conversational
voice stays quiet so it does not overlap or contradict that prompt. Delivery
status uses short fixed wording: acceptance means the native session accepted
the instruction, not that its task completed. Unknown delivery must be checked
before any resend.

Codex readback identifies the newest turn separately from bounded recent
history. The immediate spoken result uses only that turn's reply and status;
an unfinished or reply-less turn must not reuse an older completion. These
feedback changes do not alter approval requirements or native permissions.

Status: implemented transport and durable-delivery tests; **not phone-enabled**.
The separately testable owner broker and Unix API are source-only. They have no
installed unit, production route, enable setting, or trust key. Its service
entrypoint is deliberately read-only until the authority integration is reviewed.
The production phone release still provides its accepted read-only features.

The requested MVP is to select an existing owner Codex or Claude Code session,
read its recent conversation, and send one exact confirmed instruction. Existing
session permissions continue to govern its work, including repository edits and
deployment. This does not require another model process, a copied checkout, or
terminal keyboard injection. A separate multi-repository job launcher remains
later work; merely finding a clone never grants write authority to it.

## Implemented boundary

- Codex uses its existing daemon's Unix WebSocket endpoint. Only initialization,
  loaded-thread listing, thread metadata, bounded recent turns, starting a turn,
  and steering an exact active turn are allowed. No thread resume/fork, shell,
  process-spawn, configuration, login, or permission-response RPC is available.
- Claude uses the exact live registration and native inbox socket. The message
  carries the current session UUID. It cannot answer a permission prompt or
  impersonate the recipient's child/permission class; native inbound controls
  may hold or refuse it. No recipient auth token is read.
- Operator-configured endpoints bind owner UID, process PID/start identity,
  current boot, listener ownership, and socket device/inode. Symlinked or
  other-user-writable endpoints fail. The session fingerprint also binds
  provider, session UUID, and workspace. Names and tmux titles are not identity.
- Recent history is bounded, omits tool payloads, and uses existing credential
  redaction. Claude reads at most 256 KiB from the exact session log; Codex caps
  inbound frames and reads at most three turns. This is a recent-history view,
  not a complete transcript or a guarantee of detecting every possible secret.
- Delivery requires an exact signed `telecap2` request. The host verifies the
  signature and operation bindings itself. Capability replay consumption and
  delivery intent commit together with SQLite WAL and `synchronous=FULL` before
  submission. No raw capability or instruction is stored in the delivery table.
- Duplicate operation IDs return their existing state. A different request with
  the same ID is rejected. Lost responses, crashes after intent, and errors
  after admission never cause automatic resend. An RPC acceptance is not work
  completion. A Claude socket write is only `submitted_unconfirmed`.

The adapters are host-side library code. They do not authorize giving the phone
container, controller, or provider worker the owner's tmux/daemon sockets,
credentials, home directory, or unrestricted execution. There is no tmux send
fallback when a native endpoint is unavailable.

## Exact enrollment and controller boundary

The host broker exposes list, inspect/history, prepare, deliver, result and panic
operations over one private Unix listener. It refuses TCP requests, extra request
fields, oversized bodies, arbitrary socket paths and generic RPCs. The controller
proxy never retries delivery: it queries the durable operation ID and plan hash
after a lost response. One native operation runs at a time, with no waiting queue;
panic can persist an admission lock while an inspection is in flight.

A root-owned catalog enrolls exact session IDs, friendly labels, canonical
workspaces, UID, PID/start time, boot, socket identity and executable identity.
Enrollment does not claim liveness; inspection revalidates it. Session output
cannot enroll another target. Catalog changes revoke an in-flight preflight
before admission. Paths under the laptop work bridge are refused. Native daemon
or session replacement requires fresh operator enrollment. The service uses an
exclusive lifetime lock and inherits only the root-owned controller-group Unix
listener. It cannot start without its protected catalog and private state root.
The host namespace/unit installation remains outstanding; the library alone is
not an isolation proof.

## Observed on Hermes, 2026-09-30

Read-only requests against the existing Codex 0.159.2 daemon listed five loaded
threads, read their runtime metadata, and read active-turn identities. The live
daemon requires an object `params` for `thread/loaded/list`. Four Claude Code
2.1.285 interactive registrations passed the native socket/process/session
identity checks. Their 0664 metadata is accepted only inside the owner-only 0700
registry with one file link; live permissions were not changed. The installed
Claude receiver checks the supplied session UUID before enqueueing a message.
No messages were sent to those sessions and no new agent/daemon was started.

These observations establish discovery, not production delivery acceptance.
The tests use synthetic Unix sockets and synthetic signing keys. They cannot
prove handset identity, native provider execution, or deployment acceptance.

## Required before phone activation

1. Install a separately reviewed host owner broker with a narrow controller
   socket and an operator-owned catalog. Keep provider sockets out of voice and
   worker namespaces. Exclude work-bridge targets from this local execution
   lane and preserve existing repository/organization authority rules.
2. Complete the independent Asterisk approval adapter and controller authority
   in [the PBX contract](PBX-APPROVAL-ATTESTATION-CONTRACT.md). Bind the exact
   message, target fingerprint, active turn, and canonical plan to approval.
3. Integrate the broker into durable controller/voice jobs and expose truthful
   submitted, held, accepted, completed, and unknown states. Add exact-message
   provider evidence for reconciliation; transport ACKs alone are insufficient.
4. Define recovery and panic for owner sessions. The current delivery lock
   prevents new submissions but reports `quiesced: false`; personal agents may
   keep working. Never report STOPPED solely because the broker is locked.
5. Review resource admission for already-running owner agents, durable-state
   retention, key rotation, the operator catalog, and the complete signed release
   closure. Then run one isolated native-provider acceptance and an attended
   phone approval before enabling the feature.

Until those steps pass, keep the live phone release selected. Do not produce
another full release bundle merely to install unused adapters.

## Validation

Run the focused owner-session suite with the Hermes bounded test helper and
existing dependencies. It exercises Unix transport, exact steering, redacted
history, swapped registrations/endpoints, invalid authority, durable ambiguity,
concurrent duplicates, panic admission, and the production import boundary.
The regular hosted PR validation runs the full repository suites.

Native protocols: [OpenAI App Server](https://learn.chatgpt.com/docs/app-server)
and [Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).
OpenAI explicitly describes App Server and its WebSocket transport as
experimental and unsupported for production. The Unix endpoint uses that
transport too. Exact executable enrollment and regression tests reduce accidental
version drift; they do not turn it into a supported production API. Native
acceptance must be repeated after changing the enrolled daemon executable.
Unsupported protocol shapes fail closed.

## Durable controller coordination

`owner-approval-coordinator.js` is the source controller coordinator, still not
imported by the production HTTP service. It snapshots the broker's exact plan,
resolves the native trunk SIP Call-ID through the independent attester, and
constructs the approval prompt itself. One pending approval is admitted at a
time. Only verified evidence from the three-key protocol can reach the broker's
signed delivery endpoint.

The controller commits a dispatch intent before issuing its one-time capability.
It never persists signed artifacts. It stores the exact instruction in protected
controller state, just as a durable job needs its request; that text must not be
included in diagnostic logs. Cancellation or panic while awaiting confirmation
prevents later evidence from starting delivery. A crash invalidates unfinished
approvals, while a dispatch crash queries the exact operation ID and plan hash.
An ambiguous response remains unknown until that query finds a native broker
receipt. Neither recovery nor repeated phone tool calls resubmit the instruction.
Transport acceptance is still not task completion.

The source coordinator requires independent admission checks. Unit installation,
protected keys/state, authenticated routes, handset SIP Call-ID propagation,
native completion evidence and production panic integration remain outstanding.

The source host-admission guard checks whole-host memory/CPU pressure, load,
root/state disk reserve, and headroom in Hermes's existing aggregate owner pool.
It verifies that pool's 11 GiB memory, five-core CPU and 5,000-task ceilings;
it does not add a daily Codex allowance. A target process must belong to that
pool. A missing, asynchronous or refusing broker admission guard prevents signed
delivery before the durable effect boundary. Runtime service wiring must pass
these checks and verifier-epoch checks; the source read-only entrypoint still
cannot enable delivery.

An independent star press during prompt generation now cancels that approval
before playback. Outside approval, the ARI router forwards only the owner's star
to the conductor trunk for existing cancellation behavior.

## Shutdown scope

Owner-session panic durably fences new delivery and separately reports whether
Teleagent's in-flight delivery slot and approval work have drained. It always
reports personal-agent execution as unproven. The controller requires every
managed plane to quiesce before reporting `ownedQuiesced`; generic failures or
partial delivery cannot establish that proof.

The voice lifecycle can use this narrower proof to stop its owned containers.
Its activation journal records `owned_quiesced`, including after offline
recovery, rather than full quiescence. Both phone-facing panic endpoints continue
to return HTTP 503 / PARTIAL. Personal sessions are never killed, cancelled,
restarted, or resent by this path. Root host recovery must independently stop
and verify the owner broker, PBX attester and ARI proxy and preserve this scope
before the feature can be activated.
