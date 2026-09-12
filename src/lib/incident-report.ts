/**
 * Filing an Improvement Program incident as a GitHub issue.
 *
 * WHY `gh` AND NOT OUR OWN HTTP CLIENT: the owner already connects GitHub for
 * the coding agent's backups (src/lib/coding-github.ts), the credential is
 * gh's and ClawBox never holds it, and `gh issue create` is the same command
 * a person would run. A second credential path for this feature would mean a
 * second thing to revoke.
 *
 * THE FOUR RULES, in the order they are applied:
 *
 *   1. THE OWNER'S MODE. `off` sends nothing, ever — the caller is told so in a
 *      sentence rather than left to infer it from a silence.
 *   2. GITHUB MUST BE CONNECTED. Not connected is not a failure: the incident
 *      stays queued and the card says "Connect GitHub to send reports".
 *   3. DEDUPE BEFORE CREATE. Every issue body carries `<!-- cbip:<fingerprint> -->`
 *      and a search for that marker decides between an issue and a comment. The
 *      marker is in the BODY rather than the title because a title is the one
 *      part of an issue a maintainer rewrites.
 *   4. RATE LIMIT. At most MAX_ISSUES_PER_DAY new issues per box per UTC day,
 *      and at most one "+1, seen again" comment per issue per day. A box in a
 *      crash loop must not be able to open fifty issues overnight — for the
 *      repository's sake and for the owner's, since every one of them carries
 *      their box's version and edition.
 *
 * The dedupe search is best-effort in ONE direction only: a search that fails
 * refuses the send rather than creating a possible duplicate. An issue filed
 * twice cannot be taken back; a report deferred to the next occurrence can.
 */

import { runChild, startedMissing, wasKilled, type ChildResult } from "@/lib/child-run";
import { githubStatus } from "@/lib/coding-github";
import {
  getImprovementMode,
  getIncident,
  recordIncident,
  markCommented,
  markReported,
  remainingIssuesToday,
  utcDay,
  type Incident,
  type ImprovementMode,
  type RecordIncidentInput,
} from "@/lib/incidents";

/** Where reports go. Not configurable: a box that could be pointed at another
 *  repository would be a way to make it post the owner's diagnostics anywhere. */
export const REPORT_REPO = "ID-Robots/clawbox";

/** The labels every report carries, so a maintainer can filter the whole
 *  programme out of their view in one click. */
export const REPORT_LABELS = ["improvement-program", "auto-report"] as const;

/** New issues one box may open per UTC day. */
export const MAX_ISSUES_PER_DAY = 5;

const GH_TIMEOUT_MS = 45_000;

/** Why a report did not go out. Every one of these is a stable code the UI and
 *  the MCP tool word in their own language. */
export type ReportRefusal =
  /** The owner has the programme switched off. */
  | "off"
  /** GitHub is not connected, or `gh` is not installed. */
  | "no_github"
  /** No incident with that id. */
  | "not_found"
  /** Today's allowance of new issues is spent. */
  | "rate_limited"
  /** The dedupe search could not answer; creating now risks a duplicate. */
  | "search_failed"
  /** `gh` ran and refused, or never answered. */
  | "gh_failed";

export type ReportOutcome =
  | { ok: true; action: "created" | "commented" | "already_reported"; issueNumber: number; url?: string }
  | { ok: false; code: ReportRefusal; detail: string };

/** The marker line that makes one fault findable again. */
export function markerFor(fingerprint: string): string {
  return `<!-- cbip:${fingerprint} -->`;
}

/** `gh` with the same minimal environment coding-github.ts uses: HOME for the
 *  credential, no prompts, no colour. */
function gh(args: string[]): Promise<ChildResult> {
  return runChild("gh", args, {
    timeoutMs: GH_TIMEOUT_MS,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/home/clawbox",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
      LANG: "C",
    },
  });
}

/** The seam the tests drive instead of the device. Never passed on a box. */
export interface ReportDeps {
  gh?: (args: string[]) => Promise<ChildResult>;
  githubConnected?: () => Promise<boolean>;
  mode?: () => Promise<ImprovementMode>;
  now?: () => number;
}

/** The title: the source, then the first line of the sanitized message. */
export function issueTitleFor(incident: Incident): string {
  const line = incident.message.split("\n")[0].trim().slice(0, 120);
  return `[auto] ${incident.source}: ${line || "error"}`;
}

/**
 * The body. A fixed template — nothing here is composed from anything but the
 * fields the store already sanitized, so there is no path by which a new kind
 * of text reaches a public issue without passing through the sanitizer first.
 */
