import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import VncResolutionSetting from "@/components/VncResolutionSetting";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => key }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

/**
 * Agent Browser -> Settings -> remote desktop resolution (beside Open in VNC;
 * it used to sit in Settings -> Appearance). The control must show what is
 * actually stored: a slow mount-time read cannot overwrite a newer pick, and a
 * failed apply reconciles with the server instead of assuming a rollback.
 */

type Reply = { ok: boolean; status?: number; body: unknown };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function reply({ ok, status, body }: Reply) {
  return { ok, status: status ?? (ok ? 200 : 500), json: async () => body };
}

function select(): HTMLSelectElement {
  return screen.getByRole("combobox") as HTMLSelectElement;
}

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("VncResolutionSetting", () => {
  it("does not let the mount-time read overwrite a selection submitted after it", async () => {
    const initialGet = deferred<ReturnType<typeof reply>>();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return reply({ ok: true, body: { resolution: "1920x1080", restarted: true } });
      return initialGet.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<VncResolutionSetting />);
    fireEvent.change(select(), { target: { value: "1920x1080" } });
    await waitFor(() => expect(screen.getByText("settings.vncResolutionHint")).toBeTruthy());
    expect(select().value).toBe("1920x1080");

    // The stale read lands last, carrying the old value.
    await act(async () => {
      initialGet.resolve(reply({ ok: true, body: { resolution: "1280x720" } }));
      await initialGet.promise;
    });
    expect(select().value).toBe("1920x1080");
  });

  it("shows the stored value after a failed apply instead of assuming a rollback", async () => {
    let stored = "1280x720";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        // Saved, but the restart failed.
        stored = JSON.parse(String(init.body)).resolution;
        return reply({ ok: false, status: 500, body: { resolution: stored, restartFailed: true } });
      }
      return reply({ ok: true, body: { resolution: stored } });
    }));

    render(<VncResolutionSetting />);
    await waitFor(() => expect(select().value).toBe("1280x720"));
    fireEvent.change(select(), { target: { value: "1600x900" } });
    await waitFor(() => expect(screen.getByText("settings.vncResolutionError")).toBeTruthy());
    expect(select().value).toBe("1600x900");
  });

  it("goes back to the stored value when the save itself failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return reply({ ok: false, status: 500, body: { error: "nope" } });
      return reply({ ok: true, body: { resolution: "1600x900" } });
    }));

    render(<VncResolutionSetting />);
    await waitFor(() => expect(select().value).toBe("1600x900"));
    fireEvent.change(select(), { target: { value: "1920x1080" } });
    await waitFor(() => expect(screen.getByText("settings.vncResolutionError")).toBeTruthy());
    expect(select().value).toBe("1600x900");
  });
});
