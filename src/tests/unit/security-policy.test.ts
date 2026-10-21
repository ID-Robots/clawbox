/**
 * The published security policy (SECURITY.md) against the code it describes.
 *
 * The supported line has to be the one package.json ships, reports have to go
 * to the shared security mailbox rather than a person's, and the policy has to
 * state what the EU Cyber Resilience Act obliges the manufacturer to report.
 * Addresses are built from parts so this file passes the public-hygiene scan.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const read = (name: string) => fs.readFileSync(path.join(ROOT, name), "utf-8");

const policy = read("SECURITY.md");
const major = Number(JSON.parse(read("package.json")).version.split(".")[0]);
const EMAIL_RE = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** The body of the `## <title>` section, up to the next level-2 heading. */
function section(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return "";
  const end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/** The rows of the first table in `text`, header and separator dropped. */
function tableRows(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("|")).slice(2);
}

describe("SECURITY.md", () => {
  it("supports only the release line package.json ships", () => {
    expect(Number.isInteger(major)).toBe(true);
    const rows = tableRows(section(policy, "Supported Versions"));
    const supported = rows.filter((row) => row.includes("✅"));
    const unsupported = rows.filter((row) => row.includes("❌"));
    expect(supported).toHaveLength(1);
    expect(supported[0]).toContain(`${major}.x`);
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toContain(`${major - 1}.x and earlier`);
  });

  it("sends email reports to the security mailbox only", () => {
    const emails = section(policy, "Reporting a Vulnerability").match(EMAIL_RE) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    for (const address of emails) expect(address).toMatch(/^security@/);
    expect(emails).toContain(["security", "clawbox.com"].join("@"));
  });

  it("states the reporting obligations of the Cyber Resilience Act", () => {
    expect(policy).toMatch(/2024\/2847/);
  });
});

describe("CONTRIBUTING.md", () => {
  it("points security reports to SECURITY.md instead of naming a mailbox", () => {
    const security = read("CONTRIBUTING.md").split("### Security")[1]?.split(/\n#{2,3} /)[0] ?? "";
    expect(security).toContain("SECURITY.md");
    expect(security.match(EMAIL_RE)).toBeNull();
  });
});
