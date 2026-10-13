import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeConfigGateway, runFakeOpenclawCli } from "@/tests/helpers/fake-config-gateway";

/**
 * ONE config write per request (TASK-1535): `withConfigWriteScope`,
 * `beginConfigWriteTransaction`, `configWriteBoundary` and the commit.
 *
 * The configure route used to make each of its openclaw.json writes on its
 * own — a CLI start apiece on a Jetson and a gateway reload after each — and a
 * ClawBox AI re-save was measured at 50 s. Inside a transaction the writers
 * STAGE, the readers see what is staged, and the commit is one exact
 * `config.patch`. What has to survive that is the route's error handling,
 * which it used to wrap around each `await`: these cases hold the commit to
 * the `try`/`catch` semantics a boundary stands for — including when the one
 * write cannot be made and every staged write is replayed one at a time.
 *
 * Same harness as `openclaw-config-gateway-write.test.ts`: the core's merge
 * over a real openclaw.json in a temp home, and the CLI behind a spawn mock.
 */

const state = vi.hoisted(() => ({
  gateway: null as import("@/tests/helpers/fake-config-gateway").FakeConfigGateway | null,
  unavailable: false,
  /** `config.get` asked while the gateway was down. */
  unavailableAsks: 0,
  cliRefuse: null as ((argv: readonly string[]) => string | null) | null,
  spawned: [] as string[][],
  file: "",
}));

vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>();
  return {
    ...actual,
    gatewayWsCall: async (method: string, params: Record<string, unknown>) => {
      if (state.unavailable || !state.gateway) {
        state.unavailableAsks += 1;
        throw new actual.GatewayWsUnavailableError("connect ECONNREFUSED");
      }
      return state.gateway.call(method, params);
    },
    gatewayWsPatchConfig: async (patch: Record<string, unknown>, options: { baseHash: string; replacePaths?: string[] }) => {
      if (state.unavailable || !state.gateway) throw new actual.GatewayWsUnavailableError("connect ECONNREFUSED");
      return state.gateway.patch(patch, options);
    },
  };
});

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: (_bin: string, argv: string[]) => {
    state.spawned.push(argv);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = stderr;
    child.stdin = { end: () => {}, write: () => {}, on: () => {} };
    child.kill = () => {};
    setTimeout(() => {
      const out = runFakeOpenclawCli(state.file, argv, state.cliRefuse ?? undefined);
      if (out.stderr) stderr.emit("data", Buffer.from(out.stderr));
      child.emit("close", out.code);
    }, 1);
    return child;
  },
}));

let lib: typeof import("@/lib/openclaw-config");
let home: string;

function writeFile(config: unknown): void {
  fs.writeFileSync(state.file, JSON.stringify(config, null, 2));
}

function readFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(state.file, "utf-8")) as Record<string, unknown>;
}

function cliCalls(): string[][] {
  return state.spawned.filter((argv) => argv[0] === "config");
}

