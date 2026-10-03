/**
 * Monitor mode's pure arithmetic (src/lib/monitors-layout.ts): what wlr-randr
 * prints, the plan for the monitors connected now, the arguments that put it
 * on screen, and the two readers that hold an untrusted layout (a request from
 * the Settings tab, a file read back from disk) to what the compositor offers.
 *
 * `wlr-randr-two-external.txt` is the real output of the test machine: two
 * identical AOC monitors (told apart by serial) and the laptop's own panel,
 * switched off, with no serial ("(null)"). `wlr-randr-builtin-rotated.txt` is
 * made by hand: the built-in panel ON at a fractional scale and an external
 * monitor rotated 90° at 1.5x, current mode not the preferred one.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  MONITOR_TRANSFORMS,
  distinctModes,
  isMirrored,
  layoutFromOutputs,
  logicalSize,
  mergeLayouts,
  monitorId,
  parseSavedLayout,
  parseWlrRandr,
  planLayout,
  preferredMode,
  protocolScale,
  readLayoutRequest,
  settingFromOutput,
  wlrRandrArgs,
  type MonitorLayout,
  type MonitorMode,
  type MonitorOutput,
  type MonitorPlan,
  type MonitorSetting,
  type PlannedOutput,
} from "@/lib/monitors-layout";

const fixture = (name: string) =>
  fs.readFileSync(new URL(`../fixtures/monitors/${name}`, import.meta.url), "utf8");

const TWO_EXTERNAL = fixture("wlr-randr-two-external.txt");
const BUILTIN_ROTATED = fixture("wlr-randr-builtin-rotated.txt");

const HDMI = "AOC|Q27B3MA|17ZP6HA000848";
const DP2 = "AOC|Q27B3MA|17ZP6HA001316";
const EDP = "BOE|0x06DF|@eDP-1";
const DELL = "Dell Inc.|DELL U2720Q|7XYZ123";

const sample = () => parseWlrRandr(TWO_EXTERNAL);
const handMade = () => parseWlrRandr(BUILTIN_ROTATED);
const byName = (outputs: MonitorOutput[], name: string) => {
  const o = outputs.find((x) => x.name === name);
  if (!o) throw new Error(`no output ${name}`);
  return o;
};
const planned = (plan: MonitorPlan | null, id: string): PlannedOutput => {
  const p = plan?.outputs.find((x) => x.id === id);
  if (!p) throw new Error(`no planned output ${id}`);
  return p;
};
const on = (width: number, height: number, refresh: number, extra: Partial<MonitorSetting> = {}): MonitorSetting => ({
  enabled: true, width, height, refresh, scale: 1, transform: "normal", ...extra,
});
const off = (width: number, height: number, refresh: number): MonitorSetting => ({ ...on(width, height, refresh), enabled: false });
const mode = (width: number, height: number, refresh: number, preferred = false): MonitorMode => ({ width, height, refresh, preferred });

/** A minimal output for the cases the fixtures do not cover. */
function output(name: string, over: Partial<MonitorOutput> = {}): MonitorOutput {
  const make = over.make ?? "ACME";
  const model = over.model ?? name;
  const serial = over.serial === undefined ? `SN-${name}` : over.serial;
  return {
    name,
    description: `${make} ${model} (${name})`,
    make,
    model,
    serial,
    id: monitorId(make, model, serial, name),
    builtIn: /^(eDP|LVDS|DSI)-/.test(name),
    physicalSize: null,
    enabled: true,
    modes: [mode(1920, 1080, 60, true)],
    current: { width: 1920, height: 1080, refresh: 60 },
    position: { x: 0, y: 0 },
    transform: "normal",
    scale: 1,
    ...over,
  };
}

// ---------------------------------------------------------------------------
describe("monitorId", () => {
  it("names a monitor by make, model and serial — not by the socket it is on", () => {
    expect(monitorId("AOC", "Q27B3MA", "17ZP6HA000848", "HDMI-A-1")).toBe(HDMI);
    expect(monitorId("AOC", "Q27B3MA", "17ZP6HA000848", "DP-2")).toBe(HDMI);
  });

  it("falls back to the connector when there is no serial, so two identical panels stay apart", () => {
    expect(monitorId("BOE", "0x06DF", null, "eDP-1")).toBe(EDP);
    expect(monitorId("BOE", "0x06DF", "(null)", "eDP-1")).toBe(EDP);
    expect(monitorId("BOE", "0x06DF", "   ", "eDP-1")).toBe(EDP);
    expect(monitorId("ACME", "X", null, "DP-1")).not.toBe(monitorId("ACME", "X", null, "DP-2"));
  });

  it("trims every part and marks a missing make or model with ?", () => {
    expect(monitorId("  AOC ", " Q27 ", " SN1 ", "DP-1")).toBe("AOC|Q27|SN1");
    expect(monitorId("", "  ", null, "HDMI-A-1")).toBe("?|?|@HDMI-A-1");
  });
});

