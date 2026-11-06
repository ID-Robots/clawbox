/**
 * The laptop battery, as the desktop's tray indicator shows it.
 *
 * Read server-side from Linux sysfs, `/sys/class/power_supply/*`: every entry
 * there is a symlink into `/sys/devices/…`, and each attribute is a one-line
 * file under it. The kernel reports a battery as `type` Battery with
 * `capacity` (percent), `status` and either the energy family (`energy_now`,
 * `energy_full` in µWh, `power_now` in µW) or the charge family
 * (`charge_now`, `charge_full` in µAh, `current_now` in µA); the charger as a
 * Mains or USB supply with `online`.
 *
 * Only the x64 laptop shows it. The check is the process architecture,
 * `os.arch()`, as `system-info.ts` reports it — there is no edition flag that
 * tells the x64 build apart. A Jetson never even lists the directory.
 *
 * Not every Battery is the laptop's: a wireless mouse or headset registers one
 * too, with `scope` Device, and a hot-swap bay can hold a supply with
 * `present` 0. Both are skipped. A box with no battery left after that — every
 * desktop PC — is `available: false`, the normal answer rather than an error,
 * and so is anything this module cannot read: it never throws, so the route
 * that returns it never answers 500 for the ordinary state of most boxes.
 */
import { promises as fs } from "fs";
import os from "os";
import path from "./runtime-path";

export type BatteryState = "charging" | "discharging" | "full" | "not_charging" | "unknown";

export type BatteryStatus =
  | { available: false }
  | {
      available: true;
      /** Whole percent, 0–100. */
      percent: number;
      state: BatteryState;
      /** Whether a Mains or USB supply is feeding the laptop; null when none reports `online`. */
      acOnline: boolean | null;
      /**
       * Minutes to empty while discharging, to full while charging. Null in
       * every other state, when the rate is missing or zero, and when the
       * estimate is over 48 h (a near-idle rate gives a number nobody can use).
       */
      minutesLeft: number | null;
    };

export interface ReadBatteryOptions {
  /** The power_supply class directory; defaults to CLAWBOX_POWER_SUPPLY_DIR, then sysfs. */
  root?: string;
  /** The architecture to decide for; defaults to `os.arch()`. */
  arch?: string;
}

export const DEFAULT_POWER_SUPPLY_DIR = "/sys/class/power_supply";

const MAX_MINUTES_LEFT = 48 * 60;

interface Battery {
  capacity: number | null;
  state: BatteryState;
  energyNow: number | null;
  energyFull: number | null;
  powerNow: number | null;
  chargeNow: number | null;
  chargeFull: number | null;
  currentNow: number | null;
}

type Supply = { kind: "battery"; battery: Battery } | { kind: "ac"; online: number | null };

/** The `now`, `full` and `rate` of one unit family, so energy and charge share one sum. */
type Family = (b: Battery) => [now: number | null, full: number | null, rate: number | null];

const ENERGY: Family = (b) => [b.energyNow, b.energyFull, b.powerNow];
const CHARGE: Family = (b) => [b.chargeNow, b.chargeFull, b.currentNow];

async function readAttr(dir: string, name: string): Promise<string | null> {
  try {
    return (await fs.readFile(/* turbopackIgnore: true */ path.join(dir, name), "utf8")).trim();
  } catch {
    return null;
  }
}

