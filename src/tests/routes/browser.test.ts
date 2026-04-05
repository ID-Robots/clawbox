import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock playwright before importing the route
vi.mock("playwright", () => {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue("https://www.google.com"),
    title: vi.fn().mockResolvedValue("Google"),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("PNG")),
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
  };
  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
  };
  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    chromium: {
      launch: vi.fn().mockResolvedValue(mockBrowser),
    },
  };
});

describe("/setup-api/browser", () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    // Re-mock playwright after reset
    const pw = await import("playwright");
    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://www.google.com"),
      title: vi.fn().mockResolvedValue("Google"),
      screenshot: vi.fn().mockResolvedValue(Buffer.from("PNG")),
      mouse: { click: vi.fn().mockResolvedValue(undefined), dblclick: vi.fn().mockResolvedValue(undefined), move: vi.fn().mockResolvedValue(undefined), wheel: vi.fn().mockResolvedValue(undefined) },
      keyboard: { type: vi.fn().mockResolvedValue(undefined), press: vi.fn().mockResolvedValue(undefined) },
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(false),
      goBack: vi.fn().mockResolvedValue(undefined), goForward: vi.fn().mockResolvedValue(undefined), reload: vi.fn().mockResolvedValue(undefined),
    };
    const mockContext = { newPage: vi.fn().mockResolvedValue(mockPage) };
    const mockBrowser = { newContext: vi.fn().mockResolvedValue(mockContext), close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(pw.chromium.launch).mockResolvedValue(mockBrowser as never);
    const mod = await import("@/app/setup-api/browser/route");
    POST = mod.POST;
  });

  it("launches a browser session", async () => {
    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.sessionId).toBeDefined();
    expect(body.url).toBe("https://www.google.com");
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
    // First launch
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "unknown-action", sessionId }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("handles navigate action", async () => {
    // Launch first
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "navigate", sessionId, url: "https://example.com" }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.url).toBeDefined();
  });

  it("handles close action", async () => {
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "close", sessionId }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("handles click action", async () => {
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "click", sessionId, x: 100, y: 200 }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.url).toBeDefined();
  });

  it("handles type action", async () => {
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "type", sessionId, text: "hello" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("handles screenshot action", async () => {
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "screenshot", sessionId }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.screenshot).toBeDefined();
  });

  it("handles hover action", async () => {
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "hover", sessionId, x: 10, y: 20 }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("handles dblclick action", async () => {
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "dblclick", sessionId, x: 100, y: 200 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("handles scroll action", async () => {
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "scroll", sessionId, x: 100, y: 200, deltaY: 300 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("handles keydown action", async () => {
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "keydown", sessionId, key: "Enter" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("handles keydown with printable character", async () => {
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "keydown", sessionId, key: "a" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("handles back action", async () => {
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "back", sessionId }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("handles forward action", async () => {
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "forward", sessionId }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("handles refresh action", async () => {
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "refresh", sessionId }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("rejects navigate without url", async () => {
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "navigate", sessionId }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects type without text", async () => {
    const launchReq = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const launchRes = await POST(launchReq);
    const { sessionId } = await launchRes.json();

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "type", sessionId }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("handles launch with screenshot failure", async () => {
    // Override mock to make screenshot throw
    const pw = await import("playwright");
    const failPage = {
      goto: vi.fn().mockRejectedValue(new Error("nav error")),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockRejectedValue(new Error("no title")),
      screenshot: vi.fn().mockRejectedValue(new Error("screenshot failed")),
      mouse: { click: vi.fn(), dblclick: vi.fn(), move: vi.fn(), wheel: vi.fn() },
      keyboard: { type: vi.fn(), press: vi.fn() },
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockRejectedValue(new Error("eval failed")),
      goBack: vi.fn().mockRejectedValue(new Error("err")),
      goForward: vi.fn().mockRejectedValue(new Error("err")),
      reload: vi.fn().mockRejectedValue(new Error("err")),
    };
    const failContext = { newPage: vi.fn().mockResolvedValue(failPage) };
    const failBrowser = { newContext: vi.fn().mockResolvedValue(failContext), close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(pw.chromium.launch).mockResolvedValue(failBrowser as never);

    // Need fresh import to get new module state
    vi.resetModules();
    const mod = await import("@/app/setup-api/browser/route");
    const freshPOST = mod.POST;

    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch" }),
    });
    const res = await freshPOST(req);
    const body = await res.json();
    expect(body.sessionId).toBeDefined();
    expect(body.screenshot).toBeNull();
  });

  it("handles invalid JSON", async () => {
    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
