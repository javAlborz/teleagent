# Phone agent architecture

Status: accepted target design. Production read-only phone work remains
available, but mutating, target-session, and privileged phone work is
fail-closed until the independent PBX-attested approval authority described
below exists and every promotion gate passes.

## Decision

The phone is an authenticated intent and authorization interface. It is not a
trusted shell, a provider session terminal, or the owner of privileged state.

Every Claude or Codex request runs as a fresh, bounded provider job. Teleagent's
durable stores—not a provider-native conversation or resume ID—are the only
continuity boundary. Mutating work enters a durable executor before a provider
starts. Read-only work may use the same provider boundary directly, but it gets
no mutation, approval, secret, private-network, or privileged capability.

The system assumes all of the following can be hostile or fail at any time:

- caller-controlled speech, SIP identity fields, DTMF, and model output;
- prompts, repositories, hooks, configuration files, MCP/tool descriptions,
  and provider subprocesses;
- a provider job after it has received an approved prompt;
- local unprivileged processes and compromised same-host applications;
- network peers other than the exact mutually authenticated PBX;
- process, host, container, or power failure at every side-effect boundary.

## Trust planes

```text
handset
  |  registered endpoint
  v
Asterisk/PBX + isolated approval attester
       |  mutual SIP authentication                 | authenticated,
       v                                            | request-bound evidence
voice/media plane ----------------------------------+
       | read-only scoped request                   v
       +---------------------------------> controller + durable ledger
                                                |             |
                                       read-only|             |approved mutation
                                                v             v
                                      provider boundary   durable executor
                                                |             |
                                                +------v------+
                                               privileged broker
```

The drawing shows authority, not process placement. Every arrow is narrower
than the plane before it and must be authenticated independently.

### Voice and media plane

The voice application may interpret speech and maintain conversational text.
It cannot execute provider/root work, hold an approval signing key or
privileged bearer, or produce authorization-grade DTMF evidence. Production
constructs it without a capability issuer or privileged bridge.

Inbound calls must authenticate as the PBX before caller identity, media,
thread state, or approval state is created. Callback calls use a separate PBX
credential and a server-owned route. Caller `From`, `To`, `Contact`, and supplied
dial URIs never select an authenticated outbound target. The voice runtime does
not register handset or assistant device accounts with any other SIP registrar;
device configuration contains persona and routing metadata, not reusable SIP
passwords.

Legacy STT/TTS helpers are disabled unless their exact local loopback endpoint
is part of the reviewed release contract. They do not accept arbitrary base
URLs or redirects, because both call content and any helper credential are
sensitive.

The production Realtime client is pinned to the reviewed OpenAI WebSocket
origin, path, model, transcription model, and voice set. Configuration cannot
redirect the provider credential or call stream to another origin.

Handset confirmation becomes useful only after an independently isolated PBX
attester—not voice and not a FreeSWITCH event source voice can inject into—plays
the controller-canonical summary and durably attests later handset-side DTMF
for the exact call leg and request. Dormant fixture modules now specify three
non-interchangeable Ed25519 artifacts: controller arm `telereq1`, PBX evidence
`teleattest1`, and controller execution capability `telecap2`. They enforce
exact prompt/request/plan/call-leg bindings, temporal ordering, distinct key
roles, and atomic replay consumption. They are not imported by a production
entrypoint and provide no activation authority. A real controller-owned
authority must validate that evidence and internally dispatch one call-bound
capability for one canonical action plan. Voice never receives a signer or
capability. See `PBX-APPROVAL-ATTESTATION-CONTRACT.md`.

### Controller and durable executor

The controller owns scoped HTTP authentication, request classification, and
coordination. Active general, executor, outbound, and voice-control tokens are
distinct and non-interchangeable. The production service removes legacy phone
approval-verifier and privileged-proxy settings after reading its environment
file and cannot access the privileged socket. The voice-to-controller endpoint is a
fixed numeric loopback address and port with redirects disabled; configuration
cannot redirect a scoped bearer or signed action to another destination.

Production mutating requests are rejected before durable submission. The
retained future path records approved mutations in a durable task ledger with
idempotency, approval, cancellation, and recovery truth. Immediately before a
first provider or tmux effect, the executor also requires the currently active
verifier and exact admitting key epoch: both the persisted key ID and the
verifier-derived SHA-256 SPKI fingerprint must match. Replacing a public key
under the same ID therefore revokes pre-rotation queued work. Revoked/pre-cut
queued work fails; already-attempted target delivery retains GET-only
reconciliation.

