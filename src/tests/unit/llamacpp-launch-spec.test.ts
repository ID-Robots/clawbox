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

  /** The device's own project directory — CONFIG_ROOT's production default. */
  const BOX_ROOT = "/home/clawbox/clawbox";
  /** A root no cwd can be, so the pair discriminates wherever it runs. */
  const OTHER_ROOT = "/srv/clawbox-elsewhere";

  it("resolves the launcher script from the checkout, not from the cwd", async () => {
    // TWO checkouts, one process. A cwd-based spec answers the same path for
    // both, whatever the cwd happens to be, so one of these two lines fails for
    // it wherever the suite runs.
    //
    // Pinned that way rather than against `process.cwd()` itself: on a device
    // the checkout IS the cwd (`/home/clawbox/clawbox`) and vitest runs from the
    // project root, so a `not.toBe(join(process.cwd(), …))` line compares a
    // string with itself and goes RED over correct code — on the hardware these
    // suites are run on, and on no other machine. A guard against a cwd reader
    // must not itself depend on the cwd.
    const box = await loadWithRoot(BOX_ROOT);
    const boxSpec = box.getLlamaCppLaunchSpec("gemma4-e2b-it-q4_0");
    const elsewhere = await loadWithRoot(OTHER_ROOT);
    const elsewhereSpec = elsewhere.getLlamaCppLaunchSpec("gemma4-e2b-it-q4_0");

    expect(boxSpec.scriptPath).toBe(path.join(BOX_ROOT, "scripts", "start-llamacpp.sh"));
    expect(elsewhereSpec.scriptPath).toBe(path.join(OTHER_ROOT, "scripts", "start-llamacpp.sh"));
  });

  it("keeps the script and the runtime files it writes in one tree", async () => {
    const root = OTHER_ROOT;
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
