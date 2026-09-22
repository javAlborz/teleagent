# Protected application placement candidate

This source checkpoint adds `deploy/voice-stack/media-application-boundary.js`
and an explicit refusal at the beginning of the voice launcher's `start()`.
The old host-network start cannot accidentally bypass unfinished media
integration. Stop, panic, cleanup, offline recovery, controller Unix transport,
the Compose source and the three FreeSWITCH volumes are unchanged. This code
is not installed; no image, container, credential, service or live network was
changed while implementing it.

The module implements concrete preparation and verification operations:

- Validate the exact infra `teleagent.media-docker-launcher-contract.v1`,
  including current boot, four different immutable anchors, namespace inodes,
  application UIDs and the independently reviewed anchor source/build/image.
- Read only fixed, protected host input at
  `/etc/teleagent-media/application-launch.json`. Every ancestor and final file
  must be root-owned, not writable by group/others, and free of symlink aliases;
  the file has one link and bounded size. Canonical JSON excludes duplicates.
- Require the separate protected `/usr/local/libexec/verify-teleagent-media-activation`
  to admit the release, exact file digest, stage and evidence digest. No
  implementation, approval record, configuration or sentinel is fabricated.
- Produce a complete resolved Compose candidate whose three running voice
  services use `network_mode: container:<full anchor ID>`, exact local image
  IDs, explicit host user namespaces and disabled container health checks.
  Conflicting hostname, published-port, DNS, additional-host, link and other
  network settings are refused. Commands, environments and mounts are copied
  unchanged. The candidate must not be launched until the remaining gates below
  are implemented.
- Check created and running Docker containers against the exact image,
  namespace mode, UID/GID, approved sandbox digest, memory/swap/CPU/task limits,
  cgroup parent, read-only root, capability drops, no-new-privileges, healthcheck
  and restart policy. Inspection explicitly excludes raw Env and command arrays.
- Check actual kernel UID/GID/capabilities/seccomp, PID start generation,
  namespace device/inode, exact systemd cgroup hierarchy and actual cgroup
  memory/swap/task/CPU settings. Repeat Docker observation around the process
  evidence. Walk every process's threads, including nonleader threads, and
  refuse unknown namespace occupants, nested/foreign cgroups or unreadable
  evidence. Application descendants must have the admitted workload cgroup,
  identity, capabilities and namespace. Anchor verification comes from the
  independently coordinated authority before and after the snapshot.

The outer canonical host contract is:

```text
schema: teleagent.media-application-contract.v1
releaseRoot: /opt/teleagent/releases/sha256-<exact release digest>
bootstrap: exact independently observed infra launcher contract
workloads:
  drachtio | freeswitch | voice-app:
    imageId: exact local sha256 image ID
    uid/gid: admitted dedicated system identity
    sandboxDigest: SHA-256 of canonical selected Docker sandbox observation
```

`loadAdmission()` invokes the fixed authority with
`--admit-media-application STAGE CONTRACT_SHA BOOT RELEASE_ROOT EVIDENCE_SHA`.
The exact JSON response is `teleagent.media-application-admission.v1` with
`stage`, `contractDigest`, `bootId`, `releaseRoot`, and `evidenceDigest`.
The authority must independently derive those values from its owned release,
anchor/workload journal and live observations, validate complete command/image/
credential/tool/resource closure, reject any ambiguous pending Docker RPC, and
retain the shared lifecycle fence across the eventual caller's mutation.
Echoing request arguments or accepting caller-selected images is not admission.
The returned JSON is a checked observation, not a transferable authorization.

`verifyProtectedPlacement(releaseRoot, fullContainerIds, stage)` is the concrete
read-only operation for `created`, `running` and `restart`. It uses the exact
local Docker socket and protected empty Docker client configuration, then
submits the full observation digest to the authority. Automatic container or
anchor restart/recreation is refused; a replacement requires a new independently
reviewed generation. The source candidate does not adopt or delete uncertain
containers and does not mutate Docker while verifying.

Before replacing the explicit start refusal, the next integrated change must:

1. Implement and review the independent authority and durable workload journal,
   with retained lifecycle locking and exact anchor/workload PID handles across
   creation/start/rollback. The anchor bootstrap manager alone cannot check an
   already populated application namespace. Snapshot checks cannot serialize
   concurrent trusted-root namespace entry by themselves.
2. Render Drachtio SIP/control, FreeSWITCH ESL/SIP/RTP and voice audiofork
   listeners/peers for the selected interfaces. Existing loopback templates
   deliberately remain unchanged and would not connect across namespaces.
3. Commission exact Realtime WSS and legacy STT/TTS egress, DNS/proxy policy,
   outbound SIP and the external PBX edge, then integrate readiness and panic
   paths without host-loopback assumptions or receiver-namespace exec helpers.
4. Extend coordinated admission to the separately owned Asterisk workload.
   This checkpoint accepts its anchor alone and refuses additional PBX tasks;
   it cannot stand in for a complete four-service activation transaction.
5. Wire candidate creation, `verifyProtectedPlacement(..., 'created')`, start,
   post-start/restart verification and rollback into one durable transaction;
   retain all three existing FreeSWITCH volumes. Pin the new imported module
   in both exact release-source closures and refresh installed tool hashes.
6. Run isolated actual Docker inspection/namespace attachment/placement,
   adversarial process/packet and real zero-call cutover tests, then perform
   reviewed handset canaries. The fixture suite proves none of those live gates.

Focused tests cover immutable contract rejection, conflicting network flags,
volume preservation, sandbox/resource/image drift, kernel process generations,
actual cgroup limit parsing, foreign nonleader threads, unreadable inventory,
missing authority and refusal before cleanup or credential projection. Run
these and `voice-stack-launch.test.js` serially through `scripts/hermes-safe-test`
with 512 MiB, zero swap, 128 tasks and one CPU. No Docker calls are made by tests.
