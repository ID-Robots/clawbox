import { readFile } from "fs/promises";
import path from "path";

import { findOpenclawBin } from "@/lib/openclaw-config";

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
 * The same file `scripts/gateway-pre-start.sh` reads first, for the reason it
 * measured: `openclaw --version` costs ~8 s on a shipped Orin against ~53 ms
 * for the manifest, and this is asked on the owner's Save path.
 *
 * THROUGH `findOpenclawBin()`, and that matters more than the read itself.
 * `src/lib/memory-shard.ts` already reads THIS file for THIS boundary, and its
 * own docblock states the invariant: "the two writers read one file and cannot
 * disagree about the generation". A private path here would have broken it —
 * `findOpenclawBin` searches the node dir, `$HOME/.npm-global/bin`,
 * `/usr/local/bin`, `/usr/bin` and every nvm version, so a box whose core is
 * anywhere but the first of those would be identified by one reader and called
 * unknown by the other, permanently. Consolidating the three readers of this
 * one fact — here, `memory-shard.ts`, and `installedOpenclawUsesSqliteAuthStore`
 * by CLI spawn — is recorded as a follow-up.
 */
function coreManifestPath(): string {
  const bin = process.env.OPENCLAW_BIN || findOpenclawBin();
  return path.join(path.dirname(bin), "..", "lib", "node_modules", "openclaw", "package.json");
}

/**
 * The boot script's own regex (`gateway-pre-start.sh`: `grep -oE
 * '^20[0-9]{2}\.[0-9]+\.[0-9]+'`), anchored at the START only and deliberately
 * so: a prerelease core is `2026.8.1-dev.3`, and the two writers have to put
 * that box in the same generation or one of them writes a key the other's
 * gateway refuses. Something that does not BEGIN with a date says nothing about
 * the generation and reads as `unknown`.
 *
 * ONE SOURCE, unlike the boot script, which falls back to a bounded `openclaw
 * --version` when the manifest cannot be read. That fallback costs ~8 s and
 * this is the Save path, so an unreadable manifest here means neither home is
 * written and the boot script claims the slot at the next start instead.
 */
const CORE_VERSION_RE = /^(20\d{2})\.(\d+)\.(\d+)/;

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
