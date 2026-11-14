#!/usr/bin/env node
// Live answer text for reasoning models on Chat Completions (TASK-2228).
//
// OpenClaw 2026.10.9's openai-completions transport (`@openclaw/ai`) reads the
// first native `reasoning_content` chunk as "this answer's phase is known only
// at the end": it stamps the message `openclawDelivery.textPhaseRequiresTerminal`
// and forces its reasoning-tag partitioner into strict mode, which releases no
// visible text before the stream ends. The core's message handler then drops
// live text for every Chat Completions message carrying that stamp. ClawBox AI
// (DeepSeek V4) streams its reasoning first, so every answer reached the chat
// as one delta after it was complete — the portal streamed it token by token.
//
// Upstream retired both in 2026.10.10 (compat record
// "assistant-text-phase-terminal-hint": "Omit textPhaseRequiresTerminal;
// unphased text is never retroactively classified"): the transport no longer
// stamps the message, no longer forces strict mode, and routes visible text
// through the same `pushVisible` an answer without reasoning takes. This makes
// exactly those two edits on the pinned core. Without the stamp the core's
// handler streams the text as it already does for every answer without
// reasoning, so nothing in the core itself is touched.
//
// ClawBox pins 2026.11.3 now, which carries upstream's fix: on it this reports
// "not needed" and writes nothing (checked against the published package). It
// stays for a box on 2026.10.9 — one that has not updated yet, or a rollback.
//
// Run by install.sh's openclaw_patch step (fresh installs, every update, a
// harness swap) as the user who owns the core:
//
//   node scripts/openclaw-reasoning-stream-patch.mjs <openclaw package root>
//
// Applied only to the @openclaw/ai versions it was verified on; anywhere else
// it reports and writes nothing. Exit 1 when a verified version does not have
// the expected shape (nothing is written then either) or the files could not
// be read or written.
import { chmodSync, chownSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Left where the stamp and the forced strict mode were, so a rerun knows. */
export const PATCH_MARKER = "/* clawbox: reasoning answers stream live (TASK-2228) */";

/** @openclaw/ai versions this was verified on, board-measured. */
export const VERIFIED_VERSIONS = ["2026.10.9"];

// beginReasoning's stamp and forced strict mode, whitespace-tolerant.
const STAMP_AND_STRICT = String.raw`if \(!output\.openclawDelivery\?\.textPhaseRequiresTerminal\) output\.openclawDelivery = \{\s*\.\.\.output\.openclawDelivery,\s*textPhaseRequiresTerminal: true\s*\};\s*if \(forceStrict \|\| reasoningTagTextPartitioner\.hasPending\(\)\) reasoningTagTextPartitioner\.markStrict\(\);`;
// Visible text in a chunk that also carries reasoning goes in strict (push).
const STRICT_ROUTING = String.raw`hasReasoningThinking \? reasoningTagTextPartitioner\.push\(part\.text\) : reasoningTagTextPartitioner\.pushVisible\(part\.text\)`;
const VISIBLE_ROUTING = "reasoningTagTextPartitioner.pushVisible(part.text)";

function count(source, pattern) {
  return [...source.matchAll(new RegExp(pattern, "g"))].length;
}

/**
 * One file's verdict:
 *   "patch"    — the 2026.10.9 shape, exactly once each; `source` is the patched text
 *   "patched"  — already carries the marker and neither hold is left
 *   "absent"   — neither hold is in this file
 *   "mismatch" — only part of the shape, or more than one of either: not touched
 */
export function patchTransportSource(source) {
  const stamps = count(source, STAMP_AND_STRICT);
  const routes = count(source, STRICT_ROUTING);
  if (source.includes(PATCH_MARKER)) {
    return { verdict: stamps === 0 && routes === 0 ? "patched" : "mismatch", source };
  }
  if (stamps === 0 && routes === 0) return { verdict: "absent", source };
  if (stamps !== 1 || routes !== 1) return { verdict: "mismatch", source };
  return {
    verdict: "patch",
    source: source
      .replace(new RegExp(STAMP_AND_STRICT), PATCH_MARKER)
      .replace(new RegExp(STRICT_ROUTING), VISIBLE_ROUTING),
  };
}

/**
 * Same directory, same owner and mode, then a rename: a gateway loading the
 * module never reads half a file. Written beside the real file, so a symlink
 * stays a symlink; the temporary file never outlives a failure.
 */
function writeInPlace(link, text) {
  const file = realpathSync(link);
  const st = statSync(file);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.clawbox-${process.pid}`);
  try {
    writeFileSync(tmp, text);
    // Not through writeFileSync's mode: that one is filtered by the umask.
    chmodSync(tmp, st.mode & 0o7777);
    try {
      chownSync(tmp, st.uid, st.gid);
    } catch {
      // Not root and not the owner: the rename below leaves our own uid, which
      // can only happen to a caller that could write the directory anyway.
    }
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Patch the transport under one OpenClaw package root. Returns
 * { result, version, files } where result is one of:
 *   "patched"          — written now
 *   "already"          — this core already carries the patch
 *   "not-needed"       — no hold anywhere (a core that fixed it, or never had it)
 *   "unverified"       — the hold is there but this version was never verified: left as is
 *   "mismatch"         — a verified version without the expected shape: left as is
 *   "no-transport"     — no @openclaw/ai package under this root
 */
export function patchOpenClawRoot(root, { verifiedVersions = VERIFIED_VERSIONS } = {}) {
  const pkgDir = path.join(root, "node_modules", "@openclaw", "ai");
  let version;
  try {
    version = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
  } catch {
    return { result: "no-transport", version: undefined, files: [] };
  }
  const dist = path.join(pkgDir, "dist");
  let names;
  try {
    names = readdirSync(dist).filter((name) => /\.m?js$/.test(name)).sort();
  } catch {
    return { result: "no-transport", version, files: [] };
  }
  const verdicts = names.map((name) => {
    const file = path.join(dist, name);
    return { file, ...patchTransportSource(readFileSync(file, "utf8")) };
  });
  const touched = verdicts.filter((v) => v.verdict !== "absent");
  const files = touched.map((v) => path.relative(root, v.file));
  if (!verifiedVersions.includes(version)) {
    if (touched.length === 0) return { result: "not-needed", version, files };
    return { result: touched.every((v) => v.verdict === "patched") ? "already" : "unverified", version, files };
  }
  if (touched.length === 0 || touched.some((v) => v.verdict === "mismatch")) return { result: "mismatch", version, files };
  const pending = touched.filter((v) => v.verdict === "patch");
  if (pending.length > 1) return { result: "mismatch", version, files };
  for (const v of pending) writeInPlace(v.file, v.source);
  return { result: pending.length ? "patched" : "already", version, files };
}

const MESSAGES = {
  patched: "applied",
  already: "already applied",
  "not-needed": "not needed (this core streams reasoning answers itself)",
  unverified: "not applied: this @openclaw/ai version was never verified with it",
  mismatch: "NOT applied: the transport does not have the expected shape",
  "no-transport": "not applied: no @openclaw/ai package found",
};

function main(argv) {
  const root = argv[0];
  if (!root) {
    console.error("usage: openclaw-reasoning-stream-patch.mjs <openclaw package root>");
    return 2;
  }
  let outcome;
  try {
    outcome = patchOpenClawRoot(path.resolve(root));
  } catch (error) {
    console.error(`  Reasoning stream patch: failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const where = outcome.files.length ? ` [${outcome.files.join(", ")}]` : "";
  console.log(`  Reasoning stream patch (@openclaw/ai ${outcome.version ?? "?"}): ${MESSAGES[outcome.result]}${where}`);
  return outcome.result === "mismatch" ? 1 : 0;
}

// Run as a script, not imported. Compared as real paths: node resolves its own
// URL through symlinks, argv[1] keeps the path the installer typed.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
