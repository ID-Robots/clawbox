import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// A configured provider entry in openclaw.json overrides OpenClaw's bundled
// model catalog outright. A V4 model that omits contextWindow therefore does
// NOT inherit the canonical 1M window — it resolves to the generic 200,000
// default. Confirmed on a real device on OpenClaw 2026.7.1 (2026-08-17):
// `openclaw models list` reported 200K with the field absent and 1M once it
// was written. Devices in the field are in one of three states (absent, an old
// explicit 128000, or a 200000 written back by an earlier run) and the boot
// migration has to fix all three without touching a cap someone set on purpose.
//
// These run the migration block out of the shipped .sh, not a copy of it, so
// the test fails if the real script drifts.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/** Pull the DeepSeek V4 model-normalisation block out of the .sh verbatim. */
function extractPolicy(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf("if isinstance(ds_models, list):");
  const end = src.indexOf("if changed:", start);
  if (start < 0 || end < 0) throw new Error("deepseek V4 model block not found");
  return src.slice(start, end);
}

const POLICY = hasPython3 ? extractPolicy() : "";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "v4-context-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type MigratedModel = {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  [key: string]: unknown;
};

/** Run the extracted block over a model list and return the migrated models. */
function migrate(models: Record<string, unknown>[]): MigratedModel[] {
  const file = path.join(dir, "models.json");
  writeFileSync(file, JSON.stringify(models));
  const program = [
    "import json, sys",
    "ds_models = json.load(open(sys.argv[1]))",
    "changed = False",
    POLICY,
    "print(json.dumps({'models': ds_models, 'changed': changed}))",
  ].join("\n");
  const out = JSON.parse(execFileSync("python3", ["-c", program, file], { encoding: "utf-8" }).trim());
  return out.models;
}

/** Same, but reporting whether the script decided a rewrite was needed. */
function migrateChanged(models: Record<string, unknown>[]): boolean {
  const file = path.join(dir, "models.json");
  writeFileSync(file, JSON.stringify(models));
  const program = [
    "import json, sys",
    "ds_models = json.load(open(sys.argv[1]))",
    "changed = False",
    POLICY,
    "print(json.dumps({'changed': changed}))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", program, file], { encoding: "utf-8" }).trim()).changed;
}

const V4_IDS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

describe.skipIf(!hasPython3)("gateway-pre-start.sh V4 context migration", () => {
  it.each(V4_IDS)("fills an absent contextWindow with 1M on %s", (id) => {
    const [m] = migrate([{ id, name: "ClawBox AI" }]);
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.maxTokens).toBe(393_216);
    expect(m.input).toEqual(["text"]);
  });

  it.each(V4_IDS)("replaces the old explicit 128K on %s", (id) => {
    const [m] = migrate([{ id, contextWindow: 128000 }]);
    expect(m.contextWindow).toBe(1_000_000);
  });

  it.each(V4_IDS)("raises the 384K output cap an earlier run wrote to the enforced 393,216 on %s", (id) => {
    // The first version of this migration shipped 384000. It is under the real
    // upstream ceiling, so boxes that already took it would keep a cap we chose
    // by rounding rather than by measuring.
    const [m] = migrate([{ id, maxTokens: 384000 }]);
    expect(m.maxTokens).toBe(393_216);
  });

  it.each(V4_IDS)("replaces the 200K fallback written back by an earlier run on %s", (id) => {
    const [m] = migrate([{ id, contextWindow: 200000 }]);
    expect(m.contextWindow).toBe(1_000_000);
  });

  it("migrates Flash and Pro in the same pass", () => {
    const models = migrate([
      { id: "deepseek-v4-flash", contextWindow: 128000 },
      { id: "deepseek-v4-pro" },
    ]);
    expect(models.map((m) => m.contextWindow)).toEqual([1_000_000, 1_000_000]);
  });

  it("is idempotent — a second run reports no change", () => {
    const once = migrate([{ id: "deepseek-v4-flash", contextWindow: 128000 }]);
    expect(migrateChanged(once)).toBe(false);
  });

  it("leaves a deliberate non-standard cap alone", () => {
    // 32K is not a value we ever shipped, so someone chose it — probably to fit
    // a smaller box. Overwriting it would be the migration overruling its owner.
    const [m] = migrate([{ id: "deepseek-v4-flash", contextWindow: 32000, maxTokens: 8192 }]);
    expect(m.contextWindow).toBe(32000);
    expect(m.maxTokens).toBe(8192);
  });

  it("does not touch models from other providers or other deepseek ids", () => {
    const models = migrate([{ id: "deepseek-chat", contextWindow: 65536 }]);
    expect(models[0].contextWindow).toBe(65536);
    expect(models[0].maxTokens).toBeUndefined();
    expect(models[0].input).toBeUndefined();
  });

  it("preserves unrelated fields it did not come to change", () => {
    const [m] = migrate([{
      id: "deepseek-v4-pro",
      name: "ClawBox AI Pro",
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }]);
    expect(m.name).toBe("ClawBox AI Pro");
    expect(m.reasoning).toBe(true);
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("replaces an input that is present but not a usable list", () => {
    const [m] = migrate([{ id: "deepseek-v4-flash", input: [] }]);
    expect(m.input).toEqual(["text"]);
  });
});
