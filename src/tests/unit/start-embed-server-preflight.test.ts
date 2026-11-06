import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedStopReasonFromLog } from "@/lib/embed-server";

/**
 * scripts/start-embed-server.sh asks llama-server which flags it takes before
 * it execs it (TASK-2166). A field box was on a llama-server older than the
 * script — May's build has no server `--embd-normalize` — and the unit died
 * on its first line with "error: invalid argument: --embd-normalize", which is
 * all the proxy and Settings → Local AI could then say.
 *
 * These run the real script against a fake llama-server whose --help is cut
 * from llama.cpp's own help layout (option column, then the description from
 * column 41), so the parser meets the shape it meets on the box.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SCRIPT = path.join(process.cwd(), "scripts/start-embed-server.sh");

/** One help line in llama.cpp's layout: options padded to 40 columns. */
function opt(names: string, text: string): string {
  return `${names.padEnd(40)}${text}`;
}

const HELP_LINES: Record<string, string> = {
  "--host": opt("--host HOST", "ip address to listen, or bind to an UNIX socket (default: 127.0.0.1)"),
  "--port": opt("--port PORT", "port to listen (default: 8080)"),
  "--alias": opt("-a,    --alias STRING", "set alias for model name (to be used by REST API)"),
  "--model": opt("-m,    --model FNAME", "model path to load"),
  "--embedding": opt("--embedding, --embeddings", "restrict to only support embedding use case; use only with dedicated"),
  "--pooling": opt("--pooling {none,mean,cls,last,rank}", "pooling type for embeddings, use model default if unspecified"),
  "--embd-normalize": opt("--embd-normalize N", "normalisation for embeddings (default: 2) (-1=none, 0=max absolute"),
  "--ctx-size": opt("-c,    --ctx-size N", "size of the prompt context (default: 4096, 0 = loaded from model)"),
  "--batch-size": opt("-b,    --batch-size N", "logical maximum batch size (default: 2048)"),
  "--ubatch-size": opt("-ub,   --ubatch-size N", "physical maximum batch size (default: 512)"),
  "--parallel": opt("-np,   --parallel N", "number of server slots (default: -1, -1 = auto)"),
  "--n-gpu-layers": opt("-ngl,  --gpu-layers, --n-gpu-layers N", "max. number of layers to store in VRAM (default: -1)"),
  "--fit": opt("-fit,  --fit [on|off]", "whether to adjust unset arguments to fit in device memory ('on' or 'off', default: 'on')"),
  "--flash-attn": opt("-fa,   --flash-attn [on|off|auto]", "set Flash Attention use ('on', 'off', or 'auto', default: 'auto')"),
  "--cache-type-k": opt("-ctk,  --cache-type-k TYPE", "KV cache data type for K"),
  "--cache-type-v": opt("-ctv,  --cache-type-v TYPE", "KV cache data type for V"),
  "--no-webui": opt("--no-webui", "Disable the Web UI (default: enabled)"),
};

/** The help of a build that has every flag but `without`. */
function help(without: string[] = []): string {
  return [
    "----- common params -----",
    "",
    opt("-h,    --help, --usage", "print usage and exit"),
    opt("--version", "show version and build info"),
    ...Object.entries(HELP_LINES).filter(([flag]) => !without.includes(flag)).map(([, line]) => line),
    // A description that MENTIONS a flag is not the flag: May's build has
    // this line and no --embd-normalize.
    opt("--embd-gemma-default", "use default EmbeddingGemma model (pair with --embd-normalize"),
    "                                        to compare against the reference)",
    // …and a wrapped description line that happens to START with a flag.
    "                                        --no-webui --cache-type-v belong to the server, not to this",
    "                                        (env: LLAMA_ARG_EMBD_GEMMA_DEFAULT)",
    "",
  ].join("\n");
}

let tmp: string;
let bin: string;
let log: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "embed-preflight-"));
  fs.mkdirSync(path.join(tmp, "models"));
  fs.writeFileSync(path.join(tmp, "models", "Qwen3-Embedding-0.6B-Q8_0.gguf"), "gguf");
  bin = path.join(tmp, "llama-server");
  log = path.join(tmp, "embed", "server.log");
  writeBinary(help(), "version: 10214 (db7d8b24b)");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The fake: --help and --version as given (each counted), anything else records its argv. */
function writeBinary(helpText: string, version: string, failToStart = false): void {
  fs.writeFileSync(path.join(tmp, "help.txt"), helpText);
  fs.writeFileSync(
    bin,
    `#!/bin/bash
echo "$1" >> "${tmp}/invocations"
${failToStart ? `echo "llama-server: error while loading shared libraries: libllama-server-impl.so: cannot open shared object file: No such file or directory" >&2; exit 127` : ""}
echo "ggml_cuda_init: found 1 CUDA devices (Total VRAM: 7607 MiB):" >&2
case "$1" in
  --help) cat "${tmp}/help.txt"; exit 0 ;;
  --version) echo "${version}"; echo "built with GNU 11.4.0 for Linux aarch64"; exit 0 ;;
esac
printf '%s\\n' "$@" > "${tmp}/argv"
`,
    { mode: 0o755 },
  );
}

