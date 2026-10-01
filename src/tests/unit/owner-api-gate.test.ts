// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { _resetSessionUserForTest, mayUseOwnerApis, useMayUseOwnerApis } from "@/lib/use-session-user";
import { useClawboxLogin } from "@/lib/use-clawbox-login";
import { useClawkeepShieldStatus } from "@/hooks/useClawkeepShieldStatus";
import { useWhatsNew } from "@/lib/use-whats-new";

// Multi-user ClawBox OS (TASK-1256): the desktop's owner-only requests wait on
// one gate — "has the box said this session is the owner's?" — so a non-owner's
// desktop sends none of the requests the middleware would refuse with 403. The
// gate is about noise, never access: when /users/me cannot be had, the desktop
// behaves as the owner's always did and the server still refuses what it must.

function stubUsersMe(response: { ok: boolean; body?: unknown } | Error) {
  const fetchMock = vi.fn(async (input: unknown) => {
    if (String(input).includes("/setup-api/users/me")) {
      if (response instanceof Error) throw response;
      return { ok: response.ok, status: response.ok ? 200 : 500, json: async () => response.body };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const calledFor = (fetchMock: ReturnType<typeof vi.fn>, fragment: string) =>
  fetchMock.mock.calls.some(([u]) => String(u).includes(fragment));

beforeEach(() => {
  _resetSessionUserForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetSessionUserForTest();
});

describe("mayUseOwnerApis", () => {
  it("is true for the owner", async () => {
    stubUsersMe({ ok: true, body: { username: "clawbox", isOwner: true, multiUser: true } });
    await expect(mayUseOwnerApis()).resolves.toBe(true);
  });

  it("is false for another ClawBox user", async () => {
    stubUsersMe({ ok: true, body: { username: "alice", isOwner: false, multiUser: true } });
    await expect(mayUseOwnerApis()).resolves.toBe(false);
  });

  it("stays the owner's answer when /users/me fails or cannot be reached", async () => {
    stubUsersMe({ ok: false, body: { error: "boom" } });
    await expect(mayUseOwnerApis()).resolves.toBe(true);
    _resetSessionUserForTest();
    stubUsersMe(new TypeError("network down"));
    await expect(mayUseOwnerApis()).resolves.toBe(true);
    _resetSessionUserForTest();
    stubUsersMe({ ok: true, body: { nonsense: 1 } });
    await expect(mayUseOwnerApis()).resolves.toBe(true);
  });

  it("asks /users/me once for every caller on the page", async () => {
    const fetchMock = stubUsersMe({ ok: true, body: { username: "alice", isOwner: false, multiUser: true } });
    await Promise.all([mayUseOwnerApis(), mayUseOwnerApis(), mayUseOwnerApis()]);
    await mayUseOwnerApis();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("useMayUseOwnerApis", () => {
  it("is null until the box answers, then settles", async () => {
    stubUsersMe({ ok: true, body: { username: "alice", isOwner: false, multiUser: true } });
    const { result } = renderHook(() => useMayUseOwnerApis());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("settles true for the owner", async () => {
    stubUsersMe({ ok: true, body: { username: "clawbox", isOwner: true, multiUser: false } });
    const { result } = renderHook(() => useMayUseOwnerApis());
    await waitFor(() => expect(result.current).toBe(true));
  });
});

describe("the desktop's owner-only hooks, disabled", () => {
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it("useClawboxLogin asks nothing and stays unresolved until enabled", async () => {
    const fetchMock = stubUsersMe({ ok: true, body: {} });
    const { result, rerender } = renderHook(({ enabled }) => useClawboxLogin(undefined, enabled), {
      initialProps: { enabled: false },
    });
    await settle();
    expect(calledFor(fetchMock, "/setup-api/ai-models/status")).toBe(false);
    expect(result.current.loading).toBe(true);

    // The owner's desktop enables it once /users/me has answered.
    rerender({ enabled: true });
    await waitFor(() => expect(calledFor(fetchMock, "/setup-api/ai-models/status")).toBe(true));
  });

  it("useClawkeepShieldStatus asks nothing", async () => {
    const fetchMock = stubUsersMe({ ok: true, body: {} });
    const { result } = renderHook(() => useClawkeepShieldStatus(false));
    await settle();
    expect(calledFor(fetchMock, "/setup-api/clawkeep")).toBe(false);
    expect(result.current.protection).toBeNull();
  });

  it("useWhatsNew asks nothing and shows nothing", async () => {
    const fetchMock = stubUsersMe({ ok: true, body: {} });
    const { result } = renderHook(() => useWhatsNew("free", false));
    await settle();
    expect(calledFor(fetchMock, "/setup-api/whats-new")).toBe(false);
    expect(result.current.visible).toBe(false);
  });

  it("every one of them still asks by default — no other caller changes", async () => {
    const fetchMock = stubUsersMe({ ok: true, body: {} });
    renderHook(() => {
      useClawboxLogin();
      useClawkeepShieldStatus();
      useWhatsNew();
    });
    await waitFor(() => {
      expect(calledFor(fetchMock, "/setup-api/ai-models/status")).toBe(true);
      expect(calledFor(fetchMock, "/setup-api/clawkeep")).toBe(true);
      expect(calledFor(fetchMock, "/setup-api/whats-new")).toBe(true);
    });
  });
});
