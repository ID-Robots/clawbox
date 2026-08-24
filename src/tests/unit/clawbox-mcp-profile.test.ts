import { describe, expect, it } from "vitest";
import { profileForActiveModel } from "../../../mcp/lib/profile";

/**
 * TASK-457 (d), the ClawBox half of the per-turn payload: 42 tools / 26,358 B
 * of schema, enumerated live over stdio against the deployed server. The `core`
 * profile that trims it already existed — it was reachable only by setting an
 * env var by hand, which nothing on a customer device ever does. This is the
 * rule that selects it.
 *
 * The gate is the PROVIDER first and the size second. Getting that order wrong
 * would slim a cloud model whose id happens to contain "3b".
 */
const local = (current: string) => ({ provider: "clawlocal", current });
const env = (extra: Record<string, string> = {}) => extra as unknown as NodeJS.ProcessEnv;

/**
 * Following the model is OPT-IN. It cannot be made per-turn correct: the chat
 * header's provider override is client-local and never reaches this process,
 * because Hermes builds the MCP child's environment from an allowlist
 * (`_build_safe_env` in tools/mcp_tool.py) that drops a ClawBox-specific name.
 * ON by default would therefore drop a header-selected CLOUD turn from 38 tools
 * to 14 on a locally-configured device. `auto` is what the bake-off sets;
 * unset must stay exactly what beta shipped.
 */
const AUTO = env({ CLAWBOX_MCP_PROFILE: "auto" });

describe("which tool profile a device registers", () => {
  it("selects the slim set for the on-device models this box ships", () => {
    for (const id of ["gemma4-e2b-it-q4_0", "qwen2.5:3b", "llama3.2:1b"]) {
      expect(profileForActiveModel(local(id), AUTO), id).toBe("core");
    }
  });

  it("selects the slim set when the local model cannot be identified", () => {
    // The provider already tells us it runs on this hardware; nothing this box
    // can host is big.
    expect(profileForActiveModel(local(""), AUTO)).toBe("core");
    expect(profileForActiveModel({ provider: "clawlocal" }, AUTO)).toBe("core");
  });

  it("keeps every tool for a cloud provider, whatever its model is called", () => {
    expect(profileForActiveModel({ provider: "clawai", current: "deepseek-v4-pro" }, AUTO)).toBe("full");
    // The trap: a hosted model whose id carries a small parameter count.
    expect(profileForActiveModel({ provider: "openrouter", current: "qwen2.5:3b" }, AUTO)).toBe("full");
    expect(profileForActiveModel({ provider: "anthropic", current: "claude-sonnet-4-5" }, AUTO)).toBe("full");
  });

  it("keeps every tool for a big local model", () => {
    expect(profileForActiveModel(local("gpt-oss:20b"), AUTO)).toBe("full");
  });

  it("keeps every tool when the device could not be asked", () => {
    // A loopback GET that timed out at boot must not quietly withhold two
    // thirds of the agent's tools — the opposite direction from the edition
    // lock, where an unreadable answer resolves to the SMALLER set.
    expect(profileForActiveModel(null, AUTO)).toBe("full");
    expect(profileForActiveModel({}, AUTO)).toBe("full");
  });

  it("keeps every tool when nothing opted in — beta's behaviour, unchanged", () => {
    // The regression this guards: on a device whose PERSISTED provider is the
    // on-device one, a chat-header-selected cloud turn would silently drop from
    // 38 tools to 14. The header override is client-local and cannot reach this
    // process, so the default must not slim anything.
    expect(profileForActiveModel(local("qwen2.5:3b"), env())).toBe("full");
    expect(profileForActiveModel(local("gemma4-e2b-it-q4_0"), env())).toBe("full");
    expect(profileForActiveModel(null, env())).toBe("full");
  });

  it("lets an explicit env pin win in either direction", () => {
    expect(profileForActiveModel(local("qwen2.5:3b"), { CLAWBOX_MCP_PROFILE: "full" } as unknown as NodeJS.ProcessEnv))
      .toBe("full");
    expect(profileForActiveModel({ provider: "clawai", current: "deepseek-v4-pro" },
      { CLAWBOX_MCP_PROFILE: "core" } as unknown as NodeJS.ProcessEnv)).toBe("core");
  });

  it("honours the same off switch the chat route reads", () => {
    expect(profileForActiveModel(local("qwen2.5:3b"),
      env({ CLAWBOX_MCP_PROFILE: "auto", CLAWBOX_SMALL_MODEL_PROFILE: "off" }))).toBe("full");
  });
});
