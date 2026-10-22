// What an OpenClaw backup of this box can leave out, as an OpenClaw plugin.
//
// WHAT IT IS FOR. ClawKeep's cloud snapshot is `openclaw backup create` of the
// whole state directory, and that carried the archives the box keeps of itself
// in `<state>/backups/`: older snapshots in every new one, every nightly upload
// longer, and a box near its quota paying for them.
//
// NOT ALL OF backups/ IS AN ARCHIVE. `openclaw doctor` in the pinned 2026.10.3
// core MOVES two kinds of the owner's files there and deletes the originals:
// each agent's TOOLS.md (`backups/tools-md-migration/<agent>-<sha256>.md`,
// doctor-tools-md-migration) and its heartbeat scratch file
// (`backups/heartbeat-migration/`, doctor-heartbeat-scratch-migration). Those
// are the only copies left, so they stay in every snapshot. Nothing else in
// that core writes under `backups/`.
//
// HARNESS FIRST. The core has no exclude flag or config key for `backup
// create`, but its plugin manifest has `backupResources`: a `regenerable`
// entry is left out of the archive and reported in the dry-run's `skipped`
// with reason `regenerable`, and "only an explicit nested `include` protects a
// descendant and keeps its excluded ancestors traversable"
// (docs/plugins/manifest/surfaces.md in the pinned core). So `backups` is
// regenerable and the two doctor folders are `include`. Measured on that core
// with this plugin installed by the boot step: a real archive carries both
// doctor folders and no `backups/nightly/*.tar.gz`, and a state dir without
// the doctor folders backs up the same way. Only paths the pinned core itself
// writes are named: core update downloads and the Codex runtime's own caches
// are not paths the 2026.10.3 package creates, so they are not left out. The
// list is the manifest — this file only has to load.
//
// Deployed like ClawBox's other plugins: copied out of the checkout by
// gateway-pre-start.sh on every boot and enabled in `plugins.entries`, on a
// 2026.10 or later core only (the first with `backupResources`). ClawKeep
// leaves out by itself what a fixed path cannot name: the box's own archive
// files anywhere in the state dir, and temporary trees an unfinished run left
// behind (clawkeep/clawkeep/own_backups.py).

const clawboxBackupScopePlugin = {
  id: "clawbox-backup-scope",
  name: "ClawBox backup scope",
  description: "Tells OpenClaw backups they can leave out the box's own backup archives, keeping what openclaw doctor moved there.",
  register() {},
};

// The loader follows the `default` export and requires `register` to be a
// function; this plugin registers nothing.
export default clawboxBackupScopePlugin;
