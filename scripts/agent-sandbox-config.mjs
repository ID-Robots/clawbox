#!/usr/bin/env node
// What ClawBox writes into OpenClaw's config for the agent tool sandbox
// (`agents.defaults.sandbox` and the sandbox tool policy), decided in ONE place
// for every writer that runs outside the web server:
//
//   node agent-sandbox-config.mjs plan  <device-store> <openclaw.json>
//       Prints `name=value` lines (values are single-line JSON or a word) for
//       install.sh and install-x64.sh, which write them with `openclaw config
//       set` so the pinned core validates them on every install and update.
//
//   node agent-sandbox-config.mjs apply <device-store> <openclaw.json>
//       Writes the same answer into openclaw.json itself, atomically and 0600,
//       for scripts/gateway-pre-start.sh. That script runs BEFORE the gateway,
//       so nothing is live to race, and a CLI call there costs 10 s of a
//       blocking ExecStartPre on a Nano; every other openclaw.json write in it
//       is made the same way, for the same reason.
//
// The posture is config/agent-sandbox.json, read from beside THIS file: when
// install.sh runs as root out of its root-owned mirror, both come from there.
// Settings (src/lib/agent-sandbox.ts) reads the same file and the same rules;
// src/tests/unit/agent-sandbox.test.ts holds the two to one answer.
//
// The rules:
//   * The owner's switch is OFF unless the device store holds exactly `true`.
//     A store that exists and cannot be read is "unknown": the mode the config
//     already has is kept, so a torn write can neither switch the sandbox on
//     nor take it away.
//   * The posture keys are ClawBox's and are put back on every run (the
//     512 MB cap is the decision, not a default). Anything else the owner set
//     under agents.defaults.sandbox, its docker or its browser block is kept.
//   * ClawBox's MCP tools are let through the sandbox tool policy by adding the
//     server's glob to `alsoAllow`, or to `allow` when the owner wrote one:
//     OpenClaw refuses both in the same scope.
//   * Never fatal. An unreadable openclaw.json is reported and left alone.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POSTURE_PATH = path.join(HERE, "..", "config", "agent-sandbox.json");
const MODES = new Set(["off", "non-main", "all"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadPosture() {
  return JSON.parse(fs.readFileSync(POSTURE_PATH, "utf8"));
}

/** "on" | "off" | "unknown" — the owner's switch as the device store holds it. */
export function switchState(storePath, posture = loadPosture()) {
  if (!storePath) return "off";
  let raw;
  try {
    raw = fs.readFileSync(storePath, "utf8");
  } catch (err) {
    return err && err.code === "ENOENT" ? "off" : "unknown";
  }
  let store;
  try {
    store = JSON.parse(raw);
  } catch {
    return "unknown";
  }
  if (!isPlainObject(store)) return "unknown";
  return store[posture.storeKey] === true ? "on" : "off";
}

/** { state: "ok" | "absent" | "unreadable", cfg } */
function readOpenclawConfig(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { state: "absent", cfg: {} };
    return { state: "unreadable", cfg: null, why: err && err.code ? err.code : String(err) };
  }
  try {
    const cfg = JSON.parse(raw);
    if (!isPlainObject(cfg)) return { state: "unreadable", cfg: null, why: "not an object" };
    return { state: "ok", cfg };
  } catch (err) {
    return { state: "unreadable", cfg: null, why: err instanceof Error ? err.message : String(err) };
  }
}

function currentSandbox(cfg) {
  const agents = isPlainObject(cfg.agents) ? cfg.agents : {};
  const defaults = isPlainObject(agents.defaults) ? agents.defaults : {};
  return isPlainObject(defaults.sandbox) ? defaults.sandbox : {};
}

/** The mode to write: the switch's, or — when the store is unknown — the one the box has. */
export function sandboxMode(sw, current, posture = loadPosture()) {
  if (sw === "on") return posture.modeWhenOn;
  if (sw === "off") return posture.modeWhenOff;
  return MODES.has(current.mode) ? current.mode : posture.modeWhenOff;
}

/** agents.defaults.sandbox as it should be: the posture over what is there, and the mode. */
export function desiredSandbox(cfg, sw, posture = loadPosture()) {
  const current = currentSandbox(cfg);
  const docker = { ...(isPlainObject(current.docker) ? current.docker : {}), ...posture.sandbox.docker };
  const browser = { ...(isPlainObject(current.browser) ? current.browser : {}), ...posture.sandbox.browser };
  return { ...current, ...posture.sandbox, docker, browser, mode: sandboxMode(sw, current, posture) };
}

/**
 * The tool-policy write that lets ClawBox's MCP tools into a sandboxed turn,
 * or null when the policy already names them (or holds an `allow` that is not
 * a list, which only the owner can make sense of).
 */
export function desiredToolPolicy(cfg, posture = loadPosture()) {
  const glob = posture.mcpToolGlob;
  const tools = isPlainObject(cfg.tools) ? cfg.tools : {};
  const sandbox = isPlainObject(tools.sandbox) ? tools.sandbox : {};
  const policy = isPlainObject(sandbox.tools) ? sandbox.tools : {};
  if (Object.prototype.hasOwnProperty.call(policy, "allow")) {
    if (!Array.isArray(policy.allow) || policy.allow.includes(glob)) return null;
    return { key: "allow", value: [...policy.allow, glob] };
  }
  const also = Array.isArray(policy.alsoAllow) ? policy.alsoAllow : [];
  if (also.includes(glob)) return null;
  return { key: "alsoAllow", value: [...also, glob] };
}

/** Key-order-free JSON, so a config that is already right is not rewritten. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function child(parent, key) {
  if (!isPlainObject(parent[key])) parent[key] = {};
  return parent[key];
}

function writeAtomically(configPath, cfg) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.openclaw.sandbox.${process.pid}.tmp`);
  fs.rmSync(tmp, { force: true });
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, configPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function plan(storePath, configPath) {
  const posture = loadPosture();
  const sw = switchState(storePath, posture);
  const read = readOpenclawConfig(configPath);
  const lines = [`switch=${sw}`, `config=${read.state}`];
  if (read.state !== "unreadable") {
    const sandbox = desiredSandbox(read.cfg, sw, posture);
    lines.push(`mode=${sandbox.mode}`, `sandbox=${JSON.stringify(sandbox)}`);
    const policy = desiredToolPolicy(read.cfg, posture);
    if (policy) lines.push(`policy-key=${policy.key}`, `policy-value=${JSON.stringify(policy.value)}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function apply(storePath, configPath) {
  const posture = loadPosture();
  const sw = switchState(storePath, posture);
  const read = readOpenclawConfig(configPath);
  if (read.state === "unreadable") {
    process.stderr.write(
      `  WARN: ${path.basename(configPath)} could not be read (${read.why}); the agent tool sandbox settings are left as they are this boot\n`,
    );
    return;
  }
  const before = canonical(read.cfg);
  const cfg = JSON.parse(JSON.stringify(read.cfg));
  const defaults = child(child(cfg, "agents"), "defaults");
  defaults.sandbox = desiredSandbox(read.cfg, sw, posture);
  const policy = desiredToolPolicy(read.cfg, posture);
  if (policy) child(child(child(cfg, "tools"), "sandbox"), "tools")[policy.key] = policy.value;

  const mode = defaults.sandbox.mode;
  const said = sw === "unknown"
    ? `mode ${mode}, kept: the device store could not be read`
    : `mode ${mode}, the owner's switch is ${sw}`;
  if (canonical(cfg) === before) {
    process.stdout.write(`  Agent tool sandbox config already current (${said})\n`);
    return;
  }
  writeAtomically(configPath, cfg);
  process.stdout.write(`  Agent tool sandbox config written (${said})\n`);
}

// Realpaths on both sides: node resolves a symlinked script path for
// import.meta.url but not for argv[1], and a project dir reached through a
// link would otherwise exit 0 having printed and written nothing.
function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
const isMain = Boolean(process.argv[1]) && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url));
if (isMain) {
  const [command, storePath, configPath] = process.argv.slice(2);
  if (!configPath || (command !== "plan" && command !== "apply")) {
    process.stderr.write("usage: agent-sandbox-config.mjs plan|apply <device-store> <openclaw.json>\n");
    process.exit(64);
  }
  try {
    if (command === "plan") plan(storePath, configPath);
    else apply(storePath, configPath);
  } catch (err) {
    process.stderr.write(`  WARN: the agent tool sandbox settings could not be worked out (${err instanceof Error ? err.message : err})\n`);
    process.exit(1);
  }
}
