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
    PROMOTION_BLOCKERS,
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

HOST_RUNTIME_ENTRYPOINTS = (
    "claude-api-server/provider-egress-broker.js",
    "claude-api-server/provider-egress-shim.js",
    "claude-api-server/provider-supervisor-service.js",
    "claude-api-server/server.js",
    "claude-api-server/worker-session-broker-service.js",
    "privileged-action-broker/control.js",
    "privileged-action-broker/index.js",
    "realtime-sip-gateway/src/index.js",
)

PACKAGE_SCOPE_PATHS = (
    "claude-api-server/package.json",
    "package.json",
    "privileged-action-broker/package.json",
    "realtime-sip-gateway/package.json",
)

VOICE_AND_HOST_SOURCE_PATHS = (
    "deploy/host/teleagent-disabled-host-install",
    "deploy/voice-stack/drachtio.conf.xml.template",
    "deploy/voice-stack/freeswitch-event-socket.conf.xml.template",
    "deploy/voice-stack/media-application-boundary.js",
    "deploy/voice-stack/media-receiver-endpoints.js",
    "deploy/voice-stack/teleagent-sip-local-peer-fence",
    "deploy/voice-stack/teleagent-sip-local-peer-fence-install",
    "deploy/voice-stack/teleagent-sip-local-peer-fence.bundle",
    "deploy/voice-stack/teleagent-sip-local-peer-fence.service",
    "deploy/voice-stack/teleagent-voice-containers.slice",
    "deploy/voice-stack/teleagent-voice-stack-install",
    "deploy/voice-stack/teleagent-voice-stack-launch.js",
    "deploy/voice-stack/teleagent-voice-stack.service",
    "deploy/voice-stack/teleagent-voice-stack.sysusers",
    "deploy/voice-stack/teleagent-voice-stack.tmpfiles",
    "deploy/voice-stack/verify-voice-stack-identity",
    "docker-compose.yml",
    "freeswitch/entrypoint.sh",
    "freeswitch/mrf.xml",
    "freeswitch/switch.conf.xml",
    "lib/voice-app-runtime-env.js",
    "lib/sip-media-boundary-contract.js",
)

EXPECTED_PROMOTION_BLOCKERS = (
    "persistent-docker-group-self-hosted-runner-is-not-an-external-trust-boundary",
    "voice-image-build-toolchain-is-not-hermetic",
    "separate-trusted-ephemeral-attestation-job-is-not-defined",
    "independent-pbx-attested-request-bound-approval-authority-is-not-implemented",
    "receiver-safe-sip-media-network-boundary-and-asterisk-rtp-attestation-"
    "are-not-implemented",
    "universal-current-boot-release-gate-enforcement-at-credential-bearing-"
    "service-restart-is-not-proven",
    "dedicated-staging-proof-including-non-root-media-containers-is-missing",
)

RELEASE_START_GATE = (
    "ExecStartPre=+/usr/bin/env -i HOME=/var/empty "
    "PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 "
    "/usr/local/libexec/verify-teleagent-release-closure --check-start-gate"
)

EXPECTED_START_GATED_UNITS = (
    "deploy/controller/teleagent-agent-controller.service",
    "deploy/privileged-action/teleagent-privileged-action.service",
    "deploy/voice-stack/teleagent-voice-stack.service",
    "deploy/worker-session/teleagent-provider-egress@.service",
    "deploy/worker-session/teleagent-provider-libexec-install.service",
    "deploy/worker-session/teleagent-provider-supervisor@.service",
    "deploy/worker-session/teleagent-worker-session.service",
    "realtime-sip-gateway/deploy/teleagent-realtime-sip-gateway.service",
)

RELEASE_GATE_CREDENTIAL = (
    "LoadCredential=teleagent-release-gate:"
    "/run/teleagent-release-gate/verified.json"
)

