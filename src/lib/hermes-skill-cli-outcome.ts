// TASK-453 round 3 — reading what the Hermes skills CLI ACTUALLY said.
//
// `hermes skills install` exits 0 on almost every refusal. It resolves nothing
// and exits 0; it fails to download and exits 0; the security scanner blocks
// the skill and it exits 0. The install route therefore could not use the exit
// code to tell those apart, and inferred failure from the ABSENCE of a hub-lock
// entry — which can only ever produce one sentence:
//
//     502 {"error":"Skill could not be resolved — try the full identifier"}
//
// Live on a Hermes box (revalidate2-round1.md §3): every ClawHub id that
// `skill_search` had just handed out came back with exactly that, and the MCP
// tool turned it into `NOT_FOUND` + "Call skill_search, then pass the exact id
// it returned" — the step that had just been taken. A guaranteed retry loop,
// and a customer told their id was wrong when the id was fine and the SCANNER
// had refused it.
//
// This module is the fix's foundation: classify the CLI's own output, so the
// route can say which of these actually happened. It is PURE (no fs, no
// child_process) so it can be unit-tested against verbatim CLI transcripts, and
// it is shared — `inspect` dead-ends on the same disambiguation table.
//
// Two shapes of the CLI matter here, both read from the deployed hermes-agent
// on a live box:
//
//   tools/skills_guard.py:797  should_allow_install(result, force)
//     INSTALL_POLICY   safe     caution   dangerous
//       builtin        allow    allow     allow
//       trusted        allow    allow     block
//       community      allow    block     block
//       agent-created  allow    allow     ask
//     `force` upgrades ANY decision to allow EXCEPT a `dangerous` verdict at
//     `community`/`trusted` trust, which is unoverridable and says so:
//       "Blocked (community source + dangerous verdict, 2 findings).
//        --force does not override a dangerous verdict."
//     Everything else that is refused names its own escape hatch:
//       "Blocked (community source + caution verdict, 4 findings). Use --force
//        to override."   /   "Requires confirmation (…)"
//
//   hermes_cli/skills_hub.py:728  prints "Installation blocked: <that reason>"
//     through a `rich` Console. Off a TTY that console is 80 columns wide, so
//     the reason WRAPS mid-sentence — verified on the box, where the
//     128-character reason above comes out as two lines. Every matcher here
//     therefore runs against a whitespace-collapsed copy of the output, never
//     against raw lines. (runHermesCli now asks for a wide console, so the
//     scan-report ROWS survive too; this stays newline-tolerant because a
//     device that ignores COLUMNS must still be classified correctly.)

import { checkInstallIdentifier } from '@/lib/hermes-skills';
import type { ScanFinding } from '@/lib/hermes-skills';
import { logSafe } from '@/lib/log-safe';

export type InstallOutcomeKind =
  /** The security scanner refused it. `confirmable` says whether the owner can override. */
  | 'scan-refused'
  /** `Installation blocked:` for a reason that is not the scan gate (e.g. an unsafe path). */
  | 'blocked-other'
  /** The id matched nothing the installer could fetch. */
  | 'unresolved'
  /** The short name matched several skills; the installer wants a full identifier. */
  | 'ambiguous'
  /** Resolved, but no source would serve it. */
  | 'unfetchable'
  /** Unfetchable specifically because the GitHub API rate limit is exhausted. */
  | 'rate-limited'
  /** Already present; the installer will not replace it without `--force`. */
  | 'already-installed'
  /** The installer said something this parser does not recognise. */
  | 'unknown';

