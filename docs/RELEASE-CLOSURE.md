# Teleagent Immutable Release Closure

Status: source-side build contract. This document and the tools under
`scripts/release/` do not authorize installation or activation.

## Dormant CI evidence lane

`.github/workflows/teleagent-release-candidate.yml` is a manual, default-branch
evidence workflow. It is restricted to the exact repo-scoped
`hephaestus-ci-build-vm01-teleagent` runner with the `self-hosted`, `Linux`,
`X64`, `ci-build`, and `teleagent` labels. Third-party Actions use immutable
commit SHAs (`actions/checkout` v6.0.2 and `actions/upload-artifact` v7.0.1),
checkout does not persist credentials, jobs time out, concurrent runs queue
instead of cancelling one another, and the workflow has only `contents: read`.
It has no pull-request/push trigger, secrets, OIDC token, attestation permission,
registry permission, deploy step, service activation, or image push.

The runner user is a member of the Docker group, which is root-equivalent, and
the guest is currently long-lived. Therefore every uploaded artifact is
explicitly **non-promotable build evidence**. GitHub attestation is deliberately
omitted: granting OIDC to this trust domain would make the evidence look
stronger without supplying an independent build boundary. Promotion remains
blocked until an external system resets or creates a clean immutable guest for
each job, verifies that generation outside the guest, and performs attestation
in a separate ephemeral trust domain.

The voice image build is also not hermetic: its Dockerfile still resolves
mutable Alpine `apk` inputs and npm build dependencies over the network. Two
assemblies can detect divergence during one run, but cannot prove that those
inputs are reproducible later. This lane therefore cannot be promoted even if
the two current-run outputs match.

Dependency lifecycle scripts, native smoke loads, repository tests, and lint do
not run in the Docker-group host context. They run in a digest-pinned throwaway
Node 24.19.0 container with an empty environment, no Docker socket or runner
credentials, a read-only root, all capabilities dropped, no-new-privileges,
and fixed CPU, memory, PID, file-descriptor, and wall-clock bounds. The archived
source mount is read-only; only explicit package-local `node_modules` output
mounts are writable. Link and extended-metadata checks run before the host
copies the reviewed Node or provider bytes into either fresh assembly.

`scripts/release/ci-release-inputs.json` pins the Node archive and interpreter,
the lifecycle image digest, the Syft and Trivy release archives and installed
executable bytes, the exact runner name, and the root-owned provider inputs.
The builder fails if any input/tool is missing or drifts. It builds and scans
the voice image, produces CycloneDX 1.6 SBOMs, assembles the current v2-shaped
tree and deterministic archive twice, and uploads only evidence. It never deploys,
starts, imports on a target, provisions credentials, or pushes to a registry.

`release-summary.json` keeps `promotionEligibility.status` exactly `blocked`
and emits these seven machine-readable reasons, in this order:

```text
persistent-docker-group-self-hosted-runner-is-not-an-external-trust-boundary
voice-image-build-toolchain-is-not-hermetic
separate-trusted-ephemeral-attestation-job-is-not-defined
independent-pbx-attested-request-bound-approval-authority-is-not-implemented
receiver-safe-sip-media-network-boundary-and-asterisk-rtp-attestation-are-not-implemented
universal-current-boot-release-gate-enforcement-at-credential-bearing-service-restart-is-not-proven
dedicated-staging-proof-including-non-root-media-containers-is-missing
```

The old `host-executed-bound-source-integration-is-pending` blocker is closed:
the source-side manifest now carries the complete production host closure.
That does not remove any blocker above. In particular, the target still needs
one universal boot-bound gate before every credential-bearing service start or
restart. Caller confirmation must also be attested outside the voice process
that proposes work; moving a signing key behind an endpoint that trusts the
same process is not sufficient. Dedicated staging still must prove the full
dormant/install/activation behavior including the non-root media containers.

## Security decision

A Git revision, an OCI label, and a manifest stored inside the release do not
independently prove that the host is running one reviewed artifact set. A
release could otherwise combine:

