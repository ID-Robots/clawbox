/**
 * The harness SWAP: a locked single-edition box re-baked as the other edition
 * (OpenClaw ↔ Hermes) through the `harness_swap` root step. Owner's ask,
 * 2026-09-07: a button on Settings → Harness with both logos.
 *
 * This is NOT `/setup-api/harness/select`. That route is the RUNTIME switch of
 * a licensed `dual` box, where both harnesses are installed and the lock is
 * open; a single-edition box has one harness installed and a root-owned lock
 * naming it, so changing it means installing the other harness, re-baking the
 * lock and re-provisioning the units — install.sh's own steps, run as root.
 * The route hands the step ONE fact through `data/harness-swap.env` and
 * follows its journal; everything the step cannot do as root — the ClawBox AI
 * sign-in and the Telegram bot, which are per-harness credentials written
 * through each harness's own CLI — is carried over here afterwards.
 *
 * THE BOUNDARY, stated the way `set_timezone` states its own: the capability is
 * granted to the `clawbox` ACCOUNT, not to this route. Anything running as
 * clawbox can write the request file and start the step; what bounds it is the
 * VALUE gate on the root side (`read_configured_harness_swap`: plain file only,
 * two exact edition names, a timestamp inside an hour). The worst outcome is a
 * swap the owner did not ask for — loud (the desktop reloads onto the other
 * harness) and reversible (the same button swaps back).
 *
 * SERVER ONLY: reads /proc, statfs, systemctl and the harness CLIs.
 */
import { execFile as execFileCb } from "child_process";
import { randomUUID } from "crypto";
import fs, { constants, type FileHandle } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { readClawaiEntitlementTier } from "@/lib/clawai-plan-tier";
import {
  CLAWBOX_AI_DEFAULT_TIER,
  CLAWBOX_AI_PROVIDER,
  normalizeClawboxAiTier,
} from "@/lib/clawbox-ai-models";
import { CLAWAI_TIER_INFO, type ClawaiTier } from "@/lib/clawbox-ai-tiers";
import { CONFIG_ROOT, DATA_DIR, get } from "@/lib/config-store";
import type { EditionSource } from "@/lib/edition-source";
import { HARNESSES, type Harness } from "@/lib/harness";
import { applyClawaiToHermes } from "@/lib/hermes-clawai";
import { ensureHermesGateway, setHermesTelegramToken } from "@/lib/hermes-telegram";
import { memAvailableMb } from "@/lib/mem-available";
import { findOpenclawBin, readConfig, restartGateway, setTelegramToken } from "@/lib/openclaw-config";
import { freeBytes } from "@/lib/project-import";
import { rootStepUnit } from "@/lib/root-step-follow";
import { isUpdateLocked } from "@/lib/update-lock";

const execFile = promisify(execFileCb);

/** The root step, on WEB_ROOT_STEPS and deliberately off UI_ROOT_STEPS. */
export const HARNESS_SWAP_STEP = "harness_swap";

/**
 * Whether the swap is gated on the coming Business plan.
 *
 * `false` for now, at the owner's ruling (2026-09-07): the Harness card SHOWS
 * the current plan and the upgrade offer, and lets every plan swap. The
 * follow-up PR flips this to `true` once the portal reports a business plan —
 * and teaches `planIsBusiness` below to recognise it; nothing else has to move.
 */
export const HARNESS_SWAP_BUSINESS_PLAN_REQUIRED = false;

/** The phases the stream reports, in the order a swap passes through them. */
export const SWAP_PHASES = ["request", "install", "lock", "provision", "carry", "done"] as const;
export type SwapPhase = (typeof SWAP_PHASES)[number];

/** A Hermes install is a few hundred MB of wheels plus the model caches; 3 GiB keeps the update build alive beside it. */
export const SWAP_MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024;
/** The installer's pip resolves in memory; under this the Orin swaps itself to a crawl. */
export const SWAP_MIN_AVAILABLE_MB = 1500;
/** Where the pinned Hermes installer is fetched from — the one download the step cannot do without. */
export const SWAP_INSTALL_ORIGIN = "https://raw.githubusercontent.com/";
/**
 * Where `npm install -g openclaw@<pin>` fetches the core from. A Hermes-SKU
 * box never had it (`step_openclaw_install` returns early on that edition),
 * so its way back is a download too — and offline that failed minutes into
 * the step instead of at the door the way the Hermes direction does.
 */
