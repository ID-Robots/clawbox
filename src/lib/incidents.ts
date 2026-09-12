/**
 * The ClawBox Improvement Program: what broke on this box, kept locally, and —
 * only if the owner opted in — reported to the ClawBox repository as a GitHub
 * issue.
 *
 * THE OWNER'S SWITCH IS THE WHOLE DESIGN. `clawbox_improvement_program` has
 * three values and nothing here reads any other:
 *
 *   off  (default) — incidents are still RECORDED, because "what went wrong on
 *                    this box last week" is the first question support asks and
 *                    the answer is worth having whether or not it is shared.
 *                    Nothing leaves the device.
 *   ask            — nothing is sent by itself. The agent may offer ("ClawBox
 *                    hit an error; want me to report it?") through the MCP
 *                    tools, and files one on the owner's yes.
 *   auto           — the box files on capture, inside the daily rate limit.
 *
 * Default `off`, and it must stay `off`: a box that reported before it was
 * asked would be doing the one thing this feature exists to make optional.
 *
 * WHAT IS KEPT, and nothing else: a fingerprint, when it was first and last
 * seen, how many times, the edition, the ClawBox version, the OpenClaw core
 * version, a SANITIZED one-line message, a trimmed and sanitized stack, and a
 * handful of sanitized context values. No transcripts, no prompts, no file
 * contents, no environment dumps — those are never passed in, and
 * `sanitizeContext` drops anything structured that tries.
 *
 * STORAGE: data/incidents.json, 0600 via temp+rename, the discipline
 * email-pending.ts uses for drafts. A separate file rather than a config key,
 * for the same reason: it is a bounded log with a lifecycle, and error text
 * does not belong in the blob every settings read parses.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { CONFIG_ROOT, DATA_DIR, get as configGet, getAll as configGetAll, set as configSet } from "@/lib/config-store";
import { readEdition, type EditionName } from "@/lib/edition-source";
import {
  normalizeMessage,
  sanitizeContext,
  sanitizeStack,
  sanitizeText,
  type SanitizeOptions,
} from "@/lib/incident-sanitize";

/**
 * Resolved on every call rather than once at import.
 *
 * Not a style choice: `recordIncident` is reached from `updater.ts` and
 * `coding-agent.ts`, and a module-scope `path.join(DATA_DIR, …)` made merely
 * IMPORTING either of those throw in every suite that mocks `config-store`
 * with a partial object (six updater suites did). A reporter that cannot be
 * imported without a complete config-store is a reporter that breaks the code
 * it reports on.
 */
function incidentsPath(): string {
  return path.join(DATA_DIR, "incidents.json");
}

/** The config key the owner's switch lives under. */
export const IMPROVEMENT_MODE_KEY = "clawbox_improvement_program";

export type ImprovementMode = "off" | "ask" | "auto";
export const IMPROVEMENT_MODES: readonly ImprovementMode[] = ["off", "ask", "auto"] as const;

export function isImprovementMode(value: unknown): value is ImprovementMode {
  return typeof value === "string" && (IMPROVEMENT_MODES as readonly string[]).includes(value);
}

/**
 * The mode, defaulting to `off`.
 *
 * An unreadable or nonsense value is `off` too, deliberately: every failure of
 * this read must fail towards "send nothing", never towards a box that started
 * reporting because its config was corrupt.
 */
export async function getImprovementMode(): Promise<ImprovementMode> {
  try {
    const value = await configGet(IMPROVEMENT_MODE_KEY);
    return isImprovementMode(value) ? value : "off";
  } catch {
    return "off";
  }
}

export async function setImprovementMode(mode: ImprovementMode): Promise<void> {
  await configSet(IMPROVEMENT_MODE_KEY, mode);
}

/** Where an incident came from. A closed set, because it is half the
 *  fingerprint and the first word of every issue title. */
export type IncidentSource =
  /** A delegated Claude Code run that failed. */
  | "coding-agent"
  /** The coding harness itself is not usable — Claude Code or ClawBox AI missing. */
  | "coding-harness"
  /** A step of a system update or post-update failed. */
  | "update"
  /** Anything else in ClawBox's own code that threw where it should not have. */
  | "clawbox";