- host application tree B at `/opt/teleagent/current`;
- a voice image labelled with revision A;
- native `node_modules` installed or rebuilt separately;
- untracked Claude or Codex binaries;
- an untracked Node interpreter at either
  `/usr/local/libexec/teleagent-node` or `/opt/teleagent/node/bin/node`;
- bind-mounted Compose, FreeSWITCH, launcher, or runtime-environment files from
  a different source tree.

Teleagent v2 therefore closes every runtime byte into one complete inventory.
The trust chain is:

```text
homelab-owned root approval pin
  -> exact SHA-256 of teleagent-release.manifest.json
    -> exact SHA-256 of teleagent-release.files.tsv
      -> every directory and regular file in the extracted release
```

The approval pin and authoritative verifier must come from the homelab
repository. They must never be supplied by, copied from, or selected through
the Teleagent bundle. The source-side verifier in this repository is a build
and test aid only.

This design needs no signing service. Its trust anchors are the separately
reviewed homelab change, a fixed root-owned verifier, and a fixed root-owned
approval file. It does not claim to resist a compromised host root account.

## Release layout

An approved extracted release is stored at:

```text
/opt/teleagent/releases/sha256-<manifest-sha256>
```

`/opt/teleagent/current` must be one root-owned symlink whose literal target is
that exact directory. Link chains are not accepted.

The release contains two metadata files:

```text
teleagent-release.manifest.json
teleagent-release.files.tsv
```

The file list excludes only those two files. The external approval hashes the
manifest, and the manifest hashes the file list. An authoritative verifier
must enumerate the extracted tree and reject every path absent from the list.

The release also carries these generated artifacts:

```text
runtime/node/...
artifacts/provider-cli/claude
artifacts/provider-cli/codex-vendor
artifacts/voice/voice-image.manifest.json
artifacts/voice/voice-image.docker.tar
artifacts/sbom/teleagent-release.cdx.json
artifacts/sbom/voice-image.cdx.json
```

The Codex wrapper remains source-owned and enters the provider binding through
`deploy/worker-session/teleagent-codex-cli-wrapper`. The installed provider
canary is self-contained and digest-pinned; it never imports mutable
application JavaScript. The closure still binds `claude-api-server/agent-cli.js`
as the API server's host-side provider adapter. Both files remain inside the
complete inventory.

## Filesystem policy

The extracted release uses one exact metadata policy:

- release root and every directory: one real directory, mode `0555`;
- data/source/native-addon files: one regular file, mode `0444`, link count 1;
- executable files and fixed interpreters: one regular file, mode `0555`, link
  count 1;
- one uid/gid throughout the tree; production extraction requires `root:root`;
- no symbolic links, hard-linked files, sockets, FIFOs, devices, ACLs,
  capabilities, or extended attributes;
- no group- or world-writable entries;
- no unlisted path and no `node_modules/.bin` tree.

Paths are relative ASCII strings matching `[A-Za-z0-9._+@/-]+`. Absolute
paths, empty components, `.` or `..`, repeated separators, and trailing
separators are invalid.

An ordinary Git checkout is not a release. Git tracks non-executable files as
`0644`, while the immutable release requires `0444`; executable files become
`0555`. In particular, `provider-libexec.manifest` must be `0444` in the
release even though Git stores it as `100644`. The generator normalizes a
fresh staging tree and then makes the root `0555`. Worker-session source checks
must accept the immutable `0555`/`0444` variants in addition to their
development-checkout modes.

## Canonical file list

`teleagent-release.files.tsv` is ASCII, has one trailing LF, contains no blank
or comment records, and is bytewise `LC_ALL=C` sorted by path. Every record has
exactly five tab-separated fields:

```text
D	0555	-	-	claude-api-server
F	0444	1234	<64 lowercase SHA-256 hex>	claude-api-server/server.js
F	0555	5678	<64 lowercase SHA-256 hex>	deploy/worker-session/teleagent-provider-canary
```

`D` records describe directories. `F` records describe regular files and bind
their decimal byte size and SHA-256. Duplicate or unsorted paths fail closed.

## Canonical release manifest

`teleagent-release.manifest.json` is ASCII JSON on exactly one line with one
trailing LF. It contains no insignificant whitespace. Object keys and array
records use the exact order emitted by `release_closure.py`; duplicate or
unknown keys are invalid. The v2 top-level order is exactly:

