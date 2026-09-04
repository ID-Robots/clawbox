import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * 0000 is a no-op for root, which reads anything — the unreadable case would
 * take the happy path and prove nothing. CI is non-root.
 */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

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

/** The same run, but reporting a non-zero exit instead of throwing on it. */
function loadRaw(cfgPath: string): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync(
    "python3",
    [
      "-c",
      `import json, os, sys, shutil, time\ncfg_path = sys.argv[1]${LOADER}\nprint(json.dumps(cfg))`,
      cfgPath,
    ],
    { encoding: "utf-8" },
  );
  return { status: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
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

  it("treats bytes that are not UTF-8 as corrupt, rather than tracing back", () => {
    // `json.load` raises UnicodeDecodeError — a ValueError, NOT a
    // JSONDecodeError and NOT an OSError — so a config holding arbitrary bytes
    // escaped all three arms and killed this bare top-level heredoc under
    // `set -euo pipefail`: no gateway, on every boot, until someone with shell
    // access fixed the file. The event that produces it is the SAME one the
    // .corrupt-<utc> copy exists for — a power loss mid-write on a Jetson
    // leaves arbitrary bytes, not a truncated but decodable string — so the
    // fixture that pinned the corrupt path (`'{not json'`, valid UTF-8) could
    // not see it. TASK-657.
    const torn = Buffer.concat([
      Buffer.from('{"gateway":{"port":18789},"models":'),
      Buffer.from([0xe9, 0xff, 0xfe]),
    ]);
    writeFileSync(cfgPath, torn);

    const { result, stderr } = load(cfgPath);

    expect(result).toEqual({});
    // The bytes are preserved exactly, which is the whole point of the copy.
    const backups = readdirSync(dir).filter((f) => f.startsWith("openclaw.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dir, backups[0]))).toEqual(torn);
    expect(readFileSync(cfgPath)).toEqual(torn);
    expect(stderr).toMatch(/WARN: openclaw\.json is not valid JSON/);
  });

  it.skipIf(isRoot)("does not take the boot down on a file it cannot read, and does not answer {}", () => {
    // `PermissionError` is not a subclass of `FileNotFoundError`, so it escaped
    // the one arm that was caught. This heredoc is a bare top-level command in
    // a script under `set -euo pipefail`, so the raise killed the whole
    // ExecStartPre: no gateway, on every boot, until someone with shell access
    // fixed the mode. openclaw.json is clawbox-owned and therefore writable
    // from a chat turn, which makes that an agent-reachable boot DoS — the same
    // class this change already closed for data/hostname.env and .mcp-token,
    // moved to the more central file, the one this script exists to edit.
    //
    // And answering `{}` is not the fix either: that object is written back a
    // few hundred lines below, so a config that merely could not be OPENED
    // would lose every provider, auth profile and channel.
    writeFileSync(cfgPath, JSON.stringify({ gateway: { port: 18789 }, models: { providers: { openai: {} } } }));
    chmodSync(cfgPath, 0o000);
    try {
      const r = loadRaw(cfgPath);
      expect(r.status, `the loader aborted the pre-start:\n${r.stderr}`).toBe(0);
      expect(r.stdout.trim(), "it answered {} for a file it could not read").toBe("");
      expect(r.stderr).toMatch(/could not be read/i);
      expect(r.stderr).toMatch(/leaving it exactly as it is/i);
      // Nothing beside it: this is not the corrupt-file path.
      expect(readdirSync(dir)).toEqual(["openclaw.json"]);
    } finally {
      chmodSync(cfgPath, 0o644);
    }
  });

  // The block runs with the script's own imports; a change there must move here.
  it("needs only what the script imports", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    expect(src).toMatch(/^import json, os, sys, tempfile, secrets, shutil, time$/m);
  });
});
