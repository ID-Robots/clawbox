import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs bash: vitest's 5 s default is not enough on a loaded CI runner
// (src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Speculative decoding for the local model, through scripts/start-llamacpp.sh.
 *
 * Measured on a DGX Spark (GB10), llama.cpp 29c720e, Qwen3.6-35B-A3B UD-Q4_K_XL
 * from unsloth's -MTP GGUF, 512 tokens at temperature 0:
 *   no speculation                 66.9 tok/s
 *   --spec-type draft-mtp, n-max 2  94.4 tok/s (310 of 400 drafts accepted)
 *   --spec-type draft-mtp, n-max 3  93.6
 *   --spec-type draft-mtp, n-max 4  88.9
 * A model with its own multi-token-prediction head drafts for itself; an
 * EAGLE-3 or plain draft model is a second GGUF beside the first. The launcher
 * passed neither, so no box could have it whatever its .env said.
 */
const SCRIPT = path.join(process.cwd(), "scripts", "start-llamacpp.sh");

let dir: string;
let modelDir: string;
let argsFile: string;
let logPath: string;
let fakeServer: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-llamacpp-spec-"));
  modelDir = path.join(dir, "models");
  mkdirSync(modelDir);
  writeFileSync(path.join(modelDir, "model.gguf"), "GGUF");
  argsFile = path.join(dir, "args");
  logPath = path.join(dir, "server.log");
  fakeServer = path.join(dir, "llama-server");
  writeServer(CURRENT_HELP);
});

/** Lines of `llama-server --help` from the build the feature was proven on (29c720e). */
const CURRENT_HELP = [
  "--spec-draft-model, -md, --model-draft FNAME",
  "--spec-draft-n-max N                    number of tokens to draft for speculative decoding (default: 3)",
  "--spec-type none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,ngram-simple",
];
/** An older build, such as install.sh's pinned one, before any of it. */
const OLD_HELP = ["--model, -m FNAME", "--n-gpu-layers, -ngl N"];

function writeServer(help: string[]) {
  writeFileSync(fakeServer, [
    "#!/usr/bin/env bash",
    `if [ "\${1:-}" = "--help" ]; then printf '%s\\n' ${help.map((l) => `'${l}'`).join(" ")}; exit 0; fi`,
    `printf '%s\\n' "$@" > "${argsFile}"`,
    "",
  ].join("\n"));
  chmodSync(fakeServer, 0o755);
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function start(env: Record<string, string> = {}) {
  const r = spawnSync(
    "bash",
    [SCRIPT, modelDir, "org/repo", "model.gguf", "local-model", "127.0.0.1", "8080", logPath, fakeServer, "/nonexistent/hf", "32768"],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: dir, ...env } },
  );
  let args: string[] = [];
  try { args = readFileSync(argsFile, "utf8").trim().split("\n"); } catch { /* the server never ran */ }
  let log = "";
  try { log = readFileSync(logPath, "utf8"); } catch { /* no log */ }
  return { status: r.status, args, log };
}

/** The value that follows `flag` on the command line, or null. */
function argAfter(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] ?? null : null;
}

describe("start-llamacpp.sh speculative decoding", () => {
  it("is off unless .env asks for it", () => {
    const r = start();
    expect(r.args).toContain("--model");
    expect(r.args).not.toContain("--spec-type");
  });

  it("drafts with the model's own multi-token-prediction head", () => {
    const r = start({ LLAMACPP_SPEC_TYPE: "draft-mtp", LLAMACPP_SPEC_DRAFT_N_MAX: "2" });
    expect(argAfter(r.args, "--spec-type")).toBe("draft-mtp");
    expect(argAfter(r.args, "--spec-draft-n-max")).toBe("2");
    expect(r.log).toMatch(/speculative decoding: .*draft-mtp/);
  });

  it("loads an EAGLE-3 draft model from the model directory", () => {
    writeFileSync(path.join(modelDir, "eagle3.gguf"), "GGUF");
    const r = start({ LLAMACPP_SPEC_TYPE: "draft-eagle3", LLAMACPP_SPEC_DRAFT_FILE: "eagle3.gguf" });
    expect(argAfter(r.args, "--spec-type")).toBe("draft-eagle3");
    expect(argAfter(r.args, "--spec-draft-model")).toBe(path.join(modelDir, "eagle3.gguf"));
  });

  it("starts without speculation, and says why, when the draft model is missing", () => {
    const r = start({ LLAMACPP_SPEC_TYPE: "draft-eagle3", LLAMACPP_SPEC_DRAFT_FILE: "absent.gguf" });
    expect(r.args).toContain("--model");
    expect(r.args).not.toContain("--spec-type");
    expect(r.log).toMatch(/LLAMACPP_SPEC_DRAFT_FILE/);
  });

  it("never reads a draft model from outside the model directory", () => {
    writeFileSync(path.join(dir, "outside.gguf"), "GGUF");
    const r = start({ LLAMACPP_SPEC_TYPE: "draft-eagle3", LLAMACPP_SPEC_DRAFT_FILE: "../outside.gguf" });
    expect(r.args).not.toContain("--spec-type");
    expect(r.args.join(" ")).not.toContain("outside.gguf");
  });

  it("starts without speculation on a type llama-server would reject, instead of not starting", () => {
    // A typo in .env must not leave the box with no local model at all.
    const r = start({ LLAMACPP_SPEC_TYPE: "draft-mtpp" });
    expect(r.args).toContain("--model");
    expect(r.args).not.toContain("--spec-type");
    expect(r.log).toMatch(/Invalid LLAMACPP_SPEC_TYPE/);
  });

  it("starts without speculation on a llama-server too old to know it, asked of the binary itself", () => {
    // An older binary exits on an argument it does not know: .env alone must
    // never be able to cost the box its local model.
    writeServer(OLD_HELP);
    const r = start({ LLAMACPP_SPEC_TYPE: "draft-mtp", LLAMACPP_SPEC_DRAFT_N_MAX: "2" });
    expect(r.args).toContain("--model");
    expect(r.args).not.toContain("--spec-type");
    expect(r.args).not.toContain("--spec-draft-n-max");
    expect(r.log).toMatch(/does not support --spec-type draft-mtp/);
  });

  it("ignores a draft length that is not a small positive number", () => {
    for (const bad of ["0", "-1", "abc", "99"]) {
      const r = start({ LLAMACPP_SPEC_TYPE: "draft-mtp", LLAMACPP_SPEC_DRAFT_N_MAX: bad });
      expect(argAfter(r.args, "--spec-type")).toBe("draft-mtp");
      expect(r.args).not.toContain("--spec-draft-n-max");
      expect(r.log).toMatch(/Invalid LLAMACPP_SPEC_DRAFT_N_MAX/);
    }
  });
});
