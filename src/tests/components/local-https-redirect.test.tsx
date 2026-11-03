import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

import LocalHttpsRedirect from "@/components/LocalHttpsRedirect";
import { PROBE_FAILED_KEY } from "@/lib/local-https-client";

/**
 * The root layout's mover (docs/design/local-https.md, "Moving the browser").
 * jsdom serves the page on http://localhost — loopback, which is already a
 * secure context — so the component must not even ask. The rules for a LAN
 * page are pinned on src/lib/local-https-client.ts.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("LocalHttpsRedirect", () => {
  it("renders nothing and asks nothing on loopback", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<LocalHttpsRedirect />);
    await settle();
    expect(container.innerHTML).toBe("");
    expect(window.location.hostname).toBe("localhost");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the failed-probe key the client module names", () => {
    expect(PROBE_FAILED_KEY).toBe("clawbox:local-https-probe-failed");
  });
});
