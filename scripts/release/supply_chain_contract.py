#!/usr/bin/env python3
"""Structural, non-authorizing supply-chain evidence contracts.

The accepted documents are deliberately marked as dormant fixtures.  This
module does not verify a signature, an OIDC certificate, transparency-log
inclusion, artifact bytes, or an actual isolated build.  It therefore cannot
make a release promotable.  Its purpose is to make the future byte-level
contracts and their cross-bindings testable before those external trust
boundaries exist.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit


VOICE_TOOLCHAIN_SCHEMA = (
    "urn:teleagent:supply-chain:hermetic-voice-toolchain:v1"
)
EPHEMERAL_ATTESTATION_SCHEMA = (
    "urn:teleagent:supply-chain:trusted-ephemeral-attestation:v1"
)
FIXTURE_AUTHORIZATION = "dormant-fixture-only-no-promotion-authority"

REPOSITORY = "https://github.com/javAlborz/teleagent.git"
REPOSITORY_NAME = "javAlborz/teleagent"
ATTESTATION_WORKFLOW_REF = (
    "javAlborz/teleagent/.github/workflows/"
    "teleagent-trusted-ephemeral-attestation.yml@refs/heads/main"
)
OIDC_ISSUER = "https://token.actions.githubusercontent.com"
OIDC_SUBJECT = "repo:javAlborz/teleagent:ref:refs/heads/main"

ATTESTATION_CHECKS = (
    "independent-source-revision-and-tree-verification",
    "hermetic-material-byte-verification",
    "networkless-voice-image-rebuild",
    "independent-release-bundle-reassembly",
    "subject-digest-comparison",
)

DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
REVISION_RE = re.compile(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")
IDENTIFIER_RE = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
NAME_RE = re.compile(r"^@?[A-Za-z0-9][A-Za-z0-9._/@+-]{0,254}$")
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$")
PATH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/+-]{0,4095}$")
DECIMAL_RE = re.compile(r"^[1-9][0-9]{0,19}$")
TIMESTAMP_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
OCI_SOURCE_RE = re.compile(
    r"^oci://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?"
    r"(?::[1-9][0-9]{0,4})?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$"
)

MATERIAL_KINDS = (
    "builder-image",
    "runtime-image",
    "apk-package",
    "npm-package",
)


class SupplyChainContractError(ValueError):
    """A structural fixture violates the dormant supply-chain contract."""


def _error(message: str) -> SupplyChainContractError:
    return SupplyChainContractError(f"supply-chain contract refused: {message}")


def canonical_json_bytes(value: Mapping[str, Any]) -> bytes:
    """Return Teleagent's canonical one-line JSON representation."""

    return (
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
        + "\n"
    ).encode("ascii")


def sha256_digest(contents: bytes) -> str:
    return f"sha256:{hashlib.sha256(contents).hexdigest()}"