export function issueBodyFor(incident: Incident): string {
  const seen = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  const context = Object.entries(incident.context);
  return [
    markerFor(incident.fingerprint),
    "",
    "Reported from a ClawBox with the Improvement Program enabled.",
    "",
    "| | |",
    "| --- | --- |",
    `| Source | \`${incident.source}\` |`,
    `| Fingerprint | \`${incident.fingerprint}\` |`,
    `| Edition | \`${incident.edition}\` |`,
    `| ClawBox version | \`${incident.appVersion}\` |`,
    `| OpenClaw core | \`${incident.coreVersion ?? "unknown"}\` |`,
    `| Seen | ${incident.count}× between ${seen(incident.firstSeen)} and ${seen(incident.lastSeen)} |`,
    "",
    "### Message",
    "",
    "```",
    incident.message,
    "```",
    ...(incident.stack ? ["", "### Stack", "", "```", incident.stack, "```"] : []),
    ...(context.length
      ? ["", "### Context", "", ...context.map(([k, v]) => `- \`${k}\`: ${v}`)]
      : []),
    "",
    "_No transcripts, prompts, file contents or environment values are included._",
    "_Secrets, addresses, hostnames and home paths are removed on the device before sending._",
  ].join("\n");
}

/** The one-line comment a repeat occurrence adds. */
export function commentBodyFor(incident: Incident): string {
  return `+1, seen again on ${incident.appVersion} (${incident.count} times).`;
}

/** An issue number out of `gh issue create`'s URL, or out of a search row. */
export function issueNumberFrom(text: string): number | null {
  const m = /\/issues\/(\d+)/.exec(text.trim());
  return m ? Number(m[1]) : null;
}

/** What `gh` could not do, in one sentence and with no path or credential in
 *  it — a refusal reaches the owner's screen and the agent's context. */
function ghDetail(r: ChildResult, what: string): string {
  if (startedMissing(r)) return `The GitHub CLI is not installed on this ClawBox, so ${what} is not possible.`;
  if (r.startFailed) return `The GitHub CLI could not be started, so ${what} is not possible.`;
  if (wasKilled(r)) return `GitHub did not answer in time while ${what}.`;
  const line = (r.stderr || r.stdout).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return `GitHub refused while ${what}${line ? `: ${line.slice(0, 200)}` : "."}`;
}

/**
 * Does an open issue already carry this fingerprint?
 *
 * `--search "cbip:<fingerprint> in:body"` with `--json number` — the marker is
 * distinctive enough that a hit is the issue, and the result is verified
 * against the number field rather than scraped out of a table.
 *
 * Three answers, not two: found, definitely-not-found, and could-not-look. The
 * third refuses the send, because creating on a failed search is how one fault
 * becomes five issues in a week.
 */
async function findExistingIssue(
  fingerprint: string,
  run: (args: string[]) => Promise<ChildResult>,
): Promise<{ ok: true; number: number | null } | { ok: false; detail: string }> {
  const r = await run([
    "issue", "list",
    "--repo", REPORT_REPO,
    "--state", "open",
    "--search", `cbip:${fingerprint} in:body`,
    "--json", "number",
    "--limit", "5",
  ]);
  if (r.startFailed || wasKilled(r) || r.code !== 0) {
    return { ok: false, detail: ghDetail(r, "looking for an existing report") };
  }
  try {
    const rows: unknown = JSON.parse(r.stdout || "[]");
    if (!Array.isArray(rows)) return { ok: true, number: null };
    for (const row of rows) {
      const n = (row as { number?: unknown })?.number;
      if (typeof n === "number" && Number.isInteger(n) && n > 0) return { ok: true, number: n };
    }
    return { ok: true, number: null };
  } catch {
    // gh answered something that is not the JSON it was asked for. That is a
    // search we cannot read, not a search that found nothing.
    return { ok: false, detail: "The GitHub CLI answered the search in a form this ClawBox could not read." };
  }
}

/**
 * File one incident, or add the day's single "+1" to the issue it already has.
 *
 * The ONE entry point for every surface: the `auto` mode's capture hook, the
 * owner's button and the agent's MCP tool all come through here, so no surface
 * can skip a rule another one applies.
 */
