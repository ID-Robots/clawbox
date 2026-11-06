#!/usr/bin/env python3
"""Stamps for the gateway pre-start: re-use a check whose inputs have not changed.

scripts/gateway-pre-start.sh runs as the BLOCKING ExecStartPre of
clawbox-gateway.service, and three of its checks cost a CLI cold start each on
every boot of a box whose answer has not changed in weeks — 8-12 s apiece on a
Jetson, with the gateway (and every chat) down while they run:

``codex-registry``
    ``openclaw plugins list --json``: does the core's registry see every
    dependency of the installed Codex plugin?
``plugin-consent``
    ``openclaw plugins inspect --all --json``: which managed plugins the core
    reports as consented.
``claude-code``
    ``claude --version`` and a read of every bundle file in the core, to make
    the core report the installed Claude Code to Anthropic.

A provider, model or sign-in switch that needs a gateway restart changes none
of what those checks read, and paid for all three anyway. This helper lets the
script ask instead: "is the answer the last full check recorded still the
answer?" — and say yes only when all of these hold:

  1. the KEY matches: a hash over everything the check reads (below). The
     `plugins` key covers the core, the pre-start script, the `plugins` section
     of openclaw.json and the manifests of every plugin payload on disk — NOT
     `agents`, `auth` or `models`, which are what a provider switch writes and
     what neither plugin check reads. The
     `claude-code` key covers the core package and every Claude Code binary
     the script would ask;
  2. the record is less than a day old, so every box still runs each full
     check at least once a day it restarts;
  3. the START-GUARD's record (data/openclaw-start-guard.json, written at the
     top of this same pre-start) shows this start is not an automatic restart
     after a failure (systemd's NRestarts is 0) and that the PREVIOUS start
     reached `gateway ready` after it began. A reused answer that turned out
     wrong would have kept the gateway from becoming ready, and the very next
     start then runs the full checks. On a core without the start-guard
     (before 2026.10) there is no such proof, and nothing is ever reused;
  4. the operator did not ask for a full run (CLAWBOX_PRESTART_FULL=1 makes
     the script pass --no-reuse).

Anything this helper cannot read is a miss, never a hit: a miss costs what
every boot cost before, a wrong hit could cost a gateway that does not start.

Usage (stdout is one tab-separated line; the exit status is 0 for both):

  check --step NAME --kind plugins|claude --record FILE --guard FILE
        --script FILE --core-pkg FILE [--config FILE --openclaw-home DIR
        --global-modules DIR] [--candidate PATH ...] [--no-reuse]
      -> "hit<TAB><key><TAB><value>"  or  "miss<TAB><key or -><TAB><reason>"
  remember --step NAME --key KEY [--value VALUE] --record FILE
      -> writes the record; exit 1 when it could not
"""

import argparse
import glob
import hashlib
import json
import os
import sys
import time

# A full check at least once a day the gateway restarts, whatever the key says.
MAX_AGE_S = 24 * 60 * 60
# The start-guard records this start at the top of the pre-start; the checks
# that ask here run within the unit's 600 s TimeoutStartSec of it.
CURRENT_START_MAX_AGE_S = 900
RECORD_VERSION = 1


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


def file_digest(path):
    """sha256 of a file's bytes, or a word saying why there is none."""
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except FileNotFoundError:
        return "absent"
    except OSError:
        return "unreadable"


def file_identity(path):
    """Size and mtime: enough to see a reinstall of the same version."""
    try:
        st = os.stat(path)
    except OSError:
        return "absent"
    return "%d:%d" % (st.st_size, st.st_mtime_ns)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def plugin_dirs(openclaw_home, global_modules):
    """Every directory a ClawBox-managed plugin payload can live in.

    The layouts the pre-start itself resolves (the flat and project-managed
    npm homes, the extensions directory, a global install), and only their
    plugin roots: the dependency trees under them are thousands of packages
    whose versions follow the plugin's own package.json and lock file.
    """
    patterns = []
    if openclaw_home:
        patterns += [
            os.path.join(openclaw_home, "extensions", "*"),
            os.path.join(openclaw_home, "npm", "node_modules", "@openclaw", "*"),
            os.path.join(openclaw_home, "npm", "node_modules", "openclaw-*"),
            os.path.join(openclaw_home, "npm", "projects", "*"),
            os.path.join(openclaw_home, "npm", "projects", "*", "node_modules", "@openclaw", "*"),
            os.path.join(openclaw_home, "npm", "projects", "*", "node_modules", "openclaw-*"),
        ]
    if global_modules:
        patterns += [
            os.path.join(global_modules, "@openclaw", "*"),
            os.path.join(global_modules, "openclaw-*"),
        ]
    found = set()
    for pattern in patterns:
        for path in glob.glob(pattern):
            if os.path.isdir(path):
                found.add(os.path.normpath(path))
    return sorted(found)


def plugins_key_parts(args):
    parts = []
    with open(args.config, "r", encoding="utf-8") as fh:
        config = json.load(fh)
    if not isinstance(config, dict):
        raise ValueError("openclaw.json is not an object")
    # Which plugins are enabled, allowed, loaded from where: what decides both
    # answers apart from the payloads below. Which MODEL is selected does not
    # enter: the core's reports are about every plugin, selected or not, and
    # the script decides which of them to ask about on every boot.
    parts.append("plugins-config=" + canonical(config.get("plugins")))
    for path in plugin_dirs(args.openclaw_home, args.global_modules):
        peer = os.path.join(path, "node_modules", "openclaw")
        parts.append("plugin=%s pkg=%s manifest=%s lock=%s peer=%s peer-pkg=%s" % (
            path,
            file_digest(os.path.join(path, "package.json")),
            file_digest(os.path.join(path, "openclaw.plugin.json")),
            file_identity(os.path.join(path, "package-lock.json")),
            os.path.realpath(peer) if os.path.lexists(peer) else "-",
            "yes" if os.path.isfile(os.path.join(peer, "package.json")) else "no",
        ))
    return parts


