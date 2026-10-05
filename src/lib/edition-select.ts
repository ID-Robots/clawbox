/**
 * The setup wizard's "Choose your assistant" step on a unified-image box
 * (TASK-1149, reports/clawbox/unified-image-design-2026-09.md §3).
 *
 * Every box can now ship from ONE image carrying both harnesses, with the
 * root-owned lock reading `unselected`. The owner's first-setup choice is handed
 * to the `edition_select` root step through `data/edition-select.env` — the
 * same request file class the harness swap uses, written by the same helper —
 * and that step locks the box to the chosen agent, provisions it, takes the
 * other one off the box and restarts the web server. The result on disk is a
 * plain single-edition box, byte-for-byte what a factory-flashed one has.
 *
 * THE BOUNDARY is the swap's, stated in `harness-swap.ts`: anything running as
 * clawbox can write the request and start the step, so the root side's VALUE
 * gate is what bounds it — and its one extra rule is what keeps this from
 * being a free swap: the step acts only while the recorded lock is literally
 * `unselected` (or finishes an activation that a power cut or a crash left
 * half done, for the SAME agent). Every deployed box has a lock naming
 * openclaw, hermes or dual, so none of them can ever reach it.
 *
 * SERVER ONLY: reads the lock directory, systemctl and the journal.
 */
import { execFile as execFileCb } from "child_process";
import fs from "fs";
import path from "@/lib/runtime-path";
import { promisify } from "util";
import { editionLockDir, readEditionSource, type EditionHint, type EditionName } from "@/lib/edition-source";
import type { Harness } from "@/lib/harness";
import { readEditionRequestFile, writeEditionRequestFile, type SwapRequest } from "@/lib/harness-swap";
import { rootStepJournalArgs, rootStepUnit } from "@/lib/root-step-journal";

const execFile = promisify(execFileCb);

/** The root step, on WEB_ROOT_STEPS and deliberately off UI_ROOT_STEPS. */
export const EDITION_SELECT_STEP = "edition_select";

/**
 * The phases the stream reports, in order. `request` and `done` are the
 * route's own; the four between are the step's `[edition-select] phase=` lines.
 */
export const SELECT_PHASES = ["request", "check", "lock", "provision", "cleanup", "done"] as const;
export type SelectPhase = (typeof SELECT_PHASES)[number];

/**
 * How long the route follows the step: the unit's own TimeoutStartSec, for the
 * reason SWAP_FOLLOW_TIMEOUT_MS gives — systemd owns the kill, never this
 * stream. A normal activation is a few minutes; the long tail is the one where
 * the chosen harness has to be repaired over the network first.
 */
export const SELECT_FOLLOW_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** How much of this run's journal the plain read looks at when `--grep` is not there. */
const SELECT_JOURNAL_SCAN_LINES = 4000;

/** The marker the root step leaves beside the lock while an activation is under way. */
const PENDING_MARKER = "edition-select.pending";
const MARKER_MAX_BYTES = 256;