export interface InstallOutcome {
  kind: InstallOutcomeKind;
  /**
   * The installer's own sentence, un-wrapped to a single line. Only ever set
   * from a TEMPLATED CLI message whose words this module recognises — never a
   * free-text exception, which could carry on-device paths.
   */
  reason?: string;
  /**
   * `scan-refused` only. True when an explicit owner confirmation can get past
   * this refusal (the CLI's own `--force`), false when the CLI refuses at any
   * confirmation.
   */
  confirmable?: boolean;
  /** Trust tier the installer resolved for the source, e.g. `community`. */
  trust?: string;
  /** Scanner verdict, e.g. `dangerous`. */
  verdict?: string;
  /** How many findings the installer counted — its number, not ours. */
  findingCount?: number;
  /**
   * The scanned bundle's digest, from the `Scan provenance:` line. It is the
   * key to the installer's OWN structured report in
   * `~/.hermes/skills/.hub/scan-cache`, which is written before the policy gate
   * runs — so the caller can read the real findings (`pattern_id` included)
   * instead of the rendered table.
   */
  contentHash?: string;
  /** Findings recovered from the printed table — the fallback when the cache is gone. */
  findings: ScanFinding[];
  scannerVersion?: string;
  /** `unresolved`/`ambiguous`: the ids the installer offered instead. */
  suggestions: string[];
}

/** Longest CLI output worth scanning; anything past this is noise. */
const MAX_OUTPUT_CHARS = 200_000;
// Matches buildDangerWarning()'s own cap: parsing more only to have them sliced
// off before anything renders them is work for nobody.
const MAX_FINDINGS = 40;
const MAX_SUGGESTIONS = 5;
const MAX_EXCERPT = 200;
/** Trust tiers and verdicts are single words; this is a sanity bound, not a policy. */
const MAX_WORD = 32;

/**
 * The scan gate's verdict line, tolerant of the 80-column wrap.
 *
 * `Blocked (community source + dangerous verdict, 2 findings).` and
 * `Requires confirmation (agent-created source + dangerous verdict, 3 findings)`
 * are the only two shapes skills_guard emits, and both carry the three facts
 * that decide what the owner is told: trust tier, verdict, finding count.
 */
const SCAN_REASON_RE =
  /Installation blocked:\s*(Blocked|Requires confirmation)\s*\(([A-Za-z][\w-]*) source \+ ([A-Za-z][\w-]*) verdict, (\d+) findings?\)\s*\.?/i;

/** The clause skills_guard adds when NOTHING the owner does will get past it. */
const UNOVERRIDABLE_RE = /--force does not override a dangerous verdict/i;

/**
 * One row of `format_scan_report`:
 *   `  CRITICAL supply_chain   SKILL.md:62    "curl -fsSL https://…| bash"`
 * severity is ljust(8), category ljust(14), `file:line` ljust(30), then the
 * matched excerpt in quotes. The excerpt is attacker-controlled text from the
 * skill, so it goes through logSafe() before it is kept.
 */
const FINDING_RE =
  /^\s{2}(CRITICAL|HIGH|MEDIUM|LOW|INFO)\s+(\S+)\s+(.+?):(\d+)\s+"([\s\S]*)"\s*$/;

/** `Scan provenance: fresh; scanner skills-guard-v1; hash sha256:d75b7b1d…` */
const PROVENANCE_RE = /Scan provenance:\s*\w+;\s*scanner\s+([\w.-]+);\s*hash\s+(sha256:[0-9a-f]{16,64})/i;

/** `  Terraform — oo-terraform` under a "did you mean" list. */
const SUGGESTION_RE = /^\s{2,}(?:\S.*?)\s+[—–-]\s+(\S+)\s*$/;

/** `Multiple skills named 'x' found:` — the header above the ambiguity table. */
const AMBIGUOUS_RE = /Multiple skills named '[^']*' found/i;

function parseFindings(raw: string): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (out.length >= MAX_FINDINGS) break;
    const m = FINDING_RE.exec(line);
    if (!m) continue;
    out.push({
      severity: m[1].toLowerCase(),
      category: logSafe(m[2], 40),
      file: logSafe(m[3], 200),
      line: Number(m[4]),
      description: logSafe(m[5], MAX_EXCERPT),
    });
  }
  return out;
}

/**
 * The ids a "did you mean" list offered.
 *
 * Each one is validated with the install route's own identifier check: an id
 * the route would answer 400 for is not a next step, it is a wasted round trip.
 */
function parseSuggestions(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (out.length >= MAX_SUGGESTIONS) break;
    const m = SUGGESTION_RE.exec(line);
    if (m && checkInstallIdentifier(m[1]).ok) out.push(m[1]);
  }
  return out;
}

