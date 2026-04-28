from __future__ import annotations

from pathlib import Path

import pytest

from clawkeep import config


def write(tmp_path: Path, content: str) -> Path:
    p = tmp_path / "config.toml"
    p.write_text(content, encoding="utf-8")
    return p


def test_loads_minimum_valid_config(tmp_path: Path) -> None:
    p = write(
        tmp_path,
        """
        server = "https://openclawhardware.dev/"
        paths = ["/home"]
        """,
    )
    cfg = config.load(p)
    assert cfg.server == "https://openclawhardware.dev"  # trailing slash stripped
    assert cfg.paths == ["/home"]
    assert cfg.exclude == []
    assert cfg.schedule == "daily"
    assert cfg.restic.binary == "/usr/bin/restic"
    assert cfg.heartbeat.idle_interval_hours == 24


def test_overrides_apply(tmp_path: Path) -> None:
    p = write(
        tmp_path,
        """
        server = "https://example.com"
        paths = ["/a", "/b"]
        exclude = ["**/node_modules"]
        schedule = "weekly"

        [restic]
        binary = "/opt/restic"
        compression = "max"
        read_concurrency = 4

        [heartbeat]
        idle_interval_hours = 12
        """,
    )
    cfg = config.load(p)
    assert cfg.paths == ["/a", "/b"]
    assert cfg.schedule == "weekly"
    assert cfg.restic.binary == "/opt/restic"
    assert cfg.restic.compression == "max"
    assert cfg.restic.read_concurrency == 4
    assert cfg.heartbeat.idle_interval_hours == 12


def test_missing_server_rejected(tmp_path: Path) -> None:
    p = write(tmp_path, 'paths = ["/home"]\n')
    with pytest.raises(config.ConfigError, match="server"):
        config.load(p)


def test_missing_paths_rejected(tmp_path: Path) -> None:
    p = write(tmp_path, 'server = "https://x"\n')
    with pytest.raises(config.ConfigError, match="paths"):
        config.load(p)


def test_invalid_schedule_rejected(tmp_path: Path) -> None:
    p = write(
        tmp_path,
        '''
        server = "https://x"
        paths = ["/home"]
        schedule = "fortnightly"
        ''',
    )
    with pytest.raises(config.ConfigError, match="schedule"):
        config.load(p)


def test_missing_file_rejected(tmp_path: Path) -> None:
    with pytest.raises(config.ConfigError, match="not found"):
        config.load(tmp_path / "nope.toml")
