// @vitest-environment jsdom
/**
 * `/app/<id>` asks which harness this box runs — ONCE, and fails closed on the
 * answer it gets.
 *
 * The desktop asks the same question with a bounded retry (`{ force: true }`,
 * two more attempts, 500 ms apart) precisely because the answer can be
 * temporarily unknowable: `install.sh` truncates and rewrites the root-owned
 * edition lock on every update, and a page that mounts inside that window is
 * told "openclaw, and that was a guess" — `activeKnown: false`. On this page a
 * single probe made that permanent for the life of the tab: the OpenClaw App
 * Store rendered on a Hermes box, and the box's own brand never appeared.
 *
 * Both surfaces now go through ONE helper, so a retry rule can never exist on
 * one screen and not the other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { render, screen } from "@/tests/helpers/test-utils";
import StandaloneAppPage from "@/app/app/[id]/page";

type Probe = { active?: string; edition?: string; activeKnown?: boolean } | null;

const harnessMock = vi.hoisted(() => vi.fn<(options?: { force?: boolean; signal?: AbortSignal }) => Promise<Probe>>());

// `/app/store` — an app that exists on OpenClaw and not on Hermes, so the
// answer decides what the customer sees.
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "store" }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("next/image", () => ({ default: () => null }));
// Only `fetchHarness` is mocked: the retry helper under test is the real one,
// and this is the request it makes.
vi.mock("@/lib/client-harness", () => ({ fetchHarness: harnessMock }));

beforeEach(() => {
  harnessMock.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/app/<id> — a probe that could not name the harness", () => {
  it("asks again, and hides the OpenClaw app the box does not have", async () => {
    // The update window, then the settled answer.
    harnessMock
      .mockResolvedValueOnce({ active: "openclaw", edition: "openclaw", activeKnown: false })
      .mockResolvedValue({ active: "hermes", edition: "hermes", activeKnown: true });

    render(<StandaloneAppPage />);

    expect(await screen.findByText(/App not found: store/)).toBeInTheDocument();
    expect(harnessMock.mock.calls.length).toBeGreaterThan(1);
    // The second ask must go past the client cache, or it is the same stale
    // reply read twice.
    expect(harnessMock).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));
  });

  it("does not ask twice when the first answer is the device's own", async () => {
    // The cost guard: a settled answer is the end of it. Every mount paying for
    // three round-trips would be the other failure.
    harnessMock.mockResolvedValue({ active: "openclaw", edition: "openclaw", activeKnown: true });

    render(<StandaloneAppPage />);

    expect(await screen.findByRole("link")).toBeInTheDocument();
    expect(harnessMock).toHaveBeenCalledTimes(1);
  });
});
