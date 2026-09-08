"""The browser sees a challenge; only the token exchange receives its verifier."""
import base64
import hashlib
import urllib.parse
import pytest
from unittest.mock import Mock

from clawkeep import pair


class CallbackServer:
    def __init__(self, address, handler):
        self.handler = handler

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def handle_request(self):
        self.handler.received = {"code": "test-code", "state": self.handler.expected_state}


def test_pair_s256_proof_matches_exchange_and_is_never_printed(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(pair, "_OneShotServer", CallbackServer)
    response = Mock(ok=True, status_code=200)
    response.json.return_value = {"access_token": "claw_test_private_token", "pkce_verified": True}
    post = Mock(return_value=response)
    monkeypatch.setattr(pair.requests, "post", post)
    verifiers = []
    for index in range(2):
        token_path = tmp_path / f"token-{index}"
        assert pair.run_pair("https://portal.test", token_path=token_path) == "claw_test_private_token"
        output = capsys.readouterr().out
        url = next(line.strip() for line in output.splitlines() if line.strip().startswith("https://portal.test/portal/connect?"))
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        body = post.call_args.kwargs["json"]
        verifier = body["code_verifier"]
        assert 43 <= len(verifier) <= 128
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
        assert query["code_challenge"] == [challenge]
        assert query["code_challenge_method"] == ["S256"]
        assert body["state"] == query["state"][0]
        assert body["code"] == "test-code"
        assert post.call_args.args[0] == "https://portal.test/api/portal/connect/exchange"
        assert post.call_args.kwargs["allow_redirects"] is False
        assert verifier not in output
        assert "claw_test_private_token" not in output
        assert token_path.stat().st_mode & 0o777 == 0o600
        verifiers.append(verifier)
    assert verifiers[0] != verifiers[1]


@pytest.mark.parametrize("server", ["http://portal.test", "https://user:pass@portal.test", "https://portal.test?token=x", "https://portal.test#anchor"])
def test_pair_refuses_unsafe_portal_before_starting(monkeypatch, server):
    listener = Mock()
    post = Mock()
    monkeypatch.setattr(pair, "_OneShotServer", listener)
    monkeypatch.setattr(pair.requests, "post", post)
    with pytest.raises(SystemExit, match="HTTPS portal URL"):
        pair.run_pair(server)
    listener.assert_not_called()
    post.assert_not_called()


@pytest.mark.parametrize("status", [301, 302, 307, 308])
def test_exchange_never_follows_redirects(monkeypatch, status):
    post = Mock(return_value=Mock(status_code=status))
    monkeypatch.setattr(pair.requests, "post", post)
    with pytest.raises(SystemExit, match="refused a redirect"):
        pair._exchange("https://portal.test", "code", "state", "device", "verifier")
    assert post.call_args.kwargs["allow_redirects"] is False


def test_old_portal_cannot_silently_downgrade_pkce(monkeypatch, tmp_path):
    monkeypatch.setattr(pair, "_OneShotServer", CallbackServer)
    response = Mock(ok=True, status_code=200)
    response.json.return_value = {"access_token": "claw_legacy_token"}
    monkeypatch.setattr(pair.requests, "post", Mock(return_value=response))
    token_path = tmp_path / "token"
    with pytest.raises(SystemExit, match="did not confirm S256 PKCE"):
        pair.run_pair("https://portal.test", token_path=token_path)
    assert not token_path.exists()