export function editionSelectRequestPath(): string {
  return path.join(process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox", "data", "edition-select.env");
}

export async function writeEditionSelectRequest(target: Harness, now: number = Date.now()): Promise<void> {
  await writeEditionRequestFile(editionSelectRequestPath(), target, now);
}

export async function readEditionSelectRequest(): Promise<SwapRequest | null> {
  return readEditionRequestFile(editionSelectRequestPath());
}

/** Best effort: a file that is already gone is the outcome wanted. */
export async function removeEditionSelectRequest(): Promise<void> {
  await fs.promises.rm(editionSelectRequestPath(), { force: true }).catch(() => {});
}

/**
 * The agent an unfinished activation already locked the box to, or null.
 *
 * `install.sh --step edition_select` writes `/etc/clawbox/edition-select.pending`
 * (root-owned, beside the lock) just before it flips the lock and removes it
 * once the chosen agent is provisioned. A marker still there means the step
 * was cut short after the lock changed — a power cut, a crash, a provisioning
 * failure — and the wizard has to finish the job rather than skip ahead to a
 * box with no working agent. Read through one O_NOFOLLOW descriptor, like the
 * lock itself.
 */
export function readSelectPending(): Harness | null {
  let fd: number;
  try {
    fd = fs.openSync(
      /* turbopackIgnore: true */ path.join(editionLockDir(), PENDING_MARKER),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MARKER_MAX_BYTES) return null;
    const target = /^TARGET_EDITION=(.*)$/m.exec(fs.readFileSync(fd, "utf-8"))?.[1]?.trim();
    return target === "openclaw" || target === "hermes" ? target : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export interface EditionChoice {
  /** True while the wizard must show the step: no agent chosen, or one chosen but not finished. */
  needed: boolean;
  /** The lock reads `unselected`. */
  unselected: boolean;
  /** The agent a cut-short activation locked the box to; the step can only finish THAT one. */
  pending: Harness | null;
  /** The locked edition once there is one; null while unselected or when nothing names it. */
  edition: EditionName | null;
  /** The agent the box was prepared for, preselected by the wizard. Never binding. */
  hint: EditionHint | null;
}

/**
 * Where this box stands on the choice, from the root-owned records alone.
 *
 * A pending marker counts only when the lock names that same agent: a marker
 * left beside a lock that says something else is debris, not an instruction,
 * and a box whose owner finished setup long ago must never be put back in front
 * of the step by one.
 */
export function readEditionChoice(): EditionChoice {
  const source = readEditionSource();
  if (source.unselected) {
    return { needed: true, unselected: true, pending: null, edition: null, hint: source.hint ?? null };
  }
  const edition = source.defaulted ? null : source.edition;
  const marker = edition === "openclaw" || edition === "hermes" ? readSelectPending() : null;
  const pending = marker !== null && marker === edition ? marker : null;
  return { needed: pending !== null, unselected: false, pending, edition, hint: null };
}

// ── One activation at a time ─────────────────────────────────────────────────

/** The target this process is activating, while it is. */
let claimed: Harness | null = null;

/**
 * Is `clawbox-root-update@edition_select.service` running? Tri-state, for the
 * reason `harnessSwapUnitActive` is: "systemd could not be asked" is not
 * "nothing is running", so every decision that would ACT on inactive treats
 * null as maybe-running.
 */
export async function editionSelectUnitActive(): Promise<boolean | null> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/systemctl",
      ["show", rootStepUnit(EDITION_SELECT_STEP), "-p", "ActiveState"],
      { timeout: 15_000 },
    );
    const state = /^ActiveState=(.*)$/m.exec(stdout)?.[1]?.trim();
    if (!state) return null;
    return state === "activating" || state === "active" || state === "reloading";
  } catch {
    return null;
  }
}

export type UnitProbe = () => Promise<boolean | null>;

export interface SelectProgress {
  inProgress: boolean;
  target: Harness | null;
  /** True when systemd could not be asked and `inProgress` is a guess. */
  unknown?: true;
}

/** This process's claim first, else the unit's own state with the request file's target. */
export async function selectInProgress(unitActive: UnitProbe = editionSelectUnitActive): Promise<SelectProgress> {
  if (claimed) return { inProgress: true, target: claimed };
  const active = await unitActive();
  if (active === null) return { inProgress: false, target: null, unknown: true };
  if (!active) return { inProgress: false, target: null };
  return { inProgress: true, target: (await readEditionSelectRequest())?.target ?? null };
}

export type SelectClaim = "claimed" | "busy" | "unknown";

/** Take the one in-flight slot — set before the await, so two racing POSTs cannot both pass. */
export async function claimEditionSelect(
  target: Harness,
  unitActive: UnitProbe = editionSelectUnitActive,
): Promise<SelectClaim> {
  if (claimed) return "busy";
  claimed = target;
  const active = await unitActive();
  if (active !== false) {
    claimed = null;
    return active ? "busy" : "unknown";
  }
  return "claimed";
}

export function releaseEditionSelect(): void {
  claimed = null;
}