function start(): { code: number; argv: string[] | null; lastLine: string; logText: string } {
  let code = 0;
  try {
    execFileSync("bash", [SCRIPT], {
      stdio: "ignore",
      env: {
        ...process.env,
        CLAWBOX_ROOT: tmp,
        EMBED_MODEL_DIR: path.join(tmp, "models"),
        EMBED_LOG_PATH: log,
        LLAMACPP_BIN: bin,
        HF_BIN: path.join(tmp, "no-hf"),
      },
    });
  } catch (e: unknown) {
    code = (e as { status?: number }).status ?? 1;
  }
  const argvFile = path.join(tmp, "argv");
  const argv = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, "utf8").trimEnd().split("\n") : null;
  fs.rmSync(argvFile, { force: true });
  const logText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  const lastLine = logText.trimEnd().split("\n").at(-1) ?? "";
  return { code, argv, lastLine, logText };
}

function invocations(flag: string): number {
  const file = path.join(tmp, "invocations");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l === flag).length : 0;
}

/** The value after `flag` in argv, or null when the flag is not there. */
function valueOf(argv: string[], flag: string): string | null {
  const at = argv.indexOf(flag);
  return at < 0 ? null : argv[at + 1];
}

describe("the embedder's pre-flight", () => {
  it("passes every flag to the pinned build", () => {
    const r = start();
    expect(r.code).toBe(0);
    expect(r.argv).not.toBeNull();
    expect(valueOf(r.argv!, "--embd-normalize")).toBe("2");
    expect(valueOf(r.argv!, "--fit")).toBe("off");
    expect(valueOf(r.argv!, "--pooling")).toBe("last");
    expect(r.argv).toContain("--no-webui");
    expect(r.logText).not.toMatch(/WARN/);
    expect(r.logText).toMatch(/^\[embed\] Starting llama-server \(embedding\)/m);
  });

  it("starts May's build without --embd-normalize — its vectors are L2-normalised by default — and says so", () => {
    writeBinary(help(["--embd-normalize"]), "version: 1 (f08f20a)");
    const r = start();
    expect(r.code).toBe(0);
    expect(r.argv).not.toContain("--embd-normalize");
    // Its value went with it, and nothing else moved.
    expect(r.argv!.filter((a) => a === "2")).toEqual([]);
    expect(valueOf(r.argv!, "--pooling")).toBe("last");
    expect(valueOf(r.argv!, "--fit")).toBe("off");
    expect(r.logText).toMatch(/WARN: this llama-server \(version: 1 \(f08f20a\)\) predates --embd-normalize; starting without it/);
  });

  it("drops --fit on a build that predates it: such a build never fits, which is what 'off' asks", () => {
    writeBinary(help(["--embd-normalize", "--fit"]), "version: 6100 (d2f8305)");
    const r = start();
    expect(r.code).toBe(0);
    expect(r.argv).not.toContain("--fit");
    expect(r.argv!.filter((a) => a === "off")).toEqual([]);
    expect(valueOf(r.argv!, "--flash-attn")).toBe("on");
  });

  it("refuses a build missing a flag the embedder needs, naming it and the fix on the log's last line", () => {
    writeBinary(help(["--no-webui", "--cache-type-v"]), "version: 1 (f08f20a)");
    const r = start();
    expect(r.code).toBe(1);
    expect(r.argv).toBeNull();
    expect(r.lastLine).toBe(
      "[embed] This box's llama-server (version: 1 (f08f20a)) is too old for the memory embedder: it does not accept --cache-type-v --no-webui. Updating ClawBox rebuilds llama.cpp at the version it pins.",
    );
    expect(r.logText).toMatch(/To rebuild it now: sudo bash .*\/install\.sh --step llamacpp_runtime/);
  });

  it("refuses a binary that does not start, with its own last word", () => {
    writeBinary(help(), "", true);
    const r = start();
    expect(r.code).toBe(1);
    expect(r.argv).toBeNull();
    expect(r.lastLine).toMatch(/^\[embed\] This box's llama-server does not start: .*cannot open shared object file/);
  });

  it("asks a binary once, and again only when the binary is replaced", () => {
    start();
    start();
    expect(invocations("--help")).toBe(1);
    expect(invocations("--version")).toBe(1);
    // A rebuild is a new file.
    writeBinary(help(["--embd-normalize"]), "version: 1 (f08f20a)");
    const r = start();
    expect(invocations("--help")).toBe(2);
    expect(r.argv).not.toContain("--embd-normalize");
  });

  it("leaves the verdict to the server when the help names no flags at all", () => {
    writeBinary("usage: llama-server [options]\n", "version: 10214 (db7d8b24b)");
    const r = start();
    expect(r.code).toBe(0);
    expect(valueOf(r.argv!, "--embd-normalize")).toBe("2");
  });
});

describe("what Settings → Local AI shows of a refusal", () => {
  it("is the last line, without the prefix and without a path", () => {
    expect(embedStopReasonFromLog([
      "[embed] Starting llama-server (embedding) with /home/clawbox/clawbox/data/embed/models/Qwen3-Embedding-0.6B-Q8_0.gguf ngl=99 batch=1024",
      "error: invalid argument: --embd-normalize",
      "",
    ].join("\n"))).toBe("error: invalid argument: --embd-normalize");

    expect(embedStopReasonFromLog(
      "[embed] Missing local model at /home/clawbox/clawbox/data/embed/models/Qwen3-Embedding-0.6B-Q8_0.gguf and Hugging Face CLI at /home/clawbox/.local/bin/hf. Run the embed_model step.\n",
    )).toBe("Missing local model at Qwen3-Embedding-0.6B-Q8_0.gguf and Hugging Face CLI at hf. Run the embed_model step.");

    expect(embedStopReasonFromLog("")).toBeNull();
    expect(embedStopReasonFromLog(`${"x".repeat(500)}\n`)?.length).toBe(300);
  });
});
