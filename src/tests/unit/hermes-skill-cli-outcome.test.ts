import { describe, expect, it } from 'vitest';

import { parseInstallOutcome } from '@/lib/hermes-skill-cli-outcome';

/**
 * TASK-453 round 3 — `hermes skills install` exits 0 on every refusal, so the
 * install route could only ever answer "Skill could not be resolved". Live on a
 * Hermes box that sentence came back for ids that resolved perfectly and were
 * refused by the device's own SECURITY SCANNER, and the MCP tool turned it into
 * "call skill_search and pass the exact id it returned" — the step just taken.
 *
 * The transcripts below are the shipped CLI's real output. They were built from
 * the deployed hermes-agent (`tools/skills_guard.py::should_allow_install`,
 * `hermes_cli/skills_hub.py`) and reproduced against that box's own `rich`
 * install, INCLUDING the 80-column hard wrap that splits every one of these
 * sentences when stdout is a pipe. A parser that only works on un-wrapped text
 * would pass a prettier fixture and fail on the device.
 */

// community + caution. The CLI blocks it too — but names `--force` as the way
// past, which is exactly the owner confirmation ClawBox already collects.
const BLOCKED_CAUTION = [
  'Scan: helm (helm/community)  Verdict: CAUTION',
  '  MEDIUM   network        SKILL.md:8                     "curl https://get.helm.sh"',
  '',
  'Installation blocked: Blocked (community source + caution verdict, 1 findings). ',
  'Use --force to override.',
].join('\n');

// agent-created + dangerous — the policy table's third decision, `ask`, which
// skills_hub still prints under the "Installation blocked" banner.
const NEEDS_CONFIRMATION =
  'Installation blocked: Requires confirmation (agent-created source + dangerous \nverdict, 3 findings)';

const DID_YOU_MEAN = [
  "Resolving 'qrcode-decode'...",
  "No exact match for 'qrcode-decode'. Did you mean one of these?",
  '  QR Code Decode — qrcode-decode',
  '  QR Tools — qr-tools',
  '',
].join('\n');

const RATE_LIMITED = [
  "Error: Could not fetch 'NVIDIA/skills/skills/aiq-deploy' from any source.",
  'Hint: GitHub API rate limit exhausted (unauthenticated: 60 requests/hour).',
  'Set GITHUB_TOKEN in your .env or install the gh CLI and run gh auth login to ',
  'raise the limit to 5,000/hr.',
].join('\n');

describe('parseInstallOutcome — the scan gate', () => {
  it('reads a caution verdict as a refusal an explicit confirmation CAN override', () => {
    const out = parseInstallOutcome(BLOCKED_CAUTION);

    expect(out.kind).toBe('scan-refused');
    expect(out.confirmable).toBe(true);
    expect(out.verdict).toBe('caution');
  });

  it('reads "Requires confirmation" as confirmable, not as a dead end', () => {
    const out = parseInstallOutcome(NEEDS_CONFIRMATION);

    expect(out.kind).toBe('scan-refused');
    expect(out.confirmable).toBe(true);
    expect(out.trust).toBe('agent-created');
    expect(out.findingCount).toBe(3);
  });

});

describe('parseInstallOutcome — everything else the CLI exits 0 for', () => {
  it('reads a "did you mean" list as unresolved and keeps the suggestions', () => {
    const out = parseInstallOutcome(DID_YOU_MEAN);

    expect(out.kind).toBe('unresolved');
    expect(out.suggestions).toEqual(['qrcode-decode', 'qr-tools']);
  });

  it('separates an exhausted GitHub allowance from a skill that does not exist', () => {
    expect(parseInstallOutcome(RATE_LIMITED).kind).toBe('rate-limited');
    expect(
      parseInstallOutcome("Error: Could not fetch 'x/y' from any source.\n").kind,
    ).toBe('unfetchable');
  });

  it('reads the already-installed warning as such, not as a missing skill', () => {
    const out = parseInstallOutcome(
      "Warning: 'pdf' is already installed at ~/.hermes/skills/pdf\nUse --force to reinstall.\n",
    );

    expect(out.kind).toBe('already-installed');
  });

  it('reads an ambiguous short name as ambiguous', () => {
    expect(
      parseInstallOutcome("Multiple skills named 'pdf' found:\nUse the full identifier to install a specific one.").kind,
    ).toBe('ambiguous');
  });

  it('reads a name no source has as unresolved', () => {
    expect(parseInstallOutcome("Error: No skill named 'nope' found in any source.\n").kind).toBe(
      'unresolved',
    );
  });

  it('does not guess when the installer says something it has never seen', () => {
    expect(parseInstallOutcome('something entirely new\n').kind).toBe('unknown');
  });

  it('keeps a non-scan "Installation blocked" out of the scan branch', () => {
    // A quarantine/path refusal carries an exception string, which must never
    // be mistaken for a verdict the owner could confirm past.
    const out = parseInstallOutcome(
      'Installation blocked: unsafe path in bundle: ../../etc/passwd\n',
    );

    expect(out.kind).toBe('blocked-other');
    expect(out.confirmable).toBeUndefined();
  });

  it('never echoes a free-text exception back to the caller', () => {
    const out = parseInstallOutcome(
      'Installation blocked: cannot write /home/clawbox/.hermes/skills/x\n',
    );

    expect(JSON.stringify(out)).not.toMatch(/home\/clawbox/);
  });

  it('neutralises control characters in a registry-controlled finding excerpt', () => {
    const esc = String.fromCharCode(27);
    const excerpt = `  HIGH     injection      SKILL.md:1                     "a${esc}[31mb"`;
    const out = parseInstallOutcome(
      `Installation blocked: Blocked (community source + dangerous verdict, 1 findings). --force does not override a dangerous verdict.
${excerpt}`,
    );

    // logSafe() REPLACES rather than strips, so an escape cannot be acted on by
    // a terminal and two excerpts differing only in escapes stay distinct.
    expect(out.findings[0].description).not.toContain(esc);
    expect(out.findings[0].description).toHaveLength('a?[31mb'.length);
  });

  it('drops a suggested id the install route would refuse anyway', () => {
    const out = parseInstallOutcome(
      [
        "No exact match for 'x'. Did you mean one of these?",
        '  Flagged — --oops',
        '  Real — real-skill',
      ].join('\n'),
    );

    expect(out.suggestions).toEqual(['real-skill']);
  });
});

