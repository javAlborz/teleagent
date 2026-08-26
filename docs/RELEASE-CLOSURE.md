# Teleagent Immutable Release Closure

Status: source-side build contract. This document and the tools under
`scripts/release/` do not authorize installation or activation.

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
unknown keys are invalid. Its v2 shape is:

```json
{"version":2,"application":"teleagent","source":{"repository":"https://github.com/javAlborz/teleagent.git","revision":"<40-or-64-lowercase-hex>","tree":"<40-or-64-lowercase-hex>"},"target":{"os":"linux","architecture":"amd64","libc":"glibc","nodeVersion":"v24.x.y","nodeModulesAbi":"137"},"files":{"path":"teleagent-release.files.tsv","sha256":"sha256:<64hex>","size":123,"entries":456},"hostRuntime":{"nodePath":"runtime/node/bin/node","nodeSha256":"sha256:<64hex>","interpreterTargets":["/opt/teleagent/node/bin/node","/usr/local/libexec/teleagent-node"],"apiLockPath":"claude-api-server/package-lock.json","apiLockSha256":"sha256:<64hex>","nodeModulesPath":"claude-api-server/node_modules","nativeModules":[{"path":"claude-api-server/node_modules/better-sqlite3/build/Release/better_sqlite3.node","sha256":"sha256:<64hex>","size":123},{"path":"claude-api-server/node_modules/node-pty/build/Release/pty.node","sha256":"sha256:<64hex>","size":123}],"boundSourcePaths":["claude-api-server/agent-cli.js","deploy/voice-stack/drachtio.conf.xml.template","deploy/voice-stack/freeswitch-event-socket.conf.xml.template","deploy/voice-stack/teleagent-voice-stack-launch.js","deploy/voice-stack/teleagent-voice-stack.service","deploy/worker-session/teleagent-provider-canary","docker-compose.yml","freeswitch/entrypoint.sh","freeswitch/mrf.xml","freeswitch/switch.conf.xml","lib/voice-app-runtime-env.js"]},"providerCli":{"manifestPath":"deploy/worker-session/provider-cli.manifest.json","manifestSha256":"sha256:<64hex>","artifacts":[{"id":"claude","path":"artifacts/provider-cli/claude","sha256":"sha256:<64hex>","size":247905800},{"id":"codex-wrapper","path":"deploy/worker-session/teleagent-codex-cli-wrapper","sha256":"sha256:<64hex>","size":69},{"id":"codex-vendor","path":"artifacts/provider-cli/codex-vendor","sha256":"sha256:<64hex>","size":258227840}]},"voiceImage":{"manifestPath":"artifacts/voice/voice-image.manifest.json","manifestSha256":"sha256:<64hex>","archivePath":"artifacts/voice/voice-image.docker.tar","archiveSha256":"sha256:<64hex>","archiveSize":89710080,"configDigest":"sha256:<64hex>","runtimeReference":"sha256:<64hex>","registryReference":null,"registryManifestDigest":null,"sourceRevision":"<same-source-revision>","platform":"linux/amd64"},"sbom":{"format":"cyclonedx-json-1.6","releasePath":"artifacts/sbom/teleagent-release.cdx.json","releaseSha256":"sha256:<64hex>","voiceImagePath":"artifacts/sbom/voice-image.cdx.json","voiceImageSha256":"sha256:<64hex>"}}
```

The native-module array must equal every `*.node` file under the declared host
`node_modules`. Dependencies are installed in the builder and copied as bytes;
the target never runs `npm`, downloads a prebuild, or compiles an addon.

Both Node interpreter destinations are explicit because root launchers and
verifiers currently use `/usr/local/libexec/teleagent-node`, while broker,
supervisor, and egress services use `/opt/teleagent/node/bin/node`. The same
release-contained Node file must provision both targets, and the authoritative
installed check must compare both installed copies to `nodeSha256` before any
release code runs.

The provider section cross-checks `provider-cli.manifest.json` against the
actual bundled Claude binary, Codex wrapper, and Codex vendor binary. IDs,
provider names, install destinations, sources, target modes, byte sizes,
digests, and version-check contracts must all agree.

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

The generator accepts an external JSON description. This file is build input,
not part of the release and not an approval:

```json
{
  "version": 1,
  "source": {
    "repository": "https://github.com/javAlborz/teleagent.git",
    "revision": "<reviewed commit>",
    "tree": "<reviewed Git tree>"
  },
  "target": {
    "os": "linux",
    "architecture": "amd64",
    "libc": "glibc",
    "nodeVersion": "v24.x.y",
    "nodeModulesAbi": "137"
  },
  "hostRuntime": {
    "nodePath": "runtime/node/bin/node",
    "interpreterTargets": [
      "/opt/teleagent/node/bin/node",
      "/usr/local/libexec/teleagent-node"
    ],
    "apiLockPath": "claude-api-server/package-lock.json",
    "nodeModulesPath": "claude-api-server/node_modules",
    "nativeModulePaths": [
      "claude-api-server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      "claude-api-server/node_modules/node-pty/build/Release/pty.node"
    ],
    "boundSourcePaths": [
      "claude-api-server/agent-cli.js",
      "deploy/voice-stack/drachtio.conf.xml.template",
      "deploy/voice-stack/freeswitch-event-socket.conf.xml.template",
      "deploy/voice-stack/teleagent-voice-stack-launch.js",
      "deploy/voice-stack/teleagent-voice-stack.service",
      "deploy/worker-session/teleagent-provider-canary",
      "docker-compose.yml",
      "freeswitch/entrypoint.sh",
      "freeswitch/mrf.xml",
      "freeswitch/switch.conf.xml",
      "lib/voice-app-runtime-env.js"
    ]
  },
  "providerCli": {
    "manifestPath": "deploy/worker-session/provider-cli.manifest.json",
    "artifacts": [
      {"id": "claude", "path": "artifacts/provider-cli/claude"},
      {"id": "codex-wrapper", "path": "deploy/worker-session/teleagent-codex-cli-wrapper"},
      {"id": "codex-vendor", "path": "artifacts/provider-cli/codex-vendor"}
    ]
  },
  "voiceImage": {
    "manifestPath": "artifacts/voice/voice-image.manifest.json",
    "archivePath": "artifacts/voice/voice-image.docker.tar"
  },
  "sbom": {
    "format": "cyclonedx-json-1.6",
    "releasePath": "artifacts/sbom/teleagent-release.cdx.json",
    "voiceImagePath": "artifacts/sbom/voice-image.cdx.json"
  }
}
```

Unknown fields, reordered semantic arrays, missing interpreter destinations,
or missing host binding paths are rejected.

## Deterministic build sequence

Run release builds only on the bounded CI/build lane, never Hermes:

1. Create a clean detached checkout of the reviewed commit; require no tracked
   or untracked changes and record its exact commit and Git tree IDs.
2. Populate a fresh staging directory from `git archive` of that commit.
3. Copy one digest-pinned Node distribution into `runtime/node`.
4. In a digest-pinned builder, run `npm ci --omit=dev` for
   `claude-api-server`. Remove `node_modules/.bin` and foreign-platform native
   prebuilds. Require the two reviewed Linux native modules; do not rebuild on
   the target.
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
    Create the external approval only through the homelab change.

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
python3 -m unittest -v scripts/release/test_release_closure.py
```

Tests cover canonicalization, traversal, extra/missing/tampered files,
symlinks, hardlinks, FIFOs, xattrs, modes, exact native modules,
provider/image/SBOM cross-binding, host-bound source completeness, and
byte-identical double packaging.
