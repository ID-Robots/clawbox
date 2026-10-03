/**
 * Monitor brightness over DDC/CI (src/lib/monitor-brightness.ts), over a FAKE
 * `ddcutil`: `child_process.execFile` is mocked, every call is recorded, and a
 * write (`setvcp`) is a deferred the test settles by hand, so a slider dragged
 * while a write is on the bus can be replayed step by step.
 *
 * Two contracts are pinned here beyond the parsers:
 *  - only a detection that found a monitor is cached — a run that failed or in
 *    which nothing answered (a monitor asleep, just plugged in) is asked again,
 *    rather than leaving the slider off for the five minutes a good one lasts;
 *  - every caller for a bus waits for the write that carries its value (or the
 *    newer one that replaced it) and gets THAT write's outcome, and a failed
 *    write never takes a newer value down with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  calls: [] as string[][],
  /** What a `detect --terse` answers: text, or an Error to fail with. */
  detect: "" as string | Error,
  /** What a `getvcp 10 --brief` answers. */
  getvcp: "VCP 10 C 40 100\n" as string | Error,
  /** The writes on the bus, each settled by the test. */
  writes: [] as Array<{ bus: string; value: string; ok: () => void; fail: (msg: string) => void }>,
}));

vi.mock("child_process", () => ({
  execFile: (...a: unknown[]) => {
    const args = a[1] as string[];
    const cb = a[a.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    fake.calls.push(args);
    const answer = (out: string | Error) => {
      if (out instanceof Error) cb(out, "", out.message);
      else cb(null, out, "");
    };
    if (args[0] === "detect") {
      const out = fake.detect;
      queueMicrotask(() => answer(out));
    } else if (args[2] === "getvcp") {
      const out = fake.getvcp;
      queueMicrotask(() => answer(out));
    } else if (args[2] === "setvcp") {
      fake.writes.push({
        bus: args[1],
        value: args[4],
        ok: () => answer(""),
        fail: (msg) => answer(new Error(msg)),
      });
    } else {
      queueMicrotask(() => answer(new Error(`unexpected ddcutil ${args.join(" ")}`)));
    }
  },
}));

import {
  BrightnessError,
  _resetBrightnessForTests,
  parseDdcDetect,
  parseVcpBrief,
  readBrightness,
  setBrightness,
} from "@/lib/monitor-brightness";

const DETECT_HDMI = [
  "Display 1",
  "   I2C bus:  /dev/i2c-5",
  "   DRM connector:           card1-HDMI-A-1",
  "   Monitor:                 DEL:DELL U2720Q:ABC123",
  "",
  "Invalid display",
  "   I2C bus:  /dev/i2c-7",
  "   DRM connector:           card1-eDP-1",
  "",
].join("\n");

/** A detection in which the monitor did not answer: it is listed, but invalid. */
const DETECT_ASLEEP = ["Invalid display", "   I2C bus:  /dev/i2c-5", "   DRM connector:           card1-HDMI-A-1", ""].join("\n");

const HDMI = { id: "mon-hdmi", name: "HDMI-A-1" };
const NAMES = ["HDMI-A-1", "eDP-1"];

const detects = () => fake.calls.filter((c) => c[0] === "detect").length;

/** Let every queued callback and promise reaction run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Track whether a promise has settled, without awaiting it. */
function track<T>(p: Promise<T>) {
  const t = { done: false, value: undefined as T | undefined, error: undefined as unknown };
  p.then(
    (v) => { t.done = true; t.value = v; },
    (e) => { t.done = true; t.error = e; },
  );
  return t;
}

beforeEach(() => {
  _resetBrightnessForTests();
  fake.calls.length = 0;
  fake.writes.length = 0;
  fake.detect = DETECT_HDMI;
  fake.getvcp = "VCP 10 C 40 100\n";
});

afterEach(() => {
  _resetBrightnessForTests();
});

describe("parsers", () => {
  it("parseDdcDetect keeps the displays that answer, by connector", () => {
    expect([...parseDdcDetect(DETECT_HDMI)]).toEqual([["HDMI-A-1", 5]]);
    expect(parseDdcDetect(DETECT_ASLEEP).size).toBe(0);
  });

  it("parseVcpBrief reads a value within its maximum", () => {
    expect(parseVcpBrief("VCP 10 C 88 100\n")).toEqual({ value: 88, max: 100 });
    expect(parseVcpBrief("VCP 10 C 120 100\n")).toBeNull();
    expect(parseVcpBrief("VCP 10 ERR\n")).toBeNull();
  });
});

describe("detection cache", () => {
  it("caches a detection that found a monitor, until the set of outputs changes", async () => {
    expect(await readBrightness([HDMI])).toEqual({ "mon-hdmi": { value: 40, max: 100 } });
    expect(await readBrightness([HDMI])).toEqual({ "mon-hdmi": { value: 40, max: 100 } });
    expect(detects()).toBe(1);
    // Another set of outputs is another detection.
    await readBrightness([HDMI, { id: "mon-dp", name: "DP-1" }]);
    expect(detects()).toBe(2);
  });

  it("does not cache a detection that FAILED, so the next read asks again", async () => {
    fake.detect = new Error("ddcutil: i2c bus busy");
    expect(await readBrightness([HDMI])).toEqual({});
    fake.detect = DETECT_HDMI;
    expect(await readBrightness([HDMI])).toEqual({ "mon-hdmi": { value: 40, max: 100 } });
    expect(detects()).toBe(2);
  });

  it("does not cache a detection in which no monitor answered (asleep, just plugged in)", async () => {
    fake.detect = DETECT_ASLEEP;
    expect(await readBrightness([HDMI])).toEqual({});
    // The monitor wakes: the very next read finds it rather than five minutes later.
    fake.detect = DETECT_HDMI;
    expect(await readBrightness([HDMI])).toEqual({ "mon-hdmi": { value: 40, max: 100 } });
    expect(detects()).toBe(2);
  });

  it("a write to a monitor that was asleep at the last look detects again instead of refusing", async () => {
    fake.detect = DETECT_ASLEEP;
    await expect(setBrightness(HDMI, 50, NAMES)).rejects.toMatchObject({ code: "unsupported" });
    fake.detect = DETECT_HDMI;
    const write = track(setBrightness(HDMI, 50, NAMES));
    await settle();
    expect(fake.writes.map((w) => w.value)).toEqual(["50"]);
    fake.writes[0].ok();
    await settle();
    expect(write.value).toEqual({ value: 50, max: 100 });
  });
});

describe("setBrightness: one write at a time per bus, the latest value wins", () => {
  it("a caller arriving mid-write waits for the write that carries its value", async () => {
    const a = track(setBrightness(HDMI, 30, NAMES));
    await settle();
    expect(fake.writes.map((w) => w.value)).toEqual(["30"]);

    // The slider moves twice while 30 is on the bus: 50 is replaced by 70.
    const b = track(setBrightness(HDMI, 50, NAMES));
    const c = track(setBrightness(HDMI, 70, NAMES));
    await settle();
    expect(b.done).toBe(false);
    expect(c.done).toBe(false);

    fake.writes[0].ok();
    await settle();
    expect(a.value).toEqual({ value: 30, max: 100 });
    // One more write, of the latest value only.
    expect(fake.writes.map((w) => w.value)).toEqual(["30", "70"]);
    expect(b.done).toBe(false);
    expect(c.done).toBe(false);

    fake.writes[1].ok();
    await settle();
    // Both answer with what the monitor now shows.
    expect(b.value).toEqual({ value: 70, max: 100 });
    expect(c.value).toEqual({ value: 70, max: 100 });
    expect(fake.writes).toHaveLength(2);
  });

  it("a failed write fails its own callers and still writes the newer value", async () => {
    const a = track(setBrightness(HDMI, 30, NAMES));
    await settle();
    const b = track(setBrightness(HDMI, 60, NAMES));
    await settle();
    expect(b.done).toBe(false);

    fake.writes[0].fail("DDC communication failed");
    await settle();
    expect(a.error).toBeInstanceOf(BrightnessError);
    expect(a.error).toMatchObject({ code: "write_failed", message: "DDC communication failed" });
    // 60 was not dropped with 30: it goes on the bus, and its caller waits for it.
    expect(fake.writes.map((w) => w.value)).toEqual(["30", "60"]);
    expect(b.done).toBe(false);

    fake.writes[1].ok();
    await settle();
    expect(b.value).toEqual({ value: 60, max: 100 });
  });

  it("a caller whose own write fails is told so, not that it worked", async () => {
    const a = track(setBrightness(HDMI, 30, NAMES));
    await settle();
    const b = track(setBrightness(HDMI, 60, NAMES));
    fake.writes[0].ok();
    await settle();
    expect(a.value).toEqual({ value: 30, max: 100 });

    fake.writes[1].fail("DDC communication failed");
    await settle();
    expect(b.error).toMatchObject({ code: "write_failed" });

    // The bus is free again: the next value is written at once.
    const c = track(setBrightness(HDMI, 80, NAMES));
    await settle();
    expect(fake.writes.map((w) => w.value)).toEqual(["30", "60", "80"]);
    fake.writes[2].ok();
    await settle();
    expect(c.value).toEqual({ value: 80, max: 100 });
  });

  it("refuses a value outside the monitor's range before anything is written", async () => {
    await expect(setBrightness(HDMI, 101, NAMES)).rejects.toMatchObject({ code: "invalid_value" });
    await expect(setBrightness(HDMI, 2.5, NAMES)).rejects.toMatchObject({ code: "invalid_value" });
    expect(fake.writes).toHaveLength(0);
  });

  it("_resetBrightnessForTests forgets a write loop that never finished", async () => {
    void setBrightness(HDMI, 30, NAMES);
    await settle();
    expect(fake.writes).toHaveLength(1);

    // The write above hangs for ever; after a reset a new value is not held
    // behind it, and is not handed to a loop nothing will ever resume.
    _resetBrightnessForTests();
    const b = track(setBrightness(HDMI, 55, NAMES));
    await settle();
    expect(fake.writes.map((w) => w.value)).toEqual(["30", "55"]);
    fake.writes[1].ok();
    await settle();
    expect(b.value).toEqual({ value: 55, max: 100 });
  });
});
