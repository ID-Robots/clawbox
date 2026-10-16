import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every case starts a real bash: see src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Change-based selection for the on-device suite: the `plan` job of
// .github/workflows/nano-hardware-tests.yml hands a pull request's changed
// files to scripts/nano-tests/select-tests.sh, and the board then runs only
// the tests whose `# covers:` map reaches those files, plus the core smoke set
// (`# select: always`). A wrong subset leaves a change untested on its PR
// (beta and main still run everything), so every doubt must come out `all`.

const SCRIPT = path.resolve(process.cwd(), "scripts/nano-tests/select-tests.sh");
const canRun = process.platform === "linux" && spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const CORE = ["10-build-identity", "20-services", "30-chat-turn"];

function select(paths: string[] | string, args: string[] = [], cwd?: string) {
  const input = Array.isArray(paths) ? paths.map((p) => `${p}\n`).join("") : paths;
  const result = spawnSync("bash", [SCRIPT, ...args], { input, encoding: "utf-8", cwd });
  const lines = result.stdout.split("\n").filter(Boolean);
  const field = (key: string) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  const tests = field("tests");
  return {
    status: result.status,
    stderr: result.stderr,
    lines,
    all: tests === "all",
    tests: tests && tests !== "all" ? tests.split(" ") : [],
    reason: field("reason"),
  };
}

describe.skipIf(!canRun)("scripts/nano-tests/select-tests.sh", () => {
  it("prints exactly the two GITHUB_OUTPUT lines and exits 0", () => {
    const out = select(["src/lib/coding-agent.ts"]);
    expect(out.status).toBe(0);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatch(/^tests=(all|\d\d-[a-z0-9-]+( \d\d-[a-z0-9-]+)*)$/);
    expect(out.lines[1]).toMatch(/^reason=\S/);
  });

  it("runs only the core smoke set for changes that never reach a board", () => {
    for (const p of [
      "src/tests/unit/coding-time-budget.test.ts",
      "e2e/desktop.spec.ts",
      "e2e-install/10-setup-wizard.spec.ts",
      ".github/workflows/e2e-tests.yml",
      "docs/nano-hardware-tests.md",
      "vitest.config.ts",
    ]) {
      const out = select([p]);
      expect(out.all, p).toBe(false);
      expect(out.tests, p).toEqual(CORE);
      expect(out.reason, p).toMatch(/core smoke set only/);
    }
  });

  it("adds the tests whose map covers a changed file", () => {
    expect(select(["src/lib/coding-agent.ts"]).tests).toEqual([...CORE, "40-coding-agent-run", "45-coding-agent-time-budget", "60-media-tools"]);
    expect(select(["src/lib/shared-browser.ts"]).tests).toEqual([...CORE, "78-one-browser", "79-browser-clean-start"]);
    expect(select(["scripts/setup-optimizations.sh"]).tests).toEqual([...CORE, "50-memory-pressure"]);
    expect(select(["config/clawbox-gateway.service", "src/components/Desktop.tsx"]).tests).toEqual([...CORE, "75-full-reboot", "78-one-browser", "79-browser-clean-start"]);
    expect(select(["src/lib/coding-agent.ts"]).reason).toMatch(/^the core smoke set and 40-coding-agent-run 45-coding-agent-time-budget 60-media-tools, from 1 of 1 changed files/);
  });

  it("runs a test whose own file changed, and nothing for a test that was removed", () => {
    expect(select(["scripts/nano-tests/tests/50-memory-pressure.sh"]).tests).toEqual([...CORE, "50-memory-pressure"]);
    expect(select(["scripts/nano-tests/tests/70-reboot-survival.sh"]).tests).toEqual(CORE);
  });

  it("runs everything for the runner, the board workflow and the redactor", () => {
    for (const p of [
      "scripts/nano-tests/run.sh",
      "scripts/nano-tests/lib.sh",
      "scripts/nano-tests/select-tests.sh",
      ".github/workflows/nano-hardware-tests.yml",
      "scripts/public-hygiene.mjs",
    ]) {
      const out = select(["src/tests/unit/a.test.ts", p]);
      expect(out.all, p).toBe(true);
      expect(out.reason, p).toBe(`every test: ${p} is part of the on-device runner`);
    }
  });

  it("runs everything for a file no test's map covers", () => {
    for (const p of ["install.sh", "package.json", "bun.lock", "src/lib/updater.ts", "src/middleware.ts", "config/clawbox-bootstrap-new.md"]) {
      const out = select(["src/lib/coding-agent.ts", p]);
      expect(out.all, p).toBe(true);
      expect(out.reason, p).toBe(`every test: ${p} is covered by no test's map`);
    }
  });

  it("runs everything when the list is incomplete or empty", () => {
    expect(select(["src/tests/unit/a.test.ts"], ["--partial"])).toMatchObject({ all: true, reason: "every test: the list of changed files is incomplete" });
    expect(select([])).toMatchObject({ all: true, reason: "every test: no changed files were listed" });
    expect(select("\n\n")).toMatchObject({ all: true });
  });

  it("reads CRLF lines and a last line without a newline", () => {
    expect(select("src/tests/unit/a.test.ts\r\nscripts/setup-optimizations.sh").tests).toEqual([...CORE, "50-memory-pressure"]);
  });

  it("refuses an unknown option", () => {
    const out = select(["src/lib/a.ts"], ["--everything"]);
    expect(out.status).toBe(2);
    expect(out.lines).toEqual([]);
    expect(out.stderr).toMatch(/usage:/);
  });

  describe("against a map of its own", () => {
    let dir = "";
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "nano-select-"));
      fs.mkdirSync(path.join(dir, "tests"));
      fs.writeFileSync(path.join(dir, "tests", "10-core.sh"), "#!/usr/bin/env bash\n# timeout: 60\n# select: always\n");
      fs.writeFileSync(path.join(dir, "tests", "20-src.sh"), "#!/usr/bin/env bash\n# timeout: 60\n# covers: src/*\n");
      // A file in the folder the script runs in that the pattern would match
      // if it were expanded as a path rather than matched as a pattern.
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src", "present.ts"), "");
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("matches patterns against the paths, never against the files around it", () => {
      const out = select(["src/deep/absent.ts"], ["--tests-dir", path.join(dir, "tests")], dir);
      expect(out.tests).toEqual(["10-core", "20-src"]);
    });
  });
});