// ---------------------------------------------------------------------------
describe("parseWlrRandr — the test machine's real output", () => {
  it("finds the three outputs in the order the compositor printed them", () => {
    const outputs = sample();
    expect(outputs.map((o) => o.name)).toEqual(["DP-2", "HDMI-A-1", "eDP-1"]);
    expect(outputs.map((o) => o.id)).toEqual([DP2, HDMI, EDP]);
  });

  it("reads an enabled external monitor field by field", () => {
    const dp = byName(sample(), "DP-2");
    expect(dp).toMatchObject({
      name: "DP-2",
      description: "AOC Q27B3MA 17ZP6HA001316 (DP-2 via HDMI)",
      make: "AOC",
      model: "Q27B3MA",
      serial: "17ZP6HA001316",
      id: DP2,
      builtIn: false,
      physicalSize: { width: 600, height: 340 },
      enabled: true,
      current: { width: 2560, height: 1440, refresh: 59.951 },
      position: { x: 2560, y: 0 },
      transform: "normal",
      scale: 1,
      adaptiveSync: false,
    });
    expect(dp.modes).toHaveLength(38);
    expect(dp.modes[0]).toEqual({ width: 2560, height: 1440, refresh: 59.951, preferred: true });
    expect(dp.modes[1]).toEqual({ width: 2560, height: 1440, refresh: 74.968002, preferred: false });
    expect(dp.modes[37]).toEqual({ width: 720, height: 400, refresh: 70.082001, preferred: false });
    expect(dp.modes.filter((m) => m.preferred)).toHaveLength(1);
  });

  it("tells the two identical AOC monitors apart by serial", () => {
    const [dp, hdmi] = sample();
    expect(dp.model).toBe(hdmi.model);
    expect(dp.id).not.toBe(hdmi.id);
    expect(byName(sample(), "HDMI-A-1").position).toEqual({ x: 0, y: 0 });
  });

  it("reads the switched-off built-in panel: no serial, no current mode, no position", () => {
    const edp = byName(sample(), "eDP-1");
    expect(edp).toMatchObject({
      make: "BOE",
      model: "0x06DF",
      serial: null,
      id: EDP,
      builtIn: true,
      physicalSize: { width: 310, height: 170 },
      enabled: false,
      current: null,
      position: null,
      transform: "normal",
      scale: 1,
    });
    expect(edp.modes).toEqual([mode(1920, 1080, 60.012001, true), mode(1920, 1080, 48.009998)]);
    // A disabled output prints no Adaptive Sync line: the field is absent, not false.
    expect("adaptiveSync" in edp).toBe(false);
  });

  it("reads the hand-made fixture: built-in on at 1.25x, external rotated 90° at 1.5x", () => {
    const [edp, dell] = handMade();
    expect(edp).toMatchObject({
      name: "eDP-1", id: EDP, builtIn: true, enabled: true, scale: 1.25, transform: "normal", adaptiveSync: false,
      current: { width: 1920, height: 1080, refresh: 60.012001 }, position: { x: 0, y: 0 },
    });
    expect(dell).toMatchObject({
      name: "DP-1", make: "Dell Inc.", model: "DELL U2720Q", serial: "7XYZ123", id: DELL, builtIn: false,
      enabled: true, scale: 1.5, transform: "90", position: { x: 1536, y: 0 }, adaptiveSync: true,
      // The current mode is not the preferred one.
      current: { width: 1920, height: 1080, refresh: 60 },
    });
    expect(dell.modes.find((m) => m.preferred)).toEqual(mode(3840, 2160, 60, true));
  });

  it("treats LVDS and DSI connectors as built-in too, and nothing else", () => {
    const text = ["LVDS-1 \"a\"", "  Enabled: no", "DSI-1 \"b\"", "  Enabled: no", "HDMI-A-2 \"c\"", "  Enabled: no", "VIRTUAL-1 \"d\"", "  Enabled: no"].join("\n");
    expect(parseWlrRandr(text).map((o) => [o.name, o.builtIn])).toEqual([
      ["LVDS-1", true], ["DSI-1", true], ["HDMI-A-2", false], ["VIRTUAL-1", false],
    ]);
  });

  it("returns nothing for empty or header-less text", () => {
    expect(parseWlrRandr("")).toEqual([]);
    expect(parseWlrRandr("\n\n")).toEqual([]);
    expect(parseWlrRandr("  Make: AOC\n  Enabled: yes\n    1920x1080 px, 60.000000 Hz (current)\n")).toEqual([]);
  });

  it("tolerates trailing whitespace on every line", () => {
    expect(parseWlrRandr(TWO_EXTERNAL.replace(/\n/g, "  \n"))).toEqual(sample());
  });

  it("never takes an indented line for a new output", () => {
    const text = `DP-1 "one"\n  Enabled: yes\n  DP-2 "not a header"\n`;
    const outputs = parseWlrRandr(text);
    expect(outputs.map((o) => o.name)).toEqual(["DP-1"]);
  });

  it("only counts mode lines inside the Modes block", () => {
    const text = [
      'DP-1 "x"',
      "  Make: ACME",
      "    3840x2160 px, 60.000000 Hz (preferred)",
      "  Enabled: yes",
      "  Modes:",
      "    1920x1080 px, 60.000000 Hz (preferred, current)",
      "  Position: 0,0",
      "    1280x720 px, 60.000000 Hz (current)",
    ].join("\n");
    const [o] = parseWlrRandr(text);
    expect(o.modes).toEqual([mode(1920, 1080, 60, true)]);
    expect(o.current).toEqual({ width: 1920, height: 1080, refresh: 60 });
  });

  it("falls back to safe values for an unknown transform, a bad scale and a bad position", () => {
    const text = [
      'DP-1 "x"', "  Enabled: yes", "  Position: here", "  Transform: sideways", "  Scale: 0.000000",
      'DP-2 "y"', "  Enabled: yes", "  Position: -1920,-5", "  Transform: flipped-270", "  Scale: banana",
      'DP-3 "z"', "  Enabled: maybe", "  Physical size: 0x0 cm", "  Serial: ", "  Scale: 2.000000",
    ].join("\n");
    const [a, b, c] = parseWlrRandr(text);
    expect(a).toMatchObject({ position: null, transform: "normal", scale: 1, enabled: true });
    expect(b).toMatchObject({ position: { x: -1920, y: -5 }, transform: "flipped-270", scale: 1 });
    expect(c).toMatchObject({ enabled: false, physicalSize: null, serial: null, scale: 2, id: "?|?|@DP-3" });
  });

  it("tells apart two monitors that report the same serial by their connectors", () => {
    // Many panels carry a fixed EDID serial (0x01010101): two of one model
    // would otherwise share an id and could never be arranged one by one.
    const twin = (name: string, x: number) => [
      `${name} "Acme X (${name})"`, "  Make: Acme", "  Model: X", "  Serial: 0x01010101", "  Enabled: yes",
      "  Modes:", "    1920x1080 px, 60.000000 Hz (preferred, current)", `  Position: ${x},0`, "  Transform: normal", "  Scale: 1.000000",
    ];
    const outputs = parseWlrRandr([...twin("HDMI-A-1", 0), ...twin("DP-1", 1920), ...TWO_EXTERNAL.split("\n")].join("\n"));
    expect(outputs.map((o) => o.id).slice(0, 2)).toEqual(["Acme|X|0x01010101@HDMI-A-1", "Acme|X|0x01010101@DP-1"]);
    // Monitors with a serial of their own keep the plain id.
    expect(outputs.slice(2).map((o) => o.id)).toEqual([DP2, HDMI, EDP]);
    expect(new Set(outputs.map((o) => o.id)).size).toBe(outputs.length);

    // ...so each can be ordered, set and made main on its own.
    const r = readLayoutRequest({
      order: ["Acme|X|0x01010101@DP-1", "Acme|X|0x01010101@HDMI-A-1"],
      main: "Acme|X|0x01010101@DP-1",
      monitors: { "Acme|X|0x01010101@HDMI-A-1": { ...on(1920, 1080, 60), enabled: false } },
    }, outputs.slice(0, 2));
    if (!r.ok) throw new Error(`refused: ${r.code}`);
    const plan = planLayout(outputs.slice(0, 2), r.layout);
    expect(plan?.outputs.map((p) => [p.name, p.enabled, p.x])).toEqual([["DP-1", true, 0], ["HDMI-A-1", false, 0]]);
    expect(plan?.main).toBe("Acme|X|0x01010101@DP-1");
  });

  it("leaves a lone monitor with a fixed serial its plain id", () => {
    const text = ['HDMI-A-1 "Acme X"', "  Make: Acme", "  Model: X", "  Serial: 0x01010101", "  Enabled: yes"].join("\n");
    expect(parseWlrRandr(text)[0].id).toBe("Acme|X|0x01010101");
  });

  it("reads Adaptive Sync as a boolean only when it says enabled or disabled", () => {
    const text = ['DP-1 "a"', "  Adaptive Sync: enabled", 'DP-2 "b"', "  Adaptive Sync: disabled", 'DP-3 "c"', "  Adaptive Sync: unsupported"].join("\n");
    const [a, b, c] = parseWlrRandr(text);
    expect(a.adaptiveSync).toBe(true);
    expect(b.adaptiveSync).toBe(false);
    expect("adaptiveSync" in c).toBe(false);
  });

  it("ignores lines it does not know", () => {
    const text = 'DP-1 "x"\n  Make: ACME\n  Some Future Field: 42\n  Enabled: yes\n';
    const [o] = parseWlrRandr(text);
    expect(o).toMatchObject({ make: "ACME", enabled: true, modes: [] });
  });
});

