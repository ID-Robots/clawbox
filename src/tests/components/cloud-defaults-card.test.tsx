/**
 * Settings → Local AI, the ClawBox AI cloud card
 * (src/components/CloudDefaultsCard.tsx).
 *
 * Pinned: the card reports what the SERVER said and decides nothing itself;
 * "use this box" goes to the route that already owns that change (and records
 * the owner's pin on the way through) rather than to a second implementation;
 * a box with no subscription gets one sentence and a way to connect one, not an
 * error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import CloudDefaultsCard from "@/components/CloudDefaultsCard";

type Row = { source: string; target: string; ownerChoice: boolean; reason: string | null };

const cloud: Row = { source: "cloud", target: "cloud", ownerChoice: false, reason: null };
const box = (reason: string | null, over: Partial<Row> = {}): Row =>
  ({ source: "local", target: "local", ownerChoice: false, reason, ...over });

let posts: { url: string; body: unknown }[] = [];

function stubFetch(status: unknown) {
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("/setup-api/ai-cloud-defaults")) {
      if (status === null) return new Response("", { status: 404 });
      return new Response(JSON.stringify(status), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }));
}

function draw() {
  return render(
    <I18nProvider><CloudDefaultsCard active /></I18nProvider>,
  );
}

beforeEach(() => { posts = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("CloudDefaultsCard", () => {
  it("says which engine answers for each capability", async () => {
    stubFetch({
      linked: true,
      plan: "pro",
      capabilities: { tts: cloud, stt: cloud, embeddings: box("route_unavailable", { target: "local" }) },
    });
    draw();
    await screen.findByTestId("cloud-defaults-card");
    // The catalogue arrives in an effect (I18nProvider), so the first paint
    // carries raw keys — every text assertion here waits for the copy.
    await waitFor(() => expect(screen.getByTestId("cloud-default-source-embeddings")).toHaveTextContent("This box"));
    // Exact, not a substring: the raw key `localModels.cloud.onCloud` contains
    // the word this asserts, so a loose match passes before the copy arrives.
    expect(screen.getByTestId("cloud-default-source-tts").textContent).toBe("Cloud");
    // The reason is what makes the row actionable — each one has a different fix.
    expect(screen.getByTestId("cloud-default-reason-embeddings")).toHaveTextContent(/not serving this yet/i);
  });

  it("sends 'use this box' to the route that already owns that change", async () => {
    stubFetch({ linked: true, plan: "pro", capabilities: { tts: cloud, stt: cloud, embeddings: cloud } });
    draw();
    fireEvent.click(await screen.findByTestId("cloud-default-switch-tts"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/setup-api/tts", body: { action: "select", choice: "local" } });
    fireEvent.click(screen.getByTestId("cloud-default-switch-stt"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({ url: "/setup-api/stt", body: { primary: "local" } });
  });

  it("hands a pinned capability back to the cloud through the defaults route", async () => {
    stubFetch({
      linked: true,
      plan: "pro",
      capabilities: { tts: box("owner", { ownerChoice: true }), stt: cloud, embeddings: cloud },
    });
    draw();
    const button = await screen.findByTestId("cloud-default-switch-tts");
    await waitFor(() => expect(button).toHaveTextContent("Use the cloud"));
    fireEvent.click(button);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/setup-api/ai-cloud-defaults", body: { capability: "tts" } });
  });

  it("offers no cloud button for a capability the subscription cannot serve", async () => {
    // A button that would answer its own refusal is worse than none: the row
    // states the reason instead.
    stubFetch({
      linked: true,
      plan: "flash",
      capabilities: { tts: box("plan"), stt: cloud, embeddings: box("plan") },
    });
    draw();
    await screen.findByTestId("cloud-defaults-card");
    expect(screen.queryByTestId("cloud-default-switch-tts")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("cloud-default-reason-tts")).toHaveTextContent(/plan does not include/i));
  });

  it("tells an unlinked box why, and how to connect one, without an error", async () => {
    stubFetch({
      linked: false,
      plan: null,
      capabilities: { tts: box("not_linked"), stt: box("not_linked"), embeddings: box("not_linked") },
    });
    draw();
    const note = await screen.findByTestId("cloud-defaults-unlinked");
    await waitFor(() => expect(note).toHaveTextContent(/no ClawBox AI subscription/i));
    expect(screen.getByTestId("cloud-defaults-connect")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("draws nothing at all against a server that has no such route", async () => {
    stubFetch(null);
    const { container } = draw();
    await waitFor(() => expect(container.querySelector('[data-testid="cloud-defaults-card"]')).toBeNull());
  });
});
