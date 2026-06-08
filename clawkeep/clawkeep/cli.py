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
from . import passphrase as passphrase_mod
from . import restore as restore_mod
from . import s3, token


USAGE = """\
usage: clawkeep <command> [args...]

Commands:
  pair             Pair this device with a portal account
  daemon           Run a single backup cycle (alias for `clawkeepd`)
  snapshots        List cloud snapshots (JSON to stdout)
  restore          Restore a snapshot over the live state directory
  label            Set/clear a snapshot's human label (manifest)
  lock             Mark a snapshot as protected (never auto/manually deleted)
  unlock           Remove a snapshot's protected flag
  delete           Delete a snapshot (refused if locked)
  prune            Apply retention now (keep newest N unlocked snapshots)
  set-passphrase   Set the device-local backup encryption passphrase
  clear-passphrase Remove the stored passphrase (future backups will need a new one)
  passphrase-status Print {"set": bool} as JSON
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
    if cmd == "label":
        return _label_main(rest)
    if cmd == "lock":
        return _lock_main(rest, locked=True)
    if cmd == "unlock":
        return _lock_main(rest, locked=False)
    if cmd == "delete":
        return _delete_main(rest)
    if cmd == "prune":
        return _prune_main(rest)
    if cmd == "set-passphrase":
        return _set_passphrase_main(rest)
    if cmd == "clear-passphrase":
        return _clear_passphrase_main(rest)
    if cmd == "passphrase-status":
        return _passphrase_status_main(rest)
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
    """`clawkeep restore <name> [--config PATH] [--passphrase-file PATH]` —
    destructive: overwrites the live state directory after moving it
    aside to `.bak-restore-<ts>`.

    `--passphrase-file` lets the API route hand a one-shot password
    (written to a 0600 tmpfile from a UI prompt) to the daemon without
    the password ever touching argv. When omitted, the daemon falls back
    to the device-local stored passphrase, then surfaces a structured
    error if neither is available.
    """
    import argparse

    parser = argparse.ArgumentParser(prog="clawkeep restore")
    parser.add_argument("name", help="snapshot name from `clawkeep snapshots`")
    parser.add_argument("--config", default=None)
    parser.add_argument(
        "--passphrase-file",
        default=None,
        help="path to a file containing the decryption passphrase",
    )
    args = parser.parse_args(argv)

    try:
        cfg, bearer = _load_cfg_and_token(args.config)
        result = restore_mod.restore_snapshot(
            cfg,
            bearer,
            args.name,
            passphrase_file=Path(args.passphrase_file) if args.passphrase_file else None,
        )
    except (cfg_mod.ConfigError, token.TokenError) as e:
        return _emit_err(e, 64)
    except restore_mod.WrongPasswordError as e:
        # Distinct status so the UI can prompt for re-entry instead of
        # rendering a generic "restore failed" with no recourse.
        print(json.dumps({"ok": False, "error": str(e), "kind": "wrong_password"}))
        return 2
    except restore_mod.PassphraseMissingError as e:
        print(json.dumps({"ok": False, "error": str(e), "kind": "passphrase_missing"}))
        return 3
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


def _mint_creds(config_path: str | None):
    """Shared setup for the manifest/snapshot-management subcommands: parse
    config, load the token, mint short-lived R2 credentials."""
    cfg, bearer = _load_cfg_and_token(config_path)
    from . import api
    return api.mint_credentials(cfg.server, bearer)


def _manifest_entry(manifest: dict, name: str) -> dict:
    """Return the manifest entry for `name`, creating a default one in place
    if absent. New entries are stamped with createdAt=now so a snapshot first
    annotated via label/lock still gets a creation time."""
    from . import api
    snaps = manifest.setdefault("snapshots", {})
    entry = snaps.get(name)
    if not isinstance(entry, dict):
        entry = {"label": None, "locked": False, "createdAt": api.now_ms()}
        snaps[name] = entry
    return entry


def _label_main(argv: list[str]) -> int:
    """`clawkeep label <objectName> --text "<label>"` — set or clear a
    snapshot's human label in the manifest. An empty/whitespace text clears
    the label (sets it to null)."""
    import argparse

    parser = argparse.ArgumentParser(prog="clawkeep label")
    parser.add_argument("name", help="snapshot object name")
    parser.add_argument("--text", default="", help="label text; empty clears it")
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    text = args.text.strip()
    new_label = text if text else None
    try:
        creds = _mint_creds(args.config)
        manifest = s3.read_manifest(creds)
        entry = _manifest_entry(manifest, args.name)
        entry["label"] = new_label
        s3.write_manifest(creds, manifest)
    except (cfg_mod.ConfigError, token.TokenError) as e:
        return _emit_err(e, 64)
    except Exception as e:  # noqa: BLE001
        return _emit_err(e, 1)

    print(json.dumps({"ok": True, "name": args.name, "label": new_label}))
    return 0


def _lock_main(argv: list[str], *, locked: bool) -> int:
    """`clawkeep lock|unlock <objectName>` — toggle a snapshot's protected
    flag in the manifest. A locked snapshot can't be deleted manually or by
    auto-cleanup until it's unlocked."""
    import argparse

    prog = "clawkeep lock" if locked else "clawkeep unlock"
    parser = argparse.ArgumentParser(prog=prog)
    parser.add_argument("name", help="snapshot object name")
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    try:
        creds = _mint_creds(args.config)
        manifest = s3.read_manifest(creds)
        entry = _manifest_entry(manifest, args.name)
        entry["locked"] = locked
        s3.write_manifest(creds, manifest)
    except (cfg_mod.ConfigError, token.TokenError) as e:
        return _emit_err(e, 64)
    except Exception as e:  # noqa: BLE001
        return _emit_err(e, 1)

    print(json.dumps({"ok": True, "name": args.name, "locked": locked}))
    return 0


