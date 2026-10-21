import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, string | number>) => (params ? `${key}${JSON.stringify(params)}` : key),
  }),
}));

import PhonePairPage from "@/components/PhonePairPage";

/**
 * /phone-pair, the page a phone opens from the owner's QR invite: it asks,
 * waits for the owner, and shows the phone's own setup code only once the
 * owner approved it.
 */

const INVITE = "I".repeat(22);
const CLAIM = "C".repeat(32);

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

let statusAnswer: { status: number; body: unknown };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", `/phone-pair#${INVITE}`);
  statusAnswer = { status: 200, body: { state: "waiting", expiresAtMs: Date.now() + 600_000 } };
  fetchMock = vi.fn((url: string) => {
    if (url === "/setup-api/nodes/request") return json(200, { claim: CLAIM, expiresAtMs: Date.now() + 600_000 });
    if (url === "/setup-api/nodes/request/status") return json(statusAnswer.status, statusAnswer.body);
    return json(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the phone's pairing page", () => {
  it("refuses a link without a valid invite", async () => {
    window.history.replaceState(null, "", "/phone-pair#nope");
    render(<PhonePairPage />);
    expect(await screen.findByTestId("phone-pair-invalid")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks with the phone's name, waits, and shows its own code once the owner approved", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PhonePairPage />);
    fireEvent.change(await screen.findByTestId("phone-pair-name"), { target: { value: "Pixel 9" } });
    fireEvent.click(screen.getByTestId("phone-pair-ask"));

    expect(await screen.findByTestId("phone-pair-waiting")).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls.find(([u]) => u === "/setup-api/nodes/request")!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ invite: INVITE, name: "Pixel 9" });
    expect(window.sessionStorage.getItem(`clawbox-phone-claim:${INVITE}`)).toBe(CLAIM);

    statusAnswer = { status: 200, body: { state: "approved", setupCode: "c2V0dXAtY29kZQ", expiresAtMs: Date.now() + 600_000 } };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(await screen.findByTestId("phone-pair-code")).toHaveValue("c2V0dXAtY29kZQ");
    const [, statusInit] = fetchMock.mock.calls.find(([u]) => u === "/setup-api/nodes/request/status")!;
    expect(JSON.parse(String((statusInit as RequestInit).body))).toEqual({ invite: INVITE, claim: CLAIM });
  });

  it("keeps waiting across a reload with the claim it already holds", async () => {
    window.sessionStorage.setItem(`clawbox-phone-claim:${INVITE}`, CLAIM);
    render(<PhonePairPage />);
    expect(await screen.findByTestId("phone-pair-waiting")).toBeInTheDocument();
    expect(screen.queryByTestId("phone-pair-name")).toBeNull();
  });

  it("says so when the owner turned the phone down", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.sessionStorage.setItem(`clawbox-phone-claim:${INVITE}`, CLAIM);
    statusAnswer = { status: 200, body: { state: "rejected" } };
    render(<PhonePairPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(await screen.findByTestId("phone-pair-rejected")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(`clawbox-phone-claim:${INVITE}`)).toBeNull();
  });

  it("keeps waiting through a rate limit instead of stalling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.sessionStorage.setItem(`clawbox-phone-claim:${INVITE}`, CLAIM);
    statusAnswer = { status: 429, body: { code: "rate_limited" } };
    render(<PhonePairPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByTestId("phone-pair-waiting")).toBeInTheDocument();

    statusAnswer = { status: 200, body: { state: "approved", setupCode: "c2V0dXAtY29kZQ", expiresAtMs: Date.now() + 600_000 } };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(await screen.findByTestId("phone-pair-code")).toHaveValue("c2V0dXAtY29kZQ");
  });

  it("counts the code down and takes it away once it has expired", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.sessionStorage.setItem(`clawbox-phone-claim:${INVITE}`, CLAIM);
    statusAnswer = { status: 200, body: { state: "approved", setupCode: "c2V0dXAtY29kZQ", expiresAtMs: Date.now() + 2.5 * 60_000 + 3_000 } };
    render(<PhonePairPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(await screen.findByTestId("phone-pair-code")).toBeInTheDocument();
    expect(screen.getByText('phonePair.codeExpires{"minutes":3}')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText('phonePair.codeExpires{"minutes":2}')).toBeInTheDocument();

    // The box, asked again while the code is shown, says it has expired.
    statusAnswer = { status: 200, body: { state: "expired" } };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(screen.getByTestId("phone-pair-expired")).toBeInTheDocument();
    expect(screen.queryByTestId("phone-pair-code")).toBeNull();
    expect(window.sessionStorage.getItem(`clawbox-phone-claim:${INVITE}`)).toBeNull();
  });

  it("keeps a code the box still holds valid, whatever this phone's clock says, and through a failed check", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.sessionStorage.setItem(`clawbox-phone-claim:${INVITE}`, CLAIM);
    // By this phone's clock the code expired a minute ago: its clock runs ahead of the box's.
    statusAnswer = { status: 200, body: { state: "approved", setupCode: "c2V0dXAtY29kZQ", expiresAtMs: Date.now() - 60_000 } };
    render(<PhonePairPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.getByTestId("phone-pair-code")).toHaveValue("c2V0dXAtY29kZQ");

    statusAnswer = { status: 503, body: {} };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(screen.getByTestId("phone-pair-code")).toHaveValue("c2V0dXAtY29kZQ");
    expect(window.sessionStorage.getItem(`clawbox-phone-claim:${INVITE}`)).toBe(CLAIM);
  });

  it("says when another phone already used the link", async () => {
    fetchMock.mockImplementation((url: string) =>
      url === "/setup-api/nodes/request" ? json(409, { code: "used", error: "used" }) : json(404, {}),
    );
    render(<PhonePairPage />);
    fireEvent.click(await screen.findByTestId("phone-pair-ask"));
    expect(await screen.findByTestId("phone-pair-used")).toBeInTheDocument();
  });

  it("says when phone pairing is switched off on the box", async () => {
    fetchMock.mockImplementation((url: string) =>
      url === "/setup-api/nodes/request" ? json(404, { code: "unavailable", error: "off" }) : json(404, {}),
    );
    render(<PhonePairPage />);
    fireEvent.click(await screen.findByTestId("phone-pair-ask"));
    expect(await screen.findByTestId("phone-pair-unavailable")).toBeInTheDocument();
  });

  it("keeps waiting through a check the box does not answer, and says so only after several in a row", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.sessionStorage.setItem(`clawbox-phone-claim:${INVITE}`, CLAIM);
    statusAnswer = { status: 500, body: { code: "store_write_failed" } };
    render(<PhonePairPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByTestId("phone-pair-waiting")).toBeInTheDocument();

    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("network down")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByTestId("phone-pair-waiting")).toBeInTheDocument();

    statusAnswer = { status: 200, body: { state: "approved", setupCode: "c2V0dXAtY29kZQ", expiresAtMs: Date.now() + 600_000 } };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(await screen.findByTestId("phone-pair-code")).toHaveValue("c2V0dXAtY29kZQ");
  });

  it("says the box is not answering once several checks in a row went unanswered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.sessionStorage.setItem(`clawbox-phone-claim:${INVITE}`, CLAIM);
    statusAnswer = { status: 503, body: {} };
    render(<PhonePairPage />);
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(screen.getByTestId("phone-pair-waiting")).toBeInTheDocument();
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByTestId("phone-pair-error")).toBeInTheDocument();
  });

  it("gives the form back with the name kept when an ask gets no usable answer", async () => {
    let asks = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url !== "/setup-api/nodes/request") return json(404, {});
      asks += 1;
      return asks === 1 ? json(429, { code: "rate_limited", error: "Too many attempts." }) : json(200, { claim: CLAIM, expiresAtMs: Date.now() + 600_000 });
    });
    render(<PhonePairPage />);
    fireEvent.change(await screen.findByTestId("phone-pair-name"), { target: { value: "Ada's phone" } });
    fireEvent.click(screen.getByTestId("phone-pair-ask"));
    expect(await screen.findByTestId("phone-pair-error")).toBeInTheDocument();
    expect(screen.getByTestId("phone-pair-name")).toHaveValue("Ada's phone");

    fireEvent.click(screen.getByTestId("phone-pair-ask"));
    expect(await screen.findByTestId("phone-pair-waiting")).toBeInTheDocument();
    expect(asks).toBe(2);
  });
});
