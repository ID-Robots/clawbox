import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// F-15, the boot-time sibling. gateway-pre-start.sh loads openclaw.json, edits
// a few keys and writes the object back on every gateway start. A file that
// did not parse was answered with `{}` — deliberately, boot over refuse — but
// that `{}` is what gets written back, so one torn or corrupt file cost every
// provider, auth profile and channel, and the log said "Updated gateway
// config". The loader must copy the previous contents aside BEFORE it answers
// `{}`. The real function is extracted from the shipped script and run under
// python3, the same way the token-policy test does it.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");

const hasPython3 =
  spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

function extractLoader(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf("\ntry:\n    with open(cfg_path) as f:\n        cfg = json.load(f)\n");
  const end = src.indexOf("\n    cfg = {}\n\nchanged = False\n", start);
  if (start < 0 || end < 0) {
    throw new Error("config load block not found in gateway-pre-start.sh");
  }
  return src.slice(start, end + "\n    cfg = {}\n".length);
}

const LOADER = hasPython3 ? extractLoader() : "";

/** Run the loader against `cfgPath`; answers its JSON result and stderr. */
function load(cfgPath: string): { result: unknown; stderr: string } {
  const proc = spawnSync(
    "python3",
    [
      "-c",
      `import json, os, sys, shutil, time\ncfg_path = sys.argv[1]${LOADER}\nprint(json.dumps(cfg))`,
      cfgPath,
    ],
    { encoding: "utf-8" },
  );
  if (proc.status !== 0) throw new Error(`loader exited ${proc.status}: ${proc.stderr}`);
  return { result: JSON.parse(proc.stdout.trim()), stderr: proc.stderr };
}

describe.skipIf(!hasPython3)("gateway-pre-start.sh config load block", () => {
  let dir: string;
  let cfgPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "clawbox-prestart-"));
    cfgPath = path.join(dir, "openclaw.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers the file's JSON when it parses, and copies nothing", () => {
    writeFileSync(cfgPath, JSON.stringify({ gateway: { port: 18789 } }));

    expect(load(cfgPath).result).toEqual({ gateway: { port: 18789 } });
    expect(readdirSync(dir)).toEqual(["openclaw.json"]);
  });

  it("answers {} for a missing file with no backup (first run)", () => {
    expect(load(cfgPath).result).toEqual({});
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps a corrupt file's bytes beside it before answering {}", () => {
    const torn = '{"gateway":{"port":18789},"models":{"providers":{"openai":{"apiKey":"sk-te';
    writeFileSync(cfgPath, torn);

    const { result, stderr } = load(cfgPath);

    expect(result).toEqual({});
    const backups = readdirSync(dir).filter((f) => f.startsWith("openclaw.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dir, backups[0]), "utf-8")).toBe(torn);
    // The loader itself never touches the original; the script's later write does.
    expect(readFileSync(cfgPath, "utf-8")).toBe(torn);
    expect(stderr).toMatch(/WARN: openclaw\.json is not valid JSON/);
    expect(stderr).toContain(backups[0]);
  });

  // The block runs with the script's own imports; a change there must move here.
  it("needs only what the script imports", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    expect(src).toMatch(/^import json, os, sys, tempfile, secrets, shutil, time$/m);
  });
});
