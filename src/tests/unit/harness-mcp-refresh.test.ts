import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The fifth boot-time snapshot, and the biggest: WHICH HARNESS IS ACTIVE.
 *
 * `mcp/lib/edition.ts` resolves it once while the ClawBox MCP stdio child
 * boots, and that one answer decides which harness's built-in apps
 * `ui_open_app`/`ui_list_apps` offer, which tool families are registered at
 * all, what `device_status` calls the agent and which field guide
 * `clawbox_context` serves. `/setup-api/harness/select` deliberately does not
 * bounce the other gateway, so on the dual SKU nothing told that child — and
 * `ui_open_app("hermes")` went on answering "There is no such app on this
 * ClawBox" for the box's own dashboard until the next MCP restart (TASK-715,
 * TASK-541's symptom returning through the switch).
 *
 * The mechanism is the harness's own `reload.mcp`, shared with the four
 * siblings; what is pinned here is the RULE for when it is worth paying for.
 */

const rpcMock = vi.hoisted(() => vi.fn());
const activeHarnessMock = vi.hoisted(() => vi.fn(async () => "hermes" as string));

vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: rpcMock }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: activeHarnessMock }));

import { refreshHarnessToolsIfSwitched } from "@/lib/harness-mcp-refresh";
import { reportMcpReloadRefused } from "@/lib/hermes-mcp-reload";
import { LOG_FIELD_MAX_LENGTH } from "@/lib/log-safe";

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rpcMock.mockReset();
  activeHarnessMock.mockReset();
  activeHarnessMock.mockResolvedValue("hermes");
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("the agent's tool list, after the owner switches harness", () => {
  it("asks the harness to rebuild it when the harness really moved", async () => {
    rpcMock.mockResolvedValue({ status: "ok" });

    await expect(refreshHarnessToolsIfSwitched("openclaw", "hermes")).resolves.toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("reload.mcp", { confirm: true });
  });

  it("asks in the other direction too", async () => {
    rpcMock.mockResolvedValue({ status: "ok" });

    await expect(refreshHarnessToolsIfSwitched("hermes", "openclaw")).resolves.toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("costs nothing when the owner re-selects the harness already running", async () => {
    // A reload respawns every MCP child and invalidates the model's prompt
    // cache, so the next turn re-pays for a system prompt that was cached. A
    // save that changed nothing the agent can see must not buy that.
    await expect(refreshHarnessToolsIfSwitched("hermes", "hermes")).resolves.toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("says so rather than reporting a reload the dashboard refused", async () => {
    // `confirm_required` is an ordinary non-error reply that means NOTHING
    // HAPPENED — the false-success shape the shared helper exists to catch.
    rpcMock.mockResolvedValue({ status: "confirm_required" });

    await expect(refreshHarnessToolsIfSwitched("openclaw", "hermes")).resolves.toBe(false);
  });

  it("never throws when there is no dashboard to ask", async () => {
    rpcMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(refreshHarnessToolsIfSwitched("openclaw", "hermes")).resolves.toBe(false);
  });
});

/**
 * TASK-742 — the two words this helper writes into the journal.
 *
 * `before` and `after` reach `refreshHarnessToolsIfSwitched` from the body of
 * `POST /setup-api/harness/select`, and the line built from them is written in
 * three places: this module's success line and both arms of
 * `reportMcpReloadRefused`. CodeQL reported all three (`js/log-injection`
 * #516-#518). `isHarness()` narrows the body's field to two names and the
 * signature says `string`, but a `.test()`-shaped narrowing leaves the
 * caller's own string in play — the same thing #464 says about `ACTIONS.find`.
 *
 * So the LINE is spelled from this module's literals while the COMPARISON
 * keeps the raw values: two unknown-but-different harnesses must still read as
 * a move, which they would not if the rebuild collapsed them onto one word.
 */
describe("the harness names that reach the journal", () => {
  it("writes the box's own words for a move it recognises", async () => {
    rpcMock.mockResolvedValue({ status: "ok" });

    await refreshHarnessToolsIfSwitched("openclaw", "hermes");

    expect(logSpy).toHaveBeenCalledWith(
      "[harness/select] the active harness moved from openclaw to hermes; asked Hermes to reload its MCP servers",
    );
  });

  it("does not echo a name that is not one of the two", async () => {
    rpcMock.mockResolvedValue({ status: "ok" });

    await refreshHarnessToolsIfSwitched("openclaw", "hermes\nWARN root login accepted");

    const line = String(logSpy.mock.calls.at(-1)?.[0]);
    expect(line).not.toContain("root login accepted");
    expect(line).toContain("an unrecognised harness");
    // One value, one record: the injected newline cannot become a second line.
    expect(line.split(String.fromCharCode(10))).toHaveLength(1);
  });

  it("keeps the same rule on the arm that reports a refusal", async () => {
    // The Hermes box that HAS a dashboard and it said no — `console.error`,
    // hermes-mcp-reload.ts:110, the third of the three alerts.
    rpcMock.mockResolvedValue({ status: "confirm_required" });

    await refreshHarnessToolsIfSwitched("openclaw", "hermes\nWARN root login accepted");

    const line = String(errorSpy.mock.calls.at(-1)?.[0]);
    expect(line).not.toContain("root login accepted");
    expect(line).toContain("an unrecognised harness");
    expect(line.split(String.fromCharCode(10))).toHaveLength(1);
  });
});

/**
 * TASK-742 — and the shared reporter bounds whatever its callers hand it.
 *
 * `reportMcpReloadRefused` is the one line five families share, and one of them
 * (`provider-mcp-refresh`) builds `what` by joining a provider list whose
 * length nothing here decides. `logSafe`'s two rules are about the RECORD, not
 * the value's provenance: one value stays one line, and one caller does not
 * decide how much gets written.
 */
describe("reportMcpReloadRefused bounds the record", () => {
  it("keeps one value to one line on the no-dashboard arm", async () => {
    activeHarnessMock.mockResolvedValue("openclaw");

    await reportMcpReloadRefused("provider/refresh", "gained a\nWARN root login accepted");

    const line = String(logSpy.mock.calls.at(-1)?.[0]);
    expect(line.split(String.fromCharCode(10))).toHaveLength(1);
    expect(line).not.toContain("\nWARN");
  });

  it("caps a caller-sized value on the refusal arm", async () => {
    activeHarnessMock.mockResolvedValue("hermes");

    await reportMcpReloadRefused("provider/refresh", "x".repeat(LOG_FIELD_MAX_LENGTH + 500));

    const line = String(errorSpy.mock.calls.at(-1)?.[0]);
    expect(line).toContain("...[+500 chars]");
    expect(line.length).toBeLessThan(LOG_FIELD_MAX_LENGTH + 200);
  });
});
