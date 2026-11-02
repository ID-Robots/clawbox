"""A transfer the cloud refuses is an `S3Error`, like every other S3 failure.

boto3's transfer manager does not let a `ClientError` out of `upload_file`:
it re-raises it as `boto3.exceptions.S3UploadFailedError`, and
`download_file` turns exhausted retries into `RetriesExceededError`. Neither
is a botocore error, so both escaped `s3.upload`/`s3.download`, and the
runner, which catches only `s3.S3Error`, crashed with the dashboard still on
"Uploading" and no error reported.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

boto3 = pytest.importorskip("boto3")

from botocore.stub import Stubber  # noqa: E402 — must follow the importorskip guard

from clawkeep import s3  # noqa: E402
from clawkeep.api import Credentials  # noqa: E402

CREDS = Credentials(
    accessKeyId="AK", secretAccessKey="SK", sessionToken="ST",
    endpoint="https://acct.r2.cloudflarestorage.com", bucket="clawkeep",
    prefix="users/u_x/repo/", expiresAt=9_999_999_999_999,
    quotaBytes=5_368_709_120, cloudBytes=0,
)


def test_rejected_upload_is_an_s3_error(tmp_path: Path) -> None:
    archive = tmp_path / "a.tar.zst"
    archive.write_bytes(b"x" * 1024)
    client = boto3.client("s3", region_name="auto", endpoint_url=CREDS.endpoint,
                          aws_access_key_id="AK", aws_secret_access_key="SK")
    stub = Stubber(client)
    stub.add_client_error("put_object", service_error_code="AccessDenied", http_status_code=403)
    stub.activate()
    with patch.object(s3, "_client", lambda *_a, **_k: client):
        with pytest.raises(s3.S3Error, match="upload failed"):
            s3.upload(CREDS, archive_path=archive, object_name="snapshots/a.tar.zst")


def test_a_download_out_of_retries_is_an_s3_error(tmp_path: Path) -> None:
    from boto3.exceptions import RetriesExceededError

    client = MagicMock()
    client.download_file.side_effect = RetriesExceededError(ConnectionResetError("reset by peer"))
    with patch.object(s3, "_client", lambda *_a, **_k: client):
        with pytest.raises(s3.S3Error, match="download failed"):
            s3.download(CREDS, object_name="snapshots/a.tar.zst", dest_path=tmp_path / "a.tar.zst")