```text
version, application, source, target, files, hostRuntime, providerCli, voiceImage, sbom
```

The generator and verifier in `release_closure.py` are the canonical schema;
the focused tests compare the generated structure and canonical bytes. The
131-entry `hostRuntime.boundSourcePaths` array is emitted dynamically from the
single reviewed `BOUND_SOURCE_PATHS` tuple rather than copied into the workflow
or this document.

The native-module array must equal every `*.node` file under the declared host
`node_modules`. Dependencies are installed in the builder and copied as bytes;
the target never runs `npm`, downloads a prebuild, or compiles an addon.

The v2 `hostRuntime` schema requires, in exact key order, these package-local
bindings in addition to the API dependency binding:

```json
{"privilegedBrokerLockPath":"privileged-action-broker/package-lock.json","privilegedBrokerLockSha256":"sha256:<64hex>","privilegedBrokerNodeModulesPath":"privileged-action-broker/node_modules","privilegedBrokerNativeModules":[{"path":"privileged-action-broker/node_modules/better-sqlite3/build/Release/better_sqlite3.node","sha256":"sha256:<64hex>","size":123}],"realtimeSipLockPath":"realtime-sip-gateway/package-lock.json","realtimeSipLockSha256":"sha256:<64hex>","realtimeSipNodeModulesPath":"realtime-sip-gateway/node_modules","realtimeSipNativeModules":[{"path":"realtime-sip-gateway/node_modules/better-sqlite3/build/Release/better_sqlite3.node","sha256":"sha256:<64hex>","size":123}]}
```

These fields occur after the API `nativeModules` field and before
`boundSourcePaths`; they are not a separate object. Each lockfile digest,
package-local production tree, and complete native-addon set is independently
cross-checked against the full inventory. Node resolution uses normal sibling
`node_modules` lookup; mutable/system `NODE_PATH` is forbidden.

Both Node interpreter destinations are explicit because root launchers and
verifiers currently use `/usr/local/libexec/teleagent-node`, while broker,
supervisor, and egress services use `/opt/teleagent/node/bin/node`. The same
release-contained Node file must provision both targets, and the authoritative
installed check must compare both installed copies to `nodeSha256` before any
release code runs.

## Production host source closure

`BOUND_SOURCE_PATHS` is one explicit, duplicate-free, byte-sorted 131-path
tuple. It is derived from production consumption boundaries, not from a broad
directory glob:

- the local-import closure rooted at the controller, worker-session broker,
  provider supervisor/egress/shim, privileged broker/control CLI, and realtime
  SIP entrypoints;
- all four nearest package-scope `package.json` files (including the repository
  root for `lib/*.js` and the host launcher) that determine host Node module
  semantics, while each `package-lock.json` and production `node_modules` tree
  remains independently bound by dedicated manifest fields;
- every source and component manifest consumed by the worker/provider,
  controller/privileged, and realtime-SIP disabled installers, including every
  installed unit, socket, slice, sysusers, tmpfiles, sudoers, AppArmor, fixed
  libexec, empty provider configuration, and verifier input;
- all fourteen realtime-SIP `src/*.js` imports, its unit, sysusers, tmpfiles,
  verifier, install manifest, and installer;
- the voice unit/slice/sysusers/tmpfiles, launcher/verifier/installer, Compose
  file, rendered configuration templates, three FreeSWITCH bind inputs, and
  the launcher-loaded runtime-environment module;
- the SIP peer-fence helper/unit/installer/version descriptor and the aggregate
  `deploy/host/teleagent-disabled-host-install` entrypoint.

Documentation, tests, example policies/configuration, and unused legacy assets
are deliberately absent. They remain covered by the complete release file
inventory, but are not mislabeled as production host execution inputs. A
focused regression independently derives the import and component-manifest
sets, requires exact equality with the reviewed tuple, proves all 131 paths are
real regular files, derives every host JavaScript file's nearest package scope,
and pins the complete realtime-SIP import list.

