import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn((file: string, args?: unknown, options?: unknown, callback?: unknown) => {
  const cb = [args, options, callback].find((value) => typeof value === "function") as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
  cb?.(null, "", "");
  return undefined;
}));

const mockPage = vi.hoisted(() => ({
  goto: vi.fn().mockResolvedValue(undefined),
  url: vi.fn().mockReturnValue("https://www.google.com"),
  title: vi.fn().mockResolvedValue("Google"),
  screenshot: vi.fn().mockResolvedValue(Buffer.from("PNG")),
  bringToFront: vi.fn().mockResolvedValue(undefined),
  mouse: {
    click: vi.fn().mockResolvedValue(undefined),
    dblclick: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockResolvedValue(undefined),
    wheel: vi.fn().mockResolvedValue(undefined),
  },
  keyboard: {
    type: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
  },
  waitForTimeout: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn().mockResolvedValue(false),
  goBack: vi.fn().mockResolvedValue(undefined),
  goForward: vi.fn().mockResolvedValue(undefined),
  reload: vi.fn().mockResolvedValue(undefined),
}));

const mockContext = vi.hoisted(() => ({
  pages: vi.fn(() => [mockPage]),
  newPage: vi.fn().mockResolvedValue(mockPage),
}));

const mockBrowser = vi.hoisted(() => ({
  contexts: vi.fn(() => [mockContext]),
  close: vi.fn().mockResolvedValue(undefined),
}));

const connectOverCDP = vi.hoisted(() => vi.fn().mockResolvedValue(mockBrowser));

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP,
  },
}));

function cdpVersionResponse() {
  return {
    ok: true,
    json: async () => ({ Browser: "Chromium 146" }),
  } as Response;
}

