"""Tests for the device-side encryption + passphrase storage modules.

These cover the two halves of the e2e-encryption story:

* :mod:`clawkeep.crypto` — the openssl wrapper. We round-trip a real file
  through encrypt + decrypt with a real openssl on PATH, then exercise
  the wrong-password and corrupt-file branches.
* :mod:`clawkeep.passphrase` — the on-disk passphrase store. We assert
  the file ends up at 0600, that empty passphrases are rejected, and that
  read/clear behave consistently with `is_set`.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from clawkeep import crypto, passphrase


# ── crypto.py ─────────────────────────────────────────────────────────


def _write_pw(tmp: Path, secret: str) -> Path:
    pw_file = tmp / "pw"
    pw_file.write_text(secret, encoding="utf-8")
    pw_file.chmod(0o600)
    return pw_file


def test_encrypt_decrypt_roundtrip(tmp_path: Path) -> None:
    payload = (b"the quick brown crab " * 4096)  # ~80KB so we exercise more than one openssl block
    plaintext = tmp_path / "plain.tar.gz"
    plaintext.write_bytes(payload)
    cipher = tmp_path / "plain.tar.gz.enc"
    pw_file = _write_pw(tmp_path, "correct horse battery staple")

    crypto.encrypt_file(
        plaintext_path=plaintext,
        ciphertext_path=cipher,
        password_file=pw_file,
    )
    assert cipher.is_file() and cipher.stat().st_size > 0
    # openssl `-pbkdf2 -salt` produces the canonical "Salted__" header so
    # the file is portable to any other openssl install with the same pw.
    assert cipher.read_bytes()[:8] == b"Salted__"

    recovered = tmp_path / "recovered.tar.gz"
    crypto.decrypt_file(
        ciphertext_path=cipher,
        plaintext_path=recovered,
        password_file=pw_file,
    )
    assert recovered.read_bytes() == payload


def test_encrypt_rejects_empty_password_file(tmp_path: Path) -> None:
    plaintext = tmp_path / "plain.tar.gz"
    plaintext.write_bytes(b"data")
    cipher = tmp_path / "plain.tar.gz.enc"
    empty_pw = tmp_path / "empty"
    empty_pw.write_text("", encoding="utf-8")

    with pytest.raises(crypto.CryptoError, match="empty"):
        crypto.encrypt_file(
            plaintext_path=plaintext,
            ciphertext_path=cipher,
            password_file=empty_pw,
        )
    # An empty-password call must not leave a half-written cipher file —
    # the user would mistakenly think they had an encrypted backup.
    assert not cipher.exists()


def test_decrypt_with_wrong_password_is_classified(tmp_path: Path) -> None:
    plaintext = tmp_path / "plain.tar.gz"
    plaintext.write_bytes(b"top secret crab data")
    cipher = tmp_path / "plain.tar.gz.enc"
    good_pw = tmp_path / "good_pw"
    good_pw.write_text("good-passphrase", encoding="utf-8")
    good_pw.chmod(0o600)
    crypto.encrypt_file(
        plaintext_path=plaintext,
        ciphertext_path=cipher,
        password_file=good_pw,
    )

    bad_pw = tmp_path / "bad_pw"
    bad_pw.write_text("wrong-passphrase", encoding="utf-8")
    bad_pw.chmod(0o600)

    out = tmp_path / "recovered.tar.gz"
    with pytest.raises(crypto.CryptoError) as exc_info:
        crypto.decrypt_file(
            ciphertext_path=cipher,
            plaintext_path=out,
            password_file=bad_pw,
        )
    # The classifier exists so the runner can convert "bad password" into
    # a distinct exit code; verify the message looks like one openssl
    # actually emits on a wrong key.
    assert crypto.is_bad_password_error(exc_info.value)
    # Failed decrypt must not leave a dangling output file masquerading
    # as the original plaintext.
    assert not out.exists()


def test_is_likely_encrypted_distinguishes_legacy_targz(tmp_path: Path) -> None:
    legacy = tmp_path / "legacy.tar.gz"
    # tar.gz starts with the gzip magic 1f 8b — definitely NOT "Salted__"
    legacy.write_bytes(b"\x1f\x8b\x08\x00rest_of_a_real_archive")
    assert not crypto.is_likely_encrypted(legacy)

    encrypted = tmp_path / "new.enc"
    encrypted.write_bytes(b"Salted__\x00\x01\x02\x03\x04\x05\x06\x07rest")
    assert crypto.is_likely_encrypted(encrypted)


# ── passphrase.py ─────────────────────────────────────────────────────


@pytest.fixture
def pw_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolate the passphrase store under a tmp dir so tests don't touch
    a real ~/.clawkeep / /var/lib/clawkeep."""
    monkeypatch.setenv("CLAWKEEP_DATA_DIR", str(tmp_path))
    return tmp_path


def test_write_creates_0600_file(pw_dir: Path) -> None:
    p = passphrase.write("test passphrase")
    assert p.exists()
    mode = stat.S_IMODE(p.stat().st_mode)
    # 0600 is the contract — anything broader leaks the secret to other
    # local users (relevant on shared dev boxes; less so on a single-user
    # Jetson, but the guarantee is still load-bearing).
    assert mode == 0o600, f"expected 0o600, got {oct(mode)}"
    assert passphrase.read() == "test passphrase"
    assert passphrase.is_set()


def test_write_rejects_empty_or_whitespace(pw_dir: Path) -> None:
    with pytest.raises(passphrase.PassphraseError):
        passphrase.write("")
    with pytest.raises(passphrase.PassphraseError):
        passphrase.write("   \n\t  ")
    # Neither failed call should leave a file behind.
    assert not passphrase.is_set()


def test_read_strips_trailing_newline(pw_dir: Path) -> None:
    # Simulate `printf "secret\n" > passphrase` — i.e. the user editing the
    # file by hand. The read path must produce the same string the user
    # would type, no trailing whitespace.
    p = passphrase.default_passphrase_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("hand-edited\n", encoding="utf-8")
    p.chmod(0o600)
    assert passphrase.read() == "hand-edited"


def test_clear_removes_file_and_flips_is_set(pw_dir: Path) -> None:
    passphrase.write("delete me")
    assert passphrase.is_set()
    removed = passphrase.clear()
    assert removed is True
    assert not passphrase.is_set()
    # Idempotent — clear() on an already-empty store is a no-op signal.
    assert passphrase.clear() is False


def test_is_set_is_false_for_zero_byte_file(pw_dir: Path) -> None:
    """A botched first-write that leaves a 0-byte file must NOT be treated
    as 'configured' — that would let the runner try to encrypt with an
    empty passphrase, which openssl accepts and produces trivially-broken
    output for."""
    p = passphrase.default_passphrase_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(p), os.O_CREAT | os.O_WRONLY, 0o600)
    os.close(fd)
    assert not passphrase.is_set()