/** Test seam: forget the claim. */
export function _resetEditionSelectForTests(): void {
  claimed = null;
}

// ── The journal's phase markers ──────────────────────────────────────────────

const PHASE_LINE = /^\[edition-select\] phase=([a-z]+)$/;
const PHASE_GREP = "^\\[edition-select\\] phase=";

/** `[edition-select] phase=<name>` → the phase; null for any other line, near misses included. */
export function parseSelectPhase(line: string): SelectPhase | null {
  const name = PHASE_LINE.exec(line.trim())?.[1];
  return name && (SELECT_PHASES as readonly string[]).includes(name) ? (name as SelectPhase) : null;
}

/**
 * The newest phase marker THIS dispatch of the step wrote, or null.
 *
 * The follow forwards only the last journal line per poll, and the step prints
 * each marker with a sub-step's output right behind it, so the marker is
 * rarely the line anyone sees. Bounded by `sinceMs` through the one shared
 * definition of "this run's journal" (root-step-journal.ts), so an earlier
 * attempt's `phase=cleanup` can never count as this one's.
 */
export async function latestSelectPhase(sinceMs: number): Promise<SelectPhase | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFile(
      "/usr/bin/journalctl",
      [...rootStepJournalArgs(EDITION_SELECT_STEP, { sinceMs, lines: SELECT_PHASES.length * 2 }), "-g", PHASE_GREP],
      { timeout: 10_000 },
    ));
  } catch {
    try {
      ({ stdout } = await execFile(
        "/usr/bin/journalctl",
        rootStepJournalArgs(EDITION_SELECT_STEP, { sinceMs, lines: SELECT_JOURNAL_SCAN_LINES }),
        { timeout: 10_000 },
      ));
    } catch {
      return null;
    }
  }
  let newest: SelectPhase | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const phase = parseSelectPhase(line);
    if (phase) newest = phase;
  }
  return newest;
}

export interface SelectPhaseFollower {
  /** A journal line from the follow: the phase it named, or null for a plain line. */
  onLine(line: string): SelectPhase | null;
  /** Resolves once every scan a line started has finished. */
  settled(): Promise<void>;
}

/** The phases the ROUTE says itself: `request` before the step, `done` after the lock is checked. */
const ROUTE_PHASES: readonly SelectPhase[] = ["request", "done"];

/**
 * Turn the follow's lines into forward-only phase announcements — the swap's
 * follower, keyed on this step's marker and on the dispatch time instead of an
 * invocation id. A marker on the line itself advances at once; any other line
 * asks the journal, one scan at a time and in order. Skipped phases are
 * announced too, so the progress list never has a gap.
 */
export function selectPhaseFollower(
  emitPhase: (phase: SelectPhase) => void,
  sinceMs: number,
  latest: (sinceMs: number) => Promise<SelectPhase | null> = latestSelectPhase,
): SelectPhaseFollower {
  let reached = SELECT_PHASES.indexOf("request");
  let chain: Promise<void> = Promise.resolve();

  const advanceTo = (phase: SelectPhase) => {
    const index = SELECT_PHASES.indexOf(phase);
    for (let i = reached + 1; i <= index; i += 1) {
      if (!ROUTE_PHASES.includes(SELECT_PHASES[i])) emitPhase(SELECT_PHASES[i]);
    }
    if (index > reached) reached = index;
  };

  return {
    onLine(line) {
      const phase = parseSelectPhase(line);
      if (phase) {
        advanceTo(phase);
        return phase;
      }
      chain = chain
        .then(async () => {
          const newest = await latest(sinceMs);
          if (newest) advanceTo(newest);
        })
        .catch(() => {});
      return null;
    },
    settled: () => chain,
  };
}

/**
 * When this server process started, for the wizard to tell "the box restarted
 * the web server" from "the same server answered again". The step ends by
 * restarting clawbox-setup so the boot-time readers (the MCP registration, the
 * Hermes plugin watcher) come up for the chosen agent; the page reloads once
 * it sees a new value here.
 */
export function serverStartedAt(): number {
  return Math.round(performance.timeOrigin);
}
