"""A stand-in `openclaw` CLI for the suites that drive `backup create` end to end.

It answers `backup create --dry-run --json` and `backup create --json --output
<dir>` the way OpenClaw 2026.9.4 does, applying the core's OWN rules for the
three gates the field failures came from, with its sentences verbatim:

  * `assertArchiveSymbolicLinkTarget` — an absolute link whose real target is
    outside every declared asset is refused ("must be relative"); a relative
    one that lands outside is refused ("outside the declared backup assets");
  * `createVerifiedSqliteSnapshot` — every `*.sqlite` must pass a full
    `integrity_check` and an empty `foreign_key_check`;
  * the regenerable roots the plan skips are not walked.

Knobs, all environment variables:
  FAKE_OPENCLAW_STATE        the state dir (required)
  FAKE_OPENCLAW_EXTRA_ASSETS JSON list of extra dry-run assets
  FAKE_OPENCLAW_FAILURES     a file of one failure sentence per line; each
                             `create` pops the first and fails with it
  FAKE_OPENCLAW_LEAVE        "1": a popped failure first publishes the archive
                             into the output dir, as a failed `--verify` does
  FAKE_OPENCLAW_CALLS        a file each call appends its argv to (JSON lines)
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tarfile

ROOT = "2026-09-24T03-00-00.000Z-openclaw-backup"


def archive_path(source: str) -> str:
    return f"{ROOT}/payload/posix/{source.lstrip('/')}"


def inside(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": {"type": "cli_error", "message": message}}))
    sys.stderr.write(f"[openclaw] Could not start the CLI.\n[openclaw] Reason: {message}\n")
    sys.exit(1)


def main() -> None:
    args = sys.argv[1:]
    state = os.environ["FAKE_OPENCLAW_STATE"]
    calls = os.environ.get("FAKE_OPENCLAW_CALLS")
    if calls:
        with open(calls, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(args) + "\n")

    assets = [{"kind": "state", "sourcePath": state, "archivePath": archive_path(state)}]
    assets += json.loads(os.environ.get("FAKE_OPENCLAW_EXTRA_ASSETS", "[]"))
    regenerable = os.path.join(state, "npm")
    skipped = [{"kind": "managed state", "sourcePath": regenerable, "reason": "regenerable"}]

    if args[:2] != ["backup", "create"]:
        fail(f"unexpected command {args!r}")
    if "--dry-run" in args:
        plan = {"archiveRoot": ROOT, "dryRun": True, "assets": assets, "skipped": skipped}
        print(json.dumps(plan))
        return

    output = args[args.index("--output") + 1]
    target = os.path.join(output, f"{ROOT}.tar.gz")

    queue = os.environ.get("FAKE_OPENCLAW_FAILURES")
    if queue and os.path.exists(queue):
        with open(queue, encoding="utf-8") as fh:
            lines = [line.rstrip("\n") for line in fh if line.strip()]
        if lines:
            with open(queue, "w", encoding="utf-8") as fh:
                fh.write("".join(f"{line}\n" for line in lines[1:]))
            if os.environ.get("FAKE_OPENCLAW_LEAVE") == "1":
                with tarfile.open(target, "w:gz") as tf:
                    tf.add(state, arcname=archive_path(state), recursive=False)
            fail(lines[0])

    roots = [a["sourcePath"] for a in assets]
    members: list[tuple[str, str]] = []
    for asset in assets:
        for dirpath, dirnames, filenames in os.walk(asset["sourcePath"]):
            dirnames[:] = sorted(
                d for d in dirnames if not inside(os.path.join(dirpath, d), regenerable)
            )
            members.append((dirpath, archive_path(dirpath)))
            for name in sorted(filenames) + sorted(
                d for d in os.listdir(dirpath)
                if os.path.islink(os.path.join(dirpath, d)) and d not in filenames
            ):
                path = os.path.join(dirpath, name)
                if inside(path, regenerable):
                    continue
                if os.path.islink(path):
                    link = os.readlink(path)
                    if os.path.isabs(link):
                        try:
                            real = os.path.realpath(link, strict=True)
                        except OSError:
                            real = None
                        if real is None or not any(inside(real, r) for r in roots):
                            fail(
                                "Backup archive write failed: Archive symbolic link target must "
                                f"be relative: {archive_path(path)} -> {link} (after 1 attempt)",
                            )
                    else:
                        landed = os.path.normpath(os.path.join(dirpath, link))
                        if not any(inside(landed, r) for r in roots):
                            fail(
                                "Backup archive write failed: Archive symbolic link is outside "
                                f"the declared backup assets: {archive_path(path)} -> {link} "
                                "(after 1 attempt)",
                            )
                elif name.endswith(".sqlite"):
                    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
                    try:
                        rows = [str(r[0]) for r in conn.execute("PRAGMA integrity_check")]
                        fks = conn.execute("PRAGMA foreign_key_check").fetchall()
                    finally:
                        conn.close()
                    if rows != ["ok"] or fks:
                        detail = "; ".join(rows) if rows != ["ok"] else "foreign key violations"
                        fail(
                            f"SQLite database cannot be compacted safely for backup: {path}. "
                            f"SQLite integrity_check failed for {path}: {detail}. The source must "
                            "pass full integrity checks, online SQLite backup, and offline "
                            "compaction with its required SQLite capabilities; a direct file copy "
                            "was refused because it can retain deleted data.",
                        )
                members.append((path, archive_path(path)))

    with tarfile.open(target, "w:gz") as tf:
        for path, name in members:
            tf.add(path, arcname=name, recursive=False)
    print(json.dumps({
        "createdAt": "2026-09-24T03:00:00.000Z",
        "archiveRoot": ROOT,
        "archivePath": target,
        "assets": assets,
        "skipped": skipped,
        "verified": "--verify" in args,
    }))


if __name__ == "__main__":
    main()