// ---------------------------------------------------------------------------
describe("distinctModes / preferredMode", () => {
  it("folds the duplicate modes of the real monitor and sorts biggest first", () => {
    const modes = distinctModes(byName(sample(), "DP-2").modes);
    // 38 lines, six exact repeats (1920x1080@60, 1280x720@60, 720x576@50,
    // 720x480@60, 720x480@59.94, 640x480@59.94).
    expect(modes).toHaveLength(32);
    expect(modes.slice(0, 7).map((m) => `${m.width}x${m.height}@${m.refresh}`)).toEqual([
      "2560x1440@74.968002",
      "2560x1440@59.951",
      "1920x1080@74.973",
      "1920x1080@60",
      "1920x1080@59.939999",
      "1920x1080@50",
      "1280x1440@59.912998",
    ]);
    for (let i = 1; i < modes.length; i++) {
      const a = modes[i - 1], b = modes[i];
      const areaA = a.width * a.height, areaB = b.width * b.height;
      expect(areaA > areaB || (areaA === areaB && a.refresh > b.refresh)).toBe(true);
    }
    expect(modes.filter((m) => m.preferred)).toEqual([mode(2560, 1440, 59.951, true)]);
  });

  it("folds to the millihertz and keeps the preferred flag of any duplicate", () => {
    const folded = distinctModes([mode(1920, 1080, 60), mode(1920, 1080, 60.0004, true), mode(1920, 1080, 60.002)]);
    expect(folded).toHaveLength(2);
    expect(folded.find((m) => Math.round(m.refresh * 1000) === 60000)?.preferred).toBe(true);
  });

  it("does not change the list it was given", () => {
    const input = [mode(1920, 1080, 60), mode(1920, 1080, 60, true)];
    const copy = structuredClone(input);
    distinctModes(input);
    expect(input).toEqual(copy);
  });

  it("preferredMode is the flagged mode even when a bigger one exists", () => {
    expect(preferredMode(byName(sample(), "DP-2"))).toEqual(mode(2560, 1440, 59.951, true));
    const o = output("DP-1", { modes: [mode(3840, 2160, 30), mode(1920, 1080, 60, true)] });
    expect(preferredMode(o)).toEqual(mode(1920, 1080, 60, true));
  });

  it("preferredMode without a flag is the biggest, fastest mode; with no modes it is null", () => {
    const o = output("DP-1", { modes: [mode(1920, 1080, 60), mode(2560, 1440, 59.95), mode(2560, 1440, 144)] });
    expect(preferredMode(o)).toEqual(mode(2560, 1440, 144));
    expect(preferredMode(output("DP-1", { modes: [] }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("logicalSize", () => {
  it("is the mode itself at scale 1, normal", () => {
    expect(logicalSize(2560, 1440, 1, "normal")).toEqual({ width: 2560, height: 1440 });
  });

  it("swaps width and height for every quarter turn, and only for those", () => {
    for (const t of ["90", "270", "flipped-90", "flipped-270"] as const) {
      expect(logicalSize(2560, 1440, 1, t)).toEqual({ width: 1440, height: 2560 });
    }
    for (const t of ["normal", "180", "flipped", "flipped-180"] as const) {
      expect(logicalSize(2560, 1440, 1, t)).toEqual({ width: 2560, height: 1440 });
    }
    expect(MONITOR_TRANSFORMS).toHaveLength(8);
  });

  it("divides by the scale, after rotating", () => {
    expect(logicalSize(3840, 2160, 2, "normal")).toEqual({ width: 1920, height: 1080 });
    expect(logicalSize(1920, 1080, 1.25, "normal")).toEqual({ width: 1536, height: 864 });
    expect(logicalSize(1920, 1080, 1.5, "90")).toEqual({ width: 720, height: 1280 });
    expect(logicalSize(3840, 2160, 2, "flipped-270")).toEqual({ width: 1080, height: 1920 });
  });

  it("treats a zero or negative scale as 1", () => {
    expect(logicalSize(1920, 1080, 0, "normal")).toEqual({ width: 1920, height: 1080 });
    expect(logicalSize(1920, 1080, -2, "90")).toEqual({ width: 1080, height: 1920 });
  });

  // wlroots' own layout box (wlr_output_effective_resolution, which
  // wlr_output_layout uses for every output's box) is `int /= float` — it
  // TRUNCATES. Rounded, 2560 px at 1.5x was 1707 here against 1706 on screen,
  // and the next monitor placed at x=1707 left a 1 px column that belonged to
  // no monitor. Integer quotients (1x, 1.25x, 2x of the usual modes) are
  // unaffected.
  it("matches wlroots at a fractional scale that does not divide the mode", () => {
    expect(logicalSize(2560, 1440, 1.5, "normal")).toEqual({ width: 1706, height: 960 });
    expect(logicalSize(2560, 1440, 1.75, "normal")).toEqual({ width: 1462, height: 822 });
    expect(logicalSize(1366, 768, 1.25, "normal")).toEqual({ width: 1092, height: 614 });
    expect(logicalSize(2560, 1440, 1.5, "90")).toEqual({ width: 960, height: 1706 });
  });

  it("divides in single precision, as the compositor does", () => {
    // 1440 / 1.2: 1199.99995 in float32 arithmetic rounds to exactly 1200.
    expect(logicalSize(1440, 900, 1.2, "normal")).toEqual({ width: 1200, height: 750 });
  });

  it("places the next monitor where the compositor ends the previous one", () => {
    const outputs = [output("HDMI-A-1", { modes: [mode(2560, 1440, 60, true)] }), output("DP-1", { modes: [mode(2560, 1440, 60, true)] })];
    const saved: MonitorLayout = {
      order: ["ACME|HDMI-A-1|SN-HDMI-A-1", "ACME|DP-1|SN-DP-1"],
      main: null,
      monitors: { "ACME|HDMI-A-1|SN-HDMI-A-1": on(2560, 1440, 60, { scale: 1.5 }), "ACME|DP-1|SN-DP-1": on(2560, 1440, 60, { scale: 1.5 }) },
    };
    const plan = planLayout(outputs, saved);
    expect(plan?.outputs.map((p) => p.x)).toEqual([0, 1706]);
    expect(plan?.box).toEqual({ width: 3412, height: 960 });
    expect(wlrRandrArgs(plan!)).toContain("1706,0");
  });
});

describe("protocolScale", () => {
  it("is the scale as the output-management protocol carries it (24.8 fixed point)", () => {
    for (const s of [1, 1.25, 1.5, 1.75, 2, MIN_SCALE, MAX_SCALE]) expect(protocolScale(s)).toBe(s);
    expect(protocolScale(1.235)).toBe(1.234375);
    expect(protocolScale(1.2)).toBe(307 / 256);
  });
});

// ---------------------------------------------------------------------------
describe("settingFromOutput / layoutFromOutputs", () => {
  it("an output stands in its current mode, or its preferred one while off", () => {
    expect(settingFromOutput(byName(sample(), "HDMI-A-1"))).toEqual(on(2560, 1440, 59.951, { adaptiveSync: false }));
    const edp = settingFromOutput(byName(sample(), "eDP-1"));
    expect(edp).toEqual(off(1920, 1080, 60.012001));
    expect(edp && "adaptiveSync" in edp).toBe(false);
    expect(settingFromOutput(byName(handMade(), "DP-1"))).toEqual(on(1920, 1080, 60, { scale: 1.5, transform: "90", adaptiveSync: true }));
    expect(settingFromOutput(output("DP-1", { modes: [], current: null }))).toBeNull();
  });

  it("orders the outputs that are on left to right, then the ones that are off", () => {
    const layout = layoutFromOutputs(sample(), null);
    expect(layout.order).toEqual([HDMI, DP2, EDP]);
    expect(layout.main).toBeNull();
    expect(Object.keys(layout.monitors).sort()).toEqual([DP2, EDP, HDMI].sort());
    expect("mirror" in layout).toBe(false);
    expect(layoutFromOutputs(sample(), DP2).main).toBe(DP2);
  });

  it("marks the layout mirrored when two or more monitors that are on share one position", () => {
    const mirrored = sample().map((o) => (o.enabled ? { ...o, position: { x: 0, y: 0 } } : o));
    expect(layoutFromOutputs(mirrored, null).mirror).toBe(true);
  });
});

describe("isMirrored", () => {
  it("is false for the test machine's row", () => {
    expect(isMirrored(sample())).toBe(false);
  });

  it("is true for two monitors on at the same position, whatever is off", () => {
    const outputs = sample().map((o) => ({ ...o, position: { x: 0, y: 0 } }));
    expect(isMirrored(outputs)).toBe(true);
    expect(isMirrored([output("A-1", { position: { x: 100, y: 50 } }), output("B-1", { position: { x: 100, y: 50 } })])).toBe(true);
  });

  it("needs two monitors that are on, with a position", () => {
    expect(isMirrored([output("A-1")])).toBe(false);
    expect(isMirrored([output("A-1"), output("B-1", { enabled: false })])).toBe(false);
    expect(isMirrored([output("A-1"), output("B-1", { position: null })])).toBe(false);
    expect(isMirrored([output("A-1"), output("B-1", { position: { x: 0, y: 1 } })])).toBe(false);
    expect(isMirrored([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("planLayout", () => {
  it("has nothing to plan with no outputs, or with outputs that offer no mode", () => {
    expect(planLayout([], null)).toBeNull();
    expect(planLayout([output("DP-1", { modes: [], current: null })], null)).toBeNull();
  });

  it("skips an output without modes and plans the rest", () => {
    const plan = planLayout([output("DP-1", { modes: [], current: null }), output("DP-2")], null);
    expect(plan?.outputs.map((p) => p.name)).toEqual(["DP-2"]);
  });

  it("reproduces what is on screen from the layout the compositor shows now", () => {
    const outputs = sample();
    const plan = planLayout(outputs, layoutFromOutputs(outputs, null));
    expect(plan).toEqual({
      outputs: [
        { name: "HDMI-A-1", id: HDMI, enabled: true, width: 2560, height: 1440, refresh: 59.951, scale: 1, transform: "normal", adaptiveSync: false, x: 0, y: 0 },
        { name: "DP-2", id: DP2, enabled: true, width: 2560, height: 1440, refresh: 59.951, scale: 1, transform: "normal", adaptiveSync: false, x: 2560, y: 0 },
        { name: "eDP-1", id: EDP, enabled: false, width: 1920, height: 1080, refresh: 60.012001, scale: 1, transform: "normal", x: 0, y: 0 },
      ],
      main: HDMI,
      box: { width: 5120, height: 1440 },
      mirror: false,
    });
  });

  it("lays rotated and scaled outputs out by their logical size, top-aligned", () => {
    const outputs = handMade();
    const plan = planLayout(outputs, layoutFromOutputs(outputs, null));
    expect(planned(plan, EDP)).toMatchObject({ enabled: true, x: 0, y: 0, scale: 1.25, transform: "normal" });
    expect(planned(plan, DELL)).toMatchObject({ enabled: true, x: 1536, y: 0, width: 1920, height: 1080, scale: 1.5, transform: "90" });
    // 1920x1080 at 1.25 → 1536x864; 1920x1080 turned 90° at 1.5 → 720x1280.
    expect(plan?.box).toEqual({ width: 1536 + 720, height: 1280 });
    // The main monitor is the first one that is not the built-in panel.
    expect(plan?.main).toBe(DELL);
  });

  it("honours the saved order and the saved main monitor", () => {
    const saved: MonitorLayout = {
      order: [DP2, EDP, HDMI],
      main: HDMI,
      monitors: { [DP2]: on(2560, 1440, 59.951), [HDMI]: on(1920, 1080, 60), [EDP]: off(1920, 1080, 60.012001) },
    };
    const plan = planLayout(sample(), saved);
    expect(plan?.outputs.map((p) => p.id)).toEqual([DP2, EDP, HDMI]);
    expect(planned(plan, DP2)).toMatchObject({ enabled: true, x: 0 });
    expect(planned(plan, EDP)).toMatchObject({ enabled: false, x: 0, y: 0 });
    expect(planned(plan, HDMI)).toMatchObject({ enabled: true, x: 2560, width: 1920, height: 1080, refresh: 60 });
    expect(plan?.main).toBe(HDMI);
    expect(plan?.box).toEqual({ width: 2560 + 1920, height: 1440 });
  });

  it("turns a monitor it has never seen on at its preferred mode, at the right end of the row", () => {
    const saved: MonitorLayout = {
      order: [HDMI, EDP],
      main: HDMI,
      monitors: { [HDMI]: on(1920, 1080, 60), [EDP]: off(1920, 1080, 60.012001) },
    };
    const plan = planLayout(sample(), saved);
    expect(plan?.outputs.map((p) => p.id)).toEqual([HDMI, EDP, DP2]);
    expect(planned(plan, DP2)).toEqual({
      name: "DP-2", id: DP2, enabled: true, width: 2560, height: 1440, refresh: 59.951, scale: 1, transform: "normal", x: 1920, y: 0,
    });
    expect(plan?.main).toBe(HDMI);
  });

  it("puts every never-seen monitor after every known one, whatever its position", () => {
    // HDMI-A-1 sits at x=0 on screen, DP-2 at 2560; the saved layout knows
    // only DP-2, so HDMI-A-1 goes to its right.
    const outputs = sample().filter((o) => !o.builtIn);
    const plan = planLayout(outputs, { order: [DP2], main: null, monitors: { [DP2]: on(2560, 1440, 59.951) } });
    const ids = plan?.outputs.map((p) => p.id) ?? [];
    expect(ids[0]).toBe(DP2);
    expect(planned(plan, HDMI).x).toBe(2560);
  });

  it("with nothing saved turns every connected monitor on at its preferred mode", () => {
    const plan = planLayout(sample(), null);
    expect(plan?.outputs.every((p) => p.enabled && p.scale === 1 && p.transform === "normal" && p.y === 0)).toBe(true);
    expect(planned(plan, EDP)).toMatchObject({ width: 1920, height: 1080, refresh: 60.012001 });
    expect(plan?.box).toEqual({ width: 2560 + 2560 + 1920, height: 1440 });
    expect(plan?.main).not.toBe(EDP);
  });

  // Among monitors the saved layout does not rank, one that is OFF has no
  // position. Read as x=0 it sorted LEFT of the ones already on screen (and
  // `localeCompare` put "eDP-1" before "HDMI-A-1"), so with nothing saved and
  // the lid open the reconciler lit the laptop panel at x=0 and pushed both
  // AOC monitors 1920 px to the right — where the doc says a never-seen
  // monitor "goes to the right end of the row".
  it("with nothing saved, a monitor that is off comes on to the right of the ones already on screen", () => {
    const plan = planLayout(sample(), null);
    expect(plan?.outputs.map((p) => [p.name, p.x])).toEqual([["HDMI-A-1", 0], ["DP-2", 2560], ["eDP-1", 5120]]);
  });

  // The same with a saved layout: both never-seen monitors go after the known
  // one, and the one that is off (no position) after the one on screen at x=0.
  it("among never-seen monitors, one that is off goes after the ones on screen", () => {
    const plan = planLayout(sample(), { order: [DP2], main: DP2, monitors: { [DP2]: on(2560, 1440, 59.951) } });
    expect(plan?.outputs.map((p) => p.name)).toEqual(["DP-2", "HDMI-A-1", "eDP-1"]);
  });

  it("carries a saved adaptive-sync choice into the plan", () => {
    const plan = planLayout(sample(), { order: [], main: null, monitors: { [HDMI]: on(2560, 1440, 59.951, { adaptiveSync: true }) } });
    expect(planned(plan, HDMI).adaptiveSync).toBe(true);
    expect("adaptiveSync" in planned(plan, EDP)).toBe(false);
  });

  it("puts a saved mode the monitor no longer offers back to its preferred mode, keeping scale and rotation", () => {
    const saved: MonitorLayout = {
      order: [HDMI, DP2],
      main: null,
      monitors: { [HDMI]: on(3840, 2160, 60, { scale: 2, transform: "180" }), [DP2]: on(2560, 1440, 59.951) },
    };
    const plan = planLayout(sample(), saved);
    expect(planned(plan, HDMI)).toMatchObject({ width: 2560, height: 1440, refresh: 59.951, scale: 2, transform: "180", x: 0 });
    expect(planned(plan, DP2).x).toBe(1280);
  });

  it("takes the refresh rate nearest to the saved one when the size is offered", () => {
    const plan = (refresh: number) =>
      planned(planLayout(sample(), { order: [], main: null, monitors: { [HDMI]: on(1920, 1080, refresh) } }), HDMI).refresh;
    expect(plan(59.94)).toBe(59.939999);
    expect(plan(61)).toBe(60);
    expect(plan(74)).toBe(74.973);
    expect(plan(1)).toBe(50);
  });

  it("ignores saved monitors that are not connected", () => {
    const ghost = "GHOST|X|1";
    const plan = planLayout(sample(), { order: [ghost, DP2], main: ghost, monitors: { [ghost]: on(800, 600, 60) } });
    expect(plan?.outputs.map((p) => p.id)).not.toContain(ghost);
    expect(plan?.outputs[0].id).toBe(DP2);
    expect(plan?.main).not.toBe(ghost);
  });

  it("does not change the saved layout it was given", () => {
    const saved: MonitorLayout = { order: [DP2], main: DP2, monitors: { [DP2]: off(2560, 1440, 59.951), [HDMI]: off(2560, 1440, 59.951) } };
    const copy = structuredClone(saved);
    planLayout(sample(), saved, { lidClosed: true });
    expect(saved).toEqual(copy);
  });

  describe("at least one output is always on", () => {
    it("brings the built-in panel back when every connected monitor is set off", () => {
      const saved: MonitorLayout = {
        order: [HDMI, DP2, EDP],
        main: HDMI,
        monitors: { [HDMI]: off(2560, 1440, 59.951), [DP2]: off(2560, 1440, 59.951), [EDP]: off(1920, 1080, 60.012001) },
      };
      const plan = planLayout(sample(), saved);
      expect(plan?.outputs.filter((p) => p.enabled).map((p) => p.id)).toEqual([EDP]);
      expect(plan?.main).toBe(EDP);
      expect(planned(plan, EDP).x).toBe(0);
      expect(plan?.box).toEqual({ width: 1920, height: 1080 });
    });

    it("brings the first monitor the compositor lists back when there is no built-in panel", () => {
      const outputs = sample().filter((o) => !o.builtIn);
      const plan = planLayout(outputs, { order: [HDMI, DP2], main: null, monitors: { [HDMI]: off(2560, 1440, 59.951), [DP2]: off(2560, 1440, 59.951) } });
      expect(plan?.outputs.filter((p) => p.enabled).map((p) => p.id)).toEqual([outputs[0].id]);
      expect(plan?.main).toBe(outputs[0].id);
    });

    it("never plans a main monitor that is off", () => {
      const saved: MonitorLayout = { order: [], main: DP2, monitors: { [DP2]: off(2560, 1440, 59.951) } };
      const plan = planLayout(sample(), saved);
      expect(planned(plan, DP2).enabled).toBe(false);
      expect(plan?.main).not.toBe(DP2);
      expect(planned(plan, plan!.main).enabled).toBe(true);
    });
  });

  describe("main monitor fallback", () => {
    it("is the first monitor on that is not the built-in panel, even with the panel on at the left", () => {
      const outputs = handMade();
      const plan = planLayout(outputs, { order: [EDP, DELL], main: null, monitors: {} });
      expect(plan?.outputs[0].id).toBe(EDP);
      expect(plan?.main).toBe(DELL);
    });

    it("is the first non-built-in in layout order, not in compositor order", () => {
      const plan = planLayout(sample(), { order: [EDP, DP2, HDMI], main: null, monitors: {} });
      expect(plan?.main).toBe(DP2);
    });

    it("is the built-in panel when it is the only monitor on", () => {
      const outputs = handMade();
      const plan = planLayout(outputs, { order: [EDP, DELL], main: DELL, monitors: { [DELL]: off(1920, 1080, 60) } });
      expect(plan?.main).toBe(EDP);
    });
  });

  describe("mirror", () => {
    const both = (extra: Partial<MonitorLayout> = {}): MonitorLayout => ({
      order: [HDMI, DP2, EDP],
      main: null,
      monitors: { [HDMI]: on(2560, 1440, 59.951), [DP2]: on(1920, 1080, 60), [EDP]: off(1920, 1080, 60.012001) },
      ...extra,
    });

    it("puts every monitor that is on at (0, 0) and sizes the box to the biggest", () => {
      const plan = planLayout(sample(), both({ mirror: true }));
      expect(plan?.mirror).toBe(true);
      expect(planned(plan, HDMI)).toMatchObject({ enabled: true, x: 0, y: 0 });
      expect(planned(plan, DP2)).toMatchObject({ enabled: true, x: 0, y: 0, width: 1920 });
      expect(plan?.box).toEqual({ width: 2560, height: 1440 });
      const args = wlrRandrArgs(plan!);
      expect(args.filter((a, i) => args[i - 1] === "--pos")).toEqual(["0,0", "0,0"]);
    });

    it("is a row when the layout does not ask for a mirror", () => {
      for (const mirror of [false, undefined]) {
        const plan = planLayout(sample(), both({ mirror }));
        expect(plan?.mirror).toBe(false);
        expect(planned(plan, DP2).x).toBe(2560);
        expect(plan?.box).toEqual({ width: 2560 + 1920, height: 1440 });
      }
    });

    it("is not a mirror with only one monitor on", () => {
      const plan = planLayout(sample(), both({ mirror: true, monitors: { [HDMI]: on(2560, 1440, 59.951), [DP2]: off(1920, 1080, 60), [EDP]: off(1920, 1080, 60.012001) } }));
      expect(plan?.mirror).toBe(false);
      expect(plan?.box).toEqual({ width: 2560, height: 1440 });
    });

    it("is not a mirror when the shut lid leaves one monitor on", () => {
      const outputs = handMade();
      const plan = planLayout(outputs, { ...layoutFromOutputs(outputs, null), mirror: true }, { lidClosed: true });
      expect(plan?.mirror).toBe(false);
      expect(plan?.outputs.filter((p) => p.enabled).map((p) => p.id)).toEqual([DELL]);
    });

    it("reproduces a mirrored screen from the layout the compositor shows", () => {
      const outputs = sample().map((o) => (o.enabled ? { ...o, position: { x: 0, y: 0 } } : o));
      const plan = planLayout(outputs, layoutFromOutputs(outputs, null));
      expect(plan?.mirror).toBe(true);
      expect(plan?.outputs.filter((p) => p.enabled).every((p) => p.x === 0 && p.y === 0)).toBe(true);
    });
  });

  describe("lidClosed", () => {
    it("turns the built-in panel off when another monitor can carry the desktop", () => {
      const outputs = handMade();
      const plan = planLayout(outputs, layoutFromOutputs(outputs, EDP), { lidClosed: true });
      expect(planned(plan, EDP).enabled).toBe(false);
      expect(planned(plan, DELL)).toMatchObject({ enabled: true, x: 0 });
      expect(plan?.main).toBe(DELL);
      expect(plan?.box).toEqual({ width: 720, height: 1280 });
    });

    it("leaves the built-in panel on when it is the only monitor", () => {
      const outputs = handMade().filter((o) => o.builtIn);
      const plan = planLayout(outputs, layoutFromOutputs(outputs, null), { lidClosed: true });
      expect(planned(plan, EDP).enabled).toBe(true);
      expect(plan?.main).toBe(EDP);
    });

    it("never turns the built-in panel on — it stays off beside a monitor that is on", () => {
      const saved: MonitorLayout = {
        order: [HDMI, DP2, EDP],
        main: null,
        monitors: { [HDMI]: on(2560, 1440, 59.951), [DP2]: on(2560, 1440, 59.951), [EDP]: off(1920, 1080, 60.012001) },
      };
      for (const lidClosed of [true, false]) {
        expect(planned(planLayout(sample(), saved, { lidClosed }), EDP).enabled).toBe(false);
      }
    });

    it("brings an external monitor back, not the panel, when everything is set off behind a shut lid", () => {
      const saved: MonitorLayout = {
        order: [HDMI, DP2, EDP],
        main: null,
        monitors: { [HDMI]: off(2560, 1440, 59.951), [DP2]: off(2560, 1440, 59.951), [EDP]: on(1920, 1080, 60.012001) },
      };
      const plan = planLayout(sample(), saved, { lidClosed: true });
      const lit = plan?.outputs.filter((p) => p.enabled).map((p) => p.id) ?? [];
      expect(lit).toHaveLength(1);
      expect(lit[0]).not.toBe(EDP);
      expect(plan?.main).toBe(lit[0]);
    });

    it("still lights the panel when it is the only monitor and was set off (at least one on wins)", () => {
      const outputs = handMade().filter((o) => o.builtIn);
      const plan = planLayout(outputs, { order: [EDP], main: null, monitors: { [EDP]: off(1920, 1080, 60.012001) } }, { lidClosed: true });
      expect(planned(plan, EDP).enabled).toBe(true);
    });

    it("leaves the built-in panel alone with the lid open or not reported", () => {
      const outputs = handMade();
      const saved = layoutFromOutputs(outputs, null);
      expect(planned(planLayout(outputs, saved, { lidClosed: false }), EDP).enabled).toBe(true);
      expect(planned(planLayout(outputs, saved), EDP).enabled).toBe(true);
    });

    it("needs lidClosed to be exactly true", () => {
      const outputs = handMade();
      const plan = planLayout(outputs, layoutFromOutputs(outputs, null), { lidClosed: "yes" as unknown as boolean });
      expect(planned(plan, EDP).enabled).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
describe("wlrRandrArgs", () => {
  it("puts the test machine's current layout back in one configuration, outputs that are off first", () => {
    const outputs = sample();
    const plan = planLayout(outputs, layoutFromOutputs(outputs, null))!;
    expect(wlrRandrArgs(plan)).toEqual([
      "--output", "eDP-1", "--off",
      "--output", "HDMI-A-1", "--on", "--mode", "2560x1440@59.951000Hz", "--pos", "0,0", "--transform", "normal", "--scale", "1", "--adaptive-sync", "disabled",
      "--output", "DP-2", "--on", "--mode", "2560x1440@59.951000Hz", "--pos", "2560,0", "--transform", "normal", "--scale", "1", "--adaptive-sync", "disabled",
    ]);
  });

  it("leaves adaptive sync out when asked to (the retry), and when the plan does not say", () => {
    const outputs = sample();
    const plan = planLayout(outputs, layoutFromOutputs(outputs, null))!;
    const args = wlrRandrArgs(plan, false);
    expect(args).not.toContain("--adaptive-sync");
    expect(args).toHaveLength(3 + 11 + 11);
    const enabledEdp = planLayout(outputs, null)!;
    const edpArgs = wlrRandrArgs(enabledEdp);
    const at = edpArgs.indexOf("eDP-1");
    // eDP-1 never reported adaptive sync, so its block ends at --scale.
    expect(edpArgs.slice(at - 1, at + 10)).toEqual([
      "--output", "eDP-1", "--on", "--mode", "1920x1080@60.012001Hz", "--pos", expect.any(String), "--transform", "normal", "--scale", "1",
    ]);
    expect(edpArgs[at + 10]).not.toBe("--adaptive-sync");
  });

  it("lists every off output before any on output, whatever the row order", () => {
    const plan: MonitorPlan = {
      main: "b",
      mirror: false,
      box: { width: 1920, height: 1080 },
      outputs: [
        { name: "A-1", id: "a", enabled: false, width: 1920, height: 1080, refresh: 60, scale: 1, transform: "normal", x: 0, y: 0 },
        { name: "B-1", id: "b", enabled: true, width: 1920, height: 1080, refresh: 60, scale: 1, transform: "normal", x: 0, y: 0 },
        { name: "C-1", id: "c", enabled: false, width: 1920, height: 1080, refresh: 60, scale: 1, transform: "normal", x: 0, y: 0 },
      ],
    };
    const args = wlrRandrArgs(plan);
    expect(args.slice(0, 6)).toEqual(["--output", "A-1", "--off", "--output", "C-1", "--off"]);
    expect(args.slice(6, 9)).toEqual(["--output", "B-1", "--on"]);
    // Two off outputs (3 each) and one on: --output B-1 --on + 4 flag pairs.
    expect(args).toHaveLength(6 + 11);
  });

  it("writes the refresh rate with six decimals and the scale and rotation as planned", () => {
    const outputs = handMade();
    const args = wlrRandrArgs(planLayout(outputs, layoutFromOutputs(outputs, null))!);
    expect(args).toEqual([
      "--output", "eDP-1", "--on", "--mode", "1920x1080@60.012001Hz", "--pos", "0,0", "--transform", "normal", "--scale", "1.25", "--adaptive-sync", "disabled",
      "--output", "DP-1", "--on", "--mode", "1920x1080@60.000000Hz", "--pos", "1536,0", "--transform", "90", "--scale", "1.5", "--adaptive-sync", "enabled",
    ]);
    const odd = wlrRandrArgs(planLayout(sample(), { order: [HDMI], main: null, monitors: { [HDMI]: on(2560, 1440, 74.968002) } })!);
    expect(odd).toContain("2560x1440@74.968002Hz");
  });

  it("hands over nothing but plain strings", () => {
    const args = wlrRandrArgs(planLayout(sample(), null)!);
    expect(args.every((a) => typeof a === "string" && a.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("readLayoutRequest", () => {
  const outputs = sample();
  const valid = () => ({
    order: [HDMI, DP2],
    main: HDMI,
    monitors: {
      [HDMI]: { enabled: true, width: 2560, height: 1440, refresh: 59.951, scale: 1, transform: "normal" },
      [DP2]: { enabled: true, width: 2560, height: 1440, refresh: 59.951, scale: 1, transform: "normal" },
    } as Record<string, Record<string, unknown>>,
  });
  const refusal = (body: unknown) => {
    const r = readLayoutRequest(body, outputs);
    return r.ok ? "ok" : r.code;
  };
  const withMonitor = (id: string, patch: Record<string, unknown>) => {
    const b = valid();
    b.monitors[id] = { ...b.monitors[id], ...patch };
    return b;
  };

  it("accepts a layout the connected monitors can show, appending the ones it did not order", () => {
    const r = readLayoutRequest(valid(), outputs);
    expect(r).toEqual({
      ok: true,
      layout: {
        order: [HDMI, DP2, EDP],
        main: HDMI,
        monitors: { [HDMI]: on(2560, 1440, 59.951), [DP2]: on(2560, 1440, 59.951) },
      },
    });
  });

  it("accepts a layout with no main monitor, and an empty monitors map", () => {
    const b = valid();
    delete (b as { main?: unknown }).main;
    expect(readLayoutRequest(b, outputs)).toMatchObject({ ok: true, layout: { main: null } });
    expect(readLayoutRequest({ ...valid(), main: null }, outputs)).toMatchObject({ ok: true, layout: { main: null } });
    // Nothing changed: the two AOC monitors are on now, so something is on.
    expect(readLayoutRequest({ order: [], monitors: {} }, outputs)).toEqual({
      ok: true, layout: { order: [DP2, HDMI, EDP], main: null, monitors: {} },
    });
  });

  it("refuses a body of the wrong shape as invalid", () => {
    for (const body of [
      null, undefined, "layout", 42, true,
      [], // no order
      { monitors: {} },
      { order: [], monitors: {}, mirror: "yes" },
      { order: [], monitors: {}, mirror: null },
      { order: [], monitors: {}, mirror: 1 },
      { order: "DP-2", monitors: {} },
      { order: [], monitors: null },
      { order: [], monitors: "x" },
      { order: [] },
      { order: [42], monitors: {} },
      { order: [null], monitors: {} },
    ]) {
      expect(refusal(body), JSON.stringify(body)).toBe("invalid");
    }
  });

  it("refuses a monitor setting of the wrong shape as invalid", () => {
    const b = valid();
    b.monitors[HDMI] = null as unknown as Record<string, unknown>;
    expect(refusal(b)).toBe("invalid");
    const s = valid();
    s.monitors[HDMI] = "on" as unknown as Record<string, unknown>;
    expect(refusal(s)).toBe("invalid");
    for (const enabled of ["yes", 1, null, undefined]) expect(refusal(withMonitor(HDMI, { enabled }))).toBe("invalid");
    for (const adaptiveSync of ["yes", 1, null, "enabled"]) expect(refusal(withMonitor(HDMI, { adaptiveSync }))).toBe("invalid");
    for (const key of ["width", "height", "refresh"]) {
      for (const v of ["abc", undefined, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
        expect(refusal(withMonitor(HDMI, { [key]: v })), `${key}=${String(v)}`).toBe("invalid");
      }
    }
  });

  it("refuses a monitor that is not connected as unknown_monitor — in the order, the map or as main", () => {
    expect(refusal({ ...valid(), order: [HDMI, "GHOST|X|1"] })).toBe("unknown_monitor");
    expect(refusal({ ...valid(), order: ["HDMI-A-1"] })).toBe("unknown_monitor"); // a connector is not an id
    const b = valid();
    b.monitors["GHOST|X|1"] = { ...b.monitors[HDMI] };
    expect(refusal(b)).toBe("unknown_monitor");
    expect(refusal({ ...valid(), main: "GHOST|X|1" })).toBe("unknown_monitor");
    expect(refusal({ ...valid(), main: 7 })).toBe("unknown_monitor");
    expect(refusal({ ...valid(), main: { id: HDMI } })).toBe("unknown_monitor");
  });

  it("is not fooled by prototype keys", () => {
    const body = JSON.parse(`{"order":[],"monitors":{"__proto__":{"enabled":true,"width":2560,"height":1440,"refresh":59.951,"scale":1,"transform":"normal"}}}`);
    expect(refusal(body)).toBe("unknown_monitor");
    expect(refusal({ order: ["constructor"], monitors: {} })).toBe("unknown_monitor");
    expect(refusal({ order: [], monitors: {}, main: "toString" })).toBe("unknown_monitor");
    expect(({} as Record<string, unknown>).enabled).toBeUndefined();
  });

  it("refuses a mode the monitor does not offer as unknown_mode", () => {
    expect(refusal(withMonitor(HDMI, { width: 3840, height: 2160, refresh: 60 }))).toBe("unknown_mode");
    expect(refusal(withMonitor(HDMI, { width: 1440, height: 2560 }))).toBe("unknown_mode");
    expect(refusal(withMonitor(HDMI, { width: 1920, height: 1080, refresh: 60.5 }))).toBe("unknown_mode");
    expect(refusal(withMonitor(HDMI, { refresh: 59.97 }))).toBe("unknown_mode");
    // eDP-1's 1920x1080@60.012 is not one of the AOC's modes.
    expect(refusal(withMonitor(HDMI, { width: 1920, height: 1080, refresh: 60.012001 }))).toBe("unknown_mode");
  });

  it("refuses a scale outside the range as invalid_scale, and takes both ends", () => {
    for (const scale of [0.49, 0, -1, 3.01, 10, "abc", undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refusal(withMonitor(HDMI, { scale })), `scale=${String(scale)}`).toBe("invalid_scale");
    }
    expect(refusal(withMonitor(HDMI, { scale: MIN_SCALE }))).toBe("ok");
    expect(refusal(withMonitor(HDMI, { scale: MAX_SCALE }))).toBe("ok");
  });

  it("refuses a transform that is not one of the eight as invalid_transform", () => {
    for (const transform of ["45", "Normal", "rotate-90", 90, undefined, null, "", "normal; reboot"]) {
      expect(refusal(withMonitor(HDMI, { transform })), `transform=${String(transform)}`).toBe("invalid_transform");
    }
    for (const transform of MONITOR_TRANSFORMS) expect(refusal(withMonitor(HDMI, { transform }))).toBe("ok");
  });

  it("refuses a layout that leaves every monitor off as none_enabled", () => {
    const b = { ...withMonitor(HDMI, { enabled: false }), main: null };
    b.monitors[DP2] = { ...b.monitors[DP2], enabled: false };
    // eDP-1 is not named and is off right now, so nothing would be on.
    expect(refusal(b)).toBe("none_enabled");
    // Turning the panel on makes it a layout again.
    b.monitors[EDP] = { enabled: true, width: 1920, height: 1080, refresh: 60.012001, scale: 1, transform: "normal" };
    expect(refusal(b)).toBe("ok");
  });

  it("counts a monitor the request does not name by how it stands now", () => {
    const b = { ...withMonitor(HDMI, { enabled: false }), main: null };
    delete b.monitors[DP2]; // DP-2 is on right now
    expect(refusal(b)).toBe("ok");
  });

  it("refuses a main monitor that would be off as main_disabled", () => {
    expect(refusal({ ...withMonitor(HDMI, { enabled: false }), main: HDMI })).toBe("main_disabled");
    // eDP-1 is off now and the request leaves it alone.
    expect(refusal({ ...valid(), main: EDP })).toBe("main_disabled");
  });

  it("checks in a fixed order: the mode before the scale before the transform", () => {
    expect(refusal(withMonitor(HDMI, { width: 1, scale: 99, transform: "x" }))).toBe("unknown_mode");
    expect(refusal(withMonitor(HDMI, { scale: 99, transform: "x" }))).toBe("invalid_scale");
  });

  it("rebuilds every value from the compositor's own lists, never passing the request through", () => {
    const b = withMonitor(HDMI, {
      width: "2560", height: "1440", refresh: 59.95, scale: "1.23456", transform: "flipped-90",
      exec: "rm -rf /", name: "HDMI-A-1; reboot", x: -99999,
    });
    b.order = [DP2, HDMI, DP2, HDMI];
    const r = readLayoutRequest(b, outputs);
    if (!r.ok) throw new Error(`refused: ${r.code}`);
    const s = r.layout.monitors[HDMI];
    expect(Object.keys(s).sort()).toEqual(["enabled", "height", "refresh", "scale", "transform", "width"]);
    // The scale as the protocol carries it (24.8 fixed point): 1.23456 → 316/256.
    expect(s).toEqual({ enabled: true, width: 2560, height: 1440, refresh: 59.951, scale: 1.234375, transform: "flipped-90" });
    expect(typeof s.width).toBe("number");
    // The mode object is the compositor's: its exact refresh, not the 59.95 asked for.
    expect(byName(outputs, "HDMI-A-1").modes.some((m) => m.refresh === s.refresh && m.width === s.width)).toBe(true);
    // The order is deduplicated and completed with the monitors it did not name.
    expect(r.layout.order).toEqual([DP2, HDMI, EDP]);
    expect(Object.keys(r.layout.monitors).sort()).toEqual([DP2, HDMI].sort());
  });

  it("matches a refresh within 0.01 Hz of an offered one", () => {
    expect(refusal(withMonitor(HDMI, { width: 1920, height: 1080, refresh: 59.94 }))).toBe("ok");
    expect(refusal(withMonitor(HDMI, { width: 1920, height: 1080, refresh: 59.935 }))).toBe("ok");
    expect(refusal(withMonitor(HDMI, { width: 1920, height: 1080, refresh: 59.92 }))).toBe("unknown_mode");
  });

  it("keeps a boolean adaptive-sync choice and the mirror switch, and adds neither when absent", () => {
    const r = readLayoutRequest({ ...withMonitor(HDMI, { adaptiveSync: true }), mirror: true }, outputs);
    if (!r.ok) throw new Error(`refused: ${r.code}`);
    expect(r.layout.mirror).toBe(true);
    expect(r.layout.monitors[HDMI].adaptiveSync).toBe(true);
    expect("adaptiveSync" in r.layout.monitors[DP2]).toBe(false);
    const plain = readLayoutRequest(valid(), outputs);
    if (!plain.ok) throw new Error(`refused: ${plain.code}`);
    expect("mirror" in plain.layout).toBe(false);
    const row = readLayoutRequest({ ...valid(), mirror: false }, outputs);
    expect(row.ok && row.layout.mirror).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("mergeLayouts", () => {
  const saved: MonitorLayout = {
    order: [EDP, HDMI, "OLD|X|1"],
    main: "OLD|X|1",
    monitors: { [EDP]: off(1920, 1080, 60.012001), [HDMI]: on(1920, 1080, 60), "OLD|X|1": on(1280, 1024, 60) },
  };

  it("lets the new layout win, and keeps what it says nothing about", () => {
    const next: MonitorLayout = { order: [HDMI, DP2], main: HDMI, monitors: { [HDMI]: on(2560, 1440, 59.951), [DP2]: on(2560, 1440, 59.951) } };
    expect(mergeLayouts(saved, next)).toEqual({
      order: [HDMI, DP2, EDP, "OLD|X|1"],
      main: HDMI,
      monitors: {
        [EDP]: off(1920, 1080, 60.012001),
        [HDMI]: on(2560, 1440, 59.951),
        [DP2]: on(2560, 1440, 59.951),
        "OLD|X|1": on(1280, 1024, 60),
      },
    });
  });

  it("keeps the saved main monitor when the new layout names none", () => {
    expect(mergeLayouts(saved, { order: [], main: null, monitors: {} }).main).toBe("OLD|X|1");
  });

  it("takes the mirror switch from the new layout, else keeps the saved one, else adds none", () => {
    const next: MonitorLayout = { order: [], main: null, monitors: {} };
    expect(mergeLayouts({ ...saved, mirror: true }, { ...next, mirror: false }).mirror).toBe(false);
    expect(mergeLayouts({ ...saved, mirror: true }, next).mirror).toBe(true);
    expect("mirror" in mergeLayouts(saved, next)).toBe(false);
    expect(mergeLayouts(null, { ...next, mirror: true }).mirror).toBe(true);
  });

  it("with nothing saved is the new layout", () => {
    const next: MonitorLayout = { order: [DP2], main: null, monitors: { [DP2]: on(2560, 1440, 59.951) } };
    expect(mergeLayouts(null, next)).toEqual(next);
  });

  it("changes neither input", () => {
    const next: MonitorLayout = { order: [HDMI], main: HDMI, monitors: { [HDMI]: on(2560, 1440, 59.951) } };
    const a = structuredClone(saved), b = structuredClone(next);
    const merged = mergeLayouts(saved, next);
    merged.order.push("x");
    merged.monitors.x = on(1, 1, 1);
    expect(saved).toEqual(a);
    expect(next).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
describe("parseSavedLayout", () => {
  const good = {
    order: [HDMI, DP2, EDP],
    main: HDMI,
    monitors: {
      [HDMI]: on(2560, 1440, 59.951),
      [DP2]: on(1920, 1080, 60, { scale: 1.25, transform: "flipped-180" }),
      [EDP]: off(1920, 1080, 60.012001),
    },
  };

  it("reads back a layout it wrote", () => {
    expect(parseSavedLayout(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it("is null for anything that is not a layout", () => {
    for (const raw of [
      null, undefined, "", "layout", 0, 1, true, [], [good],
      {}, { order: [] }, { monitors: {} }, { order: "a", monitors: {} }, { order: [], monitors: null }, { order: [], monitors: 5 },
    ]) {
      expect(parseSavedLayout(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("drops each monitor entry it does not recognise and keeps the rest", () => {
    const raw = {
      order: [HDMI],
      main: HDMI,
      monitors: {
        [HDMI]: on(2560, 1440, 59.951),
        a: null,
        b: "on",
        c: { ...on(1920, 1080, 60), enabled: "yes" },
        d: { ...on(1920, 1080, 60), transform: "sideways" },
        e: { ...on(1920, 1080, 60), transform: undefined },
        f: { ...on(1920, 1080, 60), width: "wide" },
        g: { ...on(1920, 1080, 60), refresh: undefined },
        h: { ...on(1920, 1080, 60), scale: 0.25 },
        i: { ...on(1920, 1080, 60), scale: 3.5 },
        j: { ...on(1920, 1080, 60), width: 0 },
        k: { ...on(1920, 1080, 60), height: -1080 },
        l: { ...on(1920, 1080, 60), scale: Number.POSITIVE_INFINITY },
      },
    };
    expect(parseSavedLayout(raw)).toEqual({ order: [HDMI], main: HDMI, monitors: { [HDMI]: on(2560, 1440, 59.951) } });
  });

  it("keeps the scale range's two ends", () => {
    const raw = { order: [], monitors: { a: on(1920, 1080, 60, { scale: MIN_SCALE }), b: on(1920, 1080, 60, { scale: MAX_SCALE }) } };
    expect(Object.keys(parseSavedLayout(raw)!.monitors)).toEqual(["a", "b"]);
  });

  it("filters the order to strings and reads a main that is not a string as none", () => {
    expect(parseSavedLayout({ order: [HDMI, 7, null, { id: DP2 }, DP2], main: 42, monitors: {} })).toEqual({
      order: [HDMI, DP2], main: null, monitors: {},
    });
    expect(parseSavedLayout({ order: [], monitors: {} })).toEqual({ order: [], main: null, monitors: {} });
  });

  it("reads the mirror switch and adaptive sync only as booleans, dropping the field and not the entry", () => {
    const raw = {
      order: [],
      mirror: "yes",
      monitors: { a: { ...on(1920, 1080, 60), adaptiveSync: "enabled" }, b: { ...on(1920, 1080, 60), adaptiveSync: false } },
    };
    const layout = parseSavedLayout(raw)!;
    expect("mirror" in layout).toBe(false);
    expect(layout.monitors.a).toEqual(on(1920, 1080, 60));
    expect("adaptiveSync" in layout.monitors.a).toBe(false);
    expect(layout.monitors.b).toEqual(on(1920, 1080, 60, { adaptiveSync: false }));
    expect(parseSavedLayout({ order: [], monitors: {}, mirror: true })!.mirror).toBe(true);
    expect(parseSavedLayout({ order: [], monitors: {}, mirror: false })!.mirror).toBe(false);
  });

  it("takes only the known fields of a monitor entry", () => {
    const raw = { order: [], monitors: { [HDMI]: { ...on(2560, 1440, 59.951), x: 100, command: "reboot" } } };
    expect(parseSavedLayout(raw)!.monitors[HDMI]).toEqual(on(2560, 1440, 59.951));
  });

  // BUG (src/lib/monitors-layout.ts:408, parseSavedLayout): the numeric fields
  // go through `Number(...)`, so a hand-edited file's "2560" (string), `true`,
  // `[1920]` or `null` (→ 0 for refresh) are coerced into numbers and KEPT,
  // although the function's contract is "read back strictly: anything
  // unrecognised is dropped, never repaired". Low impact — planLayout matches
  // the size against the compositor's modes — but it is a repair.
  it.fails("drops numeric fields that are not numbers instead of coercing them", () => {
    const raw = {
      order: [],
      monitors: {
        a: { ...on(1920, 1080, 60), width: "1920" },
        b: { ...on(1920, 1080, 60), refresh: null },
        c: { ...on(1920, 1080, 60), scale: true },
        d: { ...on(1920, 1080, 60), height: [1080] },
      },
    };
    expect(parseSavedLayout(raw)!.monitors).toEqual({});
  });
});
