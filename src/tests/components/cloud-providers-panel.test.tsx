/**
 * Settings → AI providers and the setup wizard's AI step on a box whose AI is
 * the owner's own (TASK-2497): the local choice leads, the cloud cards fold
 * away under a closed "optional" disclosure, none of them marked Recommended,
 * and "Hide cloud AI providers" takes them off the screen. A box with no
 * local choice — or one that cannot answer — keeps the screen it had.
 * Rendered with a `t` that answers the KEY.
 */
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { CloudProvidersSettings, CloudProvidersWizardGate } from "@/components/CloudProvidersPanel";
import ClawboxAiProviderRow from "@/components/ClawboxAiProviderRow";
import type { CloudProvidersView } from "@/lib/cloud-providers";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => key }),
}));

const URL_ = "/setup-api/settings/cloud-providers";

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

const NORMAL: CloudProvidersView = {
  hidden: false,
  setting: "auto",
  autoHidden: false,
  orgMode: false,
  localOnly: false,
  externalEngine: null,
  localModel: null,
};
const ENGINE: CloudProvidersView = {
  ...NORMAL,
  externalEngine: { displayName: "echo-1", modelRef: "clawext/acme/echo-1" },
  localModel: "clawext/acme/echo-1",
};
const ORG_ENGINE: CloudProvidersView = { ...ENGINE, orgMode: true, hidden: true, autoHidden: true };

/** The cloud cards as Settings hands them over: here, the ClawBox AI row. */
function CloudCards() {
  return (
    <div data-testid="cloud-cards">
      <ClawboxAiProviderRow radioName="p" selected={false} onSelect={() => {}} />
    </div>
  );
}

function renderSettings(extra: { onOpenLocalAi?: () => void; openRequest?: number } = {}) {
  return render(
    <CloudProvidersSettings pitch={<div data-testid="clawai-pitch" />} {...extra}>
      <CloudCards />
    </CloudProvidersSettings>,
  );
}