The same regression derives the eight systemd services that directly execute
the selected release or an installed launcher that consumes it. Each must make
the host-owned `verify-teleagent-release-closure --check-start-gate` command its
first execution directive, exactly once. That start gate checks the current
boot, approval, canonical manifest, selected release identity, and installed
runtime metadata without scanning or hashing the complete release. Full tree
and runtime hashing remains serialized in the dedicated staging handoff;
putting it in every service preflight would multiply large reads during boot.
The release remains non-promotable until the cheap start gate and the complete
handoff are proven under real systemd on a dedicated staging host.

The provider section cross-checks `provider-cli.manifest.json` against the
actual bundled Claude binary, Codex wrapper, and Codex vendor binary. IDs,
provider names, install destinations, sources, target modes, byte sizes,
digests, and captured-version provenance must all agree. Root release install
and verification never execute these artifacts; only the later unprivileged
managed provider canary supplies activation-time execution evidence.

The image config digest is distinct from a registry manifest digest. Before a
registry is approved, both registry fields are `null` and `runtimeReference`
is the exact image config digest. Production promotion requires a canonical
`registry/repository@sha256:<manifest-digest>` in both the image manifest and
release manifest; `runtimeReference` then equals that registry reference.

## Voice image manifest

The generated `artifacts/voice/voice-image.manifest.json` is also canonical
one-line JSON:

```json
{"version":2,"sourceRevision":"<same-source-revision>","platform":"linux/amd64","configDigest":"sha256:<64hex>","runtimeReference":"sha256:<same-config-digest>","registryReference":null,"registryManifestDigest":null}
```

After registry publication, the last three fields identify the exact registry
manifest instead. The image must carry
`org.opencontainers.image.revision=<same-source-revision>`. The authoritative
host gate must inspect that label and the resolved config ID after importing or
pulling the already-approved artifact.

## External approval pin

The homelab repository installs exactly one fixed file at
`/etc/teleagent/release-approval.json`. It is canonical one-line JSON,
`root:root`, mode `0400`, link count 1, with root-owned non-writable ancestry:

```json
{"version":1,"application":"teleagent","environment":"dedicated-staging","releaseId":"sha256-<manifest-sha256>","manifestSha256":"sha256:<manifest-sha256>","bundleSha256":"sha256:<deterministic-tar-sha256>","sourceRevision":"<revision>","sourceTree":"<tree>","voiceImageConfigDigest":"sha256:<config-digest>","voiceImageRegistryReference":null,"voiceImageRegistryDigest":null,"providerCliManifestSha256":"sha256:<provider-manifest-digest>"}
```

The authoritative verifier derives the release directory from `releaseId` and
compares every duplicated field to the release manifest. Dedicated staging may
approve null registry fields and the pinned Docker archive. Production policy
must reject null registry fields.

## Build input

The generator accepts an external canonical JSON description. This file is
build input, not part of the release and not an approval. The dormant CI lane
creates it from the reviewed commit and tree without copying the 131-path host
closure into shell or workflow code:

```bash
python3 scripts/release/ci_release_support.py write-build-input \
  --destination /build/teleagent-release-input.json \
  --revision <reviewed-commit> \
  --tree <reviewed-tree>
```

The emitted object has the exact top-level order `version`, `source`, `target`,
`hostRuntime`, `providerCli`, `voiceImage`, and `sbom`. `hostRuntime` binds both
interpreter targets, each package-local lockfile/dependency/native-addon tree,
and the exact byte-sorted `BOUND_SOURCE_PATHS` tuple. The provider, image, and
SBOM objects then bind their fixed artifact paths. The focused test suite
validates the complete generated object rather than maintaining a second
handwritten example.

Unknown fields, reordered semantic arrays, missing interpreter destinations,
or missing host binding paths are rejected.

## Deterministic build sequence

Run release builds only on the bounded CI/build lane, never Hermes:

1. Create a clean detached checkout of the reviewed commit; require no tracked
   or untracked changes and record its exact commit and Git tree IDs.
