import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HERMES-05 — the tools that told the agent the wrong model was "in use".
 *
 * Routing was never the bug: every turn ran on the model the chat header sent.
 * The bug was the self-report. `ai_list_models` read /setup-api/hermes/models
 * — the device DEFAULT from config.yaml — and labelled it `in_use`, and
 * `device_status` did the same under `ai.model`. Told to "use tools", the agent
 * called them and answered "tool-verified: gpt-5.6-sol" while it was running on
 * deepseek-v4-flash. This process cannot know better (see CURRENT_CHAT_MODEL_NOTE
 * in mcp/lib/report.ts), so the honest payload names the value for what it is
 * and says, in the same object, what it is not.
 *
 * The unknown-guard and the filtered-query cases live in mcp-tool-honesty.test.ts,
 * already under the new key; this file pins only what this finding added.
 */

const { apiGet, apiPost, apiTry, spawnArgv, hasBinary } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiTry: vi.fn(),
  spawnArgv: vi.fn(),
  hasBinary: vi.fn(),
}));

vi.mock("../../../mcp/lib/api", () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiTry: (...a: unknown[]) => apiTry(...a),
  apiToken: () => ({ token: "", source: "none" }),
  authHeader: () => null,
  API_BASE: "http://127.0.0.1:80",
  CLAWBOX_ROOT: "/home/clawbox/clawbox",
}));

vi.mock("../../../mcp/lib/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../mcp/lib/guard")>();
  return { ...actual, spawnArgv, hasBinary };
});

import type { McpContext } from "../../../mcp/lib/context";
import { CURRENT_CHAT_MODEL_NOTE } from "../../../mcp/lib/report";
import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerAiTools } from "../../../mcp/tools/ai";
import { registerOrientationTools } from "../../../mcp/tools/orientation";

const ctx = (edition: "openclaw" | "hermes", install: McpContext["install"] = edition): McpContext => ({
  edition,
  install,
  profile: "full",
  capabilities: { screenGrabber: null, imageConvert: false, journal: false, du: false },
  providers: ["clawai", "openai"],
  emailCanRead: false,
  codingAgent: false,
  canGenerateImages: true,
});

const DEFAULT = { provider: "openai", current: "gpt-5.6-sol", reasoning: "medium" };
const CATALOGUE = {
  ...DEFAULT,
  models: [{ id: "gpt-5.6-sol" }],
  providers: [
    { id: "openai", name: "OpenAI", authenticated: true, total: 1 },
    { id: "clawai", name: "ClawBox AI", authenticated: true, total: 1 },
  ],
};

function ai() {
  const h = captureRegistrar("hermes");
  registerAiTools(h.reg, ctx("hermes"));
  return h;
}

function status(edition: "openclaw" | "hermes", install: McpContext["install"] = edition) {
  const h = captureRegistrar(edition);
  registerOrientationTools(h.reg, ctx(edition, install));
  return h;
}

async function parsed(h: ReturnType<typeof captureRegistrar>, name: string, args = {}) {
  const out = await h.call(name, args);
  if (out.isError) throw new Error(`${name} failed: ${JSON.stringify(out.error)}`);
  return JSON.parse(out.text) as Record<string, unknown>;
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiTry.mockReset().mockResolvedValue(null);
});

describe("the note both tools attach", () => {
  it("says the default is not the chat, and where the answer is", () => {
    expect(CURRENT_CHAT_MODEL_NOTE).toMatch(/per-session/);
    expect(CURRENT_CHAT_MODEL_NOTE).toMatch(/not visible/);
    // It points at the one place that does know — the label under a reply —
    // without promising one under every reply: rows stored before the field
    // existed, and sessions that never touched the ClawBox chat, have none.
    expect(CURRENT_CHAT_MODEL_NOTE).toMatch(/under (that|a) reply/);
    expect(CURRENT_CHAT_MODEL_NOTE).not.toMatch(/under each reply/);
  });
});