const SOURCES: readonly IncidentSource[] = ["coding-agent", "coding-harness", "update", "clawbox"] as const;

export function isIncidentSource(value: unknown): value is IncidentSource {
  return typeof value === "string" && (SOURCES as readonly string[]).includes(value);
}

export interface Incident {
  /** Short, stable, and what the MCP tools and the routes name an incident by. */
  id: string;
  /** sha256 of source + normalized message + top stack frame, 16 hex chars.
   *  The dedupe key on GitHub, carried in the issue body as `cbip:<fingerprint>`. */
  fingerprint: string;
  source: IncidentSource;
  /** Sanitized. Never the raw message. */
  message: string;
  /** Sanitized, at most MAX_STACK_FRAMES frames. Null when there was none. */
  stack: string | null;
  context: Record<string, string>;
  firstSeen: number;
  lastSeen: number;
  count: number;
  edition: EditionName;
  appVersion: string;
  coreVersion: string | null;
  /** The issue this was filed as, once it has been. */
  issueNumber: number | null;
  reportedAt: number | null;
  /** The UTC day (YYYY-MM-DD) a "+1, seen again" comment was last added, so a
   *  box that keeps hitting one fault comments at most once a day. */
  lastCommentDay: string | null;
}

/**
 * How many incidents are kept. Past this the OLDEST BY LAST SEEN is dropped —
 * never the one seen most recently, and never a reported one in preference to
 * an unreported one, because the record of what was already filed is what stops
 * the box filing it twice.
 */
export const MAX_INCIDENTS = 100;

interface IncidentFile {
  version: 1;
  incidents: Incident[];
  /** New issues filed today, for the per-box daily cap. `day` is UTC. */
  filed: { day: string; count: number };
}

const EMPTY: IncidentFile = { version: 1, incidents: [], filed: { day: "", count: 0 } };

/** Today in UTC, as YYYY-MM-DD. One clock for the rate limit and the comment
 *  cadence, so neither can be reset by a timezone change. */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Whether a row read back off disk is an incident.
 *
 * `context` and `stack` are checked as strictly as the scalars, and that is not
 * belt-and-braces: `issueBodyFor` calls `.replace()` on every context value to
 * neutralise stray markers, so a file carrying `context: { note: 1 }` — a hand
 * edit, a half-written file, a record from a future shape — made the report
 * route throw a TypeError instead of filing. The store is what guarantees the
 * record's shape to everything downstream, so this is where it is guaranteed.
 */
/** Absent, explicitly null, or of the named type. */
function isOptional(value: unknown, type: "string" | "number"): boolean {
  return value === undefined || value === null || typeof value === type;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([k, v]) => typeof k === "string" && typeof v === "string");
}

function isIncident(value: unknown): value is Incident {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string"
    && typeof v.fingerprint === "string"
    && isIncidentSource(v.source)
    && typeof v.message === "string"
    && isOptional(v.stack, "string")
    && (v.context === undefined || isStringRecord(v.context))
    // The three fields that record what became of this incident. A wrong TYPE
    // is refused here; a MISSING one is filled in by `readFile` — see below for
    // why the difference matters more than it looks.
    && isOptional(v.issueNumber, "number")
    && isOptional(v.reportedAt, "number")
    && isOptional(v.lastCommentDay, "string")
    && typeof v.firstSeen === "number"
    && typeof v.lastSeen === "number"
    && typeof v.count === "number"
  );
}

