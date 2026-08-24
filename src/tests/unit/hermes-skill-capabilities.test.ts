import { describe, expect, it } from 'vitest';
import type { ScanFinding } from '@/lib/hermes-skills';
import {
  buildDangerWarning,
  capabilityOf,
  deriveCapabilities,
  isFlaggedVerdict,
  severityCounts,
} from '@/lib/hermes-skill-capabilities';

/**
 * TASK-452 / crit9c — turning the installer's scan report into something a
 * device owner can decide on.
 *
 * The fixture is the real report from the QA box: installing
 * `official/creative/simple-english` on 2026-08-22 returned HTTP 200 in 1.4 s
 * with `scan_verdict: dangerous` and these two CRITICAL findings, because the
 * installer's policy table allows everything at `builtin` trust — while the
 * same device's `hermes skills audit` called the very same skill BLOCKED.
 */
const SIMPLE_ENGLISH_FINDINGS: ScanFinding[] = [
  {
    patternId: 'agent-instruction-overwrite',
    severity: 'critical',
    category: 'persistence',
    file: 'SKILL.md',
    line: 308,
    description: '- **Agent instructions (prompts, AGENTS.md)**: a system prom',
  },
  {
    patternId: 'agent-instruction-overwrite',
    severity: 'critical',
    category: 'persistence',
    file: 'references/use-cases.md',
    line: 41,
    description: '## Instructions for AI agents (prompts, AGENTS.md, skills)',
  },
];

describe('capabilityOf (TASK-452)', () => {
  it.each([
    [{ category: 'persistence', description: 'rewrites AGENTS.md' }, 'agentInstructions'],
    [{ category: 'credential-access', description: 'reads ~/.aws/credentials' }, 'credentials'],
    [{ category: 'command-injection', description: 'calls subprocess.run' }, 'shell'],
    [{ category: 'network', description: 'posts to a webhook' }, 'network'],
    [{ category: 'browser-automation', description: 'drives chromium' }, 'browser'],
    [{ category: 'privilege', description: 'runs sudo apt install' }, 'system'],
    [{ category: 'file-write', description: 'writes into ~/Documents' }, 'filesystem'],
    // A category a future scanner version invents is reported, not dropped.
    [{ category: 'quantum-weirdness', description: 'inexplicable' }, 'other'],
    [{}, 'other'],
  ])('%o -> %s', (finding, expected) => {
    expect(capabilityOf(finding as ScanFinding)).toBe(expected);
  });
});

describe('deriveCapabilities (TASK-452)', () => {
  it('buckets the real simple-english report under "changes your agent’s instructions"', () => {
    const caps = deriveCapabilities(SIMPLE_ENGLISH_FINDINGS);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ id: 'agentInstructions', count: 2, severity: 'critical' });
    // The evidence a reviewer can go and check, verbatim from the report.
    expect(caps[0].locations).toEqual(['SKILL.md:308', 'references/use-cases.md:41']);
  });

  it('orders buckets most-severe first', () => {
    const caps = deriveCapabilities([
      { category: 'file-read', severity: 'low', file: 'a.py' },
      { category: 'command-injection', severity: 'critical', file: 'b.py' },
      { category: 'network', severity: 'medium', file: 'c.py' },
    ]);
    expect(caps.map((c) => c.id)).toEqual(['shell', 'network', 'filesystem']);
  });

  it('keeps the worst severity in a bucket, not the last one seen', () => {
    const caps = deriveCapabilities([
      { category: 'network', severity: 'low' },
      { category: 'network', severity: 'high' },
      { category: 'network', severity: 'info' },
    ]);
    expect(caps[0]).toMatchObject({ id: 'network', severity: 'high', count: 3 });
  });

  it('dedupes and caps the locations it quotes', () => {
    const caps = deriveCapabilities(
      Array.from({ length: 20 }, (_, i) => ({
        category: 'network',
        severity: 'low',
        file: i < 2 ? 'same.py' : `f${i}.py`,
        line: i < 2 ? 3 : i,
      })),
    );
    expect(caps[0].count).toBe(20);
    expect(caps[0].locations.length).toBeLessThanOrEqual(6);
    expect(new Set(caps[0].locations).size).toBe(caps[0].locations.length);
  });
});

describe('severityCounts', () => {
  it('counts every branch, treating an unknown severity as info', () => {
    expect(
      severityCounts([
        { severity: 'CRITICAL' },
        { severity: 'high' },
        { severity: 'wat' },
        {},
      ]),
    ).toEqual({ critical: 1, high: 1, medium: 0, low: 0, info: 2 });
  });
});

describe('isFlaggedVerdict (TASK-452)', () => {
  it('does not flag a clean scan', () => {
    expect(isFlaggedVerdict('safe', [])).toBe(false);
    expect(isFlaggedVerdict('SAFE', [])).toBe(false);
  });

  it('flags the verdict that installed silently on the box', () => {
    expect(isFlaggedVerdict('dangerous', SIMPLE_ENGLISH_FINDINGS)).toBe(true);
  });

  it('flags caution as well as dangerous', () => {
    // Krasi's ruling is warn + confirm, not block, so asking about a `caution`
    // skill costs a click; NOT asking is what the finding was about.
    expect(isFlaggedVerdict('caution', [])).toBe(true);
  });

  it('fails CLOSED on a verdict this build has never heard of', () => {
    expect(isFlaggedVerdict('quarantined', [])).toBe(true);
  });

  it('flags a critical finding even when the verdict claims safe', () => {
    expect(isFlaggedVerdict('safe', SIMPLE_ENGLISH_FINDINGS)).toBe(true);
  });

  it('does NOT flag a skill that was never scanned', () => {
    // No verdict and no findings means the scanner never looked — a different
    // state from "looked and objected", handled by the normal trust copy.
    expect(isFlaggedVerdict(undefined, [])).toBe(false);
    expect(isFlaggedVerdict('', [])).toBe(false);
  });
});

describe('buildDangerWarning (TASK-452)', () => {
  it('carries the trust tier that used to be the reason nobody was asked', () => {
    const warning = buildDangerWarning({
      id: 'official/creative/simple-english',
      name: 'simple-english',
      source: 'official',
      trust: 'builtin',
      verdict: 'dangerous',
      findings: SIMPLE_ENGLISH_FINDINGS,
    });
    expect(warning).toMatchObject({
      id: 'official/creative/simple-english',
      name: 'simple-english',
      trust: 'builtin',
      verdict: 'dangerous',
      requiresConfirmation: true,
    });
    expect(warning.severityCounts.critical).toBe(2);
    expect(warning.capabilities[0].id).toBe('agentInstructions');
    expect(warning.findings).toHaveLength(2);
  });

  it('caps the findings it echoes back', () => {
    const warning = buildDangerWarning({
      id: 'x/y',
      name: 'y',
      verdict: 'dangerous',
      findings: Array.from({ length: 200 }, () => ({ severity: 'low', category: 'network' })),
    });
    expect(warning.findings.length).toBeLessThanOrEqual(40);
  });
});