EXPECTED_START_COMPONENTS = {
    "deploy/controller/teleagent-agent-controller.service": "agent-controller",
    "deploy/privileged-action/teleagent-privileged-action.service": "privileged-action",
    "deploy/voice-stack/teleagent-voice-stack.service": "voice-stack-start",
    "deploy/worker-session/teleagent-provider-egress@.service": "provider-egress-%i",
    "deploy/worker-session/teleagent-provider-libexec-install.service":
        "provider-libexec-install",
    "deploy/worker-session/teleagent-provider-supervisor@.service":
        "provider-supervisor-%i",
    "deploy/worker-session/teleagent-worker-session.service": "worker-session",
    "realtime-sip-gateway/deploy/teleagent-realtime-sip-gateway.service":
        "realtime-sip-gateway",
}


def release_start_command(component: str) -> str:
    supervised = component not in ('privileged-action', 'voice-stack-start', 'provider-libexec-install')
    prefix = '!' if supervised else ''
    operation = '--supervise-component' if supervised else '--start-component'
    return (
        f"ExecStart={prefix}/usr/bin/python3 -I "
        "/usr/local/libexec/verify-teleagent-release-closure "
        f"{operation} {component} "
        "${CREDENTIALS_DIRECTORY}/teleagent-release-gate"
    )


def release_preflight_command(component: str) -> str:
    return (
        "ExecStartPre=+/usr/bin/python3 -I "
        "/usr/local/libexec/verify-teleagent-release-closure "
        f"--preflight-component {component} "
        "${CREDENTIALS_DIRECTORY}/teleagent-release-gate"
    )


EXPECTED_EXECUTION_DIRECTIVES = {
    "deploy/controller/teleagent-agent-controller.service": (
        RELEASE_START_GATE,
        release_start_command("agent-controller"),
    ),
    "deploy/privileged-action/teleagent-privileged-action.service": (
        RELEASE_START_GATE,
        release_start_command("privileged-action"),
    ),
    "deploy/voice-stack/teleagent-voice-stack.service": (
        RELEASE_START_GATE,
        release_start_command("voice-stack-start"),
        "ExecStop=/usr/bin/python3 -I "
        "/usr/local/libexec/verify-teleagent-release-closure --stop-voice-stack",
        "ExecStopPost=/usr/bin/python3 -I "
        "/usr/local/libexec/verify-teleagent-release-closure --cleanup-voice-stack",
    ),
    "deploy/worker-session/teleagent-provider-egress@.service": (
        RELEASE_START_GATE,
        release_preflight_command("provider-egress-%i"),
        release_start_command("provider-egress-%i"),
    ),
    "deploy/worker-session/teleagent-provider-libexec-install.service": (
        RELEASE_START_GATE,
        release_start_command("provider-libexec-install"),
    ),
    "deploy/worker-session/teleagent-provider-supervisor@.service": (
        RELEASE_START_GATE,
        release_preflight_command("provider-supervisor-%i"),
        release_start_command("provider-supervisor-%i"),
    ),
    "deploy/worker-session/teleagent-worker-session.service": (
        RELEASE_START_GATE,
        release_preflight_command("worker-session"),
        release_start_command("worker-session"),
    ),
    "realtime-sip-gateway/deploy/teleagent-realtime-sip-gateway.service": (
        RELEASE_START_GATE,
        release_preflight_command("realtime-sip-gateway"),
        release_start_command("realtime-sip-gateway"),
    ),
}

