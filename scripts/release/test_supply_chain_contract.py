#!/usr/bin/env python3
"""Fixture-only tests for the dormant supply-chain evidence contracts."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from supply_chain_contract import (  # noqa: E402
    ATTESTATION_CHECKS,
    ATTESTATION_WORKFLOW_REF,
    EPHEMERAL_ATTESTATION_SCHEMA,
    FIXTURE_AUTHORIZATION,
    OIDC_ISSUER,
    OIDC_SUBJECT,
    REPOSITORY,
    REPOSITORY_NAME,
    VOICE_TOOLCHAIN_SCHEMA,
    SupplyChainContractError,
    canonical_json_bytes,
    main,
    sha256_digest,
    validate_ephemeral_attestation_contract,
    validate_voice_toolchain_contract,
    voice_materials_digest,
)


REVISION = "a" * 40
TREE = "b" * 40


def digest(character: str) -> str:
    return f"sha256:{character * 64}"


def voice_toolchain_document() -> dict[str, object]:
    materials = [
        {
            "id": "apk-gpp-13.2.1-r0",
            "kind": "apk-package",
            "name": "g++",
            "version": "13.2.1-r0",
            "path": "inputs/apk/g++-13.2.1-r0.apk",
            "source": (
                "https://dl-cdn.alpinelinux.org/alpine/v3.22/main/"
                "x86_64/g++-13.2.1-r0.apk"
            ),
            "sha256": digest("c"),
            "size": 1_234_567,
        },
        {
            "id": "builder-node-24.19.0-alpine3.22",
            "kind": "builder-image",
            "name": "node",
            "version": "24.19.0-alpine3.22",
            "path": "inputs/oci/node-builder-layout.tar",
            "source": f"oci://docker.io/library/node@{digest('d')}",
            "sha256": digest("d"),
            "size": 51_000_000,
        },
        {
            "id": "npm-better-sqlite3-12.4.1",
            "kind": "npm-package",
            "name": "better-sqlite3",
            "version": "12.4.1",
            "path": "inputs/npm/better-sqlite3-12.4.1.tgz",
            "source": (
                "https://registry.npmjs.org/better-sqlite3/-/"
                "better-sqlite3-12.4.1.tgz"
            ),
            "sha256": digest("e"),
            "size": 9_876_543,
        },
        {
            "id": "runtime-node-24.19.0-alpine3.22",
            "kind": "runtime-image",
            "name": "node",
            "version": "24.19.0-alpine3.22",
            "path": "inputs/oci/node-runtime-layout.tar",
            "source": f"oci://docker.io/library/node@{digest('f')}",
            "sha256": digest("f"),
            "size": 49_000_000,
        },
    ]
    return {
        "schema": VOICE_TOOLCHAIN_SCHEMA,
        "version": 1,
        "authorization": FIXTURE_AUTHORIZATION,
        "source": {
            "repository": REPOSITORY,
            "revision": REVISION,
            "tree": TREE,
        },
        "target": {"os": "linux", "architecture": "amd64"},
        "execution": {
            "network": "none",
            "inputFilesystem": "read-only",
            "outputFilesystem": "empty",
            "environment": "empty-except-source-date-epoch",
            "sourceDateEpoch": 1_700_000_000,
        },
        "recipe": {
            "dockerfile": {
                "path": "voice-app/Dockerfile",
                "sha256": digest("1"),
                "size": 2_345,
            },
            "packageLock": {
                "path": "voice-app/package-lock.json",
                "sha256": digest("2"),
                "size": 123_456,
            },
        },
        "materials": materials,
        "closure": {
            "algorithm": "sha256-canonical-json",
            "materialCount": len(materials),
            "apkPackageCount": 1,
            "npmPackageCount": 1,
            "materialsSha256": voice_materials_digest(materials),
        },
    }


def attestation_document(toolchain_bytes: bytes) -> dict[str, object]:
    return {
        "schema": EPHEMERAL_ATTESTATION_SCHEMA,
        "version": 1,
        "authorization": FIXTURE_AUTHORIZATION,
        "subject": {
            "releaseManifestSha256": digest("3"),
            "releaseBundleSha256": digest("4"),
            "voiceImageConfigDigest": digest("5"),
            "voiceToolchainContractSha256": sha256_digest(toolchain_bytes),
        },
        "source": {
            "repository": REPOSITORY,
            "revision": REVISION,
            "tree": TREE,
        },
        "identity": {
            "issuer": OIDC_ISSUER,
            "subject": OIDC_SUBJECT,
            "audience": "sigstore",
            "repository": REPOSITORY_NAME,
            "repositoryId": "123456789",
            "workflowRef": ATTESTATION_WORKFLOW_REF,
            "workflowSha": REVISION,
            "eventName": "workflow_dispatch",
            "ref": "refs/heads/main",
            "runId": "987654321",
            "runAttempt": 1,
            "jobName": "attest-release",
            "runnerEnvironment": "github-hosted",
            "runnerLifecycle": "single-job-ephemeral",
        },
        "provenance": {
            "method": "independent-networkless-rebuild-and-compare",
            "candidateTrust": "untrusted-input-only",
            "sourceAcquisition": "independent-by-revision",
            "materialAcquisition": "digest-verified-before-network-disable",
            "networkDuringRebuild": "none",
            "checks": list(ATTESTATION_CHECKS),
            "startedAt": "2026-08-26T12:00:00Z",
            "finishedAt": "2026-08-26T12:05:00Z",
        },
        "verification": {
            "bundleFormat": "application/vnd.dev.sigstore.bundle.v0.3+json",
            "statementType": "https://in-toto.io/Statement/v1",
            "predicateType": "https://slsa.dev/provenance/v1",
            "bundlePath": "attestations/teleagent-release.sigstore.json",
            "bundleSha256": digest("6"),
            "bundleSize": 8_192,
            "certificateIssuer": OIDC_ISSUER,
            "certificateSubject": OIDC_SUBJECT,
            "transparencyLog": "https://rekor.sigstore.dev",
        },
    }


def canonical(document: dict[str, object]) -> bytes:
    return canonical_json_bytes(document)


class VoiceToolchainContractTests(unittest.TestCase):
    def test_accepts_one_canonical_networkless_exact_material_fixture(self) -> None:
        document = voice_toolchain_document()
        contents = canonical(document)
        self.assertEqual(validate_voice_toolchain_contract(contents), document)
        self.assertEqual(contents, canonical_json_bytes(document))

    def test_rejects_noncanonical_duplicate_and_reordered_json(self) -> None:
        document = voice_toolchain_document()
        with self.assertRaisesRegex(SupplyChainContractError, "canonical one-line"):
            validate_voice_toolchain_contract(
                json.dumps(document, indent=2).encode("ascii")
            )
        duplicated = canonical(document).replace(
            b'"version":1,', b'"version":1,"version":1,', 1
        )
        with self.assertRaisesRegex(SupplyChainContractError, "duplicate JSON key"):
            validate_voice_toolchain_contract(duplicated)
        reordered = {
            "version": document["version"],
            "schema": document["schema"],
            **{key: value for key, value in document.items() if key not in ("version", "schema")},
        }
        with self.assertRaisesRegex(SupplyChainContractError, "key order"):
            validate_voice_toolchain_contract(canonical(reordered))

        document = voice_toolchain_document()
        document["version"] = True
        with self.assertRaisesRegex(SupplyChainContractError, "identity or authorization"):
            validate_voice_toolchain_contract(canonical(document))

    def test_rejects_network_or_ambient_build_inputs(self) -> None:
        for key, value in (
            ("network", "egress"),
            ("inputFilesystem", "writable"),
            ("environment", "inherited"),
        ):
            document = voice_toolchain_document()
            document["execution"][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(
                SupplyChainContractError, f"execution {key}"
            ):
                validate_voice_toolchain_contract(canonical(document))

    def test_rejects_mutable_or_non_digest_addressed_material_identity(self) -> None:
        document = voice_toolchain_document()
        document["materials"][1]["version"] = "latest"
        with self.assertRaisesRegex(SupplyChainContractError, "mutable version"):
            validate_voice_toolchain_contract(canonical(document))

        document = voice_toolchain_document()
        document["materials"][1]["source"] = "oci://docker.io/library/node:24-alpine"
        with self.assertRaisesRegex(SupplyChainContractError, "digest-addressed OCI"):
            validate_voice_toolchain_contract(canonical(document))

    def test_rejects_unsorted_duplicate_or_escaping_material_paths(self) -> None:
        document = voice_toolchain_document()
        document["materials"][1], document["materials"][2] = (
            document["materials"][2],
            document["materials"][1],
        )
        with self.assertRaisesRegex(SupplyChainContractError, "ID-sorted"):
            validate_voice_toolchain_contract(canonical(document))

        document = voice_toolchain_document()
        document["materials"][1]["path"] = document["materials"][0]["path"]
        with self.assertRaisesRegex(SupplyChainContractError, "not unique"):
            validate_voice_toolchain_contract(canonical(document))

        document = voice_toolchain_document()
        document["materials"][0]["path"] = "inputs/../escape.apk"
        with self.assertRaisesRegex(SupplyChainContractError, "unsafe component"):
            validate_voice_toolchain_contract(canonical(document))

    def test_rejects_missing_ecosystem_or_self_inconsistent_closure(self) -> None:
        document = voice_toolchain_document()
        document["materials"][0]["kind"] = "npm-package"
        document["closure"]["apkPackageCount"] = 0
        document["closure"]["npmPackageCount"] = 2
        document["closure"]["materialsSha256"] = voice_materials_digest(
            document["materials"]
        )
        with self.assertRaisesRegex(SupplyChainContractError, "omits apk"):
            validate_voice_toolchain_contract(canonical(document))

        document = voice_toolchain_document()
        document["closure"]["materialCount"] = 5
        with self.assertRaisesRegex(SupplyChainContractError, "materialCount"):
            validate_voice_toolchain_contract(canonical(document))

        document = voice_toolchain_document()
        document["closure"]["materialsSha256"] = digest("9")
        with self.assertRaisesRegex(SupplyChainContractError, "closure digest"):
            validate_voice_toolchain_contract(canonical(document))

    def test_rejects_boolean_sizes_and_noncanonical_https_sources(self) -> None:
        document = voice_toolchain_document()
        document["materials"][0]["size"] = True
        with self.assertRaisesRegex(SupplyChainContractError, "positive bounded integer"):
            validate_voice_toolchain_contract(canonical(document))

        document = voice_toolchain_document()
        document["materials"][0]["source"] += "?mirror=mutable"
        with self.assertRaisesRegex(SupplyChainContractError, "non-canonical URL"):
            validate_voice_toolchain_contract(canonical(document))

        document = voice_toolchain_document()
        document["materials"][0]["source"] = (
            "https://dl-cdn.alpinelinux.org:99999/package.apk"
        )
        with self.assertRaisesRegex(SupplyChainContractError, "invalid port"):
            validate_voice_toolchain_contract(canonical(document))


class EphemeralAttestationContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.toolchain = canonical(voice_toolchain_document())

    def validate(self, document: dict[str, object]) -> dict[str, object]:
        return validate_ephemeral_attestation_contract(
            canonical(document), voice_toolchain_contents=self.toolchain
        )

    def test_accepts_exact_independent_ephemeral_cross_bound_fixture(self) -> None:
        document = attestation_document(self.toolchain)
        self.assertEqual(self.validate(document), document)

        document["version"] = True
        with self.assertRaisesRegex(SupplyChainContractError, "identity or authorization"):
            self.validate(document)

    def test_rejects_wrong_or_noncanonical_toolchain_bytes(self) -> None:
        document = attestation_document(self.toolchain)
        document["subject"]["voiceToolchainContractSha256"] = digest("9")
        with self.assertRaisesRegex(SupplyChainContractError, "exact voice toolchain"):
            self.validate(document)

        with self.assertRaisesRegex(SupplyChainContractError, "canonical one-line"):
            validate_ephemeral_attestation_contract(
                canonical(attestation_document(self.toolchain)),
                voice_toolchain_contents=self.toolchain.rstrip(b"\n"),
            )

    def test_rejects_self_hosted_or_persistent_attester_identity(self) -> None:
        for key, value in (
            ("runnerEnvironment", "self-hosted"),
            ("runnerLifecycle", "persistent"),
        ):
            document = attestation_document(self.toolchain)
            document["identity"][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(
                SupplyChainContractError, f"identity {key}"
            ):
                self.validate(document)

    def test_rejects_oidc_workflow_or_source_identity_drift(self) -> None:
        mutations = (
            ("issuer", "https://issuer.example.invalid"),
            ("subject", "repo:attacker/fork:ref:refs/heads/main"),
            ("workflowRef", ATTESTATION_WORKFLOW_REF.replace("main", "feature")),
            ("workflowSha", "f" * 40),
            ("eventName", "pull_request"),
            ("ref", "refs/heads/feature"),
        )
        for key, value in mutations:
            document = attestation_document(self.toolchain)
            document["identity"][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(
                SupplyChainContractError, f"identity {key}"
            ):
                self.validate(document)

        document = attestation_document(self.toolchain)
        document["source"]["tree"] = "f" * 40
        with self.assertRaisesRegex(SupplyChainContractError, "does not match"):
            self.validate(document)

    def test_rejects_incomplete_or_reordered_independent_checks(self) -> None:
        document = attestation_document(self.toolchain)
        document["provenance"]["checks"].pop()
        with self.assertRaisesRegex(SupplyChainContractError, "incomplete or reordered"):
            self.validate(document)

        document = attestation_document(self.toolchain)
        document["provenance"]["checks"].reverse()
        with self.assertRaisesRegex(SupplyChainContractError, "incomplete or reordered"):
            self.validate(document)

    def test_rejects_non_networkless_or_candidate_trusting_provenance(self) -> None:
        for key, value in (
            ("networkDuringRebuild", "egress"),
            ("candidateTrust", "trusted-builder"),
            ("method", "accept-candidate-claim"),
        ):
            document = attestation_document(self.toolchain)
            document["provenance"][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(
                SupplyChainContractError, f"provenance {key}"
            ):
                self.validate(document)

    def test_rejects_impossible_or_reversed_timestamps(self) -> None:
        document = attestation_document(self.toolchain)
        document["provenance"]["startedAt"] = "2026-02-30T12:00:00Z"
        with self.assertRaisesRegex(SupplyChainContractError, "real UTC"):
            self.validate(document)

        document = attestation_document(self.toolchain)
        document["provenance"]["finishedAt"] = "2026-08-26T11:59:59Z"
        with self.assertRaisesRegex(SupplyChainContractError, "not after"):
            self.validate(document)

    def test_rejects_unsigned_shape_or_certificate_claim_drift(self) -> None:
        document = attestation_document(self.toolchain)
        document["verification"]["bundlePath"] = "../escape.sigstore.json"
        with self.assertRaisesRegex(SupplyChainContractError, "invalid syntax|unsafe component"):
            self.validate(document)

        document = attestation_document(self.toolchain)
        document["verification"]["certificateSubject"] = "repo:attacker/fork"
        with self.assertRaisesRegex(SupplyChainContractError, "certificateSubject"):
            self.validate(document)

        document = attestation_document(self.toolchain)
        document["verification"]["bundleSize"] = False
        with self.assertRaisesRegex(SupplyChainContractError, "positive bounded integer"):
            self.validate(document)

    def test_cli_validates_only_explicit_fixture_commands(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            toolchain_path = root / "voice.json"
            attestation_path = root / "attestation.json"
            toolchain_path.write_bytes(self.toolchain)
            attestation_path.write_bytes(canonical(attestation_document(self.toolchain)))
            self.assertEqual(
                main(
                    [
                        "validate-voice-toolchain-fixture",
                        "--document",
                        str(toolchain_path),
                    ]
                ),
                0,
            )
            self.assertEqual(
                main(
                    [
                        "validate-ephemeral-attestation-fixture",
                        "--document",
                        str(attestation_path),
                        "--voice-toolchain",
                        str(toolchain_path),
                    ]
                ),
                0,
            )
            toolchain_path.write_bytes(self.toolchain.rstrip(b"\n"))
            stderr = StringIO()
            with redirect_stderr(stderr):
                self.assertEqual(
                    main(
                        [
                            "validate-voice-toolchain-fixture",
                            "--document",
                            str(toolchain_path),
                        ]
                    ),
                    77,
                )
            self.assertIn("not canonical one-line JSON", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
