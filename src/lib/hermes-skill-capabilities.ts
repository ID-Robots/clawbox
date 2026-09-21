// TASK-452 — turning an installer scan report into a sentence a device owner
// can act on.
//
// Hermes' scanner answers with a VERDICT (`safe` / `caution` / `dangerous`) and
// a list of findings whose fields are a pattern id, a severity, a category and
// a source excerpt. That is a security engineer's vocabulary: "CRITICAL
// persistence SKILL.md:308" tells the owner of a ClawBox nothing about what the
// skill would be able to DO to their device.
//
// This module is the translation layer. It buckets the findings into the
// capabilities a non-specialist can reason about — can it run commands, can it
// read my files, can it reach the internet, can it read my keys — so the store
// and the install API can say "this skill can run shell commands and read your
// credentials" instead of quoting a pattern id.
//
// It is PURE (no fs, no node) on purpose: the install route derives the payload
// server-side and the store renders the same objects client-side, so both must
// be able to import it.
//
// Krasi's ruling (2026-08-24): a flagged skill is WARNED about and CONFIRMED,
// never hard-blocked, and the rule applies to every trust tier including
// `official`. Nothing here decides policy — it only describes.

import type { ScanFinding } from '@/lib/hermes-skills';

export const CAPABILITY_IDS = [
  'shell',
  'filesystem',
  'network',
  'credentials',
  'browser',
  'system',
  'agentInstructions',
  'other',
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export interface SkillCapability {
  id: CapabilityId;
  /** How many findings landed in this bucket. */
  count: number;
  /**
   * The concrete evidence, deduped and capped: `SKILL.md:308`,
   * `scripts/run.py:12`. Empty when a finding carried no location.
   */
  locations: string[];
  /** Highest severity seen in this bucket — drives the ordering and the icon. */
  severity: FindingSeverity;
}

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function normalizeSeverity(raw?: string): FindingSeverity {
  const v = (raw || '').trim().toLowerCase();
  return (SEVERITY_ORDER as string[]).includes(v) ? (v as FindingSeverity) : 'info';
}

function severityRank(s: FindingSeverity): number {
  return SEVERITY_ORDER.indexOf(s);
}

// Substring probes applied to `category` + `patternId` + `description`, in
// order — the FIRST bucket that matches wins, so the more specific probes come
// first. Deliberately substring-based rather than an exact table: the scanner's
// pattern ids are not a stable published vocabulary (they change with the
// scanner version the device happens to run), and a finding that falls through
// every probe still gets reported under `other` rather than being dropped.
const PROBES: { id: CapabilityId; needles: string[] }[] = [
  {
    id: 'agentInstructions',
    needles: [
      'persistence',
      'agents.md',
      'agent instruction',
      'system prompt',
      'prompt-inject',
      'prompt inject',
      'skill.md injection',
    ],
  },
  {
    id: 'credentials',
    needles: [
      'credential',
      'secret',
      'password',
      'api key',
      'api-key',
      'apikey',
      'token',
      'ssh',
      'keychain',
      'dotenv',
      '.env',
      'exfil',
    ],
  },
  {
    id: 'browser',
    needles: ['browser', 'chrome', 'chromium', 'playwright', 'selenium', 'puppeteer', 'webdriver', 'cdp'],
  },
  {
    id: 'shell',
    needles: [
      'shell',
      'exec',
      'subprocess',
      'command-injection',
      'command injection',
      'os.system',
      'eval',
      'bash',
      'popen',
      'spawn',
    ],
  },
  {
    id: 'network',
    needles: [
      'network',
      'http',
      'url',
      'download',
      'fetch',
      'curl',
      'wget',
      'socket',
      'dns',
      'upload',
      'webhook',
      'remote',
    ],
  },
  {
    id: 'system',
    needles: [
      'sudo',
      'root',
      'privilege',
      'systemd',
      'service',
      'cron',
      'crontab',
      'launchd',
      'registry',
      'kernel',
      'package-install',
      'apt',
      'pip install',
      'settings',
      'config',
    ],
  },
  {
    id: 'filesystem',
    needles: [
      'file',
      'filesystem',
      'path-traversal',
      'traversal',
      'write',
      'read',
      'delete',
      'unlink',
      'rmtree',
      'chmod',
      'symlink',
      'glob',
    ],
  },
];

/** Which capability a single finding evidences. */
export function capabilityOf(finding: ScanFinding): CapabilityId {
  const hay = [finding.category, finding.patternId, finding.description]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  if (!hay.trim()) return 'other';
  for (const probe of PROBES) {
    if (probe.needles.some((n) => hay.includes(n))) return probe.id;
  }
  return 'other';
}

const MAX_LOCATIONS_PER_CAPABILITY = 6;

function locationOf(finding: ScanFinding): string | null {
  if (!finding.file) return null;
  // The file field is registry-controlled text; keep it short and single-line.
  const file = finding.file.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
  if (!file) return null;
  return typeof finding.line === 'number' && finding.line > 0 ? `${file}:${finding.line}` : file;
}

/**
 * Bucket a scan report's findings into capabilities, ordered most-severe first
 * (ties broken by how many findings evidence the capability, then by id so the
 * output is deterministic and snapshot-testable).
 */
export function deriveCapabilities(findings: ScanFinding[]): SkillCapability[] {
  const byId = new Map<CapabilityId, SkillCapability>();
  for (const finding of findings) {
    const id = capabilityOf(finding);
    const severity = normalizeSeverity(finding.severity);
    const existing = byId.get(id);
    const bucket: SkillCapability = existing || { id, count: 0, locations: [], severity: 'info' };
    bucket.count++;
    if (severityRank(severity) < severityRank(bucket.severity)) bucket.severity = severity;
    const where = locationOf(finding);
    if (where && bucket.locations.length < MAX_LOCATIONS_PER_CAPABILITY && !bucket.locations.includes(where)) {
      bucket.locations.push(where);
    }
    byId.set(id, bucket);
  }
  return Array.from(byId.values()).sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.count - a.count ||
      a.id.localeCompare(b.id),
  );
}

