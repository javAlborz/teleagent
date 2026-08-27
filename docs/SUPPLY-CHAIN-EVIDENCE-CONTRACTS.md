# Dormant Supply-Chain Evidence Contracts

Status: structural fixture contracts only. These contracts do not authorize a
release, satisfy a promotion blocker, grant a workflow permission, or describe
evidence that currently exists.

`scripts/release/supply_chain_contract.py` defines two canonical JSON fixture
formats and fail-closed validators:

- a complete material list for a future hermetic `linux/amd64` voice-image
  build; and
- a receipt shape for a future independent, trusted, single-job ephemeral
  attestation.

Every accepted document must carry the exact authorization marker
`dormant-fixture-only-no-promotion-authority`. Unknown or reordered fields,
duplicate JSON keys, non-canonical encoding, unsafe paths, and inconsistent
cross-bindings are rejected. The validators are intentionally separate from
the current release-candidate workflow and release closure.

## Voice toolchain fixture

The voice fixture binds one source revision and tree, the exact Dockerfile and
package-lock bytes, an ordered external-material closure, and a fixed execution
shape. The execution contract requires:

- no build network;
- read-only inputs and a fresh empty output filesystem;
- no inherited environment other than `SOURCE_DATE_EPOCH`; and
- one digest-addressed builder image, one digest-addressed runtime image, and
  explicit APK and npm package payloads.

Each material has a unique stable ID and input path, exact version, immutable
source identity, SHA-256 digest, and byte size. The closure repeats the total,
APK, and npm counts and binds the canonical ordered material list with a
SHA-256 digest. This makes omission or reordering visible within the fixture.

The validator does not prove that the declared material list is complete for
the actual Dockerfile or package lock. A trusted builder must independently
derive that closure, fetch and verify every byte, disable the network, and then
build from only those inputs. The current `voice-app/Dockerfile` still runs
networked `apk` and npm resolution and is therefore not hermetic.

## Trusted ephemeral attestation fixture

The attestation fixture binds the exact canonical voice-toolchain fixture bytes
alongside release-manifest, deterministic release-bundle, and voice-image
configuration digests. Its source identity must equal the toolchain source.

The prospective attester identity is deliberately narrow: the main ref of
`javAlborz/teleagent`, the exact future attestation-workflow path and workflow
revision, a manual event, a GitHub-hosted single-job ephemeral runner, and the
expected Sigstore OIDC issuer, subject, and audience. Its provenance method is
an independent networkless rebuild and comparison. It must treat candidate
runner output as untrusted input and record the complete ordered verification
sequence.

The receipt also binds a Sigstore bundle path, digest, size, statement and
predicate types, certificate policy, and Rekor log. The fixture validator does
not parse or cryptographically validate that bundle. A future authoritative
consumer must verify the signature, Fulcio certificate chain and claims,
transparency-log inclusion, subject digests, source identity, material bytes,
and actual rebuild outcome before it considers the receipt.

## Fixture validation

The focused tests create canonical documents in temporary storage; no example
fixture is installable or deployable.

```bash
scripts/hermes-safe-test python3 scripts/release/test_supply_chain_contract.py
```

For a local structural fixture:

```bash
python3 scripts/release/supply_chain_contract.py \
  validate-voice-toolchain-fixture --document voice-toolchain.fixture.json

python3 scripts/release/supply_chain_contract.py \
  validate-ephemeral-attestation-fixture \
  --document ephemeral-attestation.fixture.json \
  --voice-toolchain voice-toolchain.fixture.json
```

Successful structural validation is never promotion evidence.

## Work still outside this repository contract

The following proof remains external and mandatory:

1. Replace mutable Alpine/npm resolution with an independently derived,
   byte-pinned material closure and demonstrate a networkless build.
2. Create and review the separate trusted ephemeral workflow and its minimal
   OIDC/attestation permissions. The persistent Docker-group candidate runner
   must remain outside that trust boundary.
3. Generate and cryptographically verify a real signed statement and Sigstore
   bundle in that ephemeral identity, including transparency-log inclusion.
4. Teach a separately reviewed authoritative promotion verifier to enforce the
   final activated evidence schema and policy. This fixture-only schema must
   not be accepted as that activated evidence.
5. Complete dedicated staging and the other release blockers before any
   installation or service activation.

Accordingly, the existing blockers for a non-hermetic voice toolchain, a
missing trusted ephemeral attestation job, and the persistent self-hosted
runner remain correct.