/** A gateway that refuses any patch touching `models.<key>` — a schema refusal stand-in. */
async function refusePatchesTouching(key: string): Promise<void> {
  const { GatewayRpcError } = await import("@/lib/openclaw-gateway-ws");
  state.gateway!.refuseIf = (patch) => {
    const models = patch.models as Record<string, unknown> | undefined;
    return models && Object.hasOwn(models, key) ? new GatewayRpcError(`invalid config: models.${key}`, "INVALID_REQUEST") : null;
  };
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-write-tx-"));
  state.file = path.join(home, "openclaw.json");
  state.gateway = new FakeConfigGateway(state.file);
  state.unavailable = false;
  state.unavailableAsks = 0;
  state.cliRefuse = null;
  state.spawned = [];
  vi.stubEnv("CLAWBOX_OPENCLAW_HOME", home);
  vi.resetModules();
  lib = await import("@/lib/openclaw-config");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("a config write transaction", () => {
  it("stages every writer, shows what is staged to every reader, and lands it all as ONE config.patch", async () => {
    writeFile({
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash", fallbacks: ["llamacpp/gemma"] } } },
      models: { providers: { openai: { apiKey: "claw_x" } } },
    });
    await lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "anthropic/claude-opus-5"], { uid: process.getuid?.() });
      await lib.runOpenclawConfigSetBatch([
        ["agents.defaults.model.fallbacks", "[]", "--json"],
        ["models.mode", "merge"],
      ]);
      await lib.runOpenclawConfigUnset("models.providers.openai.apiKey");

      // Nothing has been written yet…
      expect(state.gateway!.patches).toEqual([]);
      expect(readFile()).toMatchObject({ agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } } });
      // …and a later step of the same request still reads what an earlier one wrote.
      const view = await lib.readConfig();
      expect(view).toEqual({
        agents: { defaults: { model: { primary: "anthropic/claude-opus-5", fallbacks: [] } } },
        models: { providers: { openai: {} }, mode: "merge" },
      });
      expect(await lib.readConfigStrict()).toEqual(view);
      expect(tx.pending).toBe(3);

      await tx.commit();
      expect(tx.committedAs).toBe("gateway");
    });
    expect(state.gateway!.patches).toHaveLength(1);
    expect(readFile()).toEqual({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-5", fallbacks: [] } } },
      models: { providers: { openai: {} }, mode: "merge" },
    });
    expect(cliCalls()).toEqual([]);
  });

  it("writes nothing for a save the file already holds — a re-save of the same credential", async () => {
    writeFile({ agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } }, models: { mode: "merge" } });
    const before = fs.readFileSync(state.file, "utf-8");
    let applied = 0;
    await lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await lib.configWriteBoundary({ onApplied: () => { applied += 1; } }, () =>
        lib.runOpenclawConfigSetBatch([
          ["agents.defaults.model.primary", "deepseek/deepseek-v4-flash"],
          ["models.mode", "merge"],
        ]));
      await tx.commit();
      expect(tx.committedAs).toBe("unchanged");
    });
    expect(state.gateway!.patches).toEqual([]);
    expect(fs.readFileSync(state.file, "utf-8")).toBe(before);
    expect(applied).toBe(1);
  });

  it("runs each boundary's onApplied at the commit, not before", async () => {
    writeFile({ models: {} });
    const events: string[] = [];
    await lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await lib.configWriteBoundary({ onApplied: () => { events.push("a applied"); } }, () =>
        lib.runOpenclawConfigSet(["models.mode", "merge"]));
      events.push("after a");
      await lib.configWriteBoundary({ onApplied: () => { events.push("b applied"); } }, () =>
        lib.runOpenclawConfigSet(["agents.defaults.model.primary", "a/b"]));
      events.push("committing");
      await tx.commit();
    });
    expect(events).toEqual(["after a", "committing", "a applied", "b applied"]);
  });

  it("calls a boundary that staged nothing applied at once", async () => {
    writeFile({});
    let applied = false;
    await lib.withConfigWriteScope(async () => {
      lib.beginConfigWriteTransaction("test");
      await lib.configWriteBoundary({ onApplied: () => { applied = true; } }, async () => {});
      expect(applied).toBe(true);
    });
  });

  it("hands a value the CLI could not parse to its boundary at once, as the CLI's own failure would have been", async () => {
    writeFile({});
    const caught: unknown[] = [];
    await lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await lib.configWriteBoundary({ onError: (err) => { caught.push(err); } }, () =>
        lib.runOpenclawConfigSet(["models.mode", "{not json", "--json"]));
      expect(caught).toHaveLength(1);
      expect(tx.pending).toBe(0);
      await tx.commit();
    });
    expect(state.gateway!.calls).toEqual([]);
  });
});

/**
 * When the one write cannot be made. The commit replays every staged write in
 * order, gateway first, and each failure goes where the `catch` around its
 * `await` would have sent it.
 */
