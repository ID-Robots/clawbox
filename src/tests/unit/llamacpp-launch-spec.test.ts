import { afterEach, describe, expect, it, vi } from "vitest";
import path from "path";

/**
 * Where the llama.cpp launcher script comes from.
 *
 * `getLlamaCppLaunchSpec()` resolved `scripts/start-llamacpp.sh` from
 * `process.cwd()`. In production the cwd is `.next/standalone` — Next's
 * standalone `server.js` does `process.chdir(__dirname)` and
 * `config/clawbox-setup.service` starts `production-server.js`, which requires
 * that file — so the launcher was read out of the build output rather than out
 * of the checkout. It worked only because @vercel/nft happened to trace the
 * script into that tree; nothing copies `scripts/` there on purpose, and the
 * copy that is there only refreshes on a full rebuild.
 *
 * Everything else in the spec (pidPath, logPath, modelDir, modelPath) is
 * derived from `DATA_DIR`, i.e. from `CONFIG_ROOT`. The script was the one
 * field that was not, so the launcher and the runtime state it writes could be
 * read from two different trees. src/instrumentation-node.ts already resolves
 * `scripts/terminal-server.mjs` from CONFIG_ROOT for exactly this reason, and
 * src/tests/unit/instrumentation-terminal-server.test.ts pins it there.
 */
describe("getLlamaCppLaunchSpec", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Load the module with `root` as the box's project directory. */
  async function loadWithRoot(root: string) {
    vi.resetModules();
    vi.stubEnv("CLAWBOX_ROOT", root);
    return await import("@/lib/llamacpp-server");
  }

  it("resolves the launcher script from the checkout, not from the cwd", async () => {
    const root = "/home/clawbox/clawbox";
    const { getLlamaCppLaunchSpec } = await loadWithRoot(root);

    const spec = getLlamaCppLaunchSpec("gemma4-e2b-it-q4_0");

    expect(spec.scriptPath).toBe(path.join(root, "scripts", "start-llamacpp.sh"));
    // Belt and braces, and it is the assertion that bites ON A BOX: there the
    // checkout IS /home/clawbox/clawbox, so the line above would pass for a
    // cwd-based spec whose cwd happened to be the checkout. Naming the cwd
    // separately is what keeps the case honest wherever it runs.
    expect(spec.scriptPath).not.toBe(path.join(process.cwd(), "scripts", "start-llamacpp.sh"));
  });

  it("keeps the script and the runtime files it writes in one tree", async () => {
    const root = "/srv/clawbox-elsewhere";
    const { getLlamaCppLaunchSpec } = await loadWithRoot(root);

    const spec = getLlamaCppLaunchSpec("gemma4-e2b-it-q4_0");

    // The invariant the cwd broke: the launcher and the pid/log/model paths it
    // is handed have to come from the same install, or the script started is
    // one tree's and the state it writes is another's.
    for (const p of [spec.scriptPath, spec.pidPath, spec.logPath, spec.modelDir]) {
      expect(p.startsWith(`${root}/`), `${p} is not under ${root}`).toBe(true);
    }
  });
});
