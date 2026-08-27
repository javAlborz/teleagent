#!/usr/bin/env python3
"""Fail-closed helpers for the dormant Hephaestus release-candidate lane.

This module prepares build evidence only. It never installs a release, imports
an image on a target host, reads credentials, runs a provider, or activates a
service.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

from release_closure import (
    API_LOCK_PATH,
    API_NATIVE_MODULE_PATHS,
    API_NODE_MODULES_PATH,
    BOUND_SOURCE_PATHS,
    FILE_LIST_NAME,
    INTERPRETER_TARGETS,
    MANIFEST_NAME,
    PRIVILEGED_BROKER_LOCK_PATH,
    PRIVILEGED_BROKER_NATIVE_MODULE_PATHS,
    PRIVILEGED_BROKER_NODE_MODULES_PATH,
    REALTIME_SIP_LOCK_PATH,
    REALTIME_SIP_NATIVE_MODULE_PATHS,
    REALTIME_SIP_NODE_MODULES_PATH,
    ClosureError,
    canonical_json_bytes,
    verify_release,
)


CI_CONFIG_NAME = "ci-release-inputs.json"
EXPECTED_PROVIDER_INPUT_ROOT = Path("/opt/teleagent-ci-inputs/provider-cli")
REVISION_RE = re.compile(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")
DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
HEX_RE = re.compile(r"^[a-f0-9]{64}$")

# These are authorization blockers, not advisory warnings.  Evidence remains
# non-promotable until a later reviewed pipeline removes every exact reason.
PROMOTION_BLOCKERS = (
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


class CiReleaseError(ValueError):
    """A CI input or generated artifact violates the release contract."""


def _error(message: str) -> CiReleaseError:
    return CiReleaseError(f"release CI refused: {message}")


def _sha256_file(filename: Path) -> tuple[str, int]:
    descriptor: int | None = None
    try:
        descriptor = os.open(filename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise _error(f"{filename.name} is not one single-link regular file")
        digest = hashlib.sha256()
        size = 0
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            digest.update(block)
            size += len(block)
        after = os.fstat(descriptor)
    except CiReleaseError:
        raise
    except OSError as exc:
        raise _error(f"{filename.name} cannot be hashed safely") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
    snapshot = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size")
    if any(getattr(before, field) != getattr(after, field) for field in snapshot) or size != before.st_size:
        raise _error(f"{filename.name} changed while it was hashed")
    return digest.hexdigest(), size


def _load_json(filename: Path, label: str, maximum: int = 128 * 1024 * 1024) -> dict[str, Any]:
    try:
        contents = filename.read_bytes()
    except OSError as exc:
        raise _error(f"{label} is absent or unreadable") from exc
    if not contents or len(contents) > maximum or b"\x00" in contents or b"\r" in contents:
        raise _error(f"{label} has invalid size or encoding")
    try:
        value = json.loads(contents.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _error(f"{label} is not valid JSON") from exc
    if type(value) is not dict:
        raise _error(f"{label} must be a JSON object")
    return value


def _require_keys(value: Any, keys: Sequence[str], label: str) -> dict[str, Any]:
    if type(value) is not dict or list(value) != list(keys):
        raise _error(f"{label} has an unsupported schema")
    return value


def load_ci_config(filename: Path | None = None) -> dict[str, Any]:
    path = filename or Path(__file__).with_name(CI_CONFIG_NAME)
    contents = path.read_bytes()
    config = _load_json(path, "release CI input configuration", 32 * 1024)
    if contents != canonical_json_bytes(config):
        raise _error("release CI input configuration is not canonical one-line JSON")
    _require_keys(
        config,
        (
            "version", "repository", "runnerName", "providerInputRoot", "sandboxImage",
            "node", "tools", "providerFiles",
        ),
        "release CI input configuration",
    )
    if config["version"] != 1 or config["repository"] != "javAlborz/teleagent" or \
            config["runnerName"] != "hephaestus-ci-build-vm01-teleagent" or \
            config["providerInputRoot"] != str(EXPECTED_PROVIDER_INPUT_ROOT) or \
            config["sandboxImage"] != (
                "node:24.19.0-bookworm@"
                "sha256:f6d02cf1353049cf3658e6ce9ec03c6877a6479495f122062d195e2279d01055"
            ):
        raise _error("release CI repository, runner, or provider root drifted")
    node = _require_keys(
        config["node"],
        ("version", "modulesAbi", "archiveUrl", "archiveSha256", "binarySha256", "archiveRoot"),
        "release CI Node input",
    )
    if node != {
        "version": "v24.19.0",
        "modulesAbi": "137",
        "archiveUrl": "https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz",
        "archiveSha256": "14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647",
        "binarySha256": "bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12",
        "archiveRoot": "node-v24.19.0-linux-x64",
    }:
        raise _error("release CI Node input is not the reviewed Node 24.19.0 artifact")
    tools = _require_keys(config["tools"], ("syft", "trivy"), "release CI tool inputs")
    tool_keys = (
        "path", "version", "platform", "archiveUrl", "archiveSha256", "binarySha256",
    )
    syft = _require_keys(tools["syft"], tool_keys, "release CI Syft input")
    if syft != {
        "path": "/usr/local/bin/syft",
        "version": "1.51.0",
        "platform": "linux/amd64",
        "archiveUrl": (
            "https://github.com/anchore/syft/releases/download/v1.51.0/"
            "syft_1.51.0_linux_amd64.tar.gz"
        ),
        "archiveSha256": "2a2e837a2c8d59ec9af5472ee22d3b04ee463c4e44476ecf993fd1e5ab6ebc7f",
        "binarySha256": "5a8b71e94f4607973145f02e27e01d50b9f7c7bc41e38d40b39606ad138b43b5",
    }:
        raise _error("release CI Syft input is not the reviewed 1.51.0 artifact")
    trivy = _require_keys(tools["trivy"], tool_keys, "release CI Trivy input")
    if trivy != {
        "path": "/usr/local/bin/trivy",
        "version": "0.72.0",
        "platform": "linux/amd64",
        "archiveUrl": (
            "https://github.com/aquasecurity/trivy/releases/download/v0.72.0/"
            "trivy_0.72.0_Linux-64bit.tar.gz"
        ),
        "archiveSha256": "bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea",
        "binarySha256": "0e69edd134a3c338baa1a6806920773615d682b18cbc6a0cba2a3b658ef9b63e",
    }:
        raise _error("release CI Trivy input is not the reviewed 0.72.0 artifact")
    provider_files = _require_keys(
        config["providerFiles"], ("claude", "codex-vendor"), "release CI provider files"
    )
    if provider_files != {
        "claude": "claude-2.1.246",
        "codex-vendor": "codex-vendor-0.149.1",
    }:
        raise _error("release CI provider filenames drifted")
    return config


def _assert_trusted_directory(path: Path, trusted_uid: int, trusted_gid: int = 0) -> None:
    try:
        metadata = path.lstat()
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise _error("a trusted CI input directory or one of its ancestors is unavailable") from exc
    if resolved != path or not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or \
            metadata.st_uid != trusted_uid or metadata.st_gid != trusted_gid or metadata.st_mode & 0o022:
        raise _error("a trusted CI input directory has unsafe ancestry or metadata")


def _assert_provider_ancestry(input_root: Path, trusted_uid: int, trusted_gid: int = 0) -> None:
    if not input_root.is_absolute() or input_root != EXPECTED_PROVIDER_INPUT_ROOT:
        raise _error("the provider input root is not the fixed CI path")
    for ancestor in (Path("/"), Path("/opt"), Path("/opt/teleagent-ci-inputs"), input_root):
        _assert_trusted_directory(ancestor, trusted_uid, trusted_gid)


def _provider_records(manifest_path: Path) -> dict[str, dict[str, Any]]:
    document = _load_json(manifest_path, "provider CLI manifest", 64 * 1024)
    _require_keys(document, ("version", "artifacts"), "provider CLI manifest")
    if document["version"] != 1 or type(document["artifacts"]) is not list:
        raise _error("provider CLI manifest version or artifacts are invalid")
    expected_ids = ("claude", "codex-wrapper", "codex-vendor")
    if len(document["artifacts"]) != len(expected_ids):
        raise _error("provider CLI manifest artifact set is incomplete")
    records: dict[str, dict[str, Any]] = {}
    for record, expected_id in zip(document["artifacts"], expected_ids, strict=True):
        _require_keys(
            record,
            (
                "id", "provider", "path", "source", "sha256", "size", "mode",
                "versionArgs", "versionStdout",
            ),
            "provider CLI artifact",
        )
        if record["id"] != expected_id or record["mode"] != "0755" or \
                not HEX_RE.fullmatch(str(record["sha256"])) or \
                type(record["size"]) is not int or record["size"] < 1:
            raise _error("provider CLI manifest artifact identity is invalid")
        records[expected_id] = record
    return records


def verify_provider_file(
    filename: Path,
    record: Mapping[str, Any],
    *,
    trusted_uid: int = 0,
    trusted_gid: int = 0,
) -> None:
    try:
        metadata = filename.lstat()
        resolved = filename.resolve(strict=True)
    except OSError as exc:
        raise _error(f"provider input {record['id']} is unavailable") from exc
    if resolved != filename or not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or \
            metadata.st_uid != trusted_uid or metadata.st_gid != trusted_gid or metadata.st_nlink != 1 or \
            stat.S_IMODE(metadata.st_mode) != 0o555:
        raise _error(f"provider input {record['id']} has unsafe metadata")
    try:
        if os.listxattr(filename, follow_symlinks=False):
            raise _error(f"provider input {record['id']} has unreviewed extended metadata")
    except OSError as exc:
        raise _error(f"provider input {record['id']} metadata cannot be inspected") from exc
    digest, size = _sha256_file(filename)
    if digest != record["sha256"] or size != record["size"]:
        raise _error(f"provider input {record['id']} differs from the reviewed manifest")


def _copy_exclusive(source: Path, destination: Path, mode: int = 0o555) -> None:
    if destination.exists() or destination.is_symlink():
        raise _error(f"staged destination {destination.name} already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(destination, flags, 0o600)
    try:
        with source.open("rb") as reader, os.fdopen(descriptor, "wb", closefd=False) as writer:
            shutil.copyfileobj(reader, writer, length=1024 * 1024)
            writer.flush()
            os.fsync(writer.fileno())
        os.fchmod(descriptor, mode)
    finally:
        os.close(descriptor)


def stage_provider_artifacts(
    manifest_path: Path,
    staging_root: Path,
    *,
    input_root: Path = EXPECTED_PROVIDER_INPUT_ROOT,
    trusted_uid: int = 0,
    trusted_gid: int = 0,
    require_fixed_ancestry: bool = True,
) -> None:
    records = _provider_records(manifest_path)
    config = load_ci_config()
    if require_fixed_ancestry:
        _assert_provider_ancestry(input_root, trusted_uid, trusted_gid)
    sources = {
        "claude": input_root / config["providerFiles"]["claude"],
        "codex-vendor": input_root / config["providerFiles"]["codex-vendor"],
    }
    destinations = {
        "claude": staging_root / "artifacts/provider-cli/claude",
        "codex-vendor": staging_root / "artifacts/provider-cli/codex-vendor",
    }
    for artifact_id in ("claude", "codex-vendor"):
        verify_provider_file(
            sources[artifact_id],
            records[artifact_id],
            trusted_uid=trusted_uid,
            trusted_gid=trusted_gid,
        )
        _copy_exclusive(sources[artifact_id], destinations[artifact_id])
    wrapper = staging_root / "deploy/worker-session/teleagent-codex-cli-wrapper"
    digest, size = _sha256_file(wrapper)
    if digest != records["codex-wrapper"]["sha256"] or size != records["codex-wrapper"]["size"]:
        raise _error("source-owned Codex wrapper differs from the reviewed provider manifest")


def check_provider_inputs(
    manifest_path: Path,
    *,
    input_root: Path = EXPECTED_PROVIDER_INPUT_ROOT,
    trusted_uid: int = 0,
    trusted_gid: int = 0,
) -> None:
    records = _provider_records(manifest_path)
    config = load_ci_config()
    _assert_provider_ancestry(input_root, trusted_uid, trusted_gid)
    for artifact_id in ("claude", "codex-vendor"):
        verify_provider_file(
            input_root / config["providerFiles"][artifact_id],
            records[artifact_id],
            trusted_uid=trusted_uid,
            trusted_gid=trusted_gid,
        )


def check_tool_inputs() -> None:
    config = load_ci_config()
    for tool_name in ("syft", "trivy"):
        filename = Path(config["tools"][tool_name]["path"])
        if not filename.is_absolute():
            raise _error(f"the fixed {tool_name} path is not absolute")
        for ancestor in reversed(filename.parents):
            _assert_trusted_directory(ancestor, 0, 0)
        try:
            metadata = filename.lstat()
            resolved = filename.resolve(strict=True)
            attributes = os.listxattr(filename, follow_symlinks=False)
        except OSError as exc:
            raise _error(f"the fixed {tool_name} executable is unavailable") from exc
        if resolved != filename or not stat.S_ISREG(metadata.st_mode) or \
                stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_gid != 0 or \
                metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o555 or attributes:
            raise _error(f"the fixed {tool_name} executable has unsafe metadata")
        digest, _size = _sha256_file(filename)
        if digest != config["tools"][tool_name]["binarySha256"]:
            raise _error(f"the fixed {tool_name} executable differs from its reviewed SHA-256")


def prune_native_modules(staging_root: Path) -> None:
    dependency_trees = (
        (API_NODE_MODULES_PATH, API_NATIVE_MODULE_PATHS, "API"),
        (
            PRIVILEGED_BROKER_NODE_MODULES_PATH,
            PRIVILEGED_BROKER_NATIVE_MODULE_PATHS,
            "privileged broker",
        ),
        (
            REALTIME_SIP_NODE_MODULES_PATH,
            REALTIME_SIP_NATIVE_MODULE_PATHS,
            "realtime SIP gateway",
        ),
    )
    for module_relative, expected_relative, label in dependency_trees:
        module_root = staging_root / module_relative
        bin_path = module_root / ".bin"
        if bin_path.is_symlink() or bin_path.is_file():
            bin_path.unlink()
        elif bin_path.is_dir():
            shutil.rmtree(bin_path)
        expected = {staging_root / relative for relative in expected_relative}
        for filename in module_root.rglob("*.node"):
            if filename not in expected:
                filename.unlink()
        for filename in expected:
            if not filename.is_file() or filename.is_symlink():
                raise _error(f"required {label} native module {filename.name} is absent")
        actual = set(module_root.rglob("*.node"))
        if actual != expected:
            raise _error(f"the staged {label} native module set is not exact")


def strip_extended_metadata(root: Path) -> None:
    paths = [root]
    for directory, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        base = Path(directory)
        paths.extend(base / name for name in dirnames)
        paths.extend(base / name for name in filenames)
    for path in paths:
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise _error("a symbolic link entered staging before metadata normalization")
        try:
            attributes = os.listxattr(path, follow_symlinks=False)
            for attribute in attributes:
                os.removexattr(path, attribute, follow_symlinks=False)
            if os.listxattr(path, follow_symlinks=False):
                raise _error("extended metadata remained after normalization")
        except OSError as exc:
            raise _error("extended metadata could not be normalized") from exc


def _contains_forbidden_path(value: Any, forbidden: Sequence[str]) -> bool:
    if isinstance(value, str):
        return any(item and item in value for item in forbidden)
    if isinstance(value, list):
        return any(_contains_forbidden_path(item, forbidden) for item in value)
    if isinstance(value, dict):
        return any(_contains_forbidden_path(item, forbidden) for item in value.values())
    return False


def _sort_cyclonedx(document: dict[str, Any]) -> None:
    for key in ("components", "services", "vulnerabilities"):
        values = document.get(key)
        if isinstance(values, list):
            values.sort(key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")))
    dependencies = document.get("dependencies")
    if isinstance(dependencies, list):
        for dependency in dependencies:
            if isinstance(dependency, dict) and isinstance(dependency.get("dependsOn"), list):
                dependency["dependsOn"].sort()
        dependencies.sort(key=lambda item: str(item.get("ref", "")) if isinstance(item, dict) else "")


def normalize_cyclonedx(
    source: Path,
    destination: Path,
    *,
    forbidden_paths: Sequence[str] = (),
) -> None:
    document = _load_json(source, "generated SBOM")
    if document.get("bomFormat") != "CycloneDX" or document.get("specVersion") != "1.6":
        raise _error("generated SBOM is not CycloneDX JSON 1.6")
    document.pop("serialNumber", None)
    metadata = document.get("metadata")
    if isinstance(metadata, dict):
        metadata.pop("timestamp", None)
    if _contains_forbidden_path(document, forbidden_paths):
        raise _error("generated SBOM embeds an ephemeral staging path")
    _sort_cyclonedx(document)
    contents = canonical_json_bytes(dict(sorted(document.items())))
    if destination.exists() or destination.is_symlink():
        raise _error("normalized SBOM destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(contents)
    destination.chmod(0o444)


def write_voice_manifest(destination: Path, revision: str, config_digest: str) -> None:
    if not REVISION_RE.fullmatch(revision) or not DIGEST_RE.fullmatch(config_digest):
        raise _error("voice manifest revision or config digest is invalid")
    value = {
        "version": 2,
        "sourceRevision": revision,
        "platform": "linux/amd64",
        "configDigest": config_digest,
        "runtimeReference": config_digest,
        "registryReference": None,
        "registryManifestDigest": None,
    }
    if destination.exists() or destination.is_symlink():
        raise _error("voice image manifest destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(canonical_json_bytes(value))
    destination.chmod(0o444)


def write_build_input(destination: Path, revision: str, tree: str) -> None:
    if not REVISION_RE.fullmatch(revision) or not REVISION_RE.fullmatch(tree):
        raise _error("build-input source identity is invalid")
    config = load_ci_config()
    value = {
        "version": 1,
        "source": {
            "repository": "https://github.com/javAlborz/teleagent.git",
            "revision": revision,
            "tree": tree,
        },
        "target": {
            "os": "linux",
            "architecture": "amd64",
            "libc": "glibc",
            "nodeVersion": config["node"]["version"],
            "nodeModulesAbi": config["node"]["modulesAbi"],
        },
        "hostRuntime": {
            "nodePath": "runtime/node/bin/node",
            "interpreterTargets": list(INTERPRETER_TARGETS),
            "apiLockPath": API_LOCK_PATH,
            "nodeModulesPath": API_NODE_MODULES_PATH,
            "nativeModulePaths": list(API_NATIVE_MODULE_PATHS),
            "privilegedBrokerLockPath": PRIVILEGED_BROKER_LOCK_PATH,
            "privilegedBrokerNodeModulesPath": PRIVILEGED_BROKER_NODE_MODULES_PATH,
            "privilegedBrokerNativeModulePaths": list(
                PRIVILEGED_BROKER_NATIVE_MODULE_PATHS
            ),
            "realtimeSipLockPath": REALTIME_SIP_LOCK_PATH,
            "realtimeSipNodeModulesPath": REALTIME_SIP_NODE_MODULES_PATH,
            "realtimeSipNativeModulePaths": list(REALTIME_SIP_NATIVE_MODULE_PATHS),
            "boundSourcePaths": list(BOUND_SOURCE_PATHS),
        },
        "providerCli": {
            "manifestPath": "deploy/worker-session/provider-cli.manifest.json",
            "artifacts": [
                {"id": "claude", "path": "artifacts/provider-cli/claude"},
                {"id": "codex-wrapper", "path": "deploy/worker-session/teleagent-codex-cli-wrapper"},
                {"id": "codex-vendor", "path": "artifacts/provider-cli/codex-vendor"},
            ],
        },
        "voiceImage": {
            "manifestPath": "artifacts/voice/voice-image.manifest.json",
            "archivePath": "artifacts/voice/voice-image.docker.tar",
        },
        "sbom": {
            "format": "cyclonedx-json-1.6",
            "releasePath": "artifacts/sbom/teleagent-release.cdx.json",
            "voiceImagePath": "artifacts/sbom/voice-image.cdx.json",
        },
    }
    if destination.exists() or destination.is_symlink():
        raise _error("release build-input destination already exists")
    destination.write_bytes(canonical_json_bytes(value))
    destination.chmod(0o444)


def _assert_clean_scan(scan_path: Path) -> tuple[str, int]:
    scan = _load_json(scan_path, "Trivy voice-image scan")
    results = scan.get("Results", [])
    if type(results) is not list:
        raise _error("Trivy voice-image scan has an invalid result set")
    findings = 0
    for result in results:
        if type(result) is not dict:
            raise _error("Trivy voice-image scan has an invalid result")
        for key in ("Vulnerabilities", "Secrets"):
            values = result.get(key) or []
            if type(values) is not list:
                raise _error("Trivy voice-image scan finding set is invalid")
            findings += len(values)
    if findings != 0:
        raise _error("Trivy reported a critical/high vulnerability or secret")
    return _sha256_file(scan_path)


def _copy_evidence(source: Path, destination: Path) -> None:
    if destination.exists() or destination.is_symlink():
        raise _error(f"evidence destination {destination.name} already exists")
    shutil.copyfile(source, destination)
    destination.chmod(0o444)


def compare_and_publish(
    first_root: Path,
    first_bundle: Path,
    second_root: Path,
    second_bundle: Path,
    scan_path: Path,
    output: Path,
) -> dict[str, Any]:
    config = load_ci_config()
    first_digest, first_manifest = verify_release(first_root)
    second_digest, second_manifest = verify_release(second_root)
    first_bundle_digest, first_bundle_size = _sha256_file(first_bundle)
    second_bundle_digest, second_bundle_size = _sha256_file(second_bundle)
    if first_digest != second_digest or first_manifest != second_manifest or \
            (first_root / MANIFEST_NAME).read_bytes() != (second_root / MANIFEST_NAME).read_bytes() or \
            (first_root / FILE_LIST_NAME).read_bytes() != (second_root / FILE_LIST_NAME).read_bytes() or \
            first_bundle_digest != second_bundle_digest or first_bundle_size != second_bundle_size:
        raise _error("two fresh release assemblies are not byte-identical")
    scan_digest, scan_size = _assert_clean_scan(scan_path)
    if output.exists() or output.is_symlink():
        raise _error("release evidence output already exists")
    output.mkdir(mode=0o700, parents=True)
    evidence = {
        "teleagent-release.tar": first_bundle,
        MANIFEST_NAME: first_root / MANIFEST_NAME,
        FILE_LIST_NAME: first_root / FILE_LIST_NAME,
        "voice-image.manifest.json": first_root / first_manifest["voiceImage"]["manifestPath"],
        "teleagent-release.cdx.json": first_root / first_manifest["sbom"]["releasePath"],
        "voice-image.cdx.json": first_root / first_manifest["sbom"]["voiceImagePath"],
        "voice-image.trivy.json": scan_path,
    }
    for name, source in evidence.items():
        _copy_evidence(source, output / name)
    summary = {
        "version": 1,
        "application": "teleagent",
        "source": first_manifest["source"],
        "releaseManifestSha256": first_digest,
        "releaseBundleSha256": f"sha256:{first_bundle_digest}",
        "releaseBundleSize": first_bundle_size,
        "voiceImage": first_manifest["voiceImage"],
        "providerCli": first_manifest["providerCli"],
        "sbom": first_manifest["sbom"],
        "buildToolchain": {
            "node": {
                "version": config["node"]["version"],
                "modulesAbi": config["node"]["modulesAbi"],
                "archiveSha256": f"sha256:{config['node']['archiveSha256']}",
                "binarySha256": f"sha256:{config['node']['binarySha256']}",
            },
            "syft": {
                "version": config["tools"]["syft"]["version"],
                "platform": config["tools"]["syft"]["platform"],
                "archiveSha256": f"sha256:{config['tools']['syft']['archiveSha256']}",
                "binarySha256": f"sha256:{config['tools']['syft']['binarySha256']}",
            },
            "trivy": {
                "version": config["tools"]["trivy"]["version"],
                "platform": config["tools"]["trivy"]["platform"],
                "archiveSha256": f"sha256:{config['tools']['trivy']['archiveSha256']}",
                "binarySha256": f"sha256:{config['tools']['trivy']['binarySha256']}",
            },
        },
        "scan": {
            "path": "voice-image.trivy.json",
            "sha256": f"sha256:{scan_digest}",
            "size": scan_size,
            "maximumSeverity": "HIGH",
            "secrets": "zero",
        },
        "determinism": {
            "freshAssemblies": 2,
            "manifest": "byte-identical",
            "inventory": "byte-identical",
            "bundle": "byte-identical",
        },
        "authorization": "non-promotable-build-evidence-only",
        "promotionEligibility": {
            "status": "blocked",
            "reasons": list(PROMOTION_BLOCKERS),
        },
    }
    summary_path = output / "release-summary.json"
    summary_path.write_bytes(canonical_json_bytes(summary))
    summary_path.chmod(0o444)
    checksum_paths = sorted(
        (path for path in output.iterdir() if path.is_file()), key=lambda item: item.name.encode("ascii")
    )
    lines = []
    for path in checksum_paths:
        digest, _size = _sha256_file(path)
        lines.append(f"{digest}  {path.name}\n")
    checksum_file = output / "SHA256SUMS"
    checksum_file.write_text("".join(lines), encoding="ascii")
    checksum_file.chmod(0o444)
    return summary


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("validate-config")
    commands.add_parser("check-tools")

    provider_check = commands.add_parser("check-providers")
    provider_check.add_argument("--manifest", required=True, type=Path)

    provider = commands.add_parser("stage-providers")
    provider.add_argument("--manifest", required=True, type=Path)
    provider.add_argument("--staging-root", required=True, type=Path)

    native = commands.add_parser("prune-native")
    native.add_argument("--staging-root", required=True, type=Path)

    metadata = commands.add_parser("strip-metadata")
    metadata.add_argument("--root", required=True, type=Path)

    sbom = commands.add_parser("normalize-sbom")
    sbom.add_argument("--source", required=True, type=Path)
    sbom.add_argument("--destination", required=True, type=Path)
    sbom.add_argument("--forbid-path", action="append", default=[])

    voice = commands.add_parser("write-voice-manifest")
    voice.add_argument("--destination", required=True, type=Path)
    voice.add_argument("--revision", required=True)
    voice.add_argument("--config-digest", required=True)

    build_input = commands.add_parser("write-build-input")
    build_input.add_argument("--destination", required=True, type=Path)
    build_input.add_argument("--revision", required=True)
    build_input.add_argument("--tree", required=True)

    compare = commands.add_parser("compare")
    compare.add_argument("--first-root", required=True, type=Path)
    compare.add_argument("--first-bundle", required=True, type=Path)
    compare.add_argument("--second-root", required=True, type=Path)
    compare.add_argument("--second-bundle", required=True, type=Path)
    compare.add_argument("--scan", required=True, type=Path)
    compare.add_argument("--output", required=True, type=Path)
    return result


def main(argv: list[str] | None = None) -> int:
    arguments = parser().parse_args(argv)
    try:
        if arguments.command == "validate-config":
            load_ci_config()
        elif arguments.command == "check-tools":
            check_tool_inputs()
        elif arguments.command == "check-providers":
            check_provider_inputs(arguments.manifest)
        elif arguments.command == "stage-providers":
            stage_provider_artifacts(arguments.manifest, arguments.staging_root)
        elif arguments.command == "prune-native":
            prune_native_modules(arguments.staging_root)
        elif arguments.command == "strip-metadata":
            strip_extended_metadata(arguments.root)
        elif arguments.command == "normalize-sbom":
            normalize_cyclonedx(
                arguments.source, arguments.destination, forbidden_paths=arguments.forbid_path
            )
        elif arguments.command == "write-voice-manifest":
            write_voice_manifest(arguments.destination, arguments.revision, arguments.config_digest)
        elif arguments.command == "write-build-input":
            write_build_input(arguments.destination, arguments.revision, arguments.tree)
        elif arguments.command == "compare":
            compare_and_publish(
                arguments.first_root,
                arguments.first_bundle,
                arguments.second_root,
                arguments.second_bundle,
                arguments.scan,
                arguments.output,
            )
        else:  # pragma: no cover - argparse owns the command set.
            raise _error("unsupported command")
    except (CiReleaseError, ClosureError, OSError) as error:
        sys.stderr.write(f"{error}\n")
        return 77
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
