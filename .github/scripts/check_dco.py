#!/usr/bin/env python3
"""Fail when a commit in a revision range lacks a DCO sign-off trailer."""

from __future__ import annotations

import re
import subprocess
import sys

SIGNOFF = re.compile(
    r"^Signed-off-by:\s+.+\s+<[^<>@\s]+@[^<>\s]+>$",
    re.IGNORECASE | re.MULTILINE,
)


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: check_dco.py <base-sha> <head-sha>", file=sys.stderr)
        return 2
    base, head = sys.argv[1:]
    commits = subprocess.check_output(
        ["git", "rev-list", "--reverse", f"{base}..{head}"],
        text=True,
    ).splitlines()
    missing: list[str] = []
    for commit in commits:
        message = subprocess.check_output(
            ["git", "show", "-s", "--format=%B", commit],
            text=True,
        )
        if not SIGNOFF.search(message):
            missing.append(commit)

    if missing:
        print("Commits missing a Signed-off-by DCO trailer:")
        for commit in missing:
            subject = subprocess.check_output(
                ["git", "show", "-s", "--format=%s", commit],
                text=True,
            ).strip()
            print(f"- {commit[:12]} {subject}")
        return 1

    print(f"DCO sign-off present on {len(commits)} commit(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
