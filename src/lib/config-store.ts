import path from "path";
import fs from "fs";

/**
 * Where this ClawBox is installed, resolved AT CALL TIME.
 *
 * `CONFIG_ROOT` below is the same answer captured at import time, and it is
 * what almost everything should use. Call this instead only where the root can
 * still change after the module is loaded — the tests set `CLAWBOX_ROOT` in a
 * `beforeEach`, which a module-level constant never sees.
 *
 * NOT `process.cwd()` outside development: the production server chdirs into
 * `.next/standalone` (Next's standalone `server.js` does `process.chdir`), so
 * the cwd there is the build output, not the install.
 */
export function resolveConfigRoot(): string {
  return process.env.CLAWBOX_ROOT
    || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
}

export const CONFIG_ROOT = resolveConfigRoot();
export const DATA_DIR = path.join(CONFIG_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

// Simple JSON file-based key-value store — works with both Node.js and Bun

function readConfig(): Record<string, unknown> {
  try {
    return readConfigStrict();
  } catch {
    return {};
  }
}

/**
 * The same read, without the swallow.
 *
 * `readConfig()` answers `{}` to a missing file, an EACCES, an EIO and a
 * half-written JSON alike, which is fine for the settings it was written for
 * and wrong for a caller deciding whether two bots collide: "we could not read
 * the file" is not evidence that a key is unset. Only an ABSENT file is that,
 * and only that case returns here — everything else throws, so the caller can
 * answer "we could not find out" instead of guessing.
 *
 * A file holding valid JSON that is not an object (`null`, a number, an array)
 * is a read failure too: `config[key]` on `null` throws a TypeError from
 * whichever route touched it next, which is a 500 with no explanation.
 */
function readConfigStrict(): Record<string, unknown> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("data/config.json does not hold a JSON object");
  }
  // A `"__proto__"` the FILE carries — a hand-edit, a restored backup of an
  // older data/ — is an own property here, because `JSON.parse` creates it as
  // one. Dropped on the way in, so the read side answers `undefined` for it
  // like any other absent key (`config[key]` would otherwise reach
  // `Object.prototype`'s getter and hand a caller the prototype object), and so
  // the next write does not re-emit it: `assertStorableKey` refuses to CREATE
  // one, and a store that already holds one must have a way back out.
  Reflect.deleteProperty(parsed, "__proto__");
  return parsed as Record<string, unknown>;
}

/**
 * The one STORE key a plain object cannot hold, and the values JSON cannot
 * write faithfully.
 *
 * Both are the same failure the value guard on `swap` was added for — a write
 * that reports success over a store that did not change the way the caller
 * believes — reached by two other routes:
 *
 *  - `config["__proto__"] = value` never creates a property. It reaches
 *    `Object.prototype`'s own accessor, which sets the object's PROTOTYPE for
 *    an object value and does nothing at all for a primitive; either way the
 *    key is absent from `JSON.stringify`'s output, so `writeConfig` renames a
 *    config without it over the one that had it and the caller is told the
 *    write landed. `swap` compounds it by reading the same accessor for its
 *    `previous`, handing the caller `Object.prototype` as the value it
 *    replaced. Refused rather than written as an own property, because a
 *    `"__proto__"` key inside data/config.json is a loaded gun for every OTHER
 *    reader of that file: `Object.assign({}, JSON.parse(raw))` and every
 *    read-modify-write built on it would take the parsed own property through
 *    a plain object's inherited setter and change that object's prototype.
 *    Nothing on the box stores a key it does not spell out as a constant, so
 *    the refusal costs no caller anything.
 *
 *  - `JSON.stringify(NaN)` is the string `"null"`, and so are `Infinity` and
 *    `-Infinity`, so a non-finite number passes the `=== undefined` test and
 *    the file ends up holding `null` under a key the caller believes holds a
 *    figure. Every reader then sees "unset" over a write that answered success
 *    — `session_generation` back to 0 invalidates every live cookie,
 *    `clawai_credential_refused_at` back to "never refused" re-arms the write
 *    the refusal exists to stop, `setup_progress_step` reopens the wizard.
 *    Checked at any depth, through `JSON.stringify`'s own walk rather than a
 *    hand-rolled one, so a cycle is reported by the serialiser that would have
 *    hit it anyway.
 *
 * The KEY half is the STORE's own key, not every key in the value: a nested
 * `"__proto__"` is part of an object the caller built and is written as it
 * stands (`JSON.parse` reads it back as an own property, so a ClawBox reader
 * sees what was stored). Only the top-level key can silently fail to land here.
 */
