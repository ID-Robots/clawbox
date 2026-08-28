#!/usr/bin/env python3

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parent.parent
DISPATCHER = ROOT / "scripts" / "nm-dispatcher-failover.sh"
GATEWAY_WRAPPER = ROOT / "scripts" / "run-openclaw-gateway.sh"
CHANNEL_RECOVERY = ROOT / "scripts" / "recover-openclaw-channels.sh"
NETWORK_READINESS = ROOT / "scripts" / "network-readiness.sh"


def write_executable(path: Path, body: str) -> None:
    path.write_text(textwrap.dedent(body).lstrip(), encoding="utf-8")
    path.chmod(0o755)


class NetworkResilienceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="clawbox-network-test-")
        self.root = Path(self.tempdir.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "calls.log"
        self.state = self.root / "state.json"
        self.dispatcher = self.root / "nm-dispatcher-failover.sh"
        self.dispatcher.write_text(
            DISPATCHER.read_text(encoding="utf-8").replace(
                "/usr/local/libexec/clawbox/network-readiness.sh",
                str(NETWORK_READINESS),
            ),
            encoding="utf-8",
        )
        self.dispatcher.chmod(0o755)
        self._install_mocks()

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def _install_mocks(self) -> None:
        write_executable(
            self.bin / "logger",
            r"""
            #!/usr/bin/env bash
            printf 'logger %s\n' "$*" >>"$MOCK_LOG"
            """,
        )
        write_executable(
            self.bin / "ip",
            r"""
            #!/usr/bin/env bash
            [ "${MOCK_ROUTE_READY:-0}" = "1" ]
            """,
        )
        write_executable(
            self.bin / "curl",
            r"""
            #!/usr/bin/env bash
            if [ "${MOCK_ROUTE_READY:-0}" = "1" ]; then
              printf '204'
              exit 0
            fi
            exit 7
            """,
        )
        write_executable(
            self.bin / "systemctl",
            r"""
            #!/usr/bin/env bash
            printf 'systemctl %s\n' "$*" >>"$MOCK_LOG"
            exit 0
            """,
        )
        write_executable(
            self.bin / "nmcli",
            r"""
            #!/usr/bin/env bash
            args="$*"
            case "$args" in
              '-t -f TYPE,STATE device status') printf 'ethernet:disconnected\nwifi:disconnected\n' ;;
              '-t -f NAME,DEVICE connection show --active') ;;
              '-t -f TYPE,STATE,DEVICE device status') printf 'wifi:disconnected:wlP1p1s0\n' ;;
              '-t -f NAME,TYPE,AUTOCONNECT-PRIORITY connection show')
                if [ "${MOCK_WIFI_PROFILE:-0}" = "1" ]; then
                  printf 'HomeWifi:802-11-wireless:10\n'
                fi
                ;;
              'connection up HomeWifi ifname wlP1p1s0')
                [ "${MOCK_WIFI_CONNECTS:-0}" = "1" ]
                ;;
              *) printf 'unexpected nmcli: %s\n' "$args" >&2; exit 2 ;;
            esac
            """,
        )
        write_executable(
            self.bin / "openclaw",
            r"""
            #!/usr/bin/env python3
            import json, os, pathlib, sys

            log = pathlib.Path(os.environ["MOCK_LOG"])
            state_path = pathlib.Path(os.environ["MOCK_STATE"])
            args = sys.argv[1:]
            with log.open("a", encoding="utf-8") as handle:
                handle.write(
                    "openclaw skip=%s %s\n"
                    % (os.environ.get("OPENCLAW_SKIP_CHANNELS", ""), " ".join(args))
                )
            if args and args[0] == "gateway" and len(args) > 1 and args[1] != "call":
                raise SystemExit(0)
            mode = os.environ.get("MOCK_CHANNEL_MODE", "suppressed")
            started = state_path.exists()
            if args[:2] == ["channels", "status"]:
                if mode == "auth-failure":
                    alfred = {
                        "accountId": "alfred", "enabled": True, "configured": True,
                        "running": False, "connected": False, "lastError": "unauthorized",
                        "probe": {"ok": True},
                    }
                else:
                    alfred = {
                        "accountId": "alfred", "enabled": True, "configured": True,
                        "running": started, "connected": started,
                        "lastError": None if started else
                            "gateway restart-loop breaker tripped; suppressing channel auto-start",
                        "probe": {"ok": True},
                    }
                payload = {"channelAccounts": {"telegram": [
                    alfred,
                    {"accountId": "default", "enabled": True, "configured": True,
                     "running": True, "connected": True, "lastError": None,
                     "probe": {"ok": True}},
                ]}}
                print(json.dumps(payload))
                raise SystemExit(0)
            if args[:3] == ["gateway", "call", "channels.start"]:
                state_path.write_text("started", encoding="utf-8")
                print(json.dumps({"started": True}))
                raise SystemExit(0)
            raise SystemExit(2)
            """,
        )

    def _env(self, **overrides: str) -> dict[str, str]:
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{self.bin}:{env.get('PATH', '')}",
                "MOCK_LOG": str(self.log),
                "MOCK_STATE": str(self.state),
                "CLAWBOX_NETWORK_READINESS_LIB": str(NETWORK_READINESS),
                "CLAWBOX_OPENCLAW_BIN": str(self.bin / "openclaw"),
                "CLAWBOX_CHANNEL_RECOVERY_VERIFY_ATTEMPTS": "1",
                "CLAWBOX_CHANNEL_RECOVERY_VERIFY_DELAY_SECONDS": "0",
            }
        )
        env.update(overrides)
        return env

    def _run(self, script: Path, *args: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(script), *args],
            env=env,
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )

    def _calls(self) -> str:
        return self.log.read_text(encoding="utf-8") if self.log.exists() else ""

    def test_link_down_without_replacement_route_does_not_restart_gateway(self) -> None:
        result = self._run(self.dispatcher, "enP8p1s0", "down", env=self._env(MOCK_ROUTE_READY="0"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("restart clawbox-gateway.service", self._calls())

    def test_wifi_failover_restarts_only_after_public_route_is_ready(self) -> None:
        result = self._run(
            self.dispatcher,
            "enP8p1s0",
            "down",
            env=self._env(MOCK_ROUTE_READY="1", MOCK_WIFI_PROFILE="1", MOCK_WIFI_CONNECTS="1"),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self._calls()
        self.assertIn("restart clawbox-gateway.service", calls)
        self.assertIn("restart clawbox-channel-recovery.timer", calls)

    def test_link_up_without_public_route_does_not_restart_gateway(self) -> None:
        result = self._run(self.dispatcher, "enP8p1s0", "up", env=self._env(MOCK_ROUTE_READY="0"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("restart clawbox-gateway.service", self._calls())

    def test_gateway_wrapper_defers_channels_when_network_is_unavailable(self) -> None:
        result = self._run(
            GATEWAY_WRAPPER,
            "--allow-unconfigured",
            env=self._env(MOCK_ROUTE_READY="0"),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("openclaw skip=1 gateway --allow-unconfigured", self._calls())

    def test_gateway_wrapper_starts_channels_normally_when_network_is_ready(self) -> None:
        result = self._run(
            GATEWAY_WRAPPER,
            "--allow-unconfigured",
            env=self._env(MOCK_ROUTE_READY="1"),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("openclaw skip= gateway --allow-unconfigured", self._calls())

    def test_recovery_starts_only_breaker_suppressed_account_and_verifies_connected(self) -> None:
        result = self._run(CHANNEL_RECOVERY, env=self._env(MOCK_ROUTE_READY="1"))
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self._calls()
        self.assertIn("gateway call channels.start", calls)
        self.assertIn('"accountId":"alfred"', calls)
        self.assertNotIn('"accountId":"default"', calls)

    def test_recovery_does_not_override_authentication_failure(self) -> None:
        result = self._run(
            CHANNEL_RECOVERY,
            env=self._env(MOCK_ROUTE_READY="1", MOCK_CHANNEL_MODE="auth-failure"),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("gateway call channels.start", self._calls())


if __name__ == "__main__":
    unittest.main(verbosity=2)
