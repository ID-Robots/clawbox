// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSkillDetail } from "@/components/hermes-skills/useSkillDetail";

/**
 * HERMES-04. The panel's note is a CODE now, and it belongs to one skill in one
 * TAB: the same string is a lock name in the Installed tab and a registry
 * identifier in Browse, which are two different skills with two different
 * answers — the cache has always kept them apart, the failure did not.
 */
const ID = "pdf-tools";
const DETAIL = { id: ID, name: "PDF Tools", source: "official", trust: "official", needsRemoteDocs: false };

let answer: (url: string) => { ok: boolean; status: number; body: unknown };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const { ok, status, body } = answer(String(input));
      return { ok, status, json: async () => body } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("which skill a detail failure belongs to", () => {
  it("is not shown for the other tab's skill of the same name", async () => {
    // Installed fails, Browse answers: one id, two scopes, two outcomes.
    answer = (url) =>
      url.includes("scope=installed")
        ? { ok: false, status: 502, body: { error: "…", code: "cli_missing" } }
        : { ok: true, status: 200, body: { skill: DETAIL } };

    const { result, rerender } = renderHook(
      ({ installed }: { installed: boolean }) => useSkillDetail(ID, installed),
      { initialProps: { installed: true } },
    );

    await waitFor(() => expect(result.current.error?.code).toBe("cli_missing"));

    await act(async () => {
      rerender({ installed: false });
    });

    await waitFor(() => expect(result.current.detail?.name).toBe("PDF Tools"));
    expect(result.current.error).toBeNull();
  });

  it("is dropped when the same panel is asked again and answers", async () => {
    // `refresh()` re-runs the fetch after an install; the note from the failed
    // attempt used to sit under the panel that had just loaded.
    let failing = true;
    answer = () =>
      failing
        ? { ok: false, status: 502, body: { error: "…", code: "cli_failed" } }
        : { ok: true, status: 200, body: { skill: DETAIL } };

    const { result } = renderHook(() => useSkillDetail(ID, false));

    await waitFor(() => expect(result.current.error?.part).toBe("meta"));

    failing = false;
    await act(async () => {
      result.current.refresh(ID);
    });

    await waitFor(() => expect(result.current.detail?.name).toBe("PDF Tools"));
    expect(result.current.error).toBeNull();
  });
});