export function assertStorableKey(key: string): void {
  if (key === "__proto__") {
    throw new TypeError(`config-store: "${key}" cannot be a key — the object backing the store cannot hold it`);
  }
}

function assertStorableValue(key: string, value: unknown): void {
  // The WHOLE value first, because the walk below cannot see it: JSON drops a
  // top-level function or symbol entirely, and the write then RENAMES a config
  // without the key over the one that had it — `set("active_harness", () => …)`
  // deletes the harness and answers success. `swap` was saved from this only by
  // its own `JSON.stringify(value) === undefined` test, so without this the
  // three writers were not the same guard. `undefined` cannot arrive here: it
  // is the documented delete and both callers filter it out first.
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`config-store: ${key} cannot hold a ${typeof value} — JSON omits it`);
  }
  // Not an arrow: the replacer's `this` is the object or array HOLDING the
  // value, and that is what separates the two ways JSON writes `null`. An
  // OBJECT property whose value is `undefined`, a function or a symbol is
  // omitted from the file, and a reader then sees `undefined` — which is what
  // the caller stored, so nothing is misreported. The same value inside an
  // ARRAY becomes a `null` MEMBER, at any depth: the list still has its length
  // and one entry is now nothing, which is the same false success as the
  // numbers below.
  JSON.stringify(value, function (this: unknown, _field: string, held: unknown) {
    // `held instanceof Number` as well as the primitive: a boxed non-finite
    // number reaches the replacer as an OBJECT and is written as `null` just
    // the same, so the "at any depth" claim above would be half true without
    // it.
    const asNumber = typeof held === "number" ? held : held instanceof Number ? held.valueOf() : null;
    if (asNumber !== null && !Number.isFinite(asNumber)) {
      throw new TypeError(`config-store: ${key} cannot hold ${String(asNumber)} — JSON writes it as null`);
    }
    if (Array.isArray(this) && (held === undefined || typeof held === "function" || typeof held === "symbol")) {
      throw new TypeError(`config-store: ${key} cannot hold a list with a member JSON writes as null`);
    }
    return held;
  });
}

/**
 * The value the store HOLDS under `key`, never one it inherits.
 *
 * `config[key]` walks the prototype chain, so `"__proto__"` answers
 * `Object.prototype` and `"constructor"` the `Object` function — objects, under
 * a signature that says "whatever was stored", for keys the store holds
 * nothing under. Every reader here goes through this.
 */
function held(config: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(config, key) ? config[key] : undefined;
}

/** One key, tri-state: `known: false` when the store could not be read. */
export async function getKnown(key: string): Promise<{ value: unknown; known: boolean }> {
  try {
    return { value: held(readConfigStrict(), key), known: true };
  } catch (err) {
    // The message only: a JSON parse error quotes a window of the INPUT, and
    // this file holds the mailbox password and both bot tokens.
    console.error(
      "[config-store] data/config.json could not be read:",
      err instanceof Error ? err.message : err,
    );
    return { value: undefined, known: false };
  }
}

function writeConfig(data: Record<string, unknown>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // config.json holds real secrets (clawai portal token, telegram bot token).
  // Write to a fresh temp file at 0o600 then atomically rename over the target,
  // so the live config is never briefly world-readable (writeFileSync's `mode`
  // is ignored when the destination already exists, e.g. a 0644 file from an
  // older build). chmod the temp too, in case a stale temp survived a crash
  // and pre-existed at 0644 (rename would then carry those perms across).
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort; a failed chmod must not break config writes
  }
  fs.renameSync(tmp, CONFIG_PATH);
}

