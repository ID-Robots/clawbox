import { describe, expect, it } from "vitest";
import { agentIdFromSessionKey, isAgentSelectionRequired } from "@/lib/harness/openclaw-gateway-adapter";
import { HarnessError } from "@/lib/harness/transport";

describe("agentIdFromSessionKey", () => {
  it("reads the agent a fully qualified key names", () => {
    expect(agentIdFromSessionKey("agent:main:main")).toBe("main");
    expect(agentIdFromSessionKey("agent:Coder:clawbox-abc")).toBe("coder");
  });

  it("never guesses for a key that names no agent", () => {
    expect(agentIdFromSessionKey("")).toBeUndefined();
    expect(agentIdFromSessionKey("main")).toBeUndefined();
    expect(agentIdFromSessionKey("agent::main")).toBeUndefined();
    expect(agentIdFromSessionKey("agent:main")).toBeUndefined();
    expect(agentIdFromSessionKey("cron:main:x")).toBeUndefined();
  });
});

describe("isAgentSelectionRequired", () => {
  const frame = (fields: Record<string, unknown>) => Object.assign(new Error(String(fields.message ?? "x")), fields);

  it("spots the refusal by code, nested details, message, and through a HarnessError cause", () => {
    expect(isAgentSelectionRequired(frame({ code: "AGENT_SELECTION_REQUIRED" }))).toBe(true);
    expect(isAgentSelectionRequired(frame({ code: "INVALID_REQUEST", details: { code: "AGENT_SELECTION_REQUIRED" } }))).toBe(true);
    expect(isAgentSelectionRequired(new Error("AGENT_SELECTION_REQUIRED: add a binding"))).toBe(true);
    expect(isAgentSelectionRequired(new HarnessError("upstream", "no", frame({ code: "AGENT_SELECTION_REQUIRED" })))).toBe(true);
  });

  it("leaves every other failure retryable", () => {
    expect(isAgentSelectionRequired(new Error("commands.list unavailable"))).toBe(false);
    expect(isAgentSelectionRequired(frame({ code: "UNAVAILABLE" }))).toBe(false);
    expect(isAgentSelectionRequired(null)).toBe(false);
  });
});
