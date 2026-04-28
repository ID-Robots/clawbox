from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from clawkeep import token


def test_write_then_read_roundtrip(tmp_path: Path) -> None:
    p = tmp_path / "token"
    token.write_token("claw_abc123", p)
    assert token.read_token(p) == "claw_abc123"
    assert stat.S_IMODE(p.stat().st_mode) == 0o600


def test_read_missing_token_raises(tmp_path: Path) -> None:
    with pytest.raises(token.TokenError, match="No token"):
        token.read_token(tmp_path / "nope")


def test_refuses_non_claw_token(tmp_path: Path) -> None:
    with pytest.raises(token.TokenError, match="claw_"):
        token.write_token("not-a-real-token", tmp_path / "token")


def test_read_rejects_garbage(tmp_path: Path) -> None:
    p = tmp_path / "token"
    p.write_text("garbage")
    # read_token calls assert_perms before the content check, so the
    # file has to be 0600 first; otherwise the perm check would fire
    # and mask the real test (the format rejection).
    os.chmod(p, 0o600)
    with pytest.raises(token.TokenError, match="not a valid"):
        token.read_token(p)


def test_repo_password_is_persistent(tmp_path: Path) -> None:
    p = tmp_path / "repo-pass"
    pw1 = token.read_or_create_repo_password(p)
    pw2 = token.read_or_create_repo_password(p)
    assert pw1 == pw2
    assert len(pw1) == 64  # 32 bytes hex
    assert stat.S_IMODE(p.stat().st_mode) == 0o600


def test_assert_perms_raises_on_world_readable(tmp_path: Path) -> None:
    p = tmp_path / "token"
    p.write_text("claw_x")
    os.chmod(p, 0o644)
    with pytest.raises(token.TokenError, match="insecure permissions"):
        token.assert_perms(p)


def test_delete_token_is_idempotent(tmp_path: Path) -> None:
    p = tmp_path / "token"
    token.delete_token(p)  # missing — should not raise
    token.write_token("claw_x", p)
    token.delete_token(p)
    assert not p.exists()
