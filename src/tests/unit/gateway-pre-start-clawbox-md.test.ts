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
function run(): string {
  const program = `set -eu\nCLAWBOX_GUIDE_DST="${guide}"\n${BLOCK}\n`;
  execFileSync("bash", ["-c", program], { encoding: "utf-8" });
  return existsSync(guide) ? readFileSync(guide, "utf-8") : "";
}

describe.skipIf(!hasBash)("gateway-pre-start.sh CLAWBOX.md model limits", () => {
  it("appends the section to a guide that predates it", () => {
    writeFileSync(guide, "# ClawBox Integration Guide\n\nolder content\n");
    const out = run();
    expect(out).toContain(MARKER);
    expect(out).toContain("1000000");
    expect(out).toContain("393216");
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
    expect(twice.match(new RegExp(MARKER, "g"))).toHaveLength(1);
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

  it("states the same numbers the provider migration writes", () => {
    // One drifting without the other is how the picker came to claim 128K in
    // the first place: two places holding the same fact, only one maintained.
    const src = readFileSync(SCRIPT, "utf-8");
    expect(src).toContain('model["contextWindow"] = 1000000');
    expect(src).toContain('model["maxTokens"] = 393216');
    writeFileSync(guide, "# ClawBox Integration Guide\n");
    const out = run();
    expect(out).toContain("1000000");
    expect(out).toContain("393216");
  });

  it("ships the same section in the seeded template, so fresh boxes match upgraded ones", () => {
    const template = readFileSync(GUIDE, "utf-8");
    expect(template).toContain(MARKER);
    expect(template).toContain("1,000,000");
    expect(template).toContain("393,216");
  });
});
