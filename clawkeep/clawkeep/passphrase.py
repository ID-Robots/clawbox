"""Local passphrase storage for ClawKeep encryption.

The user picks a passphrase once during the first backup. We persist it on
the device under `$CLAWKEEP_DATA_DIR/passphrase` (mode 0600) so subsequent
unattended runs (systemd timer, scheduled backups) can encrypt without
prompting. The passphrase never leaves the device — it's only used as the
input to PBKDF2 inside :mod:`clawkeep.crypto`.

Failure mode by design: if the user wipes the device they lose the
passphrase, and prior backups become unrecoverable unless they wrote it
down. That's the entire point of end-to-end encryption.
"""

from __future__ import annotations

import os
from pathlib import Path

from .token import data_dir


PASSPHRASE_FILENAME = "passphrase"


class PassphraseError(Exception):
    pass


def default_passphrase_path() -> Path:
    """Path resolution mirrors :func:`clawkeep.token.default_token_path`:
    the data dir is `$CLAWKEEP_DATA_DIR` if set, else `~/.clawkeep`. We
    intentionally store the passphrase next to the bearer token — both
    have the same trust boundary (device-local 0600), and a single chmod
    on the parent dir covers them.
    """
    return data_dir() / PASSPHRASE_FILENAME


def is_set(path: Path | None = None) -> bool:
    """True if the passphrase file exists and is non-empty.

    A zero-byte file is treated as "not set" so a botched first-write
    doesn't get interpreted as an empty passphrase (which openssl would
    accept and produce trivially-decryptable output).
    """
    p = path or default_passphrase_path()
    try:
        return p.is_file() and p.stat().st_size > 0
    except OSError:
        return False


def read(path: Path | None = None) -> str:
    """Return the stored passphrase. Raises PassphraseError when unset.

    The returned string has no trailing newline (we strip on write so the
    file matches what the user typed; we strip again on read defensively
    in case the file was edited by hand).
    """
    p = path or default_passphrase_path()
    if not p.exists():
        raise PassphraseError(f"passphrase not set: {p}")
    try:
        raw = p.read_text(encoding="utf-8")
    except OSError as e:
        raise PassphraseError(f"could not read passphrase file {p}: {e}") from e
    pw = raw.rstrip("\r\n")
    if not pw:
        raise PassphraseError(f"passphrase file is empty: {p}")
    return pw


def write(passphrase: str, *, path: Path | None = None) -> Path:
    """Atomically write the passphrase to disk, mode 0600.

    Empty / whitespace-only passphrases are rejected — encryption with an
    empty key offers no protection and would silently break the
    "operator can't read backups" guarantee.
    """
    if not passphrase or not passphrase.strip():
        raise PassphraseError("passphrase must be non-empty")

    p = path or default_passphrase_path()
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = p.with_suffix(p.suffix + ".tmp")
    # Open with O_CREAT|O_WRONLY|O_TRUNC and explicit 0600 so even a brief
    # window between create and chmod doesn't leak the secret.
    fd = os.open(str(tmp), os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            # Strip a single trailing newline so re-reads don't accumulate
            # blank lines if the user ever edits the file in $EDITOR.
            f.write(passphrase.rstrip("\r\n"))
    except OSError as e:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise PassphraseError(f"could not write passphrase: {e}") from e
    try:
        os.chmod(tmp, 0o600)
        os.replace(tmp, p)
    except OSError as e:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise PassphraseError(f"could not finalise passphrase: {e}") from e
    return p


def clear(path: Path | None = None) -> bool:
    """Delete the passphrase file. Returns True if a file was removed,
    False if there was nothing to remove. Best-effort overwrite first
    so the on-disk slack is less likely to retain plaintext."""
    p = path or default_passphrase_path()
    if not p.exists():
        return False
    try:
        size = p.stat().st_size
        if size:
            with p.open("r+b") as f:
                f.write(os.urandom(size))
                f.flush()
                os.fsync(f.fileno())
    except OSError:
        # Overwrite is courtesy, not contract — fall through to unlink.
        pass
    try:
        p.unlink()
        return True
    except OSError as e:
        raise PassphraseError(f"could not delete passphrase: {e}") from e
