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

/**
 * HERMES' OWN ANSWER to "what did the running process load", on the socket
 * ClawBox already dials. `plugins.list` is a method on the pinned Hermes
 * (`tui_gateway/methods_tools.py`), built from `get_plugin_manager()._plugins`
 * — the process's own registry rather than a log of what it once printed.
 * `null` is a box whose dashboard could not be reached.
 */
const rpcMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: rpcMock }));

import {
  _resetHermesPluginNameMemoForTests,
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
 * THE OTHER WRITER ON THE BOX, and the layout that made the reader answer
 * nothing at all.
 *
 * Hermes' own dumper forces `indentless=False`, so its list items sit two
 * columns further in than `enabled:` — that is {@link CONFIG_WITH}, and it is
 * what every fixture used to assume. `scripts/register-mcp.sh` re-serialises
 * the WHOLE file with plain `yaml.safe_dump`, and PyYAML's default in a mapping
 * context is an INDENTLESS block sequence: `enabled:` at column 2 and `- clawai`
 * at column 2 as well. Reproduced with the shipped flags (PyYAML 6.0.1):
 *
 *     plugins:
 *       enabled:
 *       - clawai
 *
 * Every box that script has ever had something to change carries this layout —
 * which is every box that got the EMAIL-directive hook.
 */
const CONFIG_INDENTLESS = (names: string[], rest = "") => `providers:
  clawai:
    api_key: redacted
plugins:
  enabled:
${names.map((n) => `  - ${n}`).join("\n")}
${rest}agents:
  defaults:
    model: claude-opus-5
`;

/**
 * The two questions ClawBox puts to the running dashboard, answered apart.
 *
 * `plugins.list` is the RUNNING registry — what this process actually holds,
 * keyed by registry key. `plugins.manage {action:"list"}` is Hermes' own plugin
 * DISCOVERY, and the only place the name↔key map exists: `manifest_key()` is
 * `manifest.key or manifest.name`, so a nested plugin's key says nothing about
 * the name a person enables it under. `manifests: null` is a box whose Hermes
 * has no such method — which must read as "could not establish", never as "no".
 */
function registryAnswers(opts: {
  running: { name: string; enabled?: boolean }[] | null;
  manifests?: { key: string; name: string }[] | null;
}): void {
  rpcMock.mockImplementation(async (method: string) => {
    if (method === "plugins.list") return opts.running ? { plugins: opts.running } : null;
    if (method === "plugins.manage") return opts.manifests ? { plugins: opts.manifests } : null;
    return null;
  });
}

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
  // The name↔key memo lives in the process store, so it is shared between the
  // cases in this file until it is put back.
  _resetHermesPluginNameMemoForTests();
  rpcMock.mockReset().mockResolvedValue(null);
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

  it("is not ended by a comment at column zero INSIDE it", () => {
    // YAML has no rule that a `#` closes a mapping, and `hermes config` and a
    // person editing by hand both leave them. Ending the extraction there cut
    // `disabled:` — the deny-list `_plugin_status` gives precedence to — out of
    // the signature entirely, so disabling a plugin changed nothing the watcher
    // could see and the box went on serving it.
    const yaml = [
      "plugins:",
      "  enabled:",
      "    - superpowers",
      "# the owner's own note about why the next one is off",
      "  disabled:",
      "    - noisy-plugin",
      "agents:",
      "  defaults:",
      "    model: claude-opus-5",
    ].join("\n");
    const block = hermesPluginsBlock(yaml);
    expect(block).toContain("disabled");
    expect(block).toContain("noisy-plugin");
    expect(block).not.toContain("agents");
    expect(block).not.toContain("claude-opus-5");
  });

  it("does not take a comment that FOLLOWS the block into it", () => {
    // The other direction: a comment sitting between the block and the next
    // top-level key belongs to what comes after, and swallowing it would make
    // an edit to that comment read as a plugin change.
    const withNote = hermesPluginsBlock([
      "plugins:",
      "  enabled:",
      "    - superpowers",
      "# a note about the agents block below",
      "agents:",
      "  defaults:",
      "    model: claude-opus-5",
    ].join("\n"));
    const without = hermesPluginsBlock([
      "plugins:",
      "  enabled:",
      "    - superpowers",
      "agents:",
      "  defaults:",
      "    model: claude-opus-5",
    ].join("\n"));
    expect(withNote).toBe(without);
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

  it("leaves a plugin's OWN `enabled:` list out of the declaration", async () => {
    // `plugins.entries.<id>` is a plugin's own settings, and the block
    // extraction keeps it deliberately out of the signature: a preference a
    // person changes is not a plugin set that changed. The key match ran at ANY
    // depth inside the block, though, so a plugin whose settings schema has a
    // LIST-valued key literally named `enabled` (or `disabled`) put its members
    // into the box's declaration — a ghost name no registry can ever resolve,
    // which is a permanent `stale`/`null`, and a signature that moves when a
    // preference does. The key belongs to `plugins:` only at the block's own
    // first indent level.
    writeHermesHome({
      installed: installRecord("clawai"),
      configYaml: `plugins:
  enabled:
    - clawai
  entries:
    thing:
      enabled:
        - ghost
      disabled:
        - phantom
agents:
  defaults:
    model: claude-opus-5
`,
    });
    const declared = await readHermesPluginDeclaration();
    expect(declared.enabled).toEqual(["clawai"]);
    expect(declared.names).toEqual(["clawai"]);
  });

  it("still reads a scalar `enabled:` under a plugin's entry as nothing", async () => {
    // The shape the box actually carries (`enabled: true`), which has always
    // yielded no names and must go on doing so.
    writeHermesHome({
      installed: installRecord("clawai"),
      configYaml: `plugins:
  enabled:
    - clawai
  entries:
    thing:
      enabled: true
agents:
  defaults:
    model: claude-opus-5
`,
    });
    expect((await readHermesPluginDeclaration()).enabled).toEqual(["clawai"]);
  });

  it("does not change the signature when only an unrelated setting changes", async () => {
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

  it("reads the enabled names out of PyYAML's INDENTLESS block sequence", async () => {
    // `scripts/register-mcp.sh` re-serialises config.yaml with plain
    // `yaml.safe_dump`, whose block sequences sit at the KEY'S indent rather
    // than deeper. The old rule accepted an item only when it was indented
    // FURTHER (`item[1].length > listIndent`), so on every box that script had
    // written, `plugins.enabled` read as EMPTY — and `stale`, which is
    // `enabled.some(...)`, was permanently false. The MCP tool then told the
    // owner "the agent now serving chat has read the current plugin set" about
    // a plugin that had never loaded: the exact false success this module's
    // null-handling exists to prevent, arriving through the other reader.
    writeHermesHome({
      installed: installRecord("superpowers"),
      configYaml: CONFIG_INDENTLESS(["clawai", "clawbox_email_directives", "superpowers"]),
    });
    const declared = await readHermesPluginDeclaration();
    expect(declared.enabled).toEqual(["clawai", "clawbox_email_directives", "superpowers"]);
  });

  it("gives ONE signature to the two layouts, so a re-serialisation is not a plugin change", async () => {
    // THE RESTART THAT NOTHING ASKED FOR. The signature used to hash the raw
    // `plugins:` text, and `register-mcp.sh` rewrites the whole file through
    // `yaml.safe_dump` whenever anything at all changed — spawned at every
    // web-server boot from `production-server.js` and again from the ClawBox-MCP
    // toggle in Settings. Its write normalises the block's indentation, so the
    // watcher saw "a signature I have not seen", bounced the dashboard, and the
    // owner's chat window closed with "The assistant restarted to load the
    // plugin …" over a plugin set that had not moved by one name.
    writeHermesHome({
      installed: installRecord("superpowers"),
      configYaml: CONFIG_WITH(["clawai", "superpowers"]),
    });
    const hermesLayout = await readHermesPluginDeclaration();
    writeHermesHome({
      installed: installRecord("superpowers"),
      configYaml: CONFIG_INDENTLESS(["clawai", "superpowers"]),
    });
    expect((await readHermesPluginDeclaration()).signature).toBe(hermesLayout.signature);
  });

  it("still changes the signature when the re-serialised set is DIFFERENT", async () => {
    // The other half of the rule above: hashing the parsed set must not make a
    // real change invisible, which would leave a plugin unloaded for ever with
    // the box reporting no work outstanding.
    writeHermesHome({ installed: {}, configYaml: CONFIG_WITH(["clawai"]) });
    const before = await readHermesPluginDeclaration();
    writeHermesHome({ installed: {}, configYaml: CONFIG_INDENTLESS(["clawai", "superpowers"]) });
    expect((await readHermesPluginDeclaration()).signature).not.toBe(before.signature);
  });

  it("changes the signature when an installed plugin is updated in place", async () => {
    // `hermes plugins update` pulls the plugin's git checkout and records the
    // new HEAD in `.install-metadata.json` — the plugin NAME does not move but
    // the code does, and the running process is holding the old one.
    const plugins = path.join(home, ".hermes", "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    const write = (revision: string) =>
      fs.writeFileSync(
        path.join(plugins, ".install-metadata.json"),
        JSON.stringify({ superpowers: { source: "git", revision } }),
      );
    write("a".repeat(40));
    const before = await readHermesPluginDeclaration();
    write("b".repeat(40));
    expect((await readHermesPluginDeclaration()).signature).not.toBe(before.signature);
  });

  it("does not take a trailing YAML comment for part of the plugin name", async () => {
    // `- superpowers # installed 2026-09-18` is ordinary YAML that a person
    // writes by hand. Read as the NAME "superpowers # installed 2026-09-18" it
    // matches no registry key ever, so `stale` is true for good — the MCP tool
    // warns "the plugin is NOT loaded yet" on a box that is serving it, and the
    // next config write bounces the owner's chat for a restart that cannot
    // change the answer.
    writeHermesHome({
      installed: {},
      configYaml: `plugins:
  enabled:
    - superpowers # installed 2026-09-18
    - "weird # name"
`,
    });
    expect((await readHermesPluginDeclaration()).enabled).toEqual(["superpowers", "weird # name"]);
  });

  it("reads a FLOW list, with or without a comment after it", async () => {
    // `hermes config set plugins.enabled '["a","b"]'` writes this shape. The
    // old expression required the `]` to be the last thing on the line, so a
    // comment after it dropped the whole list — and a genuinely stale plugin
    // went unreported.
    writeHermesHome({
      installed: {},
      configYaml: `plugins:
  enabled: [superpowers, "clawai"] # owner note
`,
    });
    expect((await readHermesPluginDeclaration()).enabled).toEqual(["clawai", "superpowers"]);
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

  it("asks the HARNESS first, and never opens the journal when it answers", async () => {
    // Leverage the harness first. The journal scrape was a re-implementation of
    // a question Hermes answers natively, and the re-implementation did not
    // work on the box it was built for — the dashboard publishes no
    // registration lines at all there, so `loaded` was permanently null.
    writeHermesHome({ installed: installRecord("superpowers"), configYaml: CONFIG_WITH(["superpowers"]) });
    systemAnswers({ show: "InvocationID=abc123def456\nExecMainStartTimestampMonotonic=1000000\n", journal: "" });
    rpcMock.mockResolvedValue({
      plugins: [
        { name: "superpowers", version: "1.2.0", enabled: true },
        { name: "basic", version: "?", enabled: true },
      ],
    });

    const state = await readHermesPluginState();
    expect(rpcMock).toHaveBeenCalledWith("plugins.list", {}, expect.anything());
    expect(state.loaded).toEqual(["basic", "superpowers"]);
    // …and it is the registry, so `stale` can finally be a fact about the
    // RUNNING process rather than a guess from a file's mtime.
    expect(state.stale).toBe(false);
    expect(execFileMock.mock.calls.some((call) => String(call[0]).includes("journalctl"))).toBe(false);
  });

  it("does not count a plugin the running process has DISABLED as loaded", async () => {
    // `_plugins` holds every manifest discovery found, bundled ones included,
    // each with the verdict the config gave it. "Loaded" to the person asking
    // means the tools are in their chat.
    writeHermesHome({ installed: installRecord("superpowers"), configYaml: CONFIG_WITH(["superpowers"]) });
    registryAnswers({
      running: [{ name: "superpowers", enabled: false }],
      manifests: [{ key: "superpowers", name: "superpowers" }],
    });
    const state = await readHermesPluginState();
    // An answer with rows and none of them on is the registry saying "no", not
    // a box that could not be asked — so it is `[]` and the staleness that
    // follows is a fact.
    expect(state.loaded).toEqual([]);
    expect(state.stale).toBe(true);
  });

  it("falls back to the journal when the dashboard cannot be asked", async () => {
    writeHermesHome({ installed: installRecord("superpowers"), configYaml: CONFIG_WITH(["superpowers"]) });
    rpcMock.mockResolvedValue(null);
    systemAnswers({
      show: "InvocationID=abc123def456\nExecMainStartTimestampMonotonic=1000000\n",
      journal: "Plugin 'superpowers' registered tool: brainstorm\n",
    });
    expect((await readHermesPluginState()).loaded).toEqual(["superpowers"]);
  });

  it("says the process is BEHIND THE FILES when what the box declares is not in the registry", async () => {
    writeHermesHome({ installed: installRecord("superpowers"), configYaml: CONFIG_WITH(["superpowers"]) });
    registryAnswers({
      running: [{ name: "basic", enabled: true }],
      manifests: [{ key: "basic", name: "basic" }],
    });
    const state = await readHermesPluginState();
    expect(state.stale).toBe(true);
  });

  it("matches a declared name the way HERMES does — the whole key or the manifest name", async () => {
    // MEASURED ON THE OWNER'S BOX (2026-09-18). `plugins.list` answers the
    // registry key — `image_gen/clawai`, `superpowers/.hermes-plugin`,
    // `dashboard_auth/basic` — while `plugins.enabled` holds the name a person
    // wrote. Hermes' own matcher is `names = {manifest name, registry key}`
    // (`hermes_cli/plugins_cmd.py:_plugin_status`, and `manifest_key()` is
    // `manifest.key or manifest.name`), so the name↔key map is the missing
    // half — it comes from `plugins.manage {action:"list"}`, which carries both.
    writeHermesHome({
      installed: installRecord("superpowers"),
      configYaml: CONFIG_WITH(["clawai", "clawbox_email_directives", "superpowers"]),
    });
    registryAnswers({
      running: [
        { name: "image_gen/clawai", enabled: true },
        { name: "superpowers/.hermes-plugin", enabled: true },
        { name: "clawbox_email_directives", enabled: true },
        { name: "dashboard_auth/basic", enabled: true },
      ],
      manifests: [
        { key: "image_gen/clawai", name: "clawai" },
        { key: "superpowers/.hermes-plugin", name: "superpowers" },
        { key: "clawbox_email_directives", name: "clawbox_email_directives" },
        { key: "dashboard_auth/basic", name: "basic" },
      ],
    });
    expect((await readHermesPluginState()).stale).toBe(false);
  });

  it("matches a manifest name a PATH SEGMENT never could", async () => {
    // The case the segment rule could not reach and reported as behind for
    // ever: a plugin installed into a directory whose name differs from its
    // manifest `name`, enabled under the manifest name. The key carries
    // neither, so the segment rule answered "missing" on a box that was serving
    // it — the MCP tool's "the plugin is NOT loaded yet" over a working device,
    // and a chat restart at the next web-server boot that could not fix it.
    writeHermesHome({ installed: {}, configYaml: CONFIG_WITH(["weather"]) });
    registryAnswers({
      running: [{ name: "community/wx-tools", enabled: true }],
      manifests: [{ key: "community/wx-tools", name: "weather" }],
    });
    expect((await readHermesPluginState()).stale).toBe(false);
  });

  it("does not call a plugin loaded because its name is a PATH SEGMENT of some other key", async () => {
    // Looser than Hermes in the other direction: `clawai` is not loaded just
    // because some unrelated `image_gen/clawai` key exists whose manifest is
    // named something else. Reporting that as up to date is the false success
    // on the reader the MCP tool quotes to the owner.
    writeHermesHome({ installed: {}, configYaml: CONFIG_WITH(["clawai"]) });
    registryAnswers({
      running: [{ name: "image_gen/clawai", enabled: true }],
      manifests: [{ key: "image_gen/clawai", name: "openai_images" }],
    });
    expect((await readHermesPluginState()).stale).toBe(true);
  });

  it("asks for the name↔key map once and reuses it, but never remembers a box it could not ask", async () => {
    // `plugins.manage {action:"list"}` re-discovers every manifest from disk
    // and consults the catalogue, which is why this file budgets it at 15 s;
    // the deny-list branch made it ordinary rather than rare, so it is memoed.
    // Only a SUCCESSFUL map: remembering "could not be asked" would turn a
    // transient failure into a stale `null` verdict for the whole window.
    writeHermesHome({ installed: {}, configYaml: CONFIG_WITH(["weather"]) });
    registryAnswers({ running: [{ name: "community/wx-tools", enabled: true }], manifests: null });
    expect((await readHermesPluginState()).stale).toBeNull();
    const askedWhileUnanswered = rpcMock.mock.calls.filter((c) => c[0] === "plugins.manage").length;
    expect((await readHermesPluginState()).stale).toBeNull();
    expect(rpcMock.mock.calls.filter((c) => c[0] === "plugins.manage").length)
      .toBeGreaterThan(askedWhileUnanswered);

    registryAnswers({
      running: [{ name: "community/wx-tools", enabled: true }],
      manifests: [{ key: "community/wx-tools", name: "weather" }],
    });
    expect((await readHermesPluginState()).stale).toBe(false);
    const askedOnce = rpcMock.mock.calls.filter((c) => c[0] === "plugins.manage").length;
    expect((await readHermesPluginState()).stale).toBe(false);
    expect(rpcMock.mock.calls.filter((c) => c[0] === "plugins.manage").length).toBe(askedOnce);
  });

  it("answers NULL, never `true`, when the name↔key map could not be read", async () => {
    // A declared name that is not itself a registry key can only be resolved
    // through the manifest, and an older Hermes has no `plugins.manage`. "We
    // could not establish it" is the honest answer; `true` there would be a
    // permanent "behind the files" that re-arms a chat restart at every
    // web-server boot over a box nobody can prove anything about.
    writeHermesHome({ installed: {}, configYaml: CONFIG_WITH(["superpowers"]) });
    registryAnswers({ running: [{ name: "superpowers/.hermes-plugin", enabled: true }], manifests: null });
    expect((await readHermesPluginState()).stale).toBeNull();
  });

  it("does not call a plugin the box's own deny-list has switched off BEHIND the files", async () => {
    // MEASURED ON THE OWNER'S BOX (2026-09-18) and confirmed against Hermes'
    // `cmd_disable`: `hermes plugins disable superpowers` discards the KEY and
    // its leaf from `plugins.enabled` and adds the key to `plugins.disabled` —
    // the bare-name entry a person wrote stays behind. `_plugin_status` gives
    // the deny-list precedence, so the plugin is OFF and the running registry is
    // right not to have it. Reading `enabled` alone made `stale` true for good
    // on a box whose owner had deliberately switched a plugin off: the MCP tool
    // warned "the agent is still behind the files", and with `changedAfterStart`
    // re-armed by any Settings save the watcher's first look would bounce the
    // owner's chat at the next web-server boot, for a restart that cannot change
    // the answer.
    writeHermesHome({
      installed: {},
      configYaml: `plugins:
  enabled:
    - clawai
    - superpowers
  disabled:
    - superpowers/.hermes-plugin
`,
    });
    registryAnswers({
      running: [{ name: "image_gen/clawai", enabled: true }],
      manifests: [
        { key: "image_gen/clawai", name: "clawai" },
        { key: "superpowers/.hermes-plugin", name: "superpowers" },
      ],
    });
    expect((await readHermesPluginState()).stale).toBe(false);
  });

  it("never asks for the name↔key map when every declared name IS a registry key", async () => {
    // `plugins.manage list` re-discovers from disk and consults the live plugin
    // catalogue over the network; it is not a price the common box should pay.
    writeHermesHome({ installed: {}, configYaml: CONFIG_WITH(["superpowers"]) });
    registryAnswers({ running: [{ name: "superpowers", enabled: true }], manifests: [] });
    expect((await readHermesPluginState()).stale).toBe(false);
    expect(rpcMock.mock.calls.some((call) => call[0] === "plugins.manage")).toBe(false);
  });

  it("reports whether the files were touched after the dashboard started, apart from staleness", async () => {
    // The self-limiting half of the watcher's seed rule, and the reason it is a
    // separate field: it is an mtime, so a Settings save makes it true — but
    // once the dashboard has restarted, its start is newer than those files, so
    // a box whose declaration and registry can never agree cannot be bounced
    // twice for the same reason.
    writeHermesHome({ installed: installRecord("superpowers"), configYaml: CONFIG_WITH(["superpowers"]) });
    rpcMock.mockResolvedValue({ plugins: [{ name: "superpowers", enabled: true }] });
    // A dashboard that started long before this boot.
    systemAnswers({ show: "InvocationID=abc123def456\nExecMainStartTimestampMonotonic=1000\n" });
    expect((await readHermesPluginState()).changedAfterStart).toBe(true);
  });

  it("does not call a box stale because an unrelated Settings save rewrote config.yaml", async () => {
    // THE FALSE POSITIVE `stale` USED TO CARRY. It was
    // `max(mtime(ledger), mtime(config.yaml)) > dashboardStartedAt`, and
    // config.yaml is rewritten by every Settings save on this box and by the
    // dashboard's own ExecStartPre. An owner changing the assistant's model at
    // 14:00 made the MCP tool warn "the agent is still behind the files — the
    // plugin is NOT loaded yet" about a plugin that was loaded at 10:52.
    writeHermesHome({ installed: installRecord("superpowers"), configYaml: CONFIG_WITH(["superpowers"]) });
    rpcMock.mockResolvedValue({ plugins: [{ name: "superpowers", enabled: true }] });
    // A save well after the dashboard started, touching nothing about plugins.
    writeHermesHome({ configYaml: CONFIG_WITH(["superpowers"], "") });
    fs.utimesSync(path.join(home, ".hermes", "config.yaml"), new Date(), new Date());
    systemAnswers({ show: "InvocationID=abc123def456\nExecMainStartTimestampMonotonic=1000\n" });
    expect((await readHermesPluginState()).stale).toBe(false);
  });

  it("answers null for `stale` when neither the registry nor the journal can be read", async () => {
    // Never a guess in either direction: "could not be established" is a real
    // answer and the route and the MCP tool both word it as one.
    writeHermesHome({ installed: installRecord("superpowers"), configYaml: CONFIG_WITH(["superpowers"]) });
    rpcMock.mockResolvedValue(null);
    systemAnswers({ show: "", journal: "" });
    const state = await readHermesPluginState();
    expect(state.loaded).toBeNull();
    expect(state.stale).toBeNull();
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
