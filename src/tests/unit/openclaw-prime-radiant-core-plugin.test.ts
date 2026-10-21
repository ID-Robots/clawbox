/**
 * The OpenClaw plugin that hands the Prime Radiant core block to the owner's
 * main agent (`clawbox-prime-radiant-core`): the block as system context on
 * every prompt build of the gateway's default agent — read again when ClawBox
 * rewrote the file, with no restart — and nothing in a ClawBox user's own
 * chat, for another agent, on a model running on the device, or with no file.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../../../scripts/openclaw-plugins/clawbox-prime-radiant-core/index.mjs";
import {
  coreContextFile,
  createBlockReader,
  isUserChatKey,
  mainAgentId,
  primaryModel,
  promptContext,
  runsOnDevice,
} from "../../../scripts/openclaw-plugins/clawbox-prime-radiant-core/prime-radiant-core.mjs";
import { coreContextPath } from "@/lib/prime-radiant/paths";
import { CORE_CONTEXT_FORMAT } from "@/lib/prime-radiant/core-context-file";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-core-plugin-"));
let n = 0;
let file = "";

const CLOUD = { agents: { defaults: { model: { primary: "anthropic/claude-opus-5-5" } } } };
const OWNER = { sessionKey: "agent:main:main", agentId: "main" };
const BLOCK = '<prime_radiant_core pages="1">\nPrime Radiant core: …\n- Acme — A company.\n</prime_radiant_core>\n';

function writeBlock(text: string, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ format: CORE_CONTEXT_FORMAT, text, pages: 1, chars: text.length, estTokens: 1, ...extra }));
  fs.renameSync(tmp, file);
}

beforeEach(() => {
  file = path.join(base, `case-${++n}`, "core-context.json");
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("which turns get the block", () => {
  it("gives the owner's main agent the block as system context, once, never as turn context", async () => {
    writeBlock(BLOCK);
    expect(await promptContext(OWNER, CLOUD, createBlockReader(file))).toEqual({ appendSystemContext: BLOCK });
    // A side tab of the owner, a Telegram chat and a key with no agent id given beside it.
    for (const sessionKey of ["agent:main:clawbox-0123abcd", "agent:main:telegram:direct:1234", "agent:main:main"]) {
      expect(await promptContext({ sessionKey }, CLOUD, createBlockReader(file))).toEqual({ appendSystemContext: BLOCK });
    }
  });

  it("gives a ClawBox user's own chat nothing, main or tab", async () => {
    writeBlock(BLOCK);
    const read = createBlockReader(file);
    for (const sessionKey of ["agent:main:clawbox-user-alice", "agent:main:clawbox-utab-0123456789ab-alice", "AGENT:MAIN:CLAWBOX-USER-BOB"]) {
      expect(await promptContext({ sessionKey, agentId: "main" }, CLOUD, read)).toBeUndefined();
    }
  });

  it("gives another agent nothing, and follows the gateway's default agent", async () => {
    writeBlock(BLOCK);
    const read = createBlockReader(file);
    expect(await promptContext({ sessionKey: "agent:coder:main", agentId: "coder" }, CLOUD, read)).toBeUndefined();
    expect(await promptContext({ sessionKey: "agent:main:main", agentId: "coder" }, CLOUD, read)).toBeUndefined();
    const roster = { agents: { ...CLOUD.agents, entries: { main: {}, roboclaw: { default: true } } } };
    expect(mainAgentId(roster)).toBe("roboclaw");
    expect(await promptContext({ sessionKey: "agent:roboclaw:main", agentId: "roboclaw" }, roster, read)).toEqual({ appendSystemContext: BLOCK });
    expect(await promptContext(OWNER, roster, read)).toBeUndefined();
  });

  it("gives nothing when the session or the model cannot be told", async () => {
    writeBlock(BLOCK);
    const read = createBlockReader(file);
    expect(await promptContext({}, CLOUD, read)).toBeUndefined();
    expect(await promptContext(undefined, CLOUD, read)).toBeUndefined();
    expect(await promptContext(OWNER, null, read)).toBeUndefined();
    expect(await promptContext(OWNER, { agents: { defaults: {} } }, read)).toBeUndefined();
  });

  it("gives nothing while the primary model runs on the device", async () => {
    writeBlock(BLOCK);
    const read = createBlockReader(file);
    for (const primary of ["llamacpp/gemma4-e2b-it-q4_0", "ollama/qwen2.5:3b", "Ollama/llama3.1:8b"]) {
      expect(runsOnDevice(primary)).toBe(true);
      expect(await promptContext(OWNER, { agents: { defaults: { model: { primary } } } }, read)).toBeUndefined();
    }
    for (const primary of ["anthropic/claude-opus-5-5", "deepseek/deepseek-chat", "openai-codex/gpt-5.5", "google/gemini-3-pro"]) {
      expect(runsOnDevice(primary)).toBe(false);
    }
    // The agent's own model wins over the defaults; a bare string is a model too.
    const own = { agents: { defaults: { model: "anthropic/claude-opus-5-5" }, entries: { main: { model: { primary: "llamacpp/gemma4" } } } } };
    expect(primaryModel(own, "main")).toBe("llamacpp/gemma4");
    expect(await promptContext(OWNER, own, read)).toBeUndefined();
    expect(primaryModel({ agents: { defaults: { model: "anthropic/claude-opus-5-5" } } }, "main")).toBe("anthropic/claude-opus-5-5");
  });
});

describe("the block on disk", () => {
  it("adds nothing without a file, and nothing from a file ClawBox did not write", async () => {
    expect(await promptContext(OWNER, CLOUD, createBlockReader(file))).toBeUndefined();
    writeBlock(BLOCK, { format: 2 });
    expect(await promptContext(OWNER, CLOUD, createBlockReader(file))).toBeUndefined();
    writeBlock("x".repeat(64_001));
    expect(await promptContext(OWNER, CLOUD, createBlockReader(file))).toBeUndefined();
    fs.writeFileSync(file, "not json");
    expect(await promptContext(OWNER, CLOUD, createBlockReader(file))).toBeUndefined();
  });

  it("follows the file: a new block on the next turn, none once it is removed — no restart", async () => {
    const read = createBlockReader(file);
    writeBlock(BLOCK);
    expect(await promptContext(OWNER, CLOUD, read)).toEqual({ appendSystemContext: BLOCK });
    const next = BLOCK.replace("A company.", "A company with 40 staff.");
    writeBlock(next);
    expect(await promptContext(OWNER, CLOUD, read)).toEqual({ appendSystemContext: next });
    fs.rmSync(file);
    expect(await promptContext(OWNER, CLOUD, read)).toBeUndefined();
  });

  describe("where it is", () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const k of ["CLAWBOX_ROOT", "PRIME_RADIANT_DIR", "CLAWBOX_HOME_DIR"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it("is the path ClawBox writes, whichever way the root is given", () => {
      process.env.CLAWBOX_ROOT = path.join(base, "root");
      delete process.env.PRIME_RADIANT_DIR;
      expect(coreContextFile(process.env)).toBe(coreContextPath());
      process.env.PRIME_RADIANT_DIR = path.join(base, "pr");
      expect(coreContextFile(process.env)).toBe(coreContextPath());
      // The gateway runs without CLAWBOX_ROOT: the root is <home>/clawbox, as gateway-pre-start.sh has it.
      const home = path.join(base, "home");
      const boxHome = path.join(base, "box-home");
      expect(coreContextFile({}, home)).toBe(path.join(home, "clawbox", "data", "prime-radiant", "core-context.json"));
      expect(coreContextFile({ CLAWBOX_HOME_DIR: boxHome }, home)).toBe(path.join(boxHome, "clawbox", "data", "prime-radiant", "core-context.json"));
    });
  });
});

describe("the plugin", () => {
  const prev = process.env.PRIME_RADIANT_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.PRIME_RADIANT_DIR;
    else process.env.PRIME_RADIANT_DIR = prev;
  });

  it("registers one before_prompt_build handler that never throws", async () => {
    // The block it reads is this test's own (absent) one, never the machine's.
    process.env.PRIME_RADIANT_DIR = path.join(base, "plugin");
    const handlers: Array<[string, (event: unknown, ctx: unknown) => Promise<unknown>]> = [];
    // A runtime whose config cannot be read: the snapshot registration saw is used.
    plugin.register({
      on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.push([name, fn]),
      get runtime(): never {
        throw new Error("boom");
      },
      config: CLOUD,
    });
    expect(handlers.map(([name]) => name)).toEqual(["before_prompt_build"]);
    await expect(handlers[0][1]({}, OWNER)).resolves.toBeUndefined();
    expect(isUserChatKey(null)).toBe(false);
  });
});
