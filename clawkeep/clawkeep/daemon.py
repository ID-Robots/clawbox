"""`clawkeepd` — runs one backup (or one idle heartbeat) and exits.

systemd's timer schedules invocations; we don't keep a long-running event
loop ourselves (section 5 of clawkeep-plan.md).
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from . import config as cfg_mod
from . import runner, token


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

    return runner.run_once(cfg, bearer)


if __name__ == "__main__":
    sys.exit(main())
