"""Tiny dispatcher so the two console-scripts share one binary spec.

`clawkeep`   → subcommands (pair, daemon, snapshots, restore)
`clawkeepd`  → the daemon entrypoint
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path

from . import config as cfg_mod
from . import restore as restore_mod
from . import s3, token


USAGE = """\
usage: clawkeep <command> [args...]

Commands:
  pair        Pair this device with a portal account
  daemon      Run a single backup cycle (alias for `clawkeepd`)
  snapshots   List cloud snapshots (JSON to stdout)
  restore     Restore a snapshot over the live state directory
"""


def clawkeep_main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print(USAGE)
        return 0 if argv else 64

    cmd, rest = argv[0], argv[1:]
    if cmd == "pair":
        from . import pair
        return pair.main(rest)
    if cmd == "daemon":
        from . import daemon
        return daemon.main(rest)
    if cmd == "snapshots":
        return _snapshots_main(rest)
    if cmd == "restore":
        return _restore_main(rest)
    print(f"clawkeep: unknown command {cmd!r}", file=sys.stderr)
    return 64


def clawkeepd_main(argv: list[str] | None = None) -> int:
    from . import daemon
    return daemon.main(argv)


def _load_cfg_and_token(config_path: str | None) -> tuple[cfg_mod.Config, str]:
    """Both `snapshots` and `restore` need the same setup the daemon does:
    parse config.toml, load the bearer token. Centralised so the two
    subcommands stay in lockstep with daemon.py."""
    p = Path(config_path) if config_path else cfg_mod.default_config_path()
    cfg = cfg_mod.load(p)
    bearer = token.read_token(token.default_token_path())
    return cfg, bearer


def _emit_err(e: Exception, rc: int) -> int:
    """JSON error envelope on stdout. The TS bridge reads stdout; stderr is
    a fallback for non-JSON failures, so emit JSON even when something
    upstream of the JSON-friendly code path raised."""
    print(json.dumps({"ok": False, "error": str(e)}))
    return rc


def _snapshots_main(argv: list[str]) -> int:
    """`clawkeep snapshots [--config PATH]` → newest-first JSON list to stdout.

    JSON-only output: this command exists so the TS bridge can spawn it and
    parse the result. A human-friendly mode would just be a `jq` away.
    """
    import argparse

    parser = argparse.ArgumentParser(prog="clawkeep snapshots")
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    try:
        cfg, bearer = _load_cfg_and_token(args.config)
        from . import api
        creds = api.mint_credentials(cfg.server, bearer)
        snapshots = s3.list_snapshots(creds)
    except (cfg_mod.ConfigError, token.TokenError) as e:
        return _emit_err(e, 64)
    except Exception as e:  # noqa: BLE001 — surface every error path as JSON
        return _emit_err(e, 1)

    print(json.dumps({
        "ok": True,
        "snapshots": [asdict(s) for s in snapshots],
        "quotaBytes": creds.quotaBytes,
        "cloudBytes": creds.cloudBytes,
    }))
    return 0


def _restore_main(argv: list[str]) -> int:
    """`clawkeep restore <name> [--config PATH]` — destructive: overwrites
    the live state directory after moving it aside to `.bak-restore-<ts>`.
    """
    import argparse

    parser = argparse.ArgumentParser(prog="clawkeep restore")
    parser.add_argument("name", help="snapshot name from `clawkeep snapshots`")
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    try:
        cfg, bearer = _load_cfg_and_token(args.config)
        result = restore_mod.restore_snapshot(cfg, bearer, args.name)
    except (cfg_mod.ConfigError, token.TokenError) as e:
        return _emit_err(e, 64)
    except restore_mod.RestoreError as e:
        return _emit_err(e, 1)
    except Exception as e:  # noqa: BLE001
        return _emit_err(e, 99)

    print(json.dumps({
        "ok": True,
        "archive": result.archive_name,
        "archiveBytes": result.archive_size_bytes,
        "assets": [
            {
                "kind": a.kind,
                "targetPath": str(a.target_path),
                "backupPath": str(a.backup_path),
                "bytesRestored": a.bytes_restored,
            }
            for a in result.assets
        ],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(clawkeep_main())
