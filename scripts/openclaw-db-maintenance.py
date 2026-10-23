#!/usr/bin/env python3
"""OpenClaw SQLite housekeeping for the gateway pre-start and the installer.

The agent databases (`agents/<id>/agent/openclaw-agent.sqlite`) are where
OpenClaw keeps sessions, transcripts AND its memory-search index. A customer box
with ~10 GB agent databases showed three ways they grow past what a Jetson can
carry, and this is ClawBox's half of each, driving OpenClaw's OWN commands:

``prestart``  (run by scripts/gateway-pre-start.sh, gateway stopped)
    1. Writes ``data/openclaw-migration-status.json``: whether every database
       is on the schema the installed core declares
       (``package.json`` → ``openclaw.schemaVersions``). A 10.x gateway on 9.x
       agent databases reports ready while every agent is degraded; this file
       is what the web server reads so the owner is told instead
       (``src/lib/openclaw-migration-status.ts``).
    2. Compacts, with ``openclaw doctor --session-sqlite compact
       --session-sqlite-agent <id> --json`` (and ``--state-sqlite compact`` for
       the shared state database), every database whose free pages are over
       the threshold (30 %) — the pages a schema migration or a large delete
       leaves behind, which OpenClaw's routine incremental auto_vacuum never
       returns to the filesystem. Also every database a schema migration has
       left a ``*.pre-startup-migration-*.bak`` group beside, whatever its
       free pages: that run is the integrity check the clean-up below needs.
       Only when the filesystem has at least the database's size free, and
       only while the time budget the pre-start passes lasts.
    3. Removes the migration's rollback copies (the ``.bak`` groups beside the
       databases, and ``<state-dir>.update-captures/``) once the migration is
       VERIFIED: every database on the declared schema, no incomplete doctor
       run recorded for this core, and a successful compaction — which runs
       OpenClaw's ``quick_check``/``integrity_check``/``foreign_key_check`` —
       of the database AFTER its copy was taken. And only once the gateway has
       STARTED on the migrated databases (``start-guard`` below records that):
       a database can pass every SQLite check and still hold a row the core
       refuses at startup, and the copy is then the way back.

``start-guard`` (run by scripts/gateway-pre-start.sh, first, gateway stopped)
    A single row the core refuses in the default agent's database (or the
    shared one) stops the gateway from starting, and ``Restart=always`` then
    restarts it every few seconds with nothing changing. When the unit has
    restarted itself three times running and the gateway's own output names a
    database it refused, this runs the core's own repair (``doctor --fix``,
    then ``doctor --session-sqlite recover``, which renames a corrupt set aside
    rather than deleting it); when the next start still fails on a database,
    it puts back the newest pre-update copy of THAT database, setting the
    current one aside, never deleting it. What it did is recorded in
    ``data/openclaw-start-guard.json`` for the owner
    (``src/lib/openclaw-start-recovery.ts``).

``preflight`` (run by install.sh before it promotes a new core / runs doctor)
    Refuses (exit 3) a core OLDER than the databases on disk — one a newer core
    has migrated, which every older core refuses and its doctor cannot repair —
    unless the owner's override (``data/harness-downgrade.json``) names this
    core, in which case exactly those databases are moved beside the backup the
    override took first. Then measures the databases the core would migrate and
    refuses (exit 3) when the filesystem cannot hold the migration's copies.

``record-doctor`` (run by install.sh after ``doctor --fix``)
    Records the migration verdict for the status file.

``memory-rebuild`` (detached from the pre-start, runs after the gateway starts)
    Runs ``openclaw memory index --force`` once after the box changed the
    memory index's identity (see the memory block in gateway-pre-start.sh),
    preceded by ``openclaw memory reset --yes`` only when the MODEL changed;
    bounded, niced, never twice at once, at most three attempts. Reads back
    (read-only) what the core built, and says so when it built the index
    keyword-only — text and no vectors, the core's fallback when no embedder
    answers — rather than reporting a rebuild.

``breaker-watch`` (detached from the pre-start after a ``start-guard`` recovery)
    The failed starts before a recovery trip the core's restart-loop breaker,
    and the recovered start then holds channel auto-start back (Telegram,
    Discord, ...). The core lifts that itself once the gateway has run through
    the breaker's window; this follows the gateway's own log until it says so,
    records in ``data/openclaw-start-guard.json`` (``channels``) whether
    channels are still held back, for the owner, and only when the core has not
    lifted it in time starts the held channels with the core's documented
    manual override (``openclaw gateway call channels.start``).

Nothing here writes an OpenClaw database: measurements open them READ-ONLY,
every change is the core's own command. The one thing deleted by hand is the
migration's rollback copies, and only under the verification above — the core's
own ``openclaw update cleanup`` is asked first, but it keeps every group until
its OWN updater has recorded a later successful update, which ClawBox, which
installs the pinned core with npm, never does. Two things are MOVED by hand. A
database newer than the core being installed, under the owner's override only:
OpenClaw has no downgrade of its own (its docs: install a build that supports
the schema, restore a backup matching the older build, or give the older build
a separate state dir; ``doctor --fix`` cannot repair a newer schema), so the
files go, whole and unedited, beside the backup taken first, and the older core
creates fresh ones — the separate state the core's own advice describes, for
exactly the databases it cannot open.
And ``start-guard``'s restore of a rollback copy, for which the core has no
command either: its ``backup sqlite restore`` takes only its own snapshots,
and its docs keep these groups for the operator "to restore the matching
database generation".

Exit status is 0 except ``preflight``'s refusal (3) and usage errors (2): this
runs inside a blocking ExecStartPre, and a housekeeping failure must cost the
box its housekeeping, never its gateway.
"""

import argparse
import errno
import fcntl
import json
import os
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request

AGENT_DB_NAME = "openclaw-agent.sqlite"
BACKUP_MARK = ".pre-startup-migration-"
CAPTURE_MARKER = ".openclaw-private-update-capture"
CAPTURE_MARKER_TEXT = "openclaw-private-update-capture-v1\n"
AGENT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")

STATUS_FILE = "openclaw-migration-status.json"
# The owner's override for installing an older core (src/lib/harness-downgrade-backup.ts),
# how long it stands, and where under its backup the newer databases go.
DOWNGRADE_AUTHORIZATION_FILE = "harness-downgrade.json"
DOWNGRADE_AUTHORIZATION_TTL_S = 12 * 3600
SET_ASIDE_DIR = "openclaw-newer-schema"
RECORD_FILE = "openclaw-db-maintenance.json"
MEMORY_REBUILD_FILE = "openclaw-memory-rebuild.json"
# The lock scripts/ensure-local-embeddings.sh holds for its own `memory index
# --force`: shared, so the two rebuilds can never run at the same time.
EMBED_LOCK_FILE = "local-embeddings.state.lock"

# Free-page share above which a database is compacted.
DEFAULT_THRESHOLD = 0.30
# Compaction speed on a Jetson Orin Nano, measured on a 9.8 GB agent database
# with 48 % free pages: 248 s for ~5.0 GB of live data, ~20 MB/s of what
# VACUUM copies. Planned at 16 MiB/s (a fifth slower) plus the CLI's start.
DEFAULT_LIVE_RATE_BPS = 16 * 1024 * 1024
CLI_OVERHEAD_S = 20
# A schema migration keeps a verified copy of every database it advances
# (`<db>.pre-startup-migration-<id>.bak`), a pre-repair capture, and needs the
# migrated database and its WAL beside them: the 9.x -> 10.x migration of a
# ~10 GB box needed 30-56 GB free. Planned at six times the databases it
# migrates plus a gigabyte, the top of that range.
DEFAULT_MIGRATION_FACTOR = 6.0
DEFAULT_MIGRATION_MARGIN = 1024 * 1024 * 1024

# ── start-guard ───────────────────────────────────────────────────────────
GUARD_FILE = "openclaw-start-guard.json"
GATEWAY_UNIT = "clawbox-gateway.service"
# What journald calls this pre-start's own output (and the CLIs it runs).
PRESTART_IDENT = "gateway-pre-start.sh"
# Automatic restarts in a row before a failing start is called a loop. The
# incident behind this was a dozen in eight minutes; three is the second minute.
LOOP_RESTARTS = 3
# ...all inside this window: three crashes over a month are not a loop.
LOOP_WINDOW_S = 1800
# An action is answered by the starts right after it; StartLimitBurst=20 per
# hour ends any loop long before this, so an older one is a new episode.
EPISODE_S = 3600
# Rollback copies are kept this long at most without proof that the gateway
# started on the migrated databases (no journal access, /tmp wiped by a reboot).
COPY_PROOF_MAX_AGE_S = 7 * 86400
STARTS_KEPT = 20
# The restore leg's own names: a set-aside generation, and a copy on its way in.
SET_ASIDE_MARK = ".clawbox-start-loop-"
RESTORING_MARK = ".clawbox-restoring-"
SQLITE_SIDECARS = ("", "-wal", "-shm", "-journal")
# A plain file copy on the box's storage, planned well below what it does.
RESTORE_COPY_BPS = 48 * 1024 * 1024
RESTORE_MARGIN = 64 * 1024 * 1024
# How much of each OpenClaw log file is read: the tail is where today is.
LOG_TAIL_BYTES = 4 * 1024 * 1024
# The updater's bound for one `doctor --fix` (src/lib/openclaw-migration-status.ts
# doctorFixBudgetMs): 90 s plus two minutes a GiB, never past twenty minutes.
DOCTOR_FIX_BASE_S = 90
DOCTOR_FIX_PER_GIB_S = 120
DOCTOR_FIX_CAP_S = 1200
# The core's restart-loop breaker (the "crash-loop breaker" of gateway/
# restart-recovery in the pinned docs; src/infra/gateway-boot-lifecycle in the
# 2026.10.6 package): three unclean boots within five minutes, and the next
# boot holds channel/provider account auto-start back. The same process lifts
# it itself at its channel health monitor's first check after the window has
# drained (a check every five minutes, the first a minute after the monitor
# starts), or the next boot does; the margin is for a slow Jetson.
BREAKER_WINDOW_S = 300
HEALTH_CHECK_S = 300
HEALTH_GRACE_S = 60
BREAKER_MARGIN_S = 120
# Past this a watch is over, whatever it saw: the next recovery starts another.
BREAKER_WATCH_MAX_AGE_S = 86400


def log(msg):
    print("  [db-maintenance] " + msg, flush=True)


def warn(msg):
    print("  [db-maintenance] WARN: " + msg, file=sys.stderr, flush=True)


def human(n):
    if n is None:
        return "?"
    n = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1000 or unit == "TB":
            return ("%.0f %s" % (n, unit)) if unit in ("B", "KB") else ("%.1f %s" % (n, unit))
        n /= 1000.0
    return "%.1f TB" % n


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


# ── reading ───────────────────────────────────────────────────────────────