EXPECTED_CREDENTIAL_DIRECTIVES = {
    "deploy/controller/teleagent-agent-controller.service": (
        RELEASE_GATE_CREDENTIAL,
    ),
    "deploy/privileged-action/teleagent-privileged-action.service": (
        "LoadCredential=approval-public-key:"
        "/etc/teleagent/privileged-action/approval-public.pem",
        "LoadCredential=replay-fingerprint-key:"
        "/etc/teleagent/privileged-action/replay-fingerprint.key",
        RELEASE_GATE_CREDENTIAL,
    ),
    "deploy/voice-stack/teleagent-voice-stack.service": (
        RELEASE_GATE_CREDENTIAL,
    ),
    "deploy/worker-session/teleagent-provider-egress@.service": (
        "LoadCredential=provider-api-key:"
        "/etc/teleagent/provider-egress-secrets/%i.api-key",
        RELEASE_GATE_CREDENTIAL,
    ),
    "deploy/worker-session/teleagent-provider-libexec-install.service": (
        RELEASE_GATE_CREDENTIAL,
    ),
    "deploy/worker-session/teleagent-provider-supervisor@.service": (
        RELEASE_GATE_CREDENTIAL,
    ),
    "deploy/worker-session/teleagent-worker-session.service": (
        RELEASE_GATE_CREDENTIAL,
    ),
    "realtime-sip-gateway/deploy/teleagent-realtime-sip-gateway.service": (
        "LoadCredential=OPENAI_API_KEY:/etc/teleagent/credentials/openai-api-key",
        "LoadCredential=OPENAI_WEBHOOK_SECRET:"
        "/etc/teleagent/credentials/openai-webhook-secret",
        "LoadCredential=SIP_PBX_AUTH_SECRET:"
        "/etc/teleagent/credentials/sip-pbx-auth-secret",
        "LoadCredential=SIP_STATE_INITIALIZED:"
        "/etc/teleagent/realtime-sip-gateway/STATE_INITIALIZED",
        RELEASE_GATE_CREDENTIAL,
    ),
}

EXECUTION_DIRECTIVE_RE = re.compile(
    r"^Exec(?:Condition|StartPre|Start|StartPost|Reload|Stop|StopPost)="
)
CREDENTIAL_DIRECTIVE_RE = re.compile(
    r"^(?:LoadCredential|LoadCredentialEncrypted|SetCredential|"
    r"SetCredentialEncrypted|ImportCredential|ImportCredentialEx)="
)
SENSITIVE_ASSIGNMENT_RE = re.compile(
    r"^(?:[^\S\r\n]+(?:"
    r"Exec(?:Condition|StartPre|Start|StartPost|Reload|Stop|StopPost)|"
    r"(?:LoadCredential|LoadCredentialEncrypted|SetCredential|"
    r"SetCredentialEncrypted|ImportCredential|ImportCredentialEx))[^\S\r\n]*="
    r"|(?:Exec(?:Condition|StartPre|Start|StartPost|Reload|Stop|StopPost)|"
    r"(?:LoadCredential|LoadCredentialEncrypted|SetCredential|"
    r"SetCredentialEncrypted|ImportCredential|ImportCredentialEx))[^\S\r\n]+=)",
    re.MULTILINE,
)
UNIT_SECTION_RE = re.compile(r"[^\S\r\n]*(\[[^\][\r\n]+\])[^\S\r\n]*")


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def local_module_closure(entrypoints: tuple[str, ...]) -> set[str]:
    """Derive the exact local JavaScript graph loaded by host entrypoints."""

    patterns = (
        re.compile(r"require\(\s*['\"]([^'\"]+)['\"]\s*\)"),
        re.compile(r"\bfrom\s+['\"]([^'\"]+)['\"]"),
        re.compile(r"\bimport\s+['\"]([^'\"]+)['\"]"),
    )
    pending = list(entrypoints)
    closure: set[str] = set()
    while pending:
        relative = pending.pop()
        if relative in closure:
            continue
        closure.add(relative)
        source = (REPOSITORY_ROOT / relative).read_text("utf-8")
        for expression in patterns:
            for specifier in expression.findall(source):
                if not specifier.startswith("."):
                    continue
                target = Path(os.path.normpath(
                    (Path(relative).parent / specifier).as_posix()
                ))
                if not target.suffix:
                    target = target.with_suffix(".js")
                normalized = target.as_posix()
                if not (REPOSITORY_ROOT / normalized).is_file():
                    raise AssertionError(
                        f"unresolved host-local import: {relative} -> {specifier}"
                    )
                pending.append(normalized)
    return closure


def component_manifest_sources(filename: Path, field: int, prefix: str = "") -> set[str]:
    result = set()
    for line in filename.read_text("utf-8").splitlines():
        if line:
            result.add(f"{prefix}{line.split()[field]}")
    return result


