#!/usr/bin/env python3
from __future__ import annotations

import argparse
import uuid

PREFIXES = {
    "run": "run", "signal": "sig", "signal_change": "schg", "signal_revision": "srev",
    "topic": "top", "topic_change": "tchg", "topic_revision": "trev", "candidate": "cand",
    "forecast": "fc", "forecast_evaluation": "fce", "suppression_group": "sg",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=sorted(PREFIXES))
    parser.add_argument("--count", type=int, default=1)
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be at least 1")
    for _ in range(args.count):
        print(f"{PREFIXES[args.kind]}-{uuid.uuid4()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
