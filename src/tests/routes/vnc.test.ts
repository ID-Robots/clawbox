import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ stdout: "", stderr: "" })),
}));

function makeSocketMock(connectEvent: "connect" | "error") {
  return {
    default: {
      Socket: vi.fn(function (this: Record<string, unknown>) {
        let cb: (() => void) | null = null;
        this.setTimeout = vi.fn();
        this.destroy = vi.fn();
        this.on = vi.fn((event: string, handler: () => void) => {
          if (event === connectEvent) cb = handler;
          return this;
        });
        this.connect = vi.fn(() => {
          if (cb) cb();
          return this;
        });
      }),
    },
  };
}

describe("/setup-api/vnc", () => {
  it("returns available when both VNC and WS ports are open", async () => {
    vi.resetModules();
    vi.doMock("net", () => makeSocketMock("connect"));
    const mod = await import("@/app/setup-api/vnc/route");
    const res = await mod.GET();
    const body = await res.json();
    expect(body.available).toBe(true);
  });

  it("returns not available when VNC port is closed", async () => {
    vi.resetModules();
    vi.doMock("net", () => makeSocketMock("error"));
    const mod = await import("@/app/setup-api/vnc/route");
    const res = await mod.GET();
    const body = await res.json();
    expect(body.available).toBe(false);
  });
});
