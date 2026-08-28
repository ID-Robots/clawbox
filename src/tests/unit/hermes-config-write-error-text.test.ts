import fsActual from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `patchHermesConfig` fails in two ways, and BOTH of them reached the browser.
 *
 * It is the write path behind "save a local model" on a Hermes box:
 * hermes-local-ai.ts re-wraps whatever it throws as `HermesLocalApplyError`,
 * /setup-api/ai-models/configure returns that as `{ error: err.message }` under
 * a comment reading "Author-controlled, non-credential message — safe to echo",
 * and AIModelsStep renders it verbatim in the save banner.
 *
 *   1. The CLI FALLBACK, taken when the comment-preserving merge cannot handle
 *      the file: `hermes config set`'s raw stderr became the banner. Same class
 *      as #515's chat bubble, same Python CLI, different screen.
 *
 *   2. The MERGE path's own fs error, which is the COMMON case rather than the
 *      fallback — and the one shape that needs no traceback to leak the
 *      layout:
 *
 *        EACCES: permission denied, open '/home/clawbox/.hermes/config.yaml'
 *
 * The fs half is mocked rather than provoked, because the only portable way to
 * make a real read fail (a directory where the file should be) produces an
 * errno message with no path in it — which would make the assertion pass
 * without testing anything.
 */

const cliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/hermes-config-cache", () => ({ invalidateHermesConfigCache: vi.fn() }));

// Delegates to the real fs unless a test arms a failure, so the CLI-fallback
// case below runs against a genuine file on disk.
const fsState = vi.hoisted(() => ({ readFileFailure: null as NodeJS.ErrnoException | null }));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  const readFile = ((...args: unknown[]) =>
    fsState.readFileFailure
      ? Promise.reject(fsState.readFileFailure)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : (actual.readFile as any)(...args)) as typeof actual.readFile;
  const api = { ...actual, readFile };
  return { ...api, default: api };
});

const TRACEBACK = [
  "Traceback (most recent call last):",
  '  File "/home/clawbox/.hermes/cli/config.py", line 61, in set_value',
  '    raise PermissionError(13, "config.yaml")',
  "PermissionError: [Errno 13] Permission denied: '/home/clawbox/.hermes/config.yaml'",
].join("\n");

/** A file `yaml-block-edit` declines, so the write takes the CLI fallback. */
const MULTI_DOCUMENT = "---\nmodel:\n  provider: anthropic\n---\nother: 1\n";

let home: string;

async function loadModule() {
  vi.resetModules();
  return await import("@/lib/hermes-config-yaml");
}

async function messageFor(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the write to fail, and it did not");
}

beforeEach(async () => {
  cliMock.mockReset();
  fsState.readFileFailure = null;
  home = await fsActual.mkdtemp(path.join(os.tmpdir(), "hermes-config-err-"));
  process.env.HERMES_HOME = home;
});

afterEach(async () => {
  delete process.env.HERMES_HOME;
  fsState.readFileFailure = null;
  await fsActual.rm(home, { recursive: true, force: true });
});

describe("a Hermes config write that failed", () => {
  it("does not put `hermes config set`'s traceback in the save banner", async () => {
    await fsActual.writeFile(path.join(home, "config.yaml"), MULTI_DOCUMENT, { mode: 0o600 });
    cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: TRACEBACK });
    const { patchHermesConfig } = await loadModule();
    const message = await messageFor(() => patchHermesConfig({ set: { "model.default": "gemma-4" } }));
    // The fallback really was taken — otherwise this asserts nothing.
    expect(cliMock).toHaveBeenCalled();
    expect(message).not.toContain("/home/clawbox");
    expect(message).not.toContain('File "');
    expect(message).not.toContain("Traceback");
    expect(message.trim()).not.toBe("");
  });

  it("does not put the fs error's own path in the save banner", async () => {
    const err: NodeJS.ErrnoException = Object.assign(
      new Error("EACCES: permission denied, open '/home/clawbox/.hermes/config.yaml'"),
      { code: "EACCES", path: "/home/clawbox/.hermes/config.yaml" },
    );
    fsState.readFileFailure = err;
    const { patchHermesConfig } = await loadModule();
    const message = await messageFor(() => patchHermesConfig({ set: { "model.default": "gemma-4" } }));
    expect(message).not.toContain("/home/clawbox");
    expect(message.trim()).not.toBe("");
    // Never the fallback path either: an unreadable file is not something
    // `hermes config set` would do better at — it writes the same file.
    expect(cliMock).not.toHaveBeenCalled();
  });
});

describe("registering a local model when the config write failed", () => {
  it("does not carry the raw message through HermesLocalApplyError", async () => {
    // The wrapper is its own surface: it re-wraps `err.message` from ANY throw,
    // so it has to be safe on its own rather than on the promise that whoever
    // threw already cleaned it.
    vi.resetModules();
    vi.doMock("@/lib/hermes-config-yaml", () => ({
      patchHermesConfig: vi.fn(async () => {
        throw new Error("EACCES: permission denied, open '/home/clawbox/.hermes/config.yaml'");
      }),
      readHermesConfigValue: vi.fn(async () => null),
    }));
    vi.doMock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
    vi.doMock("@/lib/local-ai-token", () => ({ getLocalAiToken: () => "local-token-xyz" }));
    vi.doMock("@/lib/local-ai-runtime", () => ({
      getLocalAiProxyRootUrl: () => "http://127.0.0.1",
      getLocalAiOpenAiBaseUrl: () => "http://127.0.0.1/setup-api/local-ai/ollama/v1",
    }));
    vi.doMock("@/lib/config-store", () => ({ get: vi.fn(async () => null) }));
    const { applyLocalAiToHermes } = await import("@/lib/hermes-local-ai");
    const message = await messageFor(() =>
      applyLocalAiToHermes({ provider: "ollama", model: "gemma-4:e2b", makeDefault: true }));
    expect(message).not.toContain("/home/clawbox");
    expect(message.trim()).not.toBe("");
    vi.doUnmock("@/lib/hermes-config-yaml");
  });
});