describe("ai_list_models — the default is labelled as the default", () => {
  it("reports the device default under its own name, never as in_use", async () => {
    apiGet.mockResolvedValue(CATALOGUE);
    const body = await parsed(ai(), "ai_list_models");

    expect(body).not.toHaveProperty("in_use");
    expect(body.device_default).toEqual({ provider: "openai", model: "gpt-5.6-sol", thinking: "medium" });
    expect(body.current_chat).toBe(CURRENT_CHAT_MODEL_NOTE);
  });

  it("keeps the same shape on a filtered call, and reads the default off the scoped reply's `savedPair`", async () => {
    // The scoped reply reuses `provider` for the filter and carries the saved
    // pairing as `savedPair` — whichever provider it belongs to.
    apiGet.mockResolvedValue({
      provider: "zai", current: "", reasoning: "low", models: [{ id: "glm-4" }], providers: [],
      savedPair: { provider: "clawai", model: "deepseek-v4-flash" },
    });
    let body = await parsed(ai(), "ai_list_models", { provider: "zai" });
    expect(body.asked_about).toBe("zai");
    expect(body.device_default).toEqual({ provider: "clawai", model: "deepseek-v4-flash", thinking: "low" });
    expect(body.current_chat).toBe(CURRENT_CHAT_MODEL_NOTE);

    // The box's OWN provider, with a stale list that no longer has the saved
    // model: `current` is blank and `savedElsewhere` is null, and the default
    // is still exactly this provider.
    apiGet.mockResolvedValue({
      provider: "clawai", current: "", reasoning: "off", models: [], providers: [], savedElsewhere: null,
      savedPair: { provider: "clawai", model: "deepseek-v4-flash" },
    });
    body = await parsed(ai(), "ai_list_models", { provider: "clawai" });
    expect(body.device_default).toEqual({ provider: "clawai", model: "deepseek-v4-flash", thinking: "off" });

    // Nothing to read: still the object, still "unknown" — never a prose string
    // in a field the unfiltered call fills with an object.
    apiGet.mockResolvedValue({ provider: "zai", current: "", models: [], providers: [] });
    body = await parsed(ai(), "ai_list_models", { provider: "zai" });
    expect(body.device_default).toEqual({ provider: "unknown", model: "unknown", thinking: "unknown" });
    expect(body.current_chat).toBe(CURRENT_CHAT_MODEL_NOTE);
  });

  it("tells the agent, in the description, that this is not the model answering the chat", () => {
    const { description } = ai().get("ai_list_models");
    expect(description).toMatch(/device default/);
    expect(description).toMatch(/per-session/);
    expect(description).not.toMatch(/in use right now/i);
  });
});

describe("ai_set_provider / ai_set_model — a default change is not a chat change", () => {
  it("names what it changed and what it did not", async () => {
    apiPost.mockResolvedValue({ provider: "clawai", model: "deepseek-v4-flash" });
    const h = ai();
    for (const [tool, args] of [
      ["ai_set_model", { model: "deepseek-v4-flash" }],
      ["ai_set_provider", { provider: "clawai" }],
    ] as const) {
      const out = await h.call(tool, args);
      if (out.isError) throw new Error(`${tool} failed`);
      expect(out.text).toMatch(/^Device default is now/);
      expect(out.text).toMatch(/header/);
      expect(h.get(tool).description).toMatch(/by default/);
    }
  });
});

