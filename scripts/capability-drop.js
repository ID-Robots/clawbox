"use strict";
/**
 * The capability drop for programs the web server starts.
 *
 * On the Jetson, clawbox-setup.service gives the web server
 * CAP_NET_BIND_SERVICE (port 80), CAP_NET_ADMIN and CAP_NET_RAW (Wi-Fi) as
 * AMBIENT capabilities, and ambient capabilities survive execve of an ordinary
 * binary, so every child keeps them. The long-running helper programs it
 * starts need none of the three: the local chat server and its downloader, the
 * model library's download, the tunnel route's quick tunnel and each public
 * app link's quick tunnel. Through this they start under setpriv with the
 * ambient and inheritable sets emptied and no-new-privs set, the same
 * arguments the coding runner uses.
 *
 * The one implementation. production-server.js's CommonJS scripts require it
 * (scripts/public-app-links.js); the TypeScript side imports it through
 * src/lib/capability-drop.ts, which only re-exports it. A CommonJS file cannot
 * require TypeScript, so this side holds the code and the gate cannot drift
 * between the two.
 *
 * It fails OPEN, unlike the coding runner (which refuses a run without
 * setpriv, because a run executes an agent's commands): these programs are the
 * box's own local chat and published links, and stopping them over a missing
 * setpriv would break a working box. A skipped drop is never silent, though.
 *
 * This file is in the server build (through src/lib/capability-drop.ts), so
 * every fs call carries a turbopackIgnore hint and never takes a built path
 * directly: Turbopack turns an fs call it can partly resolve into a glob over
 * the project (src/lib/runtime-path.ts; capability-drop.test.ts checks it).
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");

const CAPABILITY_DROP_COMMAND = "setpriv";
/** @type {readonly string[]} */
const CAPABILITY_DROP_ARGS = [
  "--ambient-caps=-all",
  "--inh-caps=-all",
  "--no-new-privs",
  "--",
];
/** Where util-linux installs it; an absolute path, so the web server's PATH cannot pick another. */
const SETPRIV_PATH = "/usr/bin/setpriv";
const PROC_STATUS = "/proc/self/status";

/**
 * The settings production-server.js puts into its own environment for the web
 * server itself. None of the programs started through the drop uses them:
 * scripts/start-llamacpp.sh and what it runs (hf, llama-server), and
 * cloudflared.
 * @type {readonly string[]}
 */
const WEB_SERVER_OWN_SETTINGS = Object.freeze([
  "SESSION_SECRET",
  "CLAWBOX_TERMINAL_TOKEN",
  "CLAWBOX_MCP_TOKEN",
  "LOCAL_AI_TOKEN",
  "CLAWBOX_INTERNAL_TOKEN",
]);

