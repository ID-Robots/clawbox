"""`clawkeepd` — runs one backup (or one idle heartbeat) and exits.

systemd's timer schedules invocations; we don't keep a long-running event
loop ourselves (section 5 of clawkeep-plan.md).
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import threading
from pathlib import Path

from . import config as cfg_mod
from . import runner, token


def _exit_on_sigterm(signum: int, _frame: object) -> None:
    # SIGTERM's default ends the process where it stands, so a stopped run
    # never reached `run_once`'s cleanup and left its staging archive behind.
    # Raised, it unwinds through every `finally` on the way out.
    raise SystemExit(128 + signum)


def _setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def main(argv: list[str] | None = None) -> int:
    # Resolve defaults lazily so $CLAWKEEP_DATA_DIR set after import still wins.
    parser = argparse.ArgumentParser(prog="clawkeepd")
    parser.add_argument(
        "--config",
        default=str(cfg_mod.default_config_path()),
        help=(
            "Path to config.toml. Defaults: $CLAWKEEP_CONFIG_PATH → "
            "$CLAWKEEP_DATA_DIR/config.toml → ~/.clawkeep/config.toml → "
            "/etc/clawkeep/config.toml"
        ),
    )
    parser.add_argument(
        "--token-path",
        default=str(token.default_token_path()),
        help="Path to token file (default: $CLAWKEEP_DATA_DIR/token)",
    )
    parser.add_argument(
        "--idle",
        action="store_true",
        help="Send an 'idle' heartbeat instead of running a backup",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single backup cycle and exit (default; reserved for clarity)",
    )
    parser.add_argument(
        "--label",
        default=None,
        help="Optional human label to record for this backup's snapshot",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    _setup_logging(args.verbose)
    log = logging.getLogger("clawkeepd")

    try:
        cfg = cfg_mod.load(Path(args.config))
    except cfg_mod.ConfigError as e:
        log.error("config error: %s", e)
        return 64  # EX_USAGE

    try:
        bearer = token.read_token(Path(args.token_path))
    except token.TokenError as e:
        log.error("token error: %s", e)
        return 65  # EX_DATAERR

    if args.idle:
        return runner.run_idle(cfg, bearer)

    label = args.label.strip() if isinstance(args.label, str) and args.label.strip() else None
    # Only the main thread may set a handler; a run driven from another thread
    # (the test suite does) keeps the process's own.
    on_main = threading.current_thread() is threading.main_thread()
    previous = signal.signal(signal.SIGTERM, _exit_on_sigterm) if on_main else None
    try:
        return runner.run_once(cfg, bearer, label=label)
    finally:
        if on_main:
            signal.signal(signal.SIGTERM, previous or signal.SIG_DFL)


if __name__ == "__main__":
    sys.exit(main())