function readFile(): IncidentFile {
  try {
    if (!fs.existsSync(incidentsPath())) return { ...EMPTY, incidents: [] };
    const parsed: unknown = JSON.parse(fs.readFileSync(incidentsPath(), "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return { ...EMPTY, incidents: [] };
    const v = parsed as Partial<IncidentFile>;
    // EVERY optional field is filled in, not only the two that were obviously
    // optional. The guard lets a record omit them (one written before the field
    // existed is still a valid incident) and every reader is typed as though it
    // cannot — and `undefined !== null` is TRUE, so a record with no
    // `issueNumber` read as "already filed" and sent the reporter down the
    // comment path with `gh issue comment undefined`. This map is what makes
    // the docblock's promise — that the store guarantees the record's shape —
    // true rather than aspirational.
    const incidents = (Array.isArray(v.incidents) ? v.incidents.filter(isIncident) : [])
      .map((i) => ({
        ...i,
        stack: i.stack ?? null,
        context: i.context ?? {},
        issueNumber: i.issueNumber ?? null,
        reportedAt: i.reportedAt ?? null,
        lastCommentDay: i.lastCommentDay ?? null,
      }));
    const filed = v.filed && typeof v.filed.day === "string" && typeof v.filed.count === "number"
      ? { day: v.filed.day, count: v.filed.count }
      : { day: "", count: 0 };
    return { version: 1, incidents, filed };
  } catch {
    // A corrupt log must not take the box's error paths down with it — they
    // are error paths. Nothing recorded is worse than a throw inside a catch.
    return { ...EMPTY, incidents: [] };
  }
}

function writeFile(file: IncidentFile): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${incidentsPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort; a failed chmod must not lose the record
  }
  fs.renameSync(tmp, incidentsPath());
}

/**
 * The fingerprint: source + normalized message + the top stack frame.
 *
 * The TOP frame only. Two occurrences of one fault reach the same throw from
 * different callers often enough that the whole stack would fingerprint them
 * apart, which is how one bug becomes twenty issues.
 */
export function fingerprintOf(source: IncidentSource, message: string, stack: string | null): string {
  const topFrame = (stack ?? "").split("\n").map((l) => l.trim()).find((l) => l.startsWith("at ")) ?? "";
  const canonical = JSON.stringify([source, normalizeMessage(message), topFrame]);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

/**
 * Every string value the box holds in its config, for the sanitizer's literal
 * pass. Values only — a KEY is a name, and redacting the word "telegram" out of
 * every message would be absurd.
 *
 * Never throws and never logs what it read: an unreadable config means the
 * literal pass is skipped and the shape patterns still run.
 */
async function configSecrets(): Promise<string[]> {
  try {
    const all = await configGetAll();
    const out: string[] = [];
    const walk = (value: unknown, depth: number): void => {
      if (depth > 4 || out.length > 200) return;
      if (typeof value === "string") {
        if (value.length >= 8) out.push(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      if (value && typeof value === "object") {
        for (const item of Object.values(value)) walk(item, depth + 1);
      }
    };
    walk(all, 0);
    return out;
  } catch {
    return [];
  }
}

/**
 * The versions an issue carries. Never allowed to throw: a version we cannot
 * name is "unknown", which is still a report.
 *
 * MEMOISED for the process lifetime, and that is not only about the two file
 * reads. `recordIncident` must not `await` between its `readFile()` and its
 * `writeFile()` — both are synchronous, so an await between them is a
 * lost-update window in which a concurrent capture, `markReported` or
 * `markCommented` writes state this one then overwrites. The read is hoisted
 * above the load-modify-store below and cached here so the hoist costs nothing
 * on the common path. An update replaces package.json and restarts the web
 * server, so a cached value cannot outlive the release it names.
 */
let versionsCache: { appVersion: string; coreVersion: string | null } | null = null;

async function versions(): Promise<{ appVersion: string; coreVersion: string | null }> {
  if (versionsCache) return versionsCache;
  let appVersion = process.env.NEXT_PUBLIC_APP_VERSION || "unknown";
  try {
    // The checkout's package.json, like updater.ts's own version read: it is
    // rewritten by the git sync, so it always names the running release —
    // unlike NEXT_PUBLIC_APP_VERSION, which is baked at build time and goes
    // stale on a box that synced without a clean rebuild.
    const pkg = JSON.parse(await fs.promises.readFile(path.join(CONFIG_ROOT, "package.json"), "utf-8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version) appVersion = pkg.version.startsWith("v") ? pkg.version : `v${pkg.version}`;
  } catch {
    // keep the build-time value
  }
  let coreVersion: string | null = null;
  try {
    const { installedOpenclawCoreVersion } = await import("@/lib/openclaw-core-generation");
    coreVersion = await installedOpenclawCoreVersion();
  } catch {
    coreVersion = null;
  }
  versionsCache = { appVersion, coreVersion };
  return versionsCache;
}

export interface RecordIncidentInput {
  source: IncidentSource;
  /** The raw message. Sanitized here — a caller never has to remember to. */
  message: string;
  stack?: string | null;
  /** A small, flat set of facts: a step id, an exit code, a run status. Strings,
   *  numbers and booleans only; anything else is dropped, which is what keeps a
   *  transcript or a file's contents out by construction. */
  context?: Record<string, unknown>;
  /**
   * Do not touch the record if this fingerprint was last seen less than this
   * long ago. What makes a repeating warning batched rather than a write on
   * every poll — the readiness path passes half an hour.
   */
  throttleMs?: number;
  /** Injected by tests. Never passed on a box. */
  now?: number;
}

/**
 * The shape `nextId` mints, and the only shape a caller may name.
 *
 * Exported so the report route can refuse anything else at the door rather
 * than carrying a caller's string as far as a lookup — and as far as a LOG
 * line, which is what CodeQL flagged: an id with a newline in it forges log
 * entries in a file an operator reads to find out what a box did.
 */
export const INCIDENT_ID_RE = /^inc-[a-z0-9]{1,32}$/;

let idCounter = 0;

function nextId(now: number): string {
  idCounter = (idCounter + 1) % 1_000;
  return `inc-${now.toString(36)}${idCounter.toString(36).padStart(2, "0")}`;
}

/**
 * Record one incident. Upserts by fingerprint: a fault seen again bumps its
 * count and its lastSeen rather than filling the log with copies.
 *
 * NEVER THROWS and never rejects. Every caller is already on a failure path,
 * and an error reporter that can fail the thing it is reporting on is worse
 * than no error reporter. Returns the stored incident, or null when nothing
 * was written (throttled, or the write failed).
 */
export async function recordIncident(input: RecordIncidentInput): Promise<Incident | null> {
  try {
    const now = input.now ?? Date.now();
    if (!isIncidentSource(input.source)) return null;
    const raw = typeof input.message === "string" ? input.message.trim() : "";
    if (!raw) return null;

    const options: SanitizeOptions = { secrets: await configSecrets(), maxChars: 600 };
    const message = sanitizeText(raw, options);
    if (!message) return null;
    const stack = sanitizeStack(input.stack ?? null, { ...options, maxChars: 4_000 });
    const context = sanitizeContext(input.context, options);
    const fingerprint = fingerprintOf(input.source, message, stack);

    // BEFORE the read. Everything from `readFile()` to `writeFile()` below is
    // one synchronous load-modify-store, and an `await` inside it is a window
    // in which another capture's write is lost.
    const { appVersion, coreVersion } = await versions();

    const file = readFile();
    const existing = file.incidents.find((i) => i.fingerprint === fingerprint);
    if (existing) {
      if (input.throttleMs && now - existing.lastSeen < input.throttleMs) return existing;
      existing.lastSeen = now;
      existing.count += 1;
      // The newest occurrence's context and stack: an older copy describes a
      // state the box has since left, and the count already says it recurs.
      if (stack) existing.stack = stack;
      if (Object.keys(context).length) existing.context = context;
      writeFile(file);
      return existing;
    }

    const incident: Incident = {
      id: nextId(now),
      fingerprint,
      source: input.source,
      message,
      stack,
      context,
      firstSeen: now,
      lastSeen: now,
      count: 1,
      edition: safeEdition(),
      appVersion,
      coreVersion,
      issueNumber: null,
      reportedAt: null,
      lastCommentDay: null,
    };
    file.incidents.push(incident);
    prune(file);
    writeFile(file);
    return incident;
  } catch {
    return null;
  }
}

function safeEdition(): EditionName {
  try {
    return readEdition();
  } catch {
    return "openclaw";
  }
}

/** Drop the oldest by lastSeen once the log is full, UNREPORTED ones first: the
 *  record that an incident was already filed is what stops a second issue for
 *  it, so it is the last thing worth losing. */
function prune(file: IncidentFile): void {
  if (file.incidents.length <= MAX_INCIDENTS) return;
  const order = [...file.incidents].sort((a, b) => {
    if ((a.issueNumber === null) !== (b.issueNumber === null)) return a.issueNumber === null ? -1 : 1;
    return a.lastSeen - b.lastSeen;
  });
  const drop = new Set(order.slice(0, file.incidents.length - MAX_INCIDENTS).map((i) => i.id));
  file.incidents = file.incidents.filter((i) => !drop.has(i.id));
}

/** Newest first. Everything here is already sanitized, which is what lets the
 *  MCP bearer read it. */
export function listIncidents(): Incident[] {
  return [...readFile().incidents].sort((a, b) => b.lastSeen - a.lastSeen);
}

export function getIncident(id: string): Incident | null {
  return readFile().incidents.find((i) => i.id === id) ?? null;
}

/** Never filed, and therefore what the card counts and the agent may offer. */
export function pendingIncidents(): Incident[] {
  return listIncidents().filter((i) => i.issueNumber === null);
}

/** How many new issues this box may still file today. */
export function remainingIssuesToday(max: number, now = Date.now()): number {
  const file = readFile();
  if (file.filed.day !== utcDay(now)) return max;
  return Math.max(0, max - file.filed.count);
}

/**
 * CLAIM one of today's issue slots, atomically.
 *
 * Read-check-charge in ONE synchronous load-modify-store, because checking the
 * allowance and charging it separately is not a limit: `autoReportIfEnabled`
 * single-flights by fingerprint, so N DIFFERENT faults could each read
 * "4 left" and then each create an issue — six reports passing a limit of five.
 * The slot is taken BEFORE `gh issue create` runs and handed back by
 * `releaseIssueToday` when it fails, so a refusal costs the box nothing and a
 * crash between the two costs it one slot until midnight UTC, which is the
 * safe direction.
 *
 * Returns false when today's allowance is spent.
 */
export function reserveIssueToday(max: number, now = Date.now()): boolean {
  const file = readFile();
  const day = utcDay(now);
  const count = file.filed.day === day ? file.filed.count : 0;
  if (count >= max) return false;
  file.filed = { day, count: count + 1 };
  writeFile(file);
  return true;
}

/** Hand back a slot `reserveIssueToday` granted for a creation that failed. */
export function releaseIssueToday(now = Date.now()): void {
  const file = readFile();
  const day = utcDay(now);
  if (file.filed.day !== day || file.filed.count <= 0) return;
  file.filed = { day, count: file.filed.count - 1 };
  writeFile(file);
}

/**
 * Record that an incident became issue #n, and charge one against today's
 * allowance. Both in one write, so a crash between them cannot produce a box
 * that filed an issue and did not count it.
 *
 * The reporter passes `charge: false` and reserves the slot up front instead
 * (see `reserveIssueToday`); the option stays because "mark this as filed"
 * and "spend a slot" are two different facts and a caller that learns an issue
 * already existed must record the first without the second.
 */
export function markReported(id: string, issueNumber: number, opts: { charge: boolean; now?: number } = { charge: true }): void {
  const now = opts.now ?? Date.now();
  const file = readFile();
  const incident = file.incidents.find((i) => i.id === id);
  if (!incident) return;
  incident.issueNumber = issueNumber;
  incident.reportedAt = now;
  if (opts.charge) {
    const day = utcDay(now);
    file.filed = file.filed.day === day ? { day, count: file.filed.count + 1 } : { day, count: 1 };
  }
  writeFile(file);
}

/** Record that a "+1, seen again" comment went out today. */
export function markCommented(id: string, now = Date.now()): void {
  const file = readFile();
  const incident = file.incidents.find((i) => i.id === id);
  if (!incident) return;
  incident.lastCommentDay = utcDay(now);
  writeFile(file);
}

/** Test seam: forget everything on disk. Never called on a box. */
export function _resetIncidentsForTests(): void {
  try {
    fs.rmSync(incidentsPath(), { force: true });
  } catch {
    // nothing to forget
  }
  idCounter = 0;
  versionsCache = null;
}
