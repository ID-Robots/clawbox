// Remote Access is two facts, not one: the tunnel's state right now, and the
// same intent recorded for the next boot. `systemctl stop` and
// `systemctl disable` are separate calls (config/clawbox-sudoers grants no
// `--now` variant for this unit), so they fail independently — and the failure
// that matters is the second one, where the owner switches Remote Access OFF,
// is told it worked, and the box starts publishing a public
// *.trycloudflare.com address again at the next power cycle.
//
// The route now carries that verdict in its 200. This is the panel showing it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import RemoteControlPanel from "@/components/RemoteControlPanel";

const STRINGS: Record<string, string> = {
  "remoteControl.stop": "Turn off",
  "remoteControl.stopping": "Turning off...",
};

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => STRINGS[key] ?? key }),
}));

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

const STOP_WARNING =
  "Remote access is stopped, but this ClawBox could not be told to keep it off "
  + "— it will start serving a public address again after the next reboot.";

const RUNNING_STATUS = {
  tunnel: {
    installed: true,
    service: "active",
    url: "https://abc.trycloudflare.com",
    history: [],
  },
  portalAddDeviceUrl: "https://clawbox.com/addDevice",
  portalWeb: "https://clawbox.com",
};

let stopBody: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;

function stopWasPosted() {
  return fetchMock.mock.calls.some(
    ([input, init]) =>
      String(input) === "/setup-api/portal/stop"
      && (init as RequestInit | undefined)?.method === "POST",
  );
}

beforeEach(() => {
  stopBody = { success: true, bootPersisted: false, warning: STOP_WARNING };
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/setup-api/portal/stop" && init?.method === "POST") {
      return { ok: true, json: async () => stopBody } as Response;
    }
    return { ok: true, json: async () => RUNNING_STATUS } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountPanel() {
  render(<RemoteControlPanel />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Turn off" })).toBeInTheDocument(),
  );
}

describe("RemoteControlPanel — the boot-persist verdict", () => {
  it("tells the owner when an OFF will undo itself at the next reboot", async () => {
    await mountPanel();
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(screen.getByText(STOP_WARNING)).toBeInTheDocument());
  });

  it("says nothing extra when the OFF was recorded properly", async () => {
    stopBody = { success: true, bootPersisted: true };
    await mountPanel();
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(stopWasPosted()).toBe(true));
    expect(screen.queryByText(STOP_WARNING)).toBeNull();
  });
});
