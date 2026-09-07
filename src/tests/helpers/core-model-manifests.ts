import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

/**
 * A throwaway OpenClaw home, plus the two places a provider manifest can live.
 *
 * Both suites that exercise `src/lib/core-model-lifecycle.ts` carried their own
 * copy of this scaffolding — the same three env vars saved and restored, the
 * same `mkdtemp`, the same `extensions/<provider>/openclaw.plugin.json` join —
 * and the copies had already drifted: one could write raw bytes and the other
 * only `JSON.stringify`ed ones, one knew the bundled `dist/extensions`
 * candidate and the other only neutralised it. One helper, so that where the
 * core keeps a manifest is written down once.
 *
 * `manifestPaths` reads `CLAWBOX_OPENCLAW_HOME` first, then `OPENCLAW_HOME`,
 * then `$HOME/.openclaw`, so all three are aimed at the fixture — pointing only
 * one leaves the lookup wherever the surrounding environment aimed it, and
 * `vitest.config.ts` deliberately aims them at empty directories.
 */
const ENV = ["HOME", "OPENCLAW_HOME", "CLAWBOX_OPENCLAW_HOME"];

export interface ManifestFixture {
  /**
   * An absolute `openclaw` binary path whose bundled candidate
   * (`<bin>/../lib/node_modules/openclaw/dist/extensions`) lands inside the
   * fixture. Hand it to whatever the suite has mocked `findOpenclawBin` with;
   * a bare name — what `findOpenclawBin` answers where no core is installed —
   * drops the bundled candidate entirely.
   */
  bin: string;
  /** A manifest where OpenClaw 2 puts an unbundled provider's: beside the config. */
  writeManifest(provider: string, body: unknown): void;
  /** The same file, byte for byte — for bytes `JSON.stringify` would repair. */
  writeRawManifest(provider: string, raw: string): void;
  /** A manifest bundled with the core, the candidate tried FIRST. */
  writeBundledManifest(provider: string, body: unknown): void;
  /** The same bundled file, byte for byte. */
  writeRawBundledManifest(provider: string, raw: string): void;
  /** Restore the environment and remove the temporary home. */
  cleanup(): void;
}

function writeFile(file: string, raw: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw);
}

export function createManifestFixture(prefix: string): ManifestFixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const restoreEnv = saveEnv(...ENV);
  process.env.HOME = home;
  process.env.OPENCLAW_HOME = path.join(home, ".openclaw");
  process.env.CLAWBOX_OPENCLAW_HOME = path.join(home, ".openclaw");

  const beside = (provider: string) =>
    path.join(home, ".openclaw", "extensions", provider, "openclaw.plugin.json");
  const bundled = (provider: string) =>
    path.join(home, "lib", "node_modules", "openclaw", "dist", "extensions", provider, "openclaw.plugin.json");

  return {
    bin: path.join(home, "bin", "openclaw"),
    writeManifest: (provider, body) => writeFile(beside(provider), JSON.stringify(body)),
    writeRawManifest: (provider, raw) => writeFile(beside(provider), raw),
    writeBundledManifest: (provider, body) => writeFile(bundled(provider), JSON.stringify(body)),
    writeRawBundledManifest: (provider, raw) => writeFile(bundled(provider), raw),
    cleanup: () => {
      restoreEnv();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** The module under test, with its manifest cache cleared. */
export async function loadLifecycle() {
  const mod = await import("@/lib/core-model-lifecycle");
  mod.resetCoreModelLifecycle();
  return mod;
}
