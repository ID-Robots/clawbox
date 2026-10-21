/**
 * The core block on disk, kept current. core-context.ts builds it; this
 * writes it to paths.ts `coreContextPath()`, where the ClawBox OpenClaw plugin
 * `clawbox-prime-radiant-core` reads it on every prompt build — so a new
 * block reaches the agent's next turn with no gateway restart.
 *
 * WHEN. After anything that moves the vault's `main` (reindex-hook.ts
 * `notifyVaultChanged`: a nightly merge, the owner's merge of a held night, a
 * verification, a revert), and when the owner changes the `context` setting.
 * The file is DELETED, never left stale, when the setting is off, the vault
 * is not initialised or no page is eligible: no file is how the plugin knows
 * to add nothing.
 *
 * ONE AT A TIME. A refresh asked for while one runs becomes one more run after
 * it, so two writers never land out of order and the last word is always the
 * setting as it stands (the run state lives in `processStore`: the route and
 * the nightly pass are separate module copies).
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import fs from "fs";
import path, { untraced } from "@/lib/runtime-path";
import { processStore } from "@/lib/process-store";
import { buildCoreContext } from "./core-context";
import { buildVaultGraph, graphPages, vaultRevision } from "./graph";
import { coreContextPath, vaultDir } from "./paths";
import { readSettings } from "./settings";
import { readVaultSnapshot, vaultInitialised } from "./vault";

/** Bumped when the file's shape changes; the plugin adds nothing from a format it does not know. */
export const CORE_CONTEXT_FORMAT = 1;

export interface CoreContextFile {
  format: typeof CORE_CONTEXT_FORMAT;
  /** The block exactly as the agent gets it. */
  text: string;
  pages: number;
  chars: number;
  estTokens: number;
  /** The vault revision it was built from. */
  revision: string | null;
  /** ISO 8601. */
  generatedAt: string;
}

/** The block on disk, or null when there is none (or it is not one this build reads). */
export function readCoreContextFile(): CoreContextFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(coreContextPath(), "utf8"));
  } catch {
    return null;
  }
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (o.format !== CORE_CONTEXT_FORMAT || typeof o.text !== "string" || o.text === "") return null;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    format: CORE_CONTEXT_FORMAT,
    text: o.text,
    pages: count(o.pages),
    chars: o.text.length,
    estTokens: count(o.estTokens),
    revision: typeof o.revision === "string" ? o.revision : null,
    generatedAt: typeof o.generatedAt === "string" ? o.generatedAt : "",
  };
}

/** No block: the plugin adds nothing from the next prompt build on. */
export function removeCoreContextFile(): void {
  fs.rmSync(coreContextPath(), { force: true });
}

function writeAtomically(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = untraced(`${file}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Build the block from the vault's `main` and write it — or remove it when
 * there is to be none. Answers what is on disk afterwards. Throws when the
 * vault cannot be read; the block on disk is then left as it was.
 */
export async function refreshCoreContext(): Promise<CoreContextFile | null> {
  const { context } = readSettings();
  const vault = vaultDir();
  if (!context.enabled || !(await vaultInitialised(vault))) {
    removeCoreContextFile();
    return null;
  }
  const revision = await vaultRevision(vault);
  const snapshot = await readVaultSnapshot(vault);
  const graph = buildVaultGraph(graphPages(snapshot), revision, snapshot.truncated);
  const block = buildCoreContext(graph, snapshot.pages, { n: context.n, maxChars: context.maxChars });
  // The owner may have switched it off while the vault was read.
  if (block.entries.length === 0 || !readSettings().context.enabled) {
    removeCoreContextFile();
    return null;
  }
  const file: CoreContextFile = {
    format: CORE_CONTEXT_FORMAT,
    text: block.text,
    pages: block.entries.length,
    chars: block.chars,
    estTokens: block.estTokens,
    revision,
    generatedAt: new Date().toISOString(),
  };
  writeAtomically(coreContextPath(), `${JSON.stringify(file)}\n`);
  return file;
}

const flight = processStore("prime-radiant:core-context", () => ({ running: null as Promise<void> | null, again: false }));

/**
 * Refresh the block, one run at a time. Resolves once the block on disk
 * reflects the vault and the setting as they were when this was called;
 * never rejects (a failure is logged and the block left as it was).
 */
export function scheduleCoreContextRefresh(): Promise<void> {
  if (flight.running) {
    flight.again = true;
    return flight.running;
  }
  const run = (async () => {
    try {
      do {
        flight.again = false;
        try {
          await refreshCoreContext();
        } catch (err) {
          console.warn("[prime-radiant] the core block was not refreshed:", err instanceof Error ? err.message : err);
        }
      } while (flight.again);
    } finally {
      flight.running = null;
    }
  })();
  flight.running = run;
  return run;
}