A provider start intent is itself durable. Once execution may have crossed the
provider boundary, a crash, timeout, cancellation, malformed response, or lost
acknowledgement is `outcome_unknown` unless completion is positively proven.
Unknown work is never silently retried.

### Provider execution boundary

Claude and Codex are separate providers and separate Unix identities. Each
managed request uses a fresh transient systemd unit and launch-private home.
Interactive panes, native resume/session IDs, provider-wide session stores, and
shared provider homes are not part of the production architecture.

The provider job receives:

- one exact, broker-selected workspace projection beneath a root-owned parent
  that the model cannot create, rename, or replace;
- read-only or read-write access matching the durable authorization;
- a fixed nonsecret local API sentinel;
- bounded CPU, memory, process, output, file, time, and request allowances;
- no controller, approval, PBX, signer, provider, or privileged credential;
- no unrelated repository or deployment source; the selected workspace may
  contain its own `.git` metadata when that metadata is part of the authorized
  task projection;
- no host `/run`, private-network route, arbitrary Unix socket, or unrestricted
  provider-side hosted tool.

The supervisor, shim, and credential-holding egress broker use separate Unix
identities. The shim alone receives a per-launch random capability. The egress
broker alone receives the real provider credential and injects it only after
validating the exact pinned provider, model, effort, route, headers, body shape,
tool shapes, expiry, and local allowance. Provider billing remains authoritative;
local counters are conservative request and reserved-token allowances, not a
currency balance.

All descendants belong to one kernel-owned transient cgroup. Stop, panic, and
recovery are successful only after that cgroup is proven empty and in-flight
egress is durably revoked and drained.

### Privileged broker

The root broker accepts only a signed canonical action whose argv, cwd, target,
and expected result exactly match a root-owned reviewed policy. Shells,
interpreters, dispatchers, environment expansion, caller-controlled executable
selection, and raw command output are outside the protocol.

Only digest/count-level completion truth crosses back into the conversational
plane. Detailed privileged output remains in a separately reviewed local
operator path.

## Continuity

Teleagent preserves conversation text, task state, approvals, callbacks,
cancellation, and terminal truth in its own SQLite stores. It does not trust or
persist Claude/Codex session IDs.

This deliberately trades provider-native conversational memory for isolation
and reproducibility. A later call receives only the bounded context that the
controller explicitly reconstructs from durable Teleagent state.

## Panic and shutdown

Panic first persists locks and cancellation intent, then independently stops
new admission and drains every execution plane. `STOPPED` is truthful only when
all applicable planes report durable acceptance and verified local quiescence:

- controller requests and children;
- durable executor work;
- inbound and outbound voice calls;
- provider transient units and egress requests;
- privileged root actions.

If any plane is ambiguous, the system stays locked and reports partial or
unknown. Singleton fences and protected runtime credentials remain held until a
clean close or process death; a replacement may not recover or claim work early.

## Secrets and deployment

Secret values are never sourced from a repository `.env`, broad service
environment, provider-readable home, container command line, or Docker container
environment. Root-owned fixed credential files are projected through systemd
credentials and private runtime files to the one process that needs each value.
Caller transcripts, prompts, provider output, and remote response bodies are
durable application data, not journal fields; routine logs contain only bounded
metadata and fixed error classifications.

Drachtio and FreeSWITCH consume protected generated configuration files, not
secret command-line flags. Their control listeners and the voice client's
credential-bearing connections are pinned to exact loopback addresses and
ports. The `drachtio-fsmrf` reverse ESL callback is also explicitly bound and
advertised on loopback; its dependency default may otherwise select the first
non-loopback host interface. Static/generated media is private runtime data and
is served only through exact no-follow paths.