describe("/setup-api/browser", () => {
  let POST: (req: Request) => Promise<Response>;

  const setDesktopBrowserReady = (failuresBeforeReady = 0) => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes("/json/version")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      attempts += 1;
      if (attempts <= failuresBeforeReady) {
        throw new Error("CDP offline");
      }
      return cdpVersionResponse();
    }));
  };

  const importRoute = async () => {
    const mod = await import("@/app/setup-api/browser/route");
    POST = mod.POST;
  };

  const launchSession = async (extra: Record<string, unknown> = {}) => {
    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch", ...extra }),
    });
    const res = await POST(req);
    return { res, body: await res.json() };
  };

  const sendAction = async (action: string, sessionId: string, extra: Record<string, unknown> = {}) => {
    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action, sessionId, ...extra }),
    });
    const res = await POST(req);
    return { res, body: await res.json() };
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockPage.goto.mockResolvedValue(undefined);
    mockPage.url.mockReturnValue("https://www.google.com");
    mockPage.title.mockResolvedValue("Google");
    mockPage.screenshot.mockResolvedValue(Buffer.from("PNG"));
    mockPage.bringToFront.mockResolvedValue(undefined);
    mockPage.mouse.click.mockResolvedValue(undefined);
    mockPage.mouse.dblclick.mockResolvedValue(undefined);
    mockPage.mouse.move.mockResolvedValue(undefined);
    mockPage.mouse.wheel.mockResolvedValue(undefined);
    mockPage.keyboard.type.mockResolvedValue(undefined);
    mockPage.keyboard.press.mockResolvedValue(undefined);
    mockPage.waitForTimeout.mockResolvedValue(undefined);
    mockPage.evaluate.mockResolvedValue(false);
    mockPage.goBack.mockResolvedValue(undefined);
    mockPage.goForward.mockResolvedValue(undefined);
    mockPage.reload.mockResolvedValue(undefined);

    mockContext.pages.mockReturnValue([mockPage]);
    mockContext.newPage.mockResolvedValue(mockPage);
    mockBrowser.contexts.mockReturnValue([mockContext]);
    mockBrowser.close.mockResolvedValue(undefined);
    connectOverCDP.mockResolvedValue(mockBrowser);
    execFileMock.mockImplementation((file: string, args?: unknown, options?: unknown, callback?: unknown) => {
      const cb = [args, options, callback].find((value) => typeof value === "function") as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
      cb?.(null, "", "");
      return undefined;
    });

    setDesktopBrowserReady();
    await importRoute();
  });

  it("launches a browser session by attaching to desktop Chromium over CDP", async () => {
    const { body } = await launchSession();

    expect(connectOverCDP).toHaveBeenCalledWith("http://127.0.0.1:18800");
    expect(mockPage.bringToFront).toHaveBeenCalled();
    expect(body.sessionId).toBeDefined();
    expect(body.url).toBe("https://www.google.com");
  });

  it("starts the desktop browser service when CDP is not ready yet", async () => {
    setDesktopBrowserReady(2);

    const { body } = await launchSession();

    expect(body.sessionId).toBeDefined();
    expect(execFileMock).toHaveBeenCalledWith(
      "/usr/bin/sudo",
      ["/usr/bin/systemctl", "start", "clawbox-browser.service"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("navigates the real desktop browser when launch receives a url", async () => {
    const { body } = await launchSession({ url: "https://example.com" });

    expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", expect.any(Object));
    expect(body.sessionId).toBeDefined();
  });

  it("returns error for action without session", async () => {
    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "navigate", url: "https://example.com" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns error for unknown action with session", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("unknown-action", launchBody.sessionId);
    expect(res.status).toBe(400);
  });

  it("handles navigate action", async () => {
    const { body: launchBody } = await launchSession();

    const { body } = await sendAction("navigate", launchBody.sessionId, { url: "https://example.com" });
    expect(body.url).toBeDefined();
  });

  it("disconnects the automation session on close", async () => {
    const { body: launchBody } = await launchSession();

    const { body } = await sendAction("close", launchBody.sessionId);
    expect(body.ok).toBe(true);
    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it("handles click action", async () => {
    const { body: launchBody } = await launchSession();

    const { body } = await sendAction("click", launchBody.sessionId, { x: 100, y: 200 });
    expect(body.url).toBeDefined();
  });

  it("handles type action", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("type", launchBody.sessionId, { text: "hello" });
    expect(res.status).toBe(200);
  });

  it("handles screenshot action", async () => {
    const { body: launchBody } = await launchSession();

    const { body } = await sendAction("screenshot", launchBody.sessionId);
    expect(body.screenshot).toBeDefined();
  });

  it("handles hover action", async () => {
    const { body: launchBody } = await launchSession();

    const { body } = await sendAction("hover", launchBody.sessionId, { x: 10, y: 20 });
    expect(body.ok).toBe(true);
  });

  it("handles dblclick action", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("dblclick", launchBody.sessionId, { x: 100, y: 200 });
    expect(res.status).toBe(200);
  });

  it("handles scroll action", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("scroll", launchBody.sessionId, { x: 100, y: 200, deltaY: 300 });
    expect(res.status).toBe(200);
  });

  it("handles keydown action", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("keydown", launchBody.sessionId, { key: "Enter" });
    expect(res.status).toBe(200);
  });

  it("handles keydown with printable character", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("keydown", launchBody.sessionId, { key: "a" });
    expect(res.status).toBe(200);
  });

  it("handles back action", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("back", launchBody.sessionId);
    expect(res.status).toBe(200);
  });

  it("handles forward action", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("forward", launchBody.sessionId);
    expect(res.status).toBe(200);
  });

  it("handles refresh action", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("refresh", launchBody.sessionId);
    expect(res.status).toBe(200);
  });

  it("rejects navigate without url", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("navigate", launchBody.sessionId);
    expect(res.status).toBe(400);
  });

  it("rejects type without text", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("type", launchBody.sessionId);
    expect(res.status).toBe(400);
  });

  it("handles launch when screenshots fail", async () => {
    mockPage.screenshot.mockRejectedValue(new Error("screenshot failed"));
    mockPage.title.mockRejectedValue(new Error("no title"));

    const { body } = await launchSession();

    expect(body.sessionId).toBeDefined();
    expect(body.screenshot).toBeNull();
  });

  it("returns an error if desktop Chromium never becomes available", async () => {
    setDesktopBrowserReady(Number.POSITIVE_INFINITY);

    const { res } = await launchSession();
    expect(res.status).toBe(500);
  }, 15000);

  it("handles invalid JSON", async () => {
    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
