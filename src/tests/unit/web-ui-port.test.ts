import { describe, expect, it } from "vitest";
import { APPLIANCE_WEB_UI_PORT, webUiLoopbackUrl, webUiPort } from "@/lib/web-ui-port";

/**
 * TASK-2359: every tunnel forwarded to a hard-coded http://localhost:80. On the
 * Jetson appliance that is the web UI; on a PC/workstation installed with
 * install-x64.sh the UI serves on the installer's CLAWBOX_PORT (3005 by
 * default) and nothing listens on :80, so the public URL answered 502.
 *
 * The two layouts are the units' own environments: clawbox-setup.service runs
 * with PORT=80 on the appliance, and install-x64.sh writes PORT=$PORT into the
 * UI unit and CLAWBOX_PORT=$PORT into the gateway's.
 */
describe("webUiPort", () => {
  it("is 80 on the appliance, whose UI unit sets PORT=80", () => {
    expect(webUiPort({ PORT: "80" })).toBe(80);
    expect(webUiLoopbackUrl({ PORT: "80" })).toBe("http://localhost:80");
  });

  it("is the installer's port on a PC install, whose UI unit sets PORT=3005", () => {
    expect(webUiPort({ PORT: "3005" })).toBe(3005);
    expect(webUiLoopbackUrl({ PORT: "3005" })).toBe("http://localhost:3005");
  });

  it("follows whatever port the owner chose, not one default", () => {
    expect(webUiLoopbackUrl({ PORT: "8080" })).toBe("http://localhost:8080");
  });

  it("falls back to the installer's CLAWBOX_PORT when PORT is absent", () => {
    expect(webUiPort({ CLAWBOX_PORT: "3005" })).toBe(3005);
  });

  it("prefers PORT — what the server listens on — over CLAWBOX_PORT", () => {
    expect(webUiPort({ PORT: "3005", CLAWBOX_PORT: "4000" })).toBe(3005);
  });

  it.each(["", "abc", "0", "-1", "1.5", "70000"])("ignores PORT=%j that is not a port", (bad) => {
    expect(webUiPort({ PORT: bad, CLAWBOX_PORT: "3005" })).toBe(3005);
    expect(webUiPort({ PORT: bad })).toBe(APPLIANCE_WEB_UI_PORT);
  });

  it("is the appliance's 80 when nothing names a port", () => {
    expect(APPLIANCE_WEB_UI_PORT).toBe(80);
    expect(webUiPort({})).toBe(80);
    expect(webUiLoopbackUrl({})).toBe("http://localhost:80");
  });

  it("reads process.env by default", () => {
    const saved = { PORT: process.env.PORT, CLAWBOX_PORT: process.env.CLAWBOX_PORT };
    try {
      process.env.PORT = "3005";
      delete process.env.CLAWBOX_PORT;
      expect(webUiLoopbackUrl()).toBe("http://localhost:3005");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