describe("when the one write cannot be made", () => {
  it("replays write by write: a non-fatal failure lands in its own boundary, and the writes after it are still made", async () => {
    writeFile({ models: {} });
    await refusePatchesTouching("providers");
    state.cliRefuse = (argv) => (argv.join(" ").includes("models.providers.bad") ? "Config schema validation failed: models.providers.bad" : null);
    const events: string[] = [];
    await lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await lib.configWriteBoundary({ onApplied: () => { events.push("mode applied"); } }, () =>
        lib.runOpenclawConfigSet(["models.mode", "merge"]));
      await lib.configWriteBoundary(
        {
          onError: (err) => { events.push(`bad failed: ${(err as Error).message}`); },
          onApplied: () => { events.push("bad applied"); },
        },
        () => lib.runOpenclawConfigSet(["models.providers.bad", JSON.stringify({ apiKey: 1 }), "--json"]),
      );
      await lib.configWriteBoundary({ onApplied: () => { events.push("primary applied"); } }, () =>
        lib.runOpenclawConfigSet(["agents.defaults.model.primary", "a/b"]));
      await tx.commit();
      expect(tx.committedAs).toBe("one-by-one");
    });
    expect(events).toEqual([
      "mode applied",
      "bad failed: Config schema validation failed: models.providers.bad",
      "primary applied",
    ]);
    expect(readFile()).toEqual({ models: { mode: "merge" }, agents: { defaults: { model: { primary: "a/b" } } } });
  });

  it("throws a failure no boundary takes from the commit, and makes nothing after it", async () => {
    writeFile({ models: {} });
    await refusePatchesTouching("providers");
    state.cliRefuse = (argv) => (argv.join(" ").includes("models.providers.bad") ? "Config schema validation failed" : null);
    await expect(lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await lib.runOpenclawConfigSet(["models.mode", "merge"]);
      await lib.runOpenclawConfigSet(["models.providers.bad", JSON.stringify({ apiKey: 1 }), "--json"]);
      await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "a/b"]);
      await tx.commit();
    })).rejects.toThrow(/schema validation failed/);
    expect(readFile()).toEqual({ models: { mode: "merge" } });
  });

  it("sends a failure past an inner boundary with no handler to the outer one, whose remaining writes are skipped", async () => {
    writeFile({ models: {} });
    await refusePatchesTouching("providers");
    state.cliRefuse = (argv) => (argv.join(" ").includes("models.providers.bad") ? "refused" : null);
    const events: string[] = [];
    await lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await lib.configWriteBoundary(
        {
          onError: () => { events.push("outer caught"); },
          onApplied: () => { events.push("outer applied"); },
        },
        async () => {
          await lib.configWriteBoundary({ onApplied: () => { events.push("inner applied"); } }, () =>
            lib.runOpenclawConfigSet(["models.providers.bad", JSON.stringify({ x: 1 }), "--json"]));
          await lib.runOpenclawConfigSet(["models.mode", "merge"]);
        },
      );
      await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "a/b"]);
      await tx.commit();
    });
    expect(events).toEqual(["outer caught"]);
    // `models.mode` sat in the outer `try` after the failing write: skipped.
    // The primary came after the boundary: made.
    expect(readFile()).toEqual({ models: {}, agents: { defaults: { model: { primary: "a/b" } } } });
  });

  it("passes a failure a handler rethrows on to the next boundary out", async () => {
    writeFile({ models: {} });
    await refusePatchesTouching("providers");
    state.cliRefuse = (argv) => (argv.join(" ").includes("models.providers.bad") ? "refused" : null);
    const events: string[] = [];
    await lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await lib.configWriteBoundary({ onError: (err) => { events.push(`outer: ${(err as Error).message}`); } }, () =>
        lib.configWriteBoundary(
          { onError: (err) => { events.push("inner looked"); throw new Error(`rethrown ${(err as Error).message}`); } },
          () => lib.runOpenclawConfigSet(["models.providers.bad", JSON.stringify({ x: 1 }), "--json"]),
        ));
      await tx.commit();
    });
    expect(events).toEqual(["inner looked", "outer: rethrown refused"]);
  });

  it("lets a handler write while the commit runs — the configure route's write-past-the-refusal", async () => {
    writeFile({ models: {} });
    await refusePatchesTouching("providers");
    state.cliRefuse = (argv) => (argv.join(" ").includes("models.providers.bad") ? "refused" : null);
    await lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await lib.configWriteBoundary(
        { onError: () => lib.runOpenclawConfigSet(["models.mode", "replace"]) },
        () => lib.runOpenclawConfigSet(["models.providers.bad", JSON.stringify({ x: 1 }), "--json"]),
      );
      await tx.commit();
    });
    expect(readFile()).toEqual({ models: { mode: "replace" } });
  });

  it("does not ask a gateway that is down once per write, and makes a run of plain sets ONE CLI batch", async () => {
    // The ClawBox AI device sign-in stops the gateway for `doctor`, so every
    // write of that save is a CLI start: the groups it stages go as the one
    // `--batch-json` `applyConfigSetGroups` always sent, not one start apiece.
    writeFile({ models: {} });
    state.unavailable = true;
    await lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await lib.runOpenclawConfigSet(["models.mode", "merge"]);
      await lib.runOpenclawConfigSetBatch([
        ["agents.defaults.model.primary", "a/b"],
        ["agents.defaults.model.fallbacks", "[]", "--json"],
      ]);
      await tx.commit();
      expect(tx.committedAs).toBe("one-by-one");
    });
    expect(state.unavailableAsks).toBe(1);
    expect(cliCalls()).toHaveLength(1);
    expect(cliCalls()[0].slice(0, 3)).toEqual(["config", "set", "--batch-json"]);
    expect(readFile()).toEqual({ models: { mode: "merge" }, agents: { defaults: { model: { primary: "a/b", fallbacks: [] } } } });
  });

  it("with no gateway, breaks the run at a removal and at a `--replace`, which have no batch form", async () => {
    writeFile({ models: { providers: { openai: { apiKey: "k", models: [{ id: "a" }, { id: "b" }] } } } });
    state.unavailable = true;
    await lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await lib.runOpenclawConfigSet(["models.mode", "merge"]);
      await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "a/b"]);
      await lib.runOpenclawConfigSet(["models.providers.openai.models", JSON.stringify([{ id: "a" }]), "--json", "--replace"]);
      await lib.runOpenclawConfigUnset("models.providers.openai.apiKey");
      await tx.commit();
    });
    expect(cliCalls().map((argv) => argv.slice(0, 3))).toEqual([
      ["config", "set", "--batch-json"],
      ["config", "set", "models.providers.openai.models"],
      ["config", "unset", "models.providers.openai.apiKey"],
    ]);
    expect(cliCalls()[1]).toContain("--replace");
  });

  it("with no gateway, makes a run the CLI refuses as a batch one by one, each inside its own boundary", async () => {
    writeFile({ models: {} });
    state.unavailable = true;
    state.cliRefuse = (argv) => (argv.join(" ").includes("models.providers.bad") ? "Config schema validation failed" : null);
    const events: string[] = [];
    await lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await lib.configWriteBoundary({ onApplied: () => { events.push("mode applied"); } }, () =>
        lib.runOpenclawConfigSet(["models.mode", "merge"]));
      await lib.configWriteBoundary({ onError: () => { events.push("bad failed"); } }, () =>
        lib.runOpenclawConfigSet(["models.providers.bad", JSON.stringify({ x: 1 }), "--json"]));
      await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "a/b"]);
      await tx.commit();
    });
    expect(events).toEqual(["mode applied", "bad failed"]);
    expect(cliCalls().map((argv) => argv.slice(0, 3))).toEqual([
      ["config", "set", "--batch-json"],
      ["config", "set", "models.mode"],
      ["config", "set", "models.providers.bad"],
      ["config", "set", "agents.defaults.model.primary"],
    ]);
    expect(readFile()).toEqual({ models: { mode: "merge" }, agents: { defaults: { model: { primary: "a/b" } } } });
  });
});

