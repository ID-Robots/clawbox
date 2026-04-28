"""Read/write the bearer token at $CLAWKEEP_DATA_DIR/token.

Default data dir is /var/lib/clawkeep (system install). Override with
$CLAWKEEP_DATA_DIR=/home/clawbox/.clawkeep when co-resident with the
clawbox Next.js process so the daemon and the UI can share state
without needing a privileged user.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path


def data_dir() -> Path:
    """Resolve $CLAWKEEP_DATA_DIR, with a smart fallback for clawbox.

    Order:
      1. $CLAWKEEP_DATA_DIR if set
      2. ~/.clawkeep if that directory exists (clawbox UI seeds it there)
      3. /var/lib/clawkeep (system-install default)

    Lets `clawkeepd` run bare on a clawbox device without remembering
    the env var; on a system-installed setup `/var/lib/clawkeep` wins.
    """
    explicit = os.environ.get("CLAWKEEP_DATA_DIR", "").strip()
    if explicit:
        return Path(explicit)
    home_candidate = Path.home() / ".clawkeep"
    if home_candidate.is_dir():
        return home_candidate
    return Path("/var/lib/clawkeep")


def default_token_path() -> Path:
    return data_dir() / "token"


def default_repo_pass_path() -> Path:
    return data_dir() / "repo-pass"


# Module-level constants for backward compat. Resolved at import time;
# tests and external imports that need to flip CLAWKEEP_DATA_DIR mid-run
# should call default_token_path() / default_repo_pass_path() instead.
DEFAULT_TOKEN_PATH = default_token_path()
DEFAULT_REPO_PASS_PATH = default_repo_pass_path()


class TokenError(Exception):
    pass


def read_token(path: Path | str | None = None) -> str:
    p = Path(path if path is not None else default_token_path())
    if not p.exists():
        raise TokenError(f"No token at {p}; run 'clawkeep pair' first")
    token = p.read_text(encoding="utf-8").strip()
    if not token.startswith("claw_"):
        raise TokenError(f"Token at {p} is not a valid claw_* token")
    return token


def write_token(token: str, path: Path | str | None = None) -> None:
    if not token.startswith("claw_"):
        raise TokenError("refusing to write non-claw_* token")
    p = Path(path if path is not None else default_token_path())
    p.parent.mkdir(parents=True, exist_ok=True)
    # Write atomically with restrictive perms — never widen an existing file.
    # `os.open` with mode 0o600 + a typical 0o022 umask already yields 0o600
    # at create time; no follow-up chmod needed.
    tmp = p.with_suffix(p.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, token.encode("utf-8"))
    finally:
        os.close(fd)
    os.replace(tmp, p)


def delete_token(path: Path | str | None = None) -> None:
    p = Path(path if path is not None else default_token_path())
    if p.exists():
        p.unlink()


def read_or_create_repo_password(path: Path | str | None = None) -> str:
    """Restic repo password. Generated on first run; persisted at 0600.

    Losing this file means losing access to the backup permanently — section 6
    of clawkeep-plan.md flags it as the single most important secret on the
    device. v1 prints it during `clawkeep pair`; v1.1 will mirror an encrypted
    copy to the portal.
    """
    p = Path(path if path is not None else default_repo_pass_path())
    if p.exists():
        pw = p.read_text(encoding="utf-8").strip()
        if pw:
            return pw
    # Generate 32 bytes of randomness, hex-encoded → 64 chars.
    pw = os.urandom(32).hex()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, pw.encode("utf-8"))
    finally:
        os.close(fd)
    os.chmod(p, 0o600)
    return pw


def assert_perms(path: Path | str) -> None:
    """Raise if a sensitive file is world- or group-readable."""
    p = Path(path)
    if not p.exists():
        return
    mode = stat.S_IMODE(p.stat().st_mode)
    if mode & 0o077:
        raise TokenError(
            f"{p} has insecure permissions {oct(mode)}; expected 0600"
        )
