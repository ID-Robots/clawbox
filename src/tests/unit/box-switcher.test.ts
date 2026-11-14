import { describe, expect, it } from "vitest";
import {
  CARRY_PREFIX,
  MAX_WORKSPACES,
  boxSwitchSlot,
  decodeCarried,
  effectiveWorkspaces,
  encodeCarried,
  ownWorkspaces,
  planSwitch,
  readCarriedHash,
  type CarriedSet,
} from "@/lib/box-switcher";
import {
  MAX_LINKED_BOXES,
  boxOrigin,
  normalizeBoxName,
  normalizeBoxUrl,
  parseLinkedBoxesRead,
  parseLinkedBoxesWrite,
} from "@/lib/linked-boxes-shape";

/**
 * Linked ClawBoxes (TASK-2519): the list's rules (linked-boxes-shape.ts) and
 * the switcher's decisions (box-switcher.ts) — which key is which slot, what
 * a slot is on this box, and what a numbering carried from another box may
 * and may not make a key press do.
 */

const key = (code: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; isComposing: boolean }> = {}) => ({
  code,
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("normalizeBoxUrl", () => {
  it("keeps an http(s) desktop as its origin and the root page", () => {
    expect(normalizeBoxUrl("https://laptop.example.com")).toBe("https://laptop.example.com/");
    expect(normalizeBoxUrl("  https://laptop.example.com/login?next=%2F#x  ")).toBe("https://laptop.example.com/");
    expect(normalizeBoxUrl("http://192.0.2.10:3005/app/settings")).toBe("http://192.0.2.10:3005/");
    expect(normalizeBoxUrl("HTTPS://Laptop.Example.COM:443/")).toBe("https://laptop.example.com/");
  });

  it("reads a bare host the way an address bar does", () => {
    expect(normalizeBoxUrl("laptop.local")).toBe("http://laptop.local/");
    expect(normalizeBoxUrl("laptop.local:3005")).toBe("http://laptop.local:3005/");
    expect(normalizeBoxUrl("localhost:3005")).toBe("http://localhost:3005/");
    expect(normalizeBoxUrl("192.0.2.10")).toBe("http://192.0.2.10/");
  });

  it("refuses every other scheme, credentials in the address and what is not an address", () => {
    for (const bad of [
      "javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://example.com/",
      "chrome://settings", "mailto:someone@example.com", "https://user:pass@example.com/", "https://user@example.com/",
      "", "   ", "http://", "not a url", "https://exa mple.com/", `https://${"a".repeat(300)}.example.com/`, 42, null, undefined,
    ]) {
      expect(normalizeBoxUrl(bad), String(bad)).toBeNull();
    }
  });

  it("boxOrigin reads http(s) only", () => {
    expect(boxOrigin("https://laptop.example.com/x")).toBe("https://laptop.example.com");
    expect(boxOrigin("javascript:alert(1)")).toBeNull();
    expect(boxOrigin("nope")).toBeNull();
  });
});

describe("normalizeBoxName", () => {
  it("trims and folds spaces, keeps any script", () => {
    expect(normalizeBoxName("  Main   box \n")).toBe("Main box");
    expect(normalizeBoxName("Лаптоп")).toBe("Лаптоп");
    expect(normalizeBoxName("ノートPC")).toBe("ノートPC");
    expect(normalizeBoxName("x".repeat(40))).toBe("x".repeat(40));
  });

  it("refuses empty, too long, control and bidi-override characters", () => {
    for (const bad of ["", "   ", "x".repeat(41), "a\u0000b", "a\u0007b", "a\u202eb", "a\u2066b", 7, null]) {
      expect(normalizeBoxName(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("parseLinkedBoxesWrite / parseLinkedBoxesRead", () => {
  it("a written list is all good or refused with the first entry's reason", () => {
    expect(parseLinkedBoxesWrite([{ name: "Laptop", url: "laptop.local" }])).toEqual({
      ok: true,
      boxes: [{ name: "Laptop", url: "http://laptop.local/" }],
    });
    expect(parseLinkedBoxesWrite([])).toEqual({ ok: true, boxes: [] });
    expect(parseLinkedBoxesWrite("nope")).toEqual({ ok: false, code: "invalid_body" });
    expect(parseLinkedBoxesWrite([{ name: "A", url: "https://a.example" }, "x"])).toEqual({ ok: false, code: "invalid_body", index: 1 });
    expect(parseLinkedBoxesWrite([{ name: "", url: "https://a.example" }])).toEqual({ ok: false, code: "invalid_name", index: 0 });
    expect(parseLinkedBoxesWrite([{ name: "A", url: "javascript:alert(1)" }])).toEqual({ ok: false, code: "invalid_url", index: 0 });
    // The same box twice, however it was written.
    expect(parseLinkedBoxesWrite([
      { name: "A", url: "https://a.example/" },
      { name: "B", url: "https://A.example/login" },
    ])).toEqual({ ok: false, code: "duplicate", index: 1 });
    const nine = Array.from({ length: MAX_LINKED_BOXES + 1 }, (_, i) => ({ name: `B${i}`, url: `https://b${i}.example` }));
    expect(parseLinkedBoxesWrite(nine)).toEqual({ ok: false, code: "too_many" });
    expect(parseLinkedBoxesWrite(nine.slice(0, MAX_LINKED_BOXES)).ok).toBe(true);
  });

  it("a read list keeps what is good, drops the rest, caps at eight", () => {
    const raw = [
      { name: "A", url: "https://a.example" },
      { name: "bad", url: "javascript:alert(1)" },
      { name: "A again", url: "https://a.example/x" },
      null,
      ...Array.from({ length: 10 }, (_, i) => ({ name: `B${i}`, url: `https://b${i}.example` })),
    ];
    const read = parseLinkedBoxesRead(raw);
    expect(read).toHaveLength(MAX_LINKED_BOXES);
    expect(read[0]).toEqual({ name: "A", url: "https://a.example/" });
    expect(read.map((b) => b.name)).not.toContain("bad");
    expect(read.map((b) => b.name)).not.toContain("A again");
    expect(parseLinkedBoxesRead(undefined)).toEqual([]);
  });
});

describe("boxSwitchSlot", () => {
  it("Ctrl+Shift+Digit1 … Digit9 are slots 1 … 9, by code whatever the layout", () => {
    for (let n = 1; n <= 9; n++) expect(boxSwitchSlot(key(`Digit${n}`))).toBe(n);
    expect(MAX_WORKSPACES).toBe(9);
  });

  it("nothing else is", () => {
    expect(boxSwitchSlot(key("Digit0"))).toBeNull();
    expect(boxSwitchSlot(key("Numpad2"))).toBeNull();
    expect(boxSwitchSlot(key("KeyS"))).toBeNull();
    expect(boxSwitchSlot(key("Digit2", { shiftKey: false }))).toBeNull();
    expect(boxSwitchSlot(key("Digit2", { ctrlKey: false }))).toBeNull();
    expect(boxSwitchSlot(key("Digit2", { altKey: true }))).toBeNull();
    expect(boxSwitchSlot(key("Digit2", { metaKey: true }))).toBeNull();
    expect(boxSwitchSlot(key("Digit2", { isComposing: true }))).toBeNull();
    expect(boxSwitchSlot({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false })).toBeNull();
  });
});

const HOME = "https://main.example.com";
const LAPTOP = "https://laptop.example.com";
const NAS = "http://nas.example.net:3005";
const boxes = [
  { name: "Laptop", url: `${LAPTOP}/` },
  { name: "NAS", url: `${NAS}/` },
];

describe("ownWorkspaces / planSwitch on the home box", () => {
  const state = ownWorkspaces("main", HOME, boxes);

  it("slot 1 is this box, then the list in order", () => {
    expect(state.workspaces).toEqual([
      { slot: 1, name: "main", url: `${HOME}/`, here: true },
      { slot: 2, name: "Laptop", url: `${LAPTOP}/`, here: false },
      { slot: 3, name: "NAS", url: `${NAS}/`, here: false },
    ]);
    expect(state.carried).toBe(false);
  });

  it("1 stays, 2 opens the laptop carrying this numbering, 4 is empty", () => {
    expect(planSwitch(1, state)).toMatchObject({ kind: "stay", slot: 1 });
    const go = planSwitch(2, state);
    expect(go.kind).toBe("go");
    if (go.kind !== "go") return;
    expect(go.url.startsWith(`${LAPTOP}/${CARRY_PREFIX}`)).toBe(true);
    const carried = readCarriedHash(go.url.slice(go.url.indexOf("#"))).carried;
    expect(carried).toEqual({ to: 2, boxes: [{ name: "main", url: `${HOME}/` }, ...boxes] });
    expect(planSwitch(4, state)).toEqual({ kind: "empty", slot: 4 });
    expect(planSwitch(9, ownWorkspaces("main", HOME, []))).toEqual({ kind: "empty", slot: 9 });
  });
});

describe("the carried numbering", () => {
  const carried: CarriedSet = { to: 2, boxes: [{ name: "main", url: `${HOME}/` }, ...boxes] };

  it("round-trips through the fragment, names in any script included", () => {
    const set: CarriedSet = { to: 3, boxes: [{ name: "Главна", url: `${HOME}/` }, { name: "ノートPC", url: `${LAPTOP}/` }, { name: "NAS", url: `${NAS}/` }] };
    const text = encodeCarried(set);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCarried(text)).toEqual(set);
    expect(readCarriedHash(`${CARRY_PREFIX}${text}`)).toEqual({ ours: true, carried: set });
    expect(readCarriedHash("#something-else")).toEqual({ ours: false, carried: null });
  });

  it("anything that is not one is nothing", () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const bad of [
      "", "!!!", "not base64 at all", b64({ v: 2, to: 1, b: [["a", `${HOME}/`]] }), b64({ v: 1, to: 0, b: [["a", `${HOME}/`]] }),
      b64({ v: 1, to: 2, b: [["a", `${HOME}/`]] }), b64({ v: 1, to: 1, b: [] }), b64({ v: 1, to: 1, b: [["a", "javascript:alert(1)"]] }),
      b64({ v: 1, to: 1, b: [["", `${HOME}/`]] }), b64({ v: 1, to: 1, b: Array.from({ length: 10 }, (_, i) => [`b${i}`, `https://b${i}.example/`]) }),
      "a".repeat(9000),
    ]) {
      expect(decodeCarried(bad), bad.slice(0, 40)).toBeNull();
    }
    expect(readCarriedHash(`${CARRY_PREFIX}%%%`)).toEqual({ ours: true, carried: null });
  });

  it("the laptop that lists the home box keeps the home numbering: 1 goes home, 2 is here", () => {
    const state = effectiveWorkspaces({ selfName: "laptop", hereOrigin: LAPTOP, boxes: [{ name: "Main", url: `${HOME}/` }], carried });
    expect(state.carried).toBe(true);
    // The order is the home box's; the names are this box's own for what it
    // lists (itself included).
    expect(state.workspaces.map((w) => [w.slot, w.name, w.url, w.here])).toEqual([
      [1, "Main", `${HOME}/`, false],
      [2, "laptop", `${LAPTOP}/`, true],
      // The NAS is in the home box's list but not in this one: no address.
      [3, "NAS", null, false],
    ]);
    const home = planSwitch(1, state);
    expect(home.kind).toBe("go");
    if (home.kind === "go") {
      expect(home.url.startsWith(`${HOME}/${CARRY_PREFIX}`)).toBe(true);
      expect(readCarriedHash(home.url.slice(home.url.indexOf("#"))).carried).toEqual({ ...carried, to: 1 });
    }
    expect(planSwitch(2, state)).toMatchObject({ kind: "stay", slot: 2 });
    expect(planSwitch(3, state)).toMatchObject({ kind: "unlinked", slot: 3 });
  });

  it("is never kept when this box does not list its home: a crafted link cannot pick where a key goes", () => {
    const crafted: CarriedSet = { to: 2, boxes: [{ name: "Main", url: "https://evil.example/" }, { name: "Laptop", url: `${LAPTOP}/` }] };
    const state = effectiveWorkspaces({ selfName: "laptop", hereOrigin: LAPTOP, boxes: [{ name: "Main", url: `${HOME}/` }], carried: crafted });
    expect(state.carried).toBe(false);
    expect(state.workspaces[0]).toEqual({ slot: 1, name: "laptop", url: `${LAPTOP}/`, here: true });
    expect(state.workspaces.map((w) => w.url)).not.toContain("https://evil.example/");
    // …and a slot it lists but the box does not stays without an address.
    const sneaky: CarriedSet = { to: 2, boxes: [{ name: "Main", url: `${HOME}/` }, { name: "Laptop", url: `${LAPTOP}/` }, { name: "X", url: "https://evil.example/" }] };
    const kept = effectiveWorkspaces({ selfName: "laptop", hereOrigin: LAPTOP, boxes: [{ name: "Main", url: `${HOME}/` }], carried: sneaky });
    expect(kept.carried).toBe(true);
    expect(planSwitch(3, kept)).toMatchObject({ kind: "unlinked" });
  });

  it("a link cannot rename a box this box lists", () => {
    const renamed: CarriedSet = { to: 2, boxes: [{ name: "Bank", url: `${HOME}/` }, { name: "Mail", url: `${LAPTOP}/` }] };
    const state = effectiveWorkspaces({ selfName: "laptop", hereOrigin: LAPTOP, boxes: [{ name: "Main", url: `${HOME}/` }], carried: renamed });
    expect(state.workspaces.map((w) => w.name)).toEqual(["Main", "laptop"]);
  });

  it("ends back on the home box, which uses its own list again", () => {
    const back: CarriedSet = { ...carried, to: 1 };
    const state = effectiveWorkspaces({ selfName: "main", hereOrigin: HOME, boxes, carried: back });
    expect(state.carried).toBe(false);
    expect(state.workspaces[0]).toMatchObject({ slot: 1, here: true, url: `${HOME}/` });
  });

  it("a box reached under another address than the list's is the slot that was asked for", () => {
    const state = effectiveWorkspaces({
      selfName: "laptop",
      hereOrigin: "http://laptop.local",
      boxes: [{ name: "Main", url: `${HOME}/` }],
      carried,
    });
    expect(state.carried).toBe(true);
    expect(state.workspaces.find((w) => w.here)?.slot).toBe(2);
    expect(planSwitch(2, state).kind).toBe("stay");
  });
});
