#!/usr/bin/env python3
"""Read-only fixture tests; no host service, credential, or timezone changes."""
import importlib.util
import io
import os
from pathlib import Path
import pwd
import subprocess
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('package_builder',HERE/'build-package.py')
builder=importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class IntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory(prefix='clawbox-x64-test-')
        cls.base=Path(cls.tmp.name)
        cls.stage=cls.base/'package'
        cls.deb=cls.base/'package.deb'
        owner=pwd.getpwuid(os.getuid())
        args=SimpleNamespace(user=owner.pw_name,project='/home/nexus0/clawbox',node_dir='/usr/bin',
                             npm_prefix='/home/nexus0/.nvm/versions/node/v24.0.0',version='1.0.0',
                             staging=str(cls.stage),output=str(cls.deb))
        builder.build(args)

    @classmethod
    def tearDownClass(cls): cls.tmp.cleanup()

    def test_package_root_ownership_and_scope(self):
        stream=subprocess.check_output(['dpkg-deb','--fsys-tarfile',str(self.deb)])
        members=tarfile.open(fileobj=io.BytesIO(stream)).getmembers()
        self.assertTrue(all(m.uid==0 and m.gid==0 for m in members))
        self.assertTrue(all(not m.mode & 0o022 for m in members))
        self.assertTrue(all(not m.issym() and not m.islnk() for m in members))
        manifest=(self.stage/'usr/local/libexec/clawbox/clawbox-root-manifest.sh').read_text()
        self.assertIn('PROJECT_DIR="/var/lib/clawbox/x64-update-source"',manifest)
        self.assertIn('COVERED_PATHS="install.sh install-x64.sh scripts config"',manifest)
        sudoers=self.stage/'etc/sudoers.d/clawbox-x64-integration'
        subprocess.run(['/usr/sbin/visudo','-cf',str(sudoers)],check=True,capture_output=True)
        self.assertNotIn('/home/nexus0/clawbox/scripts/',sudoers.read_text())
        launcher=(self.stage/'usr/local/libexec/clawbox/clawbox-run-root-step.sh').read_text()
        self.assertNotIn('harness_swap ',launcher)

    def test_every_installed_shell_script_parses(self):
        for p in self.stage.rglob('*'):
            if p.is_file() and p.read_bytes()[:2]==b'#!' and (p.suffix=='.sh' or p.name in ['postinst','cloudflared-quick','openclaw-cli']):
                subprocess.run(['/bin/bash','-n',str(p)],check=True,capture_output=True)

    def fixture(self):
        t=tempfile.TemporaryDirectory(prefix='case-',dir=self.base)
        self.addCleanup(t.cleanup)
        root=Path(t.name)
        (root/'data').mkdir()
        config=root/'host.env'
        config.write_text(f'INSTALL_USER=fixture\nINSTALL_HOME={root}\nINSTALL_UID={os.getuid()}\nPROJECT_DIR={root}\nNODE_DIR=/usr/bin\nNPM_PREFIX={root}\n')
        runuser=root/'runuser'
        runuser.write_text('#!/bin/sh\nshift 3\nexec "$@"\n')
        runuser.chmod(0o755)
        timedate=root/'timedatectl'
        timedate.write_text(f'''#!/bin/sh
case "$1" in
list-timezones) printf 'Europe/Sofia\\nEtc/UTC\\n' ;;
show) printf 'Etc/UTC\\n' ;;
set-timezone) printf '%s' "$2" > '{root}/applied' ;;
*) exit 64 ;;
esac
''')
        timedate.chmod(0o755)
        worker=(HERE/'clawbox-x64-step.sh').read_text()
        worker=worker.replace('[ "$(id -u)" -eq 0 ] || exit 77','true # fixture only')
        worker=worker.replace('/etc/clawbox/x64-integration.env',str(config))
        worker=worker.replace('/usr/sbin/runuser',str(runuser)).replace('/usr/bin/timedatectl',str(timedate))
        path=root/'worker.sh'; path.write_text(worker)
        return root,path

    def run_worker(self,path,step='set_timezone'):
        return subprocess.run(['/bin/bash',str(path),step],capture_output=True,text=True,timeout=5)

    def test_timezone_applies_valid_zone(self):
        root,worker=self.fixture()
        (root/'data/timezone.env').write_text('TIMEZONE=Europe/Sofia\n')
        result=self.run_worker(worker)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((root/'applied').read_text(),'Europe/Sofia')

    def test_update_steps_deliver_coding_harness_from_mirror_as_owner(self):
        """Both update phases use verified source even when the checkout differs."""
        for step in ['bootstrap_updater', 'post_update']:
            with self.subTest(step=step):
                root,worker=self.fixture()
                mirror=root/'mirror'
                (mirror/'scripts/x64-migration').mkdir(parents=True)
                installer=(HERE/'install-coding-harness.sh').read_text()
                installer=installer.replace('[ "$(/usr/bin/id -u)" -ne 0 ]','[ 1000 -ne 0 ]')
                (mirror/'scripts/x64-migration/install-coding-harness.sh').write_text(installer)
                (mirror/'scripts/claude-ds').write_text((HERE.parent/'claude-ds').read_text())
                (root/'.local/bin').mkdir(parents=True)
                cli=root/'.local/bin/claude'
                cli.write_text('#!/bin/sh\nexit 0\n'); cli.chmod(0o755)
                # The mutable checkout is deliberately not executable source.
                (root/'scripts/x64-migration').mkdir(parents=True)
                (root/'scripts/x64-migration/install-coding-harness.sh').write_text('exit 99\n')
                manifest=root/'manifest'
                manifest.write_text(f'#!/bin/sh\nprintf "manifest-%s\\n" "$1" >> "{root}/events"\n')
                manifest.chmod(0o755)
                source=worker.read_text().replace('MIRROR=/var/lib/clawbox/root-exec-mirror',f'MIRROR={mirror}')
                source=source.replace('MANIFEST=/usr/local/libexec/clawbox/clawbox-root-manifest.sh',f'MANIFEST={manifest}')
                source=source.replace('    refresh_trusted_source\n',f'    printf "refresh-source\\n" >> "{root}/events"\n')
                worker.write_text(source)
                result=self.run_worker(worker,step)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertTrue(os.access(root/'.local/bin/claude-ds',os.X_OK))
                events=(root/'events').read_text().splitlines()
                self.assertEqual(events,['refresh-source'] if step=='bootstrap_updater' else ['manifest---verify','manifest---mirror'])
                # A bad/missing verified wrapper must fail the update, rather
                # than silently leaving the Coding app unusable again.
                (mirror/'scripts/claude-ds').unlink()
                result=self.run_worker(worker,step)
                self.assertNotEqual(result.returncode,0)

    def test_timezone_rejects_symlinks_fifo_shell_and_invalid_values(self):
        for kind in ['symlink','fifo','shell','unknown','oversize','multiple']:
            with self.subTest(kind=kind):
                root,worker=self.fixture()
                p=root/'data/timezone.env'
                if kind=='symlink':
                    (root/'outside').write_text('TIMEZONE=Europe/Sofia\n'); p.symlink_to(root/'outside')
                elif kind=='fifo': os.mkfifo(p)
                elif kind=='shell': p.write_text(f'TIMEZONE=$(touch {root}/owned)\n')
                elif kind=='unknown': p.write_text('TIMEZONE=Not/AZone\n')
                elif kind=='oversize': p.write_text('TIMEZONE='+'A'*600)
                else: p.write_text('TIMEZONE=Europe/Sofia\nTIMEZONE=Etc/UTC\n')
                result=self.run_worker(worker)
                self.assertNotEqual(result.returncode,0,result.stdout)
                self.assertFalse((root/'applied').exists())
                self.assertFalse((root/'owned').exists())

    def test_unknown_step_fails_closed(self):
        root,worker=self.fixture()
        result=self.run_worker(worker,'set_timezone;touch pwned')
        self.assertEqual(result.returncode,64)
        self.assertFalse((root/'pwned').exists())

    def core_fixture(self,doctor_exit=0):
        root,worker=self.fixture()
        runtime=root/'runtime'; runtime.mkdir()
        binary=root/'bin'; binary.mkdir()
        (root/'mirror/config').mkdir(parents=True)
        (root/'mirror/config/openclaw-target.txt').write_text('2026.8.1\n')
        node=runtime/'node'; node.write_text('#!/bin/sh\nprintf "2026.8.1\\n"\n'); node.chmod(0o755)
        doctor=binary/'openclaw'
        doctor.write_text(f'''#!/bin/sh
printf 'doctor-start\\n' >> '{root}/events'
sleep 0.15
printf 'doctor-end\\n' >> '{root}/events'
exit {doctor_exit}
'''); doctor.chmod(0o755)
        host=root/'host.env'; host.write_text(host.read_text().replace('NODE_DIR=/usr/bin',f'NODE_DIR={runtime}'))
        gateway=root/'gateway'
        gateway.write_text(f'#!/bin/sh\nprintf "gateway-%s\\n" "$1" >> "{root}/events"\n'); gateway.chmod(0o755)
        systemctl=root/'systemctl'
        systemctl.write_text(f'#!/bin/sh\nprintf "system-%s\\n" "$1" >> "{root}/events"\n'); systemctl.chmod(0o755)
        maintenance=root/'maintenance'
        # Exercise the packaged maintenance lock/reentrant descriptor logic;
        # replace only host effects with fixture paths and inert commands.
        source=(self.stage/'usr/local/libexec/clawbox/clawbox-gateway-maintenance.sh').read_text()
        source=source.replace('[ "$(id -u)" -eq 0 ] || exit 77','true # fixture only')
        source=source.replace('/run/clawbox-x64-core.lock',str(root/'core.lock'))
        source=source.replace('/run/clawbox-gateway-maintenance',str(root/'guard'))
        source=source.replace('/run/systemd/system/clawbox-gateway.service.d/99-clawbox-maintenance.conf',str(root/'dropin/guard.conf'))
        source=source.replace('install -d -o root -g root -m 0755','install -d -m 0755')
        source=source.replace('/usr/local/libexec/clawbox/clawbox-x64-gateway.sh',str(gateway))
        source=source.replace('/usr/bin/systemctl daemon-reload',f'{systemctl} daemon-reload')
        source=source.replace('/usr/bin/systemctl show clawbox-gateway.service -p DropInPaths --value | grep -Fq "$dropin"','test -f "$dropin"')
        maintenance.write_text(source); maintenance.chmod(0o755)
        source=worker.read_text().replace('/var/lib/clawbox/root-exec-mirror',str(root/'mirror'))
        source=source.replace('/run/clawbox-x64-core.lock',str(root/'core.lock'))
        source=source.replace('/run/clawbox-gateway-maintenance',str(root/'guard'))
        source=source.replace('/usr/local/libexec/clawbox/clawbox-gateway-maintenance.sh',str(maintenance))
        source=source.replace('/usr/local/libexec/clawbox/clawbox-x64-gateway.sh',str(gateway))
        source=source.replace('/usr/bin/systemctl',str(systemctl))
        worker.write_text(source)
        return root,worker,maintenance

    def test_core_validation_failure_propagates_after_guard_cleanup(self):
        root,worker,_=self.core_fixture(42)
        result=self.run_worker(worker,'openclaw_install')
        self.assertEqual(result.returncode,42,result.stderr)
        self.assertFalse((root/'guard').exists())
        events=(root/'events').read_text()
        self.assertIn('gateway-stop',events)
        self.assertIn('system-start',events)
        self.assertNotIn('configuration accepted',result.stdout)

    def test_concurrent_core_steps_never_overlap(self):
        root,worker,_=self.core_fixture()
        processes=[subprocess.Popen(['/bin/bash',str(worker),step],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                   for step in ['openclaw_install','openclaw_config']]
        for process in processes:
            out,err=process.communicate(timeout=5)
            self.assertEqual(process.returncode,0,err)
        events=[line for line in (root/'events').read_text().splitlines() if line.startswith('doctor-')]
        self.assertEqual(events,['doctor-start','doctor-end','doctor-start','doctor-end'])
        self.assertFalse((root/'guard').exists())

    def test_memory_patch_failure_propagates_after_backup_hook_and_cleanup(self):
        root,worker,_=self.core_fixture()
        for name,code in [('backup-sqlite',0),('memory-maintenance',65)]:
            hook=root/'bin'/f'openclaw-patch-{name}'
            hook.write_text(f'''#!/bin/sh
test "$1" = '{root}/lib/node_modules/openclaw' || exit 99
printf 'patch-{name}\\n' >> '{root}/events'
exit {code}
''')
            hook.chmod(0o755)
        result=self.run_worker(worker,'openclaw_install')
        self.assertEqual(result.returncode,65,result.stderr)
        self.assertIn('memory maintenance compatibility repair refused',result.stderr)
        self.assertFalse((root/'guard').exists())
        events=(root/'events').read_text().splitlines()
        self.assertLess(events.index('patch-backup-sqlite'),events.index('patch-memory-maintenance'))
        self.assertNotIn('doctor-start',events)
        self.assertIn('system-start',events)
        self.assertNotIn('configuration accepted',result.stdout)

    def test_external_maintenance_leave_waits_for_active_core_writer(self):
        root,worker,maintenance=self.core_fixture()
        process=subprocess.Popen(['/bin/bash',str(worker),'openclaw_install'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            if (root/'events').exists() and 'doctor-start' in (root/'events').read_text(): break
            time.sleep(0.01)
        result=subprocess.run(['/bin/bash',str(maintenance),'leave'],capture_output=True,text=True,timeout=5)
        self.assertIn('doctor-end',(root/'events').read_text())
        out,err=process.communicate(timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(process.returncode,0,err)
        self.assertIn('doctor-end',(root/'events').read_text())
        self.assertFalse((root/'guard').exists())

    def test_changed_core_pin_is_refused_before_any_core_command(self):
        """A refused migration must release maintenance and restore the gateway."""
        root,worker,_=self.core_fixture()
        (root/'mirror/config/openclaw-target.txt').write_text('2026.9.1\n')
        result=self.run_worker(worker,'openclaw_install')
        self.assertEqual(result.returncode,78,result.stderr)
        self.assertNotIn('doctor-start',(root/'events').read_text())
        self.assertIn('reviewed state snapshot',result.stderr)
        self.assertFalse((root/'guard').exists())
        self.assertIn('system-start',(root/'events').read_text())

    def rebuild_fixture(self,fail_at=None):
        """Model dependency/build failures with an old UI and owner-state sentinels."""
        root,worker,_=self.core_fixture()
        (root/'.next/standalone').mkdir(parents=True)
        (root/'.next/BUILD_ID').write_text('old-build')
        (root/'.next/standalone/server.js').write_text('old-server')
        (root/'.env').write_text('FIXTURE_CONFIG=preserve\n')
        (root/'data/owner-state').write_text('preserve sessions and configuration')
        (root/'.bun/bin').mkdir(parents=True)
        bun=root/'.bun/bin/bun'
        bun.write_text(f'''#!/bin/sh
printf 'bun-%s\\n' "$1" >> '{root}/events'
if [ "$1" = install ]; then
  [ '{fail_at}' != install ] || exit 37
  exit 0
fi
mkdir -p .next/standalone
printf new-build > .next/BUILD_ID
printf new-server > .next/standalone/server.js
[ '{fail_at}' != build ] || exit 41
''')
        bun.chmod(0o755)
        return root,worker

    def test_full_update_rebuild_failure_restores_ui_after_gateway_was_restored(self):
        """A failed rebuild must retain the UI without stranding Telegram offline."""
        for failure in ['install','build']:
            with self.subTest(failure=failure):
                root,worker=self.rebuild_fixture(failure)
                core=self.run_worker(worker,'openclaw_install')
                self.assertEqual(core.returncode,0,core.stderr)
                before=(root/'events').read_text().splitlines()
                self.assertIn('system-start',before)
                self.assertFalse((root/'guard').exists())
                result=self.run_worker(worker,'rebuild_reboot')
                self.assertEqual(result.returncode,37 if failure=='install' else 41,result.stderr)
                self.assertEqual((root/'.next/BUILD_ID').read_text(),'old-build')
                self.assertEqual((root/'.next/standalone/server.js').read_text(),'old-server')
                after=(root/'events').read_text().splitlines()[len(before):]
                self.assertNotIn('gateway-stop',after)
                self.assertEqual(after[-1],'system-restart')
                self.assertFalse((root/'guard').exists())
                self.assertEqual((root/'.env').read_text(),'FIXTURE_CONFIG=preserve\n')
                self.assertEqual((root/'data/owner-state').read_text(),'preserve sessions and configuration')

    def test_successful_ui_rebuild_restarts_only_ui_and_keeps_new_build(self):
        """A successful desktop rebuild replaces assets without cycling the gateway."""
        root,worker=self.rebuild_fixture()
        result=self.run_worker(worker,'rebuild_reboot')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((root/'.next/BUILD_ID').read_text(),'new-build')
        self.assertEqual((root/'.next/standalone/server.js').read_text(),'new-server')
        events=(root/'events').read_text().splitlines()
        self.assertEqual(events,['system-stop','bun-install','bun-run','system-restart'])
        self.assertFalse((root/'guard').exists())

    def test_initial_bridge_activation_preserves_running_user_service(self):
        postinst=(self.stage/'DEBIAN/postinst').read_text()
        self.assertIn('systemctl start clawbox-gateway.service',postinst)
        self.assertNotIn('systemctl restart',postinst)
        bridge=(self.stage/'etc/systemd/system/clawbox-gateway.service').read_text()
        self.assertIn('RemainAfterExit=yes',bridge)
        self.assertIn('clawbox-x64-gateway.sh stop',bridge)
        condition=(self.stage/'etc/systemd/user/openclaw-gateway.service.d/90-clawbox-maintenance.conf').read_text()
        self.assertIn('ConditionPathExists=!/run/clawbox-gateway-maintenance',condition)

    def ollama_home_fixture(self,mode):
        temp=tempfile.TemporaryDirectory(prefix='ollama-home-',dir=self.base)
        self.addCleanup(temp.cleanup)
        root=Path(temp.name)
        home=root/'ollama'
        getent=root/'getent'
        getent.write_text(f'#!/bin/sh\nprintf "ollama:x:{os.getuid()}:{os.getgid()}::{home}:/bin/false\\n"\n')
        getent.chmod(0o755)
        identity=root/'id'
        identity.write_text(f'#!/bin/sh\ncase "$1" in -u) echo {os.getuid()} ;; -g) echo {os.getgid()} ;; *) exit 64 ;; esac\n')
        identity.chmod(0o755)
        install=root/'install'
        install.write_text(f'''#!/bin/sh
test "$1 $2 $3 $4 $5 $6 $7" = '-d -o ollama -g ollama -m 0755' || exit 64
printf 'created\\n' > '{root}/installed'
exec /usr/bin/install -d -m 0755 "$8"
''')
        install.chmod(0o755)
        source=(HERE/'ensure-ollama-home.sh').read_text()
        source=source.replace('/usr/share/ollama',str(home))
        source=source.replace('/usr/bin/getent',str(getent)).replace('/usr/bin/id',str(identity)).replace('/usr/bin/install',str(install))
        if mode=='existing':
            home.mkdir(mode=0o700)
            (home/'model-sentinel').write_text('preserve this model')
        elif mode=='symlink':
            (root/'outside').mkdir()
            home.symlink_to(root/'outside')
        elif mode=='wrong-owner':
            home.mkdir()
            fake_stat=root/'stat'
            fake_stat.write_text('#!/bin/sh\necho 999999:999999\n'); fake_stat.chmod(0o755)
            source=source.replace('/usr/bin/stat',str(fake_stat))
        worker=root/'postinst-home.sh'
        worker.write_text('set -eu\n'+source+'\nensure_ollama_home\n')
        return root,home,worker

    def test_ollama_missing_home_created_with_requested_owner_and_mode(self):
        root,home,worker=self.ollama_home_fixture('missing')
        result=subprocess.run(['/bin/sh',str(worker)],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue(home.is_dir())
        self.assertEqual(home.stat().st_mode & 0o777,0o755)
        self.assertTrue((root/'installed').exists())

    def test_ollama_existing_home_preserves_contents_and_permissions(self):
        root,home,worker=self.ollama_home_fixture('existing')
        result=subprocess.run(['/bin/sh',str(worker)],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((home/'model-sentinel').read_text(),'preserve this model')
        self.assertEqual(home.stat().st_mode & 0o777,0o700)
        self.assertFalse((root/'installed').exists())

    def test_ollama_symlink_and_wrong_owner_are_refused(self):
        for kind in ['symlink','wrong-owner']:
            with self.subTest(kind=kind):
                root,home,worker=self.ollama_home_fixture(kind)
                result=subprocess.run(['/bin/sh',str(worker)],capture_output=True,text=True,timeout=5)
                self.assertNotEqual(result.returncode,0)
                self.assertFalse((root/'installed').exists())
                if kind=='symlink': self.assertTrue(home.is_symlink())

    def test_ollama_missing_account_and_custom_home_are_untouched(self):
        for kind in ['missing-account','custom-home']:
            with self.subTest(kind=kind):
                root,home,worker=self.ollama_home_fixture('missing')
                getent=root/'getent'
                if kind=='missing-account': getent.write_text('#!/bin/sh\nexit 2\n')
                else: getent.write_text(getent.read_text().replace(str(home),str(root/'custom-home')))
                result=subprocess.run(['/bin/sh',str(worker)],capture_output=True,text=True,timeout=5)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertFalse(home.exists())
                self.assertFalse((root/'custom-home').exists())
                self.assertFalse((root/'installed').exists())


if __name__=='__main__': unittest.main()
