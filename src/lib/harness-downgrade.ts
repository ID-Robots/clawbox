/**
 * "Would this switch install an OLDER assistant than the one that wrote this
 * box's data?" — the decision, shared by the updater (`Update now`), the
 * Settings update-branch route and the System Update screen. Pure: every input
 * is read by the caller (src/lib/updater.ts, src/lib/harness-downgrade-server.ts).
 *
 * WHY. A harness migrates its databases forward and never back. A box that ran
 * OpenClaw 2026.10.6 has agent databases on schema 25; OpenClaw 2026.10.3 reads
 * up to 24 and refuses them outright ("newer schema version"), and `doctor --fix`
 * cannot repair a newer schema. Switching such a box to a branch that still pins
 * the older core (beta -> main, or any rollback) used to install that core and
 * stop at its repair step with the gateway left stopped. Hermes is the same in
 * kind: an older release cannot run on a `state.db` a newer gateway runtime has
 * written. The numbers are knowable before anything is touched, so the side that
 * runs the NEW code reads them before it switches.
 *
 * TWO KINDS OF PROOF, and only proof refuses:
 *   - schema — a database on disk is on a newer schema than the target core
 *     declares (`openclaw.schemaVersions` of the published package, kept per pin
 *     in src/lib/updater.ts). Exact: it is the refusal the older core would give.
 *   - version — the target pin is older than the harness installed now, the one
 *     that wrote the data, and that data is on disk. A version this cannot order
 *     (a dist-tag, a prerelease) is not proof, and nothing is refused over it.
 * Everything unknown stands down: a refusal over an unknown strands exactly the
 * box an update repairs.
 *
 * THE OVERRIDE (`allowHarnessDowngrade`) is explicit and documented: it backs the
 * data up first (ClawKeep when the box is paired, else the harness's own backup
 * command) and lets the installer set aside the databases the older core cannot
 * open — see docs-site/technical/update-system.mdx.
 */

export type HarnessName = "openclaw" | "hermes";

/** `UpdateState.errorCode` and the update-branch route's `code` for a refused downgrade. */
export const HARNESS_DOWNGRADE_CODE = "harness_downgrade";
/** `UpdateState.errorCode` when the override's backup could not be taken. */
export const HARNESS_DOWNGRADE_BACKUP_FAILED_CODE = "harness_downgrade_backup_failed";
/** The request-body flag that is the override, on update/run and system/update-branch. */
export const HARNESS_DOWNGRADE_OVERRIDE_FLAG = "allowHarnessDowngrade";

export type HarnessDowngradeErrorCode =
  | typeof HARNESS_DOWNGRADE_CODE
  | typeof HARNESS_DOWNGRADE_BACKUP_FAILED_CODE;

export interface SchemaOnDisk {
  /** Where the database is, said to the owner (a path). */
  label: string;
  version: number;
}

export interface HarnessDowngrade {
  harness: HarnessName;
  /** What is installed now — what wrote the data — when it could be read. */
  installed: string | null;
  /** What the switch would install. */
  target: string;
  /** Hermes: the pinned commit `target` names, which the installer's own guard compares. */
  targetCommit?: string;
  /** Present when the proof is a database on a newer schema than `target` supports. */
  schema?: {
    database: "state" | "agent";
    label: string;
    onDisk: number;
    supported: number;
  };
}

export interface HarnessDowngradeDetail {
  /** The branch the switch goes to, when known. */
  branch: string | null;
  downgrades: HarnessDowngrade[];
  /**
   * Why the override's backup failed: the backup command's (or ClawKeep's) own
   * output, shown as given under the screen's translated sentence — never the
   * English prose around it, which the screen already says in the owner's language.
   */
  backupFailure?: string;
}

export interface OpenclawDowngradeInput {
  /** The pin the switch installs; null when it could not be read. */
  target: string | null;
  /** The core installed now; null when there is none or it could not be read. */
  installed: string | null;
  /** The newest schema on disk per database kind; null for none or unreadable. */
  onDisk: { state: SchemaOnDisk | null; agent: SchemaOnDisk | null };
  /** What `target` declares; null for a pin the table does not know. */
  supported: { state: number | null; agent: number | null };
}

