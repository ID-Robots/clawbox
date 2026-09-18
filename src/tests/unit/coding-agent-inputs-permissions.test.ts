/**
 * The permission matrix around the files a run is GIVEN.
 *
 * From a live run: "the media folder is denied by permission settings for all
 * routes — Bash cp and Read both refused". That denial is CORRECT and stays:
 * the assistant's media folder sits inside the store holding this box's
 * gateway config, provider keys and session transcripts, and a run reading it
 * would read those too. What was missing was anywhere the asset could be read
 * FROM, so this pins both halves at once:
 *
 *   - the assistant's media folder stays denied to a run, read and write alike,
 *     and no owner rule can open it;
 *   - the inputs tree is readable — no deny rule covers it, and the run is
 *     started with a rule that allows the read;
 *   - the inputs tree is not a hole in the data/ containment: everything else
 *     under data/ stays exactly as denied as it was.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fsSync from "fs";
import osMod from "os";
import pathMod from "path";
import { saveEnv } from "@/tests/helpers/env";

let home = "";
let root = "";
let restoreEnv: () => void;

/**
 * ONE box for the whole file, made before anything is imported.
 *
 * Not a fresh temp root per test: `DATA_DIR` is resolved when config-store is
 * first loaded, and nothing here writes the store, so a second root would only
 * give the suite two spellings of the same folder — which is exactly how the
 * data/ assertion below first failed, comparing a path built from this test's
 * root against rules built from the previous one's.
 */
beforeAll(() => {
  restoreEnv = saveEnv("HOME", "CLAWBOX_ROOT", "OPENCLAW_HOME", "CLAWBOX_OPENCLAW_HOME");
  home = fsSync.realpathSync(fsSync.mkdtempSync(pathMod.join(osMod.tmpdir(), "coding-inputs-perm-")));
  root = pathMod.join(home, "clawbox");
  fsSync.mkdirSync(pathMod.join(root, "data", "coding-agent-inputs", "shared"), { recursive: true });
  fsSync.mkdirSync(pathMod.join(root, "data", "secrets"), { recursive: true });
  fsSync.writeFileSync(pathMod.join(root, "data", "config.json"), "{}");
  fsSync.mkdirSync(pathMod.join(home, ".openclaw", "media"), { recursive: true });
  fsSync.writeFileSync(pathMod.join(home, ".openclaw", "openclaw.json"), "{}");
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  delete process.env.OPENCLAW_HOME;
  delete process.env.CLAWBOX_OPENCLAW_HOME;
});

afterAll(() => {
  restoreEnv();
  fsSync.rmSync(home, { recursive: true, force: true });
});

/** True when a deny rule for `tool` covers `abs`, as a tree or as the file itself. */
function deniedFor(rules: readonly string[], tool: string, abs: string): boolean {
  return rules.some((rule) => {
    const m = new RegExp(`^${tool}\\(\\/(.+?)(\\/\\*\\*)?\\)$`).exec(rule);
    if (!m) return false;
    const target = `/${m[1]}`.replace(/\/+/g, "/");
    return m[2] ? abs === target || abs.startsWith(`${target}/`) : abs === target;
  });
}

/** The values of one variadic flag. */
function valuesOf(args: readonly string[], flag: string): string[] {
  const at = args.indexOf(flag);
  if (at < 0) return [];
  const out: string[] = [];
  for (let i = at + 1; i < args.length && !args[i].startsWith("--"); i++) out.push(args[i]);
  return out;
}