def claude_key_parts(args):
    parts = []
    for candidate in args.candidate or []:
        real = os.path.realpath(candidate)
        parts.append("claude=%s real=%s id=%s" % (candidate, real, file_identity(real)))
    if not parts:
        raise ValueError("no Claude Code binary to key on")
    return parts


def compute_key(args):
    script = file_digest(args.script)
    core = file_digest(args.core_pkg)
    if script in ("absent", "unreadable") or core in ("absent", "unreadable"):
        raise ValueError("the pre-start script or the core's package.json cannot be read")
    parts = [
        "record=%d" % RECORD_VERSION,
        "kind=" + args.kind,
        # Any ClawBox update that touches the pre-start re-runs every check once.
        "script=" + script,
        # The core: its version, and the install itself (a reinstall of the
        # same version puts the bundle's own constants back).
        "core=%s %s" % (core, file_identity(args.core_pkg)),
    ]
    if args.kind == "plugins":
        parts += plugins_key_parts(args)
    else:
        parts += claude_key_parts(args)
    return hashlib.sha256("\n".join(parts).encode("utf-8", "surrogateescape")).hexdigest()


def previous_start_proven(guard_path, now):
    """None when the start-guard's record proves the previous start reached
    `gateway ready` and this start is not an automatic restart; otherwise why not."""
    guard = read_json(guard_path)
    if not guard:
        return "no start record to prove the last start reached gateway ready"
    starts = [s for s in (guard.get("starts") or [])
              if isinstance(s, dict) and isinstance(s.get("at"), (int, float))]
    if len(starts) < 2:
        return "no earlier start on record"
    current, previous = starts[-1], starts[-2]
    if not (0 <= now - current["at"] <= CURRENT_START_MAX_AGE_S):
        return "this start was not recorded"
    if current.get("restarts") != 0:
        return "systemd is restarting the gateway after a failure"
    proven = guard.get("provenAt")
    if not isinstance(proven, (int, float)) or proven <= previous["at"]:
        return "the previous start did not reach gateway ready"
    return None


def cmd_check(args):
    now = time.time()
    try:
        key = compute_key(args)
    except Exception as exc:  # anything unreadable is a miss
        print("miss\t-\tits inputs could not be read (%s)" % str(exc).replace("\t", " ").splitlines()[0][:120])
        return 0
    if args.no_reuse:
        print("miss\t%s\ta full check was asked for (CLAWBOX_PRESTART_FULL)" % key)
        return 0
    record = read_json(args.record)
    entry = ((record or {}).get("steps") or {}).get(args.step)
    if not isinstance(entry, dict) or not isinstance(entry.get("savedAt"), (int, float)):
        print("miss\t%s\tno earlier full check on record" % key)
        return 0
    if entry.get("key") != key:
        print("miss\t%s\tsomething it reads changed since the last full check" % key)
        return 0
    if not (0 <= now - entry["savedAt"] <= MAX_AGE_S):
        print("miss\t%s\tthe last full check is more than a day old" % key)
        return 0
    why_not = previous_start_proven(args.guard, now)
    if why_not:
        print("miss\t%s\t%s" % (key, why_not))
        return 0
    value = entry.get("value")
    value = value if isinstance(value, str) else ""
    print("hit\t%s\t%s" % (key, value.replace("\t", " ").replace("\n", " ")))
    return 0


def cmd_remember(args):
    if not args.key or args.key == "-":
        return 1
    record = read_json(args.record)
    if record is None:
        record = {}
    steps = record.get("steps") if isinstance(record.get("steps"), dict) else {}
    steps[args.step] = {"key": args.key, "value": args.value or "", "savedAt": time.time()}
    record["steps"] = steps
    record["version"] = RECORD_VERSION
    tmp = "%s.tmp-%d" % (args.record, os.getpid())
    try:
        os.makedirs(os.path.dirname(os.path.abspath(args.record)), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(record, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, args.record)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return 1
    return 0


def main(argv):
    parser = argparse.ArgumentParser(prog="gateway-pre-start-stamps.py")
    sub = parser.add_subparsers(dest="cmd", required=True)
    check = sub.add_parser("check")
    check.add_argument("--step", required=True)
    check.add_argument("--kind", required=True, choices=("plugins", "claude"))
    check.add_argument("--record", required=True)
    check.add_argument("--guard", required=True)
    check.add_argument("--script", required=True)
    check.add_argument("--core-pkg", required=True)
    check.add_argument("--config")
    check.add_argument("--openclaw-home")
    check.add_argument("--global-modules")
    check.add_argument("--candidate", action="append")
    check.add_argument("--no-reuse", action="store_true")
    remember = sub.add_parser("remember")
    remember.add_argument("--step", required=True)
    remember.add_argument("--key", required=True)
    remember.add_argument("--value", default="")
    remember.add_argument("--record", required=True)
    args = parser.parse_args(argv)
    if args.cmd == "check":
        if args.kind == "plugins" and not args.config:
            print("miss\t-\tno openclaw.json to key on")
            return 0
        return cmd_check(args)
    return cmd_remember(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