def _pairs_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _error(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise _error(f"non-finite JSON number {value!r} is forbidden")


def _load_canonical(contents: bytes, label: str) -> dict[str, Any]:
    if type(contents) is not bytes or not contents or len(contents) > 32 * 1024 * 1024:
        raise _error(f"{label} has invalid size")
    if b"\x00" in contents or b"\r" in contents:
        raise _error(f"{label} has invalid encoding")
    try:
        document = json.loads(
            contents.decode("ascii"),
            object_pairs_hook=_pairs_without_duplicates,
            parse_constant=_reject_constant,
        )
    except SupplyChainContractError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _error(f"{label} is not canonical ASCII JSON") from exc
    if type(document) is not dict:
        raise _error(f"{label} must be a JSON object")
    if contents != canonical_json_bytes(document):
        raise _error(f"{label} is not canonical one-line JSON")
    return document


def _require_keys(value: Any, keys: Sequence[str], label: str) -> dict[str, Any]:
    if type(value) is not dict or list(value) != list(keys):
        raise _error(f"{label} has an unsupported schema or key order")
    return value


def _require_string(value: Any, label: str, expression: re.Pattern[str] | None = None) -> str:
    if type(value) is not str or not value or len(value) > 4096:
        raise _error(f"{label} must be a non-empty bounded string")
    if expression is not None and not expression.fullmatch(value):
        raise _error(f"{label} has invalid syntax")
    return value


def _require_digest(value: Any, label: str) -> str:
    return _require_string(value, label, DIGEST_RE)


def _require_positive_integer(value: Any, label: str, maximum: int = 2**63 - 1) -> int:
    if type(value) is not int or value < 1 or value > maximum:
        raise _error(f"{label} must be a positive bounded integer")
    return value


def _require_relative_path(value: Any, label: str) -> str:
    path = _require_string(value, label, PATH_RE)
    if path.startswith("/") or path.endswith("/") or "//" in path:
        raise _error(f"{label} is not a canonical relative path")
    parts = path.split("/")
    if any(part in ("", ".", "..") or len(part.encode("ascii")) > 255 for part in parts):
        raise _error(f"{label} has an unsafe component")
    if PurePosixPath(path).as_posix() != path:
        raise _error(f"{label} is not normalized")
    return path


def _require_source_uri(value: Any, label: str, *, oci: bool) -> str:
    source = _require_string(value, label)
    if oci:
        if not OCI_SOURCE_RE.fullmatch(source):
            raise _error(f"{label} must be a digest-addressed OCI reference")
        return source
    if any(character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~:/@+-" for character in source):
        raise _error(f"{label} contains a non-canonical URL character")
    parsed = urlsplit(source)
    try:
        parsed_port = parsed.port
    except ValueError as exc:
        raise _error(f"{label} has an invalid port") from exc
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.hostname != parsed.hostname.lower()
        or parsed.username is not None
        or parsed.password is not None
        or parsed_port is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith("/")
        or parsed.path.endswith("/")
        or "//" in parsed.path
    ):
        raise _error(f"{label} must be one canonical HTTPS artifact URL")
    return source


def _validate_source(value: Any, label: str) -> dict[str, Any]:
    source = _require_keys(value, ("repository", "revision", "tree"), label)
    if source["repository"] != REPOSITORY:
        raise _error(f"{label} repository is not the reviewed Teleagent repository")
    _require_string(source["revision"], f"{label} revision", REVISION_RE)
    _require_string(source["tree"], f"{label} tree", REVISION_RE)
    return source


def _validate_file_identity(value: Any, label: str, expected_path: str) -> None:
    identity = _require_keys(value, ("path", "sha256", "size"), label)
    path = _require_relative_path(identity["path"], f"{label} path")
    if path != expected_path:
        raise _error(f"{label} path is not {expected_path}")
    _require_digest(identity["sha256"], f"{label} digest")
    _require_positive_integer(identity["size"], f"{label} size")


def voice_materials_digest(materials: Sequence[Mapping[str, Any]]) -> str:
    return sha256_digest(canonical_json_bytes({"materials": list(materials)}))


def validate_voice_toolchain_contract(contents: bytes) -> dict[str, Any]:
    """Validate a canonical, structurally hermetic voice-toolchain fixture."""

    document = _load_canonical(contents, "voice toolchain fixture")
    _require_keys(
        document,
        (
            "schema", "version", "authorization", "source", "target",
            "execution", "recipe", "materials", "closure",
        ),
        "voice toolchain fixture",
    )
    if (
        document["schema"] != VOICE_TOOLCHAIN_SCHEMA
        or type(document["version"]) is not int
        or document["version"] != 1
        or document["authorization"] != FIXTURE_AUTHORIZATION
    ):
        raise _error("voice toolchain fixture identity or authorization is invalid")
    _validate_source(document["source"], "voice toolchain source")

    target = _require_keys(document["target"], ("os", "architecture"), "voice target")
    if target != {"os": "linux", "architecture": "amd64"}:
        raise _error("voice target is not the reviewed linux/amd64 platform")

    execution = _require_keys(
        document["execution"],
        (
            "network", "inputFilesystem", "outputFilesystem", "environment",
            "sourceDateEpoch",
        ),
        "voice toolchain execution",
    )
    expected_execution = {
        "network": "none",
        "inputFilesystem": "read-only",
        "outputFilesystem": "empty",
        "environment": "empty-except-source-date-epoch",
    }
    for key, expected in expected_execution.items():
        if execution[key] != expected:
            raise _error(f"voice toolchain execution {key} is not {expected!r}")
    _require_positive_integer(
        execution["sourceDateEpoch"], "voice source-date epoch", 4_102_444_800
    )

    recipe = _require_keys(document["recipe"], ("dockerfile", "packageLock"), "voice recipe")
    _validate_file_identity(recipe["dockerfile"], "voice Dockerfile", "voice-app/Dockerfile")
    _validate_file_identity(
        recipe["packageLock"], "voice package lock", "voice-app/package-lock.json"
    )

    materials = document["materials"]
    if type(materials) is not list or not 4 <= len(materials) <= 100_000:
        raise _error("voice material closure has an invalid count")
    seen_ids: set[str] = set()
    seen_paths: set[str] = set()
    kind_counts = {kind: 0 for kind in MATERIAL_KINDS}
    previous_id: str | None = None
    for index, item in enumerate(materials):
        material = _require_keys(
            item,
            ("id", "kind", "name", "version", "path", "source", "sha256", "size"),
            f"voice material {index}",
        )
        material_id = _require_string(material["id"], f"voice material {index} id", IDENTIFIER_RE)
        if material_id in seen_ids:
            raise _error("voice material IDs are not unique")
        if previous_id is not None and material_id <= previous_id:
            raise _error("voice materials are not strictly ID-sorted")
        seen_ids.add(material_id)
        previous_id = material_id
        kind = material["kind"]
        if kind not in MATERIAL_KINDS:
            raise _error(f"voice material {material_id} has an unsupported kind")
        kind_counts[kind] += 1
        _require_string(material["name"], f"voice material {material_id} name", NAME_RE)
        version = _require_string(
            material["version"], f"voice material {material_id} version", VERSION_RE
        )
        if version.lower() == "latest":
            raise _error(f"voice material {material_id} uses a mutable version")
        path = _require_relative_path(material["path"], f"voice material {material_id} path")
        if not path.startswith("inputs/") or path in seen_paths:
            raise _error("voice material paths are not unique under inputs/")
        seen_paths.add(path)
        _require_source_uri(
            material["source"],
            f"voice material {material_id} source",
            oci=kind in ("builder-image", "runtime-image"),
        )
        _require_digest(material["sha256"], f"voice material {material_id} digest")
        _require_positive_integer(material["size"], f"voice material {material_id} size")

    if kind_counts["builder-image"] != 1 or kind_counts["runtime-image"] != 1:
        raise _error("voice closure requires exactly one builder and one runtime image")
    if kind_counts["apk-package"] < 1 or kind_counts["npm-package"] < 1:
        raise _error("voice closure omits apk or npm package material bytes")

    closure = _require_keys(
        document["closure"],
        (
            "algorithm", "materialCount", "apkPackageCount", "npmPackageCount",
            "materialsSha256",
        ),
        "voice material closure",
    )
    if closure["algorithm"] != "sha256-canonical-json":
        raise _error("voice material closure algorithm is unsupported")
    expected_counts = {
        "materialCount": len(materials),
        "apkPackageCount": kind_counts["apk-package"],
        "npmPackageCount": kind_counts["npm-package"],
    }
    for key, expected in expected_counts.items():
        if type(closure[key]) is not int or closure[key] != expected:
            raise _error(f"voice material closure {key} does not match the material set")
    if closure["materialsSha256"] != voice_materials_digest(materials):
        raise _error("voice material closure digest does not match the material set")
    return document


def _parse_timestamp(value: Any, label: str) -> dt.datetime:
    timestamp = _require_string(value, label, TIMESTAMP_RE)
    try:
        return dt.datetime.strptime(timestamp, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=dt.timezone.utc
        )
    except ValueError as exc:
        raise _error(f"{label} is not a real UTC timestamp") from exc


def validate_ephemeral_attestation_contract(
    contents: bytes,
    *,
    voice_toolchain_contents: bytes,
) -> dict[str, Any]:
    """Validate and cross-bind a structural trusted-ephemeral fixture.

    The caller must separately verify the referenced Sigstore bundle and every
    material byte.  This function intentionally accepts only a non-promotable
    fixture authorization marker.
    """

    toolchain = validate_voice_toolchain_contract(voice_toolchain_contents)
    document = _load_canonical(contents, "ephemeral attestation fixture")
    _require_keys(
        document,
        (
            "schema", "version", "authorization", "subject", "source", "identity",
            "provenance", "verification",
        ),
        "ephemeral attestation fixture",
    )
    if (
        document["schema"] != EPHEMERAL_ATTESTATION_SCHEMA
        or type(document["version"]) is not int
        or document["version"] != 1
        or document["authorization"] != FIXTURE_AUTHORIZATION
    ):
        raise _error("ephemeral attestation fixture identity or authorization is invalid")

    subject = _require_keys(
        document["subject"],
        (
            "releaseManifestSha256", "releaseBundleSha256", "voiceImageConfigDigest",
            "voiceToolchainContractSha256",
        ),
        "attestation subject",
    )
    for key in (
        "releaseManifestSha256", "releaseBundleSha256", "voiceImageConfigDigest",
        "voiceToolchainContractSha256",
    ):
        _require_digest(subject[key], f"attestation subject {key}")
    if subject["voiceToolchainContractSha256"] != sha256_digest(voice_toolchain_contents):
        raise _error("attestation does not bind the exact voice toolchain contract bytes")

    source = _validate_source(document["source"], "attestation source")
    if source != toolchain["source"]:
        raise _error("attestation source does not match the voice toolchain source")

    identity = _require_keys(
        document["identity"],
        (
            "issuer", "subject", "audience", "repository", "repositoryId",
            "workflowRef", "workflowSha", "eventName", "ref", "runId", "runAttempt",
            "jobName", "runnerEnvironment", "runnerLifecycle",
        ),
        "attestation identity",
    )
    expected_identity = {
        "issuer": OIDC_ISSUER,
        "subject": OIDC_SUBJECT,
        "audience": "sigstore",
        "repository": REPOSITORY_NAME,
        "workflowRef": ATTESTATION_WORKFLOW_REF,
        "workflowSha": source["revision"],
        "eventName": "workflow_dispatch",
        "ref": "refs/heads/main",
        "jobName": "attest-release",
        "runnerEnvironment": "github-hosted",
        "runnerLifecycle": "single-job-ephemeral",
    }
    for key, expected in expected_identity.items():
        if identity[key] != expected:
            raise _error(f"attestation identity {key} is not the reviewed value")
    _require_string(identity["repositoryId"], "attestation repository ID", DECIMAL_RE)
    _require_string(identity["runId"], "attestation run ID", DECIMAL_RE)
    _require_positive_integer(identity["runAttempt"], "attestation run attempt", 1_000_000)

    provenance = _require_keys(
        document["provenance"],
        (
            "method", "candidateTrust", "sourceAcquisition", "materialAcquisition",
            "networkDuringRebuild", "checks", "startedAt", "finishedAt",
        ),
        "attestation provenance",
    )
    expected_provenance = {
        "method": "independent-networkless-rebuild-and-compare",
        "candidateTrust": "untrusted-input-only",
        "sourceAcquisition": "independent-by-revision",
        "materialAcquisition": "digest-verified-before-network-disable",
        "networkDuringRebuild": "none",
    }
    for key, expected in expected_provenance.items():
        if provenance[key] != expected:
            raise _error(f"attestation provenance {key} is not {expected!r}")
    if provenance["checks"] != list(ATTESTATION_CHECKS):
        raise _error("attestation provenance checks are incomplete or reordered")
    started = _parse_timestamp(provenance["startedAt"], "attestation start time")
    finished = _parse_timestamp(provenance["finishedAt"], "attestation finish time")
    if finished <= started:
        raise _error("attestation finish time is not after its start time")

    verification = _require_keys(
        document["verification"],
        (
            "bundleFormat", "statementType", "predicateType", "bundlePath",
            "bundleSha256", "bundleSize", "certificateIssuer", "certificateSubject",
            "transparencyLog",
        ),
        "attestation verification",
    )
    expected_verification = {
        "bundleFormat": "application/vnd.dev.sigstore.bundle.v0.3+json",
        "statementType": "https://in-toto.io/Statement/v1",
        "predicateType": "https://slsa.dev/provenance/v1",
        "certificateIssuer": identity["issuer"],
        "certificateSubject": identity["subject"],
        "transparencyLog": "https://rekor.sigstore.dev",
    }
    for key, expected in expected_verification.items():
        if verification[key] != expected:
            raise _error(f"attestation verification {key} is not the reviewed value")
    bundle_path = _require_relative_path(
        verification["bundlePath"], "attestation signature bundle path"
    )
    if not bundle_path.startswith("attestations/") or not bundle_path.endswith(
        ".sigstore.json"
    ):
        raise _error("attestation signature bundle path is outside its fixed namespace")
    _require_digest(verification["bundleSha256"], "attestation signature bundle digest")
    _require_positive_integer(
        verification["bundleSize"], "attestation signature bundle size", 128 * 1024 * 1024
    )
    return document


def _read_fixture(path: Path, label: str) -> bytes:
    try:
        contents = path.read_bytes()
    except OSError as exc:
        raise _error(f"{label} is absent or unreadable") from exc
    return contents


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    voice = commands.add_parser("validate-voice-toolchain-fixture")
    voice.add_argument("--document", required=True, type=Path)
    attestation = commands.add_parser("validate-ephemeral-attestation-fixture")
    attestation.add_argument("--document", required=True, type=Path)
    attestation.add_argument("--voice-toolchain", required=True, type=Path)
    return result


def main(argv: list[str] | None = None) -> int:
    arguments = parser().parse_args(argv)
    try:
        if arguments.command == "validate-voice-toolchain-fixture":
            validate_voice_toolchain_contract(
                _read_fixture(arguments.document, "voice toolchain fixture")
            )
        elif arguments.command == "validate-ephemeral-attestation-fixture":
            validate_ephemeral_attestation_contract(
                _read_fixture(arguments.document, "ephemeral attestation fixture"),
                voice_toolchain_contents=_read_fixture(
                    arguments.voice_toolchain, "voice toolchain fixture"
                ),
            )
        else:  # pragma: no cover - argparse owns the command set.
            raise _error("unsupported command")
    except SupplyChainContractError as exc:
        sys.stderr.write(f"{exc}\n")
        return 77
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
