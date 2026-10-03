"""Process-level radio transaction tests. Only file-backed fake nmcli, no services."""
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest
from typing import Literal, overload

HELPER = Path(__file__).resolve().parents[1] / 'wifi-radio.sh'

class RadioTransaction(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'bin').mkdir()
        self.policy = self.root / 'policy'
        self.policy.write_text('yes\n')
        nm = self.root / 'bin/nmcli'
        nm.write_text('''#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_ROOT/calls"
if [[ "$*" == *GENERAL.AUTOCONNECT* ]]; then cat "$TEST_ROOT/policy"; exit; fi
if [[ "$*" == *'autoconnect yes' ]] && [ -e "$TEST_ROOT/fail-restore" ]; then exit 1; fi
if [[ "$*" == *'autoconnect no' ]]; then echo no > "$TEST_ROOT/policy"; exit; fi
if [[ "$*" == *'autoconnect yes' ]]; then echo yes > "$TEST_ROOT/policy"; exit; fi
exit 0
''')
        nm.chmod(0o755)
        self.env = {**os.environ, 'PATH': str(nm.parent) + ':' + os.environ['PATH'],
                    'TEST_ROOT': str(self.root), 'CLAWBOX_RADIO_RUN_DIR': str(self.root / 'run'),
                    'NETWORK_INTERFACE': 'wlan-test', 'CLAWBOX_AP_SUPERVISED': '1'}
        self.children = []

    def tearDown(self):
        for p in self.children:
            if p.poll() is None:
                os.killpg(p.pid, signal.SIGKILL)
            p.wait()
        self.tmp.cleanup()

    @overload
    def shell(self, body: str, background: Literal[False] = False) -> subprocess.CompletedProcess[str]: ...
    @overload
    def shell(self, body: str, background: Literal[True]) -> subprocess.Popen: ...
    def shell(self, body, background=False):
        command = 'set -euo pipefail; source "$1"; wifi_lock; ' + body
        args = ['bash', '-c', command, 'test', str(HELPER)]
        if background:
            p = subprocess.Popen(args, env=self.env, start_new_session=True,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.children.append(p)
            return p
        return subprocess.run(args, env=self.env, capture_output=True, text=True, timeout=5)

    def await_file(self, name):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if (self.root / name).exists():
                return
            time.sleep(.01)
        self.fail('worker did not reach ' + name)

    def test_killed_owner_recovers_before_replacement_snapshot(self):
        self.assertTrue(HELPER.exists(), 'missing shared recovery transaction')
        p = self.shell('wifi_recover; wifi_inhibit; touch "$TEST_ROOT/ready"; sleep 30', True)
        self.await_file('ready')
        self.assertEqual(self.policy.read_text().strip(), 'no')
        os.killpg(p.pid, signal.SIGKILL)
        p.wait()
        result = self.shell('wifi_recover; wifi_inhibit; wifi_recover')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.policy.read_text().strip(), 'yes')

    def test_failed_restore_retains_snapshot_and_blocks_new_owner(self):
        (self.root / 'fail-restore').touch()
        result = self.shell('wifi_recover; wifi_inhibit; wifi_recover')
        self.assertNotEqual(result.returncode, 0)
        calls = (self.root / 'calls').read_text()
        self.assertIn('autoconnect no', calls)
        result = self.shell('wifi_recover; wifi_inhibit')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / 'calls').read_text().count('autoconnect no'), 1)
        (self.root / 'fail-restore').unlink()
        self.assertEqual(self.shell('wifi_recover').returncode, 0)
        self.assertEqual(self.policy.read_text().strip(), 'yes')

    def test_owned_ap_lookup_ignores_client_name_collision_and_refuses_duplicates(self):
        a = '11111111-1111-4111-8111-111111111111'
        b = '22222222-2222-4222-8222-222222222222'
        nm = self.root / 'bin/nmcli'
        nm.write_text(f'''#!/bin/bash
case "$*" in
 '-g UUID connection show') printf '%s\\n' {a} {b} ;;
 *'connection.id'*) echo ClawBox-Setup ;;
 *'802-11-wireless.mode'*{a}) cat "$TEST_ROOT/mode" ;;
 *'802-11-wireless.mode'*{b}) echo ap ;;
 *'connection.interface-name'*) echo wlan-test ;;
 *) exit 2 ;;
esac
''')
        (self.root / 'mode').write_text('infrastructure')
        result = self.shell('wifi_ap_uuid')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), b)
        (self.root / 'mode').write_text('ap')
        result = self.shell('wifi_ap_uuid')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')

    def test_web_name_selector_resolves_only_unambiguous_clients(self):
        a = '11111111-1111-4111-8111-111111111111'
        b = '22222222-2222-4222-8222-222222222222'
        nm = self.root / 'bin/nmcli'
        nm.write_text(f'''#!/bin/bash
case "$*" in
 '-g UUID connection show') printf '%s\\n' {a} {b} ;;
 *'connection.id'*) echo Example ;;
 *'802-11-wireless.mode'*{a}) cat "$TEST_ROOT/mode" ;;
 *'802-11-wireless.mode'*{b}) echo infrastructure ;;
 'connection delete uuid {b}'|'connection up uuid {b} ifname wlan-test') touch "$TEST_ROOT/deleted-client" ;;
 *) echo "$*" >> "$TEST_ROOT/unsafe"; exit 2 ;;
esac
''')
        (self.root / 'mode').write_text('ap')
        command = ['bash', str(HELPER), '--nmcli', 'connection', 'delete', 'Example']
        result = subprocess.run(command, env=self.env, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / 'deleted-client').exists())
        (self.root / 'deleted-client').unlink()
        result = subprocess.run(['bash', str(HELPER), '--nmcli', 'connection', 'up', 'Example'],
                                env=self.env, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / 'deleted-client').exists())
        (self.root / 'deleted-client').unlink()
        (self.root / 'mode').write_text('infrastructure')
        result = subprocess.run(command, env=self.env, capture_output=True, timeout=3)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'deleted-client').exists())
        self.assertFalse((self.root / 'unsafe').exists())

    def test_web_writer_waits_then_refuses_unrecovered_snapshot(self):
        p = self.shell('wifi_recover; wifi_inhibit; touch "$TEST_ROOT/ready"; sleep 30', True)
        self.await_file('ready')
        writer = subprocess.Popen(['bash', str(HELPER), '--nmcli', 'device', 'wifi', 'rescan'],
                                  env=self.env, start_new_session=True,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.children.append(writer)
        time.sleep(.15)
        self.assertIsNone(writer.poll())
        os.killpg(p.pid, signal.SIGKILL)
        p.wait()
        self.assertEqual(writer.wait(timeout=3), 1)
        self.assertNotIn('rescan', (self.root / 'calls').read_text())
        self.assertEqual(self.shell('wifi_recover').returncode, 0)
        result = subprocess.run(['bash', str(HELPER), '--nmcli', 'device', 'wifi', 'rescan'],
                                env=self.env, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('rescan', (self.root / 'calls').read_text())

    def test_down_up_down_hook_does_not_wait_for_blocked_worker(self):
        uuid = '11111111-1111-4111-8111-111111111111'
        nm = self.root / 'bin/nmcli'
        nm.write_text(f'''#!/bin/bash
case "$*" in
 *'GENERAL.STATE'*) echo '30 (disconnected)' ;;
 *'UUID,TYPE,AUTOCONNECT-PRIORITY,TIMESTAMP'*) echo '{uuid}:802-11-wireless:0:0' ;;
 *'802-11-wireless.mode'*) echo infrastructure ;;
 *'connection up'*) touch "$TEST_ROOT/blocked"; sleep 30 ;;
 *) exit 0 ;;
esac
''')
        for name in ['systemctl', 'logger']:
            p = self.root / 'bin' / name
            p.write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> "$TEST_ROOT/requests"\n')
            p.chmod(0o755)
        self.env['CLAWBOX_RUN_DIR'] = str(self.root)
        self.env['CLAWBOX_ONLINE_WAITER'] = '/missing'
        worker = subprocess.Popen(['bash', str(HELPER.parent / 'wifi-failover.sh')],
                                  env=self.env, start_new_session=True,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.children.append(worker)
        self.await_file('blocked')
        stamp = self.root / 'gateway-online-restart.stamp'
        for action in ['down', 'up', 'down']:
            stamp.touch()
            started = time.monotonic()
            result = subprocess.run(['bash', str(HELPER.parent / 'nm-dispatcher-failover.sh'),
                                     'eth-test', action], env=self.env, capture_output=True, timeout=2)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertLess(time.monotonic() - started, 2)
            if action == 'down':
                self.assertFalse(stamp.exists())
        self.assertIsNone(worker.poll(), 'activation must still be blocked throughout event delivery')
        os.killpg(worker.pid, signal.SIGKILL)
        worker.wait()
        self.assertEqual(self.shell('wifi_recover').returncode, 0)

    def test_killing_live_scan_releases_the_same_radio_lock(self):
        # Substitute only the executable path: never invoke this VM's iw.
        iw = self.root / 'fake-iw'
        iw.write_text('#!/usr/bin/python3\nimport os,time\n'
                      'open(os.environ["TEST_ROOT"] + "/scanning", "w").close()\n'
                      'time.sleep(30)\n')
        iw.chmod(0o755)
        helper = self.root / 'scan-helper.sh'
        helper.write_text(HELPER.read_text().replace('/usr/sbin/iw', str(iw)))
        scanner = subprocess.Popen(['bash', str(helper), '--iw-scan'], env=self.env,
                                   start_new_session=True, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL)
        self.children.append(scanner)
        self.await_file('scanning')
        waiting = self.shell('touch "$TEST_ROOT/after-scan"', True)
        time.sleep(.1)
        self.assertFalse((self.root / 'after-scan').exists())
        # Exactly what network.ts does: signal the returned child, not a group.
        scanner.terminate()
        scanner.wait(timeout=3)
        self.await_file('after-scan')
        self.assertEqual(waiting.wait(timeout=3), 0)

    def test_unsupervised_inhibition_is_refused_before_mutation(self):
        self.env.pop('CLAWBOX_AP_SUPERVISED')
        self.assertNotEqual(self.shell('wifi_inhibit').returncode, 0)
        self.assertEqual(self.policy.read_text().strip(), 'yes')
        self.assertFalse((self.root / 'calls').exists())

    def test_original_no_is_not_changed_to_yes(self):
        self.policy.write_text('no\n')
        result = self.shell('wifi_recover; wifi_inhibit; wifi_recover')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.policy.read_text().strip(), 'no')

    def test_second_owner_cannot_enter_until_first_releases(self):
        p = self.shell('wifi_recover; wifi_inhibit; touch "$TEST_ROOT/ready"; sleep 30', True)
        self.await_file('ready')
        second = self.shell('wifi_recover; touch "$TEST_ROOT/second"', True)
        time.sleep(.2)
        self.assertFalse((self.root / 'second').exists())
        os.killpg(p.pid, signal.SIGKILL)
        p.wait()
        self.await_file('second')
        self.assertEqual(second.wait(timeout=3), 0)
        self.assertEqual(self.policy.read_text().strip(), 'yes')

class Dispatcher(unittest.TestCase):
    def test_down_hook_returns_promptly_and_reports_failed_service_launch(self):
        root = HELPER.parent.parent
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            (tmp / 'bin').mkdir()
            for name, body in {
                'nmcli': 'if [[ "$*" == *"connection up"* ]]; then sleep 10; fi',
                'logger': 'printf "%s\\n" "$*" >> "$TEST_ROOT/log"',
                'systemctl': 'printf "%s\\n" "$*" >> "$TEST_ROOT/systemctl"; exit 1',
            }.items():
                p = tmp / 'bin' / name
                p.write_text('#!/bin/bash\n' + body + '\n')
                p.chmod(0o755)
            env = {**os.environ, 'PATH': str(tmp / 'bin') + ':' + os.environ['PATH'],
                   'TEST_ROOT': d, 'CLAWBOX_RUN_DIR': d, 'CLAWBOX_ONLINE_WAITER': '/missing'}
            started = time.monotonic()
            result = subprocess.run(['bash', str(root / 'scripts/nm-dispatcher-failover.sh'),
                                     'eth-test', 'down'], env=env, capture_output=True, timeout=2)
            self.assertLess(time.monotonic() - started, 2)
            self.assertTrue((tmp / 'systemctl').exists(), 'dispatcher must request a supervised worker')
            self.assertIn('--no-block start clawbox-wifi-failover.service', (tmp / 'systemctl').read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('failed', (tmp / 'log').read_text())

class Integration(unittest.TestCase):
    def test_dispatcher_is_not_published_without_installed_worker_and_unit(self):
        root = HELPER.parent.parent
        installer = (root / 'install.sh').read_text()
        start = installer.index('step_nm_dispatcher() {')
        body = installer[start:installer.index('\n}', start) + 2]
        with tempfile.TemporaryDirectory() as d:
            command = 'set -u; SRC_DIR="$1"; ROOT_LIBEXEC_DIR="$2"; '\
                      'cmp() { return 1; }; mkdir() { :; }; install() { :; }; '\
                      'install_root_file() { touch "$2.published"; }; '\
                      'record_provision_failure() { :; }; '\
                      + body.replace('/etc/NetworkManager/dispatcher.d', d) + '\nstep_nm_dispatcher'
            result = subprocess.run(['bash', '-c', command, 'test', str(root), d],
                                    capture_output=True, timeout=3)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((Path(d) / '90-clawbox-failover.published').exists())

    def test_post_update_installs_services_before_dispatcher(self):
        installer = (HELPER.parent.parent / 'install.sh').read_text()
        self.assertLess(installer.index('optional_step systemd_services step_systemd_services'),
                        installer.index('optional_step nm_dispatcher step_nm_dispatcher'))

    def test_every_inhibiting_worker_has_service_cleanup(self):
        root = HELPER.parent.parent
        unit = (root / 'config/clawbox-ap.service').read_text()
        self.assertIn('ExecStopPost=/usr/local/libexec/clawbox/wifi-radio.sh --recover', unit)
        self.assertIn('Environment=CLAWBOX_AP_SUPERVISED=1', unit)
        start = (root / 'scripts/start-ap.sh').read_text()
        self.assertIn('wifi_lock', start)
        self.assertIn('wifi_recover', start)
        self.assertIn('wifi_inhibit', start)

if __name__ == '__main__':
    unittest.main()