describe("device_status — the same honesty on the orientation tool", () => {
  const routes = (map: Record<string, unknown>) =>
    apiTry.mockImplementation(async (route: unknown) => map[route as string] ?? null);

  it("labels the Hermes default as the default and says what it cannot see", async () => {
    routes({
      "/setup-api/hermes/models": { provider: "clawai", current: "deepseek-v4-flash", reasoning: "off" },
      "/setup-api/hermes/clawai": { hasToken: true, tier: "pro", active: true },
    });
    const { ai: report } = (await parsed(status("hermes"), "device_status")) as { ai: Record<string, unknown> };

    expect(report).not.toHaveProperty("model");
    expect(report).not.toHaveProperty("provider");
    expect(report.device_default).toEqual({ provider: "clawai", model: "deepseek-v4-flash", thinking: "off" });
    expect(report.current_chat).toBe(CURRENT_CHAT_MODEL_NOTE);
    // The plan block reads the same default one key down: `active` is whether
    // config.yaml's provider is ClawBox AI, so it is not "in use" either.
    expect(report.clawbox_ai).toEqual({ signed_in: true, tier: "pro", is_device_default: true });
    // The limits promise the server's instructions rely on is untouched.
    expect(report.limits).toBe("unknown");
  });

  it("says on OpenClaw that the default IS the chat's model, because the header writes it", async () => {
    // /setup-api/chat/model writes agents.defaults.model.primary AND repoints
    // every agent session, and OpenClaw has neither the reply label nor the
    // Hermes instruction — so telling this edition "not visible" would turn a
    // right answer into a shrug.
    routes({ "/setup-api/chat/model": { selected: { provider: "anthropic", model: "claude-fable-5" }, current: "" } });
    const { ai: report } = (await parsed(status("openclaw"), "device_status")) as { ai: Record<string, unknown> };

    expect(report).not.toHaveProperty("model");
    expect(report.device_default).toMatchObject({ provider: "anthropic", model: "claude-fable-5" });
    expect(String(report.current_chat)).toMatch(/what this chat runs/);
    expect(String(report.current_chat)).not.toMatch(/not visible/);
  });

  it("qualifies the default per edition in the description", () => {
    expect(status("hermes").get("device_status").description).toMatch(/not necessarily the one answering this chat/);
    const openclaw = status("openclaw").get("device_status").description;
    expect(openclaw).toMatch(/default/);
    expect(openclaw).not.toMatch(/not necessarily/);
  });

  it("does not claim the default is this chat's model on a DUAL box, where the edition may be a fallback", async () => {
    // `resolveEdition` asks /setup-api/harness/active with a 3 s timeout and
    // answers "openclaw" on any failure — and this server starts with the
    // harness, exactly when the web app may not be up. On a locked SKU that
    // cannot be wrong; on dual it can, and the affirmative note would tell a
    // HERMES chat to answer "which model are you" from the device default,
    // which is the whole defect TASK-648 opened for.
    routes({ "/setup-api/chat/model": { selected: { provider: "anthropic", model: "claude-fable-5" }, current: "" } });
    const { ai: report } = (await parsed(status("openclaw", "dual"), "device_status")) as {
      ai: Record<string, unknown>;
    };

    expect(report.device_default).toMatchObject({ provider: "anthropic", model: "claude-fable-5" });
    expect(String(report.current_chat)).not.toMatch(/so it is what this chat runs/);
    expect(String(report.current_chat)).toMatch(/could not confirm which is active/);
  });

  it("hedges the dual box's description too, rather than promising the chat runs the default", () => {
    const dual = status("openclaw", "dual").get("device_status").description;
    expect(dual).not.toMatch(/which is also what the chat runs/);
    expect(dual).toMatch(/not necessarily the one answering this chat/);
  });
});

describe("the server's standing instructions", () => {
  // Pinned on the STRING LITERAL, not the file: a comment that happens to
  // carry the phrase must not satisfy this.
  const source = fs.readFileSync(path.join(process.cwd(), "mcp", "clawbox-mcp.ts"), "utf8");

  it("point the agent at the reply label for its own identity, not at the tools", () => {
    expect(source).toMatch(/"[^"\n]*under (that|a) reply[^"\n]*report the device default[^"\n]*"/);
    expect(source).not.toMatch(/"[^"\n]*under each reply[^"\n]*"/);
  });

  it("do so on the Hermes edition only, where the label and ai_list_models exist", () => {
    expect(source.match(/edition === "hermes" \? \[WHICH_MODEL_AM_I\] : \[\]/g)).toHaveLength(2);
  });
});