/**
 * A copy of `env` without the web server's own settings; `env` itself is left
 * as it is (it may be process.env).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function withoutWebServerSettings(env) {
  const copy = { ...env };
  for (const key of WEB_SERVER_OWN_SETTINGS) delete copy[key];
  return copy;
}

/** @returns {string} */
function readOwnStatus() {
  return fs.readFileSync(/* turbopackIgnore: true */ PROC_STATUS, "utf8");
}

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(/* turbopackIgnore: true */ candidate).isFile()) return false;
    fs.accessSync(/* turbopackIgnore: true */ candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does this process hold any ambient capability? Anything unreadable or
 * unexpected is "no": that is the answer on a host whose web server was given
 * none (the x64 desktop, the DGX Spark), and those spawn exactly as before.
 *
 * @param {() => string} readStatus
 * @returns {boolean}
 */
function holdsAmbientCapabilities(readStatus) {
  let status;
  try {
    status = readStatus();
  } catch {
    return false;
  }
  const m = /^CapAmb:\s*([0-9a-fA-F]+)\s*$/m.exec(String(status));
  return m !== null && /[1-9a-fA-F]/.test(m[1]);
}

/**
 * The program's own path, as setpriv must be told it: an absolute path that is
 * an executable file, or the first PATH entry holding one. Otherwise `miss`
 * says why, so the caller spawns it unwrapped and a missing program still
 * fails with Node's own ENOENT through the site's 'error' listener.
 *
 * exec reads a relative program, or an empty or relative PATH entry, against
 * the CHILD's working directory, which the spawn may set. A path resolved here
 * against the web server's own directory could start a different file behind
 * setpriv, so the lookup stops at the first such entry instead of skipping it:
 * unwrapped, Node finds exactly what it always did. An empty PATH is one empty
 * entry.
 *
 * With PATH unset, exec searches a default list of its own, which this lookup
 * does not guess: the program starts unwrapped, found as it always was, and
 * the warning says PATH is not set.
 *
 * @param {string} bin
 * @param {Record<string, string | undefined>} env
 * @param {(p: string) => boolean} isExecutable
 * @returns {{ target: string } | { miss: string }}
 */
function resolveProgram(bin, env, isExecutable) {
  if (path.isAbsolute(bin)) return isExecutable(bin) ? { target: bin } : { miss: `${bin} not found` };
  if (bin.includes("/")) return { miss: `${bin} is a relative path` };
  if (env.PATH === undefined) return { miss: "PATH is not set" };
  for (const dir of String(env.PATH).split(":")) {
    if (!dir) return { miss: `PATH has an empty entry before any ${bin}` };
    if (!path.isAbsolute(dir)) return { miss: `PATH has the relative entry "${dir}" before any ${bin}` };
    const candidate = path.join(dir, bin);
    if (isExecutable(candidate)) return { target: candidate };
  }
  return { miss: `${bin} not found` };
}

/**
 * What to spawn for `bin argv`: the same two values on a host whose web server
 * holds no ambient capabilities, otherwise setpriv with the drop in front of
 * the program's resolved path. Synchronous, because a caller may allow no
 * await between its last check and the spawn (instrumentation-node.ts), and
 * asked afresh at every call — nothing is cached.
 *
 * setpriv execs the program in place, so the child's pid, its process group
 * (with `detached`) and its stdio are the program's own.
 *
 * A dropped start also gets an environment without the web server's own
 * settings (`env`, to spawn as the child's environment). Every other start
 * gets back exactly the `opts.env` it passed, none when it passed none, so it
 * spawns as before.
 *
 * @param {string} bin
 * @param {readonly string[]} argv
 * @param {{
 *   label: string,
 *   env?: NodeJS.ProcessEnv,
 *   probes?: { readStatus?: () => string, isExecutable?: (p: string) => boolean },
 * }} opts
 *   `label` names the program in a log line; `env` is the child's environment,
 *   whose PATH a bare name is looked up in (process.env when absent); `probes`
 *   are for tests.
 * @returns {{
 *   bin: string,
 *   argv: readonly string[],
 *   env: NodeJS.ProcessEnv | undefined,
 *   dropped: boolean,
 * }}
 */
function withCapabilityDrop(bin, argv, opts) {
  const probes = opts.probes || {};
  const readStatus = probes.readStatus || readOwnStatus;
  const isExecutable = probes.isExecutable || isExecutableFile;
  const unchanged = { bin, argv, env: opts.env, dropped: false };
  if (!holdsAmbientCapabilities(readStatus)) return unchanged;
  if (!isExecutable(SETPRIV_PATH)) {
    console.warn(`[capability-drop] setpriv not found: ${opts.label} starts with the web server's network capabilities`);
    return unchanged;
  }
  const env = opts.env || process.env;
  const program = resolveProgram(bin, env, isExecutable);
  if ("miss" in program) {
    console.warn(`[capability-drop] ${opts.label}: ${program.miss}, started without the drop`);
    return unchanged;
  }
  return {
    bin: SETPRIV_PATH,
    argv: [...CAPABILITY_DROP_ARGS, program.target, ...argv],
    env: withoutWebServerSettings(env),
    dropped: true,
  };
}

module.exports = {
  CAPABILITY_DROP_COMMAND,
  CAPABILITY_DROP_ARGS,
  SETPRIV_PATH,
  WEB_SERVER_OWN_SETTINGS,
  withoutWebServerSettings,
  withCapabilityDrop,
};