describe("CloudProvidersSettings", () => {
  let view: CloudProvidersView | null;
  let getStatus: number;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    view = NORMAL;
    getStatus = 200;
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url !== URL_) return json(404, {});
      if ((init?.method ?? "GET") === "GET") return json(getStatus, view);
      const hide = JSON.parse(String(init?.body)).hide as boolean;
      view = { ...(view as CloudProvidersView), hidden: hide, setting: hide ? "on" : "off" };
      return json(200, view);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a normal box: the offer, the cloud cards with ClawBox AI recommended, and the switch off", async () => {
    renderSettings();
    expect(await screen.findByTestId("cloud-providers-hide-switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("clawai-pitch")).toBeInTheDocument();
    expect(screen.getByTestId("cloud-cards")).toBeInTheDocument();
    expect(screen.getByText("recommended")).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-providers-local-choice")).toBeNull();
    expect(screen.queryByTestId("cloud-providers-optional")).toBeNull();
  });

  it.each([
    ["refuses", 403, null],
    ["answers something else", 200, { nope: true }],
  ])("a box that %s keeps the screen it had, without the switch", async (_label, status, body) => {
    getStatus = status;
    view = body as CloudProvidersView | null;
    renderSettings();
    expect(await screen.findByTestId("cloud-cards")).toBeInTheDocument();
    expect(screen.getByTestId("clawai-pitch")).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-providers-hide")).toBeNull();
  });

  it("draws nothing cloud before the box has answered", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    renderSettings();
    expect(screen.queryByTestId("cloud-cards")).toBeNull();
    expect(screen.queryByTestId("clawai-pitch")).toBeNull();
  });

  it("an external engine leads, Recommended and Default; the cloud folds away, closed, none recommended", async () => {
    view = ENGINE;
    const onOpenLocalAi = vi.fn();
    renderSettings({ onOpenLocalAi });
    const card = await screen.findByTestId("cloud-providers-local-choice");
    expect(card).toHaveTextContent("echo-1");
    expect(card).toHaveTextContent("recommended");
    expect(card).toHaveTextContent("cloudProviders.default");
    expect(card).toHaveTextContent("cloudProviders.externalEngineHint");
    expect(screen.queryByTestId("clawai-pitch")).toBeNull();

    const toggle = screen.getByTestId("cloud-providers-optional-toggle");
    expect(toggle).toHaveTextContent("cloudProviders.optionalSection");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("cloud-cards")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("cloud-cards")).toBeInTheDocument();
    // The one "recommended" on the page is the engine's.
    expect(screen.getAllByText("recommended")).toHaveLength(1);
    expect(card).toContainElement(screen.getByText("recommended"));

    fireEvent.click(screen.getByTestId("cloud-providers-open-local-ai"));
    expect(onOpenLocalAi).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("cloud-providers-hide-switch")).toHaveAttribute("aria-checked", "false");
  });

  it("Local-only mode leads with the on-device model the same way", async () => {
    view = { ...NORMAL, localOnly: true, localModel: "llamacpp/gemma4-e2b-it" };
    renderSettings();
    const card = await screen.findByTestId("cloud-providers-local-choice");
    expect(card).toHaveTextContent("gemma4-e2b-it");
    expect(card).toHaveTextContent("cloudProviders.localModelHint");
    expect(screen.getByTestId("cloud-providers-optional-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("cloud-cards")).toBeNull();
  });

  it("a deep link to a cloud provider opens the fold", async () => {
    view = ENGINE;
    const { rerender } = renderSettings({ openRequest: 0 });
    await screen.findByTestId("cloud-providers-optional-toggle");
    expect(screen.queryByTestId("cloud-cards")).toBeNull();
    rerender(
      <CloudProvidersSettings pitch={<div data-testid="clawai-pitch" />} openRequest={1}>
        <CloudCards />
      </CloudProvidersSettings>,
    );
    expect(await screen.findByTestId("cloud-cards")).toBeInTheDocument();
  });

  it("a later visit to Providers is not the same deep link again, a new link still opens", async () => {
    view = ENGINE;
    // Settings (the parent) outlives the section and keeps what it acted on.
    function Page({ show, request }: { show: boolean; request: number }) {
      const [seen, setSeen] = useState(0);
      return show ? (
        <CloudProvidersSettings openRequest={request} openRequestSeen={seen} onOpenRequestSeen={setSeen}>
          <CloudCards />
        </CloudProvidersSettings>
      ) : <div data-testid="elsewhere" />;
    }
    const page = render(<Page show request={2} />);
    expect(await screen.findByTestId("cloud-cards")).toBeInTheDocument();

    // Away to another section and back, the counter untouched.
    page.rerender(<Page show={false} request={2} />);
    expect(screen.getByTestId("elsewhere")).toBeInTheDocument();
    page.rerender(<Page show request={2} />);
    expect(await screen.findByTestId("cloud-providers-optional-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("cloud-cards")).toBeNull();

    // A new link still opens it.
    page.rerender(<Page show request={3} />);
    expect(await screen.findByTestId("cloud-cards")).toBeInTheDocument();
  });

  it("hidden (an organisation box running an engine): no cloud card at all, the switch on and saying why", async () => {
    view = ORG_ENGINE;
    renderSettings();
    expect(await screen.findByTestId("cloud-providers-hidden-note")).toBeInTheDocument();
    expect(screen.getByTestId("cloud-providers-local-choice")).toHaveTextContent("echo-1");
    expect(screen.queryByTestId("cloud-providers-optional")).toBeNull();
    expect(screen.queryByTestId("cloud-cards")).toBeNull();
    expect(screen.queryByTestId("clawai-pitch")).toBeNull();
    expect(screen.getByTestId("cloud-providers-hide-switch")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("cloud-providers-auto")).toHaveTextContent("cloudProviders.autoOn");
  });

  it("the owner turns it off on that box and the cloud comes back folded", async () => {
    view = ORG_ENGINE;
    const signal = vi.fn();
    window.addEventListener("clawbox:providers-changed", signal);
    renderSettings();
    fireEvent.click(await screen.findByTestId("cloud-providers-hide-switch"));
    await waitFor(() => expect(screen.getByTestId("cloud-providers-hide-switch")).toHaveAttribute("aria-checked", "false"));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ hide: false });
    expect(screen.getByTestId("cloud-providers-optional-toggle")).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-providers-auto")).toBeNull();
    expect(signal).toHaveBeenCalled();
    window.removeEventListener("clawbox:providers-changed", signal);
  });

  it("hidden by hand on a box with no local AI says to set one up", async () => {
    view = NORMAL;
    renderSettings();
    fireEvent.click(await screen.findByTestId("cloud-providers-hide-switch"));
    await waitFor(() => expect(screen.getByTestId("cloud-providers-hidden-note")).toBeInTheDocument());
    expect(screen.queryByTestId("cloud-cards")).toBeNull();
    expect(screen.getByTestId("cloud-providers-local-choice")).toHaveTextContent("cloudProviders.noLocalAi");
    expect(screen.getByTestId("cloud-providers-local-choice")).not.toHaveTextContent("recommended");
  });

  it("another user on a home box sees the page as the owner set it, without the switch", async () => {
    view = { ...ORG_ENGINE, canChange: false };
    renderSettings();
    expect(await screen.findByTestId("cloud-providers-hidden-note")).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-cards")).toBeNull();
    expect(screen.queryByTestId("cloud-providers-hide")).toBeNull();
  });

  it("opens the fold at once when Settings mounts it with a deep link already raised", async () => {
    view = ENGINE;
    renderSettings({ openRequest: 2 });
    expect(await screen.findByTestId("cloud-cards")).toBeInTheDocument();
    expect(screen.getByTestId("cloud-providers-optional-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  it("a refused save leaves the switch where it was and says so", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return json(200, NORMAL);
      return json(500, { error: "The setting could not be saved." });
    });
    renderSettings();
    fireEvent.click(await screen.findByTestId("cloud-providers-hide-switch"));
    expect(await screen.findByTestId("cloud-providers-failed")).toHaveTextContent("cloudProviders.failed");
    expect(screen.getByTestId("cloud-providers-hide-switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("cloud-cards")).toBeInTheDocument();
  });
});

describe("CloudProvidersWizardGate", () => {
  let view: CloudProvidersView | null;
  let selectStatus: number;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    view = NORMAL;
    selectStatus = 200;
    fetchMock = vi.fn((url: string) => {
      if (url === URL_) return view ? json(200, view) : json(403, { code: "owner_only" });
      if (url === "/setup-api/local-ai/external/select") return json(selectStatus, selectStatus === 200 ? { ok: true } : { error: "Hermes needs a 64k window." });
      return json(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderGate = (onNext = vi.fn()) => {
    render(
      <CloudProvidersWizardGate onNext={onNext}>
        <CloudCards />
      </CloudProvidersWizardGate>,
    );
    return onNext;
  };

  it("a normal box gets the step as it was, ClawBox AI recommended", async () => {
    renderGate();
    expect(await screen.findByTestId("cloud-cards")).toBeInTheDocument();
    expect(screen.getByText("recommended")).toBeInTheDocument();
  });

  it("no answer (setup before the owner signed in) is the step as it was", async () => {
    view = null;
    renderGate();
    expect(await screen.findByTestId("cloud-cards")).toBeInTheDocument();
  });

  it("an engine without hiding: the step stays, no cloud row recommended", async () => {
    view = ENGINE;
    renderGate();
    expect(await screen.findByTestId("cloud-cards")).toBeInTheDocument();
    expect(screen.queryByText("recommended")).toBeNull();
  });

  it("hidden: the box's own AI and a Continue that makes the engine the chat's model", async () => {
    view = ORG_ENGINE;
    const onNext = renderGate();
    expect(await screen.findByTestId("cloud-providers-wizard-local")).toHaveTextContent("echo-1");
    expect(screen.queryByTestId("cloud-cards")).toBeNull();
    fireEvent.click(screen.getByTestId("cloud-providers-wizard-continue"));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/local-ai/external/select", { method: "POST" });
  });

  it("hidden, and the engine refused: says why and stays", async () => {
    view = ORG_ENGINE;
    selectStatus = 409;
    const onNext = renderGate();
    fireEvent.click(await screen.findByTestId("cloud-providers-wizard-continue"));
    expect(await screen.findByTestId("cloud-providers-wizard-error")).toHaveTextContent("Hermes needs a 64k window.");
    expect(onNext).not.toHaveBeenCalled();
  });

  it("hidden with no engine: Continue goes on without asking the box", async () => {
    view = { ...NORMAL, hidden: true, setting: "on" };
    const onNext = renderGate();
    fireEvent.click(await screen.findByTestId("cloud-providers-wizard-continue"));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith("/setup-api/local-ai/external/select", expect.anything());
  });
});