/** Count of findings per severity — the one-line summary above the detail. */
export function severityCounts(findings: ScanFinding[]): Record<FindingSeverity, number> {
  const out: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) out[normalizeSeverity(f.severity)]++;
  return out;
}

// Verdicts that mean "the scanner looked and found nothing to raise". Anything
// else — `caution`, `dangerous`, `suspicious`, a verdict a future scanner
// version invents — is treated as flagged. Fail CLOSED: an unrecognised verdict
// asks the owner rather than installing silently.
export const CLEAN_VERDICTS = new Set(['safe', 'clean', 'ok', 'pass', 'passed', 'none']);

/**
 * Did the scanner flag this skill?
 *
 * TRUE when the verdict is anything other than a clean one, OR when the report
 * carries a critical/high finding regardless of the verdict — the box proved
 * both halves matter: `official/creative/simple-english` installed with
 * `scan_verdict: dangerous` and two CRITICALs because its trust tier said
 * "allow", and the same skill's own `hermes skills audit` called it BLOCKED.
 *
 * A verdict of `undefined` with no findings means NOT SCANNED, which is not the
 * same as flagged — a skill the scanner never looked at is handled by the
 * normal trust copy, not by the danger dialog.
 */
export function isFlaggedVerdict(verdict: string | undefined, findings: ScanFinding[] = []): boolean {
  const v = (verdict || '').trim().toLowerCase();
  if (v && !CLEAN_VERDICTS.has(v)) return true;
  return findings.some((f) => {
    const s = normalizeSeverity(f.severity);
    return s === 'critical' || s === 'high';
  });
}

/**
 * The 409 body the install route returns for a flagged skill, and the object
 * the store's confirmation dialog renders. Everything in it is derived from the
 * installer's own scan report — no ClawBox-side judgement is added.
 */
export interface SkillDangerWarning {
  /** Registry identifier the owner asked to install. */
  id: string;
  /** Resolved skill name (the lock key / directory name). */
  name: string;
  source?: string;
  /** Trust tier as the installer resolved it — `builtin` included. */
  trust?: string;
  verdict?: string;
  scannerVersion?: string;
  summary?: string;
  capabilities: SkillCapability[];
  severityCounts: Record<FindingSeverity, number>;
  findings: ScanFinding[];
  /** Always true on this payload — it is what tells the client to ask. */
  requiresConfirmation: true;
}

const MAX_REPORTED_FINDINGS = 40;

export function buildDangerWarning(input: {
  id: string;
  name: string;
  source?: string;
  trust?: string;
  verdict?: string;
  scannerVersion?: string;
  summary?: string;
  findings: ScanFinding[];
}): SkillDangerWarning {
  const findings = input.findings.slice(0, MAX_REPORTED_FINDINGS);
  return {
    id: input.id,
    name: input.name,
    source: input.source,
    trust: input.trust,
    verdict: input.verdict,
    scannerVersion: input.scannerVersion,
    summary: input.summary,
    capabilities: deriveCapabilities(findings),
    severityCounts: severityCounts(findings),
    findings,
    requiresConfirmation: true,
  };
}