describe("the assistant's media folder", () => {
  it("stays denied to a run, for every file tool", async () => {
    const lib = await import("@/lib/coding-agent");
    const rules = lib.fileDenyRules();
    const picture = pathMod.join(home, ".openclaw", "media", "tool-image-generation", "chart.png");
    for (const tool of ["Read", "Edit", "Write", "Glob", "Grep"]) {
      expect(deniedFor(rules, tool, picture), `${tool} should be denied there`).toBe(true);
    }
  });

  it("cannot be opened by an owner permission rule either", async () => {
    const lib = await import("@/lib/coding-permission-rules");
    const verdict = lib.validateAllowRule(`Read(/${pathMod.join(home, ".openclaw", "media")}/**)`, [], {
      denyRules: (await import("@/lib/coding-agent")).fileDenyRules(),
      homeDir: home,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? null : verdict.code).toBe("protected");
  });
});

describe("the inputs tree", () => {
  it("is not covered by any deny rule, for reading or for writing", async () => {
    const lib = await import("@/lib/coding-agent");
    const inputs = await import("@/lib/coding-run-inputs");
    const rules = lib.fileDenyRules();
    const staged = pathMod.join(inputs.runInputsDir("run-abc12345"), "chart.png");
    const shared = pathMod.join(inputs.sharedInputsDir(), "logo.svg");
    for (const tool of ["Read", "Edit", "Write"]) {
      expect(deniedFor(rules, tool, staged), `${tool} should reach a staged input`).toBe(false);
      expect(deniedFor(rules, tool, shared), `${tool} should reach the shared folder`).toBe(false);
    }
  });

  it("is allowed explicitly, because a headless run cannot answer a read prompt", async () => {
    const lib = await import("@/lib/coding-agent");
    const inputs = await import("@/lib/coding-run-inputs");
    const allowed = valuesOf(lib.buildRunArgs({}), "--allowedTools");
    expect(allowed).toContain(`Read(/${inputs.inputsRoot()}/**)`);
    // Before the owner's own rules, which stay last — see the allow-rules suite.
    expect(allowed).toContain(lib.TMP_READ_RULE);
  });

  it("opens nothing else under data/", async () => {
    const lib = await import("@/lib/coding-agent");
    const rules = lib.fileDenyRules();
    expect(deniedFor(rules, "Read", pathMod.join(root, "data", "config.json"))).toBe(true);
    expect(deniedFor(rules, "Read", pathMod.join(root, "data", "secrets", "x"))).toBe(true);
  });
});

describe("what the run is told", () => {
  it("names the folder, the files in it and the media folder it cannot reach", async () => {
    const lib = await import("@/lib/coding-agent");
    const inputs = await import("@/lib/coding-run-inputs");
    const dir = inputs.ensureInputsDirs("run-ccc33333");
    fsSync.writeFileSync(pathMod.join(dir, "chart.png"), "png");
    const note = lib.runInputsNote({
      id: "run-ccc33333",
      inputs: { dir, shared: inputs.sharedInputsDir(), files: [{ name: "chart.png", bytes: 3 }], refused: [] },
    });
    expect(note).toContain(dir);
    expect(note).toContain("chart.png");
    // The standing facts live in the brief, which every run gets; the note
    // stays to the one thing that differs per run.
    expect(note).not.toContain("media folder");
  });

  it("says plainly that nothing was handed over, and names what was refused", async () => {
    const lib = await import("@/lib/coding-agent");
    const inputs = await import("@/lib/coding-run-inputs");
    const note = lib.runInputsNote({
      id: "run-ddd44444",
      inputs: {
        dir: inputs.runInputsDir("run-ddd44444"),
        shared: inputs.sharedInputsDir(),
        files: [],
        refused: [{ name: "chart.png", code: "outside_roots" }],
      },
    });
    expect(note).toContain("no files were given to this run");
    expect(note).toContain("chart.png (outside_roots)");
  });

  it("tells the brief where inputs are, so a run stops hunting for the original", async () => {
    const lib = await import("@/lib/coding-agent");
    expect(lib.HEADLESS_BRIEF).toContain("CLAWBOX_RUN_INPUTS_DIR");
    expect(lib.HEADLESS_BRIEF).toContain("assistant's own media folder is NOT readable");
  });

  it("puts the folder in the run's own environment", async () => {
    const lib = await import("@/lib/coding-agent");
    const inputs = await import("@/lib/coding-run-inputs");
    const env = lib.buildRunEnv({ inputsDir: inputs.runInputsDir("run-abc12345") });
    expect(env.CLAWBOX_RUN_INPUTS_DIR).toBe(inputs.runInputsDir("run-abc12345"));
  });
});
