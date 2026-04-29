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
        """,
    )
    cfg = config.load(p)
    assert cfg.server == "https://openclawhardware.dev"  # trailing slash stripped
    assert cfg.schedule == "daily"
    assert cfg.openclaw.binary == "openclaw"
    assert cfg.openclaw.include_workspace is True
    assert cfg.openclaw.only_config is False
    assert cfg.openclaw.verify is True
    assert cfg.openclaw.output_dir == ""
    assert cfg.heartbeat.idle_interval_hours == 24


def test_overrides_apply(tmp_path: Path) -> None:
    p = write(
        tmp_path,
        """
        server = "https://example.com"
        schedule = "weekly"

        [openclaw]
        binary = "/opt/openclaw"
        include_workspace = false
        only_config = true
        verify = false
        output_dir = "/var/lib/clawkeep/staging"

        [heartbeat]
        idle_interval_hours = 12
        """,
    )
    cfg = config.load(p)
    assert cfg.schedule == "weekly"
    assert cfg.openclaw.binary == "/opt/openclaw"
    assert cfg.openclaw.include_workspace is False
    assert cfg.openclaw.only_config is True
    assert cfg.openclaw.verify is False
    assert cfg.openclaw.output_dir == "/var/lib/clawkeep/staging"
    assert cfg.heartbeat.idle_interval_hours == 12


def test_missing_server_rejected(tmp_path: Path) -> None:
    p = write(tmp_path, "schedule = \"daily\"\n")
    with pytest.raises(config.ConfigError, match="server"):
        config.load(p)


def test_invalid_schedule_rejected(tmp_path: Path) -> None:
    p = write(
        tmp_path,
        '''
        server = "https://x"
        schedule = "fortnightly"
        ''',
    )
    with pytest.raises(config.ConfigError, match="schedule"):
        config.load(p)


def test_invalid_bool_rejected(tmp_path: Path) -> None:
    p = write(
        tmp_path,
        '''
        server = "https://x"
        [openclaw]
        include_workspace = "yes"
        ''',
    )
    with pytest.raises(config.ConfigError, match="include_workspace"):
        config.load(p)


def test_missing_file_rejected(tmp_path: Path) -> None:
    with pytest.raises(config.ConfigError, match="not found"):
        config.load(tmp_path / "nope.toml")