/**
 * Verbatim from a Hermes device, 2026-08-27, `hermes skills install
 * clawhub/oo-terraform --yes` against an isolated HERMES_HOME. `oo-terraform`
 * is one of the four ids round 2 sampled; the CLI resolves it, refuses it, and
 * exits 0 with an untouched lock — which is the whole defect.
 *
 * The two captures are the SAME run at two console widths. Off a TTY `rich`
 * falls back to 80 columns and splits the reason sentence AND the scan-report
 * rows; the route now asks for a wide console, and the parser has to survive
 * both because a device that ignores COLUMNS must still be read correctly.
 */
const DEVICE_80_COL = [
  '',
  'Fetching: clawhub/oo-terraform',
  'Quarantined to .hub/quarantine/oo-terraform',
  'Running security scan...',
  'Scan: oo-terraform (oo-terraform/community)  Verdict: DANGEROUS',
  '  CRITICAL supply_chain   SKILL.md:62                    "curl -fsSL ',
  'https://cli.oomol.com/install.sh | bash    # macO"',
  '  LOW      privilege_escalation SKILL.md:4                     "allowed-tools: ',
  '[Bash(oo *)]"',
  '',
  'Decision: BLOCKED — Blocked (community source + dangerous verdict, 2 findings). ',
  '--force does not override a dangerous verdict.',
  'Scan provenance: fresh; scanner skills-guard-v1; hash ',
  'sha256:d75b7b1d4c77490378b0335404dba937ebf8a02feb3cb50efdc4148192e21a9f',
  'Source: oo-terraform; scanned 2026-08-27T10:19:41.110656+00:00; rules: ',
  'allowed_tools_field, curl_pipe_shell',
  '',
  'Installation blocked: Blocked (community source + dangerous verdict, 2 ',
  'findings). --force does not override a dangerous verdict.',
].join('\n');

const DEVICE_WIDE = [
  '',
  'Fetching: clawhub/oo-terraform',
  'Quarantined to .hub/quarantine/oo-terraform',
  'Running security scan...',
  'Scan: oo-terraform (oo-terraform/community)  Verdict: DANGEROUS',
  '  CRITICAL supply_chain   SKILL.md:62                    "curl -fsSL https://cli.oomol.com/install.sh | bash    # macO"',
  '  LOW      privilege_escalation SKILL.md:4                     "allowed-tools: [Bash(oo *)]"',
  '',
  'Decision: BLOCKED — Blocked (community source + dangerous verdict, 2 findings). --force does not override a dangerous verdict.',
  'Scan provenance: cached; scanner skills-guard-v1; hash sha256:d75b7b1d4c77490378b0335404dba937ebf8a02feb3cb50efdc4148192e21a9f',
  'Source: oo-terraform; scanned 2026-08-27T10:19:41.110656+00:00; rules: allowed_tools_field, curl_pipe_shell',
  '',
  'Installation blocked: Blocked (community source + dangerous verdict, 2 findings). --force does not override a dangerous verdict.',
].join('\n');

/** Verbatim: the bare slug `skill_search` hands out, on the same device. */
const DEVICE_BARE_SLUG = [
  "Resolving 'oo-terraform'...",
  "No exact match for 'oo-terraform'. Did you mean one of these?",
  '  Terraform — oo-terraform',
  '',
].join('\n');

describe('parseInstallOutcome — verbatim device output', () => {
  it('reads the refusal at the device default width, wrapped mid-sentence', () => {
    const out = parseInstallOutcome(DEVICE_80_COL);

    expect(out.kind).toBe('scan-refused');
    expect(out.confirmable).toBe(false);
    expect(out.trust).toBe('community');
    expect(out.verdict).toBe('dangerous');
    // The installer's own count, which survives even when the rows it printed
    // are split across lines and cannot all be parsed.
    expect(out.findingCount).toBe(2);
  });

  it('recovers both findings once the console is wide enough to print them whole', () => {
    const out = parseInstallOutcome(DEVICE_WIDE);

    expect(out.findings.map((f) => [f.severity, f.category, f.file, f.line])).toEqual([
      ['critical', 'supply_chain', 'SKILL.md', 62],
      ['low', 'privilege_escalation', 'SKILL.md', 4],
    ]);
    expect(out.scannerVersion).toBe('skills-guard-v1');
    // The digest is the key to the installer's OWN structured report in the
    // scan cache, which carries the pattern ids the rendered table drops.
    expect(out.contentHash).toBe(
      'sha256:d75b7b1d4c77490378b0335404dba937ebf8a02feb3cb50efdc4148192e21a9f',
    );
  });

  it('reads the bare slug the search tool hands out as a resolver miss, not a block', () => {
    const out = parseInstallOutcome(DEVICE_BARE_SLUG);

    expect(out.kind).toBe('unresolved');
    // The CLI suggesting the identical id it was handed is a Hermes-side
    // resolver bug; passing it through is still the only actionable answer.
    expect(out.suggestions).toEqual(['oo-terraform']);
  });
});