describe("what a transaction cannot see", () => {
  it("lands what is staged before a whole-file writer reads, so program order holds", async () => {
    writeFile({ models: {} });
    await lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await lib.runOpenclawConfigSet(["models.mode", "merge"]);
      const config = await lib.readConfigForWrite();
      expect(state.gateway!.patches).toHaveLength(1);
      expect(config).toEqual({ models: { mode: "merge" } });
      (config as Record<string, unknown>).skills = { entries: { weather: { enabled: false } } };
      await lib.writeConfig(config);
      await lib.runOpenclawConfigSet(["agents.defaults.model.primary", "a/b"]);
      await tx.commit();
    });
    expect(state.gateway!.patches).toHaveLength(2);
    expect(readFile()).toEqual({
      models: { mode: "merge" },
      skills: { entries: { weather: { enabled: false } } },
      agents: { defaults: { model: { primary: "a/b" } } },
    });
  });

  it("makes what is staged now on flushConfigWrites — before a CLI that writes the file itself", async () => {
    writeFile({ models: {} });
    await lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await lib.runOpenclawConfigSet(["models.mode", "merge"]);
      await lib.flushConfigWrites();
      expect(readFile()).toEqual({ models: { mode: "merge" } });
      expect(tx.isOpen).toBe(true);
      await tx.commit();
    });
    expect(state.gateway!.patches).toHaveLength(1);
  });
});

describe("the request around it", () => {
  it("abandons a transaction the request never committed: nothing it staged is written", async () => {
    writeFile({ models: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await lib.withConfigWriteScope(async () => {
      lib.beginConfigWriteTransaction("test");
      await lib.runOpenclawConfigSet(["models.mode", "merge"]);
    });
    expect(state.gateway!.calls).toEqual([]);
    expect(readFile()).toEqual({ models: {} });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ended without committing; 1 staged config write(s) were not made"));
  });

  it("stages nothing without a scope — every write is made as it comes", async () => {
    writeFile({ models: {} });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tx = lib.beginConfigWriteTransaction("test");
    await lib.runOpenclawConfigSet(["models.mode", "merge"]);
    expect(readFile()).toEqual({ models: { mode: "merge" } });
    expect(lib.inConfigWriteTransaction()).toBe(false);
    await tx.commit();
  });

  it("leaves writes after the commit to be made as they come", async () => {
    writeFile({ models: {} });
    await lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("test");
      await tx.commit();
      expect(lib.inConfigWriteTransaction()).toBe(false);
      await lib.runOpenclawConfigSet(["models.mode", "merge"]);
      expect(readFile()).toEqual({ models: { mode: "merge" } });
    });
  });

  it("keeps two requests' transactions apart", async () => {
    writeFile({ models: {} });
    let releaseFirst!: () => void;
    const firstMayCommit = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = lib.withConfigWriteScope(async () => {
      const tx = lib.beginConfigWriteTransaction("first");
      await lib.runOpenclawConfigSet(["models.mode", "merge"]);
      await firstMayCommit;
      await tx.commit();
    });
    await lib.withConfigWriteScope(async () => {
      expect(lib.inConfigWriteTransaction()).toBe(false);
      // Not the first request's staged write.
      expect(await lib.readConfig()).toEqual({ models: {} });
    });
    releaseFirst();
    await first;
    expect(readFile()).toEqual({ models: { mode: "merge" } });
  });
});