The tracked host-network nftables table is a transitional sender/source fence,
not the target receiver boundary: `meta skuid` identifies an emitting socket but
cannot prevent a hostile local process from binding a reviewed listener's
vacated port. Production activation remains blocked until infrastructure puts
each media service, including Asterisk, in its reviewed per-service network
namespace, enforces explicit ingress links, and attests that Asterisk's exact
effective RTP allocation is disjoint from FreeSWITCH `30000-30100`. The current
application bundle deliberately does not create that topology. The dormant
`lib/sip-media-boundary-contract.js` fixture validates the prospective four
namespace/veth/UID/address topology, exact directional flow tuples, disjoint
listeners, initiator-only TCP admission with conntrack-established return
traffic, and a boot/configuration/topology-bound Ed25519 Asterisk observation.
Validation requires both a host-owned expected topology digest and synchronous
replay consumption. It performs no networking action and is not activation
evidence. The release
reason
`receiver-safe-sip-media-network-boundary-and-asterisk-rtp-attestation-are-not-implemented`
must remain present until staging proves the installed infrastructure boundary.

The pinned root voice launcher performs host namespace observation and publishes
root-owned media admission records. Its systemd sandbox therefore permits host
process metadata and boot identity reads, `CAP_SYS_PTRACE`, `CAP_SYS_ADMIN` and
`CAP_NET_ADMIN`, mount/network namespace entry, and netlink. The last two
capabilities support the fixed `ip netns exec` and nftables readbacks; they are
not granted to the phone workloads. Writes remain restricted to the fixed
isolated runtime/state directories and the media contract/journal directories.
The protected provider credentials and worker state remain inaccessible. Hermes
read-only admission passed under these exact sandbox settings; the preceding
proc/capability restrictions denied every nonroot anchor namespace before start.

The application's separate complete namespace inventory omits a missing
namespace only after pinning the task directory and verifying an unchanged Z/X
state with the same nonzero start time twice. A live, unreadable, reused or
replaced task still refuses admission, and every required anchor must remain
present. This matches the host and PBX observer policy without relying on a
retry to repair a persistent dead task.