export async function reportIncident(id: string, deps: ReportDeps = {}): Promise<ReportOutcome> {
  const run = deps.gh ?? gh;
  const now = deps.now ? deps.now() : Date.now();

  const mode = await (deps.mode ?? getImprovementMode)();
  if (mode === "off") {
    return {
      ok: false,
      code: "off",
      detail: "The ClawBox Improvement Program is switched off on this box, so nothing is sent. The owner can turn it on in Settings.",
    };
  }

  const incident = getIncident(id);
  if (!incident) return { ok: false, code: "not_found", detail: "There is no incident with that id on this ClawBox." };

  const connected = deps.githubConnected
    ? await deps.githubConnected()
    : await githubStatus().then((s) => s.connected).catch(() => false);
  if (!connected) {
    return {
      ok: false,
      code: "no_github",
      detail: "GitHub is not connected on this ClawBox, so the report stays on the device. Connect GitHub in the Coding Agent settings.",
    };
  }

  // An incident already filed is not refiled. It may still earn the day's one
  // comment — which is the whole point of keeping a count.
  const existingHere = incident.issueNumber;
  const found = existingHere !== null
    ? { ok: true as const, number: existingHere }
    : await findExistingIssue(incident.fingerprint, run);
  if (!found.ok) return { ok: false, code: "search_failed", detail: found.detail };

  if (found.number !== null) {
    // Remember the number even when today's comment has gone: a box that
    // learned the issue exists must never create a second one for it.
    if (existingHere === null) markReported(incident.id, found.number, { charge: false, now });
    if (incident.lastCommentDay === utcDay(now)) {
      return { ok: true, action: "already_reported", issueNumber: found.number };
    }
    const c = await run([
      "issue", "comment", String(found.number),
      "--repo", REPORT_REPO,
      "--body", commentBodyFor(incident),
    ]);
    if (c.startFailed || wasKilled(c) || c.code !== 0) {
      return { ok: false, code: "gh_failed", detail: ghDetail(c, "adding a comment to the existing report") };
    }
    markCommented(incident.id, now);
    return { ok: true, action: "commented", issueNumber: found.number };
  }

  // Only a NEW issue is charged against the daily allowance. A comment is one
  // line on an issue that already exists; capping it would silence the count
  // that tells a maintainer how widespread a fault is.
  if (remainingIssuesToday(MAX_ISSUES_PER_DAY, now) <= 0) {
    return {
      ok: false,
      code: "rate_limited",
      detail: `This ClawBox has already filed ${MAX_ISSUES_PER_DAY} reports today. The rest wait until tomorrow.`,
    };
  }

  const created = await run([
    "issue", "create",
    "--repo", REPORT_REPO,
    "--title", issueTitleFor(incident),
    "--body", issueBodyFor(incident),
    ...REPORT_LABELS.flatMap((label) => ["--label", label]),
  ]);
  if (created.startFailed || wasKilled(created) || created.code !== 0) {
    return { ok: false, code: "gh_failed", detail: ghDetail(created, "filing the report") };
  }
  const url = created.stdout.split("\n").map((l) => l.trim()).find((l) => l.includes("/issues/")) ?? "";
  const number = issueNumberFrom(url);
  if (number === null) {
    // gh exited 0 without printing a URL. The issue very likely EXISTS, so the
    // honest answer is a failure that does not re-create it: the next
    // occurrence finds it by its marker and comments instead.
    return { ok: false, code: "gh_failed", detail: "GitHub accepted the report but did not say which issue it became." };
  }
  markReported(incident.id, number, { charge: true, now });
  return { ok: true, action: "created", issueNumber: number, url };
}

/**
 * The `auto` mode's hook: file straight away, and say nothing anybody has to
 * read. Never throws — it is called from the same failure paths `recordIncident`
 * is, and an auto-reporter that can fail a run would be a defect worse than the
 * one it reports.
 */
export async function autoReportIfEnabled(incident: Incident | null, deps: ReportDeps = {}): Promise<void> {
  if (!incident) return;
  try {
    const mode = await (deps.mode ?? getImprovementMode)();
    if (mode !== "auto") return;
    const outcome = await reportIncident(incident.id, deps);
    if (!outcome.ok && outcome.code !== "rate_limited" && outcome.code !== "no_github") {
      console.error(`[improvement-program] ${incident.id} not reported (${outcome.code})`);
    }
  } catch {
    // An error reporter must not become a source of errors.
  }
}

/**
 * The one call an error path makes: record it, and — in `auto` mode — file it.
 *
 * Deliberately here rather than in incidents.ts, so that module stays the store
 * and nothing on a capture path has to know there are two steps. Returns
 * nothing and never throws: a caller writes `void captureIncident(…)` inside
 * its own catch and carries on.
 */
export async function captureIncident(input: RecordIncidentInput, deps: ReportDeps = {}): Promise<void> {
  try {
    const incident = await recordIncident(input);
    await autoReportIfEnabled(incident, deps);
  } catch {
    // Reporting an error must never become one.
  }
}
