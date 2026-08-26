/**
 * The chat's "coding agent is working" indicator.
 *
 * The bug it exists for: `coding_agent_run` answers 202 with a run id in
 * milliseconds, so the chat's tool pill for it reaches "done" almost at once
 * while the run itself works for minutes. Anything driven by the tool-call
 * lifecycle would therefore go quiet while the box is busy. These tests pin
 * that the indicator follows the DEVICE's run record instead, and that it
 * stops asking the moment there is nothing to ask about.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { renderHook } from "@testing-library/react";
import { translations } from "@/lib/translations";
import CodingAgentActivityPill from "@/components/CodingAgentActivityPill";
import { isCodingAgentTool, useCodingAgentActivity } from "@/lib/use-coding-agent-activity";

const RUNNING = {
  id: "run-k3x9q2ab",
  projectId: "timer",
  task: "Build a countdown timer",
  status: "running",
  startedAt: Date.now() - 95_000,
  source: "agent",
};

function runsResponse(runs: unknown[]) {
  return new Response(JSON.stringify({ runs }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("which tools mean a run may have started", () => {
  it("recognises the coding-agent family and nothing else", () => {
    for (const name of ["coding_agent_run", "coding_agent_status", "clawbox__coding_agent_run"]) {
      expect(isCodingAgentTool(name), name).toBe(true);
    }
    for (const name of ["bash", "code_project_init", "web_search", "email_send"]) {
      expect(isCodingAgentTool(name), name).toBe(false);
    }
  });
});

describe("useCodingAgentActivity", () => {
  it("asks the device once when the chat opens, and reports a run in flight", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => { urls.push(String(url)); return runsResponse([RUNNING]); });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCodingAgentActivity(true));

    await waitFor(() => expect(result.current.run?.id).toBe("run-k3x9q2ab"));
    expect(result.current.run?.projectId).toBe("timer");
    expect(urls[0]).toMatch(/\/setup-api\/coding-agent\/runs\?limit=/);
  });

  it("does not poll when nothing is running — an idle box is asked once and left alone", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => runsResponse([{ ...RUNNING, status: "completed" }]));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.run).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps asking while a run is in flight, and stops as soon as it ends", async () => {
    vi.useFakeTimers();
    let status = "running";
    const fetchMock = vi.fn(async () => runsResponse([{ ...RUNNING, status }]));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    const whileRunning = fetchMock.mock.calls.length;
    expect(whileRunning).toBeGreaterThan(1);

    // `waitFor` polls on real timers, which never advance here — drive the
    // clock instead and read the state directly.
    status = "completed";
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(result.current.run).toBeNull();

    const afterEnd = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock.mock.calls.length).toBe(afterEnd);
  });

  it("asks nothing at all while the chat is closed", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => runsResponse([RUNNING]));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useCodingAgentActivity(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says nothing rather than claiming work when the device cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.run).toBeNull());
  });
});

describe("the pill", () => {
  const t = (k: string) => translations.en[k] ?? k;

  it("names the work, the project and how long it has been going", () => {
    render(
      <CodingAgentActivityPill
        run={{ id: "run-k3x9q2ab", projectId: "timer", task: "x", startedAt: Date.now() - 95_000, source: "agent" }}
        label={t("codingAgent.chatWorking")}
        ownerLabel={t("codingAgent.chatWorkingOwner")}
        openLabel={t("codingAgent.chatOpenApp")}
      />,
    );
    const pill = screen.getByTestId("coding-agent-activity");
    expect(pill.textContent).toContain(translations.en["codingAgent.chatWorking"]);
    expect(pill.textContent).toContain("timer");
    expect(pill.textContent).toMatch(/1m 3[0-9]s/);
    // Announced, because it appears without the owner doing anything.
    expect(pill).toHaveAttribute("role", "status");
  });

  it("does not credit the assistant for a run the owner started", () => {
    render(
      <CodingAgentActivityPill
        run={{ id: "run-x", projectId: null, task: "x", startedAt: Date.now(), source: "owner" }}
        label={t("codingAgent.chatWorking")}
        ownerLabel={t("codingAgent.chatWorkingOwner")}
        openLabel={t("codingAgent.chatOpenApp")}
      />,
    );
    const pill = screen.getByTestId("coding-agent-activity");
    expect(pill.textContent).toContain(translations.en["codingAgent.chatWorkingOwner"]);
    expect(pill.textContent).not.toContain(translations.en["codingAgent.chatWorking"]);
  });

  it("offers a way into the app only when there is somewhere to go", () => {
    const onOpen = vi.fn();
    const { rerender } = render(
      <CodingAgentActivityPill
        run={{ id: "run-x", projectId: null, task: "x", startedAt: Date.now(), source: "agent" }}
        label={t("codingAgent.chatWorking")}
        ownerLabel={t("codingAgent.chatWorkingOwner")}
        openLabel={t("codingAgent.chatOpenApp")}
        onOpen={onOpen}
      />,
    );
    screen.getByRole("button", { name: translations.en["codingAgent.chatOpenApp"] }).click();
    expect(onOpen).toHaveBeenCalledTimes(1);

    rerender(
      <CodingAgentActivityPill
        run={{ id: "run-x", projectId: null, task: "x", startedAt: Date.now(), source: "agent" }}
        label={t("codingAgent.chatWorking")}
        ownerLabel={t("codingAgent.chatWorkingOwner")}
        openLabel={t("codingAgent.chatOpenApp")}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
