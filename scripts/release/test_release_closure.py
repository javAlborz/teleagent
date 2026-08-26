#!/usr/bin/env python3
"""Regression tests for the build-side Teleagent release-closure contract."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from release_closure import (
    API_LOCK_PATH,
    API_NATIVE_MODULE_PATHS,
    API_NODE_MODULES_PATH,
    BOUND_SOURCE_PATHS,
    ClosureError,
    FILE_LIST_NAME,
    INTERPRETER_TARGETS,
    MANIFEST_NAME,
    PRIVILEGED_BROKER_LOCK_PATH,
    PRIVILEGED_BROKER_NATIVE_MODULE_PATHS,
    PRIVILEGED_BROKER_NODE_MODULES_PATH,
    REALTIME_SIP_LOCK_PATH,
    REALTIME_SIP_NATIVE_MODULE_PATHS,
    REALTIME_SIP_NODE_MODULES_PATH,
    canonical_json_bytes,
    generate_release,
    package_release,
    verify_release,
)


SOURCE_REVISION = "a" * 40
SOURCE_TREE = "b" * 40
VOICE_CONFIG_DIGEST = f"sha256:{'c' * 64}"


def digest(contents: bytes) -> str:
    return hashlib.sha256(contents).hexdigest()


class ReleaseFixture:
    """A small but semantically complete release staging tree."""

    def __init__(self, parent: Path, name: str = "release") -> None:
        self.root = parent / name
        self.root.mkdir(mode=0o755)
        self.contents: dict[str, bytes] = {}
        self._populate()

    def write(self, relative: str, contents: bytes | str, *, executable: bool = False) -> Path:
        payload = contents.encode("utf-8") if isinstance(contents, str) else contents
        filename = self.root / relative
        filename.parent.mkdir(parents=True, exist_ok=True)
        filename.write_bytes(payload)
        filename.chmod(0o755 if executable else 0o644)
        self.contents[relative] = payload
        return filename

    def _populate(self) -> None:
        self.write("runtime/node/bin/node", b"fixture-node-runtime\n", executable=True)
        self.write("claude-api-server/package-lock.json", '{"lockfileVersion":3}\n')
        self.write(
            "claude-api-server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
            b"fixture-better-sqlite3-native",
            executable=True,
        )
        self.write(
            "claude-api-server/node_modules/node-pty/build/Release/pty.node",
            b"fixture-node-pty-native",
            executable=True,
        )
        self.write(PRIVILEGED_BROKER_LOCK_PATH, '{"lockfileVersion":3}\n')
        self.write(
            PRIVILEGED_BROKER_NATIVE_MODULE_PATHS[0],
            b"fixture-privileged-broker-better-sqlite3-native",
            executable=True,
        )
        self.write(REALTIME_SIP_LOCK_PATH, '{"lockfileVersion":3}\n')
        self.write(
            REALTIME_SIP_NATIVE_MODULE_PATHS[0],
            b"fixture-realtime-sip-better-sqlite3-native",
            executable=True,
        )
        for relative in BOUND_SOURCE_PATHS:
            executable = relative in (
                "deploy/voice-stack/teleagent-voice-stack-launch.js",
                "deploy/worker-session/teleagent-provider-canary",
                "freeswitch/entrypoint.sh",
            )
            self.write(relative, f"fixture bound source: {relative}\n", executable=executable)

        provider_paths = {
            "claude": "artifacts/provider-cli/claude",
            "codex-wrapper": "deploy/worker-session/teleagent-codex-cli-wrapper",
            "codex-vendor": "artifacts/provider-cli/codex-vendor",
        }
        provider_payloads = {
            "claude": b"fixture-claude-cli",
            "codex-wrapper": b"#!/bin/sh\nexec /opt/teleagent/agent-tools/codex-vendor \"$@\"\n",
            "codex-vendor": b"fixture-codex-vendor",
        }
        for artifact_id, relative in provider_paths.items():
            self.write(relative, provider_payloads[artifact_id], executable=True)
        provider_records = []
        destinations = {
            "claude": "/opt/teleagent/agent-tools/claude",
            "codex-wrapper": "/opt/teleagent/agent-tools/codex",
            "codex-vendor": "/opt/teleagent/agent-tools/codex-vendor",
        }
        providers = {"claude": "claude", "codex-wrapper": "codex", "codex-vendor": "codex"}
        sources = {
            "claude": None,
            "codex-wrapper": "/usr/local/libexec/teleagent-provider-codex-cli-wrapper",
            "codex-vendor": None,
        }
        versions = {
            "claude": "2.1.246 (Claude Code)",
            "codex-wrapper": "codex-cli 0.149.1",
            "codex-vendor": "codex-cli 0.149.1",
        }
        for artifact_id in ("claude", "codex-wrapper", "codex-vendor"):
            payload = provider_payloads[artifact_id]
            provider_records.append(
                {
                    "id": artifact_id,
                    "provider": providers[artifact_id],
                    "path": destinations[artifact_id],
                    "source": sources[artifact_id],
                    "sha256": digest(payload),
                    "size": len(payload),
                    "mode": "0755",
                    "versionArgs": ["--version"],
                    "versionStdout": versions[artifact_id],
                }
            )
        provider_manifest = {"version": 1, "artifacts": provider_records}
        self.write(
            "deploy/worker-session/provider-cli.manifest.json",
            json.dumps(provider_manifest, indent=2) + "\n",
        )
        # This mode-sensitive source is intentionally non-executable.  The
        # generator must normalize Git's 0644 checkout mode to release 0444.
        self.write(
            "deploy/worker-session/provider-libexec.manifest",
            "0" * 64 + " fixture fixture 0444\n",
        )
        self.write(
            "deploy/worker-session/teleagent-worker-session-install",
            "#!/bin/sh\nexit 0\n",
            executable=True,
        )

        voice_manifest = {
            "version": 2,
            "sourceRevision": SOURCE_REVISION,
            "platform": "linux/amd64",
            "configDigest": VOICE_CONFIG_DIGEST,
            "runtimeReference": VOICE_CONFIG_DIGEST,
            "registryReference": None,
            "registryManifestDigest": None,
        }
        self.write(
            "artifacts/voice/voice-image.manifest.json",
            canonical_json_bytes(voice_manifest),
        )
        self.write("artifacts/voice/voice-image.docker.tar", b"fixture-docker-archive\0bytes")
        sbom = {
            "bomFormat": "CycloneDX",
            "specVersion": "1.6",
            "version": 1,
            "components": [],
        }
        self.write("artifacts/sbom/teleagent-release.cdx.json", json.dumps(sbom) + "\n")
        self.write("artifacts/sbom/voice-image.cdx.json", json.dumps(sbom) + "\n")

        self.config = {
            "version": 1,
            "source": {
                "repository": "https://github.com/javAlborz/teleagent.git",
                "revision": SOURCE_REVISION,
                "tree": SOURCE_TREE,
            },
            "target": {
                "os": "linux",
                "architecture": "amd64",
                "libc": "glibc",
                "nodeVersion": "v24.13.0",
                "nodeModulesAbi": "137",
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
                    {"id": "claude", "path": provider_paths["claude"]},
                    {"id": "codex-wrapper", "path": provider_paths["codex-wrapper"]},
                    {"id": "codex-vendor", "path": provider_paths["codex-vendor"]},
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

    def generate(self) -> str:
        return generate_release(self.root, self.config)


def make_directory_writable(directory: Path) -> None:
    directory.chmod(0o755)


def replace_immutable_file(filename: Path, contents: bytes, *, mode: int = 0o444) -> None:
    parent = filename.parent
    previous_parent_mode = stat.S_IMODE(parent.stat().st_mode)
    make_directory_writable(parent)
    filename.chmod(0o644)
    filename.write_bytes(contents)
    filename.chmod(mode)
    parent.chmod(previous_parent_mode)


def rewrite_file_list_and_binding(root: Path, contents: bytes) -> None:
    replace_immutable_file(root / FILE_LIST_NAME, contents)
    manifest_path = root / MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text("ascii"))
    manifest["files"]["sha256"] = f"sha256:{digest(contents)}"
    manifest["files"]["size"] = len(contents)
    manifest["files"]["entries"] = contents.count(b"\n")
    replace_immutable_file(manifest_path, canonical_json_bytes(manifest))


class ReleaseClosureTests(unittest.TestCase):
    def fixture(self, directory: Path, name: str = "release") -> ReleaseFixture:
        return ReleaseFixture(directory, name)

    def test_valid_closure_binds_interpreters_host_assets_and_normalized_modes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(Path(temporary))
            generated = fixture.generate()
            verified, manifest = verify_release(fixture.root)
            self.assertEqual(verified, generated)
            self.assertEqual(manifest["hostRuntime"]["interpreterTargets"], list(INTERPRETER_TARGETS))
            self.assertEqual(manifest["hostRuntime"]["boundSourcePaths"], list(BOUND_SOURCE_PATHS))
            self.assertEqual(
                [item["path"] for item in manifest["hostRuntime"]["privilegedBrokerNativeModules"]],
                list(PRIVILEGED_BROKER_NATIVE_MODULE_PATHS),
            )
            self.assertEqual(
                [item["path"] for item in manifest["hostRuntime"]["realtimeSipNativeModules"]],
                list(REALTIME_SIP_NATIVE_MODULE_PATHS),
            )
            self.assertEqual(stat.S_IMODE(fixture.root.stat().st_mode), 0o555)
            self.assertEqual(
                stat.S_IMODE(
                    (fixture.root / "deploy/worker-session/provider-libexec.manifest").stat().st_mode
                ),
                0o444,
            )
            self.assertEqual(
                stat.S_IMODE(
                    (fixture.root / "deploy/worker-session/teleagent-worker-session-install").stat().st_mode
                ),
                0o555,
            )

    def test_manifest_requires_exact_canonical_bytes_and_key_order(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(Path(temporary))
            fixture.generate()
            manifest_path = fixture.root / MANIFEST_NAME
            manifest = json.loads(manifest_path.read_text("ascii"))
            noncanonical = (json.dumps(manifest, indent=2) + "\n").encode("ascii")
            replace_immutable_file(manifest_path, noncanonical)
            with self.assertRaisesRegex(ClosureError, "not canonical"):
                verify_release(fixture.root)

    def test_file_list_rejects_traversal_even_when_manifest_rehashes_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(Path(temporary))
            fixture.generate()
            lines = (fixture.root / FILE_LIST_NAME).read_text("ascii").splitlines()
            fields = lines[0].split("\t")
            fields[-1] = "../escape"
            lines[0] = "\t".join(fields)
            malicious = ("\n".join(lines) + "\n").encode("ascii")
            rewrite_file_list_and_binding(fixture.root, malicious)
            with self.assertRaisesRegex(ClosureError, "canonical relative path|unsafe component"):
                verify_release(fixture.root)

    def test_complete_inventory_rejects_extra_missing_and_tampered_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            extra = self.fixture(base, "extra")
            extra.generate()
            make_directory_writable(extra.root)
            (extra.root / "unlisted.env").write_text("secret-shaped-extra\n", encoding="ascii")
            (extra.root / "unlisted.env").chmod(0o444)
            extra.root.chmod(0o555)
            with self.assertRaisesRegex(ClosureError, "differs from its complete inventory"):
                verify_release(extra.root)

            missing = self.fixture(base, "missing")
            missing.generate()
            target = missing.root / "freeswitch/mrf.xml"
            parent_mode = stat.S_IMODE(target.parent.stat().st_mode)
            target.parent.chmod(0o755)
            target.unlink()
            target.parent.chmod(parent_mode)
            with self.assertRaisesRegex(ClosureError, "differs from its complete inventory"):
                verify_release(missing.root)

            tampered = self.fixture(base, "tampered")
            tampered.generate()
            target = tampered.root / "docker-compose.yml"
            replace_immutable_file(target, b"tree-B orchestration\n")
            with self.assertRaisesRegex(ClosureError, "differs from its complete inventory"):
                verify_release(tampered.root)

    def test_generation_rejects_symlinks_hardlinks_and_fifo(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            symlinked = self.fixture(base, "symlinked")
            os.symlink("docker-compose.yml", symlinked.root / "unexpected-link")
            with self.assertRaisesRegex(ClosureError, "symbolic link"):
                symlinked.generate()

            linked = self.fixture(base, "linked")
            os.link(linked.root / "docker-compose.yml", linked.root / "hard-link")
            with self.assertRaisesRegex(ClosureError, "hard-linked"):
                linked.generate()

            fifo = self.fixture(base, "fifo")
            os.mkfifo(fifo.root / "unexpected-fifo", 0o600)
            with self.assertRaisesRegex(ClosureError, "special type"):
                fifo.generate()

    def test_generation_rejects_extended_attributes_when_supported(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(Path(temporary))
            target = fixture.root / "docker-compose.yml"
            try:
                os.setxattr(target, "user.teleagent-test", b"unreviewed", follow_symlinks=False)
            except OSError as error:
                self.skipTest(f"fixture filesystem does not support user xattrs: {error}")
            with self.assertRaisesRegex(ClosureError, "extended attributes"):
                fixture.generate()

    def test_native_module_set_is_exact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            unexpected = self.fixture(base, "unexpected-native")
            unexpected.write(
                "claude-api-server/node_modules/injected/build/Release/injected.node",
                b"injected-native-code",
                executable=True,
            )
            with self.assertRaisesRegex(ClosureError, "native node_modules set"):
                unexpected.generate()

            missing = self.fixture(base, "missing-native")
            (missing.root / missing.config["hostRuntime"]["nativeModulePaths"][0]).unlink()
            with self.assertRaisesRegex(ClosureError, "native node_modules set"):
                missing.generate()

            broker_unexpected = self.fixture(base, "unexpected-broker-native")
            broker_unexpected.write(
                "privileged-action-broker/node_modules/injected/build/Release/injected.node",
                b"injected-privileged-native-code",
                executable=True,
            )
            with self.assertRaisesRegex(ClosureError, "privileged broker native node_modules set"):
                broker_unexpected.generate()

            broker_missing = self.fixture(base, "missing-broker-native")
            (broker_missing.root / PRIVILEGED_BROKER_NATIVE_MODULE_PATHS[0]).unlink()
            with self.assertRaisesRegex(ClosureError, "privileged broker native node_modules set"):
                broker_missing.generate()

            sip_unexpected = self.fixture(base, "unexpected-sip-native")
            sip_unexpected.write(
                "realtime-sip-gateway/node_modules/injected/build/Release/injected.node",
                b"injected-realtime-sip-native-code",
                executable=True,
            )
            with self.assertRaisesRegex(ClosureError, "realtime SIP gateway native node_modules set"):
                sip_unexpected.generate()

            sip_missing = self.fixture(base, "missing-sip-native")
            (sip_missing.root / REALTIME_SIP_NATIVE_MODULE_PATHS[0]).unlink()
            with self.assertRaisesRegex(ClosureError, "realtime SIP gateway native node_modules set"):
                sip_missing.generate()

    def test_provider_voice_and_sbom_cross_bindings_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            provider = self.fixture(base, "provider")
            manifest_path = provider.root / provider.config["providerCli"]["manifestPath"]
            document = json.loads(manifest_path.read_text("utf-8"))
            document["artifacts"][0]["sha256"] = "d" * 64
            manifest_path.write_text(json.dumps(document) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ClosureError, "differs from its CLI manifest"):
                provider.generate()

            voice = self.fixture(base, "voice")
            voice_path = voice.root / voice.config["voiceImage"]["manifestPath"]
            document = json.loads(voice_path.read_text("ascii"))
            document["sourceRevision"] = "e" * 40
            voice_path.write_bytes(canonical_json_bytes(document))
            with self.assertRaisesRegex(ClosureError, "differs from the host release"):
                voice.generate()

            sbom = self.fixture(base, "sbom")
            sbom_path = sbom.root / sbom.config["sbom"]["voiceImagePath"]
            sbom_path.write_text(
                json.dumps({"bomFormat": "CycloneDX", "specVersion": "1.5"}) + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ClosureError, "CycloneDX 1.6"):
                sbom.generate()

    def test_host_bound_source_set_cannot_omit_canary_dependency(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(Path(temporary))
            fixture.config["hostRuntime"]["boundSourcePaths"] = list(BOUND_SOURCE_PATHS[:-1])
            with self.assertRaisesRegex(ClosureError, "source bindings are incomplete"):
                fixture.generate()

    def test_double_packaging_is_byte_identical(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            first = self.fixture(base, "first")
            second = self.fixture(base, "second")
            first_digest = first.generate()
            second_digest = second.generate()
            self.assertEqual(first_digest, second_digest)
            self.assertEqual(
                (first.root / FILE_LIST_NAME).read_bytes(),
                (second.root / FILE_LIST_NAME).read_bytes(),
            )
            first_tar = base / "first.tar"
            second_tar = base / "second.tar"
            first_bundle = package_release(first.root, first_tar, source_date_epoch=1_700_000_000)
            second_bundle = package_release(second.root, second_tar, source_date_epoch=1_700_000_000)
            self.assertEqual(first_bundle, second_bundle)
            self.assertEqual(first_tar.read_bytes(), second_tar.read_bytes())
            self.assertEqual(stat.S_IMODE(first_tar.stat().st_mode), 0o444)

    def test_metadata_symlink_and_hardlink_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            symlinked = self.fixture(base, "metadata-symlink")
            symlinked.generate()
            symlinked.root.chmod(0o755)
            (symlinked.root / MANIFEST_NAME).unlink()
            os.symlink(FILE_LIST_NAME, symlinked.root / MANIFEST_NAME)
            symlinked.root.chmod(0o555)
            with self.assertRaisesRegex(ClosureError, "unsafe type"):
                verify_release(symlinked.root)

            linked = self.fixture(base, "metadata-hardlink")
            linked.generate()
            linked.root.chmod(0o755)
            (linked.root / MANIFEST_NAME).unlink()
            os.link(linked.root / FILE_LIST_NAME, linked.root / MANIFEST_NAME)
            linked.root.chmod(0o555)
            with self.assertRaisesRegex(ClosureError, "unsafe type"):
                verify_release(linked.root)

    def test_mixed_or_non_release_modes_are_rejected_after_generation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(Path(temporary))
            fixture.generate()
            target = fixture.root / "docker-compose.yml"
            target.chmod(0o644)
            with self.assertRaisesRegex(ClosureError, "mode is not exactly"):
                verify_release(fixture.root)


if __name__ == "__main__":
    unittest.main()