def nearest_package_scope(relative: str) -> str:
    parent = Path(relative).parent
    while True:
        candidate = parent / "package.json"
        if (REPOSITORY_ROOT / candidate).is_file():
            return candidate.as_posix()
        if parent == Path("."):
            raise AssertionError(f"host JavaScript has no package scope: {relative}")
        parent = parent.parent


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

    def test_bound_source_paths_are_the_exact_production_host_closure(self) -> None:
        worker_installer = (
            REPOSITORY_ROOT / "deploy/worker-session/teleagent-worker-session-install"
        ).read_text("utf-8")
        worker_direct = set(re.findall(
            r"\badd_asset\s+(deploy/worker-session/[^\s\\]+)", worker_installer
        ))
        worker_manifest = component_manifest_sources(
            REPOSITORY_ROOT / "deploy/worker-session/provider-libexec.manifest", 1
        )
        controller_manifest_path = (
            REPOSITORY_ROOT / "deploy/controller/control-plane-install.manifest"
        )
        controller_sources = component_manifest_sources(controller_manifest_path, 2)
        controller_sources.add("deploy/controller/control-plane-install.manifest")
        sip_manifest_path = (
            REPOSITORY_ROOT
            / "realtime-sip-gateway/deploy/realtime-sip-gateway-install.manifest"
        )
        sip_sources = component_manifest_sources(
            sip_manifest_path, 1, "realtime-sip-gateway/"
        )
        sip_sources.add(
            "realtime-sip-gateway/deploy/realtime-sip-gateway-install.manifest"
        )

        expected = (
            local_module_closure(HOST_RUNTIME_ENTRYPOINTS)
            | set(PACKAGE_SCOPE_PATHS)
            | set(VOICE_AND_HOST_SOURCE_PATHS)
            | worker_direct
            | worker_manifest
            | controller_sources
            | sip_sources
        )
        self.assertEqual(BOUND_SOURCE_PATHS, tuple(sorted(expected)))
        self.assertEqual(len(BOUND_SOURCE_PATHS), 141)
        self.assertIn("deploy/voice-stack/media-application-boundary.js", BOUND_SOURCE_PATHS)
        self.assertIn("lib/worker-inspection-contract.js", BOUND_SOURCE_PATHS)
        self.assertEqual(len(BOUND_SOURCE_PATHS), len(set(BOUND_SOURCE_PATHS)))
        package_scopes = {
            nearest_package_scope(relative)
            for relative in BOUND_SOURCE_PATHS
            if relative.endswith(".js")
        }
        self.assertEqual(package_scopes, set(PACKAGE_SCOPE_PATHS))
        self.assertTrue(package_scopes.issubset(BOUND_SOURCE_PATHS))
        self.assertEqual(
            tuple(path for path in BOUND_SOURCE_PATHS if path.startswith(
                "realtime-sip-gateway/src/"
            )),
            (
                "realtime-sip-gateway/src/app.js",
                "realtime-sip-gateway/src/call-gateway.js",
                "realtime-sip-gateway/src/call-registry.js",
                "realtime-sip-gateway/src/config.js",
                "realtime-sip-gateway/src/gateway-singleton.js",
                "realtime-sip-gateway/src/gateway-state-store.js",
                "realtime-sip-gateway/src/http-server.js",
                "realtime-sip-gateway/src/index.js",
                "realtime-sip-gateway/src/logger.js",
                "realtime-sip-gateway/src/openai-call-service.js",
                "realtime-sip-gateway/src/sideband-session.js",
                "realtime-sip-gateway/src/sip-event.js",
                "realtime-sip-gateway/src/state-storage-boundary.js",
                "realtime-sip-gateway/src/webhook-handler.js",
            ),
        )
        for relative in BOUND_SOURCE_PATHS:
            filename = REPOSITORY_ROOT / relative
            metadata = filename.lstat()
            self.assertTrue(stat.S_ISREG(metadata.st_mode), relative)
            self.assertFalse(filename.is_symlink(), relative)
            self.assertNotIn("/test/", relative)
            self.assertFalse(relative.startswith("docs/"), relative)
            self.assertFalse(relative.endswith("README.md"), relative)
            self.assertFalse(relative.endswith(".env.example"), relative)

    def test_every_release_consuming_unit_starts_with_the_cheap_boot_gate(self) -> None:
        candidates: list[str] = []
        for relative in BOUND_SOURCE_PATHS:
            if not relative.endswith(".service"):
                continue
            raw_source = (REPOSITORY_ROOT / relative).read_bytes()
            self.assertNotIn(b"\x00", raw_source, relative)
            self.assertNotIn(b"\r", raw_source, relative)
            source = raw_source.decode("utf-8")
            self.assertIsNone(
                re.search(r"\\[^\S\r\n]*$", source, re.MULTILINE), relative
            )
            self.assertIsNone(SENSITIVE_ASSIGNMENT_RE.search(source), relative)
            execution_lines: list[str] = []
            credential_lines: list[str] = []
            section: str | None = None
            for line in source.split("\n"):
                header = UNIT_SECTION_RE.fullmatch(line)
                if header:
                    section = header.group(1)
                    continue
                if EXECUTION_DIRECTIVE_RE.match(line):
                    self.assertEqual(section, "[Service]", relative)
                    execution_lines.append(line)
                if CREDENTIAL_DIRECTIVE_RE.match(line):
                    self.assertEqual(section, "[Service]", relative)
                    credential_lines.append(line)
            execution_lines_tuple = tuple(execution_lines)
            if RELEASE_START_GATE in execution_lines or "--start-component" in source:
                candidates.append(relative)
                self.assertEqual(execution_lines.count(RELEASE_START_GATE), 1, relative)
                self.assertEqual(execution_lines[0], RELEASE_START_GATE, relative)
                self.assertEqual(credential_lines.count(RELEASE_GATE_CREDENTIAL), 1, relative)
                component = EXPECTED_START_COMPONENTS[relative]
                self.assertIn(
                    release_start_command(component),
                    execution_lines_tuple,
                    relative,
                )
                self.assertEqual(
                    sum('--start-component' in line or '--supervise-component' in line
                        for line in execution_lines),
                    1,
                    relative,
                )
                self.assertEqual(
                    tuple(sorted(execution_lines)),
                    tuple(sorted(EXPECTED_EXECUTION_DIRECTIVES[relative])),
                    relative,
                )
                self.assertEqual(
                    tuple(sorted(credential_lines)),
                    tuple(sorted(EXPECTED_CREDENTIAL_DIRECTIVES[relative])),
                    relative,
                )
                if relative == "deploy/voice-stack/teleagent-voice-stack.service":
                    self.assertIn(
                        "ExecStop=/usr/bin/python3 -I "
                        "/usr/local/libexec/verify-teleagent-release-closure "
                        "--stop-voice-stack",
                        source.split("\n"),
                    )
                else:
                    self.assertFalse(
                        any(
                            line.startswith(("ExecStartPost=", "ExecStop=", "ExecStopPost="))
                            for line in execution_lines
                        ),
                        relative,
                    )
                self.assertNotIn("ExecReload=", source, relative)
                for line in execution_lines:
                    self.assertNotIn("/opt/teleagent/current", line, relative)
                    if line.startswith(("ExecStartPost=", "ExecStop=", "ExecStopPost=")):
                        self.assertNotIn("teleagent-node", line, relative)
                        self.assertNotIn("teleagent-voice-stack-launch", line, relative)
                self.assertFalse(
                    any("--check-runtime" in line for line in execution_lines),
                    f"{relative} would amplify a full release scan at service start",
                )
        self.assertEqual(tuple(sorted(candidates)), EXPECTED_START_GATED_UNITS)

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
            self.assertEqual(PROMOTION_BLOCKERS, EXPECTED_PROMOTION_BLOCKERS)
            self.assertEqual(
                summary["promotionEligibility"]["reasons"],
                list(EXPECTED_PROMOTION_BLOCKERS),
            )
            self.assertNotIn(
                "host-executed-bound-source-integration-is-pending",
                summary["promotionEligibility"]["reasons"],
            )
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
                "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
                "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
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