export const SWAP_NPM_ORIGIN = "https://registry.npmjs.org/";
export const SWAP_ONLINE_TIMEOUT_MS = 8_000;
/**
 * How long the route follows the step: NOT below the unit's own
 * TimeoutStartSec (config/clawbox-root-update@.service, 2 h), so systemd owns
 * the kill and never this stream — the rule the voice install keeps. At 45
 * minutes the follow gave up on a slow Hermes install, deleted the request
 * and told the owner the swap had failed while the unit went on to flip the
 * lock with nobody carrying the credentials over.
 */
export const SWAP_FOLLOW_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** How much of the invocation's journal the plain read looks at when `--grep` is not there. */
const SWAP_JOURNAL_SCAN_LINES = 4000;

/**
 * The carry-over facts a person must know, as the stream's closing `notes`.
 * Facts about what HAPPENED, never a promise: a credential the writer refused
 * is reported as one to enter again, not as carried.
 */
export const SWAP_NOTES = {
  clawaiCarried: "ClawBox AI sign-in carried over",
  clawaiSignIn: "Sign in to ClawBox AI again in Settings → Providers",
  telegramApprovals: "Telegram approvals are per harness — approve your account again",
  telegramPending:
    "The Telegram bot token is saved, but the gateway has not confirmed it yet — check Settings → Channels",
  telegramNotCarried:
    "The Telegram bot token could not be carried over — enter it again in Settings → Channels",
  identityNotSynced:
    "The agent's persona could not be refreshed for OpenClaw — it keeps what its workspace already had",
} as const;

// ── Which way, and for whom ──────────────────────────────────────────────────

/**
 * The OTHER single edition, or null when there is nothing to swap to.
 *
 * `dual` has both harnesses and the runtime switcher, so a swap would only
 * take one of them away; an edition nobody named (`defaulted`) is a guess, and
 * a root step re-baking the lock on a guess could brand a Hermes box with a
 * missing lock file as OpenClaw for good.
 */
export function swapTargetFor(source: EditionSource): Harness | null {
  if (source.defaulted) return null;
  if (source.edition === "openclaw") return "hermes";
  if (source.edition === "hermes") return "openclaw";
  return null;
}

export interface SwapPlan {
  /** The plan the portal reported for this box's ClawBox AI account; null when there is none on record. */
  tier: ClawaiTier | null;
  /** The catalogue key the card names the plan with (`ai.planNameFree/Pro/Max`). */
  planNameKey: string;
}

/**
 * The current ClawBox AI plan, as the Harness card shows it beside the button.
 *
 * `readClawaiEntitlementTier` is the ONE reader of the plan/badge pair — the
 * plan when the portal has said one, the device badge until then — so the
 * card cannot disagree with the Providers page about what the box is on. A
 * store that cannot be read is "no plan on record", which the card words as
 * the Free plan the way `deviceTierToUiTier` does for an absent badge.
 */
export async function readSwapPlan(): Promise<SwapPlan> {
  let tier: ClawaiTier | null = null;
  try {
    tier = await readClawaiEntitlementTier();
  } catch {
    tier = null;
  }
  return { tier, planNameKey: CLAWAI_TIER_INFO[tier ?? "free"].planNameKey };
}

/**
 * Is this plan the Business plan? There is no such tier yet, so nothing is;
 * the follow-up PR that flips {@link HARNESS_SWAP_BUSINESS_PLAN_REQUIRED} maps
 * the new tier here and nowhere else.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function planIsBusiness(_plan: SwapPlan): boolean {
  return false;
}

/** The gate as a pure function of the switch, so the flipped case is testable today. */
export function swapAllowedFor(plan: SwapPlan, businessPlanRequired: boolean): boolean {
  return !businessPlanRequired || planIsBusiness(plan);
}

export function swapAllowed(plan: SwapPlan): boolean {
  return swapAllowedFor(plan, HARNESS_SWAP_BUSINESS_PLAN_REQUIRED);
}

// ── The request file ─────────────────────────────────────────────────────────

