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
class ResticConfig:
    binary: str = "/usr/bin/restic"
    compression: str = "auto"
    read_concurrency: int = 2


@dataclass(frozen=True)
class HeartbeatConfig:
    idle_interval_hours: int = 24


@dataclass(frozen=True)
class Config:
    server: str
    paths: list[str]
    exclude: list[str] = field(default_factory=list)
    schedule: str = "daily"
    restic: ResticConfig = field(default_factory=ResticConfig)
    heartbeat: HeartbeatConfig = field(default_factory=HeartbeatConfig)


class ConfigError(Exception):
    pass


def load(path: Path | str = DEFAULT_CONFIG_PATH) -> Config:
    p = Path(path)
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

    paths = raw.get("paths")
    if not isinstance(paths, list) or not paths or not all(isinstance(p, str) for p in paths):
        raise ConfigError("'paths' must be a non-empty list of strings")

    exclude = raw.get("exclude", [])
    if not isinstance(exclude, list) or not all(isinstance(p, str) for p in exclude):
        raise ConfigError("'exclude' must be a list of strings")

    schedule = raw.get("schedule", "daily")
    if schedule not in ("daily", "weekly", "manual"):
        raise ConfigError(f"'schedule' must be daily|weekly|manual, got {schedule!r}")

    restic_raw = raw.get("restic", {}) or {}
    restic = ResticConfig(
        binary=restic_raw.get("binary", "/usr/bin/restic"),
        compression=restic_raw.get("compression", "auto"),
        read_concurrency=int(restic_raw.get("read_concurrency", 2)),
    )

    heartbeat_raw = raw.get("heartbeat", {}) or {}
    heartbeat = HeartbeatConfig(
        idle_interval_hours=int(heartbeat_raw.get("idle_interval_hours", 24)),
    )

    return Config(
        server=server.rstrip("/"),
        paths=list(paths),
        exclude=list(exclude),
        schedule=schedule,
        restic=restic,
        heartbeat=heartbeat,
    )