2. Populate a fresh staging directory from `git archive` of that commit.
3. Copy one digest-pinned Node distribution into `runtime/node`.
4. In the resource-bounded lifecycle sandbox, run independent
   `npm ci --omit=dev` installs for `claude-api-server`,
   `privileged-action-broker`, and `realtime-sip-gateway`. Remove each
   `node_modules/.bin` and every undeclared native addon. Require exactly the
   API server's `better_sqlite3.node` and `pty.node`, the privileged broker's
   package-local `better_sqlite3.node`, and the realtime SIP gateway's
   package-local `better_sqlite3.node`. Smoke-load each tree inside the same
   no-socket sandbox; never execute those dependency bytes on the CI host or
   rebuild them on a target.
5. Copy the reviewed Claude and Codex vendor binaries into the artifact paths.
6. Build the voice image with the same source revision and platform, save the
   exact Docker archive, and generate its canonical v2 manifest.
7. Generate CycloneDX 1.6 SBOMs from the actual staged release and actual image.
8. Strip ACLs and xattrs before generation. The generator refuses remaining
   xattrs or special/link types instead of silently removing them.
9. Generate and optionally package the normalized tree:

   ```bash
   python3 scripts/release/generate-release-closure.py \
     --root /build/teleagent-release-staging \
     --build-input /build/teleagent-release-input.json \
     --bundle /build/teleagent-release.tar \
     --source-date-epoch <reviewed-commit-timestamp>
   ```

10. Generate a second fresh tree from the same pinned inputs. Require identical
    file-list, manifest, and tar SHA-256 values. Native-byte divergence blocks
    the candidate; it never justifies a target-host rebuild.
11. Review the manifest, SBOMs, scan evidence, and image/provider identities.
    The current long-lived-runner output remains non-promotable and cannot be
    used to create an external approval. Only a future externally reset and
    attested ephemeral build may feed the separately reviewed homelab change.

The tar is uncompressed and deterministic: byte-sorted entries, a single
`sha256-<manifest-digest>` top directory, uid/gid zero, empty owner names,
fixed modes, and one source commit timestamp. Compression, if later required,
must itself be separately deterministic and pinned by `bundleSha256`.

## Verification and failure order

The future homelab-owned verifier must perform these steps without executing
anything in the release:

1. Open the fixed approval using no-follow semantics and validate its root
   metadata and canonical schema.
2. Derive the exact release path from its manifest digest.
3. Validate every path ancestor and the release root.
4. Hash and parse the release manifest; compare every duplicated approval field.
5. Hash and parse the TSV inventory.
6. Enumerate the entire tree; compare exact path sets, types, modes, owners,
   link counts, xattrs, sizes, and hashes. Hash through no-follow descriptors
   and reject metadata changes during hashing.
7. Cross-check the Node, native-addon, provider, image, SBOM, host-launch,
   bind-mount, and canary-module bindings.
8. Require `/opt/teleagent/current` to point literally at the approved release.
9. Write a root-only, boot-bound gate under `/run/teleagent-release-gate/`.
10. Only then may it import/inspect the pinned image, run unprivileged
    networkless native smoke tests, invoke a root installer, or install provider
    binaries from their bound release paths.

No release handoff may read or provision credentials, create an `ENABLE`
sentinel, enable/start a unit, expose a route, or run a provider canary. A
failure exits `77`, emits no success token, leaves `current` unchanged, and
does not advance to a later phase.

The host must repeat closure/current/image verification before credential-
bearing service activation. Installed copies of both Node interpreter targets,
provider binaries, fixed libexec helpers, systemd units, and image metadata
must still match the approved release.

## Source-side checks

Check an extracted fixture without executing it:

```bash
python3 scripts/release/verify-release-closure.py --root /path/to/release
```

Run the build-contract regressions:

```bash
scripts/hermes-safe-test python3 -m unittest -v \
  scripts/release/test_release_closure.py scripts/release/test_ci_release.py
```

Tests cover canonicalization, traversal, extra/missing/tampered files,
symlinks, hardlinks, FIFOs, xattrs, modes, all three exact package-local native
dependency trees, provider/image/SBOM cross-binding, the exact derived 131-path
host closure, lifecycle-container isolation, immutable Action/tool pins, manual
default-branch runner gating, all seven exact non-promotable blockers, and
byte-identical double packaging. These static/unit tests do not run Docker or
download tools.
