import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { translations } from "@/lib/translations";

/**
 * The public copy and the agent's field guide describe the device the owner
 * actually has.
 *
 * ClawBox is built on the 8 GB Jetson module running in its Super power mode
 * (MAXN_SUPER, the 67 TOPS figure, the spec table on the hardware page), yet
 * the README, the field guide and several docs pages called it a plain
 * "Jetson Orin Nano 8GB" — a different, slower product to anyone who looks it
 * up. Only bench lines ("Measured on …") keep the bare name, because they
 * record the unit a number came from.
 *
 * The field guide also told the agent the owner went through a "7-step wizard
 * (WiFi → security → update → AI → Telegram → done)": the wizard has five
 * steps, and Update comes before Security. The order is read from the
 * progress bar the owner sees, so a reordered wizard takes this test with it.
 */

const REPO_ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function docsPages(): string[] {
  return readdirSync(path.join(REPO_ROOT, "docs-site"), { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".mdx") && !rel.split(path.sep).includes("node_modules"))
    .map((rel) => path.posix.join("docs-site", ...rel.split(path.sep)))
    .sort();
}

/** The wizard's step labels in English, in the order ProgressBar.tsx renders them. */
function wizardSteps(): string[] {
  const source = read("src/components/ProgressBar.tsx");
  const block = source.match(/STEP_LABELS = \[([\s\S]*?)\];/);
  if (!block) throw new Error("STEP_LABELS not found in ProgressBar.tsx");
  const keys = [...block[1].matchAll(/t\("([^"]+)"\)/g)].map((m) => m[1]);
  return keys.map((key) => {
    const label = translations.en[key];
    if (!label) throw new Error(`no English label for ${key}`);
    return label;
  });
}

describe("hardware model naming", () => {
  const files = ["README.md", "Clawbox.md", ...docsPages()];

  it("scans the README, the field guide and every docs page", () => {
    expect(files).toContain("docs-site/index.mdx");
    expect(files).toContain("docs-site/hardware/clawbox-connect.mdx");
    expect(read("docs-site/hardware/clawbox-connect.mdx")).toContain(
      "NVIDIA Jetson Orin Nano Super (8 GB)",
    );
  });

  it("never pairs Orin Nano with 8 GB or 67 TOPS without naming it Orin Nano Super", () => {
    const offenders: string[] = [];
    for (const file of files) {
      read(file)
        .split("\n")
        .forEach((line, i) => {
          if (
            /Orin Nano/.test(line) &&
            /8 ?GB|67 TOPS/.test(line) &&
            !/Orin Nano Super/.test(line) &&
            !/measured on/i.test(line)
          ) {
            offenders.push(`${file}:${i + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe("field guide setup wizard", () => {
  const guide = read("Clawbox.md");
  const steps = wizardSteps();

  it("reads five steps from the progress bar", () => {
    expect(steps).toEqual(["WiFi", "Update", "Security", "AI Provider", "Telegram"]);
  });

  it("states no step count the wizard does not have", () => {
    expect(guide).not.toMatch(/7-step wizard/);
    for (const [, count] of guide.matchAll(/(\d+)-step wizard/g)) {
      expect(Number(count)).toBe(steps.length);
    }
  });

  it("lists the steps in the order the wizard runs them", () => {
    const sequence = steps.join(" → ");
    const lines = guide
      .split("\n")
      .filter((line) => /\/setup\s+→/.test(line) || /\d+-step wizard/.test(line));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line).toContain(sequence);
    }
  });
});
