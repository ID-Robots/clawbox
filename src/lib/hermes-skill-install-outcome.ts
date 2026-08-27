// TASK-453 round 3 — reading what the Hermes installer ACTUALLY said.
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
// This module is the fix's foundation: parse the installer's own output into a
// structured outcome, so the route can say which of these actually happened.
// It is PURE (no fs, no child_process) so it can be unit-tested against
// verbatim CLI transcripts.
//
// Two shapes of the CLI matter here, both read from the deployed
// hermes-agent on a live box:
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
//       "Blocked (community source + caution verdict, 1 findings). Use --force
//        to override."   /   "Requires confirmation (…)"
//
//   hermes_cli/skills_hub.py:728  prints "Installation blocked: <that reason>"
//     through a `rich` Console. Not a TTY ⇒ width 80 ⇒ the reason WRAPS
//     mid-sentence. Verified on the box: the 128-character reason above comes
//     out as two lines. Every matcher here therefore runs against a
//     whitespace-collapsed copy of the output, never against raw lines.

import type { ScanFinding } from '@/lib/hermes-skills';

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
  /** Findings recovered from the printed scan report. Empty when it printed none. */
  findings: ScanFinding[];
  scannerVersion?: string;
  scannedAt?: string;
  /** `unresolved`: the identifiers the installer's "did you mean" list offered. */
  suggestions: string[];
}

/** Longest CLI output worth scanning; anything past this is noise. */
const MAX_OUTPUT_CHARS = 200_000;
const MAX_FINDINGS = 60;
const MAX_SUGGESTIONS = 5;
const MAX_EXCERPT = 200;

/** One line, no control characters, bounded — for anything registry-controlled. */
function tidy(value: string, maxLen: number): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

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
 *   `  CRITICAL destructive    SKILL.md:41    "curl x | sh"`
 * severity is ljust(8), category ljust(14), `file:line` ljust(30), then the
 * matched excerpt in quotes. The excerpt is attacker-controlled text from the
 * skill, so it is tidied before it is kept.
 */
const FINDING_RE =
  /^\s{2}(CRITICAL|HIGH|MEDIUM|LOW|INFO)\s+(\S+)\s+(.+?):(\d+)\s+"([\s\S]*)"\s*$/;

/** `Scan provenance: cached; scanner skills-guard-v1; hash sha256:d75b7b1d…` */
const PROVENANCE_RE = /Scan provenance:\s*\w+;\s*scanner\s+([\w.-]+);/i;
/**
 * `Source: oo-terraform; scanned 2026-08-27T10:19:41.110656+00:00; rules: …`
 * The device emits an offset, not a `Z`; a cached report can carry either.
 */
const SCANNED_AT_RE = /;\s*scanned\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)\s*;/i;

/** `  QR Code Decode — qrcode-decode` under a "did you mean" / ambiguity table. */
const SUGGESTION_RE = /^\s{2,}(?:\S.*?)\s+[—–-]\s+(\S+)\s*$/;

function parseFindings(lines: string[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const line of lines) {
    if (out.length >= MAX_FINDINGS) break;
    const m = FINDING_RE.exec(line);
    if (!m) continue;
    out.push({
      severity: m[1].toLowerCase(),
      category: tidy(m[2], 64),
      file: tidy(m[3], 120),
      line: Number(m[4]),
      description: tidy(m[5], MAX_EXCERPT),
    });
  }
  return out;
}

function parseSuggestions(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (out.length >= MAX_SUGGESTIONS) break;
    const m = SUGGESTION_RE.exec(line);
    if (m) out.push(tidy(m[1], 128));
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
  const lines = raw.split(/\r?\n/);
  // `rich` hard-wraps at 80 columns off a TTY, so no sentence can be matched
  // against a single line.
  const flat = raw.replace(/\s+/g, ' ');
  const empty = { findings: [] as ScanFinding[], suggestions: [] as string[] };

  const scan = SCAN_REASON_RE.exec(flat);
  if (scan) {
    const [, decision, trust, verdict, count] = scan;
    const unoverridable = UNOVERRIDABLE_RE.test(flat);
    return {
      ...empty,
      kind: 'scan-refused',
      // Rebuilt from the captured groups rather than sliced out of the output:
      // every word here is one this module recognised.
      reason:
        `${decision === 'Blocked' ? 'Blocked' : 'Requires confirmation'} `
        + `(${tidy(trust, 32)} source + ${tidy(verdict, 32)} verdict, ${count} findings)`,
      confirmable: !unoverridable,
      trust: tidy(trust, 32),
      verdict: tidy(verdict, 32).toLowerCase(),
      findingCount: Number(count),
      findings: parseFindings(lines),
      scannerVersion: PROVENANCE_RE.exec(flat)?.[1],
      scannedAt: SCANNED_AT_RE.exec(flat)?.[1],
    };
  }

  // Any other `Installation blocked:` is a quarantine/path refusal carrying an
  // exception string. Deliberately NOT echoed: the route logs it and answers
  // with fixed words, the same rule the non-zero-exit branch already follows.
  if (/Installation blocked:/i.test(flat)) {
    return { ...empty, kind: 'blocked-other' };
  }

  // The ambiguity list is a `rich` Table with box-drawing borders and a folded
  // Identifier column; it is deliberately not scraped. "Use the full
  // identifier" is actionable on its own, and a half-parsed table row is worse
  // than none.
  if (/Multiple skills named '[^']*' found/i.test(flat)) {
    return { ...empty, kind: 'ambiguous' };
  }
  if (/No exact match for '[^']*'/i.test(flat)) {
    return { ...empty, kind: 'unresolved', suggestions: parseSuggestions(lines) };
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