def read_json(path):
    """The object in `path`, `{}` when there is none, None when it is unreadable."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {}
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def write_json(path, data):
    """Atomic replace; False (and a WARN) when the directory cannot take it."""
    tmp = path + ".tmp-%d" % os.getpid()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
        return True
    except Exception as exc:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        warn("could not write %s (%s: %s)" % (path, type(exc).__name__, exc))
        return False


def core_schema(pkg_path):
    """`{version, agent, state}` the installed core declares, None when unknown."""
    data = read_json(pkg_path) if pkg_path else None
    if not data:
        return None
    sv = (data.get("openclaw") or {}).get("schemaVersions") if isinstance(data.get("openclaw"), dict) else None
    sv = sv if isinstance(sv, dict) else {}
    agent = sv.get("agent") if isinstance(sv.get("agent"), int) else None
    state = sv.get("state") if isinstance(sv.get("state"), int) else None
    version = data.get("version") if isinstance(data.get("version"), str) else None
    return {"version": version, "agent": agent, "state": state}


def regular_file(path):
    try:
        st = os.lstat(path)
    except OSError:
        return None
    return st if stat.S_ISREG(st.st_mode) else None


def size_of(path):
    st = regular_file(path)
    return st.st_size if st else 0


def header_facts(path):
    """Page facts from the 100-byte SQLite header: the fallback when the file
    cannot be opened (an older library, a hot WAL a read-only handle cannot
    recover). Exact after a clean checkpoint, which a stopped gateway leaves."""
    with open(path, "rb") as fh:
        head = fh.read(100)
    if len(head) < 100 or not head.startswith(b"SQLite format 3\x00"):
        raise ValueError("not an SQLite database")
    page_size = int.from_bytes(head[16:18], "big")
    page_size = 65536 if page_size == 1 else page_size
    change_counter = int.from_bytes(head[24:28], "big")
    page_count = int.from_bytes(head[28:32], "big")
    valid_for = int.from_bytes(head[92:96], "big")
    if page_count == 0 or valid_for != change_counter:
        page_count = os.path.getsize(path) // page_size
    return {
        "pageSize": page_size,
        "pageCount": page_count,
        "freelistCount": int.from_bytes(head[36:40], "big"),
        "userVersion": int.from_bytes(head[60:64], "big"),
        "source": "header",
    }


def sqlite_facts(path):
    uri = "file:" + urllib.parse.quote(path) + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=2)
    try:
        def one(pragma):
            return con.execute("PRAGMA " + pragma).fetchone()[0]

        return {
            "pageSize": one("page_size"),
            "pageCount": one("page_count"),
            "freelistCount": one("freelist_count"),
            "userVersion": one("user_version"),
            "autoVacuum": one("auto_vacuum"),
            "source": "sqlite",
        }
    finally:
        con.close()


def memory_index_built(path):
    """What this agent database's memory index says it was built with — the
    ``memory_index_meta_v1`` row the pinned core writes, read READ-ONLY — or
    None when there is no such row to read. A core built with no embedder
    writes model ``fts-only`` and provider ``none``: text chunks, no vectors."""
    try:
        con = sqlite3.connect("file:" + urllib.parse.quote(path) + "?mode=ro", uri=True, timeout=2)
        try:
            row = con.execute("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'").fetchone()
        finally:
            con.close()
        meta = json.loads(row[0]) if row else None
    except (sqlite3.Error, ValueError, TypeError):
        return None
    return meta if isinstance(meta, dict) else None


def keyword_only(meta):
    return isinstance(meta, dict) and (meta.get("provider") == "none" or meta.get("model") == "fts-only")


# Test seam: the free space every statvfs answers, so a suite can stand in
# for a full disk. Set from --free-bytes-override; never on a box.
_FREE_BYTES_OVERRIDE = None


def free_bytes(directory):
    if _FREE_BYTES_OVERRIDE is not None:
        return _FREE_BYTES_OVERRIDE
    try:
        st = os.statvfs(directory)
    except OSError:
        return None
    return st.f_bavail * st.f_frsize


def temp_dir():
    """Where SQLite builds VACUUM's temporary copy: the first usable directory
    of its own search order on Unix."""
    for candidate in (os.environ.get("SQLITE_TMPDIR"), os.environ.get("TMPDIR"), "/var/tmp", "/usr/tmp", "/tmp"):
        if candidate and os.path.isdir(candidate) and os.access(candidate, os.W_OK | os.X_OK):
            return candidate
    return None


def measure(db):
    """Fill in a database entry's size, page facts and backups, in place."""
    path = db["path"]
    db["fileBytes"] = size_of(path)
    db["walBytes"] = size_of(path + "-wal")
    db["bytes"] = db["fileBytes"] + db["walBytes"]
    try:
        try:
            facts = sqlite_facts(path)
        except Exception as exc:
            facts = header_facts(path)
            facts["openError"] = "%s: %s" % (type(exc).__name__, exc)
        db.update(facts)
        page_bytes = db["pageSize"] * db["pageCount"]
        db["freeBytes"] = db["pageSize"] * db["freelistCount"]
        db["liveBytes"] = max(0, page_bytes - db["freeBytes"])
        db["freeRatio"] = (db["freelistCount"] / float(db["pageCount"])) if db["pageCount"] else 0.0
        db.pop("error", None)
    except Exception as exc:
        db["error"] = "%s: %s" % (type(exc).__name__, exc)
    db["avail"] = free_bytes(os.path.dirname(path))
    db["backups"], db["capturing"] = backups_beside(path)
    return db


def backups_beside(path):
    """The migration's rollback copies of this database, and whether one is
    still being written (`.bak.capturing`)."""
    directory, base = os.path.split(path)
    prefix = base + BACKUP_MARK
    found, capturing = [], False
    try:
        names = os.listdir(directory)
    except OSError:
        return found, capturing
    for name in sorted(names):
        if not name.startswith(prefix):
            continue
        if name.endswith(".capturing"):
            capturing = True
            continue
        full = os.path.join(directory, name)
        st = regular_file(full)
        if st:
            # ctime as well as mtime: a copy can carry its source's mtime, and
            # "taken after the compaction" must never be read off a preserved one.
            found.append({"path": full, "bytes": st.st_size, "mtime": max(st.st_mtime, st.st_ctime)})
    return found, capturing


def configured_agent_dirs(config_path):
    """`agents.entries.<id>.agentDir` for agents that live outside the default tree."""
    cfg = read_json(config_path) if config_path else None
    out = {}
    entries = ((cfg or {}).get("agents") or {}).get("entries") if isinstance((cfg or {}).get("agents"), dict) else None
    if not isinstance(entries, dict):
        return out
    for agent_id, entry in entries.items():
        if not isinstance(entry, dict) or not AGENT_ID.match(str(agent_id)):
            continue
        agent_dir = entry.get("agentDir")
        if isinstance(agent_dir, str) and agent_dir.strip():
            out[agent_id] = os.path.expanduser(agent_dir.strip())
    return out


def discover(state_dir, config_path):
    """Every agent database under the state directory (and any configured
    elsewhere), plus the shared state database. Unmeasured."""
    dbs, seen = [], set()

    def add(kind, agent_id, path):
        real = os.path.realpath(path)
        if real in seen or not regular_file(path):
            return
        seen.add(real)
        dbs.append({"kind": kind, "agentId": agent_id, "path": path})

    agents_root = os.path.join(state_dir, "agents")
    try:
        ids = sorted(os.listdir(agents_root))
    except OSError:
        ids = []
    for agent_id in ids:
        if AGENT_ID.match(agent_id):
            add("agent", agent_id, os.path.join(agents_root, agent_id, "agent", AGENT_DB_NAME))
    for agent_id, agent_dir in sorted(configured_agent_dirs(config_path).items()):
        add("agent", agent_id, os.path.join(agent_dir, AGENT_DB_NAME))
    add("state", None, os.path.join(state_dir, "state", "openclaw.sqlite"))
    return dbs


def inventory(state_dir, config_path):
    return [measure(db) for db in discover(state_dir, config_path)]


def key_of(db):
    return "state" if db["kind"] == "state" else "agent:" + db["agentId"]


def label(db):
    return "the shared state database" if db["kind"] == "state" else "agent %s" % db["agentId"]


def declared(db, core):
    if not core:
        return None
    return core.get("state") if db["kind"] == "state" else core.get("agent")


def schema_position(db, core):
    """'current' | 'behind' | 'newer' | 'unknown' against the core's declaration."""
    want = declared(db, core)
    have = db.get("userVersion")
    if want is None or not isinstance(have, int) or db.get("error"):
        return "unknown"
    if have < want:
        return "behind"
    if have > want:
        return "newer"
    return "current"


# ── the native commands ───────────────────────────────────────────────────


# Seconds a stopped CLI is given to go: SIGTERM, then SIGKILL (see _run). Every
# deadline below keeps this much in hand, so nothing it started outlives it.
KILL_GRACE_S = 30
_children = set()


