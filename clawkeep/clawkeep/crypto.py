"""End-to-end encryption for ClawKeep tarballs.

The threat model: the portal operator (the people who run the cloud bucket)
must NOT be able to read user backups. Encryption happens device-side
*before* the S3 upload, with a password that lives only on the device
(plus, hopefully, in the user's head). Lose the password → lose the data.

Implementation: shell out to `openssl enc -aes-256-cbc -pbkdf2 -iter 600000`.

Why subprocess instead of the Python `cryptography` library:
* `openssl enc` streams natively. We routinely produce 100MB+ archives;
  loading them into memory to feed `cryptography.hazmat` is wasteful.
* Output format is openssl's own (`Salted__<8-byte salt><ciphertext>`),
  which means a user who keeps a copy of the file outside ClawKeep can
  still decrypt it on any Linux box with the same one-liner.
* `openssl` is preinstalled on every Jetson image; the `cryptography`
  Python package version that ships with L4T (3.4.8) is too old for some
  of the AEAD primitives we'd otherwise want.

Password handling: callers pass the *path* to a 0600 file containing the
password (typically ~/.clawkeep/passphrase, sometimes a tmpfile written
by the restore route from a one-shot UI prompt). We feed openssl
`-pass file:<path>` so the password never enters argv (which would expose
it via `/proc/<pid>/cmdline`).
"""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)

ENCRYPTED_SUFFIX = ".enc"

# PBKDF2 iteration count. Picked to take ~1s on a Jetson Orin Nano so a
# brute-forcer paying for cloud GPUs still has to throw real money at every
# guess. Raise alongside hardware speed; never lower without a major-version
# bump on the file format.
PBKDF2_ITER = 600_000


class CryptoError(Exception):
    """Raised for any encryption / decryption failure.

    Surfaces an actionable message to the runner; the daemon translates
    "bad password" specifically into a distinct exit code so the UI can
    prompt for a re-entry instead of just showing "restore failed".
    """