The voice stack has no autonomous Docker restart policy. A systemd-owned gate
starts it only after the local SIP fence, split provider plane, controller,
distinct media identities, non-authority credentials, and configuration are
verified. The privileged broker stays dormant and inaccessible.
Before it records activation intent or projects credentials, the launcher
securely opens the source voice-control token, authenticates detailed controller
health, and requires the new canonical read-only phone-authority status plus
every verifier/proxy/bearer flag false. The token buffer is erased on success or
failure, so an old authority-enabled controller cannot satisfy activation.
The root launcher itself is CPU-, memory-, swap-, I/O-, and task-bounded, and
accepts at most 128 KiB from any controller health or panic response. Every
Compose service is also assigned to the fixed
`teleagent-voice-containers.slice` parent. That slice caps the four containers
together at three CPUs, 3 GiB memory, zero swap, and 1024 tasks; the launcher
first requires canonical Docker evidence for the `systemd` cgroup driver and
cgroup v2. It creates every exact project container without starting it,
verifies its configured non-root user, cgroup parent, and durable
activation-generation label, then starts the graph. Before health, it verifies
each long-running container's host-visible PID UID/GID through `/proc` and
repeats Docker state/PID inspection to close the race. The
external host-owned release verifier is the first start command, before the
application identity check or launcher. Its empty-environment
`--check-start-gate` cheaply revalidates current-boot approval, selected
release/manifest identity, and installed runtime metadata without rescanning
or content-hashing the release. Systemd snapshots the nonsecret, host-owned
start gate into a private service credential with `LoadCredential`. The verifier
accepts private mode `0400` or the exact root-owned `0440` projection with a
single service-UID read ACL and no owning-group or other access.
While holding a shared lock on the root-owned mode-`0700` handoff inode,
the fixed host launcher then revalidates the snapshot plus the live approval,
global boot gate, current selector, immutable release device/inode, component,
service identity, and scrubbed environment before executing the exact
release-root launcher and Node runtime. Non-root service units use the host's
`--supervise-component` protocol: a minimal root parent forks trusted verifier
code, the child drops to the fixed service identity, and both retain the lock
until the child's close-on-exec barrier closes. The payload receives no lock
descriptor. The parent forwards signals and preserves exit status. Root-only
components keep their fixed direct interface. The descriptor is close-on-exec, and the
serialized disabled host handoff holds the exclusive side of the same lock
while validating and installing the already selected approved release. The
root-only worker/provider/Realtime admission checks use closed profiles in the
same host verifier. Each profile authenticates the snapshot and live release,
retains the shared lock in both verifier and child, and runs only an immutable
helper via that release's bundled Node before the ordinary workload start
revalidates independently. Provider-egress preflight also passes only the
selected systemd credential snapshot to its helper, which requires an exact
match with the selected live source and distinct live provider sources. No
supported credential writer exists; a future rotation writer must take the
exclusive handoff lock. No supported tool can change
`/opt/teleagent/current`. A future reviewed
selector transaction must take that exclusive lock and prove the whole bounded
unit set, including voice A, inactive before publishing B; A-to-B replacement
while A is active is unsupported. Because systemd does not expose this
credential to `ExecStop`, stop and offline recovery instead use exact
credential-free operations in the fixed host verifier and revalidate the live
approved current release. The handoff also retains the full `--check-runtime`
pass. The standalone installer requires the
loaded service and container slice to use their exact `/etc/systemd/system`
fragments, with no drop-ins or pending daemon reload. The
no-network credential preflight is separately capped at 0.5 CPU, 256 MiB, and
64 tasks, mounts durable voice state read-only, and cannot consume swap. Every
Compose service uses the bounded local log driver with three 10 MiB files, so a
chatty media process cannot fill the host filesystem through Docker logs.
Drachtio and FreeSWITCH also run with read-only root filesystems; every vendor
image `VOLUME` and writable runtime path is overridden by an explicit,
size-capped, noexec/nosuid/nodev tmpfs. Activation additionally proves the exact
`/var/lib/teleagent-isolated-voice` path is a canonical mountpoint whose device differs
from its immediate `/var/lib` parent, then requires that filesystem to be 4–8
GiB with at least 512 MiB and 20% free. This hard boundary keeps the append-only
SQLite ledger and media daemons from consuming the host root filesystem. The running
voice process repeats that admission check before every authenticated inbound
or outbound call and exposes exhaustion as unhealthy, so it stops accepting
new durable work before the hard capacity is reached.
The normal CLI delegates voice start and stop to that exact systemd unit; it
does not invoke Compose directly or inherit an image selector into activation.
The two Teleagent voice services use the exact `runtimeReference` in
`/etc/teleagent-isolated-voice/voice-image.manifest.json`. This is the same canonical v2
manifest emitted inside the immutable release: there is no caller-authored v1
translation. The root-owned mode-0400 installed copy records the image config
digest, reviewed source revision, target platform, and either an imported local
config-digest reference or one promoted registry manifest reference. The
launcher resolves that reference and verifies the exact Docker config ID, OCI
revision label, and `linux/amd64` platform before reading or projecting any
voice credential; Compose has no production build path.

The release pipeline must build with `TELEAGENT_SOURCE_REVISION` set to the
reviewed 40- or 64-hex source revision, publish the result, and stage one compact
canonical JSON line with fields in this exact order:

```json
{"version":2,"sourceRevision":"<40 or 64 lowercase hex>","platform":"linux/amd64","configDigest":"sha256:<64 lowercase hex>","runtimeReference":"sha256:<same config digest>","registryReference":null,"registryManifestDigest":null}
```

Before registry promotion, `runtimeReference` must equal `configDigest` and
both registry fields must be `null`. After promotion, `runtimeReference` and
`registryReference` are the same
`registry/repository@sha256:<manifest-digest>`, while
`registryManifestDigest` is that suffix and `configDigest` continues to bind
the inspected local image ID.

The example placeholders are not valid activation data. The staged file must
be a regular, single-link `root:root` file with mode `0400`; a tag-only image,
missing local image, mismatched config ID, platform or OCI revision label,
crossed offline/registry fields, duplicate member, extra member, or
noncanonical encoding refuses startup before credential access.

Before detached Compose startup, the gate durably records activation intent in
the root-owned `/var/lib/teleagent-isolated-voice-stack` directory. The canonical state
binds the full reviewed image manifest to an `activationGeneration` that
increments before every attempted activation; that same generation labels all
four containers. A
missing state file is outcome-unknown, not an implicit inactive generation.
Legacy v1 state must likewise pass explicit offline recovery before it can be
migrated to v2. A malformed, reordered, noncanonical, or logically inconsistent
state refuses both activation and automatic replacement.

