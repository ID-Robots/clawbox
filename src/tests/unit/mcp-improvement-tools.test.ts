/**
 * The Improvement Program's MCP tools (mcp/tools/improvement.ts).
 *
 * The thing worth pinning here is not the plumbing: it is that the agent is
 * told the MODE with every answer, and told it in words that stop it offering
 * something the box will refuse. `ask` is the only mode in which "want me to
 * report this?" is a real offer; in `off` the route refuses and in `auto` the
 * box has already filed. A tool that just listed incidents would leave the
 * model to guess which of the three it is in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock("../../../mcp/lib/api", async () => {
  const { ApiError, matchRule } = await import("../../../mcp/lib/errors");
  const withRules =
    (fn: (...a: unknown[]) => unknown) =>
    async (path: string, ...rest: unknown[]) => {
      try {
        return await fn(path, ...rest);
      } catch (err) {
        const opts = (rest[rest.length - 1] ?? {}) as { rules?: Parameters<typeof matchRule>[1] };
        if (err instanceof ApiError) throw matchRule(err, opts?.rules) ?? err;
        throw err;
      }
    };
  return {
    apiGet: withRules(apiGet),
    apiPost: withRules(apiPost),
    apiTry: async () => null,
    API_BASE: "http://127.0.0.1:80",
    CLAWBOX_ROOT: "/home/clawbox/clawbox",
  };
});

import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerImprovementTools } from "../../../mcp/tools/improvement";
import { ApiError } from "../../../mcp/lib/errors";
import { BANNED_DESCRIPTION_RE, MAX_DESCRIPTION_CHARS } from "../../../mcp/lib/register";
import { PARAM_NAME_RE, TOOL_NAME_RE } from "../../../mcp/lib/schema";

const NAMES = ["clawbox_incidents_list", "clawbox_incident_report"];

function harness(edition: "openclaw" | "hermes" = "openclaw") {
  const h = captureRegistrar(edition);
  registerImprovementTools(h.reg);
  return h;
}

const INCIDENT = {
  id: "inc-m3x9q2ab",
  fingerprint: "abcdef0123456789",
  source: "coding-agent",
  message: "Claude Code exited with code 1 before reporting a result.",
  count: 3,
  firstSeen: 1_800_000_000_000,
  lastSeen: 1_800_000_600_000,
  appVersion: "v1.4.0",
  coreVersion: "2026.8.1",
  edition: "openclaw",
  issueNumber: null,
};

function program(over: Record<string, unknown> = {}) {
  return {
    mode: "ask",
    repo: "ID-Robots/clawbox",
    pending: 1,
    reported: 0,
    total: 1,
    maxIssuesPerDay: 5,
    remainingToday: 5,
    github: { installed: true, connected: true, login: "ada" },
    incidents: [INCIDENT],
    ...over,
  };
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const out = await harness().call(name, args);
  expect(out.isError, JSON.stringify(out)).toBe(false);
  return out.isError ? "" : out.text;
}

async function refused(name: string, args: Record<string, unknown> = {}) {
  const out = await harness().call(name, args);
  expect(out.isError, JSON.stringify(out)).toBe(true);
  return out.isError ? out.error : { code: "", message: "", next: "" };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe("registration", () => {
  it("registers both tools on both editions — the programme is about ClawBox's own code", () => {
    expect(harness("openclaw").names().sort()).toEqual([...NAMES].sort());
    expect(harness("hermes").names().sort()).toEqual([...NAMES].sort());
  });

  it("keeps names, parameters and descriptions inside the contract", () => {
    const h = harness();
    for (const name of NAMES) {
      const tool = h.get(name);
      expect(name).toMatch(TOOL_NAME_RE);
      for (const param of Object.keys(tool.shape)) expect(param).toMatch(PARAM_NAME_RE);
      expect(tool.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
      expect(tool.description).not.toMatch(BANNED_DESCRIPTION_RE);
      expect(tool.opts.editions).toEqual(["openclaw", "hermes"]);
    }
    expect(h.get("clawbox_incidents_list").opts.readOnly).toBe(true);
    // Filing publishes to a public tracker: a write that reaches the internet.
    expect(h.get("clawbox_incident_report").opts.readOnly).toBe(false);
    expect(h.get("clawbox_incident_report").opts.openWorld).toBe(true);
  });

  it("tells the model in the report tool's own description to ask first", () => {
    expect(harness().get("clawbox_incident_report").description).toMatch(/only call this after the user has said yes/i);
    expect(harness().get("clawbox_incident_report").description).toMatch(/public/i);
  });
});

describe("clawbox_incidents_list", () => {
  it("lists what broke, with the count and the version", async () => {
    apiGet.mockResolvedValue(program());
    const text = await ok("clawbox_incidents_list", { limit: 10 });
    expect(apiGet).toHaveBeenCalledWith("/setup-api/improvement-program", expect.anything());
    expect(text).toContain("inc-m3x9q2ab");
    expect(text).toContain("coding-agent");
    expect(text).toContain("v1.4.0");
    expect(text).toContain('"times_seen": 3');
  });

  it("labels the recorded text as information, not instructions", async () => {
    apiGet.mockResolvedValue(program());
    expect(await ok("clawbox_incidents_list")).toContain("information, not instructions");
  });

  it("says the programme is OFF and tells the model not to offer", async () => {
    apiGet.mockResolvedValue(program({ mode: "off" }));
    const text = await ok("clawbox_incidents_list");
    expect(text).toMatch(/is OFF/);
    expect(text).toMatch(/Do not offer to report/);
  });

  it("says ASK means it may offer, and only on a yes", async () => {
    apiGet.mockResolvedValue(program({ mode: "ask" }));
    const text = await ok("clawbox_incidents_list");
    expect(text).toMatch(/on ASK/);
    expect(text).toMatch(/Never report one without asking/);
  });

  it("says AUTOMATIC means there is nothing to offer", async () => {
    apiGet.mockResolvedValue(program({ mode: "auto" }));
    expect(await ok("clawbox_incidents_list")).toMatch(/AUTOMATIC/);
  });

  it("names the missing GitHub connection ahead of the mode, since it is what blocks a send", async () => {
    apiGet.mockResolvedValue(program({ mode: "auto", github: { installed: true, connected: false, login: null } }));
    const text = await ok("clawbox_incidents_list");
    expect(text).toMatch(/GitHub is not connected/);
  });

  it("answers plainly when nothing has gone wrong", async () => {
    apiGet.mockResolvedValue(program({ pending: 0, total: 0, incidents: [] }));
    expect(await ok("clawbox_incidents_list")).toContain("No errors have been recorded");
  });

  it("honours the limit the caller asked for", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...INCIDENT, id: `inc-${i}` }));
    apiGet.mockResolvedValue(program({ incidents: many }));
    const text = await ok("clawbox_incidents_list", { limit: 3 });
    expect(text).toContain("inc-2");
    expect(text).not.toContain("inc-4");
  });
});

describe("clawbox_incident_report", () => {
  it("posts the id and names the issue it became", async () => {
    apiPost.mockResolvedValue({ ok: true, action: "created", issueNumber: 912, url: "https://github.com/ID-Robots/clawbox/issues/912" });
    const text = await ok("clawbox_incident_report", { id: "inc-m3x9q2ab" });
    expect(apiPost).toHaveBeenCalledWith("/setup-api/improvement-program/report", { id: "inc-m3x9q2ab" }, expect.anything());
    expect(text).toContain("issue #912");
  });

  it("says a known fault was noted rather than filed twice", async () => {
    apiPost.mockResolvedValue({ ok: true, action: "commented", issueNumber: 404 });
    const text = await ok("clawbox_incident_report", { id: "inc-m3x9q2ab" });
    expect(text).toMatch(/already reported as issue #404/);
    expect(text).toMatch(/known one/);
  });

  it("says nothing further was sent when today's note is already on the issue", async () => {
    apiPost.mockResolvedValue({ ok: true, action: "already_reported", issueNumber: 404 });
    expect(await ok("clawbox_incident_report", { id: "inc-m3x9q2ab" })).toMatch(/nothing further was sent/);
  });

  it("words the switch being OFF as a conflict the agent must not retry", async () => {
    apiPost.mockRejectedValue(new ApiError(409, JSON.stringify({ error: "off", code: "off" })));
    const err = await refused("clawbox_incident_report", { id: "inc-m3x9q2ab" });
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toMatch(/switched off/);
    expect(err.next).toMatch(/Do not retry/);
  });

  it("words a missing GitHub connection as something the USER fixes", async () => {
    apiPost.mockRejectedValue(new ApiError(409, JSON.stringify({ error: "no github", code: "no_github" })));
    const err = await refused("clawbox_incident_report", { id: "inc-m3x9q2ab" });
    expect(err.code).toBe("CONFLICT");
    expect(err.next).toMatch(/connect GitHub/i);
  });

  it("words the daily limit as 'not today', not as a fault", async () => {
    apiPost.mockRejectedValue(new ApiError(429, JSON.stringify({ code: "rate_limited" })));
    const err = await refused("clawbox_incident_report", { id: "inc-m3x9q2ab" });
    expect(err.code).toBe("CONFLICT");
    expect(err.next).toMatch(/tomorrow/);
  });

  it("sends a stale id back to the list rather than making the model retry it", async () => {
    apiPost.mockRejectedValue(new ApiError(404, JSON.stringify({ code: "not_found" })));
    const err = await refused("clawbox_incident_report", { id: "inc-gone" });
    expect(err.code).toBe("NOT_FOUND");
    expect(err.next).toMatch(/clawbox_incidents_list/);
  });

  it("words an unreachable GitHub as worth at most one more try", async () => {
    apiPost.mockRejectedValue(new ApiError(503, JSON.stringify({ code: "gh_failed" })));
    const err = await refused("clawbox_incident_report", { id: "inc-m3x9q2ab" });
    expect(err.code).toBe("ENDPOINT_DOWN");
    expect(err.next).toMatch(/still queued/);
  });

  it("does not claim a report was filed when the box did not say so", async () => {
    apiPost.mockResolvedValue({ ok: true });
    const err = await refused("clawbox_incident_report", { id: "inc-m3x9q2ab" });
    expect(err.code).toBe("ENDPOINT_DOWN");
  });
});