def _run_openssl(args: list[str], *, timeout: float) -> subprocess.CompletedProcess[bytes]:
    """Invoke openssl with stdout/stderr captured. Translates ENOENT and
    timeouts into CryptoError so callers don't have to import subprocess
    just to handle plumbing failures."""
    try:
        return subprocess.run(
            ["openssl", *args],
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as e:  # pragma: no cover — Jetson images ship openssl
        raise CryptoError(f"openssl not found on PATH: {e}") from e
    except subprocess.TimeoutExpired as e:
        raise CryptoError(f"openssl timed out after {timeout}s") from e


def encrypt_file(
    *,
    plaintext_path: Path,
    ciphertext_path: Path,
    password_file: Path,
    timeout: float = 30 * 60,
) -> None:
    """Encrypt `plaintext_path` to `ciphertext_path` using the password in
    `password_file`. The plaintext is *not* deleted — the caller decides.

    The output file is openssl's standard `Salted__` format with a fresh
    random 8-byte salt per call (PBKDF2 stretches it to a key + IV).
    """
    if not plaintext_path.is_file():
        raise CryptoError(f"plaintext does not exist: {plaintext_path}")
    if not password_file.is_file():
        raise CryptoError(f"password file does not exist: {password_file}")
    # The password file must be at least one non-empty line. An empty
    # passphrase is technically allowed by openssl but defeats the entire
    # feature; refuse it loudly so we can't ship "encrypted" backups that
    # anyone can read by hitting Enter.
    try:
        size = password_file.stat().st_size
    except OSError as e:
        raise CryptoError(f"could not stat password file: {e}") from e
    if size == 0:
        raise CryptoError("password file is empty — set a passphrase before backing up")

    ciphertext_path.parent.mkdir(parents=True, exist_ok=True)
    cp = _run_openssl(
        [
            "enc", "-aes-256-cbc", "-pbkdf2",
            "-iter", str(PBKDF2_ITER),
            "-salt",
            "-in", str(plaintext_path),
            "-out", str(ciphertext_path),
            "-pass", f"file:{password_file}",
        ],
        timeout=timeout,
    )
    if cp.returncode != 0:
        # Best-effort cleanup so a failed run doesn't leave a half-written
        # ciphertext file masquerading as a successful encryption.
        try:
            ciphertext_path.unlink(missing_ok=True)
        except OSError:
            pass
        tail = (cp.stderr or b"").decode("utf-8", errors="replace").strip()[-300:]
        raise CryptoError(f"openssl enc failed (rc={cp.returncode}): {tail}")


def decrypt_file(
    *,
    ciphertext_path: Path,
    plaintext_path: Path,
    password_file: Path,
    timeout: float = 30 * 60,
) -> None:
    """Inverse of :func:`encrypt_file`. Raises CryptoError on any failure;
    callers should treat a stderr containing "bad decrypt" / "wrong password"
    as a wrong-password signal (see :func:`is_bad_password_error`).
    """
    if not ciphertext_path.is_file():
        raise CryptoError(f"ciphertext does not exist: {ciphertext_path}")
    if not password_file.is_file():
        raise CryptoError(f"password file does not exist: {password_file}")

    plaintext_path.parent.mkdir(parents=True, exist_ok=True)
    cp = _run_openssl(
        [
            "enc", "-d", "-aes-256-cbc", "-pbkdf2",
            "-iter", str(PBKDF2_ITER),
            "-in", str(ciphertext_path),
            "-out", str(plaintext_path),
            "-pass", f"file:{password_file}",
        ],
        timeout=timeout,
    )
    if cp.returncode != 0:
        try:
            plaintext_path.unlink(missing_ok=True)
        except OSError:
            pass
        stderr_text = (cp.stderr or b"").decode("utf-8", errors="replace").strip()
        tail = stderr_text[-300:]
        # Surface the raw stderr so the runner can pattern-match for
        # bad-password errors and prompt the user appropriately.
        raise CryptoError(f"openssl dec failed (rc={cp.returncode}): {tail}")


def is_bad_password_error(err: CryptoError) -> bool:
    """True if a CryptoError from :func:`decrypt_file` looks like a wrong
    password / wrong key derivation, as opposed to a corrupt file or a
    plumbing problem.

    openssl's exact wording varies between releases ("bad decrypt",
    "bad magic number", "Wrong passwd"); we match conservatively so that
    a real wrong-password is reliably classified, and other failures
    fall through as generic CryptoErrors.
    """
    msg = str(err).lower()
    return any(token in msg for token in (
        "bad decrypt",
        "bad magic number",
        "wrong password",
        "wrong passwd",
        # OpenSSL 3.x emits this when the AES block decode produces a
        # truncated final block — i.e. the key derivation diverged from
        # what encrypted the file. Earlier OpenSSL versions phrased the
        # same condition as "bad decrypt", which the entry above already
        # covers.
        "wrong final block length",
        "digital envelope routines",
    ))


def is_likely_encrypted(path: Path) -> bool:
    """Cheap header sniff. openssl's PBKDF2 mode prefixes ciphertext with
    the literal bytes ``Salted__`` before the 8-byte salt. Used by restore
    to decide whether a downloaded `.tar.gz` (no .enc suffix) is actually
    a legacy unencrypted archive or a misnamed encrypted one.
    """
    try:
        with path.open("rb") as f:
            return f.read(8) == b"Salted__"
    except OSError:
        return False


def secure_unlink(path: Path) -> None:
    """Best-effort delete with a single overwrite pass on tiny files.

    Encryption is the real secrecy boundary — this is just a courtesy on
    the on-disk slack between archive build and unlink. We only overwrite
    files under a small threshold (256 KiB), which covers manifests and
    pre-encryption tmp artefacts; full openclaw tarballs are 100MB+ and
    overwriting them would add ~hundreds of ms of urandom + fsync cost
    to every backup run on a Jetson, for marginal extra protection over
    the immediate unlink that follows.
    """
    OVERWRITE_THRESHOLD = 256 * 1024
    try:
        size = path.stat().st_size
    except OSError:
        return
    if size and size <= OVERWRITE_THRESHOLD:
        try:
            with path.open("r+b") as f:
                f.write(os.urandom(size))
                f.flush()
                os.fsync(f.fileno())
        except OSError as e:  # pragma: no cover — best effort
            log.debug("overwrite failed for %s: %s", path, e)
    try:
        path.unlink(missing_ok=True)
    except OSError as e:  # pragma: no cover — best effort
        log.debug("unlink failed for %s: %s", path, e)
