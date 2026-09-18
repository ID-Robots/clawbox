import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * "Installed" is not "loaded", and this file is where the two are told apart.
 *
 * The defect: the owner's assistant installed the `superpowers` Hermes plugin
 * and PROVED it works — in a fresh `hermes chat -q` process. The chat the owner
 * was actually looking at is served by `clawbox-hermes-dashboard.service`, a
 * process that had been up since before the install, and Hermes scans for
 * plugins exactly once per process (`discover_plugins(force=True)` at start,
 * `_ensure_plugins_discovered()` returning early ever after). So every surface
 * that reads `~/.hermes` said the plugin was there, and the one process whose
 * answer mattered had never seen it.
 *
 * A reader that says "installed" over that box is the false-success shape: it
 * reports the outcome from the fact that a file exists, not from the process
 * that has to have read it.
 */

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: execFileMock,
}));

import {
  hermesPluginsBlock,
  readHermesPluginDeclaration,
  readHermesPluginState,
} from "@/lib/hermes-plugin-set";

let home: string;
let restoreEnv: () => void;

/** `~/.hermes` as a box carries it: the install ledger plus config.yaml. */
function writeHermesHome(opts: {
  installed?: Record<string, unknown>;
  configYaml?: string;
}): void {
  const plugins = path.join(home, ".hermes", "plugins");
  fs.mkdirSync(plugins, { recursive: true });
  if (opts.installed !== undefined) {
    fs.writeFileSync(
      path.join(plugins, ".install-metadata.json"),
      JSON.stringify(opts.installed, null, 2),
    );
  }
  if (opts.configYaml !== undefined) {
    fs.writeFileSync(path.join(home, ".hermes", "config.yaml"), opts.configYaml);
  }
}

/** The shape `hermes plugins install` leaves behind, narrowed to what we read. */
function installRecord(name: string) {
  return { [name]: { source: "git", installed_at: "2026-09-18T12:59:00Z" } };
}

const CONFIG_WITH = (names: string[], rest = "") => `providers:
  clawai:
    api_key: redacted
plugins:
  enabled:
${names.map((n) => `    - ${n}`).join("\n")}
${rest}agents:
  defaults:
    model: claude-opus-5
`;

/**
 * What `systemctl show` and `journalctl` answer. Both are read through
 * `execFile`, so one mock serves both; anything unasked-for answers empty,
 * which is the "cannot be asked" every reader here has to survive.
 */
function systemAnswers(answers: { show?: string; journal?: string }): void {
  execFileMock.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: unknown) => {
    const done = typeof _opts === "function" ? _opts : cb;
    const stdout = bin.includes("systemctl") ? (answers.show ?? "") : (answers.journal ?? "");
    (done as (e: null, r: { stdout: string; stderr: string }) => void)(null, { stdout, stderr: "" });
    return undefined as never;
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-hermes-plugins-"));
  restoreEnv = saveEnv("HOME", "HERMES_HOME", "CLAWBOX_EDITION");
  process.env.HOME = home;
  delete process.env.HERMES_HOME;
  process.env.CLAWBOX_EDITION = "hermes";
  execFileMock.mockReset();
  systemAnswers({});
});

