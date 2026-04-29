"""Load config.toml into a typed Config object.

Default search order (matches the TS bridge in src/lib/clawkeep.ts):
  1. $CLAWKEEP_CONFIG_PATH if set
  2. $CLAWKEEP_DATA_DIR/config.toml if that file exists
  3. /etc/clawkeep/config.toml (system install)

This lets `clawkeepd` run bare on a clawbox device where the UI writes
to ~/.clawkeep/config.toml, without forcing the user to remember --config.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover — exercised only on 3.10
    import tomli as tomllib  # type: ignore[no-redef]


def default_config_path() -> Path:
    explicit = os.environ.get("CLAWKEEP_CONFIG_PATH", "").strip()
    if explicit:
        return Path(explicit)
    data_dir = os.environ.get("CLAWKEEP_DATA_DIR", "").strip()
    if data_dir:
        candidate = Path(data_dir) / "config.toml"
        if candidate.exists():
            return candidate
    home_candidate = Path.home() / ".clawkeep" / "config.toml"
    if home_candidate.exists():
        return home_candidate
    return Path("/etc/clawkeep/config.toml")


# Module-level constant kept for callers that import it; resolved at
# import time. CLI uses default_config_path() at parse time so a later
# env-var change still wins.
DEFAULT_CONFIG_PATH = default_config_path()


@dataclass(frozen=True)
class OpenclawConfig:
    binary: str = "openclaw"
    include_workspace: bool = True
    only_config: bool = False
    verify: bool = True
    # Empty string = use a per-run tmpdir. A persistent path is fine too,
    # but the runner deletes the archive after upload either way.
    output_dir: str = ""


@dataclass(frozen=True)
class HeartbeatConfig:
    idle_interval_hours: int = 24


@dataclass(frozen=True)
class Config:
    server: str
    schedule: str = "daily"
    openclaw: OpenclawConfig = field(default_factory=OpenclawConfig)
    heartbeat: HeartbeatConfig = field(default_factory=HeartbeatConfig)


class ConfigError(Exception):
    pass


def _safe_int(value: object, *, key: str, default: int) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as e:
        raise ConfigError(f"'{key}' must be an integer, got {value!r}") from e


def _safe_bool(value: object, *, key: str) -> bool:
    if isinstance(value, bool):
        return value
    raise ConfigError(f"'{key}' must be a boolean, got {value!r}")


def load(path: Path | str | None = None) -> Config:
    # Resolve the default at call time, not at import, so $CLAWKEEP_*
    # env vars set after import still take effect.
    p = Path(path if path is not None else default_config_path())
    if not p.exists():
        raise ConfigError(f"Config file not found: {p}")
    try:
        with p.open("rb") as f:
            raw = tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"Invalid TOML in {p}: {e}") from e

    server = raw.get("server")
    if not isinstance(server, str) or not server.strip():
        raise ConfigError("'server' must be a non-empty string")

    schedule = raw.get("schedule", "daily")
    if schedule not in ("daily", "weekly", "manual"):
        raise ConfigError(f"'schedule' must be daily|weekly|manual, got {schedule!r}")

    openclaw_raw = raw.get("openclaw", {}) or {}
    if not isinstance(openclaw_raw, dict):
        raise ConfigError(f"'openclaw' must be a table, got {type(openclaw_raw).__name__}")
    openclaw = OpenclawConfig(
        binary=str(openclaw_raw.get("binary", "openclaw")),
        include_workspace=_safe_bool(
            openclaw_raw.get("include_workspace", True),
            key="openclaw.include_workspace",
        ),
        only_config=_safe_bool(
            openclaw_raw.get("only_config", False),
            key="openclaw.only_config",
        ),
        verify=_safe_bool(
            openclaw_raw.get("verify", True),
            key="openclaw.verify",
        ),
        output_dir=str(openclaw_raw.get("output_dir", "")),
    )

    heartbeat_raw = raw.get("heartbeat", {}) or {}
    if not isinstance(heartbeat_raw, dict):
        raise ConfigError(f"'heartbeat' must be a table, got {type(heartbeat_raw).__name__}")
    heartbeat = HeartbeatConfig(
        idle_interval_hours=_safe_int(
            heartbeat_raw.get("idle_interval_hours", 24),
            key="heartbeat.idle_interval_hours",
            default=24,
        ),
    )

    return Config(
        server=server.rstrip("/"),
        schedule=schedule,
        openclaw=openclaw,
        heartbeat=heartbeat,
    )
