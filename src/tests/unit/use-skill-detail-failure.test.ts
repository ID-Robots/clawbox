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

describe("a skill Hermes says does not exist", () => {
  const UNBACKED = { id: "no-such-skill", name: "no-such-skill", catalogMiss: true, needsRemoteDocs: true };

  it("stops showing the placeholder and says so, instead of blaming the documentation", async () => {
    // Phase 1 cannot refuse an id — its catalogue is a snapshot and a
    // related-skill chip carries a bare name — so it marks the record unbacked
    // and phase 2 asks Hermes. Hermes refusing it is the answer: the panel used
    // to keep the placeholder on screen under "couldn't load the documentation",
    // and the placeholder's name is the requested id echoed back.
    answer = (url) =>
      url.includes("docs=1")
        ? { ok: false, status: 404, body: { error: "Skill not found", code: "not_found" } }
        : { ok: true, status: 200, body: { skill: UNBACKED } };

    const { result } = renderHook(() => useSkillDetail("no-such-skill", false));

    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));
    expect(result.current.error?.part).toBe("meta");
    expect(result.current.detail).toBeNull();
    // …and it is a TERMINAL state, not a reload. The derived phase is
    // `stale ? 'meta' : phase` and `stale` is `!held`, so DROPPING the record
    // sent the phase back to 'meta' for as long as the panel stayed open —
    // which is what `SkillDetail` reads as `docsPending`, painting a
    // documentation skeleton underneath "there's nothing to show". A spinner
    // that never resolves next to "this does not exist" is the contradiction
    // this card exists to remove.
    expect(result.current.phase).toBe("done");
  });

  it("keeps a real skill on screen when only its documentation was refused", async () => {
    // Same 404, over a record the catalogue DID back: that is a documentation
    // failure and nothing more, and the metadata stays.
    answer = (url) =>
      url.includes("docs=1")
        ? { ok: false, status: 404, body: { error: "Skill not found", code: "not_found" } }
        : { ok: true, status: 200, body: { skill: { ...DETAIL, needsRemoteDocs: true } } };

    const { result } = renderHook(() => useSkillDetail(ID, false));

    await waitFor(() => expect(result.current.error?.part).toBe("docs"));
    expect(result.current.detail?.name).toBe("PDF Tools");
  });

  it("does not cache the placeholder, so reopening asks again", async () => {
    // The unbacked record was remembered before phase 2 ran; leaving it cached
    // would paint the same imaginary skill on the next open without asking.
    let refused = true;
    answer = (url) => {
      if (url.includes("docs=1")) {
        return refused
          ? { ok: false, status: 404, body: { error: "Skill not found", code: "not_found" } }
          : { ok: true, status: 200, body: { delta: { body: "# Real after all" } } };
      }
      return { ok: true, status: 200, body: { skill: UNBACKED } };
    };

    const { result } = renderHook(() => useSkillDetail("no-such-skill", false));
    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));

    refused = false;
    await act(async () => {
      result.current.refresh("no-such-skill");
    });

    await waitFor(() => expect(result.current.detail?.body).toBe("# Real after all"));
    expect(result.current.error).toBeNull();
  });
});

describe("which skill the PANEL's own state belongs to", () => {
  it("never paints one tab's skill for the other tab's id — not even for the frame before the fetch starts", async () => {
    // 40 ClawHub ids collide with a bundled skill on this device, which is why
    // the route takes a `scope` at all. The effect runs AFTER the render that
    // switched tabs, so for that render the state still holds the other tab's
    // answer — and its `id` matches, which is what used to let it through.
    answer = (url) =>
      url.includes("scope=installed")
        ? { ok: true, status: 200, body: { skill: { ...DETAIL, name: "The installed one" } } }
        : { ok: true, status: 200, body: { skill: { ...DETAIL, name: "The store one" } } };

    const painted: (string | undefined)[] = [];
    const { result, rerender } = renderHook(
      ({ installed }: { installed: boolean }) => {
        const controller = useSkillDetail(ID, installed);
        painted.push(controller.detail?.name);
        return controller;
      },
      { initialProps: { installed: true } },
    );

    await waitFor(() => expect(result.current.detail?.name).toBe("The installed one"));
    const before = painted.length;

    await act(async () => {
      rerender({ installed: false });
    });

    expect(painted.slice(before)).not.toContain("The installed one");
    await waitFor(() => expect(result.current.detail?.name).toBe("The store one"));
  });

  it("does not show the failure from the last visit while this visit is still asking", async () => {
    // Installed(id) -> Browse(id) -> Installed(id). Both visits to Installed
    // carry the same cache key, and `refresh()` was never called, so anything
    // tagged by key plus reload count came back looking current — and sat under
    // the panel for the whole of the second visit's request.
    let installedFails = true;
    answer = (url) => {
      if (!url.includes("scope=installed")) return { ok: true, status: 200, body: { skill: DETAIL } };
      return installedFails
        ? { ok: false, status: 502, body: { error: "…", code: "cli_failed" } }
        : { ok: true, status: 200, body: { skill: { ...DETAIL, name: "The installed one" } } };
    };

    const { result, rerender } = renderHook(
      ({ installed }: { installed: boolean }) => useSkillDetail(ID, installed),
      { initialProps: { installed: true } },
    );

    await waitFor(() => expect(result.current.error?.code).toBe("cli_failed"));

    await act(async () => {
      rerender({ installed: false });
    });
    await waitFor(() => expect(result.current.detail?.name).toBe("PDF Tools"));

    // Back to the tab that failed. Its request is in flight again; the old
    // note describes an attempt two visits ago.
    installedFails = false;
    await act(async () => {
      rerender({ installed: true });
    });
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.detail?.name).toBe("The installed one"));
    expect(result.current.error).toBeNull();
  });

  it("does not keep one tab's ambiguity over the other tab's answer", async () => {
    // The ambiguity chooser is answered by the docs phase, and nothing clears
    // it: tagged by id alone it survived a switch to the other scope, where it
    // offered candidates for a question that scope never asked.
    answer = (url) => {
      if (url.includes("docs=1")) {
        return { ok: true, status: 200, body: { ambiguous: true, query: ID, candidates: [{ id: "a/one" }] } };
      }
      return url.includes("scope=installed")
        ? { ok: true, status: 200, body: { skill: { ...DETAIL, needsRemoteDocs: true } } }
        : { ok: true, status: 200, body: { skill: DETAIL } };
    };

    const { result, rerender } = renderHook(
      ({ installed }: { installed: boolean }) => useSkillDetail(ID, installed),
      { initialProps: { installed: true } },
    );

    await waitFor(() => expect(result.current.ambiguous?.candidates).toHaveLength(1));

    await act(async () => {
      rerender({ installed: false });
    });

    await waitFor(() => expect(result.current.detail?.name).toBe("PDF Tools"));
    expect(result.current.ambiguous).toBeNull();
  });
});
