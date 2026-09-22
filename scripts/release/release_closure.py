#!/usr/bin/env python3
"""Build-side Teleagent immutable release-closure primitives.

This module is deliberately non-authoritative.  It creates and checks the
same byte-level contract that a separately managed host verifier must enforce
before it executes release code.  It never installs a release, imports an
image, reads credentials, or activates a service.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tarfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Sequence


MANIFEST_NAME = "teleagent-release.manifest.json"
FILE_LIST_NAME = "teleagent-release.files.tsv"
FORMAT_VERSION = 2
BUILD_INPUT_VERSION = 1
MAX_MANIFEST_BYTES = 128 * 1024
MAX_FILE_LIST_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 1_000_000

HEX_RE = re.compile(r"^[a-f0-9]{64}$")
REVISION_RE = re.compile(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")
DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
PATH_RE = re.compile(r"^[A-Za-z0-9._+@/-]+$")
NODE_VERSION_RE = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+$")
ABI_RE = re.compile(r"^[1-9][0-9]{0,5}$")
PLATFORM_RE = re.compile(r"^linux/(?:amd64|arm64)$")
REGISTRY_REFERENCE_RE = re.compile(
    r"^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?"
    r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$"
)

INTERPRETER_TARGETS = (
    "/opt/teleagent/node/bin/node",
    "/usr/local/libexec/teleagent-node",
)

# This byte-sorted tuple is the production host source closure.  It contains
# every host-executed entrypoint and transitive local import, every source asset
# installed as service policy or fixed libexec, and every host file bind-mounted
# into the voice containers.  Package manifests are included where Node uses
# them as package-scope/runtime metadata.  Package-lock and production
# node_modules trees have their own independent bindings below.
BOUND_SOURCE_PATHS = (
    "claude-api-server/agent-cli.js",
    "claude-api-server/agent-profiles.js",
    "claude-api-server/agent-worker-launcher.js",
    "claude-api-server/controller-listener.js",
    "claude-api-server/controller-state-configuration.js",
    "claude-api-server/executor-task-dispatcher.js",
    "claude-api-server/executor-task-store.js",
    "claude-api-server/operator-inspector.js",
    "claude-api-server/package.json",
    "claude-api-server/pbx-panic-listener.js",
    "claude-api-server/privileged-action-proxy.js",
    "claude-api-server/provider-egress-broker.js",
    "claude-api-server/provider-egress-shim.js",
    "claude-api-server/provider-supervisor-client.js",
    "claude-api-server/provider-supervisor-service.js",
    "claude-api-server/server.js",
    "claude-api-server/structured.js",
    "claude-api-server/tmux-agent-controller.js",
    "claude-api-server/voice-approval-verifier.js",
    "claude-api-server/voice-panic-coordinator.js",
    "claude-api-server/worker-session-attested-inspector.js",
    "claude-api-server/worker-session-broker-service.js",
    "claude-api-server/worker-session-broker.js",
    "claude-api-server/worker-session-operation-store.js",
    "claude-api-server/worker-session-pane-manager.js",
    "claude-api-server/worker-session-proxy.js",
    "claude-api-server/worker-state-storage-boundary.js",
    "deploy/controller/control-plane-install.manifest",
    "deploy/controller/teleagent-agent-controller.service",
    "deploy/controller/teleagent-agent-controller.socket",
    "deploy/controller/teleagent-agent-controller.tmpfiles",
    "deploy/controller/teleagent-control-plane-install",
    "deploy/controller/teleagent-pbx-panic.socket",
    "deploy/controller/verify-teleagent-control-plane",
    "deploy/host/teleagent-disabled-host-install",
    "deploy/privileged-action/teleagent-privileged-action.service",
    "deploy/privileged-action/teleagent-privileged-action.sysusers",
    "deploy/privileged-action/teleagent-privileged-action.tmpfiles",
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
    "deploy/worker-session/provider-cli.manifest.json",
    "deploy/worker-session/provider-libexec.manifest",
    "deploy/worker-session/provider-runtime-empty-mcp.json",
    "deploy/worker-session/provider-runtime-empty-settings.json",
    "deploy/worker-session/teleagent-codex-cli-wrapper",
    "deploy/worker-session/teleagent-provider-apparmor-install",
    "deploy/worker-session/teleagent-provider-boundary",
    "deploy/worker-session/teleagent-provider-boundary-runtime",
    "deploy/worker-session/teleagent-provider-canary",
    "deploy/worker-session/teleagent-provider-cli-check",
    "deploy/worker-session/teleagent-provider-cli-install",
    "deploy/worker-session/teleagent-provider-egress-control@.socket",
    "deploy/worker-session/teleagent-provider-egress-credential-check",
    "deploy/worker-session/teleagent-provider-egress@.service",
    "deploy/worker-session/teleagent-provider-egress@.socket",
    "deploy/worker-session/teleagent-provider-libexec-install",
    "deploy/worker-session/teleagent-provider-libexec-install.service",
    "deploy/worker-session/teleagent-provider-model-apparmor.service",
    "deploy/worker-session/teleagent-provider-model.apparmor",
    "deploy/worker-session/teleagent-provider-model.slice",
    "deploy/worker-session/teleagent-provider-runtime",
    "deploy/worker-session/teleagent-provider-supervisor-client",
    "deploy/worker-session/teleagent-provider-supervisor@.service",
    "deploy/worker-session/teleagent-provider-supervisor@.socket",
    "deploy/worker-session/teleagent-provider-supervisors.sudoers",
    "deploy/worker-session/teleagent-provider.slice",
    "deploy/worker-session/teleagent-resource-admission",
    "deploy/worker-session/teleagent-resource-topology-watch",
    "deploy/worker-session/teleagent-session-pane-entry",
    "deploy/worker-session/teleagent-worker-session-create",
    "deploy/worker-session/teleagent-worker-session-install",
    "deploy/worker-session/teleagent-worker-session.service",
    "deploy/worker-session/teleagent-worker-session.socket",
    "deploy/worker-session/teleagent-worker-session.sysusers",
    "deploy/worker-session/teleagent-worker-session.tmpfiles",
    "deploy/worker-session/verify-worker-session-boundary",
    "deploy/worker-session/verify-worker-session-identity",
    "docker-compose.yml",
    "freeswitch/entrypoint.sh",
    "freeswitch/mrf.xml",
    "freeswitch/switch.conf.xml",
    "lib/agent-execution-environment.js",
    "lib/durable-state-storage-boundary.js",
    "lib/phone-deploy-intent.js",
    "lib/privileged-action-plan.js",
    "lib/provider-model-contract.js",
    "lib/provider-secret.js",
    "lib/safe-agent-logging.js",
    "lib/sip-media-boundary-contract.js",
    "lib/target-session-message.js",
    "lib/voice-app-runtime-env.js",
    "lib/voice-approval-capability.js",
    "lib/voice-authorization-plan.js",
    "lib/voice-execution-control.js",
    "lib/voice-operation-risk.js",
    "lib/worker-inspection-contract.js",
    "package.json",
    "privileged-action-broker/broker.js",
    "privileged-action-broker/control.js",
    "privileged-action-broker/executor.js",
    "privileged-action-broker/index.js",
    "privileged-action-broker/package.json",
    "privileged-action-broker/policy.js",
    "privileged-action-broker/server.js",
    "privileged-action-broker/state-configuration.js",
    "privileged-action-broker/store.js",
    "privileged-action-broker/verifier.js",
    "realtime-sip-gateway/deploy/realtime-sip-gateway-install.manifest",
    "realtime-sip-gateway/deploy/teleagent-realtime-sip-gateway-install",
    "realtime-sip-gateway/deploy/teleagent-realtime-sip-gateway.service",
    "realtime-sip-gateway/deploy/teleagent-realtime-sip-gateway.sysusers",
    "realtime-sip-gateway/deploy/teleagent-realtime-sip-gateway.tmpfiles",
    "realtime-sip-gateway/deploy/verify-realtime-sip-gateway",
    "realtime-sip-gateway/package.json",
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
)

API_LOCK_PATH = "claude-api-server/package-lock.json"
API_NODE_MODULES_PATH = "claude-api-server/node_modules"
API_NATIVE_MODULE_PATHS = (
    "claude-api-server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    "claude-api-server/node_modules/node-pty/build/Release/pty.node",
)
PRIVILEGED_BROKER_LOCK_PATH = "privileged-action-broker/package-lock.json"
PRIVILEGED_BROKER_NODE_MODULES_PATH = "privileged-action-broker/node_modules"
PRIVILEGED_BROKER_NATIVE_MODULE_PATHS = (
    "privileged-action-broker/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
)
REALTIME_SIP_LOCK_PATH = "realtime-sip-gateway/package-lock.json"
REALTIME_SIP_NODE_MODULES_PATH = "realtime-sip-gateway/node_modules"
REALTIME_SIP_NATIVE_MODULE_PATHS = (
    "realtime-sip-gateway/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
)

PROVIDER_ARTIFACT_IDS = ("claude", "codex-wrapper", "codex-vendor")
PROVIDER_DESTINATIONS = {
    "claude": "/opt/teleagent/agent-tools/claude",
    "codex-wrapper": "/opt/teleagent/agent-tools/codex",
    "codex-vendor": "/opt/teleagent/agent-tools/codex-vendor",
}
PROVIDER_NAMES = {
    "claude": "claude",
    "codex-wrapper": "codex",
    "codex-vendor": "codex",
}
PROVIDER_SOURCES = {
    "claude": None,
    "codex-wrapper": "/usr/local/libexec/teleagent-provider-codex-cli-wrapper",
    "codex-vendor": None,
}


class ClosureError(ValueError):
    """A release closure is malformed, incomplete, or internally inconsistent."""


@dataclass(frozen=True, order=True)
class Entry:
    """One normalized release-tree inventory entry."""

    path: str
    kind: str
    mode: int
    size: int | None
    digest: str | None

    def to_tsv(self) -> str:
        if self.kind == "D":
            return f"D\t{self.mode:04o}\t-\t-\t{self.path}\n"
        return f"F\t{self.mode:04o}\t{self.size}\t{self.digest}\t{self.path}\n"


def _error(message: str) -> ClosureError:
    return ClosureError(f"release closure refused: {message}")


def _sha256_bytes(contents: bytes) -> str:
    return hashlib.sha256(contents).hexdigest()


def _prefixed(digest: str) -> str:
    return f"sha256:{digest}"


def canonical_json_bytes(value: Mapping[str, Any]) -> bytes:
    return (
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
        + "\n"
    ).encode("ascii")


def _pairs_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _error("a JSON object contains a duplicate key")
        result[key] = value
    return result


def parse_json_bytes(
    contents: bytes,
    *,
    label: str,
    canonical: bool,
    maximum: int = MAX_MANIFEST_BYTES,
) -> dict[str, Any]:
    if not contents or len(contents) > maximum or b"\x00" in contents or b"\r" in contents:
        raise _error(f"{label} has invalid size or encoding")
    try:
        text = contents.decode("ascii")
    except UnicodeDecodeError as exc:
        raise _error(f"{label} is not canonical ASCII JSON") from exc
    try:
        value = json.loads(
            text,
            object_pairs_hook=_pairs_without_duplicates,
            parse_constant=lambda _value: (_ for _ in ()).throw(
                _error(f"{label} contains a non-finite number")
            ),
        )
    except ClosureError:
        raise
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise _error(f"{label} is not valid JSON") from exc
    if type(value) is not dict:
        raise _error(f"{label} must be a JSON object")
    if canonical and contents != canonical_json_bytes(value):
        raise _error(f"{label} is not canonical one-line JSON")
    return value


def read_json_file(
    filename: Path,
    *,
    label: str,
    canonical: bool,
    maximum: int = MAX_MANIFEST_BYTES,
) -> dict[str, Any]:
    try:
        contents = filename.read_bytes()
    except OSError as exc:
        raise _error(f"{label} is absent or unreadable") from exc
    return parse_json_bytes(contents, label=label, canonical=canonical, maximum=maximum)


def _require_keys(value: Any, keys: Sequence[str], label: str) -> dict[str, Any]:
    if type(value) is not dict or list(value) != list(keys):
        raise _error(f"{label} has an unsupported object schema")
    return value


def _require_array(value: Any, label: str) -> list[Any]:
    if type(value) is not list:
        raise _error(f"{label} must be an array")
    return value


def _require_string(value: Any, label: str, expression: re.Pattern[str] | None = None) -> str:
    if type(value) is not str or (expression is not None and not expression.fullmatch(value)):
        raise _error(f"{label} is invalid")
    return value


def _require_int(value: Any, label: str, *, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum or value > (2**53 - 1):
        raise _error(f"{label} is outside the supported integer range")
    return value


def validate_relative_path(value: Any, label: str) -> str:
    path = _require_string(value, label)
    if (
        len(path) > 4096
        or not PATH_RE.fullmatch(path)
        or path.startswith("/")
        or path.endswith("/")
        or "//" in path
    ):
        raise _error(f"{label} is not a canonical relative path")
    parts = path.split("/")
    if any(part in ("", ".", "..") or len(part.encode("ascii")) > 255 for part in parts):
        raise _error(f"{label} contains an unsafe component")
    normalized = PurePosixPath(path).as_posix()
    if normalized != path:
        raise _error(f"{label} is not normalized")
    return path


def _safe_lstat(path: Path, label: str) -> os.stat_result:
    try:
        return path.lstat()
    except OSError as exc:
        raise _error(f"{label} is absent or unreadable") from exc


def _assert_no_xattrs(path: Path, label: str) -> None:
    try:
        attributes = os.listxattr(path, follow_symlinks=False)
    except OSError as exc:
        raise _error(f"extended attributes for {label} cannot be inspected") from exc
    if attributes:
        raise _error(f"{label} has unreviewed extended attributes")


def _assert_owner(metadata: os.stat_result, uid: int, gid: int, label: str) -> None:
    if metadata.st_uid != uid or metadata.st_gid != gid:
        raise _error(f"{label} has mixed or unexpected ownership")


def hash_regular_file(path: Path) -> tuple[str, int]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor: int | None = None
    try:
        descriptor = os.open(path, flags)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise _error("a release file changed type or link count while being hashed")
        digest = hashlib.sha256()
        size = 0
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            digest.update(block)
            size += len(block)
        after = os.fstat(descriptor)
    except ClosureError:
        raise
    except OSError as exc:
        raise _error("a release file could not be hashed safely") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
    snapshot_fields = (
        "st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink",
        "st_size", "st_mtime_ns", "st_ctime_ns",
    )
    if any(getattr(before, field) != getattr(after, field) for field in snapshot_fields):
        raise _error("a release file changed while being hashed")
    if size != before.st_size:
        raise _error("a release file size changed while being hashed")
    return digest.hexdigest(), size


def _scan_tree(
    root: Path,
    *,
    expected_uid: int,
    expected_gid: int,
    normalize_modes: bool,
    require_root_mode: bool,
) -> list[Entry]:
    root_metadata = _safe_lstat(root, "release root")
    if not stat.S_ISDIR(root_metadata.st_mode) or stat.S_ISLNK(root_metadata.st_mode):
        raise _error("the release root is not a real directory")
    _assert_owner(root_metadata, expected_uid, expected_gid, "release root")
    _assert_no_xattrs(root, "release root")
    if require_root_mode and stat.S_IMODE(root_metadata.st_mode) != 0o555:
        raise _error("the release root mode is not exactly 0555")

    entries: list[Entry] = []
    directories: list[Path] = []

    def visit(directory: Path, prefix: str) -> None:
        try:
            children = sorted(os.scandir(directory), key=lambda item: item.name.encode("ascii"))
        except (OSError, UnicodeEncodeError) as exc:
            raise _error("a release directory cannot be enumerated canonically") from exc
        for child in children:
            relative = child.name if not prefix else f"{prefix}/{child.name}"
            validate_relative_path(relative, "release entry path")
            if not prefix and child.name in (MANIFEST_NAME, FILE_LIST_NAME):
                continue
            path = Path(child.path)
            metadata = _safe_lstat(path, f"release entry {relative}")
            _assert_owner(metadata, expected_uid, expected_gid, f"release entry {relative}")
            _assert_no_xattrs(path, f"release entry {relative}")
            if stat.S_ISLNK(metadata.st_mode):
                raise _error(f"release entry {relative} is a forbidden symbolic link")
            if stat.S_ISDIR(metadata.st_mode):
                visit(path, relative)
                if normalize_modes:
                    os.chmod(path, 0o555, follow_symlinks=False)
                    metadata = _safe_lstat(path, f"release directory {relative}")
                if stat.S_IMODE(metadata.st_mode) != 0o555:
                    raise _error(f"release directory {relative} mode is not exactly 0555")
                directories.append(path)
                entries.append(Entry(relative, "D", 0o555, None, None))
                continue
            if not stat.S_ISREG(metadata.st_mode):
                raise _error(f"release entry {relative} has a forbidden special type")
            if metadata.st_nlink != 1:
                raise _error(f"release file {relative} is hard-linked")
            if normalize_modes:
                normalized_mode = 0o555 if stat.S_IMODE(metadata.st_mode) & 0o111 else 0o444
                os.chmod(path, normalized_mode, follow_symlinks=False)
                metadata = _safe_lstat(path, f"release file {relative}")
            mode = stat.S_IMODE(metadata.st_mode)
            if mode not in (0o444, 0o555):
                raise _error(f"release file {relative} mode is not exactly 0444 or 0555")
            digest, size = hash_regular_file(path)
            entries.append(Entry(relative, "F", mode, size, digest))

    visit(root, "")
    entries.sort(key=lambda entry: entry.path.encode("ascii"))
    if len(entries) > MAX_ENTRIES:
        raise _error("the release inventory is unreasonably large")
    return entries


def serialize_file_list(entries: Sequence[Entry]) -> bytes:
    ordered = sorted(entries, key=lambda entry: entry.path.encode("ascii"))
    if list(entries) != ordered or len({entry.path for entry in entries}) != len(entries):
        raise _error("the release inventory is not sorted and unique")
    return "".join(entry.to_tsv() for entry in entries).encode("ascii")


def parse_file_list(contents: bytes) -> list[Entry]:
    if (
        not contents
        or len(contents) > MAX_FILE_LIST_BYTES
        or not contents.endswith(b"\n")
        or b"\r" in contents
        or b"\x00" in contents
    ):
        raise _error("the release file list has invalid size or encoding")
    try:
        text = contents.decode("ascii")
    except UnicodeDecodeError as exc:
        raise _error("the release file list is not ASCII") from exc
    entries: list[Entry] = []
    previous: bytes | None = None
    seen: set[str] = set()
    for line in text[:-1].split("\n"):
        fields = line.split("\t")
        if len(fields) != 5:
            raise _error("the release file list contains a malformed record")
        kind, mode_text, size_text, digest_text, relative = fields
        validate_relative_path(relative, "file-list path")
        encoded = relative.encode("ascii")
        if previous is not None and encoded <= previous:
            raise _error("the release file list is not strictly path-sorted")
        if relative in seen:
            raise _error("the release file list contains a duplicate path")
        previous = encoded
        seen.add(relative)
        if kind == "D":
            if mode_text != "0555" or size_text != "-" or digest_text != "-":
                raise _error("a directory record is not canonical")
            entries.append(Entry(relative, kind, 0o555, None, None))
        elif kind == "F":
            if mode_text not in ("0444", "0555"):
                raise _error("a file record has an unsupported mode")
            if not re.fullmatch(r"(?:0|[1-9][0-9]{0,15})", size_text):
                raise _error("a file record has an invalid size")
            size = int(size_text)
            if size > 2**53 - 1 or not HEX_RE.fullmatch(digest_text):
                raise _error("a file record has an invalid size or digest")
            entries.append(Entry(relative, kind, int(mode_text, 8), size, digest_text))
        else:
            raise _error("a file-list record has an unsupported type")
    if not entries or len(entries) > MAX_ENTRIES:
        raise _error("the release file list has an unsupported entry count")
    if serialize_file_list(entries) != contents:
        raise _error("the release file list is not canonical")
    return entries


def _entry_map(entries: Iterable[Entry]) -> dict[str, Entry]:
    return {entry.path: entry for entry in entries}


def _required_file(entries: Mapping[str, Entry], relative: Any, label: str) -> Entry:
    path = validate_relative_path(relative, label)
    entry = entries.get(path)
    if entry is None or entry.kind != "F" or entry.digest is None or entry.size is None:
        raise _error(f"{label} does not name one regular release file")
    return entry


def _read_release_json(
    root: Path,
    entries: Mapping[str, Entry],
    relative: Any,
    *,
    label: str,
    canonical: bool,
) -> tuple[dict[str, Any], Entry]:
    entry = _required_file(entries, relative, label)
    document = read_json_file(root / entry.path, label=label, canonical=canonical)
    return document, entry


def validate_build_input(value: Any) -> dict[str, Any]:
    config = _require_keys(
        value,
        ("version", "source", "target", "hostRuntime", "providerCli", "voiceImage", "sbom"),
        "release build input",
    )
    if config["version"] != BUILD_INPUT_VERSION:
        raise _error("the release build-input version is unsupported")

    source = _require_keys(config["source"], ("repository", "revision", "tree"), "source input")
    _require_string(source["repository"], "source repository")
    _require_string(source["revision"], "source revision", REVISION_RE)
    _require_string(source["tree"], "source tree", REVISION_RE)

    target = _require_keys(
        config["target"],
        ("os", "architecture", "libc", "nodeVersion", "nodeModulesAbi"),
        "target input",
    )
    if target["os"] != "linux" or target["architecture"] not in ("amd64", "arm64") or target["libc"] != "glibc":
        raise _error("the release target is unsupported")
    _require_string(target["nodeVersion"], "Node version", NODE_VERSION_RE)
    _require_string(target["nodeModulesAbi"], "Node modules ABI", ABI_RE)

    runtime = _require_keys(
        config["hostRuntime"],
        (
            "nodePath", "interpreterTargets", "apiLockPath", "nodeModulesPath",
            "nativeModulePaths", "privilegedBrokerLockPath",
            "privilegedBrokerNodeModulesPath", "privilegedBrokerNativeModulePaths",
            "realtimeSipLockPath", "realtimeSipNodeModulesPath",
            "realtimeSipNativeModulePaths",
            "boundSourcePaths",
        ),
        "host runtime input",
    )
    validate_relative_path(runtime["nodePath"], "release Node path")
    interpreter_targets = _require_array(runtime["interpreterTargets"], "interpreter targets")
    if tuple(interpreter_targets) != INTERPRETER_TARGETS:
        raise _error("the two fixed host interpreter targets are not explicitly bound")
    if runtime["apiLockPath"] != API_LOCK_PATH:
        raise _error("the API lockfile path is not fixed")
    module_root = validate_relative_path(runtime["nodeModulesPath"], "node_modules path")
    if module_root != API_NODE_MODULES_PATH:
        raise _error("the API node_modules path is not fixed")
    native_paths = _require_array(runtime["nativeModulePaths"], "native module paths")
    if tuple(native_paths) != API_NATIVE_MODULE_PATHS:
        raise _error("the API native module paths are not exact")
    for index, native_path in enumerate(native_paths):
        value_path = validate_relative_path(native_path, f"native module path {index}")
        if not value_path.startswith(f"{module_root}/") or not value_path.endswith(".node"):
            raise _error("a native module is outside the declared dependency tree")

    if runtime["privilegedBrokerLockPath"] != PRIVILEGED_BROKER_LOCK_PATH:
        raise _error("the privileged broker lockfile path is not fixed")
    broker_module_root = validate_relative_path(
        runtime["privilegedBrokerNodeModulesPath"], "privileged broker node_modules path"
    )
    if broker_module_root != PRIVILEGED_BROKER_NODE_MODULES_PATH:
        raise _error("the privileged broker node_modules path is not fixed")
    broker_native_paths = _require_array(
        runtime["privilegedBrokerNativeModulePaths"],
        "privileged broker native module paths",
    )
    if tuple(broker_native_paths) != PRIVILEGED_BROKER_NATIVE_MODULE_PATHS:
        raise _error("the privileged broker native module paths are not exact")
    for index, native_path in enumerate(broker_native_paths):
        value_path = validate_relative_path(
            native_path, f"privileged broker native module path {index}"
        )
        if not value_path.startswith(f"{broker_module_root}/") or not value_path.endswith(".node"):
            raise _error("a privileged broker native module escaped its dependency tree")

    if runtime["realtimeSipLockPath"] != REALTIME_SIP_LOCK_PATH:
        raise _error("the realtime SIP lockfile path is not fixed")
    realtime_module_root = validate_relative_path(
        runtime["realtimeSipNodeModulesPath"], "realtime SIP node_modules path"
    )
    if realtime_module_root != REALTIME_SIP_NODE_MODULES_PATH:
        raise _error("the realtime SIP node_modules path is not fixed")
    realtime_native_paths = _require_array(
        runtime["realtimeSipNativeModulePaths"], "realtime SIP native module paths"
    )
    if tuple(realtime_native_paths) != REALTIME_SIP_NATIVE_MODULE_PATHS:
        raise _error("the realtime SIP native module paths are not exact")
    for index, native_path in enumerate(realtime_native_paths):
        value_path = validate_relative_path(native_path, f"realtime SIP native module path {index}")
        if not value_path.startswith(f"{realtime_module_root}/") or not value_path.endswith(".node"):
            raise _error("a realtime SIP native module escaped its dependency tree")
    bound_paths = _require_array(runtime["boundSourcePaths"], "bound source paths")
    if tuple(bound_paths) != BOUND_SOURCE_PATHS:
        raise _error("host launch, bind-mount, or canary source bindings are incomplete")

    provider = _require_keys(config["providerCli"], ("manifestPath", "artifacts"), "provider CLI input")
    validate_relative_path(provider["manifestPath"], "provider CLI manifest path")
    artifacts = _require_array(provider["artifacts"], "provider artifact inputs")
    if len(artifacts) != len(PROVIDER_ARTIFACT_IDS):
        raise _error("provider artifact inputs are incomplete")
    for artifact, expected_id in zip(artifacts, PROVIDER_ARTIFACT_IDS, strict=True):
        record = _require_keys(artifact, ("id", "path"), "provider artifact input")
        if record["id"] != expected_id:
            raise _error("provider artifact inputs are not in canonical ID order")
        validate_relative_path(record["path"], f"provider artifact {expected_id} path")

    voice = _require_keys(config["voiceImage"], ("manifestPath", "archivePath"), "voice image input")
    validate_relative_path(voice["manifestPath"], "voice image manifest path")
    validate_relative_path(voice["archivePath"], "voice image archive path")

    sbom = _require_keys(config["sbom"], ("format", "releasePath", "voiceImagePath"), "SBOM input")
    if sbom["format"] != "cyclonedx-json-1.6":
        raise _error("the SBOM format must be CycloneDX JSON 1.6")
    validate_relative_path(sbom["releasePath"], "release SBOM path")
    validate_relative_path(sbom["voiceImagePath"], "voice-image SBOM path")
    return config


def _validate_provider_manifest(
    root: Path,
    entries: Mapping[str, Entry],
    manifest_path: str,
    artifact_bindings: Sequence[Mapping[str, Any]],
) -> tuple[Entry, list[dict[str, Any]]]:
    provider_manifest, manifest_entry = _read_release_json(
        root, entries, manifest_path, label="provider CLI manifest", canonical=False
    )
    _require_keys(provider_manifest, ("version", "artifacts"), "provider CLI manifest")
    if provider_manifest["version"] != 1:
        raise _error("the provider CLI manifest version is unsupported")
    artifacts = _require_array(provider_manifest["artifacts"], "provider CLI artifacts")
    if len(artifacts) != len(PROVIDER_ARTIFACT_IDS):
        raise _error("the provider CLI manifest has an incomplete artifact set")

    result: list[dict[str, Any]] = []
    for provider_entry, binding, expected_id in zip(
        artifacts, artifact_bindings, PROVIDER_ARTIFACT_IDS, strict=True
    ):
        record = _require_keys(
            provider_entry,
            (
                "id", "provider", "path", "source", "sha256", "size", "mode",
                "versionArgs", "versionStdout",
            ),
            "provider CLI artifact",
        )
        if (
            record["id"] != expected_id
            or binding["id"] != expected_id
            or record["provider"] != PROVIDER_NAMES[expected_id]
            or record["path"] != PROVIDER_DESTINATIONS[expected_id]
            or record["source"] != PROVIDER_SOURCES[expected_id]
            or record["mode"] != "0755"
        ):
            raise _error("a provider CLI artifact identity or destination drifted")
        digest = _require_string(record["sha256"], "provider artifact digest", HEX_RE)
        size = _require_int(record["size"], "provider artifact size", minimum=1)
        args = _require_array(record["versionArgs"], "provider version arguments")
        if not args or any(type(argument) is not str or not argument for argument in args):
            raise _error("provider version arguments are invalid")
        _require_string(record["versionStdout"], "provider version stdout")
        artifact_entry = _required_file(entries, binding["path"], f"provider artifact {expected_id}")
        if artifact_entry.digest != digest or artifact_entry.size != size or artifact_entry.mode != 0o555:
            raise _error("a bundled provider artifact differs from its CLI manifest")
        result.append(
            {
                "id": expected_id,
                "path": artifact_entry.path,
                "sha256": _prefixed(artifact_entry.digest),
                "size": artifact_entry.size,
            }
        )
    return manifest_entry, result


def _validate_voice_manifest(
    root: Path,
    entries: Mapping[str, Entry],
    manifest_path: str,
    source_revision: str,
    target_platform: str,
) -> tuple[Entry, dict[str, Any]]:
    voice, entry = _read_release_json(
        root, entries, manifest_path, label="voice image manifest", canonical=True
    )
    _require_keys(
        voice,
        (
            "version", "sourceRevision", "platform", "configDigest", "runtimeReference",
            "registryReference", "registryManifestDigest",
        ),
        "voice image manifest",
    )
    if voice["version"] != 2:
        raise _error("the voice image manifest version is unsupported")
    _require_string(voice["sourceRevision"], "voice source revision", REVISION_RE)
    _require_string(voice["platform"], "voice image platform", PLATFORM_RE)
    _require_string(voice["configDigest"], "voice image config digest", DIGEST_RE)
    _require_string(voice["runtimeReference"], "voice runtime reference")
    registry_reference = voice["registryReference"]
    registry_digest = voice["registryManifestDigest"]
    if registry_reference is None or registry_digest is None:
        if registry_reference is not None or registry_digest is not None:
            raise _error("voice registry reference and digest must be both null or both present")
        if voice["runtimeReference"] != voice["configDigest"]:
            raise _error("an offline voice image must run by its exact config digest")
    else:
        _require_string(registry_reference, "voice registry reference", REGISTRY_REFERENCE_RE)
        _require_string(registry_digest, "voice registry manifest digest", DIGEST_RE)
        if not registry_reference.endswith(f"@{registry_digest}") or voice["runtimeReference"] != registry_reference:
            raise _error("voice registry fields do not identify one immutable manifest")
    if voice["sourceRevision"] != source_revision or voice["platform"] != target_platform:
        raise _error("voice image revision or platform differs from the host release")
    return entry, voice


def _validate_sbom(root: Path, entries: Mapping[str, Entry], relative: str, label: str) -> Entry:
    document, entry = _read_release_json(root, entries, relative, label=label, canonical=False)
    if document.get("bomFormat") != "CycloneDX" or document.get("specVersion") != "1.6":
        raise _error(f"{label} is not a CycloneDX 1.6 document")
    return entry


def _construct_dependency_binding(
    entries: Sequence[Entry],
    entry_by_path: Mapping[str, Entry],
    *,
    lock_path: str,
    module_root: str,
    expected_native_paths: Sequence[str],
    label: str,
) -> tuple[Entry, list[dict[str, Any]]]:
    lock_entry = _required_file(entry_by_path, lock_path, f"{label} lockfile path")
    module_directory = entry_by_path.get(module_root)
    if module_directory is None or module_directory.kind != "D":
        raise _error(f"the {label} node_modules tree is absent")
    if any(
        entry.path == f"{module_root}/.bin" or entry.path.startswith(f"{module_root}/.bin/")
        for entry in entries
    ):
        raise _error(f"{label} node_modules/.bin must not enter the release")
    actual_native_paths = sorted(
        entry.path
        for entry in entries
        if entry.kind == "F"
        and entry.path.startswith(f"{module_root}/")
        and entry.path.endswith(".node")
    )
    if list(expected_native_paths) != actual_native_paths:
        raise _error(f"the {label} native node_modules set differs from the declared closure")
    native_modules: list[dict[str, Any]] = []
    for relative in actual_native_paths:
        native = _required_file(entry_by_path, relative, f"{label} native module")
        native_modules.append(
            {"path": relative, "sha256": _prefixed(native.digest), "size": native.size}
        )
    return lock_entry, native_modules


def _construct_manifest(
    root: Path,
    config: Mapping[str, Any],
    entries: Sequence[Entry],
    file_list: bytes,
) -> dict[str, Any]:
    entry_by_path = _entry_map(entries)
    source = config["source"]
    target = config["target"]
    runtime = config["hostRuntime"]

    node_entry = _required_file(entry_by_path, runtime["nodePath"], "release Node path")
    if node_entry.mode != 0o555:
        raise _error("the release-contained Node interpreter is not executable")
    module_root = runtime["nodeModulesPath"]
    lock_entry, native_modules = _construct_dependency_binding(
        entries,
        entry_by_path,
        lock_path=runtime["apiLockPath"],
        module_root=module_root,
        expected_native_paths=runtime["nativeModulePaths"],
        label="API",
    )
    broker_module_root = runtime["privilegedBrokerNodeModulesPath"]
    broker_lock_entry, broker_native_modules = _construct_dependency_binding(
        entries,
        entry_by_path,
        lock_path=runtime["privilegedBrokerLockPath"],
        module_root=broker_module_root,
        expected_native_paths=runtime["privilegedBrokerNativeModulePaths"],
        label="privileged broker",
    )
    realtime_module_root = runtime["realtimeSipNodeModulesPath"]
    realtime_lock_entry, realtime_native_modules = _construct_dependency_binding(
        entries,
        entry_by_path,
        lock_path=runtime["realtimeSipLockPath"],
        module_root=realtime_module_root,
        expected_native_paths=runtime["realtimeSipNativeModulePaths"],
        label="realtime SIP gateway",
    )

    for relative in runtime["boundSourcePaths"]:
        _required_file(entry_by_path, relative, "bound host source path")

    provider_manifest, provider_artifacts = _validate_provider_manifest(
        root,
        entry_by_path,
        config["providerCli"]["manifestPath"],
        config["providerCli"]["artifacts"],
    )
    platform = f"{target['os']}/{target['architecture']}"
    voice_manifest_entry, voice = _validate_voice_manifest(
        root,
        entry_by_path,
        config["voiceImage"]["manifestPath"],
        source["revision"],
        platform,
    )
    voice_archive = _required_file(
        entry_by_path, config["voiceImage"]["archivePath"], "voice image archive"
    )
    release_sbom = _validate_sbom(
        root, entry_by_path, config["sbom"]["releasePath"], "release SBOM"
    )
    voice_sbom = _validate_sbom(
        root, entry_by_path, config["sbom"]["voiceImagePath"], "voice-image SBOM"
    )

    return {
        "version": FORMAT_VERSION,
        "application": "teleagent",
        "source": {
            "repository": source["repository"],
            "revision": source["revision"],
            "tree": source["tree"],
        },
        "target": {
            "os": target["os"],
            "architecture": target["architecture"],
            "libc": target["libc"],
            "nodeVersion": target["nodeVersion"],
            "nodeModulesAbi": target["nodeModulesAbi"],
        },
        "files": {
            "path": FILE_LIST_NAME,
            "sha256": _prefixed(_sha256_bytes(file_list)),
            "size": len(file_list),
            "entries": len(entries),
        },
        "hostRuntime": {
            "nodePath": node_entry.path,
            "nodeSha256": _prefixed(node_entry.digest),
            "interpreterTargets": list(INTERPRETER_TARGETS),
            "apiLockPath": lock_entry.path,
            "apiLockSha256": _prefixed(lock_entry.digest),
            "nodeModulesPath": module_root,
            "nativeModules": native_modules,
            "privilegedBrokerLockPath": broker_lock_entry.path,
            "privilegedBrokerLockSha256": _prefixed(broker_lock_entry.digest),
            "privilegedBrokerNodeModulesPath": broker_module_root,
            "privilegedBrokerNativeModules": broker_native_modules,
            "realtimeSipLockPath": realtime_lock_entry.path,
            "realtimeSipLockSha256": _prefixed(realtime_lock_entry.digest),
            "realtimeSipNodeModulesPath": realtime_module_root,
            "realtimeSipNativeModules": realtime_native_modules,
            "boundSourcePaths": list(BOUND_SOURCE_PATHS),
        },
        "providerCli": {
            "manifestPath": provider_manifest.path,
            "manifestSha256": _prefixed(provider_manifest.digest),
            "artifacts": provider_artifacts,
        },
        "voiceImage": {
            "manifestPath": voice_manifest_entry.path,
            "manifestSha256": _prefixed(voice_manifest_entry.digest),
            "archivePath": voice_archive.path,
            "archiveSha256": _prefixed(voice_archive.digest),
            "archiveSize": voice_archive.size,
            "configDigest": voice["configDigest"],
            "runtimeReference": voice["runtimeReference"],
            "registryReference": voice["registryReference"],
            "registryManifestDigest": voice["registryManifestDigest"],
            "sourceRevision": voice["sourceRevision"],
            "platform": voice["platform"],
        },
        "sbom": {
            "format": config["sbom"]["format"],
            "releasePath": release_sbom.path,
            "releaseSha256": _prefixed(release_sbom.digest),
            "voiceImagePath": voice_sbom.path,
            "voiceImageSha256": _prefixed(voice_sbom.digest),
        },
    }


def _validate_native_module_bindings(
    value: Any,
    *,
    module_root: str,
    expected_paths: Sequence[str],
    label: str,
) -> list[dict[str, Any]]:
    records = _require_array(value, f"{label} native modules")
    native_paths: list[str] = []
    for record in records:
        item = _require_keys(record, ("path", "sha256", "size"), f"{label} native module binding")
        relative = validate_relative_path(item["path"], f"{label} native module path")
        if not relative.startswith(f"{module_root}/") or not relative.endswith(".node"):
            raise _error(f"a {label} native module binding escaped node_modules")
        _require_string(item["sha256"], f"{label} native module digest", DIGEST_RE)
        _require_int(item["size"], f"{label} native module size", minimum=1)
        native_paths.append(relative)
    if tuple(native_paths) != tuple(expected_paths):
        raise _error(f"the {label} native module bindings are not exact")
    return records


def _validate_manifest_shape(manifest: Any) -> dict[str, Any]:
    value = _require_keys(
        manifest,
        (
            "version", "application", "source", "target", "files", "hostRuntime",
            "providerCli", "voiceImage", "sbom",
        ),
        "release manifest",
    )
    if value["version"] != FORMAT_VERSION or value["application"] != "teleagent":
        raise _error("the release manifest identity or version is unsupported")
    source = _require_keys(value["source"], ("repository", "revision", "tree"), "manifest source")
    _require_string(source["repository"], "source repository")
    _require_string(source["revision"], "source revision", REVISION_RE)
    _require_string(source["tree"], "source tree", REVISION_RE)
    target = _require_keys(
        value["target"],
        ("os", "architecture", "libc", "nodeVersion", "nodeModulesAbi"),
        "manifest target",
    )
    if target["os"] != "linux" or target["architecture"] not in ("amd64", "arm64") or target["libc"] != "glibc":
        raise _error("the manifest target is unsupported")
    _require_string(target["nodeVersion"], "Node version", NODE_VERSION_RE)
    _require_string(target["nodeModulesAbi"], "Node modules ABI", ABI_RE)
    files = _require_keys(value["files"], ("path", "sha256", "size", "entries"), "file-list binding")
    if files["path"] != FILE_LIST_NAME:
        raise _error("the manifest file-list path is not fixed")
    _require_string(files["sha256"], "file-list digest", DIGEST_RE)
    _require_int(files["size"], "file-list size", minimum=1)
    _require_int(files["entries"], "file-list entry count", minimum=1)

    runtime = _require_keys(
        value["hostRuntime"],
        (
            "nodePath", "nodeSha256", "interpreterTargets", "apiLockPath",
            "apiLockSha256", "nodeModulesPath", "nativeModules",
            "privilegedBrokerLockPath", "privilegedBrokerLockSha256",
            "privilegedBrokerNodeModulesPath", "privilegedBrokerNativeModules",
            "realtimeSipLockPath", "realtimeSipLockSha256",
            "realtimeSipNodeModulesPath", "realtimeSipNativeModules",
            "boundSourcePaths",
        ),
        "manifest host runtime",
    )
    validate_relative_path(runtime["nodePath"], "release Node path")
    _require_string(runtime["nodeSha256"], "release Node digest", DIGEST_RE)
    if tuple(_require_array(runtime["interpreterTargets"], "interpreter targets")) != INTERPRETER_TARGETS:
        raise _error("the manifest does not bind both host Node interpreter targets")
    if runtime["apiLockPath"] != API_LOCK_PATH:
        raise _error("the manifest API lockfile path is not fixed")
    _require_string(runtime["apiLockSha256"], "API lockfile digest", DIGEST_RE)
    module_root = validate_relative_path(runtime["nodeModulesPath"], "node_modules path")
    if module_root != API_NODE_MODULES_PATH:
        raise _error("the manifest API node_modules path is not fixed")
    _validate_native_module_bindings(
        runtime["nativeModules"],
        module_root=module_root,
        expected_paths=API_NATIVE_MODULE_PATHS,
        label="API",
    )
    if runtime["privilegedBrokerLockPath"] != PRIVILEGED_BROKER_LOCK_PATH:
        raise _error("the manifest privileged broker lockfile path is not fixed")
    _require_string(
        runtime["privilegedBrokerLockSha256"],
        "privileged broker lockfile digest",
        DIGEST_RE,
    )
    broker_module_root = validate_relative_path(
        runtime["privilegedBrokerNodeModulesPath"],
        "privileged broker node_modules path",
    )
    if broker_module_root != PRIVILEGED_BROKER_NODE_MODULES_PATH:
        raise _error("the manifest privileged broker node_modules path is not fixed")
    _validate_native_module_bindings(
        runtime["privilegedBrokerNativeModules"],
        module_root=broker_module_root,
        expected_paths=PRIVILEGED_BROKER_NATIVE_MODULE_PATHS,
        label="privileged broker",
    )
    if runtime["realtimeSipLockPath"] != REALTIME_SIP_LOCK_PATH:
        raise _error("the manifest realtime SIP lockfile path is not fixed")
    _require_string(runtime["realtimeSipLockSha256"], "realtime SIP lockfile digest", DIGEST_RE)
    realtime_module_root = validate_relative_path(
        runtime["realtimeSipNodeModulesPath"], "realtime SIP node_modules path"
    )
    if realtime_module_root != REALTIME_SIP_NODE_MODULES_PATH:
        raise _error("the manifest realtime SIP node_modules path is not fixed")
    _validate_native_module_bindings(
        runtime["realtimeSipNativeModules"],
        module_root=realtime_module_root,
        expected_paths=REALTIME_SIP_NATIVE_MODULE_PATHS,
        label="realtime SIP gateway",
    )
    if tuple(_require_array(runtime["boundSourcePaths"], "bound source paths")) != BOUND_SOURCE_PATHS:
        raise _error("the manifest host source bindings are incomplete")

    provider = _require_keys(
        value["providerCli"], ("manifestPath", "manifestSha256", "artifacts"), "provider binding"
    )
    validate_relative_path(provider["manifestPath"], "provider CLI manifest path")
    _require_string(provider["manifestSha256"], "provider CLI manifest digest", DIGEST_RE)
    provider_artifacts = _require_array(provider["artifacts"], "provider artifact bindings")
    if len(provider_artifacts) != len(PROVIDER_ARTIFACT_IDS):
        raise _error("provider artifact bindings are incomplete")
    for record, expected_id in zip(provider_artifacts, PROVIDER_ARTIFACT_IDS, strict=True):
        item = _require_keys(record, ("id", "path", "sha256", "size"), "provider artifact binding")
        if item["id"] != expected_id:
            raise _error("provider artifact bindings are not in canonical order")
        validate_relative_path(item["path"], "provider artifact path")
        _require_string(item["sha256"], "provider artifact digest", DIGEST_RE)
        _require_int(item["size"], "provider artifact size", minimum=1)

    voice = _require_keys(
        value["voiceImage"],
        (
            "manifestPath", "manifestSha256", "archivePath", "archiveSha256", "archiveSize",
            "configDigest", "runtimeReference", "registryReference", "registryManifestDigest",
            "sourceRevision", "platform",
        ),
        "voice image binding",
    )
    validate_relative_path(voice["manifestPath"], "voice manifest path")
    _require_string(voice["manifestSha256"], "voice manifest digest", DIGEST_RE)
    validate_relative_path(voice["archivePath"], "voice archive path")
    _require_string(voice["archiveSha256"], "voice archive digest", DIGEST_RE)
    _require_int(voice["archiveSize"], "voice archive size", minimum=1)
    _require_string(voice["configDigest"], "voice config digest", DIGEST_RE)
    _require_string(voice["runtimeReference"], "voice runtime reference")
    _require_string(voice["sourceRevision"], "voice source revision", REVISION_RE)
    _require_string(voice["platform"], "voice platform", PLATFORM_RE)
    if voice["sourceRevision"] != source["revision"] or voice["platform"] != f"linux/{target['architecture']}":
        raise _error("voice and host source/platform bindings disagree")
    if voice["registryReference"] is None or voice["registryManifestDigest"] is None:
        if voice["registryReference"] is not None or voice["registryManifestDigest"] is not None:
            raise _error("voice registry reference and digest must be both null or both present")
        if voice["runtimeReference"] != voice["configDigest"]:
            raise _error("offline voice runtime reference is not its config digest")
    else:
        _require_string(voice["registryReference"], "voice registry reference", REGISTRY_REFERENCE_RE)
        _require_string(voice["registryManifestDigest"], "voice registry digest", DIGEST_RE)
        if (
            not voice["registryReference"].endswith(f"@{voice['registryManifestDigest']}")
            or voice["runtimeReference"] != voice["registryReference"]
        ):
            raise _error("voice registry bindings disagree")

    sbom = _require_keys(
        value["sbom"],
        ("format", "releasePath", "releaseSha256", "voiceImagePath", "voiceImageSha256"),
        "SBOM binding",
    )
    if sbom["format"] != "cyclonedx-json-1.6":
        raise _error("the manifest SBOM format is unsupported")
    validate_relative_path(sbom["releasePath"], "release SBOM path")
    _require_string(sbom["releaseSha256"], "release SBOM digest", DIGEST_RE)
    validate_relative_path(sbom["voiceImagePath"], "voice-image SBOM path")
    _require_string(sbom["voiceImageSha256"], "voice-image SBOM digest", DIGEST_RE)
    return value


def _cross_validate_dependency_binding(
    entry_by_path: Mapping[str, Entry],
    entries: Sequence[Entry],
    *,
    lock_path: str,
    lock_digest: str,
    module_root: str,
    native_modules: Sequence[Mapping[str, Any]],
    label: str,
) -> None:
    lock = _required_file(entry_by_path, lock_path, f"{label} lockfile path")
    if _prefixed(lock.digest) != lock_digest:
        raise _error(f"the {label} lockfile binding differs from the inventory")
    if entry_by_path.get(module_root, Entry("", "", 0, None, None)).kind != "D":
        raise _error(f"the manifest {label} node_modules directory is absent")
    if any(
        entry.path == f"{module_root}/.bin" or entry.path.startswith(f"{module_root}/.bin/")
        for entry in entries
    ):
        raise _error(f"{label} node_modules/.bin entered the immutable closure")
    actual_native = sorted(
        entry.path
        for entry in entries
        if entry.kind == "F" and entry.path.startswith(f"{module_root}/") and entry.path.endswith(".node")
    )
    declared_native = [item["path"] for item in native_modules]
    if actual_native != declared_native:
        raise _error(f"the {label} native module set differs from the manifest")
    for item in native_modules:
        entry = _required_file(entry_by_path, item["path"], f"{label} native module")
        if _prefixed(entry.digest) != item["sha256"] or entry.size != item["size"]:
            raise _error(f"a {label} native module binding differs from the inventory")


def _cross_validate_manifest(root: Path, manifest: Mapping[str, Any], entries: Sequence[Entry]) -> None:
    entry_by_path = _entry_map(entries)
    runtime = manifest["hostRuntime"]
    node = _required_file(entry_by_path, runtime["nodePath"], "release Node path")
    if _prefixed(node.digest) != runtime["nodeSha256"] or node.mode != 0o555:
        raise _error("the release Node binding differs from the inventory")
    _cross_validate_dependency_binding(
        entry_by_path,
        entries,
        lock_path=runtime["apiLockPath"],
        lock_digest=runtime["apiLockSha256"],
        module_root=runtime["nodeModulesPath"],
        native_modules=runtime["nativeModules"],
        label="API",
    )
    _cross_validate_dependency_binding(
        entry_by_path,
        entries,
        lock_path=runtime["privilegedBrokerLockPath"],
        lock_digest=runtime["privilegedBrokerLockSha256"],
        module_root=runtime["privilegedBrokerNodeModulesPath"],
        native_modules=runtime["privilegedBrokerNativeModules"],
        label="privileged broker",
    )
    _cross_validate_dependency_binding(
        entry_by_path,
        entries,
        lock_path=runtime["realtimeSipLockPath"],
        lock_digest=runtime["realtimeSipLockSha256"],
        module_root=runtime["realtimeSipNodeModulesPath"],
        native_modules=runtime["realtimeSipNativeModules"],
        label="realtime SIP gateway",
    )
    for relative in runtime["boundSourcePaths"]:
        _required_file(entry_by_path, relative, "bound host source path")

    provider = manifest["providerCli"]
    provider_entry = _required_file(entry_by_path, provider["manifestPath"], "provider manifest")
    if _prefixed(provider_entry.digest) != provider["manifestSha256"]:
        raise _error("the provider manifest digest differs from the inventory")
    _, expected_provider = _validate_provider_manifest(
        root, entry_by_path, provider["manifestPath"], provider["artifacts"]
    )
    if expected_provider != provider["artifacts"]:
        raise _error("provider CLI semantic bindings differ from the manifest")

    voice = manifest["voiceImage"]
    voice_manifest_entry, voice_document = _validate_voice_manifest(
        root,
        entry_by_path,
        voice["manifestPath"],
        manifest["source"]["revision"],
        f"linux/{manifest['target']['architecture']}",
    )
    archive = _required_file(entry_by_path, voice["archivePath"], "voice archive")
    if (
        _prefixed(voice_manifest_entry.digest) != voice["manifestSha256"]
        or _prefixed(archive.digest) != voice["archiveSha256"]
        or archive.size != voice["archiveSize"]
    ):
        raise _error("voice manifest or archive binding differs from the inventory")
    for key in (
        "configDigest", "runtimeReference", "registryReference", "registryManifestDigest",
        "sourceRevision", "platform",
    ):
        if voice_document[key] != voice[key]:
            raise _error("voice semantic bindings differ from the image manifest")

    sbom = manifest["sbom"]
    release_sbom = _validate_sbom(root, entry_by_path, sbom["releasePath"], "release SBOM")
    voice_sbom = _validate_sbom(root, entry_by_path, sbom["voiceImagePath"], "voice-image SBOM")
    if (
        _prefixed(release_sbom.digest) != sbom["releaseSha256"]
        or _prefixed(voice_sbom.digest) != sbom["voiceImageSha256"]
    ):
        raise _error("an SBOM binding differs from the inventory")


def _atomic_write(filename: Path, contents: bytes, mode: int) -> None:
    temporary = filename.with_name(f".{filename.name}.new-{os.getpid()}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor: int | None = None
    try:
        descriptor = os.open(temporary, flags, 0o600)
        offset = 0
        while offset < len(contents):
            offset += os.write(descriptor, contents[offset:])
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.replace(temporary, filename)
    except OSError as exc:
        raise _error("release metadata could not be committed atomically") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def generate_release(
    root: Path | str,
    build_input: Mapping[str, Any],
    *,
    expected_uid: int | None = None,
    expected_gid: int | None = None,
) -> str:
    """Normalize a prepared staging tree and write its v2 closure metadata.

    The staging tree must not already contain either metadata file.  This
    function normalizes only ordinary file/directory modes; it refuses links,
    special files, mixed ownership, and xattrs instead of silently deleting
    evidence.
    """

    release_root = Path(root).absolute()
    metadata = _safe_lstat(release_root, "release root")
    uid = metadata.st_uid if expected_uid is None else expected_uid
    gid = metadata.st_gid if expected_gid is None else expected_gid
    config = validate_build_input(build_input)
    for name in (MANIFEST_NAME, FILE_LIST_NAME):
        path = release_root / name
        if path.exists() or path.is_symlink():
            raise _error("release metadata already exists; use a fresh staging tree")

    entries = _scan_tree(
        release_root,
        expected_uid=uid,
        expected_gid=gid,
        normalize_modes=True,
        require_root_mode=False,
    )
    file_list = serialize_file_list(entries)
    manifest = _construct_manifest(release_root, config, entries, file_list)
    manifest_contents = canonical_json_bytes(manifest)
    _atomic_write(release_root / FILE_LIST_NAME, file_list, 0o444)
    _atomic_write(release_root / MANIFEST_NAME, manifest_contents, 0o444)
    os.chmod(release_root, 0o555, follow_symlinks=False)
    return _prefixed(_sha256_bytes(manifest_contents))


def verify_release(
    root: Path | str,
    *,
    expected_uid: int | None = None,
    expected_gid: int | None = None,
) -> tuple[str, dict[str, Any]]:
    """Verify one extracted v2 release closure without executing its code."""

    release_root = Path(root).absolute()
    root_metadata = _safe_lstat(release_root, "release root")
    uid = root_metadata.st_uid if expected_uid is None else expected_uid
    gid = root_metadata.st_gid if expected_gid is None else expected_gid
    if not stat.S_ISDIR(root_metadata.st_mode) or stat.S_ISLNK(root_metadata.st_mode):
        raise _error("the release root is not a real directory")

    for name in (MANIFEST_NAME, FILE_LIST_NAME):
        filename = release_root / name
        metadata = _safe_lstat(filename, f"release metadata {name}")
        if (
            not stat.S_ISREG(metadata.st_mode)
            or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_nlink != 1
            or stat.S_IMODE(metadata.st_mode) != 0o444
        ):
            raise _error(f"release metadata {name} has unsafe type, links, or mode")
        _assert_owner(metadata, uid, gid, f"release metadata {name}")
        _assert_no_xattrs(filename, f"release metadata {name}")

    manifest_contents = (release_root / MANIFEST_NAME).read_bytes()
    manifest = parse_json_bytes(manifest_contents, label="release manifest", canonical=True)
    _validate_manifest_shape(manifest)
    file_list_contents = (release_root / FILE_LIST_NAME).read_bytes()
    files = manifest["files"]
    if (
        len(file_list_contents) != files["size"]
        or _prefixed(_sha256_bytes(file_list_contents)) != files["sha256"]
    ):
        raise _error("the file-list size or digest differs from the release manifest")
    expected_entries = parse_file_list(file_list_contents)
    if len(expected_entries) != files["entries"]:
        raise _error("the file-list entry count differs from the release manifest")
    actual_entries = _scan_tree(
        release_root,
        expected_uid=uid,
        expected_gid=gid,
        normalize_modes=False,
        require_root_mode=True,
    )
    if actual_entries != expected_entries:
        raise _error("the extracted release tree differs from its complete inventory")
    _cross_validate_manifest(release_root, manifest, actual_entries)
    return _prefixed(_sha256_bytes(manifest_contents)), manifest


def package_release(
    root: Path | str,
    output: Path | str,
    *,
    source_date_epoch: int,
    expected_uid: int | None = None,
    expected_gid: int | None = None,
) -> str:
    """Create an uncompressed deterministic tar of an already verified tree."""

    if type(source_date_epoch) is not int or source_date_epoch < 0 or source_date_epoch > 2**31 - 1:
        raise _error("SOURCE_DATE_EPOCH is outside the supported range")
    release_root = Path(root).absolute()
    output_path = Path(output).absolute()
    try:
        output_path.relative_to(release_root)
    except ValueError:
        pass
    else:
        raise _error("the deterministic bundle output must be outside the release tree")
    if output_path.exists() or output_path.is_symlink():
        raise _error("the deterministic bundle output already exists")
    manifest_digest, _manifest = verify_release(
        release_root, expected_uid=expected_uid, expected_gid=expected_gid
    )
    prefix = manifest_digest.replace(":", "-")

    paths: list[tuple[str, Path, os.stat_result]] = []
    for directory, dirnames, filenames in os.walk(release_root, topdown=True, followlinks=False):
        dirnames.sort(key=lambda value: value.encode("ascii"))
        filenames.sort(key=lambda value: value.encode("ascii"))
        base = Path(directory)
        for name in dirnames + filenames:
            path = base / name
            relative = path.relative_to(release_root).as_posix()
            paths.append((relative, path, path.lstat()))
    paths.sort(key=lambda item: item[0].encode("ascii"))

    try:
        raw = output_path.open("xb")
    except OSError as exc:
        raise _error("the deterministic bundle output cannot be created") from exc
    try:
        with raw, tarfile.open(fileobj=raw, mode="w", format=tarfile.GNU_FORMAT) as archive:
            root_info = tarfile.TarInfo(prefix)
            root_info.type = tarfile.DIRTYPE
            root_info.mode = 0o555
            root_info.uid = 0
            root_info.gid = 0
            root_info.uname = ""
            root_info.gname = ""
            root_info.mtime = source_date_epoch
            archive.addfile(root_info)
            for relative, path, metadata in paths:
                info = tarfile.TarInfo(f"{prefix}/{relative}")
                info.mode = stat.S_IMODE(metadata.st_mode)
                info.uid = 0
                info.gid = 0
                info.uname = ""
                info.gname = ""
                info.mtime = source_date_epoch
                if stat.S_ISDIR(metadata.st_mode):
                    info.type = tarfile.DIRTYPE
                    archive.addfile(info)
                elif stat.S_ISREG(metadata.st_mode):
                    info.type = tarfile.REGTYPE
                    info.size = metadata.st_size
                    with path.open("rb") as contents:
                        archive.addfile(info, contents)
                else:  # verify_release already rejected this; preserve fail-closed behavior.
                    raise _error("a release entry changed type during deterministic packaging")
        os.chmod(output_path, 0o444, follow_symlinks=False)
        digest, _size = hash_regular_file(output_path)
        return _prefixed(digest)
    except Exception:
        try:
            output_path.unlink()
        except FileNotFoundError:
            pass
        raise


def load_build_input(filename: Path | str) -> dict[str, Any]:
    return validate_build_input(
        read_json_file(Path(filename), label="release build input", canonical=False)
    )


__all__ = [
    "API_LOCK_PATH",
    "API_NATIVE_MODULE_PATHS",
    "API_NODE_MODULES_PATH",
    "BOUND_SOURCE_PATHS",
    "BUILD_INPUT_VERSION",
    "ClosureError",
    "Entry",
    "FILE_LIST_NAME",
    "FORMAT_VERSION",
    "INTERPRETER_TARGETS",
    "MANIFEST_NAME",
    "PRIVILEGED_BROKER_LOCK_PATH",
    "PRIVILEGED_BROKER_NATIVE_MODULE_PATHS",
    "PRIVILEGED_BROKER_NODE_MODULES_PATH",
    "REALTIME_SIP_LOCK_PATH",
    "REALTIME_SIP_NATIVE_MODULE_PATHS",
    "REALTIME_SIP_NODE_MODULES_PATH",
    "canonical_json_bytes",
    "generate_release",
    "load_build_input",
    "package_release",
    "parse_file_list",
    "parse_json_bytes",
    "serialize_file_list",
    "validate_build_input",
    "verify_release",
]
