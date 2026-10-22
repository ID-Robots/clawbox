// What an OpenClaw backup of this box can leave out, as an OpenClaw plugin.
//
// WHAT IT IS FOR. ClawKeep's cloud snapshot is `openclaw backup create` of the
// whole state directory, and that carried folders nobody restores: core update
// downloads (`upgrades/`), archives the box keeps of itself (`backups/`) and
// the Codex runtime's caches and logs under every agent's `codex-home/`. They
// make every nightly snapshot bigger and every upload longer, and a box near
// its quota pays for them.
//
// HARNESS FIRST. The core has no exclude flag or config key for `backup
// create`, but its plugin manifest has `backupResources`: a `regenerable`
// entry, scoped to the state directory or to every agent directory, is left
// out of the archive and reported in the dry-run's `skipped` with reason
// `regenerable` (docs/plugins/manifest/surfaces.md; the planner in the pinned
// 2026.10.3 core). Measured on that core: a real archive of a state dir with
// this plugin enabled carries `codex-home/sessions/` and none of the paths in
// openclaw.plugin.json. The list is the manifest — this file only has to load.
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
  description: "Tells OpenClaw backups which state and agent folders can be left out and rebuilt.",
  register() {},
};

// The loader follows the `default` export and requires `register` to be a
// function; this plugin registers nothing.
export default clawboxBackupScopePlugin;
