#!/usr/bin/env python3
"""Owner-only installer fixtures; no vendor downloads or real coding runs."""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class CodingHarnessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='clawbox-x64-coding-')
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.bin = self.home / '.local/bin'
        self.bin.mkdir(parents=True)
        self.project = self.home / "desktop checkout's $project"
        (self.project / 'data').mkdir(parents=True)
        (self.project / 'data/config.json').write_text(json.dumps({'clawai_token': 'fixture-token'}))
        # Exclude any CI/developer CLI in /usr/local/bin. Only fixture binaries
        # and OS utilities are available, and root CI exercises the owner path
        # by replacing only the identity check (the real root refusal is below).
        source = (HERE / 'install-coding-harness.sh').read_text()
        source = source.replace('[ "$(/usr/bin/id -u)" -ne 0 ]', '[ 1000 -ne 0 ]')
        source = source.replace('export PATH="$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/snap/bin"',
                                'export PATH="$HOME/.local/bin:/usr/bin:/bin"')
        self.installer = self.home / 'installer.sh'
        self.installer_source = source
        self.installer.write_text(source)
        self.write_bin('curl', '#!/bin/sh\necho unexpected-download >&2\nexit 99\n')

    def write_bin(self, name, source):
        p = self.bin / name
        p.write_text(source)
        p.chmod(0o755)
        return p

    def install(self, wrapper=None):
        return subprocess.run(['/bin/bash', str(self.installer), str(wrapper or HERE.parent / 'claude-ds'), str(self.project)],
                              env={'HOME': str(self.home), 'PATH': '/usr/bin:/bin'}, capture_output=True, text=True, timeout=10)

    def test_existing_cli_and_codex_preserved_wrapper_runs_with_desktop_default(self):
        claude = self.write_bin('claude', '#!/bin/sh\nprintf "%s" "$ANTHROPIC_AUTH_TOKEN" > "$HOME/claude-token"\n')
        codex = self.write_bin('codex', '#!/bin/sh\nexit 17\n')
        before = (claude.read_bytes(), codex.read_bytes())
        for _ in range(2):
            result = self.install()
            self.assertEqual(result.returncode, 0, result.stderr)
        wrapper = self.bin / 'claude-ds'
        self.assertFalse(wrapper.is_symlink())
        self.assertEqual(wrapper.stat().st_mode & 0o777, 0o755)
        self.assertEqual((claude.read_bytes(), codex.read_bytes()), before)
        run = subprocess.run([str(wrapper), '--version'], cwd=self.project,
                             env={'HOME': str(self.home), 'PATH': f'{self.bin}:/usr/bin:/bin'}, capture_output=True, text=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual((self.home / 'claude-token').read_text(), 'fixture-token')

    def test_wrapper_symlink_is_replaced_without_modifying_its_target(self):
        self.write_bin('claude', '#!/bin/sh\nexit 0\n')
        outside = self.home / 'old-wrapper'
        outside.write_text('preserve')
        (self.bin / 'claude-ds').symlink_to(outside)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.bin / 'claude-ds').is_symlink())
        self.assertEqual(outside.read_text(), 'preserve')

    def fake_download(self, body, status=0, valid_checksum=True):
        payload = self.home / 'vendor.sh'
        payload.write_text(body)
        # The real helper has no environment override for the trusted digest.
        # Only this fixture copy substitutes a reviewed stand-in executable.
        checksum = hashlib.sha256(payload.read_bytes()).hexdigest() if valid_checksum else '0' * 64
        self.installer.write_text(self.installer_source.replace(
            '9691a2b7bd796712ca8cffb8e32e54ff7fc45b662540233171a16a94a0425653', checksum))
        self.write_bin('curl', '''#!/bin/sh
test "$1 $2 $3 $4 $5 $6 $7 $8 $9" = '-fsSL --proto =https --proto-redir =https --connect-timeout 15 --max-time 300' || exit 98
shift 9
test "$1 $2" = 'https://downloads.claude.ai/claude-code-releases/2.1.268/linux-x64/claude -o' || exit 97
cp "$HOME/vendor.sh" "$3"
''' + f'exit {status}\n')

    def test_missing_cli_installed_as_owner_from_https_then_verified(self):
        self.fake_download('#!/bin/sh\ntest "$1 $2" = "install 2.1.268" || exit 96\nmkdir -p "$HOME/.local/bin"\nprintf "#!/bin/sh\\nexit 0\\n" > "$HOME/.local/bin/claude"\nchmod 755 "$HOME/.local/bin/claude"\n')
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(os.access(self.bin / 'claude', os.X_OK))
        self.assertTrue(os.access(self.bin / 'claude-ds', os.X_OK))

    def test_download_failure_invalid_response_and_missing_cli_fail_explicitly(self):
        cases = [('exit 0\n', 22), ('', 0), ('<html>region blocked</html>', 0),
                 ('unavailable in region', 0), ('exit 41\n', 0), ('exit 0\n', 0)]
        for body, status in cases:
            with self.subTest(body=body, status=status):
                self.fake_download(body, status)
                result = self.install()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.bin / 'claude-ds').exists())

    def test_checksum_mismatch_never_executes_payload_and_cleans_download(self):
        self.fake_download('#!/bin/sh\ntouch "$HOME/payload-executed"\n', valid_checksum=False)
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('checksum mismatch', result.stderr)
        self.assertFalse((self.home / 'payload-executed').exists())
        self.assertFalse((self.bin / 'claude-ds').exists())
        self.assertEqual(list((self.home / '.cache/clawbox').iterdir()), [])

    def test_missing_or_changed_wrapper_fails_without_replacing_old_wrapper(self):
        self.write_bin('claude', '#!/bin/sh\nexit 0\n')
        old = self.write_bin('claude-ds', '#!/bin/sh\nexit 17\n')
        source = self.home / 'wrapper-source'
        for exists in [False, True]:
            if exists: source.write_text('#!/bin/sh\nexit 0\n')
            result = self.install(source)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(old.read_text(), '#!/bin/sh\nexit 17\n')

    def test_root_invocation_is_refused_before_home_writes(self):
        source = (HERE / 'install-coding-harness.sh').read_text()
        self.installer.write_text(source.replace('$(/usr/bin/id -u)', '0'))
        result = self.install()
        self.assertEqual(result.returncode, 77)
        self.assertFalse((self.bin / 'claude-ds').exists())


if __name__ == '__main__': unittest.main()
