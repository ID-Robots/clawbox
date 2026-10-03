/**
 * Monitor brightness over DDC/CI — monitor mode's one setting that is not part
 * of the layout. It is offered only where it actually works: `ddcutil` is
 * installed, and the monitor answers on its i2c bus (a built-in panel never
 * does, and neither does a monitor behind many DisplayPort→HDMI adapters).
 * Everything else simply has no slider; nothing here is installed by ClawBox.
 *
 * ddcutil names each display's connector ("card1-HDMI-A-1"), which is how a
 * bus is tied to the compositor's output and so to a monitor id. Detection is
 * slow (≈2 s); one that found a monitor is cached until the set of outputs
 * changes or five minutes pass. A read is ≈0.5 s and a write ≈1 s per
 * monitor. All calls go through ONE queue, because two ddcutil runs on one bus
 * garble each other, and a slider dragged quickly only ever sends its latest
 * value.
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

/**
 * A value waiting for its write. A caller that arrives before the write starts
 * replaces the value and shares the outcome, so every caller answers when the
 * monitor has (or has not) taken the value that stands for it.
 */
interface PendingWrite {
  value: number;
  max: number;
  done: Promise<BrightnessValue>;
  resolve: (v: BrightnessValue) => void;
  reject: (err: Error) => void;
}

interface BrightnessState {
  detect: { at: number; key: string; buses: Map<string, number> } | null;
  values: Map<number, BrightnessValue & { at: number }>;
  queue: Promise<unknown>;
  /** Per bus, the latest value asked for and not yet on its way to the monitor. */
  wanted: Map<number, PendingWrite>;
  /**
   * Per bus, the write loop that is running — a token, so a loop the suites'
   * reset forgot cannot unregister the one that replaced it.
   */
  loops: Map<number, object>;
}

const state = () =>
  processStore<BrightnessState>("monitor-brightness", () => ({
    detect: null,
    values: new Map(),
    queue: Promise.resolve(),
    wanted: new Map(),
    loops: new Map(),
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
  if (s.detect && s.detect.key === key && Date.now() - s.detect.at < DETECT_TTL_MS) return s.detect.buses;
  const found = await queued(() => ddcutil(["detect", "--terse"])).then(parseDdcDetect, () => null);
  // Only a detection that found a monitor is kept. A run that failed, or one in
  // which nothing answered — a monitor asleep or plugged in a moment ago — is
  // asked again next time instead of leaving its slider off for five minutes;
  // that costs little, since only the Monitors tab reads (once per set of
  // monitors that are on) and a write asks only for a monitor it showed.
  if (!found?.size) return new Map();
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

function pendingWrite(value: number, max: number): PendingWrite {
  let resolve!: (v: BrightnessValue) => void;
  let reject!: (err: Error) => void;
  const done = new Promise<BrightnessValue>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { value, max, done, resolve, reject };
}

/** Write the bus's wanted values one after another until none is left. Never rejects. */
function startWriteLoop(bus: number): void {
  const s = state();
  const self = {};
  s.loops.set(bus, self);
  void (async () => {
    for (let next = s.wanted.get(bus); next; next = s.wanted.get(bus)) {
      s.wanted.delete(bus);
      const { value, max } = next;
      try {
        await queued(() => ddcutil(["--bus", String(bus), "setvcp", BRIGHTNESS_VCP, String(value), "--noverify"]));
      } catch (err) {
        // Only this value's callers are told: a newer value asked for during
        // the write is still in `wanted`, and goes on the bus next.
        next.reject(new BrightnessError("write_failed", err instanceof Error ? err.message : String(err)));
        continue;
      }
      s.values.set(bus, { value, max, at: Date.now() });
      next.resolve({ value, max });
    }
    // In the same step as the empty look above, so a caller cannot find this
    // loop still registered after it has stopped looking.
    if (s.loops.get(bus) === self) s.loops.delete(bus);
  })();
}

/**
 * Set one monitor's brightness. Calls arriving while a write to the same
 * monitor is under way only replace the value it applies next, so a dragged
 * slider costs one write at a time and ends on the value it was let go at.
 * Every call answers once the write carrying its value — or the newer one that
 * replaced it — has landed or failed, with what that write put on the monitor.
 */
export async function setBrightness(output: { id: string; name: string }, value: number, outputNames: string[]): Promise<BrightnessValue> {
  const s = state();
  const bus = (await buses(outputNames)).get(output.name);
  if (bus === undefined) throw new BrightnessError("unsupported", "This monitor's brightness can only be changed on the monitor itself");
  const max = s.values.get(bus)?.max ?? 100;
  if (!Number.isInteger(value) || value < 0 || value > max) throw new BrightnessError("invalid_value", `Brightness must be a whole number from 0 to ${max}`);
  let next = s.wanted.get(bus);
  if (next) {
    next.value = value;
    next.max = max;
  } else {
    next = pendingWrite(value, max);
    s.wanted.set(bus, next);
  }
  if (!s.loops.has(bus)) startWriteLoop(bus);
  return next.done;
}

/** For the suites. */
export function _resetBrightnessForTests(): void {
  const s = state();
  s.detect = null;
  s.values.clear();
  s.queue = Promise.resolve();
  s.wanted.clear();
  s.loops.clear();
}