def _stop_group(pid, grace):
    for sig, wait in ((signal.SIGTERM, grace * 2 // 3), (signal.SIGKILL, grace // 3)):
        try:
            os.killpg(pid, sig)
        except OSError:
            return
        end = time.monotonic() + wait
        while time.monotonic() < end:
            try:
                if os.waitpid(pid, os.WNOHANG)[0] == pid:
                    return
            except ChildProcessError:
                return
            time.sleep(0.2)


def _on_signal(signum, _frame):
    """The pre-start's own `timeout`, or systemd, stopping THIS process: the
    CLI it started runs in its own process group (so a deadline can stop the
    whole of it) and would otherwise be left compacting beside a starting
    gateway. Stop it first."""
    for pid in list(_children):
        _stop_group(pid, 6)
    sys.exit(128 + signum)


def _run(executable, argv, timeout):
    """Run the core's CLI in its own process group; (rc, stdout, stderr).
    rc is None when the deadline ran out (SIGTERM, then SIGKILL). Every caller
    passes the argv as a literal list, which the harness-contract scan reads."""
    try:
        proc = subprocess.Popen(
            [executable] + list(argv),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as exc:
        return 127, "", "%s: %s" % (type(exc).__name__, exc)
    _children.add(proc.pid)
    try:
        out, err = proc.communicate(timeout=max(1, timeout))
        return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        for sig, grace in ((signal.SIGTERM, KILL_GRACE_S * 2 // 3), (signal.SIGKILL, KILL_GRACE_S // 3)):
            try:
                os.killpg(proc.pid, sig)
            except OSError:
                pass
            try:
                out, err = proc.communicate(timeout=grace)
                return None, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")
            except subprocess.TimeoutExpired:
                continue
        return None, "", ""
    finally:
        _children.discard(proc.pid)


def last_json_object(text):
    """The last top-level JSON object in a command's stdout, or None."""
    decoder = json.JSONDecoder()
    found, i = None, 0
    while True:
        i = text.find("{", i)
        if i < 0:
            return found
        try:
            obj, end = decoder.raw_decode(text, i)
        except ValueError:
            i += 1
            continue
        if isinstance(obj, dict):
            found = obj
        i = end


CHECK_KEY = re.compile(r"^(quick_?check|integrity_?check|foreign_?key_?check)", re.IGNORECASE)


def integrity_of(report):
    """'ok' when every reported check says ok, 'failed' when one does not,
    'unreported' when the report names none."""
    verdicts = []

    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if CHECK_KEY.match(str(k)) and isinstance(v, (str, bool)):
                    verdicts.append(v is True or (isinstance(v, str) and v.strip().lower() in ("ok", "passed", "pass")))
                else:
                    walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(report)
    if not verdicts:
        return "unreported"
    return "ok" if all(verdicts) else "failed"


def run_compact(binary, db, timeout):
    # Every `_run(binary, [...])` below is written as a literal list on one line
    # with the CLI named `binary`: that is the shape scripts/harness-contract
    # reads, so each command and flag is checked against the pinned core.
    if db["kind"] == "state":
        rc, out, err = _run(binary, ["doctor", "--state-sqlite", "compact", "--json"], timeout)
    else:
        agent_id = db["agentId"]
        rc, out, err = _run(binary, ["doctor", "--session-sqlite", "compact", "--session-sqlite-agent", agent_id, "--json"], timeout)
    report = last_json_object(out)
    integrity = integrity_of(report) if report is not None else "unreported"
    tail = (err.strip().splitlines() or out.strip().splitlines() or [""])[-1][:300]
    return rc, integrity, tail


# ── prestart ──────────────────────────────────────────────────────────────


def disk_needed(db, tmp):
    """Free bytes compaction needs on the database's filesystem, and on the
    temporary directory's when that is another one: VACUUM writes a copy of the
    live pages there, then writes them back through the WAL."""
    live = db.get("liveBytes", db["bytes"])
    same = True
    if tmp:
        try:
            same = os.stat(tmp).st_dev == os.stat(os.path.dirname(db["path"])).st_dev
        except OSError:
            same = True
    if same:
        return max(db["bytes"], 2 * live), None
    return max(db["bytes"], live), live


def plan_compaction(dbs, core, record, threshold, rate, overhead=CLI_OVERHEAD_S, capture_time=None):
    """[(db, why)] to compact, in the order to do them, and [(db, reason)] skipped.
    `capture_time`: when the newest update capture waiting to be retired was
    written — a capture holds every database, so each must be checked after it."""
    todo, skipped = [], []
    tmp = temp_dir()
    for db in dbs:
        if db.get("error"):
            skipped.append((db, "unreadable (%s)" % db["error"]))
            continue
        position = schema_position(db, core)
        if position in ("behind", "newer"):
            skipped.append((db, "on schema %s, the core declares %s — compaction needs the current schema" % (db.get("userVersion"), declared(db, core))))
            continue
        why = None
        if db["freeRatio"] > threshold:
            why = "%d%% free pages" % round(db["freeRatio"] * 100)
        elif db["backups"] and not db["capturing"] and not verified_after_backup(db, record):
            why = "migrated: its rollback copy waits for this integrity check"
        elif capture_time is not None and not verified_since(db, record, capture_time):
            why = "an update capture waits for this integrity check"
        if not why:
            skipped.append((db, None))
            continue
        need_here, need_tmp = disk_needed(db, tmp)
        if db["avail"] is None or db["avail"] < need_here:
            skipped.append((db, "low disk: needs %s free, %s is free" % (human(need_here), human(db["avail"]))))
            continue
        if need_tmp is not None:
            avail_tmp = free_bytes(tmp)
            if avail_tmp is None or avail_tmp < need_tmp:
                skipped.append((db, "low disk in %s: needs %s free, %s is free" % (tmp, human(need_tmp), human(avail_tmp))))
                continue
        db["estimate"] = int(overhead + db.get("liveBytes", db["bytes"]) / float(rate))
        todo.append((db, why))
    todo.sort(key=lambda item: -item[0].get("freeBytes", 0))
    return todo, skipped


def verified_since(db, record, moment):
    """A successful compaction — OpenClaw's integrity checks — recorded at or
    after `moment`, of the database on the schema it is on now."""
    entry = ((record.get("databases") or {}).get(key_of(db)) or {}).get("lastCompact") or {}
    if not entry.get("ok") or entry.get("integrity") == "failed":
        return False
    if entry.get("userVersion") != db.get("userVersion"):
        return False
    return isinstance(entry.get("at"), (int, float)) and entry["at"] >= moment


def verified_after_backup(db, record):
    """Verified after the newest rollback copy beside it was taken."""
    return verified_since(db, record, max([b["mtime"] for b in db["backups"]] or [0]))


def compact_all(args, dbs, core, record, deadline):
    _root, runs = capture_dirs(args.state_dir)
    capture_time = max([tree_time(run) for run in runs]) if runs and dbs else None
    todo, skipped = plan_compaction(
        dbs, core, record, args.threshold, args.live_rate_bps, args.cli_overhead_seconds, capture_time,
    )
    for db, reason in skipped:
        if reason:
            log("%s not compacted: %s" % (label(db), reason))
            entry = record.setdefault("databases", {}).setdefault(key_of(db), {})
            entry["lastSkip"] = {"at": time.time(), "reason": reason}
    for db, why in todo:
        left = deadline - time.monotonic() - KILL_GRACE_S
        if db["estimate"] > left:
            reason = "about %d s of work, %d s of this start's budget left — next gateway start" % (db["estimate"], max(0, int(left)))
            log("%s not compacted: %s" % (label(db), reason))
            record.setdefault("databases", {}).setdefault(key_of(db), {})["lastSkip"] = {"at": time.time(), "reason": reason}
            continue
        timeout = int(min(left, db["estimate"] * 2))
        before = db["bytes"]
        log("compacting %s (%s, %s; about %d s, at most %d s)" % (label(db), human(before), why, db["estimate"], timeout))
        started = time.monotonic()
        rc, integrity, tail = run_compact(args.openclaw_bin, db, timeout)
        seconds = int(time.monotonic() - started)
        measure(db)
        ok = rc == 0 and integrity != "failed"
        entry = record.setdefault("databases", {}).setdefault(key_of(db), {})
        entry["lastCompact"] = {
            "at": time.time(),
            "ok": ok,
            "exit": rc,
            "integrity": integrity,
            "beforeBytes": before,
            "afterBytes": db["bytes"],
            "seconds": seconds,
            "userVersion": db.get("userVersion"),
        }
        if ok:
            log("compacted %s: %s -> %s in %d s (integrity %s)" % (label(db), human(before), human(db["bytes"]), seconds, integrity))
        elif rc is None:
            warn("compacting %s ran out of its %d s and was stopped; SQLite keeps the database as it was — next gateway start" % (label(db), timeout))
        else:
            warn("compacting %s failed (exit %s, integrity %s): %s" % (label(db), rc, integrity, tail))


def migration_status(dbs, core, previous):
    """The status file's body for what is on disk now."""
    now = time.time()
    behind = [db for db in dbs if schema_position(db, core) == "behind"]
    newer = [db for db in dbs if schema_position(db, core) == "newer"]
    version = (core or {}).get("version")
    doctor = previous.get("doctor") if isinstance(previous.get("doctor"), dict) else None
    preflight = previous.get("preflight") if isinstance(previous.get("preflight"), dict) else None
    # A preflight refusal for a core that has since been installed is history.
    if preflight and version and preflight.get("target") == version and not behind:
        preflight = None
    body = {
        "version": 1,
        "updatedAt": iso(now),
        "source": "gateway-pre-start",
        "core": version,
        "databases": {"total": len(dbs), "behind": len(behind), "newer": len(newer)},
        "doctor": doctor,
        "preflight": preflight,
        "requiredBytes": None,
        "freeBytes": None,
    }
    if not core or core.get("agent") is None or core.get("state") is None:
        # Nothing to compare against: say so rather than "ok".
        body["state"] = "unknown"
        body["reason"] = "core-schema-unknown"
    elif behind:
        need = migration_need(behind, DEFAULT_MIGRATION_FACTOR, DEFAULT_MIGRATION_MARGIN)
        body["requiredBytes"] = need
        body["freeBytes"] = behind[0].get("avail")
        short = body["freeBytes"] is not None and body["freeBytes"] < need
        body["state"] = "degraded"
        body["reason"] = "insufficient-disk" if short else "schema-behind"
    elif newer:
        body["state"] = "degraded"
        body["reason"] = "schema-newer"
    elif doctor and doctor.get("core") == version and doctor.get("verdict") != "complete":
        body["state"] = "degraded"
        body["reason"] = "migration-incomplete"
    elif preflight:
        body["state"] = "blocked"
        body["reason"] = "insufficient-disk"
        body["requiredBytes"] = preflight.get("requiredBytes")
        body["freeBytes"] = preflight.get("freeBytes")
    else:
        body["state"] = "ok"
        body["reason"] = None
    return body


def migration_need(dbs, factor, margin):
    return int(sum(db["bytes"] for db in dbs) * factor + margin)


def migration_verified(dbs, core, status):
    """Every database on the declared schema and no incomplete doctor run
    recorded for this core — the half of the clean-up rule that is global."""
    if not core or core.get("agent") is None or core.get("state") is None:
        return False, "the installed core declares no schema versions"
    for db in dbs:
        if schema_position(db, core) != "current":
            return False, "%s is not on the declared schema" % label(db)
    doctor = status.get("doctor") or {}
    if doctor.get("core") == core.get("version") and doctor.get("verdict") != "complete":
        return False, "the last doctor --fix for this core did not complete"
    return True, None


def remove_files(paths):
    removed = 0
    for path in paths:
        st = regular_file(path)
        if not st:
            continue
        try:
            os.unlink(path)
            removed += st.st_size
        except OSError as exc:
            warn("could not remove %s (%s)" % (path, exc))
    return removed


def tree_bytes(root):
    total = 0
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in files:
            st = regular_file(os.path.join(base, name))
            if st:
                total += st.st_size
    return total


def tree_time(root):
    """The latest mtime or ctime of anything under `root`, `root` included:
    when the capture was last written to."""
    latest = 0.0
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in [""] + files + dirs:
            try:
                st = os.lstat(os.path.join(base, name) if name else base)
            except OSError:
                continue
            latest = max(latest, st.st_mtime, st.st_ctime)
    return latest


def capture_dirs(state_dir):
    """Run directories under `<state-dir>.update-captures/` carrying the core's
    private-capture marker (in the run directory or the root above it)."""
    root = state_dir.rstrip("/") + ".update-captures"
    try:
        st = os.lstat(root)
    except OSError:
        return root, []
    if not stat.S_ISDIR(st.st_mode):
        return root, []

    def marked(directory):
        path = os.path.join(directory, CAPTURE_MARKER)
        if not regular_file(path):
            return False
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return fh.read() == CAPTURE_MARKER_TEXT
        except OSError:
            return False

    root_marked = marked(root)
    runs = []
    for name in sorted(os.listdir(root)):
        full = os.path.join(root, name)
        try:
            if not stat.S_ISDIR(os.lstat(full).st_mode):
                continue
        except OSError:
            continue
        if root_marked or marked(full):
            runs.append(full)
    return root, runs


def remove_tree(root):
    import shutil

    size = tree_bytes(root)
    try:
        shutil.rmtree(root)
        return size
    except OSError as exc:
        warn("could not remove %s (%s)" % (root, exc))
        return 0


def cleanup(args, dbs, core, status, record, deadline):
    """Retire the migration's rollback copies once the migration is verified."""
    pending = [db for db in dbs if db["backups"]]
    root, runs = capture_dirs(args.state_dir)
    if not pending and not runs:
        return
    if deadline - time.monotonic() - KILL_GRACE_S < 30:
        log("migration rollback copies kept for the next gateway start: no time left in this one")
        return
    ok, why = migration_verified(dbs, core, status)
    if not ok:
        log("migration rollback copies kept: %s" % why)
        return
    guard = read_json(os.path.join(args.data_dir, GUARD_FILE)) or {}
    if recovery_unsettled(guard, time.time()):
        log("migration rollback copies kept: the gateway's start-loop recovery has not settled")
        return
    native_tried = False
    removed = 0
    for db in pending:
        if db["capturing"]:
            log("rollback copy of %s kept: a copy is still being written" % label(db))
            continue
        if not verified_after_backup(db, record):
            log("rollback copy of %s kept until a compaction has checked its integrity" % label(db))
            continue
        if not started_since(guard, max(b["mtime"] for b in db["backups"])):
            log("rollback copy of %s kept until the gateway has started on the migrated database" % label(db))
            continue
        if not native_tried:
            native_tried = True
            # The core's own retirement first. It keeps every group its own
            # updater has not seen a later successful update for — on ClawBox
            # that is all of them — but whatever it does retire is retired by
            # its owner, manifests and all.
            binary = args.openclaw_bin
            rc, out, err = _run(binary, ["update", "cleanup", "--yes", "--json"], int(min(120, deadline - time.monotonic() - KILL_GRACE_S)))
            report = last_json_object(out) or {}
            totals = report.get("totals") if isinstance(report.get("totals"), dict) else {}
            log("openclaw update cleanup: exit %s%s" % (rc, (", removed %s" % human(totals.get("removedBytes"))) if totals.get("removedBytes") else ""))
            for other in pending:
                other["backups"], other["capturing"] = backups_beside(other["path"])
            if not db["backups"]:
                continue
        freed = remove_files([b["path"] for b in db["backups"]])
        removed += freed
        log("removed the pre-migration copy of %s (%s): the migrated database passed its integrity check" % (label(db), human(freed)))
    for run in runs:
        # A capture is a copy of the whole state: it goes only when EVERY
        # database passed a compaction after it was written — and never when
        # there are no databases left, where it may be the only copy there is.
        written = tree_time(run)
        unchecked = [db for db in dbs if not verified_since(db, record, written)]
        if not dbs or unchecked:
            log("update capture %s kept until %s has passed a compaction's integrity check" % (
                os.path.basename(run), label(unchecked[0]) if unchecked else "a database"))
            continue
        if not started_since(guard, written):
            log("update capture %s kept until the gateway has started on the migrated databases" % os.path.basename(run))
            continue
        freed = remove_tree(run)
        removed += freed
        log("removed the update capture %s (%s)" % (os.path.basename(run), human(freed)))
    if runs and os.path.isdir(root):
        try:
            leftover = [n for n in os.listdir(root) if n != CAPTURE_MARKER]
            if not leftover:
                remove_files([os.path.join(root, CAPTURE_MARKER)])
                os.rmdir(root)
        except OSError:
            pass
    if removed:
        record["cleanup"] = {"at": time.time(), "removedBytes": removed}


def cmd_prestart(args):
    started = time.monotonic()
    deadline = started + max(0, args.budget_seconds)
    data_dir = args.data_dir
    status_path = os.path.join(data_dir, STATUS_FILE)
    record_path = os.path.join(data_dir, RECORD_FILE)
    core = core_schema(args.core_pkg)
    record = read_json(record_path)
    if record is None:
        warn("%s is unreadable; starting a new record" % record_path)
        record = {}
    previous = read_json(status_path) or {}

    dbs = inventory(args.state_dir, args.config)
    if not dbs:
        log("no OpenClaw databases under %s" % args.state_dir)
    status = migration_status(dbs, core, previous)
    write_json(status_path, status)
    if status["state"] not in ("ok", "unknown"):
        warn(
            "OpenClaw databases need attention: %s (%d of %d behind the core's schema)%s"
            % (
                status["reason"],
                status["databases"]["behind"],
                status["databases"]["total"],
                (" — the migration needs %s free, %s is free" % (human(status["requiredBytes"]), human(status["freeBytes"])))
                if status.get("requiredBytes") else "",
            )
        )

    if args.budget_seconds <= 0:
        log("no time left in this gateway start for compaction")
    else:
        compact_all(args, dbs, core, record, deadline)
    cleanup(args, dbs, core, status, record, deadline)
    record["version"] = 1
    record["updatedAt"] = iso(time.time())
    write_json(record_path, record)
    return 0


# ── start-guard (gateway pre-start, first) ────────────────────────────────
#
# The incident: one session row the core refused in an agent database, and the
# gateway exited at every start — `Restart=always` brought it back a dozen
# times in eight minutes and nothing between two starts changed a thing. The
# core degrades a secondary agent whose database it cannot admit and carries
# on; the default or system agent's database, or the shared one, still stops
# startup (integrity-and-recovery, state-and-sessions in the pinned docs).
#
# Evidence is the GATEWAY's own words, never this script's: its lines in the
# unit's journal (when this account may read it — the web server's is not
# always in a journal-reading group) and its rolling log file, which the same
# account writes. Lines from this pre-start and from systemd are left out, and
# so is anything logged while this guard's own commands ran.

# A line about one of OpenClaw's databases...
DB_SUBJECT_RE = re.compile(
    r"agent[ -]database|openclaw-agent\.sqlite|openclaw\.sqlite|shared[ -]state database"
    r"|session (?:row|store|record|entr(?:y|ies)|index)|sessions? table"
    r"|SQLITE_CORRUPT|database disk image is malformed|malformed database schema",
    re.IGNORECASE,
)
# ...that says it went wrong. Not "degraded": that is the core carrying on
# without a secondary agent, which is not what stops a start.
DB_FAILURE_RE = re.compile(r"invalid|malformed|validat|fail|refus|corrupt|cannot|unable|admission|error", re.IGNORECASE)
# The core's own readiness line, announced on the same readiness decision that
# admits the databases (gateway/health in the pinned docs). Not the HTTP
# listener's line, which comes up before admission, and case-sensitive so a
# channel's own "Gateway READY" is not taken for it.
READY_RE = re.compile(r"\[gateway\] ready\b|(?:^|\")gateway ready(?:\"|$)")
_ID = r"([A-Za-z0-9][A-Za-z0-9_.-]{0,127})"
AGENT_REF_RES = (
    re.compile(r"agent-database:" + _ID),
    re.compile(r"/agents/" + _ID + r"/agent/"),
    re.compile(r"agentId\\?[\"']?\s*[:=]\s*\\?[\"']?" + _ID),
    re.compile(r"agent database\s+[\"'`(]?" + _ID, re.IGNORECASE),
    re.compile(r"\bagent\s+[\"'`]" + _ID + r"[\"'`]", re.IGNORECASE),
    # A session key, `agent:<id>:<rest>`: how 2026.10.6 names the agent when it
    # refuses a row ("invalid persisted session row requires repair for
    # agent:main:<key>"), with no database path or agent id beside it.
    re.compile(r"(?<![A-Za-z0-9_.-])agent:" + _ID + r":"),
)
SQLITE_PATH_RE = re.compile(r"(/[^\s'\"\\,;()]+?\.sqlite)(?![A-Za-z0-9_.])")
STATE_REF_RE = re.compile(r"shared[ -]state database", re.IGNORECASE)
LOG_TIME_KEYS = ("time", "ts", "timestamp", "@timestamp", "date")


def stamp(ts):
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(ts))


def doctor_fix_seconds(database_bytes):
    gib = -(-max(0, database_bytes) // (1024 ** 3))
    return min(DOCTOR_FIX_CAP_S, DOCTOR_FIX_BASE_S + gib * DOCTOR_FIX_PER_GIB_S)


def started_since(guard, moment):
    """The gateway is known to have started after `moment` — or `moment` is
    over a week old, past which nothing here can still tell."""
    proven = guard.get("provenAt")
    if isinstance(proven, (int, float)) and proven > moment:
        return True
    return time.time() - moment > COPY_PROOF_MAX_AGE_S


def recovery_unsettled(guard, now):
    """A start-loop recovery that the gateway has not yet started after."""
    episode = guard.get("episode")
    if not isinstance(episode, dict) or episode.get("settledAt"):
        return False
    acted = episode.get("actedTo")
    return isinstance(acted, (int, float)) and now - acted < COPY_PROOF_MAX_AGE_S


def _parse_time(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value / 1000.0 if value > 1e11 else float(value)
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    import datetime

    try:
        return datetime.datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


def journal_lines(unit, since):
    """(time, text) the gateway printed under `unit` since `since`; [] when
    the journal cannot be read."""
    try:
        proc = subprocess.run(
            ["journalctl", "-u", unit, "--since", "@%d" % int(since), "-o", "json", "--no-pager", "-q", "-n", "20000"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    out = []
    for raw in proc.stdout.decode("utf-8", "replace").splitlines():
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("SYSLOG_IDENTIFIER") in ("systemd", PRESTART_IDENT):
            continue
        msg = entry.get("MESSAGE")
        if isinstance(msg, list):
            try:
                msg = bytes(msg).decode("utf-8", "replace")
            except (TypeError, ValueError):
                continue
        try:
            at = int(entry.get("__REALTIME_TIMESTAMP")) / 1e6
        except (TypeError, ValueError):
            continue
        if isinstance(msg, str) and "[db-maintenance]" not in msg:
            out.append((at, msg))
    return out


def openclaw_log_files(config_path, overrides):
    """The core's rolling log files: `logging.file` when the config names one,
    else `openclaw-*.log` in its default directories."""
    if overrides:
        dirs, files = list(overrides), []
    else:
        cfg = read_json(config_path) if config_path else None
        logging_cfg = (cfg or {}).get("logging")
        configured = logging_cfg.get("file") if isinstance(logging_cfg, dict) else None
        files = [os.path.expanduser(configured.strip())] if isinstance(configured, str) and configured.strip() else []
        tmp = os.environ.get("TMPDIR") or "/tmp"
        dirs = ["/tmp/openclaw", os.path.join(tmp, "openclaw"), os.path.join(tmp, "openclaw-%d" % os.getuid())]
    seen = set(files)
    for directory in dirs:
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            continue
        for name in names:
            full = os.path.join(directory, name)
            if name.startswith("openclaw") and name.endswith(".log") and full not in seen:
                seen.add(full)
                files.append(full)
    return files


def file_log_lines(files, since):
    """(time, raw line) from the tail of each log file written since `since`.
    A line with no time of its own is left out: it cannot be placed."""
    out = []
    for path in files:
        st = regular_file(path)
        if not st or max(st.st_mtime, st.st_ctime) < since:
            continue
        try:
            with open(path, "rb") as fh:
                if st.st_size > LOG_TAIL_BYTES:
                    fh.seek(st.st_size - LOG_TAIL_BYTES)
                    fh.readline()
                data = fh.read()
        except OSError:
            continue
        for raw in data.decode("utf-8", "replace").splitlines():
            try:
                obj = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(obj, dict):
                continue
            at = None
            for key in LOG_TIME_KEYS:
                at = _parse_time(obj.get(key))
                if at is not None:
                    break
            if at is not None and at >= since:
                out.append((at, raw))
    return out


def outside(at, windows):
    return not any(start <= at <= end for start, end in windows)


def database_failures(lines, windows, after=0.0):
    return [(at, text) for at, text in lines
            if at > after and outside(at, windows) and DB_SUBJECT_RE.search(text) and DB_FAILURE_RE.search(text)]


def named_databases(lines, dbs):
    """The inventory entries the failure lines name — by agent id or path,
    never one that is not on this box."""
    by_agent = {db["agentId"]: db for db in dbs if db["kind"] == "agent"}
    by_path = {}
    for db in dbs:
        by_path[os.path.realpath(db["path"])] = db
    state = next((db for db in dbs if db["kind"] == "state"), None)
    found = {}
    for _at, text in lines:
        for rx in AGENT_REF_RES:
            for m in rx.finditer(text):
                db = by_agent.get(m.group(1))
                if db:
                    found[key_of(db)] = db
        for m in SQLITE_PATH_RE.finditer(text):
            db = by_path.get(os.path.realpath(m.group(1)))
            if db:
                found[key_of(db)] = db
        if state and STATE_REF_RE.search(text):
            found[key_of(state)] = state
    return [found[k] for k in sorted(found)]


def startup_critical(dbs, config_path):
    """The databases whose refusal stops the gateway from starting: the shared
    state database and the default and system agents' (`agents.entries.<id>
    .default`, `agents.defaults.systemAgent.agentId`; `main` when no entry is
    marked default). A secondary agent's is degraded and the gateway carries on
    without it, so it is never what a start loop is about."""
    cfg = read_json(config_path) if config_path else None
    agents = (cfg or {}).get("agents") if isinstance((cfg or {}).get("agents"), dict) else {}
    entries = agents.get("entries") if isinstance(agents.get("entries"), dict) else {}
    ids = {str(k) for k, v in entries.items() if isinstance(v, dict) and v.get("default") is True}
    if not ids:
        ids.add("main")
    defaults = agents.get("defaults") if isinstance(agents.get("defaults"), dict) else {}
    system = defaults.get("systemAgent") if isinstance(defaults.get("systemAgent"), dict) else {}
    if isinstance(system.get("agentId"), str):
        ids.add(system["agentId"])
    return [db for db in dbs if db["kind"] == "state" or db.get("agentId") in ids]


def step_of(name, rc, out, err):
    tail = (err.strip().splitlines() or out.strip().splitlines() or [""])[-1][:300]
    return {"command": name, "exit": rc, "said": tail}


def repair_leg(args, dbs, deadline):
    """The core's own repair: `doctor --fix`, then `doctor --session-sqlite
    recover` — which renames a corrupt database set aside (`.corrupt-<time>`)
    rather than deleting anything. (complete, steps)."""
    binary = args.openclaw_bin
    weight = sum(size_of(db["path"]) + size_of(db["path"] + "-wal") for db in dbs)
    steps = []
    left = deadline - time.monotonic() - KILL_GRACE_S
    # A minute of what is left is kept for the recovery pass.
    timeout = int(min(doctor_fix_seconds(weight), left - 60))
    if timeout < 30:
        return False, steps
    log("running openclaw doctor --fix (at most %d s)" % timeout)
    rc, out, err = _run(binary, ["doctor", "--fix", "--non-interactive", "--yes"], timeout)
    steps.append(step_of("doctor --fix", rc, out, err))
    left = int(deadline - time.monotonic() - KILL_GRACE_S)
    if left < 30:
        return False, steps
    log("running openclaw doctor --session-sqlite recover (at most %d s)" % left)
    rc, out, err = _run(binary, ["doctor", "--session-sqlite", "recover", "--session-sqlite-all-agents", "--non-interactive", "--json"], left)
    step = step_of("doctor --session-sqlite recover", rc, out, err)
    report = last_json_object(out)
    if isinstance(report, dict) and isinstance(report.get("recoveryIssues"), list):
        step["recoveryIssues"] = len(report["recoveryIssues"])
    steps.append(step)
    # Complete only when both commands said so: a doctor that exited non-zero
    # did not finish its repair, whatever it changed on the way.
    return all(s["exit"] == 0 for s in steps), steps


def _fsync_dir(directory):
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def restore_database(db, backup, now, deadline):
    """Put `backup` in place of `db`'s file set: the current set renamed aside
    with one suffix (never deleted), the copy written beside it first and moved
    in last, so a stop half-way changes nothing. (setAside paths, None) or
    (None, reason)."""
    path = db["path"]
    directory = os.path.dirname(path)
    avail = free_bytes(directory)
    if avail is not None and avail < backup["bytes"] + RESTORE_MARGIN:
        return None, "insufficient-disk"
    if backup["bytes"] / float(RESTORE_COPY_BPS) > deadline - time.monotonic() - KILL_GRACE_S:
        return None, "no-time"
    tmp = path + RESTORING_MARK + str(os.getpid())
    try:
        with open(backup["path"], "rb") as src, open(tmp, "wb") as dst:
            while True:
                # The rate above is a plan; a slow card can miss it. A copy
                # still running at the deadline is abandoned here, before the
                # pre-start's own `timeout` kills it half-written.
                if time.monotonic() > deadline - KILL_GRACE_S:
                    raise TimeoutError("the copy outlived this start's budget")
                chunk = src.read(8 * 1024 * 1024)
                if not chunk:
                    break
                dst.write(chunk)
            dst.flush()
            os.fsync(dst.fileno())
        header_facts(tmp)
        st = regular_file(path)
        if st:
            os.chmod(tmp, stat.S_IMODE(st.st_mode))
    except TimeoutError:
        remove_files([tmp])
        return None, "no-time"
    except (OSError, ValueError) as exc:
        remove_files([tmp])
        warn("could not copy %s (%s: %s)" % (backup["path"], type(exc).__name__, exc))
        return None, "backup-unreadable"
    suffix = SET_ASIDE_MARK + stamp(now)
    moved = []
    try:
        for side in SQLITE_SIDECARS:
            src = path + side
            if os.path.lexists(src):
                os.rename(src, src + suffix)
                moved.append(src)
        os.replace(tmp, path)
    except OSError as exc:
        for src in reversed(moved):
            try:
                os.rename(src + suffix, src)
            except OSError:
                warn("could not move %s back from %s" % (src, src + suffix))
        remove_files([tmp])
        warn("could not set %s aside (%s)" % (path, exc))
        return None, "set-aside-failed"
    _fsync_dir(directory)
    return [src + suffix for src in moved], None


def sweep_restoring(dbs):
    """Copies on their way in that a killed start left half-written (power
    lost, or a signal past the deadline). Only this guard's own names, and
    never the only copy of anything: the backup they came from is untouched."""
    for db in dbs:
        directory, base = os.path.split(db["path"])
        try:
            names = os.listdir(directory)
        except OSError:
            continue
        stale = [os.path.join(directory, n) for n in names if n.startswith(base + RESTORING_MARK)]
        if stale and remove_files(stale):
            log("removed a half-written restore copy beside %s" % label(db))


def restore_leg(guard, targets, now, deadline):
    """The newest pre-update copy of each refused database, put back. Never a
    copy already put back once (that is a loop of its own). (ok, reason, done)."""
    used = set(p for p in (guard.get("restoredFrom") or []) if isinstance(p, str))
    if not targets:
        return False, "database-unknown", []
    plan = []
    for db in targets:
        backups, _capturing = backups_beside(db["path"])
        fresh = [b for b in backups if b["path"] not in used]
        # A `.bak.capturing` beside them is an interrupted capture; the
        # completed groups are whole copies all the same.
        if not fresh:
            return False, "no-backup", []
        plan.append((db, max(fresh, key=lambda b: b["mtime"])))
    done = []
    for db, backup in plan:
        set_aside, reason = restore_database(db, backup, now, deadline)
        if reason:
            return False, reason, done
        used.add(backup["path"])
        guard["restoredFrom"] = sorted(used)
        log("put back the pre-update copy of %s (%s); the refused one is kept as %s" % (
            label(db), os.path.basename(backup["path"]), os.path.basename(set_aside[0]) if set_aside else "nothing"))
        done.append({"database": label(db), "from": backup["path"], "setAside": set_aside})
    return True, None, done


def notice_of(outcome, reason, databases, kept, now):
    return {
        "outcome": outcome,
        "reason": reason,
        "databases": databases,
        "keptCopies": kept,
        "at": iso(now),
    }


def watch_channels(guard, now):
    """The starts this recovery follows were unclean boots, so the next one
    trips the core's restart-loop breaker: `breaker-watch`, detached from this
    pre-start once the gateway is up, follows it from here."""
    guard["channels"] = {"watch": True, "state": "watching", "since": now}


def cmd_start_guard(args):
    now = time.time()
    deadline = time.monotonic() + max(0, args.budget_seconds)
    path = os.path.join(args.data_dir, GUARD_FILE)
    guard = read_json(path)
    if guard is None:
        warn("%s is unreadable; starting a new record" % path)
        guard = {}
    starts = [s for s in (guard.get("starts") or []) if isinstance(s, dict) and isinstance(s.get("at"), (int, float))]
    restarts = max(0, args.restarts)
    starts.append({"at": now, "restarts": restarts})
    guard["starts"] = starts[-STARTS_KEPT:]
    sweep_restoring(discover(args.state_dir, args.config))
    episode = guard.get("episode") if isinstance(guard.get("episode"), dict) else None

    def save():
        guard["version"] = 1
        guard["updatedAt"] = iso(time.time())
        write_json(path, guard)
        return 0

    # One read of the gateway's own words: since the last look (at most a
    # week back), and at least since the start of a loop.
    last = guard["starts"][-(LOOP_RESTARTS + 1):]
    scanned = guard.get("scannedTo") if isinstance(guard.get("scannedTo"), (int, float)) else 0
    since = max(now - COPY_PROOF_MAX_AGE_S, min(scanned, last[0]["at"]) - 60)
    lines = journal_lines(args.unit, since) + file_log_lines(openclaw_log_files(args.config, args.log_dir), since)
    guard["scannedTo"] = now
    windows = [tuple(w) for w in (guard.get("actionWindows") or [])
               if isinstance(w, list) and len(w) == 2 and all(isinstance(x, (int, float)) for x in w)]

    # What the last runs proved: a `gateway ready` is the core admitting
    # every database it needs.
    ready = [at for at, text in lines if READY_RE.search(text) and outside(at, windows)]
    if ready and max(ready) > (guard.get("provenAt") or 0):
        guard["provenAt"] = max(ready)
    if episode and not episode.get("settledAt") and (guard.get("provenAt") or 0) > (episode.get("actedTo") or now):
        episode["settledAt"] = guard["provenAt"]
        log("the gateway has started since its start-loop recovery (%s)" % episode.get("stage"))

    # A loop: the last few starts were each an automatic restart of the one
    # before, all within the window.
    loop = (
        restarts >= LOOP_RESTARTS
        and len(last) == LOOP_RESTARTS + 1
        and all(isinstance(s.get("restarts"), int) for s in last)
        and all(last[i + 1]["restarts"] == last[i]["restarts"] + 1 for i in range(LOOP_RESTARTS))
        and now - last[0]["at"] <= LOOP_WINDOW_S
    )
    if not loop:
        return save()
    failures = database_failures(lines, windows, after=last[0]["at"] - 60)
    if not failures:
        log("the gateway has restarted itself %d times, and not over a database it refused (or its output could not be read); nothing to repair here" % restarts)
        return save()
    dbs = discover(args.state_dir, args.config)
    critical = {key_of(db) for db in startup_critical(dbs, args.config)}
    named = named_databases(failures, dbs)
    if named and not any(key_of(db) in critical for db in named):
        log("the gateway has restarted itself %d times; the database it names (%s) is not one that stops a start, so the loop has another cause"
            % (restarts, ", ".join(label(db) for db in named)))
        return save()
    named = [db for db in named if key_of(db) in critical]
    evidence = failures[-1][1].strip()[:300]
    log("the gateway has restarted itself %d times over a database it refused: %s" % (restarts, evidence))

    same = (
        episode is not None
        and not episode.get("settledAt")
        and isinstance(episode.get("actedTo"), (int, float))
        and now - episode["actedTo"] <= EPISODE_S
    )
    since_action = database_failures(lines, windows, after=episode["actedTo"]) if same else []
    if same and not since_action:
        # Still looping, but not over a database since the last action: the
        # cause has moved on, and it is not one this guard repairs.
        log("still restarting, but no database refusal since the last recovery step; nothing more to do here")
        return save()
    if since_action:
        # What the last step did not fix is what the next one is about — and
        # when that names only databases that cannot stop a start, the one it
        # was about is fixed and the loop has moved on to another cause.
        after = named_databases(since_action, dbs)
        if after and not any(key_of(db) in critical for db in after):
            log("since the last recovery step the gateway names only %s, which does not stop a start; nothing more to do here"
                % ", ".join(label(db) for db in after))
            return save()
        named = [db for db in after if key_of(db) in critical] or named
    stage = episode.get("stage") if same else None
    if stage == "failed":
        log("start-loop recovery already gave up on this loop; the owner has been told")
        return save()
    acted_from = time.time()
    if stage is None or (stage == "repairing" and (episode.get("repairAttempts") or 0) < 2):
        attempts = (episode.get("repairAttempts") or 0) + 1 if same else 1
        complete, steps = repair_leg(args, dbs, deadline)
        if not steps:
            log("no time left in this start for the core's repair; it runs at the next one")
            return save()
        episode = {
            "startedAt": episode.get("startedAt") if same else now,
            "stage": "repaired" if complete else "repairing",
            "repairAttempts": attempts,
            "restarts": restarts,
            "evidence": evidence,
            "databases": [label(db) for db in named],
            "steps": steps,
        }
        guard["notice"] = notice_of("repaired", None if complete else "repair-incomplete", episode["databases"], [], now)
        watch_channels(guard, now)
    elif stage in ("repaired", "repairing"):
        ok, reason, done = restore_leg(guard, named, now, deadline)
        episode["stage"] = "restored" if ok else "failed"
        episode["restarts"] = restarts
        episode["restored"] = done
        if not ok:
            episode["reason"] = reason
            warn("could not put back a pre-update copy (%s); the gateway is left as it is" % reason)
            guard.pop("channels", None)
        else:
            watch_channels(guard, now)
        kept = [os.path.basename(p) for d in done for p in d["setAside"][:1]]
        guard["notice"] = notice_of("restored" if ok else "failed", reason, [d["database"] for d in done] or [label(db) for db in named], kept, now)
    else:  # restored, and it still fails over a database
        episode["stage"] = "failed"
        episode["reason"] = "restore-did-not-help"
        episode["restarts"] = restarts
        guard.pop("channels", None)
        warn("the gateway still refuses a database after its pre-update copy was put back; nothing more is tried")
        notice = guard.get("notice") if isinstance(guard.get("notice"), dict) else {}
        guard["notice"] = notice_of("failed", "restore-did-not-help", notice.get("databases") or [label(db) for db in named], notice.get("keptCopies") or [], now)
    acted_to = time.time()
    episode["actedFrom"], episode["actedTo"] = acted_from, acted_to
    guard["episode"] = episode
    windows.append((acted_from, acted_to))
    guard["actionWindows"] = [list(w) for w in windows if now - w[1] < COPY_PROOF_MAX_AGE_S][-10:]
    return save()


# ── preflight / record-doctor (install.sh) ────────────────────────────────


def downgrade_authorization(data_dir, core):
    """The backup directory the owner's override recorded for THIS core, else None.

    Written by the web server (src/lib/harness-downgrade-backup.ts) only after
    it has backed the data up, for the one core version the owner chose to go
    back to. Honoured only for that version, within its twelve hours, while the
    directory exists: anything else is no authorisation at all.
    """
    body = read_json(os.path.join(data_dir, DOWNGRADE_AUTHORIZATION_FILE))
    if not isinstance(body, dict) or body.get("version") != 1:
        return None
    if not core or not core.get("version") or body.get("openclaw") != core.get("version"):
        return None
    at = body.get("authorizedAtEpoch")
    if not isinstance(at, (int, float)) or not (0 <= time.time() - at <= DOWNGRADE_AUTHORIZATION_TTL_S):
        return None
    backup = body.get("backupDir")
    if not isinstance(backup, str) or not os.path.isabs(backup) or not os.path.isdir(backup):
        return None
    return backup


def newer_schema_sentence(newer, core):
    """The owner-facing refusal, the same sentence the updater says (src/lib/harness-downgrade.ts)."""
    db = newer[0]
    version = core.get("version") or "this core"
    return (
        "This box's OpenClaw data is newer than OpenClaw %s: %s is on %s schema %d, and OpenClaw %s supports schema %d. "
        "An older OpenClaw cannot open data a newer one has written, so it was not installed and nothing was changed. "
        "Stay on an update branch whose OpenClaw supports %s schema %d or newer, or choose \"Back up and update anyway\" "
        "in Settings > System Update, which backs the data up first."
        % (version, db["path"], db["kind"], db["userVersion"], version, declared(db, core), db["kind"], db["userVersion"])
    )


def set_aside(dbs, state_dir, dest):
    """Move each database, with its SQLite sidecars, under `dest/openclaw-newer-schema/`
    at its path relative to the state dir. Returns (moved, error): what moved before
    any failure, so the caller can say so."""
    moved = []
    root = os.path.realpath(state_dir)
    for db in dbs:
        src = db["path"]
        real = os.path.realpath(src)
        if real.startswith(root + os.sep):
            rel = os.path.relpath(real, root)
        else:
            rel = os.path.join("elsewhere", db.get("agentId") or "state", os.path.basename(src))
        target = os.path.join(dest, SET_ASIDE_DIR, rel)
        done = []
        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            # The database last, and its sidecars put back if it cannot follow
            # them: a database left in place without its WAL loses whatever was
            # committed only there the next time a core opens it.
            for suffix in ("-wal", "-shm", "-journal", ""):
                if os.path.lexists(src + suffix):
                    shutil.move(src + suffix, target + suffix)
                    done.append(suffix)
        except Exception as exc:
            for suffix in reversed(done):
                try:
                    shutil.move(target + suffix, src + suffix)
                except Exception as back:
                    warn("could not put %s back beside %s (%s: %s); it is at %s"
                         % (os.path.basename(src + suffix), src, type(back).__name__, back, target + suffix))
            return moved, "%s: %s" % (type(exc).__name__, exc)
        moved.append((src, target))
    return moved, None


def cmd_preflight(args):
    core = core_schema(args.core_pkg)
    if not core or core.get("agent") is None or core.get("state") is None:
        log("the core at %s declares no schema versions; the migration disk check stands down" % args.core_pkg)
        return 0
    dbs = inventory(args.state_dir, args.config)
    # A database a NEWER core has migrated is refused outright by this one, and
    # its `doctor --fix` cannot repair a newer schema: installing it is how a box
    # switched to an older branch was left with its gateway stopped. Refused here,
    # before the core is promoted, unless the owner chose to go back and the data
    # was backed up first; then exactly those databases are set aside, beside that
    # backup, and the older core starts on fresh ones.
    newer = [db for db in dbs if schema_position(db, core) == "newer"]
    if newer:
        backup = downgrade_authorization(args.data_dir, core)
        if not backup:
            print(newer_schema_sentence(newer, core), flush=True)
            return 3
        moved, error = set_aside(newer, args.state_dir, backup)
        for src, dst in moved:
            log("set aside %s (newer than OpenClaw %s) as %s" % (src, core.get("version"), dst))
        if error:
            print(
                "The OpenClaw databases this older version cannot open could not all be set aside (%s), so it was not "
                "installed; %d of %d were moved into %s."
                % (error, len(moved), len(newer), os.path.join(backup, SET_ASIDE_DIR)),
                flush=True,
            )
            return 3
        print(
            "CLAWBOX-WARN[harness-downgrade-set-aside]: OpenClaw %s cannot open %d database(s) a newer OpenClaw wrote; "
            "as you chose, they were moved into %s, beside the backup taken first, and it starts with fresh ones."
            % (core.get("version"), len(moved), os.path.join(backup, SET_ASIDE_DIR)),
            flush=True,
        )
        dbs = [db for db in dbs if all(db is not n for n in newer)]
    behind = [db for db in dbs if schema_position(db, core) == "behind"]
    unknown = [db for db in dbs if schema_position(db, core) == "unknown"]
    for db in unknown:
        warn("%s could not be read (%s); not counted" % (label(db), db.get("error") or "unknown schema"))
    status_path = os.path.join(args.data_dir, STATUS_FILE)
    status = read_json(status_path) or {}
    if not behind:
        log("no database needs a schema migration for OpenClaw %s" % (core.get("version") or "?"))
        if status.get("preflight"):
            status["preflight"] = None
            status["updatedAt"] = iso(time.time())
            write_json(status_path, status)
        return 0
    need = migration_need(behind, args.factor, args.margin_bytes)
    avail = behind[0].get("avail")
    total = sum(db["bytes"] for db in behind)
    log(
        "OpenClaw %s migrates %d database(s), %s in all; it needs about %s free and %s is free"
        % (core.get("version") or "?", len(behind), human(total), human(need), human(avail))
    )
    if avail is not None and avail >= need:
        if status.get("preflight"):
            status["preflight"] = None
            status["updatedAt"] = iso(time.time())
            write_json(status_path, status)
        return 0
    if avail is None:
        warn("the free space beside the databases could not be measured; the migration disk check stands down")
        return 0
    status.update({
        "version": 1,
        "updatedAt": iso(time.time()),
        "source": "install",
        "state": "blocked",
        "reason": "insufficient-disk",
        "requiredBytes": need,
        "freeBytes": avail,
        "preflight": {"target": core.get("version"), "requiredBytes": need, "freeBytes": avail, "at": iso(time.time())},
    })
    write_json(status_path, status)
    print(
        "OpenClaw %s has to migrate %s of agent data and needs about %s free on the disk, but only %s is free. "
        "Free up %s and run the update again; nothing was changed."
        % (core.get("version") or "this core", human(total), human(need), human(avail), human(need - avail)),
        flush=True,
    )
    return 3


def cmd_record_doctor(args):
    status_path = os.path.join(args.data_dir, STATUS_FILE)
    previous = read_json(status_path) or {}
    core = core_schema(args.core_pkg)
    previous["doctor"] = {"core": (core or {}).get("version"), "verdict": args.verdict, "at": iso(time.time())}
    dbs = inventory(args.state_dir, args.config)
    status = migration_status(dbs, core, previous)
    status["source"] = "install"
    write_json(status_path, status)
    log("recorded the migration as %s (%s)" % (args.verdict, status["state"]))
    return 0


# ── memory-rebuild (after the gateway has started) ────────────────────────


def update_owns_box(store_path):
    """The updater's on-disk claim (src/lib/update-lock.ts, src/lib/updater.ts),
    read the way gateway-pre-start.sh's `update_owns_box` reads it."""
    data = read_json(store_path)
    if not data:
        return False
    if data.get("update_in_progress") is True:
        return True
    cont = data.get("update_needs_continuation")
    return isinstance(cont, str) and bool(cont)


def gateway_started(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/startupz" % port, timeout=3) as resp:
            return resp.status == 200
    except Exception:
        return False


def cmd_memory_rebuild(args):
    path = os.path.join(args.data_dir, MEMORY_REBUILD_FILE)
    rec = read_json(path)
    if not rec or rec.get("pending") is not True:
        return 0
    store = args.device_store or os.path.join(args.data_dir, "config.json")
    deadline = time.monotonic() + args.wait_seconds
    while update_owns_box(store) or not gateway_started(args.gateway_port):
        if time.monotonic() > deadline:
            log("memory index rebuild waits for the next gateway start: the gateway did not settle in %d s" % args.wait_seconds)
            return 0
        time.sleep(args.poll_seconds)
    lock_path = os.path.join(args.data_dir, EMBED_LOCK_FILE)
    try:
        lock = open(lock_path, "a")
    except OSError as exc:
        warn("cannot open %s (%s); memory index rebuild left for the next start" % (lock_path, exc))
        return 0
    lock_deadline = time.monotonic() + args.lock_wait_seconds
    while True:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError as exc:
            if exc.errno not in (errno.EAGAIN, errno.EACCES) or time.monotonic() > lock_deadline:
                log("another memory index run holds %s; this rebuild is left for the next start" % lock_path)
                return 0
            time.sleep(args.poll_seconds)
    rec = read_json(path)
    if not rec or rec.get("pending") is not True:
        return 0
    attempts = int(rec.get("attempts") or 0)
    if attempts >= args.max_attempts:
        # Bounded, so a rebuild that cannot finish on this box is not restarted
        # at every gateway start for ever. Memory Shard's "Run a full reindex"
        # is the owner's way to finish it.
        log("memory index rebuild stopped after %d attempts (%s); a full reindex from Memory Shard finishes it"
            % (attempts, rec.get("lastError") or "no error recorded"))
        return 0
    try:
        os.nice(10)
    except OSError:
        pass
    rec["attempts"] = attempts + 1
    rec["lastAttemptAt"] = iso(time.time())
    # The reset only for a NEW MODEL: its old vectors and embedding cache are
    # dead weight (3,072-d, twice over). For a change of sources alone the
    # cache is what lets `index --force` re-embed nothing it has seen — on a box
    # embedding with its own model, a reset would make the rebuild re-embed every
    # memory file and Memory Shard folder on the device itself.
    binary = args.openclaw_bin
    if "model" in (rec.get("reasons") or []) and not rec.get("resetAt"):
        rc, out, err = _run(binary, ["memory", "reset", "--yes"], args.reset_timeout)
        if rc != 0:
            rec["lastError"] = "memory reset: %s" % ("timed out" if rc is None else "exit %s" % rc)
            write_json(path, rec)
            warn("memory reset failed (%s); retried at the next gateway start" % rec["lastError"])
            return 0
        rec["resetAt"] = iso(time.time())
        write_json(path, rec)
        log("memory index reset: the old vectors, transcript chunks and embedding cache are gone (sessions and memory files kept)")
    rc, out, err = _run(binary, ["memory", "index", "--force"], args.index_timeout)
    if rc != 0:
        rec["lastError"] = "memory index: %s" % ("timed out" if rc is None else "exit %s" % rc)
        write_json(path, rec)
        warn("memory index rebuild failed (%s); retried at the next gateway start" % rec["lastError"])
        return 0
    # Exit 0 is not "rebuilt with embeddings". For an unset provider the core's
    # creation-time fallback indexes text only and still exits 0 — this rebuild
    # runs at first boot, before the box has set any embedder — and the line
    # below used to call that a rebuild for the new settings, on an index whose
    # every search then matched words only. So what was BUILT is read back.
    built = [
        memory_index_built(db["path"])
        for db in (discover(args.state_dir, args.config) if args.state_dir else [])
        if db["kind"] == "agent"
    ]
    text_only = any(keyword_only(meta) for meta in built)
    embedded = next((meta for meta in built if isinstance(meta, dict) and not keyword_only(meta)), None)
    rec["pending"] = False
    rec["doneAt"] = iso(time.time())
    rec.pop("lastError", None)
    if text_only:
        rec["keywordOnly"] = True
    elif embedded is not None:
        # Proved embedded: the pre-start's once-per-setting guard goes too, or
        # an index that falls back to text again under the same embedder (a
        # swap to Hermes and back) would never be asked for again.
        rec.pop("keywordOnly", None)
        rec.pop("keywordOnlyFor", None)
    write_json(path, rec)
    if text_only:
        # Not retried here: the same settings would build the same thing. The
        # gateway pre-start asks again once memory.search names an embedder.
        warn("memory index rebuilt KEYWORD-ONLY: no embedding provider answered, so it holds text and no vectors and memory search matches words only; it is rebuilt once memory.search names an embedder")
    elif "keyword_only" in (rec.get("reasons") or []):
        if embedded is None:
            # The core exited 0 and that is all this knows: nothing read back.
            log("memory index rebuilt; what it was built with could not be read back")
        else:
            log("memory index rebuilt with embeddings (%s/%s): it had been built keyword-only"
                % (embedded.get("provider") or "?", embedded.get("model") or "?"))
    else:
        log("memory index rebuilt for the new settings (session transcripts no longer indexed); its freed pages are compacted at the next gateway start")
    return 0


# ── breaker-watch (after a start-guard recovery, once the gateway has started) ──
#
# The starts a recovery follows were unclean boots, and three of them within
# five minutes trip the core's restart-loop breaker: the recovered start comes
# up with channel auto-start held back ("gateway restart-loop breaker tripped:
# 3 unclean boot(s) within 300000ms; suppressing channel/provider account
# auto-start"), so the box's Telegram or Discord stays silent while chat in the
# app works. The pinned core has no command that clears the breaker, and its
# history is the core's own state database, which ClawBox does not write. The
# core lifts it itself: the same process, at its channel health monitor's first
# check after the window has drained, logs "gateway restart-loop breaker
# recovered; channel auto-start restored" and starts the channels it held back.
#
# This waits for that line in the gateway's own output (the start-guard's
# readers), and meanwhile records which channels the core held back (its
# "channel autostart suppressed by crash-loop breaker; refusing automatic start
# for <id>" lines), so the owner is told. Should the core not have lifted it by
# the window plus one health-monitor check plus a margin, each held channel is
# started with the override the core itself names for an operator, `openclaw
# gateway call channels.start`, and whether that worked is recorded too.

BREAKER_TRIPPED_RE = re.compile(r"restart-loop breaker tripped: \d+ unclean boot\(s\) within (\d+)ms")
BREAKER_RECOVERED_RE = re.compile(r"restart-loop breaker recovered")
BREAKER_HELD_RE = re.compile(r"channel autostart suppressed by crash-loop breaker; refusing automatic start for ")
# The manual-start hint the core puts on a held-back line names the channel
# (and the account, when it held back one account) exactly.
BREAKER_HINT_RE = re.compile(r"channels\.start --params '(\{[^']*\})'")
# The journal and the log file carry the same line: two copies this close are
# one trip, not a second boot.
SAME_TRIP_S = 10
# States after which nothing is left to watch.
BREAKER_FINAL = ("restored", "clear", "started", "unknown", "expired")


def held_target(text):
    """{channel, accountId?} from a held-back line's manual-start hint, or None."""
    m = BREAKER_HINT_RE.search(text)
    if not m:
        return None
    try:
        params = json.loads(m.group(1))
    except ValueError:
        return None
    if not isinstance(params, dict) or not isinstance(params.get("channel"), str) or not AGENT_ID.match(params["channel"]):
        return None
    target = {"channel": params["channel"]}
    if isinstance(params.get("accountId"), str) and params["accountId"]:
        target["accountId"] = params["accountId"]
    return target


def breaker_state(lines):
    """What the gateway's own lines say about its restart-loop breaker, as of
    the latest of them: when it last tripped and over which window, the
    channels held back since, when it was lifted after, and when the gateway
    said `gateway ready`."""
    tripped = recovered = ready = None
    window = BREAKER_WINDOW_S
    held = {}
    for at, raw in sorted(lines, key=lambda line: line[0]):
        # A log-file line is JSON: the hint's quotes are escaped in it.
        text = raw.replace('\\"', '"')
        m = BREAKER_TRIPPED_RE.search(text)
        if m:
            if tripped is None or recovered is not None or at - tripped > SAME_TRIP_S:
                held = {}
            tripped, recovered = at, None
            window = int(m.group(1)) / 1000.0
            continue
        if BREAKER_RECOVERED_RE.search(text):
            recovered = at
            continue
        if tripped is not None and recovered is None and BREAKER_HELD_RE.search(text):
            target = held_target(text)
            if target:
                held[(target["channel"], target.get("accountId", ""))] = target
            continue
        if READY_RE.search(raw):
            ready = at
    return {
        "trippedAt": tripped,
        "windowS": window,
        "recoveredAt": recovered,
        "held": [held[k] for k in sorted(held)],
        "readyAt": ready,
    }


def save_channels(path, channels):
    """Only the `channels` entry, over the record as it is on disk now: the
    start-guard owns the rest of it."""
    guard = read_json(path)
    if guard is None:
        warn("%s is unreadable; the restart-loop breaker watch is not recorded" % path)
        return False
    guard["channels"] = channels
    return write_json(path, guard)


def target_name(target):
    return target["channel"] + (" (%s)" % target["accountId"] if target.get("accountId") else "")


def held_accounts(binary, timeout):
    """The channel accounts the gateway itself reports held back by its
    breaker (stopped, its trip message as their last error), or None when it
    could not be asked. The log names only the channel; this names each
    account."""
    rc, out, _err = _run(binary, ["channels", "status", "--json", "--timeout", "10000"], timeout)
    payload = last_json_object(out) if rc == 0 else None
    if not isinstance(payload, dict) or payload.get("gatewayReachable") is False or payload.get("configOnly") is True:
        return None
    accounts = payload.get("channelAccounts")
    if not isinstance(accounts, dict):
        return None
    found = []
    for channel in sorted(accounts):
        rows = accounts[channel] if isinstance(accounts[channel], list) else []
        for row in rows:
            if not isinstance(row, dict) or row.get("running") is True or not AGENT_ID.match(str(channel)):
                continue
            error = row.get("lastError")
            message = error.get("message") if isinstance(error, dict) else error
            if isinstance(message, str) and BREAKER_TRIPPED_RE.search(message):
                target = {"channel": channel}
                if isinstance(row.get("accountId"), str) and row["accountId"]:
                    target["accountId"] = row["accountId"]
                found.append(target)
    return found


def start_held(binary, held, timeout):
    """The core's manual override, once for each held-back account: [(target, ok, exit)]."""
    targets = held_accounts(binary, timeout)
    if targets is None:
        targets = held
    results = []
    for target in targets:
        params = json.dumps(target, sort_keys=True)
        rc, out, _err = _run(binary, ["gateway", "call", "channels.start", "--params", params, "--json", "--timeout", "30000"], timeout)
        reply = last_json_object(out) if rc == 0 else None
        outcome = reply.get("outcome") if isinstance(reply, dict) else None
        # Handed to the channel's own task is started: it connects on its own.
        ok = isinstance(reply, dict) and (reply.get("started") is True
                                          or (isinstance(outcome, dict) and outcome.get("status") == "handed-off"))
        results.append(dict(target, ok=ok, exit=rc))
    return results


def cmd_breaker_watch(args):
    path = os.path.join(args.data_dir, GUARD_FILE)
    guard = read_json(path)
    rec = guard.get("channels") if isinstance(guard, dict) else None
    if not isinstance(rec, dict) or rec.get("watch") is not True:
        return 0
    rec = dict(rec)
    begun = time.time()

    def record(state, **facts):
        rec.update(facts)
        rec["state"] = state
        rec["checkedAt"] = time.time()
        if state in BREAKER_FINAL:
            rec["watch"] = False
        save_channels(path, rec)

    since = rec.get("since")
    if not isinstance(since, (int, float)) or isinstance(since, bool) or begun - since > BREAKER_WATCH_MAX_AGE_S:
        record("expired")
        return 0
    try:
        os.nice(10)
    except OSError:
        pass
    deadline = time.monotonic() + args.wait_seconds
    while not gateway_started(args.gateway_port):
        if time.monotonic() > deadline:
            log("restart-loop breaker watch waits for the next gateway start: the gateway did not start in %d s" % args.wait_seconds)
            return 0
        time.sleep(args.poll_seconds)
    started = time.time()
    # This start's lines only. The gateway decides about its breaker as it
    # boots, which is after this pre-start launched the watch.
    since_lines = begun - 5
    end = time.monotonic() + args.max_seconds
    shown = None
    while True:
        lines = journal_lines(args.unit, since_lines) + file_log_lines(openclaw_log_files(args.config, args.log_dir), since_lines)
        st = breaker_state(lines)
        now = time.time()
        if st["recoveredAt"] is not None:
            log("the core lifted its restart-loop breaker; channel auto-start is back")
            record("restored", recoveredAt=st["recoveredAt"])
            return 0
        if st["trippedAt"] is None:
            if st["readyAt"] is not None:
                log("this gateway start did not trip the core's restart-loop breaker; channels start as usual")
                record("clear")
                return 0
            if now - started > args.read_grace_seconds:
                # Neither a trip nor `gateway ready` can be read: nothing is
                # claimed either way.
                warn("the gateway's own output cannot be read, so whether its restart-loop breaker holds channels back is not known")
                record("unknown")
                return 0
        else:
            held = st["held"]
            # The core's own last chance: its first health-monitor check after
            # the window, or the monitor's first check if it started later.
            settle = max(started + args.health_grace_seconds,
                         st["trippedAt"] + st["windowS"] + args.health_check_seconds) + args.margin_seconds
            if held and held != shown:
                log("the core's restart-loop breaker holds back %s; it lifts it itself, at the latest by %s"
                    % (", ".join(target_name(t) for t in held), iso(settle)))
                record("suppressed", trippedAt=st["trippedAt"], held=held)
                shown = held
            if now >= settle:
                if not held:
                    log("the core's restart-loop breaker tripped, and held no channel back")
                    record("clear", trippedAt=st["trippedAt"])
                    return 0
                # Not lifted in time: the override the core names for an operator.
                results = start_held(args.openclaw_bin, held, args.call_timeout)
                if not results:
                    log("the gateway no longer reports a channel account held back by its restart-loop breaker")
                    record("clear", trippedAt=st["trippedAt"])
                elif all(r["ok"] for r in results):
                    log("the core had not lifted its restart-loop breaker; started %s by hand (openclaw gateway call channels.start)"
                        % ", ".join(target_name(r) for r in results))
                    record("started", manualStarts=results)
                else:
                    warn("the core had not lifted its restart-loop breaker, and channels.start did not start %s; the owner is told"
                         % ", ".join(target_name(r) for r in results if not r["ok"]))
                    record("suppressed", manualStarts=results)
                return 0
        if time.monotonic() > end:
            log("restart-loop breaker watch stopped after %d s; the next gateway start looks again" % args.max_seconds)
            return 0
        time.sleep(args.poll_seconds)


# ── entry ─────────────────────────────────────────────────────────────────


def main(argv=None):
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        # A signal the launcher set to be ignored (nohup's SIGHUP) stays ignored.
        if signal.getsignal(signum) is not signal.SIG_IGN:
            signal.signal(signum, _on_signal)
    parser = argparse.ArgumentParser(prog="openclaw-db-maintenance")
    sub = parser.add_subparsers(dest="cmd")

    def common(p):
        p.add_argument("--state-dir", required=True)
        p.add_argument("--config", default=None)
        p.add_argument("--data-dir", required=True)
        p.add_argument("--core-pkg", default=None)
        p.add_argument("--free-bytes-override", type=int, default=None, help=argparse.SUPPRESS)

    p = sub.add_parser("prestart")
    common(p)
    p.add_argument("--openclaw-bin", required=True)
    p.add_argument("--budget-seconds", type=int, default=360)
    p.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    p.add_argument("--live-rate-bps", type=float, default=DEFAULT_LIVE_RATE_BPS)
    p.add_argument("--cli-overhead-seconds", type=float, default=CLI_OVERHEAD_S)

    p = sub.add_parser("start-guard")
    common(p)
    p.add_argument("--openclaw-bin", required=True)
    p.add_argument("--unit", default=GATEWAY_UNIT)
    p.add_argument("--restarts", type=int, default=0)
    p.add_argument("--budget-seconds", type=int, default=420)
    # Where the core's rolling log files are, instead of its default places.
    p.add_argument("--log-dir", action="append", default=[])

    p = sub.add_parser("preflight")
    common(p)
    p.add_argument("--factor", type=float, default=DEFAULT_MIGRATION_FACTOR)
    p.add_argument("--margin-bytes", type=int, default=DEFAULT_MIGRATION_MARGIN)

    p = sub.add_parser("record-doctor")
    common(p)
    p.add_argument("--verdict", choices=("complete", "incomplete"), required=True)

    p = sub.add_parser("memory-rebuild")
    p.add_argument("--data-dir", required=True)
    # Where the agent databases are, to read back what the rebuild built.
    p.add_argument("--state-dir", default=None)
    p.add_argument("--config", default=None)
    p.add_argument("--openclaw-bin", required=True)
    p.add_argument("--device-store", default=None)
    p.add_argument("--gateway-port", type=int, default=18789)
    p.add_argument("--wait-seconds", type=int, default=5400)
    p.add_argument("--poll-seconds", type=float, default=15)
    p.add_argument("--lock-wait-seconds", type=int, default=600)
    p.add_argument("--reset-timeout", type=int, default=600)
    p.add_argument("--index-timeout", type=int, default=1800)
    p.add_argument("--max-attempts", type=int, default=3)

    p = sub.add_parser("breaker-watch")
    p.add_argument("--data-dir", required=True)
    p.add_argument("--config", default=None)
    p.add_argument("--openclaw-bin", required=True)
    p.add_argument("--unit", default=GATEWAY_UNIT)
    p.add_argument("--log-dir", action="append", default=[])
    p.add_argument("--gateway-port", type=int, default=18789)
    # The rest of a pre-start (up to its 600 s ceiling), then a cold start.
    p.add_argument("--wait-seconds", type=int, default=1800)
    p.add_argument("--poll-seconds", type=float, default=20)
    p.add_argument("--read-grace-seconds", type=int, default=300)
    p.add_argument("--max-seconds", type=int, default=3600)
    p.add_argument("--call-timeout", type=int, default=90)
    # The core's health-monitor timing and the margin after it, for the tests.
    p.add_argument("--health-check-seconds", type=float, default=HEALTH_CHECK_S, help=argparse.SUPPRESS)
    p.add_argument("--health-grace-seconds", type=float, default=HEALTH_GRACE_S, help=argparse.SUPPRESS)
    p.add_argument("--margin-seconds", type=float, default=BREAKER_MARGIN_S, help=argparse.SUPPRESS)

    args = parser.parse_args(argv)
    if not args.cmd:
        parser.print_usage(sys.stderr)
        return 2
    global _FREE_BYTES_OVERRIDE
    _FREE_BYTES_OVERRIDE = getattr(args, "free_bytes_override", None)
    handler = {
        "prestart": cmd_prestart,
        "start-guard": cmd_start_guard,
        "preflight": cmd_preflight,
        "record-doctor": cmd_record_doctor,
        "memory-rebuild": cmd_memory_rebuild,
        "breaker-watch": cmd_breaker_watch,
    }[args.cmd]
    try:
        return handler(args)
    except Exception as exc:  # housekeeping never fails its caller
        warn("%s stopped: %s: %s" % (args.cmd, type(exc).__name__, exc))
        return 0


if __name__ == "__main__":
    sys.exit(main())
