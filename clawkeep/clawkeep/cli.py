"""Tiny dispatcher so the two console-scripts share one binary spec.

`clawkeep`   → subcommands (currently just `pair`)
`clawkeepd`  → the daemon entrypoint
"""

from __future__ import annotations

import sys


def clawkeep_main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print("usage: clawkeep <command> [args...]")
        print()
        print("Commands:")
        print("  pair    Pair this device with a portal account")
        print("  daemon  Run a single backup cycle (alias for `clawkeepd`)")
        return 0 if argv else 64

    cmd, rest = argv[0], argv[1:]
    if cmd == "pair":
        from . import pair
        return pair.main(rest)
    if cmd == "daemon":
        from . import daemon
        return daemon.main(rest)
    print(f"clawkeep: unknown command {cmd!r}", file=sys.stderr)
    return 64


def clawkeepd_main(argv: list[str] | None = None) -> int:
    from . import daemon
    return daemon.main(argv)


if __name__ == "__main__":
    sys.exit(clawkeep_main())
