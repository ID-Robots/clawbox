import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Every case starts a real bash: see src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// .github/workflows/nano-hardware-tests.yml runs on every non-draft PR into
// beta and main (TASK-1362), but a PR that changes nothing except
// documentation is not worth an hour of a lab board. Its cheap first job lists
// the PR's changed files and hands them to scripts/nano-tests/needs-board.sh,
// whose `hardware=` line decides whether the board job runs at all. A wrong
// `false` merges an untested change; a wrong `true` only costs a board run —
// so every doubt has to come out `true`.

const SCRIPT = path.resolve(process.cwd(), "scripts/nano-tests/needs-board.sh");
const canRun = process.platform === "linux" && spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

function classify(paths: string[] | string, args: string[] = []) {
  const input = Array.isArray(paths) ? paths.map((p) => `${p}\n`).join("") : paths;
  const result = spawnSync("bash", [SCRIPT, ...args], { input, encoding: "utf-8" });
  const lines = result.stdout.split("\n").filter(Boolean);
  const field = (key: string) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  return { status: result.status, stderr: result.stderr, lines, hardware: field("hardware"), reason: field("reason") };
}

describe.skipIf(!canRun)("scripts/nano-tests/needs-board.sh", () => {
  it("prints exactly the two GITHUB_OUTPUT lines and exits 0", () => {
    const out = classify(["src/app/page.tsx"]);
    expect(out.status).toBe(0);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatch(/^hardware=(true|false)$/);
    expect(out.lines[1]).toMatch(/^reason=\S/);
  });

  it.each([
    ["a file under docs/", ["docs/nano-hardware-tests.md"]],
    ["a non-markdown file under docs/", ["docs/task-1059/screenshot.png"]],
    ["a deep path under docs/", ["docs/superpowers/plans/a/b/c.json"]],
    ["the docs site", ["docs-site/docs.json", "docs-site/editions/hermes-skills.mdx"]],
    ["markdown at the repository root", ["README.md", "RELEASE-NOTES-4.1.0.md"]],
    ["markdown at any depth", ["mcp/README.md", "bench/tasks/s-01-single-edit/brief.md", ".github/pull_request_template.md"]],
    ["a path with spaces", ["docs/a file with spaces.png"]],
  ])("needs no board for %s", (_name, paths) => {
    const out = classify(paths);
    expect(out.hardware, out.reason).toBe("false");
    expect(out.reason).toBe(`only documentation changed (${paths.length} files under docs/, docs-site/ or *.md)`);
  });

  it.each([
    ["source code", ["src/lib/updater.ts"]],
    ["the workflow itself", [".github/workflows/nano-hardware-tests.yml"]],
    ["the on-device suite", ["scripts/nano-tests/tests/30-chat-turn.sh"]],
    ["the seeded workspace guide, though it is markdown", ["config/clawbox-workspace-guide.md"]],
    ["the seeded bootstrap ritual, though it is markdown", ["config/clawbox-bootstrap.md"]],
    ["a docs/ folder that is not at the root", ["src/docs/helper.ts"]],
    ["a bare file named docs", ["docs"]],
    ["a sibling of docs/ that only starts with the name", ["docsx/readme.txt", "docs-sitex/a.json"]],
    ["MDX outside the docs site", ["src/components/Intro.mdx"]],
    ["a name that only contains .md", ["notes.md.ts", "a.md/b.txt"]],
    ["upper-case .MD (GitHub's filters are case-sensitive)", ["CHANGELOG.MD"]],
  ])("needs a board for %s", (_name, paths) => {
    expect(classify(paths).hardware).toBe("true");
  });

  it("needs a board when docs come with one code file, and names that file", () => {
    const out = classify(["docs/a.md", "README.md", "scripts/nano-tests/run.sh", "docs-site/x.mdx"]);
    expect(out.hardware).toBe("true");
    expect(out.reason).toBe("scripts/nano-tests/run.sh is not documentation (it is the only one of 4 changed files that is not documentation)");
  });

  it("counts every code file but names the first", () => {
    const out = classify(["docs/a.md", "src/a.ts", "src/b.ts", "package.json"]);
    expect(out.hardware).toBe("true");
    expect(out.reason).toBe("src/a.ts is not documentation (3 of 4 changed files are not documentation)");
  });

  it("judges both sides of a rename: code moved into docs/ still needs a board", () => {
    // The workflow lists `filename` and `previous_filename` for a rename.
    expect(classify(["docs/old-helper.ts", "src/lib/old-helper.ts"]).hardware).toBe("true");
  });

  it("needs a board when no file is listed", () => {
    for (const input of ["", "\n\n", "\r\n"]) {
      const out = classify(input);
      expect(out.hardware).toBe("true");
      expect(out.reason).toMatch(/^no changed files were listed/);
    }
  });

  it("needs a board when the list is partial, even if every listed file is a doc", () => {
    const out = classify(["docs/a.md", "README.md"], ["--partial"]);
    expect(out.hardware).toBe("true");
    expect(out.reason).toMatch(/^the list of changed files is incomplete/);
  });

  it("names the code file over a partial list", () => {
    const out = classify(["docs/a.md", "src/a.ts"], ["--partial"]);
    expect(out.hardware).toBe("true");
    expect(out.reason).toMatch(/^src\/a\.ts is not documentation/);
  });

  it("reads CRLF lines, blank lines and a last line with no newline", () => {
    expect(classify("docs/a.md\r\n\r\nREADME.md").hardware).toBe("false");
    expect(classify("docs/a.md\r\nsrc/x.ts").hardware).toBe("true");
  });

  it("refuses an unknown argument instead of guessing", () => {
    const out = classify(["docs/a.md"], ["--docs-only"]);
    expect(out.status).toBe(2);
    expect(out.lines).toEqual([]);
    expect(out.stderr).toMatch(/usage:/);
  });
});
