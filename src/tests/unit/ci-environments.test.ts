import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const read = (name: string) => readFileSync(resolve(process.cwd(), ".github/workflows", name), "utf8").split("\n").filter(line => !/^\s*#/.test(line)).join("\n");
describe("CI credential environments", () => {
  for (const [file, job] of [["pr-review.yml", "review"], ["issue-triage.yml", "triage"]]) {
    it(`${job} binds its job to the protected review environment`, () => {
      const text = read(file).split(`  ${job}:\n`)[1].split("    steps:")[0];
      expect(text).toMatch(/^ {4}environment: clawreview$/m);
    });
  }
  it("installer uses an empty environment on PRs and protected credentials otherwise", () => {
    const job = read("e2e-install.yml").split("  e2e-install:\n")[1].split("    steps:")[0];
    expect(job).toContain("environment: ${{ github.event_name == 'pull_request' && 'e2e-pull-request' || 'e2e-credentials' }}");
  });
  it("untrusted PR setup never writes the credential file", () => {
    const step = read("e2e-install.yml").split("      - name: Write .env.test\n")[1].split("        env:")[0];
    expect(step).toContain("if: ${{ github.event_name != 'pull_request' }}");
  });
  it("both installer checkouts leave no git token on disk", () => {
    const text = read("e2e-install.yml");
    for (const name of ["Checkout PR head", "Checkout repository"]) {
      const step = text.split(`      - name: ${name}\n`)[1].split("      - ")[0];
      expect(step).toContain("persist-credentials: false");
    }
  });
});
