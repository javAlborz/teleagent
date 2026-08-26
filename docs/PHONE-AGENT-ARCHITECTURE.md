# Phone agent architecture

Status: accepted design; source implementation and offline validation are in
progress. Production activation is intentionally blocked until every promotion
gate in this document passes.

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
Asterisk/PBX  <== mutual SIP authentication ==>  voice/media plane
                                                       |
                                                       | scoped request only
                                                       v
                                              controller + durable ledger
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

The voice application may interpret speech, maintain conversational text,
announce an exact proposed action, and collect a DTMF confirmation. It cannot
execute provider or root work on its own.

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

The handset confirmation becomes useful only after the exact approval summary
has entered the authenticated media session. A one-time, call-bound signed
capability then identifies one canonical action plan. It does not authorize a
free-form prompt or a later retry.

### Controller and durable executor

The controller owns scoped HTTP authentication, request classification, and
coordination. General, executor, privileged, outbound, and voice-control tokens
are distinct and non-interchangeable. The voice-to-controller endpoint is a
fixed numeric loopback address and port with redirects disabled; configuration
cannot redirect a scoped bearer or signed action to another destination.

Mutating requests are rejected from synchronous `/ask` surfaces. They are first
recorded in a durable task ledger with idempotency, approval, cancellation, and
recovery truth. A provider is launched only after that record is durable.

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
ports. Static/generated media is private runtime data and is served only through
exact no-follow paths.

The voice stack has no autonomous Docker restart policy. A systemd-owned gate
starts it only after the local SIP fence, split provider plane, controller,
privileged broker, identities, credentials, and configuration are verified.
The root launcher itself is CPU-, memory-, swap-, I/O-, and task-bounded, and
accepts at most 128 KiB from any controller health or panic response. Every
Compose service is also assigned to the fixed
`teleagent-voice-containers.slice` parent. That slice caps the four containers
together at three CPUs, 3 GiB memory, zero swap, and 1024 tasks; the launcher
first requires canonical Docker evidence for the `systemd` cgroup driver and
cgroup v2. It then inspects every exact project container after startup and refuses activation if
its cgroup parent or durable activation-generation label differs. The
no-network credential preflight is separately capped at 0.5 CPU, 256 MiB, and
64 tasks, mounts durable voice state read-only, and cannot consume swap. Every
Compose service uses the bounded local log driver with three 10 MiB files, so a
chatty media process cannot fill the host filesystem through Docker logs.
Drachtio and FreeSWITCH also run with read-only root filesystems; every vendor
image `VOLUME` and writable runtime path is overridden by an explicit,
size-capped, noexec/nosuid/nodev tmpfs. Activation additionally proves the exact
`/var/lib/teleagent-voice` path is a canonical mountpoint whose device differs
from its immediate `/var/lib` parent, then requires that filesystem to be 4–8
GiB with at least 512 MiB and 20% free. This hard boundary keeps the append-only
SQLite ledger and media daemons from consuming the host root filesystem. The running
voice process repeats that admission check before every authenticated inbound
or outbound call and exposes exhaustion as unhealthy, so it stops accepting
new durable work before the hard capacity is reached.
The normal CLI delegates voice start and stop to that exact systemd unit; it
does not invoke Compose directly or inherit an image selector into activation.
The two Teleagent voice services use the exact `runtimeReference` in
`/etc/teleagent-voice/voice-image.manifest.json`. This is the same canonical v2
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
the root-owned `/var/lib/teleagent-voice-stack` directory. The canonical state
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
The source verifier resolves `/opt/teleagent/current` once to the exact
`/opt/teleagent/releases/sha256-<manifest-digest>` tree, proves stable directory
and verifier identity, and performs the whole source check through that resolved
immutable root; a moving or chained release selector cannot mix source trees.

The unconditional `ExecStopPost` removes only containers bearing the exact
`com.docker.compose.project=teleagent-voice` label and proves none remain before
removing projected credentials. This cleanup does not clear controller panic or
convert an unknown panic outcome into success. If startup or shutdown was
interrupted before coordinated panic was positively quiescent, cleanup records
durable `panic_outcome_unknown` even after all voice containers are gone, and a
later start refuses. The launcher records that same outcome before invoking
`docker compose up`, because a failing Docker call may already have partially
created or started the stack; successful container cleanup cannot prove that
controller-visible work never began.

Recovery is explicit and two-stage. With the voice containers absent, a root
operator invokes the fixed launcher with `recover`; it re-proves zero exact
project containers and requests the controller's coordinated panic across the
executor, provider, and privileged planes. Only a positive persisted/quiesced
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
6. Mutual-auth inbound and callback calls, spoken approval, executor mutation,
   cancellation, outbound completion, panic, and restart recovery pass end to
   end on the staged host.
7. A reboot and soak complete before legacy single-UID workers, old credentials,
   or old deployment paths are retired.

Until those gates pass, the new services and sentinels remain absent or disabled
and the source tree is not evidence of a live production deployment.
