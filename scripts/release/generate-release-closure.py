#!/usr/bin/env python3
"""Generate Teleagent's non-authoritative build-side release closure."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from release_closure import ClosureError, generate_release, load_build_input, package_release


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description=(
            "Normalize a prepared Teleagent staging tree, generate its canonical v2 "
            "manifest and complete file inventory, and optionally create a deterministic tar."
        )
    )
    result.add_argument("--root", required=True, type=Path, help="fresh prepared release staging tree")
    result.add_argument(
        "--build-input", required=True, type=Path, help="external build-input JSON described in docs/RELEASE-CLOSURE.md"
    )
    result.add_argument("--expected-uid", type=int, help="require every staged entry to have this uid")
    result.add_argument("--expected-gid", type=int, help="require every staged entry to have this gid")
    result.add_argument("--bundle", type=Path, help="optional uncompressed deterministic tar output")
    result.add_argument(
        "--source-date-epoch",
        type=int,
        help="required with --bundle; normally the reviewed source commit timestamp",
    )
    return result


def main(argv: list[str] | None = None) -> int:
    arguments = parser().parse_args(argv)
    if (arguments.bundle is None) != (arguments.source_date_epoch is None):
        parser().error("--bundle and --source-date-epoch must be supplied together")
    try:
        build_input = load_build_input(arguments.build_input)
        manifest_digest = generate_release(
            arguments.root,
            build_input,
            expected_uid=arguments.expected_uid,
            expected_gid=arguments.expected_gid,
        )
        bundle_digest = None
        if arguments.bundle is not None:
            bundle_digest = package_release(
                arguments.root,
                arguments.bundle,
                source_date_epoch=arguments.source_date_epoch,
                expected_uid=arguments.expected_uid,
                expected_gid=arguments.expected_gid,
            )
    except ClosureError as error:
        sys.stderr.write(f"{error}\n")
        return 77
    sys.stdout.write(f"TELEAGENT_RELEASE_CLOSURE_GENERATED {manifest_digest}")
    if bundle_digest is not None:
        sys.stdout.write(f" {bundle_digest}")
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