export function swapRequestPath(): string {
  return path.join(process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox", "data", "harness-swap.env");
}

/**
 * Hand the root step its one fact: `TARGET_EDITION=<harness>` and when it was
 * asked for.
 *
 * PARSED by install.sh, never sourced — data/ is clawbox-writable and the step
 * runs as root, so a `.` on this file would be root code execution for
 * anything that already runs as clawbox. WRITTEN TO A TEMP AND RENAMED, `wx`,
 * mode 0600, unique temp name: the same actor can replace the path with a
 * symlink (writeFile would follow it and truncate the target) or a FIFO (open
 * blocks for ever, with no timeout on a route handler), and `rename` replaces
 * the node without opening it. The timezone route spells the full reasoning;
 * this is the same shape for the same file class.
 *
 * `REQUESTED_AT` is what lets the root reader refuse a request older than an
 * hour: a file left behind by a swap nobody followed to the end must not be a
 * standing instruction to the next root step that happens to start.
 */
/** The request is two short lines; a bigger file is not one this box wrote. */
const SWAP_REQUEST_MAX_BYTES = 256;

export async function writeSwapRequest(target: Harness, now: number = Date.now()): Promise<void> {
  const envPath = swapRequestPath();
  const tmpPath = path.join(path.dirname(envPath), `.${path.basename(envPath)}.${randomUUID()}.tmp`);
  try {
    await fs.mkdir(path.dirname(envPath), { recursive: true });
    await fs.writeFile(
      tmpPath,
      `TARGET_EDITION=${target}\nREQUESTED_AT=${Math.floor(now / 1000)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await fs.rename(tmpPath, envPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export interface SwapRequest {
  target: Harness;
  /** Unix seconds, as written. */
  requestedAt: number;
}

/**
 * The request on disk, or null — for GET's `inProgressTarget` when the unit is
 * active and this process holds no claim (a web server restarted under a swap,
 * or a step started from a root shell). The same gates as the root reader,
 * so the route never reports a target the step would refuse.
 */
export async function readSwapRequest(): Promise<SwapRequest | null> {
  const envPath = swapRequestPath();
  // One O_NOFOLLOW handle, judged and read through the same descriptor: a
  // path-level stat followed by readFile lets the file be swapped for a link
  // between the two calls (CodeQL js/file-system-race) — the root reader
  // refuses a link the same way, so the two can never disagree about it.
  let handle: FileHandle;
  try {
    handle = await fs.open(envPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > SWAP_REQUEST_MAX_BYTES) return null;
    const raw = (await handle.readFile("utf8")) as string;
    const target = /^TARGET_EDITION=(.*)$/m.exec(raw)?.[1]?.trim();
    const at = /^REQUESTED_AT=(.*)$/m.exec(raw)?.[1]?.trim();
    if (target !== "openclaw" && target !== "hermes") return null;
    if (!at || !/^\d+$/.test(at)) return null;
    return { target, requestedAt: Number(at) };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Best effort: a file that is already gone is the outcome wanted. */
export async function removeSwapRequest(): Promise<void> {
  await fs.rm(swapRequestPath(), { force: true }).catch(() => {});
}

// ── The journal's phase markers ──────────────────────────────────────────────

const PHASE_LINE = /^\[harness-swap\] phase=([a-z]+)$/;

/**
 * `[harness-swap] phase=<name>` → the phase, or null for any other line. Exact:
 * the step prints one such line per phase and nothing else in that shape, so a
 * near miss is a status line to forward, never a phase to guess at.
 */
export function parseSwapPhase(line: string): SwapPhase | null {
  const name = PHASE_LINE.exec(line.trim())?.[1];
  return name && (SWAP_PHASES as readonly string[]).includes(name) ? (name as SwapPhase) : null;
}

/**
 * The current invocation of the swap unit, or null while it has none.
 *
 * `journalctl -u` sees EVERY run of the unit, and an earlier swap's
 * `phase=done` must never count as this one's; the invocation id is the one
 * key that names exactly this activation. Systemd clears it when the unit
 * stops, so it is read while the follow is under way and kept from then on.
 */
export async function readSwapInvocationId(): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/systemctl",
      ["show", rootStepUnit(HARNESS_SWAP_STEP), "-p", "InvocationID"],
      { timeout: 15_000 },
    );
    const id = /^InvocationID=(.*)$/m.exec(stdout)?.[1]?.trim() ?? "";
    return /^[0-9a-f]{8,}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The `--grep` that hands back the marker lines alone, bounded by their own count. */
const PHASE_GREP = "^\\[harness-swap\\] phase=";

/**
 * The newest `[harness-swap] phase=` marker in the invocation's journal, or
 * null when it has none yet.
 *
 * The follow forwards only the LAST journal line every poll, and install.sh
 * prints each marker with the sub-step's own line right behind it — so the
 * marker is never the last line by the time anyone looks, and a route that
 * parsed `onStatus` alone drew `request` for the length of a ten-minute
 * install and then jumped to `carry`. Asked with `--grep` so the answer is a
 * handful of lines however long the install's output; a journalctl built
 * without pattern matching gets a bounded plain read instead, and one that
 * cannot answer at all is no phase rather than an exception in the stream.
 */
export async function latestSwapPhase(invocationId: string): Promise<SwapPhase | null> {
  const match = `_SYSTEMD_INVOCATION_ID=${invocationId}`;
  let stdout: string;
  try {
    ({ stdout } = await execFile(
      "/usr/bin/journalctl",
      [match, "-o", "cat", "--no-pager", "-g", PHASE_GREP, "-n", String(SWAP_PHASES.length * 2)],
      { timeout: 10_000 },
    ));
  } catch {
    try {
      ({ stdout } = await execFile(
        "/usr/bin/journalctl",
        [match, "-o", "cat", "--no-pager", "-n", String(SWAP_JOURNAL_SCAN_LINES)],
        { timeout: 10_000 },
      ));
    } catch {
      return null;
    }
  }
  let newest: SwapPhase | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const phase = parseSwapPhase(line);
    if (phase) newest = phase;
  }
  return newest;
}

export interface SwapPhaseFollower {
  /** A journal line from the follow: the phase it named, or null for a plain line. */
  onLine(line: string): SwapPhase | null;
  /** Resolves once every scan a line started has finished — before the route speaks after the follow. */
  settled(): Promise<void>;
}

/** The two phases the ROUTE announces itself, after the step: never from the journal. */
const ROUTE_PHASES: readonly SwapPhase[] = ["carry", "done"];

/**
 * Turn the follow's lines into forward-only phase announcements.
 *
 * A marker on the line itself advances at once; any other line asks the
 * journal, one scan at a time and in order, because two scans racing would
 * announce phases out of order. A phase the scan skipped over is announced
 * too, so the modal's list is never missing a step; a phase already announced
 * or behind the newest is not repeated. `carry` and `done` are the route's to
 * say once the step has ended — the step's own `done` is the end of the root
 * step, not of the swap.
 */
export function swapPhaseFollower(
  emitPhase: (phase: SwapPhase) => void,
  deps: { invocationId: () => Promise<string | null>; latest: (id: string) => Promise<SwapPhase | null> } = {
    invocationId: readSwapInvocationId,
    latest: latestSwapPhase,
  },
): SwapPhaseFollower {
  // `request` is announced before the follow starts, so the list begins there.
  let reached = SWAP_PHASES.indexOf("request");
  let invocationId: string | null = null;
  let chain: Promise<void> = Promise.resolve();

  const advanceTo = (phase: SwapPhase) => {
    const index = SWAP_PHASES.indexOf(phase);
    for (let i = reached + 1; i <= index; i += 1) {
      if (!ROUTE_PHASES.includes(SWAP_PHASES[i])) emitPhase(SWAP_PHASES[i]);
    }
    if (index > reached) reached = index;
  };

  return {
    onLine(line) {
      const phase = parseSwapPhase(line);
      if (phase) {
        advanceTo(phase);
        return phase;
      }
      chain = chain
        .then(async () => {
          if (!invocationId) invocationId = await deps.invocationId();
          if (!invocationId) return;
          const newest = await deps.latest(invocationId);
          if (newest) advanceTo(newest);
        })
        // A scan that failed is one poll's worth of nothing; the next line
        // asks again, and a rejected chain would refuse every scan after it.
        .catch(() => {});
      return null;
    },
    settled: () => chain,
  };
}

/** The sentence the progress view shows for a phase, naming the harness by its label. */
export function swapPhaseStatus(phase: SwapPhase, target: Harness): string {
  const name = HARNESSES[target].label;
  switch (phase) {
    case "request":
      return `Swap to ${name} requested — starting the root step.`;
    case "install":
      return `Installing ${name}…`;
    case "lock":
      return `Re-baking the edition lock for ${name}…`;
    case "provision":
      return `Provisioning ${name} — units, identity, dashboard…`;
    case "carry":
      return "Carrying over ClawBox AI and the Telegram bot…";
    case "done":
      return `The ${name} edition is in place.`;
  }
}

// ── One swap at a time ───────────────────────────────────────────────────────

/** The target this process is swapping to, while it is. */
let claimed: Harness | null = null;

/**
 * Is `clawbox-root-update@harness_swap.service` running right now? Asked of
 * systemd the way `followRootStep` asks, because the module flag above knows
 * only about THIS process: a web server restarted under a swap, or a step
 * started from a root shell, is invisible to it.
 *
 * Tri-state: `null` when systemd could not be asked (a timeout, a missing
 * binary, an answer with no ActiveState). "Could not look" is not "nothing is
 * running" — read as false it let a second swap start over a live one and
 * let the route delete the request the step was still reading — so every
 * decision that would ACT on "inactive" treats null as "maybe running", and
 * only the reporting GET says it plainly.
 */
export type UnitProbe = () => Promise<boolean | null>;

export async function harnessSwapUnitActive(): Promise<boolean | null> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/systemctl",
      ["show", rootStepUnit(HARNESS_SWAP_STEP), "-p", "ActiveState"],
      { timeout: 15_000 },
    );
    const state = /^ActiveState=(.*)$/m.exec(stdout)?.[1]?.trim();
    if (!state) return null;
    return state === "activating" || state === "active" || state === "reloading";
  } catch {
    return null;
  }
}

export interface SwapProgress {
  inProgress: boolean;
  target: Harness | null;
  /** True when systemd could not be asked and `inProgress` is a guess, not a fact. */
  unknown?: true;
}

/** What GET reports: this process's claim first, else the unit's own state with the request file's target. */
export async function swapInProgress(unitActive: UnitProbe = harnessSwapUnitActive): Promise<SwapProgress> {
  if (claimed) return { inProgress: true, target: claimed };
  const active = await unitActive();
  if (active === null) return { inProgress: false, target: null, unknown: true };
  if (!active) return { inProgress: false, target: null };
  return { inProgress: true, target: (await readSwapRequest())?.target ?? null };
}

/**
 * Take the one in-flight slot, or say it is taken.
 *
 * The flag is set BEFORE the await, so two POSTs racing through the same tick
 * cannot both pass: the second sees the first's claim synchronously. The unit
 * probe comes after, and a unit already running releases the claim again —
 * that swap belongs to whoever started it, and its end is theirs to follow.
 */
export type SwapClaim = "claimed" | "busy" | "unknown";

export async function claimSwap(
  target: Harness,
  unitActive: UnitProbe = harnessSwapUnitActive,
): Promise<SwapClaim> {
  if (claimed) return "busy";
  claimed = target;
  const active = await unitActive();
  if (active !== false) {
    // Running, or systemd could not say: neither is a slot to hand out.
    claimed = null;
    return active ? "busy" : "unknown";
  }
  return "claimed";
}

export function releaseSwap(): void {
  claimed = null;
}

/** Test seam: forget the claim. */
export function _resetHarnessSwapForTests(): void {
  claimed = null;
}

// ── Preflight ────────────────────────────────────────────────────────────────

export interface SwapRefusal {
  status: number;
  code: string;
  error: string;
}

/** The facts the preflight reads, injectable so the rules can be tested without the box. */
export interface SwapProbes {
  /** Does an in-app update own the box right now — `isUpdateLocked()`. */
  updateLocked(): Promise<boolean>;
  /** Live coding runs — `getCodingAgentStatus().running`. */
  codingRuns(): Promise<number>;
  /** Can the box reach `origin` at all? Any HTTP answer counts. */
  online(origin: string): Promise<boolean>;
  /** Is the OpenClaw core on this box, so a swap back installs nothing? */
  openclawInstalled(): Promise<boolean>;
  /** Bytes free on the filesystem `dir` sits on; null when the disk will not say. */
  freeBytes(dir: string): Promise<number | null>;
  /** MemAvailable in MB; null where /proc/meminfo cannot be read. */
  memAvailableMb(): Promise<number | null>;
}

const defaultProbes: SwapProbes = {
  updateLocked: isUpdateLocked,
  codingRuns: async () => {
    // IMPORTED LAZILY, the move the configure route documents for the same
    // module: `coding-agent` captures its stores at evaluation and drags the
    // app proxy, git and the browser sessions in behind it — a graph the GET
    // that the Harness card polls should not pay for.
    const { getCodingAgentStatus } = await import("@/lib/coding-agent");
    return (await getCodingAgentStatus()).running;
  },
  online: async (origin) => {
    try {
      const res = await fetch(origin, {
        method: "HEAD",
        cache: "no-store",
        signal: AbortSignal.timeout(SWAP_ONLINE_TIMEOUT_MS),
      });
      // A 4xx from the origin is still the origin answering; only a failure to
      // connect says the installer cannot be fetched.
      res.body?.cancel();
      return true;
    } catch {
      return false;
    }
  },
  // The config module's finder answers an absolute path for a binary it found
  // on disk and the bare name — a PATH lookup for the shell — when there is
  // none: that bare name is what a Hermes-SKU box gets.
  openclawInstalled: async () => path.isAbsolute(findOpenclawBin()),
  freeBytes,
  memAvailableMb,
};

/**
 * Why this box may NOT swap right now — or null when it may.
 *
 * Ordered cheapest first: the update lock is one config read and names the
 * worse race — an update's `git reset --hard` and rebuild run over the same
 * checkout and root-exec mirror the step re-execs install.sh from. The
 * network probe (up to 8 s) runs only when the step will DOWNLOAD: always for
 * Hermes, and for OpenClaw only where the core is absent. A probe that cannot
 * answer (null free space, null MemAvailable, a runs store that would not
 * read, a lock that would not) is no evidence either way and does not refuse
 * — the same rule the upload route keeps for a statfs that fails — because
 * refusing every swap on a dev box with no /proc/meminfo would be the wrong
 * bug to ship.
 */
export async function preflightSwap(target: Harness, probes: Partial<SwapProbes> = {}): Promise<SwapRefusal | null> {
  const p: SwapProbes = { ...defaultProbes, ...probes };

  let updating = false;
  try {
    updating = await p.updateLocked();
  } catch {
    updating = false;
  }
  if (updating) {
    return {
      status: 409,
      code: "update_in_progress",
      error: "An update owns this box right now. Wait for it to finish before changing the harness.",
    };
  }

  let runs = 0;
  try {
    runs = await p.codingRuns();
  } catch {
    runs = 0;
  }
  if (runs > 0) {
    return {
      status: 409,
      code: "coding_run_live",
      error: "A coding run is working on this box. Wait for it to finish, or stop it, before changing the harness.",
    };
  }

  const download = target === "hermes"
    ? { origin: SWAP_INSTALL_ORIGIN, what: "Hermes" }
    : (await p.openclawInstalled()) ? null : { origin: SWAP_NPM_ORIGIN, what: "OpenClaw" };
  if (download && !(await p.online(download.origin))) {
    return {
      status: 412,
      code: "offline",
      error: `This box cannot reach the internet, and ${download.what} has to be downloaded to install it.`,
    };
  }

  const free = await p.freeBytes(DATA_DIR);
  if (free !== null && free < SWAP_MIN_FREE_BYTES) {
    const gib = (free / (1024 * 1024 * 1024)).toFixed(1);
    return {
      status: 412,
      code: "disk",
      error: `Not enough disk space for the swap: ${gib} GiB free, 3 GiB needed.`,
    };
  }

  const mem = await p.memAvailableMb();
  if (mem !== null && mem < SWAP_MIN_AVAILABLE_MB) {
    return {
      status: 412,
      code: "memory",
      error: `Not enough free memory for the swap: ${mem} MB available, ${SWAP_MIN_AVAILABLE_MB} MB needed. Close what is running and try again.`,
    };
  }

  return null;
}

// ── The carry-over ───────────────────────────────────────────────────────────

export type SwapEmit = (status: string) => void;

/** Whatever a writer said, with the credentials it may have echoed blanked out. */
function withoutSecrets(message: string, secrets: readonly string[]): string {
  let text = message;
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text;
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

/**
 * Move the per-harness credentials the root step cannot: the ClawBox AI
 * sign-in and the Telegram bot, each into the TARGET harness's own store
 * through the writer that harness's Settings page already uses.
 *
 * NON-FATAL, EVERY LEG. By the time this runs the box IS the target edition —
 * the lock is re-baked and the units are up — so a writer that refuses must
 * not turn a landed swap into an error; it becomes a note telling the owner
 * what to enter again. And never a faked success: a credential is reported
 * as carried only when the writer returned, and on OpenClaw only when
 * openclaw.json actually carries the provider afterwards.
 *
 * Pairing and allowlists stay per harness on purpose (the note says so): a
 * sender the owner approved on one harness's bot has not been approved on the
 * other's.
 */
export async function carryOverAfterSwap(target: Harness, emit: SwapEmit): Promise<string[]> {
  const notes: string[] = [];
  const name = HARNESSES[target].label;

  let token = "";
  let tierRaw: unknown;
  let botToken = "";
  try {
    const [t, tier, bot] = await Promise.all([get("clawai_token"), get("clawai_tier"), get("telegram_bot_token")]);
    token = typeof t === "string" ? t.trim() : "";
    tierRaw = tier;
    botToken = typeof bot === "string" ? bot.trim() : "";
  } catch (err) {
    // Nothing can be carried from a store that will not read; say so rather
    // than guess, and point at the two pages where each is entered.
    emit(`The box's own settings could not be read: ${errorText(err)}`);
    return [SWAP_NOTES.clawaiSignIn, SWAP_NOTES.telegramNotCarried];
  }
  const secrets = [token, botToken];

  // ── ClawBox AI ──
  if (target === "hermes") {
    if (!token) {
      emit("No ClawBox AI sign-in on this box to carry over.");
      notes.push(SWAP_NOTES.clawaiSignIn);
    } else {
      emit(`Carrying the ClawBox AI sign-in over to ${name}…`);
      try {
        // The tier the badge recorded, the way the configure route passes it;
        // the plan on record stays as it is because the account is unchanged.
        await applyClawaiToHermes(token, normalizeClawboxAiTier(tierRaw) ?? CLAWBOX_AI_DEFAULT_TIER);
        emit("ClawBox AI sign-in carried over.");
        notes.push(SWAP_NOTES.clawaiCarried);
      } catch (err) {
        emit(`ClawBox AI could not be carried over: ${withoutSecrets(errorText(err), secrets)}`);
        notes.push(SWAP_NOTES.clawaiSignIn);
      }
    }
  } else {
    // openclaw.json is never overwritten by the step, so the provider the
    // configure route wrote before the box left OpenClaw is still there — or
    // it is not, and the owner is told to sign in rather than told a story.
    const provider = (await readConfig()).models?.providers?.[CLAWBOX_AI_PROVIDER];
    const apiKey = provider?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim()) {
      emit("ClawBox AI sign-in is still in OpenClaw's own configuration.");
      notes.push(SWAP_NOTES.clawaiCarried);
    } else {
      emit("OpenClaw's configuration carries no ClawBox AI sign-in.");
      notes.push(SWAP_NOTES.clawaiSignIn);
    }

    // ── The persona ──
    // Hermes' identity files are symlinks to the canonical copy, so a month
    // on Hermes has moved the persona on; OpenClaw's workspace holds REAL
    // copies that are still where the box left them. The step has no identity
    // leg in this direction (the Hermes one has, through hermes_edition), so
    // this is the runtime switcher's own refresh — the script guards the
    // introduction ritual itself and leaves a never-introduced workspace alone.
    emit("Refreshing the agent's persona for OpenClaw…");
    try {
      await execFile("bash", [path.join(CONFIG_ROOT, "scripts", "clawbox-identity-sync.sh"), "openclaw"], {
        timeout: 60_000,
      });
      emit("Persona refreshed.");
    } catch (err) {
      emit(`The persona could not be refreshed: ${withoutSecrets(errorText(err), secrets)}`);
      notes.push(SWAP_NOTES.identityNotSynced);
    }
  }

  // ── Telegram ──
  if (!botToken) return notes;
  emit(`Registering the Telegram bot with ${name}…`);
  let landed = false;
  try {
    if (target === "hermes") await setHermesTelegramToken(botToken);
    else await setTelegramToken(botToken);
    landed = true;
  } catch (err) {
    emit(`The Telegram bot could not be registered: ${withoutSecrets(errorText(err), secrets)}`);
    notes.push(SWAP_NOTES.telegramNotCarried);
  }
  if (!landed) return notes;

  // The process that RECEIVES messages has to pick the token up; the token is
  // already on disk, so a gateway that does not confirm is a pending note,
  // never a lost credential.
  let serving = false;
  try {
    if (target === "hermes") {
      const status = await ensureHermesGateway();
      serving = status.running && status.applied;
    } else {
      await restartGateway();
      serving = true;
    }
  } catch (err) {
    emit(`The ${name} gateway has not confirmed the bot yet: ${withoutSecrets(errorText(err), secrets)}`);
  }
  if (!serving) notes.push(SWAP_NOTES.telegramPending);
  else emit("Telegram bot carried over.");
  notes.push(SWAP_NOTES.telegramApprovals);
  return notes;
}
