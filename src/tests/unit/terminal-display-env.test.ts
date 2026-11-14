/**
 * The display a Terminal shell is given (scripts/terminal-display-env.mjs).
 *
 * terminal-server.mjs is started by the web server at boot, and the web server
 * has no DISPLAY: a shell spawned from the Terminal app inherited none, so
 * `xdg-open` in the Terminal exited 3 while the owner's Remote Desktop was up
 * and holding their screen on Xvfb (issue #1518). The fix is this module, and
 * the rules pinned here are the ones that make it safe to hand an environment
 * to a child process:
 *
 *   1. our own DISPLAY wins — a real desktop session knows better than a file;
 *   2. otherwise the display scripts/start-vnc.sh recorded, if it looks like
 *      one;
 *   3. otherwise nothing at all: no empty DISPLAY, no guessed ":99";
 *   4. nothing outside CLAWBOX_VNC_DISPLAY / CLAWBOX_VNC_XAUTHORITY is read;
 *   5. the recorded authority is used only with the recorded display;
 *   6. a relative WAYLAND_DISPLAY keeps the XDG_RUNTIME_DIR that finds it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  readVncState,
  terminalDisplayEnv,
  vncStatePath,
} from "../../../scripts/terminal-display-env.mjs";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-display-env-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a state file and return its path. */
function stateFile(contents: string): string {
  const file = path.join(tmp, "vnc-display.env");
  fs.writeFileSync(file, contents);
  return file;
}

describe("vncStatePath", () => {
  it("is the file scripts/start-vnc.sh writes", () => {
    expect(vncStatePath("/home/clawbox")).toBe("/home/clawbox/.cache/clawbox/vnc-display.env");
  });
});

describe("readVncState", () => {
  it("reads the two keys this module knows", () => {
    const file = stateFile(
      ["CLAWBOX_VNC_DISPLAY=:99", "CLAWBOX_VNC_XAUTHORITY=/home/clawbox/.Xauthority"].join("\n"),
    );
    expect(readVncState(file)).toEqual({
      CLAWBOX_VNC_DISPLAY: ":99",
      CLAWBOX_VNC_XAUTHORITY: "/home/clawbox/.Xauthority",
    });
  });

  it("ignores every other line, including prefix lookalikes", () => {
    const file = stateFile(
      [
        "CLAWBOX_VNC_GEOMETRY=1280x720",
        "CLAWBOX_VNC_DISPLAY_EXTRA=:99",
        "DISPLAY=:99",
        "not a key value line",
        "=:99",
        "CLAWBOX_VNC_DISPLAY=:1",
      ].join("\n"),
    );
    expect(readVncState(file)).toEqual({ CLAWBOX_VNC_DISPLAY: ":1" });
  });

  it("strips one layer of shell quoting, because start-vnc.sh writes quotes", () => {
    const file = stateFile('CLAWBOX_VNC_DISPLAY=":2"');
    expect(readVncState(file)).toEqual({ CLAWBOX_VNC_DISPLAY: ":2" });
  });

  it("is empty for a missing or unreadable file, so the Terminal behaves as before", () => {
    expect(readVncState(path.join(tmp, "absent.env"))).toEqual({});
    expect(readVncState(tmp)).toEqual({});
  });
});

