import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import SystemUpdateApp from "@/components/SystemUpdateApp";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/**
 * TASK-1213: a box with no recorded update branch left its owner asking which
 * branch to enter under Advanced options — the field was simply empty. The
 * section now says which branch updates actually follow, and why.
 */
describe("SystemUpdateApp — Advanced options names the effective update branch", () => {
  let branchAnswer: unknown;
  let saveAnswer: unknown;

  beforeEach(() => {
    saveAnswer = { success: true, branch: null, effective: { branch: "main", source: "default" } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/setup-api/update/versions")) {
          return jsonResponse({
            clawbox: { current: "v4.0.2", target: "v4.1.0", updateAvailable: true },
            openclaw: { current: "2026.7.1", target: "2026.7.1", updateAvailable: false },
            remote: { reachable: true },
          });
        }
        if (url.includes("/setup-api/system/update-branch")) {
          return jsonResponse(init?.method === "POST" ? saveAnswer : branchAnswer);
        }
        if (url.includes("/setup-api/update/status")) return jsonResponse({ phase: "idle", steps: [] });
        return jsonResponse({});
      }),
    );
  });

  async function openAdvanced(): Promise<void> {
    render(<SystemUpdateApp />);
    fireEvent.click(await screen.findByRole("button", { name: /Advanced options/ }));
  }

  it("says a box with nothing recorded follows main, the release channel", async () => {
    branchAnswer = { branch: null, effective: { branch: "main", source: "default" } };
    await openAdvanced();

    const line = await screen.findByTestId("update-effective-branch");
    expect(line.textContent).toBe("Updates follow main, the release channel. No branch is recorded on this box.");
    // The branch is its own chip, not a word lost in the sentence.
    expect(line.querySelector("code")?.textContent).toBe("main");
    // Nothing was written into the override field on the owner's behalf.
    expect((screen.getByLabelText("Branch override") as HTMLInputElement).value).toBe("");
  });

  it("says a checked-out branch is followed and that nothing is recorded", async () => {
    branchAnswer = { branch: null, effective: { branch: "main", source: "checkout-branch" } };
    await openAdvanced();

    expect((await screen.findByTestId("update-effective-branch")).textContent).toBe(
      "Updates follow main, the branch this box is checked out on. No branch is recorded.",
    );
  });

  it("names a recorded pin as recorded", async () => {
    branchAnswer = { branch: "beta", effective: { branch: "beta", source: "pin-file" } };
    await openAdvanced();

    expect((await screen.findByTestId("update-effective-branch")).textContent).toBe(
      "Updates follow beta, the branch recorded on this box.",
    );
  });

  it("tells a box the update would refuse to enter a branch first", async () => {
    branchAnswer = { branch: null, effective: { branch: "main", source: "unresolved" } };
    await openAdvanced();

    expect((await screen.findByTestId("update-effective-branch")).textContent).toMatch(
      /^Checking against main, the release channel\. .*enter a branch here before updating\.$/,
    );
  });

  it("updates the line when the pin is cleared", async () => {
    branchAnswer = { branch: "beta", effective: { branch: "beta", source: "pin-file" } };
    await openAdvanced();
    await screen.findByText(/the branch recorded on this box/);

    const input = screen.getByLabelText("Branch override");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByTestId("update-effective-branch").textContent).toBe(
        "Updates follow main, the release channel. No branch is recorded on this box.",
      ),
    );
  });

  it("shows no line at all for a server that predates the field", async () => {
    branchAnswer = { branch: "beta" };
    await openAdvanced();
    await screen.findByLabelText("Branch override");
    await waitFor(() => expect((screen.getByLabelText("Branch override") as HTMLInputElement).value).toBe("beta"));

    expect(screen.queryByTestId("update-effective-branch")).toBeNull();
  });
});
