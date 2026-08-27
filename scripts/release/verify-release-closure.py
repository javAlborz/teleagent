#!/usr/bin/env python3
"""Check a Teleagent v2 release closure without executing release code."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from release_closure import ClosureError, verify_release


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description=(
            "Perform the non-authoritative build-side byte, inventory, metadata, "
            "and cross-artifact verification for an extracted release closure."
        )
    )
    result.add_argument("--root", required=True, type=Path, help="extracted immutable release tree")
    result.add_argument("--expected-uid", type=int, help="require every release entry to have this uid")
    result.add_argument("--expected-gid", type=int, help="require every release entry to have this gid")
    return result


def main(argv: list[str] | None = None) -> int:
    arguments = parser().parse_args(argv)
    try:
        manifest_digest, _manifest = verify_release(
            arguments.root,
            expected_uid=arguments.expected_uid,
            expected_gid=arguments.expected_gid,
        )
    except ClosureError as error:
        sys.stderr.write(f"{error}\n")
        return 77
    sys.stdout.write(f"TELEAGENT_RELEASE_CLOSURE_OK {manifest_digest}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