function parseInteger(raw: string | null): number | null {
  if (raw === null || !/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** An amount (energy, charge, capacity): a negative one is garbage, not a reading. */
function parseAmount(raw: string | null): number | null {
  const value = parseInteger(raw);
  return value !== null && value >= 0 ? value : null;
}

/** A rate: some drivers sign `power_now`/`current_now` by direction, so only its size counts. */
function parseRate(raw: string | null): number | null {
  const value = parseInteger(raw);
  return value === null ? null : Math.abs(value);
}

// A switch, not a lookup table: a status of "constructor" must not find
// Object.prototype's.
function parseState(raw: string | null): BatteryState {
  switch ((raw ?? "").toLowerCase()) {
    case "charging":
      return "charging";
    case "discharging":
      return "discharging";
    case "full":
      return "full";
    case "not charging":
      return "not_charging";
    default:
      return "unknown";
  }
}

function isAcType(type: string): boolean {
  return type === "mains" || type === "usb" || type.startsWith("usb_");
}

async function readSupply(dir: string): Promise<Supply | null> {
  const type = (await readAttr(dir, "type"))?.toLowerCase();
  if (type !== "battery" && !(type && isAcType(type))) return null;
  // A peripheral's own battery or charger (mouse, headset) says Device.
  if ((await readAttr(dir, "scope"))?.toLowerCase() === "device") return null;

  if (type !== "battery") {
    return { kind: "ac", online: parseInteger(await readAttr(dir, "online")) };
  }
  // Absent `present` means the driver does not report it, not an empty bay.
  if (parseInteger(await readAttr(dir, "present")) === 0) return null;

  const [capacity, status, energyNow, energyFull, powerNow, chargeNow, chargeFull, currentNow] = await Promise.all(
    ["capacity", "status", "energy_now", "energy_full", "power_now", "charge_now", "charge_full", "current_now"].map(
      (name) => readAttr(dir, name),
    ),
  );
  return {
    kind: "battery",
    battery: {
      capacity: parseAmount(capacity),
      state: parseState(status),
      energyNow: parseAmount(energyNow),
      energyFull: parseAmount(energyFull),
      powerNow: parseRate(powerNow),
      chargeNow: parseAmount(chargeNow),
      chargeFull: parseAmount(chargeFull),
      currentNow: parseRate(currentNow),
    },
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** `now / full` of one family over every battery, or null unless all of them report it. */
function ratio(batteries: Battery[], family: Family): number | null {
  let now = 0;
  let full = 0;
  for (const b of batteries) {
    const [n, f] = family(b);
    if (n === null || f === null) return null;
    now += n;
    full += f;
  }
  return full > 0 ? now / full : null;
}

/** One battery's percent: `capacity`, else worked out from its own now/full. */
function batteryPercent(b: Battery): number | null {
  if (b.capacity !== null) return clampPercent(b.capacity);
  const fraction = ratio([b], ENERGY) ?? ratio([b], CHARGE);
  return fraction === null ? null : clampPercent(fraction * 100);
}

/**
 * Several batteries (a ThinkPad's internal + bay) are one pack to the owner:
 * weighted by energy when every one reports it, since a full small battery
 * and an empty large one are not "50 %"; otherwise the mean of the capacities.
 */
function combinedPercent(batteries: Battery[]): number | null {
  if (batteries.length === 1) return batteryPercent(batteries[0]);
  const byEnergy = ratio(batteries, ENERGY);
  if (byEnergy !== null) return clampPercent(byEnergy * 100);
  const known = batteries.map(batteryPercent).filter((p): p is number => p !== null);
  return known.length ? clampPercent(known.reduce((sum, p) => sum + p, 0) / known.length) : null;
}

/**
 * The pack's state. Batteries take turns, so the idle one says Unknown or Full
 * while the other works: any charging or discharging battery decides, then
 * Full only when every battery that says something says Full.
 */
function combinedState(batteries: Battery[]): BatteryState {
  const known = batteries.map((b) => b.state).filter((s) => s !== "unknown");
  if (known.includes("charging")) return "charging";
  if (known.includes("discharging")) return "discharging";
  if (known.length === 0) return "unknown";
  return known.every((s) => s === "full") ? "full" : "not_charging";
}

/** Hours to empty (or to full), summed over the pack in one family; null if any battery lacks it. */
function hoursLeft(batteries: Battery[], state: "charging" | "discharging", family: Family): number | null {
  let amount = 0;
  let rate = 0;
  for (const b of batteries) {
    const [now, full, r] = family(b);
    if (now === null || r === null) return null;
    if (state === "charging") {
      if (full === null) return null;
      amount += Math.max(full - now, 0);
    } else {
      amount += now;
    }
    rate += r;
  }
  return rate > 0 ? amount / rate : null;
}

function minutesLeft(batteries: Battery[], state: BatteryState): number | null {
  if (state !== "charging" && state !== "discharging") return null;
  const hours = hoursLeft(batteries, state, ENERGY) ?? hoursLeft(batteries, state, CHARGE);
  if (hours === null) return null;
  const minutes = Math.round(hours * 60);
  return Number.isFinite(minutes) && minutes <= MAX_MINUTES_LEFT ? minutes : null;
}

/** The laptop's battery, or `{ available: false }`. Never throws. */
export async function readBattery(opts: ReadBatteryOptions = {}): Promise<BatteryStatus> {
  try {
    if ((opts.arch ?? os.arch()) !== "x64") return { available: false };
    const root = opts.root || process.env.CLAWBOX_POWER_SUPPLY_DIR || DEFAULT_POWER_SUPPLY_DIR;

    let names: string[];
    try {
      names = (await fs.readdir(/* turbopackIgnore: true */ root)).sort();
    } catch {
      return { available: false };
    }
    const supplies = (await Promise.all(names.map((name) => readSupply(path.join(root, name))))).filter(
      (s): s is Supply => s !== null,
    );

    const batteries = supplies.flatMap((s) => (s.kind === "battery" ? [s.battery] : []));
    if (batteries.length === 0) return { available: false };
    const percent = combinedPercent(batteries);
    if (percent === null) return { available: false };

    const reported = supplies.flatMap((s) => (s.kind === "ac" && s.online !== null ? [s.online] : []));
    const state = combinedState(batteries);
    return {
      available: true,
      percent,
      state,
      acOnline: reported.length ? reported.some((online) => online > 0) : null,
      minutesLeft: minutesLeft(batteries, state),
    };
  } catch {
    return { available: false };
  }
}
