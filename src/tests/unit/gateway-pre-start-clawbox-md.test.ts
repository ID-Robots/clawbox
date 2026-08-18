import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Asked how much context it has, V4 answers "128K" — a memory of an older
// DeepSeek, not a fact about this device, and eight times smaller than the
// window the box actually configures. Observed on hardware on 2026-08-18: the
// same box that had just answered a 902,116-token prompt said "128K tokens" in
// the chat app. Nothing in the prompt told it otherwise, so CLAWBOX.md now
// does — and because CLAWBOX.md is seeded only when absent, boxes already in
// the field need the section appended rather than seeded.
//
// This runs the append block out of the shipped .sh, not a copy, so the test
// fails if the real script drifts.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const GUIDE = path.resolve(process.cwd(), "config/clawbox-workspace-guide.md");
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

const MARKER = "clawbox:ai-model-limits";

/** Pull the CLAWBOX.md append block out of the .sh verbatim. */
function extractAppendBlock(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf("  # --- clawbox-md-ai-limits (extracted verbatim by tests) ---");
  const end = src.indexOf("  # --- end clawbox-md-ai-limits ---", start);
  if (start < 0 || end < 0) throw new Error("clawbox-md-ai-limits block not found");
  return src.slice(start, end);
}

const BLOCK = hasBash ? extractAppendBlock() : "";

let dir: string;
let guide: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-md-"));
  guide = path.join(dir, "CLAWBOX.md");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Run the extracted block against a CLAWBOX.md in a temp dir. */
function run(templateSrc: string = GUIDE): string {
  const program = `set -eu\nCLAWBOX_GUIDE_DST="${guide}"\nCLAWBOX_GUIDE_SRC="${templateSrc}"\n${BLOCK}\n`;
  execFileSync("bash", ["-c", program], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  return existsSync(guide) ? readFileSync(guide, "utf-8") : "";
}

/** The marked section of the shipped template, verbatim. */
function templateSection(src: string = GUIDE): string {
  const text = readFileSync(src, "utf-8");
  const start = text.indexOf(`<!-- ${MARKER} -->`);
  const endMarker = `<!-- /${MARKER} -->`;
  const end = text.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("markers missing from template");
  return text.slice(start, end + endMarker.length);
}

describe.skipIf(!hasBash)("gateway-pre-start.sh CLAWBOX.md model limits", () => {
  it("appends the section to a guide that predates it", () => {
    writeFileSync(guide, "# ClawBox Integration Guide\n\nolder content\n");
    const out = run();
    expect(out).toContain(MARKER);
    expect(out).toContain("1,000,000");
    expect(out).toContain("393,216");
  });

  it("keeps what the owner already wrote", () => {
    writeFileSync(guide, "# ClawBox Integration Guide\n\nmy own note about the office printer\n");
    expect(run()).toContain("my own note about the office printer");
  });

  it("is idempotent — a second gateway start appends nothing", () => {
    writeFileSync(guide, "# ClawBox Integration Guide\n");
    const once = run();
    const twice = run();
    expect(twice).toBe(once);
    // Count the opening marker only — the section carries a closing one too.
    expect(twice.split(`<!-- ${MARKER} -->`)).toHaveLength(2);
  });

  it("does not create the file when the box has no guide at all", () => {
    // Seeding is the other half of the script's job and owns that case; this
    // block must not conjure a CLAWBOX.md outside a workspace that exists.
    expect(run()).toBe("");
    expect(existsSync(guide)).toBe(false);
  });

  it("tells the agent not to repeat the 128K it will otherwise guess", () => {
    writeFileSync(guide, "# ClawBox Integration Guide\n");
    expect(run()).toContain("128K");
  });

  it("appends the shipped section verbatim, so an upgraded box reads what a fresh one reads", () => {
    // The whole point of copying out of the template: a device flashed today
    // and a device upgraded in the field must not end up with two different
    // explanations of the same limit.
    writeFileSync(guide, "# ClawBox Integration Guide\n");
    expect(run()).toContain(templateSection());
  });

  it("states the same numbers the provider migration writes", () => {
    // One drifting without the other is how the picker came to claim 128K in
    // the first place: two places holding the same fact, only one maintained.
    const src = readFileSync(SCRIPT, "utf-8");
    expect(src).toContain('model["contextWindow"] = 1000000');
    expect(src).toContain('model["maxTokens"] = 393216');
    const section = templateSection();
    expect(section).toContain("1,000,000");
    expect(section).toContain("393,216");
  });

  it("appends nothing when the template markers have moved", () => {
    // A truncated section is a new way to be wrong; saying nothing is the
    // state we started from. The script warns and leaves the guide alone.
    const brokenTemplate = path.join(dir, "template-without-markers.md");
    writeFileSync(brokenTemplate, "# ClawBox Integration Guide\n\nno markers here\n");
    writeFileSync(guide, "# ClawBox Integration Guide\n");
    const out = run(brokenTemplate);
    expect(out).toBe("# ClawBox Integration Guide\n");
    expect(out).not.toContain(MARKER);
  });

  it("appends nothing when the template opens the section but never closes it", () => {
    // Printing as the section streams by would make a dangling opening marker
    // mean "everything to end of file" — unrelated template content landing in
    // the customer's guide, with a success exit code to hide it.
    const dangling = path.join(dir, "template-unclosed.md");
    writeFileSync(
      dangling,
      `# Guide\n\n<!-- ${MARKER} -->\n## Limits\n\nunrelated section that follows\n`,
    );
    writeFileSync(guide, "# ClawBox Integration Guide\n");
    const out = run(dangling);
    expect(out).toBe("# ClawBox Integration Guide\n");
    expect(out).not.toContain("unrelated section that follows");
  });

  it("ignores a closing marker that appears without an opening one", () => {
    const orphanClose = path.join(dir, "template-orphan-close.md");
    writeFileSync(orphanClose, `# Guide\n\nsome text\n<!-- /${MARKER} -->\n`);
    writeFileSync(guide, "# ClawBox Integration Guide\n");
    expect(run(orphanClose)).toBe("# ClawBox Integration Guide\n");
  });

  it("does nothing when the template is missing entirely", () => {
    writeFileSync(guide, "# ClawBox Integration Guide\n");
    const out = run(path.join(dir, "does-not-exist.md"));
    expect(out).toBe("# ClawBox Integration Guide\n");
  });
});