export interface AmbiguousSkill {
  identifier: string;
  source?: string;
  trust?: string;
}

/**
 * The rows of the disambiguation table `install`/`inspect` print for a short
 * name that several registries answer to ("Multiple skills named 'notion'
 * found" — 11 rows). A `rich` Table, so the cells are `│`-delimited.
 *
 * Shared because both routes dead-ended on it: inspect answered "not found"
 * and install answered "could not be resolved", for a name the device could
 * see perfectly well and simply wanted narrowed down.
 */
export function parseAmbiguousSkills(stdout: string, limit = 40): AmbiguousSkill[] {
  if (!AMBIGUOUS_RE.test(stdout)) return [];
  const out: AmbiguousSkill[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('│')) continue;
    const cells = line.split('│').map((c) => c.trim());
    if (cells.length < 5) continue;
    const [, source, trust, identifier] = cells;
    if (!identifier || identifier === 'Identifier') continue;
    if (!checkInstallIdentifier(identifier).ok) continue;
    out.push({ identifier, source: source || undefined, trust: trust || undefined });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Classify one `hermes skills install` run that exited 0 without installing.
 *
 * Order matters: the scan gate is checked first because its output CONTAINS a
 * resolution step that succeeded, and a "Resolving…" line must never be read as
 * a resolution failure.
 */
export function parseInstallOutcome(stdout: string, stderr = ''): InstallOutcome {
  const raw = `${stdout || ''}\n${stderr || ''}`.slice(0, MAX_OUTPUT_CHARS);
  // `rich` hard-wraps at 80 columns off a TTY, so no sentence can be matched
  // against a single line.
  const flat = raw.replace(/\s+/g, ' ');
  const empty = { findings: [] as ScanFinding[], suggestions: [] as string[] };

  const scan = SCAN_REASON_RE.exec(flat);
  if (scan) {
    const [, decision, trust, verdict, count] = scan;
    const provenance = PROVENANCE_RE.exec(flat);
    return {
      ...empty,
      kind: 'scan-refused',
      // Rebuilt from the captured groups rather than sliced out of the output:
      // every word here is one this module recognised.
      reason:
        `${decision === 'Blocked' ? 'Blocked' : 'Requires confirmation'} `
        + `(${trust.slice(0, MAX_WORD)} source + ${verdict.slice(0, MAX_WORD)} verdict, ${count} findings)`,
      confirmable: !UNOVERRIDABLE_RE.test(flat),
      trust: trust.slice(0, MAX_WORD),
      verdict: verdict.slice(0, MAX_WORD).toLowerCase(),
      findingCount: Number(count),
      contentHash: provenance?.[2],
      findings: parseFindings(raw),
      scannerVersion: provenance?.[1],
    };
  }

  // Any other `Installation blocked:` is a quarantine/path refusal carrying an
  // exception string. Deliberately NOT echoed: the route logs it and answers
  // with fixed words, the same rule the non-zero-exit branch already follows.
  if (/Installation blocked:/i.test(flat)) {
    return { ...empty, kind: 'blocked-other' };
  }

  if (AMBIGUOUS_RE.test(flat)) {
    return {
      ...empty,
      kind: 'ambiguous',
      suggestions: parseAmbiguousSkills(raw, MAX_SUGGESTIONS).map((s) => s.identifier),
    };
  }
  if (/No exact match for '[^']*'/i.test(flat)) {
    return { ...empty, kind: 'unresolved', suggestions: parseSuggestions(raw) };
  }
  if (/No skill named '[^']*' found in any source/i.test(flat)) {
    return { ...empty, kind: 'unresolved' };
  }
  if (/no source adapter for '[^']*'/i.test(flat)) {
    return { ...empty, kind: 'unresolved' };
  }
  if (/Could not fetch '[^']*' from any source/i.test(flat)) {
    return {
      ...empty,
      kind: /rate limit exhausted/i.test(flat) ? 'rate-limited' : 'unfetchable',
    };
  }
  if (/is already installed at/i.test(flat)) {
    return { ...empty, kind: 'already-installed' };
  }
  return { ...empty, kind: 'unknown' };
}