def _delete_main(argv: list[str]) -> int:
    """`clawkeep delete <objectName>` — delete a snapshot object + its
    manifest entry. Refused (exit 2, kind="locked") if the snapshot is
    locked; the UI surfaces that as "Unlock first"."""
    import argparse

    parser = argparse.ArgumentParser(prog="clawkeep delete")
    parser.add_argument("name", help="snapshot object name")
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    try:
        creds = _mint_creds(args.config)
        manifest = s3.read_manifest(creds)
        snaps = manifest.get("snapshots", {})
        entry = snaps.get(args.name) if isinstance(snaps, dict) else None
        if isinstance(entry, dict) and bool(entry.get("locked", False)):
            print(json.dumps({
                "ok": False,
                "kind": "locked",
                "error": f"snapshot {args.name} is locked; unlock it before deleting",
            }))
            return 2
        s3.delete_snapshot(creds, args.name)
        if isinstance(snaps, dict) and args.name in snaps:
            snaps.pop(args.name, None)
            s3.write_manifest(creds, manifest)
    except (cfg_mod.ConfigError, token.TokenError) as e:
        return _emit_err(e, 64)
    except Exception as e:  # noqa: BLE001
        return _emit_err(e, 1)

    print(json.dumps({"ok": True, "name": args.name}))
    return 0


def _prune_main(argv: list[str]) -> int:
    """`clawkeep prune --keep-last N` — run retention on demand: keep the
    newest N unlocked snapshots, delete the rest. Locked snapshots are
    always kept and don't count toward N. N<=0 is a no-op."""
    import argparse

    parser = argparse.ArgumentParser(prog="clawkeep prune")
    parser.add_argument("--keep-last", type=int, required=True, dest="keep_last")
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    try:
        from . import runner
        creds = _mint_creds(args.config)
        deleted = runner.apply_retention(creds, args.keep_last)
    except (cfg_mod.ConfigError, token.TokenError) as e:
        return _emit_err(e, 64)
    except Exception as e:  # noqa: BLE001
        return _emit_err(e, 1)

    print(json.dumps({"ok": True, "deleted": deleted, "keepLast": args.keep_last}))
    return 0


def _set_passphrase_main(argv: list[str]) -> int:
    """`clawkeep set-passphrase --from-file PATH` — read a passphrase from
    a 0600 tmpfile (so it never enters argv) and persist it on the device.

    The TS bridge writes the tmpfile then invokes this; the file is
    unlinked on either side once the call returns. `--config` is accepted
    (and ignored) because the bridge appends it uniformly to every
    subcommand for the snapshot/restore flow.
    """
    import argparse

    parser = argparse.ArgumentParser(prog="clawkeep set-passphrase")
    parser.add_argument(
        "--from-file",
        required=True,
        help="path to a tmpfile containing the new passphrase (mode 0600)",
    )
    parser.add_argument("--config", default=None, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    try:
        src = Path(args.from_file)
        if not src.is_file():
            raise passphrase_mod.PassphraseError(f"input file does not exist: {src}")
        # Strip a single trailing newline so a `printf '%s\n' "$pw" > tmpfile`
        # doesn't produce a passphrase ending in `\n`.
        new_pw = src.read_text(encoding="utf-8").rstrip("\r\n")
        passphrase_mod.write(new_pw)
    except passphrase_mod.PassphraseError as e:
        return _emit_err(e, 64)
    except Exception as e:  # noqa: BLE001
        return _emit_err(e, 99)

    print(json.dumps({"ok": True}))
    return 0


def _clear_passphrase_main(argv: list[str]) -> int:
    """`clawkeep clear-passphrase` — remove the stored passphrase. Future
    unattended backups will refuse to run until a new one is set; existing
    cloud archives stay encrypted with the old passphrase, and restoring
    them needs that passphrase typed back in via the UI.

    Accepts (and ignores) `--config` since the TS bridge appends it
    uniformly across subcommands.
    """
    import argparse

    parser = argparse.ArgumentParser(prog="clawkeep clear-passphrase")
    parser.add_argument("--config", default=None, help=argparse.SUPPRESS)
    parser.parse_args(argv)

    try:
        removed = passphrase_mod.clear()
    except passphrase_mod.PassphraseError as e:
        return _emit_err(e, 1)
    except Exception as e:  # noqa: BLE001
        return _emit_err(e, 99)
    print(json.dumps({"ok": True, "removed": removed}))
    return 0


def _passphrase_status_main(argv: list[str]) -> int:
    """JSON probe used by the UI to decide whether to show the
    "Set encryption passphrase" CTA. Cheap — single stat call.

    Accepts (and ignores) `--config` since the TS bridge appends it
    uniformly across subcommands.
    """
    import argparse

    parser = argparse.ArgumentParser(prog="clawkeep passphrase-status")
    parser.add_argument("--config", default=None, help=argparse.SUPPRESS)
    parser.parse_args(argv)
    print(json.dumps({"ok": True, "set": passphrase_mod.is_set()}))
    return 0


if __name__ == "__main__":
    sys.exit(clawkeep_main())
