/**
 * Monitor brightness over DDC/CI — monitor mode's one setting that is not part
 * of the layout. It is offered only where it actually works: `ddcutil` is
 * installed, and the monitor answers on its i2c bus (a built-in panel never
 * does, and neither does a monitor behind many DisplayPort→HDMI adapters).
 * Everything else simply has no slider; nothing here is installed by ClawBox.
 *
 * ddcutil names each display's connector ("card1-HDMI-A-1"), which is how a
 * bus is tied to the compositor's output and so to a monitor id. Detection is
 * slow (≈2 s) and cached until the set of outputs changes or five minutes
 * pass; a read is ≈0.5 s and a write ≈1 s per monitor. All calls go through
 * ONE queue, because two ddcutil runs on one bus garble each other, and a
 * slider dragged quickly only ever sends its latest value.
 */
import { execFile } from "child_process";
import { processStore } from "./process-store";

/** VCP feature 0x10: luminance. */
const BRIGHTNESS_VCP = "10";
const DETECT_TTL_MS = 5 * 60_000;
const VALUE_TTL_MS = 10_000;
const DDC_TIMEOUT_MS = 10_000;

export interface BrightnessValue {
  value: number;
  max: number;
}

interface BrightnessState {
  detect: { at: number; key: string; buses: Map<string, number> } | null;
  values: Map<number, BrightnessValue & { at: number }>;
  queue: Promise<unknown>;
  /** The latest value asked for each bus, applied by whichever write runs next. */
  wanted: Map<number, number>;
  /** Buses whose write loop is running. */
  writing: Set<number>;
}

const state = () =>
  processStore<BrightnessState>("monitor-brightness", () => ({
    detect: null,
    values: new Map(),
    queue: Promise.resolve(),
    wanted: new Map(),
    writing: new Set(),
  }));

/**
 * `ddcutil detect --terse`: the buses of displays that answer DDC/CI, by
 * connector. "Invalid display" blocks (no DDC, a laptop panel) are left out.
 */
export function parseDdcDetect(text: string): Map<string, number> {
  const buses = new Map<string, number>();
  let valid = false;
  let bus: number | null = null;
  const flush = (connector: string | null) => {
    if (valid && bus !== null && connector) buses.set(connector, bus);
  };
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      valid = /^Display\s+\d+/.test(line);
      bus = null;
      continue;
    }
    const b = /^\s+I2C bus:\s+\/dev\/i2c-(\d+)\s*$/.exec(line);
    if (b) {
      bus = Number(b[1]);
      continue;
    }
    const c = /^\s+DRM connector:\s+card\d+-(\S+)\s*$/.exec(line);
    if (c) flush(c[1]);
  }
  return buses;
}

/** `ddcutil getvcp 10 --brief`: "VCP 10 C 88 100" → { value: 88, max: 100 }. */
export function parseVcpBrief(text: string): BrightnessValue | null {
  const m = /^VCP\s+10\s+C\s+(\d+)\s+(\d+)\s*$/m.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  const max = Number(m[2]);
  return max > 0 && value >= 0 && value <= max ? { value, max } : null;
}

function ddcutil(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      /* turbopackIgnore: true */ process.env.CLAWBOX_DDCUTIL || "ddcutil",
      args,
      { encoding: "utf8", timeout: DDC_TIMEOUT_MS, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: process.env.NODE_ENV } },
      (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(new Error((stderr || err.message).trim().slice(0, 300)));
        else resolve(stdout);
      },
    );
  });
}

/** One ddcutil at a time, whoever asks. */
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const s = state();
  const run = s.queue.catch(() => undefined).then(fn);
  s.queue = run.catch(() => undefined);
  return run;
}

async function buses(outputNames: string[]): Promise<Map<string, number>> {
  const s = state();
  const key = [...outputNames].sort().join(",");
  // Not installed, or no monitor answers: an empty map, cached like any other.
  if (s.detect && s.detect.key === key && Date.now() - s.detect.at < DETECT_TTL_MS) return s.detect.buses;
  const found = await queued(() => ddcutil(["detect", "--terse"])).then(parseDdcDetect, () => new Map<string, number>());
  s.detect = { at: Date.now(), key, buses: found };
  return found;
}

/**
 * The brightness of every monitor that can tell, keyed by the id the caller
 * gave each output. A monitor that cannot is simply absent.
 */
export async function readBrightness(outputs: Array<{ id: string; name: string }>): Promise<Record<string, BrightnessValue>> {
  const s = state();
  const map = await buses(outputs.map((o) => o.name));
  const out: Record<string, BrightnessValue> = {};
  for (const o of outputs) {
    const bus = map.get(o.name);
    if (bus === undefined) continue;
    const cached = s.values.get(bus);
    if (cached && Date.now() - cached.at < VALUE_TTL_MS) {
      out[o.id] = { value: cached.value, max: cached.max };
      continue;
    }
    const v = await queued(() => ddcutil(["--bus", String(bus), "getvcp", BRIGHTNESS_VCP, "--brief"])).then(parseVcpBrief, () => null);
    if (!v) continue;
    s.values.set(bus, { ...v, at: Date.now() });
    out[o.id] = v;
  }
  return out;
}

export class BrightnessError extends Error {
  constructor(public readonly code: "unsupported" | "invalid_value" | "write_failed", message: string) {
    super(message);
  }
}

/**
 * Set one monitor's brightness. Calls arriving while a write to the same
 * monitor is under way only replace the value it applies next, so a dragged
 * slider costs one write at a time and ends on the value it was let go at.
 */
export async function setBrightness(output: { id: string; name: string }, value: number, outputNames: string[]): Promise<BrightnessValue> {
  const s = state();
  const bus = (await buses(outputNames)).get(output.name);
  if (bus === undefined) throw new BrightnessError("unsupported", "This monitor's brightness can only be changed on the monitor itself");
  const max = s.values.get(bus)?.max ?? 100;
  if (!Number.isInteger(value) || value < 0 || value > max) throw new BrightnessError("invalid_value", `Brightness must be a whole number from 0 to ${max}`);
  s.wanted.set(bus, value);
  if (s.writing.has(bus)) return { value, max };
  s.writing.add(bus);
  try {
    for (;;) {
      const next = s.wanted.get(bus);
      if (next === undefined) break;
      s.wanted.delete(bus);
      try {
        await queued(() => ddcutil(["--bus", String(bus), "setvcp", BRIGHTNESS_VCP, String(next), "--noverify"]));
      } catch (err) {
        s.wanted.delete(bus);
        throw new BrightnessError("write_failed", err instanceof Error ? err.message : String(err));
      }
      s.values.set(bus, { value: next, max, at: Date.now() });
    }
  } finally {
    s.writing.delete(bus);
  }
  return { value: s.values.get(bus)?.value ?? value, max };
}

/** For the suites. */
export function _resetBrightnessForTests(): void {
  const s = state();
  s.detect = null;
  s.values.clear();
  s.queue = Promise.resolve();
  s.wanted.clear();
  s.writing.clear();
}
