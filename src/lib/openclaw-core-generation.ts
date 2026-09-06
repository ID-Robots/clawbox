import { readFile } from "fs/promises";
import path from "path";

/**
 * Which generation of the OpenClaw core is INSTALLED on this box.
 *
 * `v2` is 2026.8 and later, the generation that renamed the config homes —
 * `agents.defaults.imageGenerationModel` → `agents.defaults.mediaModels.image`
 * among them — and refuses the other name outright, because `agents.defaults`
 * is `.strict()`. So writing the wrong home does not degrade politely in either
 * direction: it is `Unrecognized key` and gateway exit 78.
 *
 * `unknown` is a real answer and the only safe one when the core cannot be
 * identified. `scripts/gateway-pre-start.sh` states the rule this mirrors: a
 * partially finished update leaves the repository pin ahead of the binary,
 * which is exactly the state in which the core cannot be read — so guessing
 * from the pin would be wrong precisely when it matters. A caller that gets
 * `unknown` writes neither home.
 */
export type OpenclawCoreGeneration = "v1" | "v2" | "unknown";

/** 2026.8 is where the config homes moved. */
const V2_YEAR = 2026;
const V2_MONTH = 8;

/**
 * The package.json of the installed core, not `openclaw --version`.
 *
 * The same choice `scripts/gateway-pre-start.sh` makes and for the reason it
 * measured: `openclaw --version` costs ~8 s on a shipped Orin and the manifest
 * read is ~53 ms, and this is asked on the owner's Save path. Resolved from
 * `OPENCLAW_BIN` when it is set (the boot script exports it) and otherwise from
 * the canonical install, deliberately WITHOUT importing `findOpenclawBin`:
 * fifty-nine suites replace `@/lib/openclaw-config` with a hand-written
 * factory, and a helper that resolved to `undefined` under one of them would
 * answer `unknown` for every box.
 */
function coreManifestPath(): string {
  const bin = process.env.OPENCLAW_BIN
    || path.join(
      process.env.CLAWBOX_HOME_DIR || process.env.HOME || "/home/clawbox",
      ".npm-global",
      "bin",
      "openclaw",
    );
  return path.join(path.dirname(bin), "..", "lib", "node_modules", "openclaw", "package.json");
}

/**
 * ANCHORED, like the boot script's manifest read and for the same reason: this
 * is a version FIELD, so the whole string has to be the version. A dev build, a
 * fork or an `npm i -g <git url>` install yields something that is not a date,
 * which says nothing about the generation and must read as `unknown` rather
 * than sail past as v1.
 */
const CORE_VERSION_RE = /^(20\d{2})\.(\d+)\.(\d+)$/;

/** Never throws: an unreadable manifest is `unknown`, which is an answer. */
export async function installedOpenclawCoreGeneration(): Promise<OpenclawCoreGeneration> {
  let version: unknown;
  try {
    version = JSON.parse(await readFile(coreManifestPath(), "utf-8"))?.version;
  } catch {
    return "unknown";
  }
  if (typeof version !== "string") return "unknown";
  const match = CORE_VERSION_RE.exec(version.trim());
  if (!match) return "unknown";
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year > V2_YEAR || (year === V2_YEAR && month >= V2_MONTH) ? "v2" : "v1";
}