export interface HermesDowngradeInput {
  /** The pin the switch installs: the commit, and the release it is named for. */
  target: { commit: string; version: string | null } | null;
  /** What is checked out now; null when Hermes is not installed. */
  installed: { commit: string | null; version: string | null } | null;
  /** Whether a Hermes `state.db` is on disk — the data an older release cannot run on. */
  hasData: boolean;
  /**
   * `git merge-base --is-ancestor <target> HEAD` in the installed checkout:
   * true when the target commit is behind what is installed, false when it is
   * not, null when that could not be told (a shallow clone, no checkout).
   */
  targetIsAncestor: boolean | null;
}

const VERSION = /^v?(\d+(?:\.\d+)*)(?:-(\d+))?$/;

function versionParts(raw: string | null | undefined): number[] | null {
  const m = VERSION.exec(String(raw ?? "").trim());
  if (!m) return null;
  const parts = m[1].split(".").map(Number);
  // OpenClaw's patch releases are `2026.5.3-1`: after `2026.5.3`, before `2026.5.4`.
  parts.push(m[2] === undefined ? 0 : Number(m[2]));
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/**
 * Order two harness versions (`2026.10.6`, `2026.5.3-1`, `v0.22.4`): negative
 * when `a` is older, 0 when equal, positive when newer — and null when either
 * is not a plain release (a dist-tag, a prerelease), which is not something a
 * refusal may be built on.
 */
export function compareHarnessVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const pa = versionParts(a);
  const pb = versionParts(b);
  if (!pa || !pb) return null;
  // The `-N` patch slot is always last; pad the release part, not the patch.
  const ra = pa.slice(0, -1);
  const rb = pb.slice(0, -1);
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const diff = (ra[i] ?? 0) - (rb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return Math.sign(pa[pa.length - 1] - pb[pb.length - 1]);
}

const HERMES_COMMIT_LINE = /^HERMES_PIN_COMMIT="\$\{HERMES_PIN_COMMIT:-([0-9a-fA-F]{40})\}"/m;
const HERMES_PIN_COMMENT = /^# Current pin: upstream tag (v\d[\w.-]*)(.*)$/m;
const HERMES_RELEASE_NAME = /"Hermes Agent v(\d+(?:\.\d+)+)"/;

/**
 * The Hermes pin in an install.sh's text — `HERMES_PIN_COMMIT`'s default and
 * the release it is named for on the `# Current pin:` line above it (the same
 * lines scripts/harness-pins.mjs reads). The release name wins over the tag:
 * older releases tagged upstream by date (`v2026.9.7 == "Hermes Agent v0.21.1"`),
 * and a date is not a version to order against `hermes --version`.
 */
export function parseHermesPin(installSh: string): { commit: string; version: string | null } | null {
  const commit = HERMES_COMMIT_LINE.exec(installSh)?.[1];
  if (!commit) return null;
  const comment = HERMES_PIN_COMMENT.exec(installSh);
  let version: string | null = null;
  if (comment) {
    version = HERMES_RELEASE_NAME.exec(comment[2])?.[1] ?? null;
    if (!version) {
      const tag = comment[1].replace(/^v/, "");
      // A semver tag names the release; a date tag (major in the thousands) does not.
      if (/^\d+\.\d+(?:\.\d+)*$/.test(tag) && Number(tag.split(".")[0]) < 1000) version = tag;
    }
  }
  return { commit: commit.toLowerCase(), version };
}

function openclawDowngrade(input: OpenclawDowngradeInput): HarnessDowngrade | null {
  const target = input.target?.trim();
  if (!target) return null;
  for (const database of ["state", "agent"] as const) {
    const onDisk = input.onDisk[database];
    const supported = input.supported[database];
    if (onDisk && supported !== null && onDisk.version > supported) {
      return {
        harness: "openclaw",
        installed: input.installed,
        target,
        schema: { database, label: onDisk.label, onDisk: onDisk.version, supported },
      };
    }
  }
  // The version is proof only about data the installed core wrote: with no
  // database on disk (a fresh box, a state dir moved aside) an older core has
  // nothing it could fail to open.
  if (!input.onDisk.state && !input.onDisk.agent) return null;
  const order = compareHarnessVersions(target, input.installed);
  if (order !== null && order < 0) return { harness: "openclaw", installed: input.installed, target };
  return null;
}

const shortCommit = (commit: string) => commit.slice(0, 12);

function hermesDowngrade(input: HermesDowngradeInput): HarnessDowngrade | null {
  const { target, installed } = input;
  if (!target || !installed || !input.hasData) return null;
  if (installed.commit && installed.commit.toLowerCase() === target.commit.toLowerCase()) return null;
  const order = compareHarnessVersions(target.version, installed.version);
  const older = order !== null && order !== 0 ? order < 0 : input.targetIsAncestor === true;
  if (!older) return null;
  return {
    harness: "hermes",
    installed: installed.version ?? (installed.commit ? shortCommit(installed.commit) : null),
    target: target.version ?? shortCommit(target.commit),
    targetCommit: target.commit.toLowerCase(),
  };
}

/** Every harness the switch would move backwards, or an empty list. */
export function assessHarnessDowngrade(input: {
  openclaw?: OpenclawDowngradeInput | null;
  hermes?: HermesDowngradeInput | null;
}): HarnessDowngrade[] {
  const out: HarnessDowngrade[] = [];
  const openclaw = input.openclaw ? openclawDowngrade(input.openclaw) : null;
  if (openclaw) out.push(openclaw);
  const hermes = input.hermes ? hermesDowngrade(input.hermes) : null;
  if (hermes) out.push(hermes);
  return out;
}

export const HARNESS_LABEL: Record<HarnessName, string> = { openclaw: "OpenClaw", hermes: "Hermes Agent" };

/**
 * When the refusal is said, which decides what it can truthfully say happened.
 *   branch         — the Settings update-branch route: the branch was not changed.
 *   before-update  — ahead of step 1: nothing was changed.
 *   before-install — at the `openclaw_install` boundary: the checkout moved, the
 *                    core was not touched.
 */
export type DowngradeMoment = "branch" | "before-update" | "before-install";

function proofSentence(d: HarnessDowngrade, moment: DowngradeMoment): string {
  const name = HARNESS_LABEL[d.harness];
  const switching = moment === "branch" ? "that branch" : "this update";
  if (d.schema) {
    return `This device's ${name} data is newer than the version ${switching} installs. `
      + `${d.schema.label} is on ${d.schema.database} schema ${d.schema.onDisk}, `
      + `and the pinned ${name} ${d.target} supports schema ${d.schema.supported}. `
      + `${name} never downgrades ${d.schema.database === "agent" ? "an" : "a"} ${d.schema.database} schema, `
      + "so installing it would leave the assistant unable to open its own data";
  }
  return `This device runs ${name} ${d.installed ?? "(a newer release)"}, and ${switching} would install the older ${name} ${d.target}. `
    + `An older ${name} cannot open data a newer one has written`;
}

function remedySentence(d: HarnessDowngrade, moment: DowngradeMoment): string {
  const name = HARNESS_LABEL[d.harness];
  const stay = d.schema
    ? `Stay on an update branch whose ${name} supports ${d.schema.database} schema ${d.schema.onDisk} or newer`
    : `Stay on an update branch that installs ${name} ${d.installed ?? "this version"} or newer`;
  const anyway = moment === "branch" ? "Back up and switch anyway" : "Back up and update anyway";
  return `${stay}, or choose "${anyway}", which backs the assistant's data up first and sets aside what the older version cannot open.`;
}

const OUTCOME: Record<DowngradeMoment, string> = {
  branch: "the update branch was not changed.",
  "before-update": "the update was refused before it changed anything.",
  "before-install": "the update stopped before it touched OpenClaw, and the assistant keeps the core it has.",
};

/** The owner-facing sentence, in English (the screen localises from the detail). */
export function harnessDowngradeMessage(detail: HarnessDowngradeDetail, moment: DowngradeMoment): string {
  const [first, ...rest] = detail.downgrades;
  if (!first) return "";
  const lead = moment === "branch" && detail.branch ? `Branch "${detail.branch}" would install an older assistant. ` : "";
  const more = rest.map((d) => `${proofSentence(d, moment)}.`).join(" ");
  return `${lead}${proofSentence(first, moment)} — ${OUTCOME[moment]}${more ? ` ${more}` : ""} ${remedySentence(first, moment)}`;
}

/** Narrow an untrusted payload (a status poll, a route answer) to a detail the screen can render. */
export function readHarnessDowngradeDetail(value: unknown): HarnessDowngradeDetail | null {
  const v = value as Partial<HarnessDowngradeDetail> | null | undefined;
  if (!v || !Array.isArray(v.downgrades)) return null;
  const downgrades = v.downgrades.filter((d): d is HarnessDowngrade =>
    !!d && (d.harness === "openclaw" || d.harness === "hermes") && typeof d.target === "string");
  if (downgrades.length === 0) return null;
  return {
    branch: typeof v.branch === "string" ? v.branch : null,
    downgrades,
    ...(typeof v.backupFailure === "string" ? { backupFailure: v.backupFailure } : {}),
  };
}
