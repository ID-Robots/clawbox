"""Tests for the S3 transport.

boto3 is a runtime dep but tests should be runnable on a host without it.
We therefore skip the whole module if boto3 isn't importable — the
runner-level integration is already covered by test_runner.py via mocks.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

pytest.importorskip("boto3")

from clawkeep import s3  # noqa: E402 — must follow the importorskip guard
from clawkeep.api import Credentials  # noqa: E402


CREDS = Credentials(
    accessKeyId="AKIA",
    secretAccessKey="secret",
    sessionToken="session",
    endpoint="https://acct.r2.cloudflarestorage.com",
    bucket="clawkeep",
    prefix="users/u_x/repo/",
    expiresAt=0,
    quotaBytes=5_368_709_120,
    cloudBytes=0,
)


def test_join_handles_trailing_slash() -> None:
    assert s3._join("users/u_x/repo/", "snap.tar.gz") == "users/u_x/repo/snap.tar.gz"
    assert s3._join("users/u_x/repo", "snap.tar.gz") == "users/u_x/repo/snap.tar.gz"
    assert s3._join("", "snap.tar.gz") == "snap.tar.gz"


def test_upload_calls_put_with_correct_key(tmp_path: Path) -> None:
    archive = tmp_path / "snap.tar.gz"
    archive.write_bytes(b"x")
    fake_client = MagicMock()
    with patch("clawkeep.s3._client", return_value=fake_client):
        key = s3.upload(CREDS, archive_path=archive, object_name="snap.tar.gz")
    assert key == "users/u_x/repo/snap.tar.gz"
    fake_client.upload_file.assert_called_once_with(
        str(archive), "clawkeep", "users/u_x/repo/snap.tar.gz",
    )


def test_upload_translates_botocore_error(tmp_path: Path) -> None:
    archive = tmp_path / "snap.tar.gz"
    archive.write_bytes(b"x")
    from botocore.exceptions import ClientError

    fake_client = MagicMock()
    fake_client.upload_file.side_effect = ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "boom"}}, "PutObject",
    )
    with patch("clawkeep.s3._client", return_value=fake_client):
        with pytest.raises(s3.S3Error, match="upload failed"):
            s3.upload(CREDS, archive_path=archive, object_name="snap.tar.gz")


def test_stats_sums_sizes_across_pages() -> None:
    fake_paginator = MagicMock()
    fake_paginator.paginate.return_value = iter(
        [
            {"Contents": [{"Size": 100}, {"Size": 200}]},
            {"Contents": [{"Size": 50}]},
            {},  # empty page (Cloudflare returns these between truncated batches)
        ]
    )
    fake_client = MagicMock()
    fake_client.get_paginator.return_value = fake_paginator
    with patch("clawkeep.s3._client", return_value=fake_client):
        result = s3.stats(CREDS)
    assert result.cloud_bytes == 350
    assert result.snapshot_count == 3
    fake_paginator.paginate.assert_called_once_with(
        Bucket="clawkeep", Prefix="users/u_x/repo/",
    )


def test_stats_translates_botocore_error() -> None:
    from botocore.exceptions import ClientError

    fake_client = MagicMock()
    fake_client.get_paginator.return_value.paginate.side_effect = ClientError(
        {"Error": {"Code": "Forbidden", "Message": "no list"}}, "ListObjectsV2",
    )
    with patch("clawkeep.s3._client", return_value=fake_client):
        with pytest.raises(s3.S3Error, match="list_objects_v2 failed"):
            s3.stats(CREDS)


def test_list_snapshots_strips_prefix_and_sorts_newest_first() -> None:
    from datetime import datetime, timezone

    older = datetime(2026, 4, 28, 10, 0, 0, tzinfo=timezone.utc)
    newer = datetime(2026, 4, 29, 10, 0, 0, tzinfo=timezone.utc)
    fake_paginator = MagicMock()
    fake_paginator.paginate.return_value = iter(
        [
            {"Contents": [
                {"Key": "users/u_x/repo/older.tar.gz", "Size": 100, "LastModified": older},
                {"Key": "users/u_x/repo/newer.tar.gz", "Size": 200, "LastModified": newer},
                # MinIO-style directory marker — must be skipped, not listed as a snapshot.
                {"Key": "users/u_x/repo/", "Size": 0, "LastModified": newer},
            ]},
        ]
    )
    fake_client = MagicMock()
    fake_client.get_paginator.return_value = fake_paginator
    with patch("clawkeep.s3._client", return_value=fake_client):
        snaps = s3.list_snapshots(CREDS)
    assert [s.name for s in snaps] == ["newer.tar.gz", "older.tar.gz"]
    assert snaps[0].size_bytes == 200
    # Unix-ms conversion of a tz-aware UTC datetime.
    assert snaps[0].last_modified_ms == int(newer.timestamp() * 1000)


def test_download_calls_get_with_correct_key(tmp_path: Path) -> None:
    fake_client = MagicMock()
    dest = tmp_path / "snap.tar.gz"
    with patch("clawkeep.s3._client", return_value=fake_client):
        s3.download(CREDS, object_name="snap.tar.gz", dest_path=dest)
    fake_client.download_file.assert_called_once_with(
        "clawkeep", "users/u_x/repo/snap.tar.gz", str(dest),
    )


def test_download_translates_botocore_error(tmp_path: Path) -> None:
    from botocore.exceptions import ClientError

    fake_client = MagicMock()
    fake_client.download_file.side_effect = ClientError(
        {"Error": {"Code": "NoSuchKey", "Message": "gone"}}, "GetObject",
    )
    with patch("clawkeep.s3._client", return_value=fake_client):
        with pytest.raises(s3.S3Error, match="download failed"):
            s3.download(CREDS, object_name="snap.tar.gz", dest_path=tmp_path / "x.tar.gz")