afterEach(() => {
  restoreEnv();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("hermesPluginsBlock", () => {
  it("takes the plugins: block and nothing else", () => {
    // THE WHOLE POINT of extracting a block rather than hashing config.yaml.
    // That file is rewritten by every Settings save on the box — a provider
    // key, a model change, a voice toggle — and a watcher keyed on the whole
    // file would bounce the box's chat backend on each one.
    const block = hermesPluginsBlock(CONFIG_WITH(["superpowers"]));
    expect(block).toContain("superpowers");
    expect(block).not.toContain("clawai");
    expect(block).not.toContain("claude-opus-5");
  });

  it("is stable when an unrelated key changes", () => {
    const before = hermesPluginsBlock(CONFIG_WITH(["superpowers"]));
    const after = hermesPluginsBlock(
      CONFIG_WITH(["superpowers"]).replace("claude-opus-5", "claude-fable-5"),
    );
    expect(after).toBe(before);
  });

  it("keeps the disabled deny-list, which decides loading just as much", () => {
    // `plugins.disabled` wins over `plugins.enabled` in Hermes' own
    // `_plugin_status`, so a box where the owner disabled a plugin has changed
    // its plugin set as surely as one that installed another.
    const block = hermesPluginsBlock(`plugins:
  enabled:
    - superpowers
  disabled:
    - noisy
`);
    expect(block).toContain("disabled");
    expect(block).toContain("noisy");
  });

  it("answers empty for a config with no plugins block", () => {
    expect(hermesPluginsBlock("agents:\n  defaults:\n    model: x\n")).toBe("");
  });

  it("does not mistake a nested plugins: key for the top-level one", () => {
    // `dashboard.hidden_plugins` and `plugins.entries.<id>` both put the word
    // further in. Only column zero is the block this watches.
    const block = hermesPluginsBlock(`dashboard:
  plugins:
    - not-this-one
agents:
  defaults:
    model: x
`);
    expect(block).toBe("");
  });
});

describe("readHermesPluginDeclaration", () => {
  it("names the plugins ~/.hermes declares", async () => {
    writeHermesHome({
      installed: installRecord("superpowers"),
      configYaml: CONFIG_WITH(["superpowers"]),
    });
    const declared = await readHermesPluginDeclaration();
    expect(declared.names).toEqual(["superpowers"]);
    expect(declared.signature).toMatch(/^[0-9a-f]{16,}$/);
  });

  it("gives an identical signature to a byte-identical rewrite", async () => {
    // A HASH, NOT AN MTIME, and this is the case that forces it: the dashboard's
    // own ExecStartPre re-provisions auth and rewrites config.yaml on every
    // start, so an mtime watcher would see a change the moment it restarted —
    // and restart again, for ever.
    writeHermesHome({
      installed: installRecord("superpowers"),
      configYaml: CONFIG_WITH(["superpowers"]),
    });
    const first = await readHermesPluginDeclaration();
    await new Promise((r) => setTimeout(r, 10));
    writeHermesHome({
      installed: installRecord("superpowers"),
      configYaml: CONFIG_WITH(["superpowers"]),
    });
    expect((await readHermesPluginDeclaration()).signature).toBe(first.signature);
  });

  it("changes the signature when a plugin is enabled", async () => {
    writeHermesHome({ installed: {}, configYaml: CONFIG_WITH([]) });
    const before = await readHermesPluginDeclaration();
    writeHermesHome({
      installed: installRecord("superpowers"),
      configYaml: CONFIG_WITH(["superpowers"]),
    });
    const after = await readHermesPluginDeclaration();
    expect(after.signature).not.toBe(before.signature);
    expect(after.names).toContain("superpowers");
  });

  it("changes the signature when an unrelated setting does not", async () => {
    writeHermesHome({
      installed: installRecord("superpowers"),
      configYaml: CONFIG_WITH(["superpowers"]),
    });
    const before = await readHermesPluginDeclaration();
    writeHermesHome({
      installed: installRecord("superpowers"),
      configYaml: CONFIG_WITH(["superpowers"]).replace("claude-opus-5", "claude-fable-5"),
    });
    expect((await readHermesPluginDeclaration()).signature).toBe(before.signature);
  });

  it("reads a box with no plugins at all without throwing", async () => {
    const declared = await readHermesPluginDeclaration();
    expect(declared.names).toEqual([]);
    expect(typeof declared.signature).toBe("string");
  });

  it("survives a half-written install ledger", async () => {
    // `hermes plugins install` writes this file; a watcher polling every few
    // seconds WILL catch it mid-write, and an exception there would take the
    // poll loop down for the life of the web server.
    const plugins = path.join(home, ".hermes", "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    fs.writeFileSync(path.join(plugins, ".install-metadata.json"), '{"superpowers":');
    const declared = await readHermesPluginDeclaration();
    expect(Array.isArray(declared.names)).toBe(true);
  });
});

describe("readHermesPluginState", () => {
  it("separates what is declared from what the running dashboard loaded", async () => {
    writeHermesHome({
      installed: installRecord("superpowers"),
      configYaml: CONFIG_WITH(["superpowers"]),
    });
    systemAnswers({
      show: "InvocationID=abc123def456\nExecMainStartTimestampMonotonic=1000000\n",
      // The journal of a dashboard that started BEFORE the install: it
      // registered the bundled auth plugin and nothing else.
      journal: "Plugin 'basic' registered dashboard-auth provider: basic (password)\n",
    });
    const state = await readHermesPluginState();
    expect(state.declared).toContain("superpowers");
    expect(state.loaded).not.toContain("superpowers");
  });

  it("reports a plugin the running dashboard did register", async () => {
    writeHermesHome({
      installed: installRecord("superpowers"),
      configYaml: CONFIG_WITH(["superpowers"]),
    });
    systemAnswers({
      show: "InvocationID=abc123def456\nExecMainStartTimestampMonotonic=1000000\n",
      journal: "Plugin 'superpowers' registered tool: brainstorm\n",
    });
    expect((await readHermesPluginState()).loaded).toContain("superpowers");
  });

  it("answers null — not [] — for a dashboard whose journal carries no registration lines", async () => {
    // MEASURED ON THE OWNER'S BOX (2026-09-18). Its dashboard's whole journal
    // for the current invocation is 187 lines of `sessions.changed` events and
    // the readiness banner, and not ONE `Plugin … registered` line — Hermes logs
    // those on its Python logger and this process does not route them out.
    //
    // A successful read that matched nothing is therefore NOT "no plugin
    // loaded": Hermes always registers the bundled `basic` dashboard-auth plugin
    // on a gated bind, so zero registration lines can only mean this box does not
    // publish them. Answering [] would have the route tell the owner that every
    // plugin on their working device is missing — the false-failure shape, on the
    // exact box this feature was built for.
    systemAnswers({
      show: "InvocationID=abc123def456\nExecMainStartTimestampMonotonic=1000000\n",
      journal: "HERMES_DASHBOARD_READY port=9119\n{\"jsonrpc\": \"2.0\", \"method\": \"event\"}\n",
    });
    writeHermesHome({ installed: installRecord("superpowers"), configYaml: CONFIG_WITH(["superpowers"]) });
    const state = await readHermesPluginState();
    expect(state.loaded).toBeNull();
    // …and the DECLARED half still answers, so the caller is not left with nothing.
    expect(state.declared).toContain("superpowers");
  });

  it("answers null for `loaded` when the journal cannot be read", async () => {
    // A BOX THAT CANNOT BE ASKED IS NOT A BOX WITH NO PLUGINS. An empty array
    // here would let the route report "superpowers is not loaded" over a
    // dashboard that had loaded it perfectly well and merely logs at a level
    // this cannot see — the false-failure shape, on the one reader whose job is
    // to be believed.
    execFileMock.mockImplementation((_b: string, _a: string[], _o: unknown, cb: unknown) => {
      const done = typeof _o === "function" ? _o : cb;
      (done as (e: Error) => void)(new Error("no journalctl"));
      return undefined as never;
    });
    writeHermesHome({ installed: installRecord("superpowers"), configYaml: CONFIG_WITH(["superpowers"]) });
    expect((await readHermesPluginState()).loaded).toBeNull();
  });
});
