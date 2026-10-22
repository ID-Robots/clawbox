#!/usr/bin/env node
/**
 * Where ClawBox pins the two harnesses it installs, and the one reader for them.
 *
 * OpenClaw — `config/openclaw-target.txt`, first whitespace-separated token.
 *   Every runtime reader already uses this file (install.sh, install-x64.sh,
 *   scripts/gateway-pre-start.sh, src/lib/updater.ts), and it cannot move: a
 *   deployed updater reads it off the branch it is about to update to
 *   (`git show <upstream>:config/openclaw-target.txt`), so a box running an
 *   older build must still find it there. The `OPENCLAW_VERSION` and
 *   `OPENCLAW_VERSION_FALLBACK` constants in the installers and the updater
 *   are fallbacks for a missing or unreadable file, and the updater's
 *   `OPENCLAW_STATE_SCHEMA_BY_VERSION` and `OPENCLAW_AGENT_SCHEMA_BY_VERSION`
 *   must carry the pin. The unit tests in
 *   src/tests/unit/harness-pins.test.ts fail when one of them disagrees.
 *
 * Hermes — the default of `HERMES_PIN_COMMIT` in install.sh: the 40-character
 *   commit the release tag points at (install.sh says why it is not the tag).
 *   The tag is named on the comment line above it; the `harness-contract` CI
 *   job checks upstream that the tag still points at that commit.
 *
 * `node scripts/harness-pins.mjs` prints both as JSON and exits 1 when either
 * cannot be read.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OPENCLAW_PIN_FILE = "config/openclaw-target.txt";
export const HERMES_PIN_FILE = "install.sh";

const HERMES_COMMIT_LINE = /^HERMES_PIN_COMMIT="\$\{HERMES_PIN_COMMIT:-([0-9a-fA-F]{40})\}"/m;
const HERMES_TAG_LINE = /^# Current pin: upstream tag (v\d[\w.-]*) /m;

/** The pinned OpenClaw version, or null when the pin file is missing or empty. */
export function readOpenclawPin(repoDir) {
  try {
    return fs.readFileSync(path.join(repoDir, OPENCLAW_PIN_FILE), "utf-8").trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

/** `{commit, tag}` of the pinned Hermes, or null when install.sh carries no pin line. */
export function readHermesPin(repoDir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(repoDir, HERMES_PIN_FILE), "utf-8");
  } catch {
    return null;
  }
  const commit = HERMES_COMMIT_LINE.exec(raw)?.[1];
  if (!commit) return null;
  return { commit, tag: HERMES_TAG_LINE.exec(raw)?.[1] ?? null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `node scripts/harness-pins.mjs [openclaw | hermes.commit | hermes.tag]`
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pins = { openclaw: readOpenclawPin(repoDir), hermes: readHermesPin(repoDir) };
  // Both reach a cache path and `npm install` in CI: only a version shape passes.
  if (!/^\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(pins.openclaw ?? "") || !pins.hermes?.tag) {
    console.error("harness-pins: a pin could not be read (see scripts/harness-pins.mjs)");
    process.exit(1);
  }
  const field = process.argv[2];
  const value = field ? field.split(".").reduce((o, k) => o?.[k], pins) : pins;
  if (value === undefined) {
    console.error(`harness-pins: no field ${field}`);
    process.exit(2);
  }
  process.stdout.write(typeof value === "string" ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
}
