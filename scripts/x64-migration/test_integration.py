#!/usr/bin/env python3
"""Read-only fixture tests; no host service, credential, or timezone changes."""
import importlib.util
import io
import json
import os
from pathlib import Path
import pwd
import shutil
import signal
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
        cls.project=os.path.join(owner.pw_dir,'clawbox')
        # The builder refuses a Node the pinned core refuses, so the package
        # under test names a Node that answers as one the core accepts — never
        # the runner's own /usr/bin/node, whose version is the runner's.
        cls.node_dir=cls.node_stub(cls.base,'v24.18.0')
        args=SimpleNamespace(user=owner.pw_name,project=cls.project,node_dir=cls.node_dir,
                             npm_prefix=os.path.join(owner.pw_dir,'.nvm/versions/node/v24.0.0'),version='1.0.0',
                             staging=str(cls.stage),output=str(cls.deb))
        builder.build(args)

    @staticmethod
    def node_stub(base,version):
        """A bin directory whose `node --version` answers `version` (or nothing, for None)."""
        d=tempfile.mkdtemp(prefix='node-',dir=base)
        if version is not None:
            node=Path(d)/'node'
            node.write_text(f'#!/bin/sh\n[ "$1" = --version ] || exit 64\nprintf "%s\\n" "{version}"\n'); node.chmod(0o755)
        return d

    # Exactly the published `engines.node` of the pinned core, as a table — the
    # same matrix install-node-engine-table.test.ts runs the installers' bash
    # copies over, so the builder's Python copy cannot drift from them.
    NODE_REJECTED=['22.22.2','22.22.3','22.23.2','23.11.0','24.15.0','25.9.0','26.0.0']
    NODE_ACCEPTED=['24.16.0','24.21.0','26.1.0','26.8.2','27.0.0','100.0.0']

    def test_builder_node_engine_table_matches_the_installers(self):
        for v in self.NODE_REJECTED:
            self.assertFalse(builder.node_version_satisfies_openclaw_engine(v),v)
            self.assertFalse(builder.node_version_satisfies_openclaw_engine('v'+v),v)
        for v in self.NODE_ACCEPTED:
            self.assertTrue(builder.node_version_satisfies_openclaw_engine(v),v)
            self.assertTrue(builder.node_version_satisfies_openclaw_engine('v'+v),v)
        self.assertFalse(builder.node_version_satisfies_openclaw_engine(''))
        self.assertFalse(builder.node_version_satisfies_openclaw_engine(None))

    def test_builder_refuses_a_node_dir_the_pinned_core_refuses(self):
        """Refused where the builder's output is read, not inside the next core update's root unit."""
        owner=pwd.getpwuid(os.getuid())
        for version,accepted in [('v22.23.2',False),('v24.15.0',False),(None,False),('v24.16.0',True)]:
            with self.subTest(node=version):
                node_dir=self.node_stub(self.base,version)
                out=tempfile.mkdtemp(prefix='build-',dir=self.base)
                args=SimpleNamespace(user=owner.pw_name,project=self.project,node_dir=node_dir,
                                     npm_prefix=os.path.join(owner.pw_dir,'.nvm/versions/node/v24.0.0'),version='1.0.0',
                                     staging=os.path.join(out,'stage'),output=os.path.join(out,'package.deb'))
                if accepted:
                    builder.build(args)
                    env=Path(args.staging,'etc/clawbox/x64-integration.env').read_text()
                    self.assertIn(f'NODE_DIR={node_dir}\n',env)
                    continue
                with self.assertRaises(ValueError) as refused:
                    builder.build(args)
                self.assertIn('--node-dir',str(refused.exception))
                self.assertIn('>=24.16.0 <25, or >=26.1.0',str(refused.exception))
                if version: self.assertIn(version,str(refused.exception))
                self.assertFalse(Path(out,'package.deb').exists())

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
        self.assertNotIn(f'{self.project}/scripts/',sudoers.read_text())
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
        # 30 s, not 5: a core replacement runs several `sync -f` and python
        # spawns, and on a CI runner's disk that took the test past 5 s once.
        return subprocess.run(['/bin/bash',str(path),step],capture_output=True,text=True,timeout=30)

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

    # The fixture's OpenClaw launcher: the real layout (<prefix>/bin/openclaw a
    # relative symlink into <prefix>/lib/node_modules/openclaw/, the version its
    # own package.json's), so the staged core the fake npm writes answers for
    # itself exactly as the live one does. Every core command records an event;
    # doctor and config validate exit with core-exit, doctor also prints
    # doctor-says and, under doctor-mutates, rewrites the state the rollback
    # must put back; under doctor-creates it writes databases that did not
    # exist (a legacy-store migration's, a new agent's); under doctor-hangs it
    # stops there, for a test to cut the step short as a reboot would.
    LAUNCHER = r"""#!/bin/sh
here=$(dirname "$(readlink -f "$0")")
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$here/package.json")
case "$1" in
  --version) printf 'version-%s\n' "$version" >> '{root}/events'; printf 'OpenClaw %s (fixture)\n' "$version" ;;
  backup)
    case " $* " in *" --dry-run "*)
      printf '{"assets":[{"kind":"state","sourcePath":"{root}/.openclaw"}],"agentRoots":[{"agentId":"main","sourcePath":"{root}/.openclaw/agents/main/agent"}]}\n'; exit 0 ;;
    esac
    printf 'backup-%s\n' "$version" >> '{root}/events'
    [ ! -f '{root}/backup-exit' ] || exit "$(cat '{root}/backup-exit')"
    for bad in plugin-skills/outside agents/main/agent/tmp/dangling browser/SingletonSocket; do
      if [ -L "{root}/.openclaw/$bad" ]; then
        echo "Backup archive write failed: Archive symbolic link is outside the declared backup assets: $bad" >&2; exit 1
      fi
    done
    out=; while [ $# -gt 0 ]; do [ "$1" = --output ] && out=$2; shift; done
    printf 'archive' > "$out/fixture-openclaw-backup.tar.gz"; printf '{"ok":true}\n' ;;
  doctor)
    printf 'doctor-start\n' >> '{root}/events'
    sleep 0.15
    [ ! -f '{root}/doctor-says' ] || cat '{root}/doctor-says'
    if [ -f '{root}/doctor-mutates' ]; then
      printf 'migrated-by-%s' "$version" > '{root}/.openclaw/agents/main/agent/openclaw-agent.sqlite'
      printf 'shm' > '{root}/.openclaw/agents/main/agent/openclaw-agent.sqlite-shm'
      rm -f '{root}/.openclaw/agents/main/agent/openclaw-agent.sqlite-wal'
      printf '{"meta":{"lastTouchedVersion":"%s"}}' "$version" > '{root}/.openclaw/openclaw.json'
    fi
    if [ -f '{root}/doctor-creates' ]; then
      mkdir -p '{root}/.openclaw/state' '{root}/.openclaw/agents/ops/agent'
      printf 'created-by-%s' "$version" > '{root}/.openclaw/state/openclaw.sqlite'
      printf 'wal' > '{root}/.openclaw/state/openclaw.sqlite-wal'
      printf 'created-by-%s' "$version" > '{root}/.openclaw/agents/ops/agent/openclaw-agent.sqlite'
      printf 'shm' > '{root}/.openclaw/agents/ops/agent/openclaw-agent.sqlite-shm'
    fi
    [ ! -f '{root}/doctor-hangs' ] || sleep 30
    printf 'doctor-end\n' >> '{root}/events'
    exit "$(cat '{root}/core-exit')" ;;
  config)
    printf 'doctor-start\n' >> '{root}/events'
    sleep 0.15
    printf 'doctor-end\nvalidate-%s\n' "$version" >> '{root}/events'
    exit "$(cat '{root}/core-exit')" ;;
  *) exit 64 ;;
esac
"""

    # `node` answers `-p "require('<package.json>').version"` from that file.
    NODE = r"""#!/bin/sh
case "$1" in
  --version) printf 'v24.18.0\n' ;;
  -p) f=$(printf '%s' "$2" | sed -n "s/^require('\([^']*\)').version$/\1/p")
      [ -n "$f" ] && [ -f "$f" ] || exit 1
      sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$f" ;;
  *) exit 64 ;;
esac
"""

    # `npm install -g openclaw@<v> --prefix <stage>` lays the global shape out
    # in the stage -- at npm-version's version when that file says otherwise,
    # failing with npm-exit's code when it exists.
    NPM = r"""#!/bin/sh
[ "$1" = install ] || exit 0
printf 'npm-%s\n' "$1" >> '{root}/events'
[ ! -f '{root}/npm-exit' ] || exit "$(cat '{root}/npm-exit')"
prefix=; spec=
while [ $# -gt 0 ]; do
  case "$1" in --prefix) prefix=$2; shift ;; openclaw@*) spec=${1#openclaw@} ;; esac
  shift
done
[ ! -f '{root}/npm-version' ] || spec=$(cat '{root}/npm-version')
pkg="$prefix/lib/node_modules/openclaw"
mkdir -p "$pkg" "$prefix/bin"
printf '{"name":"openclaw","version":"%s"}\n' "$spec" > "$pkg/package.json"
cp '{root}/launcher.sh' "$pkg/openclaw.mjs"; chmod 0755 "$pkg/openclaw.mjs"
ln -s ../lib/node_modules/openclaw/openclaw.mjs "$prefix/bin/openclaw"
"""

    def core_fixture(self,doctor_exit=0):
        root,worker=self.fixture()
        runtime=root/'runtime'; runtime.mkdir()
        (root/'mirror/config').mkdir(parents=True)
        (root/'mirror/config/openclaw-target.txt').write_text('2026.8.1\n')
        (root/'core-exit').write_text(str(doctor_exit))
        for name,text in [('node',self.NODE),('npm',self.NPM.replace('{root}',str(root)))]:
            tool=runtime/name; tool.write_text(text); tool.chmod(0o755)
        (root/'launcher.sh').write_text(self.LAUNCHER.replace('{root}',str(root)))
        self.write_core(root,root,'2026.8.1')
        state=root/'.openclaw'
        (state/'state').mkdir(parents=True); (state/'agents/main/agent').mkdir(parents=True)
        (state/'openclaw.json').write_text('{"meta":{"lastTouchedVersion":"2026.8.1"}}')
        (state/'state/openclaw.sqlite').write_text('state-2026.8.1')
        (state/'agents/main/agent/openclaw-agent.sqlite').write_text('agent-2026.8.1')
        (state/'agents/main/agent/openclaw-agent.sqlite-wal').write_text('wal-2026.8.1')
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

    @staticmethod
    def write_core(root,prefix,version):
        pkg=prefix/'lib/node_modules/openclaw'; pkg.mkdir(parents=True)
        (pkg/'package.json').write_text('{"name":"openclaw","version":"%s"}\n'%version)
        (pkg/'openclaw.mjs').write_text((root/'launcher.sh').read_text()); (pkg/'openclaw.mjs').chmod(0o755)
        (prefix/'bin').mkdir(exist_ok=True)
        os.symlink('../lib/node_modules/openclaw/openclaw.mjs',prefix/'bin/openclaw')

    @staticmethod
    def core_version(tree):
        return json.loads((tree/'package.json').read_text())['version']

    @staticmethod
    def recovery_points(root):
        base=root/'backups/openclaw-core-update'
        return sorted(base.iterdir()) if base.is_dir() else []

    def test_changed_core_pin_replaces_the_core_behind_a_recovery_point(self):
        """Stage and gate first, then the archive and the state copy, then the swap and doctor."""
        root,worker,_=self.core_fixture()
        (root/'mirror/config/openclaw-target.txt').write_text('2026.9.1\n')
        result=self.run_worker(worker,'openclaw_install')
        self.assertEqual(result.returncode,0,result.stderr)
        events=(root/'events').read_text().splitlines()
        # Two doctor pairs: the migration, then config validate (the fixture logs every core command so).
        order=['gateway-stop','npm-install','version-2026.9.1','backup-2026.8.1','doctor-start','doctor-end','doctor-start','doctor-end','validate-2026.9.1','system-start']
        self.assertEqual([e for e in events if e in order],order,events)
        self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.9.1')
        self.assertEqual(self.core_version(root/'lib/node_modules/.openclaw-previous'),'2026.8.1')
        self.assertEqual(os.readlink(root/'bin/openclaw'),'../lib/node_modules/openclaw/openclaw.mjs')
        self.assertFalse((root/'.openclaw-stage').exists())
        points=self.recovery_points(root)
        self.assertEqual(len(points),1,points)
        point=points[0]
        self.assertTrue(point.name.endswith('-2026.8.1-to-2026.9.1'),point.name)
        self.assertEqual((point/'archive/fixture-openclaw-backup.tar.gz').read_text(),'archive')
        self.assertEqual((point/'state/config/openclaw.json').read_text(),'{"meta":{"lastTouchedVersion":"2026.8.1"}}')
        self.assertEqual((point/'state/state/openclaw.sqlite').read_text(),'state-2026.8.1')
        self.assertEqual((point/'state/agents/main/agent/openclaw-agent.sqlite-wal').read_text(),'wal-2026.8.1')
        self.assertEqual((point/'state/snapshot.txt').read_text().splitlines(),
                         ['config/openclaw.json','state/openclaw.sqlite','absent:state/openclaw.sqlite-wal','absent:state/openclaw.sqlite-shm',
                          'agents/main/agent/openclaw-agent.sqlite','agents/main/agent/openclaw-agent.sqlite-wal','absent:agents/main/agent/openclaw-agent.sqlite-shm'])
        self.assertFalse((root/'.openclaw-migration-pending').exists())
        self.assertIn('backup create --verify',(point/'recovery.txt').read_text())
        self.assertTrue((point/'doctor.log').exists())
        self.assertIn('OpenClaw 2026.9.1 installed; configuration accepted',result.stdout)
        self.assertFalse((root/'guard').exists())

    def test_refused_migration_restores_the_previous_core_and_the_state(self):
        """A failed or blocked doctor puts the core AND the one-generation state copy back."""
        for case in ['exit','blocker']:
            with self.subTest(case=case):
                root,worker,_=self.core_fixture(9 if case=='exit' else 0)
                (root/'mirror/config/openclaw-target.txt').write_text('2026.9.1\n')
                (root/'doctor-mutates').write_text('')
                if case=='blocker': (root/'doctor-says').write_text('agent database maintenance lease was lost\n')
                result=self.run_worker(worker,'openclaw_install')
                self.assertNotEqual(result.returncode,0)
                self.assertIn('restoring OpenClaw 2026.8.1',result.stderr)
                self.assertIn('back as they were',result.stderr)
                self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.8.1')
                self.assertEqual([p.name for p in (root/'lib/node_modules').iterdir()],['openclaw'])
                state=root/'.openclaw'
                self.assertEqual((state/'agents/main/agent/openclaw-agent.sqlite').read_text(),'agent-2026.8.1')
                self.assertEqual((state/'agents/main/agent/openclaw-agent.sqlite-wal').read_text(),'wal-2026.8.1')
                self.assertFalse((state/'agents/main/agent/openclaw-agent.sqlite-shm').exists())
                self.assertEqual((state/'openclaw.json').read_text(),'{"meta":{"lastTouchedVersion":"2026.8.1"}}')
                events=(root/'events').read_text().splitlines()
                self.assertIn('doctor-start',events)
                self.assertNotIn('validate-2026.9.1',events)
                self.assertIn('system-start',events)
                self.assertNotIn('configuration accepted',result.stdout)
                self.assertFalse((root/'guard').exists())
                self.assertEqual(len(self.recovery_points(root)),1)
                self.assertFalse((root/'.openclaw-migration-pending').exists())

    def test_staged_core_that_is_not_the_pin_never_reaches_the_live_prefix(self):
        """The gate is the staged launcher's own answer; nothing of the owner's is touched before it."""
        for case in ['other-version','npm-failed']:
            with self.subTest(case=case):
                root,worker,_=self.core_fixture()
                (root/'mirror/config/openclaw-target.txt').write_text('2026.9.1\n')
                if case=='other-version': (root/'npm-version').write_text('2026.9.0')
                else: (root/'npm-exit').write_text('7')
                result=self.run_worker(worker,'openclaw_install')
                self.assertNotEqual(result.returncode,0)
                self.assertIn('untouched',result.stderr)
                self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.8.1')
                events=(root/'events').read_text()
                self.assertNotIn('backup-',events)
                self.assertNotIn('doctor-start',events)
                self.assertFalse((root/'.openclaw-stage').exists())
                self.assertEqual(self.recovery_points(root),[])
                self.assertFalse((root/'guard').exists())
                self.assertIn('system-start',events)

    def test_node_the_package_names_is_checked_against_the_core_engines_before_npm_runs(self):
        """A package rebuilt without --node-dir once pointed the step at the distro's Node 22: the owner read npm's wall of text, not the repair."""
        root,worker,_=self.core_fixture()
        (root/'mirror/config/openclaw-target.txt').write_text('2026.9.1\n')
        node=root/'runtime/node'
        node.write_text(self.NODE.replace("printf 'v24.18.0\\n'","printf 'v22.23.2\\n'"))
        result=self.run_worker(worker,'openclaw_install')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('v22.23.2',result.stderr)
        self.assertIn('>=24.16.0 <25, or >=26.1.0',result.stderr)
        self.assertIn('--node-dir',result.stderr)
        self.assertIn('untouched',result.stderr)
        events=(root/'events').read_text()
        self.assertNotIn('npm-install',events)
        self.assertNotIn('backup-',events)
        self.assertNotIn('doctor-start',events)
        self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.8.1')
        self.assertFalse((root/'.openclaw-stage').exists())
        self.assertEqual(self.recovery_points(root),[])
        self.assertFalse((root/'guard').exists())
        self.assertIn('system-start',events)

    # The links the archiver refuses: an absolute target outside the state
    # tree, a relative one that lands outside (and does not exist), a stale
    # Chromium socket link; and one inside that must be left alone.
    @staticmethod
    def plant_links(root):
        state=root/'.openclaw'
        (state/'plugin-skills').mkdir(); (state/'agents/main/agent/tmp').mkdir(parents=True); (state/'browser').mkdir()
        links={'plugin-skills/outside':'/etc/hostname',
               'agents/main/agent/tmp/dangling':'../../../../../../nowhere-'+root.name,
               'browser/SingletonSocket':'../../../tmp/com.google.Chrome.fixture/SingletonSocket',
               'state/inside':'openclaw.sqlite'}
        for rel,target in links.items(): os.symlink(target,state/rel)
        return links

    def assert_links_back(self,root,links):
        for rel,target in links.items():
            path=root/'.openclaw'/rel
            self.assertTrue(path.is_symlink(),rel)
            self.assertEqual(os.readlink(path),target,rel)

    def test_links_the_archiver_refuses_are_set_aside_for_the_archive_and_put_back(self):
        root,worker,_=self.core_fixture()
        (root/'mirror/config/openclaw-target.txt').write_text('2026.9.1\n')
        links=self.plant_links(root)
        result=self.run_worker(worker,'openclaw_install')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('Set aside 3 symbolic links',result.stdout)
        self.assertIn('Put back 3 set-aside links',result.stdout)
        self.assert_links_back(root,links)
        point=self.recovery_points(root)[0]
        self.assertFalse((point/'set-aside-links.txt').exists())
        journal=(point/'set-aside-links.restored.txt').read_text().splitlines()
        self.assertEqual(sorted(l.split('\t')[0] for l in journal),
                         sorted(str(root/'.openclaw'/rel) for rel in ['plugin-skills/outside','agents/main/agent/tmp/dangling','browser/SingletonSocket']))
        self.assertEqual((point/'archive/fixture-openclaw-backup.tar.gz').read_text(),'archive')
        self.assertIn('"agentRoots"',(point/'backup-plan.json').read_text())
        self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.9.1')

    def test_set_aside_links_come_back_when_the_archive_fails(self):
        root,worker,_=self.core_fixture()
        (root/'mirror/config/openclaw-target.txt').write_text('2026.9.1\n')
        links=self.plant_links(root)
        (root/'backup-exit').write_text('3')
        result=self.run_worker(worker,'openclaw_install')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('backup create --verify failed',result.stderr)
        self.assert_links_back(root,links)
        self.assertFalse((self.recovery_points(root)[0]/'set-aside-links.txt').exists())
        self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.8.1')

    def test_links_a_cut_short_run_left_set_aside_are_put_back_by_the_next_step(self):
        root,worker,_=self.core_fixture()
        (root/'.openclaw/plugin-skills').mkdir()
        point=root/'backups/openclaw-core-update/20260101T000000Z-2026.8.0-to-2026.8.1'
        point.mkdir(parents=True)
        missing=root/'.openclaw/plugin-skills/outside'
        (point/'set-aside-links.txt').write_text(f'{missing}\t/etc/hostname\n')
        result=self.run_worker(worker,'openclaw_install')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('putting them back',result.stdout)
        self.assertTrue(missing.is_symlink()); self.assertEqual(os.readlink(missing),'/etc/hostname')
        self.assertFalse((point/'set-aside-links.txt').exists())
        self.assertTrue((point/'set-aside-links.restored.txt').exists())
        # A point still holding set-aside links is never pruned, and this one,
        # restored, is an ordinary point again: three newer ones push it out.
        self.assertIn('configuration accepted',result.stdout)

    def test_failed_archive_stops_before_the_swap(self):
        root,worker,_=self.core_fixture()
        (root/'mirror/config/openclaw-target.txt').write_text('2026.9.1\n')
        (root/'backup-exit').write_text('3')
        result=self.run_worker(worker,'openclaw_install')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('backup create --verify failed',result.stderr)
        self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.8.1')
        self.assertFalse((root/'lib/node_modules/.openclaw-previous').exists())
        self.assertFalse((root/'.openclaw-stage').exists())
        self.assertNotIn('doctor-start',(root/'events').read_text())
        self.assertFalse((root/'guard').exists())

    def test_owner_patch_for_another_core_is_skipped_with_a_warning(self):
        root,worker,_=self.core_fixture()
        hook=root/'bin/openclaw-patch-backup-sqlite'
        hook.write_text('#!/bin/sh\necho "Review required: this patch supports OpenClaw 2026.8.1, found 2026.9.1" >&2\nexit 1\n')
        hook.chmod(0o755)
        result=self.run_worker(worker,'openclaw_install')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('CLAWBOX-WARN[core-patch-skipped]: openclaw-patch-backup-sqlite',result.stdout)
        self.assertIn('configuration accepted',result.stdout)

    def test_parked_previous_core_is_put_back_when_the_live_one_is_gone(self):
        root,worker,_=self.core_fixture()
        (root/'lib/node_modules/openclaw').rename(root/'lib/node_modules/.openclaw-previous')
        result=self.run_worker(worker,'openclaw_install')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.8.1')
        self.assertNotIn('npm-install',(root/'events').read_text())

    def test_rollback_removes_the_databases_the_migration_created(self):
        """A database absent at the snapshot is recorded so; the restore removes it and its -wal/-shm."""
        root,worker,_=self.core_fixture(9)
        (root/'mirror/config/openclaw-target.txt').write_text('2026.9.1\n')
        state=root/'.openclaw'
        (state/'state/openclaw.sqlite').unlink()
        (root/'doctor-creates').write_text('')
        result=self.run_worker(worker,'openclaw_install')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('back as they were',result.stderr)
        manifest=(self.recovery_points(root)[0]/'state/snapshot.txt').read_text().splitlines()
        for rel in ['state/openclaw.sqlite','state/openclaw.sqlite-wal','state/openclaw.sqlite-shm']:
            self.assertIn('absent:'+rel,manifest)
        for rel in ['state/openclaw.sqlite','state/openclaw.sqlite-wal',
                    'agents/ops/agent/openclaw-agent.sqlite','agents/ops/agent/openclaw-agent.sqlite-shm']:
            self.assertFalse((state/rel).exists(),rel)
        self.assertEqual((state/'agents/main/agent/openclaw-agent.sqlite').read_text(),'agent-2026.8.1')
        self.assertEqual((state/'agents/main/agent/openclaw-agent.sqlite-wal').read_text(),'wal-2026.8.1')
        self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.8.1')

    def test_rollback_prunes_older_recovery_points(self):
        """Each refused attempt writes a point; the rollback keeps only the newest three."""
        root,worker,_=self.core_fixture(9)
        (root/'mirror/config/openclaw-target.txt').write_text('2026.9.1\n')
        base=root/'backups/openclaw-core-update'
        for i in range(3): (base/f'2020010{i+1}T000000Z-2026.7.1-to-2026.8.1').mkdir(parents=True)
        result=self.run_worker(worker,'openclaw_install')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('back as they were',result.stderr)
        names=[p.name for p in self.recovery_points(root)]
        self.assertEqual(len(names),3,names)
        self.assertNotIn('20200101T000000Z-2026.7.1-to-2026.8.1',names)
        self.assertTrue(names[-1].endswith('-2026.8.1-to-2026.9.1'),names)

    def interrupt_core_replacement(self,root,worker):
        """Cut the step short inside a doctor that has half-migrated the state, as a reboot would."""
        (root/'mirror/config/openclaw-target.txt').write_text('2026.9.1\n')
        (root/'doctor-mutates').write_text('')
        (root/'doctor-hangs').write_text('')
        process=subprocess.Popen(['/bin/bash',str(worker),'openclaw_install'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                 text=True,start_new_session=True)
        deadline=time.monotonic()+5
        while 'migrated-by-' not in (root/'.openclaw/agents/main/agent/openclaw-agent.sqlite').read_text():
            if time.monotonic()>deadline:
                os.killpg(process.pid,signal.SIGKILL); process.communicate(timeout=5)
                self.fail('the migration never started')
            time.sleep(0.01)
        os.killpg(process.pid,signal.SIGKILL)
        process.communicate(timeout=5)
        (root/'doctor-hangs').unlink(); (root/'doctor-mutates').unlink()
        # A reboot empties /run: the maintenance guard and its drop-in go with it.
        shutil.rmtree(root/'guard',ignore_errors=True); shutil.rmtree(root/'dropin',ignore_errors=True)
        marker=root/'.openclaw-migration-pending'
        lines=marker.read_text().splitlines()
        self.assertEqual(lines[1:],['2026.8.1','2026.9.1','replacing'])
        self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.9.1')
        return marker,len((root/'events').read_text().splitlines())

    def test_interrupted_migration_is_finished_on_the_next_run(self):
        """The new core at the pin with a pending mark is not 'already installed': its doctor runs again."""
        root,worker,_=self.core_fixture()
        marker,seen=self.interrupt_core_replacement(root,worker)
        result=self.run_worker(worker,'openclaw_install')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('running the migration again',result.stdout)
        self.assertIn('OpenClaw 2026.9.1 completed the interrupted state migration',result.stdout)
        self.assertIn('configuration accepted',result.stdout)
        events=(root/'events').read_text().splitlines()[seen:]
        self.assertIn('doctor-start',events)
        self.assertNotIn('npm-install',events)
        self.assertIn('validate-2026.9.1',events)
        self.assertFalse(marker.exists())
        self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.9.1')
        self.assertEqual(len(self.recovery_points(root)),1)
        self.assertFalse((root/'guard').exists())

    def test_interrupted_migration_the_core_refuses_is_rolled_back_on_the_next_run(self):
        root,worker,_=self.core_fixture()
        marker,seen=self.interrupt_core_replacement(root,worker)
        (root/'core-exit').write_text('9')
        result=self.run_worker(worker,'openclaw_install')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('did not complete the interrupted state migration',result.stderr)
        self.assertIn('back as they were',result.stderr)
        self.assertNotIn('configuration accepted',result.stdout)
        events=(root/'events').read_text().splitlines()[seen:]
        self.assertIn('doctor-start',events)
        self.assertNotIn('validate-2026.9.1',events)
        self.assertIn('system-start',events)
        self.assertFalse(marker.exists())
        self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.8.1')
        state=root/'.openclaw'
        self.assertEqual((state/'agents/main/agent/openclaw-agent.sqlite').read_text(),'agent-2026.8.1')
        self.assertEqual((state/'agents/main/agent/openclaw-agent.sqlite-wal').read_text(),'wal-2026.8.1')
        self.assertFalse((state/'agents/main/agent/openclaw-agent.sqlite-shm').exists())
        self.assertEqual((state/'openclaw.json').read_text(),'{"meta":{"lastTouchedVersion":"2026.8.1"}}')

    def test_interrupted_rollback_is_finished_and_the_retry_replaces_the_core_afresh(self):
        root,worker,_=self.core_fixture()
        marker,seen=self.interrupt_core_replacement(root,worker)
        lines=marker.read_text().splitlines(); lines[3]='rolling-back'
        marker.write_text('\n'.join(lines)+'\n')
        result=self.run_worker(worker,'openclaw_install')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('did not finish; finishing it',result.stdout)
        self.assertIn('back as they were',result.stderr)
        self.assertNotIn('doctor-start',(root/'events').read_text().splitlines()[seen:])
        self.assertFalse(marker.exists())
        self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.8.1')
        self.assertEqual((root/'.openclaw/agents/main/agent/openclaw-agent.sqlite').read_text(),'agent-2026.8.1')
        retry=self.run_worker(worker,'openclaw_install')
        self.assertEqual(retry.returncode,0,retry.stderr)
        self.assertIn('OpenClaw 2026.9.1 installed; configuration accepted',retry.stdout)
        self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.9.1')
        self.assertFalse(marker.exists())

    def test_mark_with_the_previous_core_still_in_place_is_dropped_and_the_update_proceeds(self):
        """A stop before the swap migrated nothing: the state is not touched, the replacement runs."""
        root,worker,_=self.core_fixture()
        (root/'mirror/config/openclaw-target.txt').write_text('2026.9.1\n')
        point=root/'backups/openclaw-core-update/20260101T000000Z-2026.8.1-to-2026.9.1'
        (point/'state/config').mkdir(parents=True)
        (point/'state/config/openclaw.json').write_text('stale')
        (point/'state/snapshot.txt').write_text('config/openclaw.json\n')
        marker=root/'.openclaw-migration-pending'
        marker.write_text(f'{point}\n2026.8.1\n2026.9.1\nreplacing\n')
        result=self.run_worker(worker,'openclaw_install')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('nothing was migrated',result.stdout)
        self.assertIn('OpenClaw 2026.9.1 installed; configuration accepted',result.stdout)
        self.assertEqual((root/'.openclaw/openclaw.json').read_text(),'{"meta":{"lastTouchedVersion":"2026.8.1"}}')
        self.assertIn('npm-install',(root/'events').read_text())
        self.assertFalse(marker.exists())
        self.assertEqual(len(self.recovery_points(root)),2)

    def test_mark_naming_no_recovery_point_stops_the_step(self):
        for case in ['outside','traversal','phase']:
            with self.subTest(case=case):
                root,worker,_=self.core_fixture()
                (root/'mirror/config/openclaw-target.txt').write_text('2026.9.1\n')
                point={'outside':str(root/'elsewhere'),'traversal':str(root/'backups/openclaw-core-update/..')}.get(case,
                       str(root/'backups/openclaw-core-update/20260101T000000Z-2026.8.1-to-2026.9.1'))
                (Path(point)/'state').mkdir(parents=True,exist_ok=True); (Path(point)/'state/snapshot.txt').write_text('')
                marker=root/'.openclaw-migration-pending'
                marker.write_text(f'{point}\n2026.8.1\n2026.9.1\n{"later" if case=="phase" else "replacing"}\n')
                result=self.run_worker(worker,'openclaw_install')
                self.assertNotEqual(result.returncode,0)
                self.assertIn('cannot settle',result.stderr)
                self.assertTrue(marker.exists())
                self.assertNotIn('npm-install',(root/'events').read_text())
                self.assertEqual(self.core_version(root/'lib/node_modules/openclaw'),'2026.8.1')
                self.assertFalse((root/'guard').exists())

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
