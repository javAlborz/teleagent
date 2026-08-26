#!/usr/bin/env python3
"""Focused tests for the dormant Hephaestus release-candidate lane."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ci_release_support import (
    CiReleaseError,
    compare_and_publish,
    load_ci_config,
    normalize_cyclonedx,
    prune_native_modules,
    stage_provider_artifacts,
    write_build_input,
    write_voice_manifest,
)
from release_closure import (
    API_NATIVE_MODULE_PATHS,
    BOUND_SOURCE_PATHS,
    PRIVILEGED_BROKER_LOCK_PATH,
    PRIVILEGED_BROKER_NATIVE_MODULE_PATHS,
    PRIVILEGED_BROKER_NODE_MODULES_PATH,
    REALTIME_SIP_LOCK_PATH,
    REALTIME_SIP_NATIVE_MODULE_PATHS,
    REALTIME_SIP_NODE_MODULES_PATH,
    canonical_json_bytes,
    package_release,
    validate_build_input,
)
from test_release_closure import ReleaseFixture


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPOSITORY_ROOT / ".github/workflows/teleagent-release-candidate.yml"
BUILDER = REPOSITORY_ROOT / "scripts/release/build-ci-release.sh"
CONFIG = REPOSITORY_ROOT / "scripts/release/ci-release-inputs.json"
SUPPORT = REPOSITORY_ROOT / "scripts/release/ci_release_support.py"
SANDBOX = REPOSITORY_ROOT / "scripts/release/run-ci-sandbox.sh"
REVISION = "a" * 40
TREE = "b" * 40
CONFIG_DIGEST = f"sha256:{'c' * 64}"


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def provider_record(
    artifact_id: str,
    provider: str,
    path: str,
    source: str | None,
    payload: bytes,
) -> dict[str, object]:
    return {
        "id": artifact_id,
        "provider": provider,
        "path": path,
        "source": source,
        "sha256": sha256(payload),
        "size": len(payload),
        "mode": "0755",
        "versionArgs": ["--version"],
        "versionStdout": "fixture version",
    }


class CiReleaseTests(unittest.TestCase):
    def test_reviewed_inputs_are_canonical_and_exact(self) -> None:
        config = load_ci_config(CONFIG)
        self.assertEqual(CONFIG.read_bytes(), canonical_json_bytes(config))
        self.assertEqual(config["runnerName"], "hephaestus-ci-build-vm01-teleagent")
        self.assertEqual(config["node"]["version"], "v24.19.0")
        self.assertEqual(config["node"]["modulesAbi"], "137")
        self.assertRegex(
            config["sandboxImage"],
            r"^node:24\.19\.0-bookworm@sha256:[a-f0-9]{64}$",
        )
        self.assertEqual(config["tools"]["syft"]["version"], "1.51.0")
        self.assertEqual(config["tools"]["trivy"]["version"], "0.72.0")
        for tool_name in ("syft", "trivy"):
            tool = config["tools"][tool_name]
            self.assertRegex(tool["archiveSha256"], r"^[a-f0-9]{64}$")
            self.assertRegex(tool["binarySha256"], r"^[a-f0-9]{64}$")
            self.assertTrue(tool["archiveUrl"].startswith("https://github.com/"))
            self.assertEqual(tool["path"], f"/usr/local/bin/{tool_name}")

    def test_build_input_uses_the_canonical_dynamic_runtime_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "build-input.json"
            write_build_input(destination, REVISION, TREE)
            document = json.loads(destination.read_text("ascii"))
            validate_build_input(document)
            runtime = document["hostRuntime"]
            self.assertEqual(runtime["boundSourcePaths"], list(BOUND_SOURCE_PATHS))
            self.assertEqual(
                runtime["privilegedBrokerLockPath"], PRIVILEGED_BROKER_LOCK_PATH
            )
            self.assertEqual(
                runtime["privilegedBrokerNodeModulesPath"],
                PRIVILEGED_BROKER_NODE_MODULES_PATH,
            )
            self.assertEqual(
                runtime["privilegedBrokerNativeModulePaths"],
                list(PRIVILEGED_BROKER_NATIVE_MODULE_PATHS),
            )
            self.assertEqual(runtime["realtimeSipLockPath"], REALTIME_SIP_LOCK_PATH)
            self.assertEqual(
                runtime["realtimeSipNodeModulesPath"], REALTIME_SIP_NODE_MODULES_PATH
            )
            self.assertEqual(
                runtime["realtimeSipNativeModulePaths"],
                list(REALTIME_SIP_NATIVE_MODULE_PATHS),
            )
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o444)

    def test_voice_manifest_is_one_canonical_v2_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "voice-image.manifest.json"
            write_voice_manifest(destination, REVISION, CONFIG_DIGEST)
            document = json.loads(destination.read_text("ascii"))
            self.assertEqual(destination.read_bytes(), canonical_json_bytes(document))
            self.assertEqual(document["version"], 2)
            self.assertEqual(document["configDigest"], CONFIG_DIGEST)
            self.assertEqual(document["runtimeReference"], CONFIG_DIGEST)
            self.assertIsNone(document["registryReference"])
            with self.assertRaisesRegex(CiReleaseError, "revision or config digest"):
                write_voice_manifest(Path(temporary) / "bad.json", REVISION, "latest")

    def test_sbom_normalization_removes_only_ephemeral_identity_deterministically(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = {
                "bomFormat": "CycloneDX",
                "specVersion": "1.6",
                "version": 1,
                "metadata": {"timestamp": "2026-01-01T00:00:00Z", "component": {"name": "x"}},
                "components": [{"name": "z"}, {"name": "a"}],
                "dependencies": [
                    {"ref": "z", "dependsOn": ["b", "a"]},
                    {"ref": "a", "dependsOn": []},
                ],
            }
            first_document = dict(base, serialNumber="urn:uuid:first")
            second_document = json.loads(json.dumps(base))
            second_document["serialNumber"] = "urn:uuid:second"
            second_document["metadata"]["timestamp"] = "2026-08-26T12:34:56Z"
            first_source = root / "first.raw.json"
            second_source = root / "second.raw.json"
            first_source.write_text(json.dumps(first_document), encoding="utf-8")
            second_source.write_text(json.dumps(second_document), encoding="utf-8")
            first = root / "first.cdx.json"
            second = root / "second.cdx.json"
            normalize_cyclonedx(first_source, first)
            normalize_cyclonedx(second_source, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            normalized = json.loads(first.read_text("ascii"))
            self.assertNotIn("serialNumber", normalized)
            self.assertNotIn("timestamp", normalized["metadata"])
            self.assertEqual(
                [component["name"] for component in normalized["components"]], ["a", "z"]
            )
            forbidden = root / "forbidden.raw.json"
            forbidden.write_text(
                json.dumps(dict(base, metadata={"component": {"name": str(root)}})),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(CiReleaseError, "ephemeral staging path"):
                normalize_cyclonedx(
                    forbidden,
                    root / "forbidden.cdx.json",
                    forbidden_paths=(str(root),),
                )

    def test_native_pruning_covers_api_and_privileged_broker_trees(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            staging = Path(temporary)
            expected = (
                API_NATIVE_MODULE_PATHS
                + PRIVILEGED_BROKER_NATIVE_MODULE_PATHS
                + REALTIME_SIP_NATIVE_MODULE_PATHS
            )
            for relative in expected:
                filename = staging / relative
                filename.parent.mkdir(parents=True, exist_ok=True)
                filename.write_bytes(relative.encode("ascii"))
            for module_root in (
                staging / "claude-api-server/node_modules",
                staging / PRIVILEGED_BROKER_NODE_MODULES_PATH,
                staging / REALTIME_SIP_NODE_MODULES_PATH,
            ):
                (module_root / ".bin").mkdir(parents=True)
                (module_root / ".bin/tool").write_text("shim\n", encoding="ascii")
                extra = module_root / "injected/build/Release/injected.node"
                extra.parent.mkdir(parents=True)
                extra.write_bytes(b"injected")
            prune_native_modules(staging)
            for relative in expected:
                self.assertTrue((staging / relative).is_file())
            self.assertFalse((staging / "claude-api-server/node_modules/.bin").exists())
            self.assertFalse(
                (staging / PRIVILEGED_BROKER_NODE_MODULES_PATH / ".bin").exists()
            )
            self.assertFalse((staging / REALTIME_SIP_NODE_MODULES_PATH / ".bin").exists())
            self.assertFalse(list(staging.rglob("injected.node")))
            (staging / PRIVILEGED_BROKER_NATIVE_MODULE_PATHS[0]).unlink()
            with self.assertRaisesRegex(CiReleaseError, "privileged broker native module"):
                prune_native_modules(staging)
            (staging / PRIVILEGED_BROKER_NATIVE_MODULE_PATHS[0]).write_bytes(b"restored")
            (staging / REALTIME_SIP_NATIVE_MODULE_PATHS[0]).unlink()
            with self.assertRaisesRegex(CiReleaseError, "realtime SIP gateway native module"):
                prune_native_modules(staging)

    def test_provider_inputs_are_copied_as_reviewed_bytes_without_execution(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_root = root / "provider-inputs"
            staging = root / "release"
            input_root.mkdir()
            wrapper = b"#!/bin/sh\nexec /fixed/codex-vendor \"$@\"\n"
            payloads = {
                "claude": b"fixture-claude-binary",
                "codex-vendor": b"fixture-codex-vendor-binary",
            }
            config = load_ci_config(CONFIG)
            for artifact_id, payload in payloads.items():
                filename = input_root / config["providerFiles"][artifact_id]
                filename.write_bytes(payload)
                filename.chmod(0o555)
            wrapper_path = staging / "deploy/worker-session/teleagent-codex-cli-wrapper"
            wrapper_path.parent.mkdir(parents=True)
            wrapper_path.write_bytes(wrapper)
            wrapper_path.chmod(0o755)
            records = [
                provider_record(
                    "claude", "claude", "/opt/teleagent/agent-tools/claude", None,
                    payloads["claude"],
                ),
                provider_record(
                    "codex-wrapper", "codex", "/opt/teleagent/agent-tools/codex",
                    "/usr/local/libexec/teleagent-provider-codex-cli-wrapper", wrapper,
                ),
                provider_record(
                    "codex-vendor", "codex", "/opt/teleagent/agent-tools/codex-vendor", None,
                    payloads["codex-vendor"],
                ),
            ]
            manifest = root / "provider-cli.manifest.json"
            manifest.write_text(json.dumps({"version": 1, "artifacts": records}), encoding="utf-8")
            stage_provider_artifacts(
                manifest,
                staging,
                input_root=input_root,
                trusted_uid=os.getuid(),
                trusted_gid=os.getgid(),
                require_fixed_ancestry=False,
            )
            for artifact_id, payload in payloads.items():
                destination = staging / f"artifacts/provider-cli/{artifact_id}"
                self.assertEqual(destination.read_bytes(), payload)
                self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o555)

    def test_compare_publishes_only_byte_identical_clean_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = ReleaseFixture(root, "first")
            second = ReleaseFixture(root, "second")
            first.generate()
            second.generate()
            first_bundle = root / "first.tar"
            second_bundle = root / "second.tar"
            package_release(first.root, first_bundle, source_date_epoch=1_700_000_000)
            package_release(second.root, second_bundle, source_date_epoch=1_700_000_000)
            scan = root / "voice-image.trivy.json"
            scan.write_text(json.dumps({"Results": []}) + "\n", encoding="utf-8")
            output = root / "evidence"
            summary = compare_and_publish(
                first.root, first_bundle, second.root, second_bundle, scan, output
            )
            self.assertEqual(summary["determinism"]["freshAssemblies"], 2)
            self.assertEqual(summary["authorization"], "non-promotable-build-evidence-only")
            self.assertEqual(summary["promotionEligibility"]["status"], "blocked")
            self.assertEqual(summary["buildToolchain"]["syft"]["version"], "1.51.0")
            self.assertTrue((output / "SHA256SUMS").is_file())

            dirty_scan = root / "dirty.trivy.json"
            dirty_scan.write_text(
                json.dumps({"Results": [{"Vulnerabilities": [{"Severity": "HIGH"}]}]}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(CiReleaseError, "critical/high vulnerability or secret"):
                compare_and_publish(
                    first.root,
                    first_bundle,
                    second.root,
                    second_bundle,
                    dirty_scan,
                    root / "dirty-evidence",
                )

    def test_workflow_is_manual_pinned_least_privilege_and_guest_only(self) -> None:
        workflow = WORKFLOW.read_text("utf-8")
        self.assertIn("  workflow_dispatch:\n", workflow)
        self.assertNotRegex(workflow, r"(?m)^  (?:pull_request|push|schedule):")
        self.assertIn("group: teleagent-release-candidate", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertIn("timeout-minutes: 120", workflow)
        for label in ("self-hosted", "Linux", "X64", "ci-build", "teleagent"):
            self.assertIn(f"      - {label}\n", workflow)
        self.assertIn("hephaestus-ci-build-vm01-teleagent", workflow)
        self.assertIn("github.event_name == 'workflow_dispatch'", workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn("Teleagent non-promotable release evidence", workflow)
        self.assertIn("ref: ${{ github.sha }}", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertNotIn("id-token: write", workflow)
        self.assertNotIn("attestations: write", workflow)
        self.assertNotIn("actions/attest", workflow)
        self.assertNotIn("packages: write", workflow)
        self.assertNotIn("secrets.", workflow)
        uses = re.findall(r"(?m)^\s*uses:\s*([^\s#]+)", workflow)
        self.assertEqual(
            uses,
            [
                "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
                "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
            ],
        )
        for use in uses:
            self.assertRegex(use.rsplit("@", 1)[1], r"^[a-f0-9]{40}$")

    def test_builder_is_dormant_bounded_and_assembles_twice(self) -> None:
        builder = BUILDER.read_text("utf-8")
        support = SUPPORT.read_text("utf-8")
        sandbox = SANDBOX.read_text("utf-8")
        self.assertIn("TELEAGENT_CI_RELEASE_BUILD", builder)
        self.assertIn("hephaestus-ci-build-vm01-teleagent", builder)
        self.assertIn("GITHUB_EVENT_NAME:-}", builder)
        self.assertIn("GITHUB_REF:-}", builder)
        self.assertIn("git archive --format=tar", builder)
        self.assertIn("docker build --pull --no-cache --platform linux/amd64", builder)
        self.assertIn("TELEAGENT_SOURCE_REVISION", builder)
        self.assertIn("--scanners vuln,secret", builder)
        self.assertIn("--severity HIGH,CRITICAL --exit-code 1", builder)
        self.assertEqual(len(re.findall(r"(?m)^build_voice_image \"\$\{image_tag\}\"$", builder)), 2)
        self.assertIn('assemble_release first "${image_tag}"', builder)
        self.assertIn('assemble_release second "${image_tag}"', builder)
        self.assertNotIn("npm_ci", builder)
        self.assertNotIn("npm_cli", builder)
        self.assertIn("run_lifecycle_sandbox stage", builder)
        for guard in (
            "--read-only", "--cap-drop ALL", "no-new-privileges=true", "--pids-limit 256",
            "--cpus 2.0", "--memory 4g", "--pull never",
        ):
            self.assertIn(guard, builder)
        self.assertIn("dst=/work,readonly", builder)
        self.assertNotIn("docker.sock", builder)
        self.assertIn("npm_ci /work/privileged-action-broker --omit=dev", sandbox)
        self.assertIn("npm_ci /work/realtime-sip-gateway --omit=dev", sandbox)
        self.assertIn("privileged-broker-native-runtime-ok", sandbox)
        self.assertIn("realtime-sip-runtime-ok", sandbox)
        self.assertNotIn("NODE_PATH", builder)
        self.assertNotIn("NODE_PATH", sandbox)
        self.assertIn("cyclonedx-json@1.6", builder)
        self.assertIn("list(BOUND_SOURCE_PATHS)", support)
        for forbidden in (
            "docker push", "docker compose", "systemctl", "kubectl", "scp ", "ssh ", "sudo ",
        ):
            self.assertNotIn(forbidden, builder)


if __name__ == "__main__":
    unittest.main()