The disabled installer never creates, deletes, resets, or migrates activation
state, so a reinstall preserves its last durable generation. A genuinely new
installation—or a state file lost across a crash—therefore initializes only
through the fixed `recover` operation: it proves the exact project empty,
persists outcome-unknown intent, obtains positive coordinated controller panic,
and only then commits inactive generation zero. State replacement fsyncs the
new file before rename and fsyncs the parent directory afterward; if a crash
still loses the rename, absence remains recovery-gated.

The installer accepts each root-owned, single-link release source only at its
exact installed mode (`0644` or `0755`) or the corresponding immutable release
mode (`0444` or `0555`). It rejects every other mode and always normalizes the
installed policy and executable copies back to their exact target modes.
The shell installer resolves its own actual entrypoint and copies sibling
assets only from that one release tree; it never re-resolves
`/opt/teleagent/current` between mutations.
The source verifier resolves `/opt/teleagent/current` once to the exact
`/opt/teleagent/releases/sha256-<manifest-digest>` tree, proves stable directory
and verifier identity, and performs the whole source check through that resolved
immutable root; a moving or chained release selector cannot mix source trees.

The unconditional `ExecStopPost` uses the host-owned shell installer rather
than the release Node runtime, so a failed release start gate cannot invoke
release-derived cleanup code. The fixed verifier waits for the exclusive
lifecycle lock and passes the same descriptor into that installer, preserving
serialization across the separate stop/post-stop commands and parent-only
verifier failure. It removes only containers bearing the exact
`com.docker.compose.project=teleagent-voice` label and proves none remain before
removing projected credentials. This cleanup does not clear controller panic or
convert an unknown panic outcome into success, and it never edits durable
activation state. If startup or shutdown was interrupted, the launcher's
already-fsynced `starting`, `cleanup_outcome_unknown`, or panic evidence remains
authoritative even after all voice containers are gone, and a later start
refuses. The launcher records start intent before invoking `docker compose up`,
because a failing Docker call may already have partially created or started the
stack; successful container cleanup cannot prove that controller-visible work
never began.

Recovery is explicit and two-stage. With the voice containers absent, a root
operator invokes the fixed host verifier's `--recover-voice-stack` operation;
it refuses unless the live selector already names the approved immutable
current release, re-proves zero exact project containers, and requests the
controller's coordinated panic
across the executor, provider, and privileged planes. Only a positive persisted/quiesced
response records the activation recovered. The controller remains panic-locked
until the separate authenticated operator unlock verifies its own durable task,
privileged broker, provider cgroup, and worker-session recovery gates. Startup
then independently requires controller readiness. Neither cleanup nor recovery
silently unlocks work.

## Explicit non-goals

- A general-purpose remote shell by voice.
- Provider-native interactive session continuity.
- Unreviewed web search, MCP, computer-use, hosted tools, or arbitrary egress.
- Retrying an operation whose side-effect outcome is unknown.
- Treating CLI permission flags, prompts, containers, loopback, or environment
  filtering as a security boundary by themselves.
- Claiming SIP, remote providers, or external side effects are exactly-once.

## Promotion gates

Production activation remains blocked until all of these are true:

1. Every source test, lint check, dependency audit, and offline crash/restart
   regression is green from the frozen release closure.
2. Pinned Claude and Codex binaries pass clean-home, fake-upstream request-shape
   canaries against the egress policy; unsupported protocol shapes fail closed.
3. Real split-UID DAC, AppArmor, transient-cgroup, private-network, Unix-socket,
   workspace, output, storage, and cancellation canaries pass without real
   secrets being visible to a model process.
4. Missing or malformed identities, credentials, policies, binaries, firewall,
   PBX authentication, controller health, provider services, or the root-owned
   immutable-image manifest produce zero voice/media listeners and zero provider
   launches.
5. Panic, cancellation, crash, and reboot tests preserve durable truth and do
   not release a singleton, database, credential runtime, or successor process
   before every applicable plane is quiescent.
6. Mutual-auth inbound and callback calls, independently PBX-attested
   request-bound approval, executor mutation, cancellation, outbound
   completion, panic, and restart recovery pass end to end on the staged host.
7. A reboot and soak complete before legacy single-UID workers, old credentials,
   or old deployment paths are retired.

Until those gates pass, the new services and sentinels remain absent or disabled
and the source tree is not evidence of a live production deployment.
