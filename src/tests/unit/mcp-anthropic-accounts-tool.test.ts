/**
 * TASK-902 — `anthropic_accounts`, the agent's read of the box's Anthropic
 * account pool: which accounts can answer, which one a run starting now would
 * use, which one a usage limit set aside and when it is back.
 *
 * The property that matters most is what the answer does NOT carry. The route
 * behind it (GET /setup-api/anthropic/accounts) serves the owner's Settings
 * card, so it has the account's email and internal id; the tool keeps only the
 * owner's own label, the kind, the state and the order — and never a
 * credential, even if a future route answered one by mistake. The fixture is
 * typed as the route's real `AnthropicPoolView`, so a renamed field breaks this
 * file at type-check instead of silently emptying the agent's answer.
 *
 * The second property is the advice: when every account is limited the agent
 * must stop spending attempts and wait for the reset, because the box resumes
 * the cut-off runs by itself then.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnthropicAccountView, AnthropicPoolView } from "@/lib/anthropic-accounts";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("../../../mcp/lib/api", async () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: vi.fn(),
  apiTry: vi.fn(),
  API_BASE: "http://127.0.0.1:80",
  CLAWBOX_ROOT: "/home/clawbox/clawbox",
}));

import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerAiTools } from "../../../mcp/tools/ai";
import { ApiError } from "../../../mcp/lib/errors";
import type { McpContext } from "../../../mcp/lib/context";
import { BANNED_DESCRIPTION_RE, MAX_DESCRIPTION_CHARS } from "../../../mcp/lib/register";

function harness(edition: "openclaw" | "hermes") {
  const h = captureRegistrar(edition);
  registerAiTools(h.reg, { canGenerateImages: true, providers: [] } as unknown as McpContext);
  return h;
}

const NOW = Date.UTC(2026, 8, 18, 17, 0);
const RESET = Date.UTC(2026, 8, 18, 19, 50);
const LATER_RESET = Date.UTC(2026, 8, 18, 22, 10);

function account(over: Partial<AnthropicAccountView> & Pick<AnthropicAccountView, "id" | "label" | "priority">): AnthropicAccountView {
  return {
    email: null,
    kind: "oauth",
    status: "ok",
    limitedUntil: null,
    limitKind: null,
    active: false,
    addedAt: NOW - 86_400_000,
    lastUsedAt: null,
    lastLimitedAt: null,
    ...over,
  };
}

function pool(accounts: AnthropicAccountView[]): AnthropicPoolView {
  const healthy = accounts.filter((a) => a.status === "ok").length;
  const limited = accounts.filter((a) => a.status === "limited");
  const resets = limited.map((a) => a.limitedUntil).filter((at): at is number => at !== null);
  return {
    accounts,
    health: {
      total: accounts.length,
      healthy,
      limited: limited.length,
      needsAttention: accounts.length - healthy - limited.length,
      allLimited: accounts.length > 0 && healthy === 0,
      nextResetAt: resets.length ? Math.min(...resets) : null,
    },
    activeAccountId: accounts.find((a) => a.active)?.id ?? null,
    loginAvailable: false,
    now: NOW,
  };
}

/** Account #1 at its session limit, account #2 carrying the runs. */
const ONE_LIMITED = pool([
  account({
    id: "acct_work",
    label: "Work Max",
    email: "owner.work@example.com",
    priority: 1,
    status: "limited",
    limitedUntil: RESET,
    limitKind: "session",
    lastLimitedAt: NOW - 60_000,
  }),
  account({ id: "acct_home", label: "Personal Max", email: "owner.home@example.com", priority: 2, active: true, lastUsedAt: NOW }),
]);

beforeEach(() => {
  apiGet.mockReset();
});

describe("registration", () => {
  it("is offered on both editions, read-only, with no arguments, inside the description contract", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      const tool = harness(edition).get("anthropic_accounts");
      expect(tool.opts.readOnly).toBe(true);
      expect(Object.keys(tool.shape)).toEqual([]);
      expect(tool.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
      expect(tool.description).not.toMatch(BANNED_DESCRIPTION_RE);
      // The description is where the agent learns the queue rule.
      expect(tool.description).toMatch(/wait until the time it gives rather than retrying/);
    }
  });

  it("offers no tool that adds, removes, orders or re-authenticates an account", () => {
    // Those are the owner's, in Settings: the route refuses the MCP bearer 403
    // on every write, and a tool for one would only ever answer that refusal.
    for (const edition of ["openclaw", "hermes"] as const) {
      const names = harness(edition).names();
      expect(names.filter((n) => /anthropic/.test(n))).toEqual(["anthropic_accounts"]);
    }
  });
});