describe("terminalDisplayEnv", () => {
  it("takes the display start-vnc.sh recorded", () => {
    const env = terminalDisplayEnv({
      env: { HOME: "/home/clawbox" },
      stateFile: stateFile("CLAWBOX_VNC_DISPLAY=:99\n"),
    });
    expect(env).toEqual({ DISPLAY: ":99" });
  });

  it("prefers our own DISPLAY over the recorded one", () => {
    const env = terminalDisplayEnv({
      env: { HOME: "/home/clawbox", DISPLAY: ":0" },
      stateFile: stateFile("CLAWBOX_VNC_DISPLAY=:99\n"),
    });
    expect(env.DISPLAY).toBe(":0");
  });

  it("adds no DISPLAY at all when neither exists — never a guessed :99", () => {
    const env = terminalDisplayEnv({
      env: { HOME: "/nonexistent" },
      stateFile: path.join(tmp, "absent.env"),
    });
    expect(env).toEqual({});
    expect("DISPLAY" in env).toBe(false);
  });

  it("refuses a recorded value that is not a display", () => {
    for (const junk of ["rm -rf /", "*", ":99; reboot", "$(id)", ""]) {
      const env = terminalDisplayEnv({
        env: { HOME: "/nonexistent" },
        stateFile: stateFile(`CLAWBOX_VNC_DISPLAY=${junk}\n`),
      });
      expect(env.DISPLAY, junk).toBeUndefined();
    }
  });

  it("accepts the display shapes an X client accepts", () => {
    for (const good of [":0", ":99", ":0.0", "localhost:10.0", "vnc-box:1"]) {
      const env = terminalDisplayEnv({
        env: { HOME: "/nonexistent" },
        stateFile: stateFile(`CLAWBOX_VNC_DISPLAY=${good}\n`),
      });
      expect(env.DISPLAY, good).toBe(good);
    }
  });

  it("passes an inherited XAUTHORITY through", () => {
    expect(
      terminalDisplayEnv({ env: { HOME: "/nonexistent", XAUTHORITY: "/tmp/xauth" } }).XAUTHORITY,
    ).toBe("/tmp/xauth");
  });

  it("takes the recorded authority with the recorded display", () => {
    const env = terminalDisplayEnv({
      env: { HOME: "/nonexistent" },
      stateFile: stateFile(
        "CLAWBOX_VNC_DISPLAY=:99\nCLAWBOX_VNC_XAUTHORITY=/home/clawbox/.Xauthority\n",
      ),
    });
    expect(env).toEqual({ DISPLAY: ":99", XAUTHORITY: "/home/clawbox/.Xauthority" });
  });

  it("never gives the recorded authority to an inherited display", () => {
    const env = terminalDisplayEnv({
      env: { HOME: "/nonexistent", DISPLAY: ":0" },
      stateFile: stateFile(
        "CLAWBOX_VNC_DISPLAY=:99\nCLAWBOX_VNC_XAUTHORITY=/home/clawbox/.Xauthority\n",
      ),
    });
    expect(env).toEqual({ DISPLAY: ":0" });
    expect("XAUTHORITY" in env).toBe(false);
  });

  it("keeps an inherited authority on an inherited display", () => {
    const env = terminalDisplayEnv({
      env: { HOME: "/nonexistent", DISPLAY: ":0", XAUTHORITY: "/run/user/1000/xauth" },
      stateFile: stateFile("CLAWBOX_VNC_XAUTHORITY=/home/clawbox/.Xauthority\n"),
    });
    expect(env).toEqual({ DISPLAY: ":0", XAUTHORITY: "/run/user/1000/xauth" });
  });

  it("carries XDG_RUNTIME_DIR when WAYLAND_DISPLAY is a relative socket name", () => {
    const env = terminalDisplayEnv({
      env: {
        HOME: "/nonexistent",
        WAYLAND_DISPLAY: "wayland-0",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      stateFile: path.join(tmp, "absent.env"),
    });
    expect(env).toEqual({
      WAYLAND_DISPLAY: "wayland-0",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
  });

  it("adds no XDG_RUNTIME_DIR when WAYLAND_DISPLAY already names the socket", () => {
    const env = terminalDisplayEnv({
      env: {
        HOME: "/nonexistent",
        WAYLAND_DISPLAY: "/run/user/1000/wayland-0",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      stateFile: path.join(tmp, "absent.env"),
    });
    expect(env).toEqual({ WAYLAND_DISPLAY: "/run/user/1000/wayland-0" });
  });

  it("exports no XDG_RUNTIME_DIR of its own when the process has none", () => {
    const env = terminalDisplayEnv({
      env: { HOME: "/nonexistent", WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "  " },
      stateFile: path.join(tmp, "absent.env"),
    });
    expect(env).toEqual({ WAYLAND_DISPLAY: "wayland-0" });
  });

  it("carries WAYLAND_DISPLAY through when the process has one", () => {
    const env = terminalDisplayEnv({
      env: { HOME: "/nonexistent", WAYLAND_DISPLAY: "wayland-0" },
      stateFile: path.join(tmp, "absent.env"),
    });
    expect(env).toEqual({ WAYLAND_DISPLAY: "wayland-0" });
  });

  it("treats blank values as absent, so no empty variable is exported", () => {
    const env = terminalDisplayEnv({
      env: { HOME: "/nonexistent", DISPLAY: "   ", WAYLAND_DISPLAY: "" },
      stateFile: stateFile("CLAWBOX_VNC_DISPLAY=\nCLAWBOX_VNC_XAUTHORITY=\n"),
    });
    expect(env).toEqual({});
  });
});
