import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import ReconnectStage from "@/components/ReconnectStage";

/**
 * ReconnectStage draws through a portal, and a portal has no server rendering.
 * It used to decide that with `typeof document`, which is true on the client's
 * FIRST render too — so on the one page that mounts it from the server's HTML
 * (/updating) the hydrating render produced a portal the server never sent,
 * and React threw hydration error #418 into the console as the update screen
 * opened. The first client render must match the server's (nothing), and the
 * portal must arrive straight after.
 */

function Page() {
  return (
    <>
      <div data-testid="floor">System Update</div>
      <ReconnectStage steps={["Preparing update..."]} phaseIndex={0} completed={false} title="System Update" description="Updating" />
    </>
  );
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("ReconnectStage on a server-rendered page", () => {
  it("hydrates without a mismatch, then shows the overlay", async () => {
    // The server has no document.
    const realDocument = globalThis.document;
    vi.stubGlobal("document", undefined);
    const html = renderToString(<Page />);
    vi.stubGlobal("document", realDocument);
    expect(html).toContain("System Update");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const recoverable: unknown[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await act(async () => {
      hydrateRoot(container, <Page />, { onRecoverableError: (err) => { recoverable.push(err); } });
    });

    expect(recoverable).toEqual([]);
    expect(errors.mock.calls.filter((c) => /hydrat/i.test(String(c[0])))).toEqual([]);
    // …and the overlay is on screen once the page is live.
    expect(document.body.querySelector("[role='status'], [data-testid='reconnect-stage'], .fixed")).not.toBeNull();
    expect(document.body.textContent).toContain("Preparing update...");
    errors.mockRestore();
  });
});