describe("anthropic_accounts", () => {
  it("reads the pool route and says how many can answer, which is in use and when the limited one is back", async () => {
    apiGet.mockResolvedValue(ONE_LIMITED);
    const out = await harness("openclaw").call("anthropic_accounts", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(apiGet).toHaveBeenCalledWith("/setup-api/anthropic/accounts", expect.objectContaining({ timeoutMs: 15_000 }));
    expect(JSON.parse(out.text)).toEqual({
      can_answer: "1 of 2",
      all_limited: false,
      next_reset: "2026-09-18T19:50:00.000Z",
      accounts: [
        { priority: 1, label: "Work Max", kind: "Claude account", status: "at its usage limit", back_at: "2026-09-18T19:50:00.000Z" },
        { priority: 2, label: "Personal Max", kind: "Claude account", status: "can answer", in_use: true },
      ],
    });
  });

  it("never passes on an email, an internal id, or a credential the route might carry", async () => {
    const leaky = {
      ...ONE_LIMITED,
      accounts: ONE_LIMITED.accounts.map((a) => ({
        ...a,
        // Not in the route's shape today. If a regression ever put them there,
        // the tool must still not hand them to the model.
        apiKey: "sk-ant-api03-LEAKLEAKLEAKLEAKLEAKLEAK",
        accessToken: "sk-ant-oat01-LEAKLEAKLEAKLEAK",
        refreshToken: "sk-ant-ort01-LEAKLEAKLEAKLEAK",
      })),
    };
    apiGet.mockResolvedValue(leaky);
    const out = await harness("hermes").call("anthropic_accounts", {});
    if (out.isError) throw new Error("expected an answer");
    expect(out.text).not.toMatch(/sk-ant-/);
    expect(out.text).not.toMatch(/LEAK/);
    expect(out.text).not.toMatch(/@example\.com/);
    expect(out.text).not.toMatch(/acct_work|acct_home/);
    expect(out.text).not.toMatch(/token|apiKey|email/i);
  });

  it("names every kind the pool holds in words, not the route's enum", async () => {
    apiGet.mockResolvedValue(pool([
      account({ id: "a", label: "Team key", kind: "api_key", priority: 1, active: true }),
      account({ id: "b", label: "Work Max", kind: "oauth", priority: 2 }),
      account({ id: "c", label: "This box's claude", kind: "login", priority: 3 }),
    ]));
    const out = await harness("openclaw").call("anthropic_accounts", {});
    if (out.isError) throw new Error("expected an answer");
    const body = JSON.parse(out.text) as { can_answer: string; accounts: { kind: string }[]; advice?: string };
    expect(body.can_answer).toBe("3 of 3");
    expect(body.accounts.map((a) => a.kind)).toEqual(["API key", "Claude account", "Claude Code sign-in"]);
    // Nothing to wait for, so nothing to advise.
    expect(body).not.toHaveProperty("advice");
    expect(body).not.toHaveProperty("next_reset");
  });

  it("tells the agent to wait for the first reset when every account is limited", async () => {
    apiGet.mockResolvedValue(pool([
      account({ id: "a", label: "Work Max", priority: 1, status: "limited", limitedUntil: LATER_RESET, limitKind: "weekly" }),
      account({ id: "b", label: "Personal Max", priority: 2, status: "limited", limitedUntil: RESET, limitKind: "session" }),
    ]));
    const out = await harness("openclaw").call("anthropic_accounts", {});
    if (out.isError) throw new Error("expected an answer");
    const body = JSON.parse(out.text) as Record<string, unknown>;
    expect(body).toMatchObject({ can_answer: "0 of 2", all_limited: true, next_reset: "2026-09-18T19:50:00.000Z" });
    expect(String(body.advice)).toMatch(/Wait until 2026-09-18T19:50:00\.000Z/);
    expect(String(body.advice)).toMatch(/resume by themselves/);
    expect(String(body.advice)).toMatch(/Do not start or retry Anthropic runs before it/);
    expect((body.accounts as { back_at?: string }[]).map((a) => a.back_at)).toEqual([
      "2026-09-18T22:10:00.000Z",
      "2026-09-18T19:50:00.000Z",
    ]);
  });

  it("says the owner must act when no account comes back by itself", async () => {
    apiGet.mockResolvedValue(pool([
      account({ id: "a", label: "Work Max", priority: 1, status: "expired" }),
      account({ id: "b", label: "Old key", kind: "api_key", priority: 2, status: "revoked" }),
    ]));
    const out = await harness("openclaw").call("anthropic_accounts", {});
    if (out.isError) throw new Error("expected an answer");
    const body = JSON.parse(out.text) as { all_limited: boolean; advice: string; accounts: { status: string }[] };
    expect(body.all_limited).toBe(true);
    expect(body).not.toHaveProperty("next_reset");
    expect(body.accounts.map((a) => a.status)).toEqual([
      "needs its sign-in renewed by the owner",
      "refused by Anthropic; the owner must re-authenticate it",
    ]);
    expect(body.advice).toMatch(/none comes back by itself/);
    expect(body.advice).toMatch(/Settings → Providers/);
  });

  it("answers an empty pool as an answer, not an error", async () => {
    apiGet.mockResolvedValue(pool([]));
    const out = await harness("hermes").call("anthropic_accounts", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/^No Anthropic account is connected on this box\./);
    expect(out.text).toMatch(/Settings → Providers/);
  });

  it("drops a reset time the route did not give rather than inventing one", async () => {
    apiGet.mockResolvedValue(pool([
      account({ id: "a", label: "Work Max", priority: 1, status: "limited", limitedUntil: null, limitKind: "rate" }),
      account({ id: "b", label: "Personal Max", priority: 2, active: true }),
    ]));
    const out = await harness("openclaw").call("anthropic_accounts", {});
    if (out.isError) throw new Error("expected an answer");
    const body = JSON.parse(out.text) as { next_reset?: string; accounts: Record<string, unknown>[] };
    expect(body.next_reset).toBeUndefined();
    expect(body.accounts[0]).toEqual({ priority: 1, label: "Work Max", kind: "Claude account", status: "at its usage limit" });
  });

  it("surfaces a store the box could not read as a tool error, without the route's body", async () => {
    apiGet.mockRejectedValue(new ApiError(503, JSON.stringify({
      error: "The Anthropic accounts could not be read: EACCES /home/clawbox/.clawbox/secrets",
      code: "store_unavailable",
    })));
    const out = await harness("openclaw").call("anthropic_accounts", {});
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.error).toBe(true);
    expect(JSON.stringify(out.error)).not.toMatch(/secrets|EACCES/);
  });
});
