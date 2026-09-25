/**
 * The e2e-install suite, split across runners (TASK-1127).
 *
 * One runner ran the whole suite in ~16 min: ~4 min of install.sh, ~2 min for
 * every spec up to 85, and then the in-app upgrade — two full rebuilds, ~6.5
 * min — on the same box. Each shard is its own runner with its own container
 * and its own real install, so the shards run side by side:
 *
 *   core     every spec but the upgrade: install, wizard, every app's happy
 *            path, and the reboot. It runs on EVERY run, so install.sh itself
 *            is exercised on every PR.
 *   upgrade  the setup wizard (the state the upgrade must preserve), then the
 *            in-app upgrade main → the PR head. It runs when the run cannot
 *            prove it has nothing to do with that flow: every scheduled and
 *            dispatched run, and every PR that touches a path in
 *            UPGRADE_PATHS — about one PR in six, measured over the thirty
 *            merged before this change.
 *
 * `CLAWBOX_E2E_SHARD` picks the shard (playwright.config.ts); unset, the
 * config runs every spec on one box in file order, as it always has, which is
 * what a person running the suite locally gets.
 */

export const SHARDS = ["core", "upgrade"] as const;
export type Shard = (typeof SHARDS)[number];

/** The spec only the upgrade shard runs. */
export const UPGRADE_SPEC = "90-upgrade-main-to-beta.spec.ts";

/**
 * What the upgrade spec needs to have run first on its own box: the wizard is
 * what sets `setup_complete`, `wifi_configured` and `password_configured`,
 * the flags it asserts survive the upgrade. It pins `.update-branch` itself.
 */
export const UPGRADE_PREREQUISITES = ["10-setup-wizard.spec.ts"] as const;

/**
 * Paths the upgrade flow depends on, repo-relative. A PR that touches any of
 * them runs the upgrade shard.
 *
 * Generous on purpose: running the shard for nothing costs a runner, while
 * skipping it for something is the coverage this split must not lose. Only the
 * UPGRADE is gated — the install itself runs on every PR in `core`, so
 * install.sh, the systemd units and everything else install.sh reads are
 * covered there regardless; they are listed here because the updater re-runs
 * them (`do_rebuild`, `post_update`) across a restart.
 */
export const UPGRADE_PATHS: readonly RegExp[] = [
  // The installer and everything it copies, runs or installs as root.
  /^install(-x64)?\.sh$/,
  /^(scripts|config)\//,
  // What the rebuild re-resolves and re-builds, and the server that stays up
  // across it.
  /^(package\.json|bun\.lock|package-lock\.json|next\.config\.ts|production-server\.js)$/,
  // The post-restart continuation hook that runs `post_update`.
  /^src\/instrumentation(-node)?\.ts$/,
  // The updater, its lock and branch pin, the root steps it dispatches, the
  // migrations it runs on boot and the setup state it must carry across.
  /^src\/lib\/(updater[^/]*|update-[^/]*|root-step[^/]*|boot-migrations|config-store|version-utils)\.ts$/,
  /^src\/app\/setup-api\/(update|setup|system\/update-branch)\//,
  // The harness itself, and the workflow that runs it.
  /^e2e-install\//,
  /^\.github\/workflows\/e2e-install\.yml$/,
];

export interface ShardPlan {
  shards: Shard[];
  /** The changed paths that brought the upgrade shard in; empty otherwise. */
  because: string[];
}

/**
 * Which shards a run needs. `null` is "the changed files are not known" — a
 * scheduled or dispatched run, or a PR whose file list could not be read —
 * and gets every shard: not knowing is never a reason to skip one.
 */
export function planShards(changed: readonly string[] | null): ShardPlan {
  if (changed === null) return { shards: [...SHARDS], because: [] };
  const because = changed.filter((path) => UPGRADE_PATHS.some((re) => re.test(path)));
  return because.length > 0 ? { shards: [...SHARDS], because } : { shards: ["core"], because: [] };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Matches one spec by file name, against the absolute path Playwright passes. */
const spec = (file: string) => new RegExp(`(^|[\\\\/])${escape(file)}$`);

export interface ShardFilter {
  testMatch: RegExp | RegExp[];
  testIgnore?: RegExp | RegExp[];
}

/**
 * The `testMatch`/`testIgnore` pair for a shard. Unset or empty selects every
 * spec; a name that is not a shard throws, because a typo that silently ran
 * nothing — or everything — is a verdict about the wrong suite.
 */
export function shardFilter(shard: string | undefined): ShardFilter {
  const all = /.*\.spec\.ts$/;
  if (!shard) return { testMatch: all };
  switch (shard as Shard) {
    case "core":
      return { testMatch: all, testIgnore: spec(UPGRADE_SPEC) };
    case "upgrade":
      return { testMatch: [...UPGRADE_PREREQUISITES, UPGRADE_SPEC].map(spec) };
    default:
      throw new Error(`CLAWBOX_E2E_SHARD=${shard} is not a shard; expected one of ${SHARDS.join(", ")}`);
  }
}
