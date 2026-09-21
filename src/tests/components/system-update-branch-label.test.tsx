import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import SystemUpdateApp from "@/components/SystemUpdateApp";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/**
 * The Branch override input under Advanced options was named by its
 * placeholder alone: the visible "Branch override" text was a <div>, so the
 * accessible name was "main / beta / clawkeep" and a screen reader had no way
 * to tell what the field was for (UI sweep, 2026-09-07). The visible text is
 * now a <label htmlFor> bound to the input.
 */
describe("SystemUpdateApp — the Branch override input's name", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/setup-api/update/versions")) {
          return jsonResponse({
            clawbox: { current: "3.1.11", target: "3.1.11", updateAvailable: false },
            openclaw: { current: "2026.7.1", target: "2026.7.1", updateAvailable: false },
          });
        }
        if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: "beta" });
        // Not "running" — otherwise the mount effect would join a live poll
        // and render the "updating" hero instead of "up to date".
        if (url.includes("/setup-api/update/status")) return jsonResponse({ phase: "idle", steps: [] });
        return jsonResponse({});
      }),
    );
  });

  it("is labelled by the visible 'Branch override' text, not by its placeholder", async () => {
    render(<SystemUpdateApp />);
    await screen.findByText("You're up to date");
    fireEvent.click(screen.getByRole("button", { name: /Advanced options/ }));

    const input = screen.getByLabelText("Branch override");
    expect(input.tagName).toBe("INPUT");
    expect((input as HTMLInputElement).value).toBe("beta");
    // The label is a real <label>, so a click on the text focuses the field.
    const label = screen.getByText("Branch override");
    expect(label.tagName).toBe("LABEL");
    expect(label.getAttribute("for")).toBe(input.id);
    expect(input.id).not.toBe("");
  });
});