export async function get(key: string): Promise<unknown> {
  return held(readConfig(), key);
}

/**
 * A write reads the whole store first, so it may NOT read it forgivingly.
 *
 * `writeConfig` temp-writes and renames, which needs write permission on
 * `data/` and not on the file — so building the new object out of `readConfig()`'s
 * `{}` succeeded on a store nobody could read and REPLACED it with the one key
 * being saved. A `data/config.json` left root-owned by a `sudo` script (the same
 * provenance this module's readers now refuse to guess about) would lose the
 * mailbox password, both bot tokens, the approved-sender names and the session
 * generation the next time the owner touched any setting — reported as
 * `success: true`, one `chmod` after they were all still there.
 *
 * So a write over an unreadable store throws. ENOENT still means `{}`: a box
 * that has never saved anything is the ordinary first write.
 */
export async function set(key: string, value: unknown): Promise<void> {
  // Ahead of the read, so a write that could never land costs no file access —
  // and on the WRITE branch only, because `delete config["__proto__"]` does
  // remove an own property and is the way a store that already holds one is
  // cleaned.
  if (value !== undefined) {
    assertStorableKey(key);
    assertStorableValue(key, value);
  }
  const config = readConfigStrict();
  if (value === undefined) {
    delete config[key];
  } else {
    config[key] = value;
  }
  writeConfig(config);
}

/**
 * Set `key` and return what it held — read and written in ONE synchronous step.
 *
 * `get` then `set` is not the same thing. The `await` between them is a point
 * where another request can land its own write, and the caller then reasons
 * about a predecessor its call never actually replaced. Here the read and the
 * write are in the same event-loop turn, so no other caller IN THIS PROCESS can
 * land a config write between them. It says nothing about another process
 * writing the same file — the rename in `writeConfig` is what covers that.
 *
 * Replaces only, and REFUSES a value JSON would drop rather than treating it as
 * `set` does. `JSON.stringify` omits a key whose value is `undefined`, and a
 * function or a symbol identically, so accepting one would rename a config
 * WITHOUT the key over the one that had it — and the caller, handed the
 * predecessor and no error, would read that as the switch having been made.
 * The test is `JSON.stringify(value) === undefined`, which is the property that
 * actually matters, rather than an enumeration of the values that have it. To
 * delete a key, `set` it to `undefined`.
 *
 * The KEY half is `assertStorableKey`, shared with `set` and `setMany` because
 * `__proto__` fails identically in all three, and the non-finite numbers
 * `JSON.stringify` writes as `null` are `assertStorableValue`, shared for the
 * same reason.
 *
 * Same strict read as `set`, for the same reason: a write over a store nobody
 * can read must throw rather than replace it with the one key being saved.
 */
export async function swap(key: string, value: unknown): Promise<unknown> {
  // Ahead of the read, so a value that cannot be stored costs no file access.
  // `JSON.stringify` throws on a BigInt or a cycle, which `writeConfig` would
  // have done anyway — here it happens before anything is opened.
  if (JSON.stringify(value) === undefined) {
    throw new TypeError(`config-store: swap(${key}) replaces, it cannot delete — use set()`);
  }
  assertStorableKey(key);
  assertStorableValue(key, value);
  const config = readConfigStrict();
  const previous = held(config, key);
  config[key] = value;
  writeConfig(config);
  return previous;
}

export async function setMany(entries: Record<string, unknown>): Promise<void> {
  // The WHOLE batch, before the read: a caller handed a refusal must not find
  // half its entries applied around the one that could never land.
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    assertStorableKey(key);
    assertStorableValue(key, value);
  }
  const config = readConfigStrict();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) {
      delete config[key];
    } else {
      config[key] = value;
    }
  }
  writeConfig(config);
}

export async function getAll(): Promise<Record<string, unknown>> {
  return readConfig();
}
