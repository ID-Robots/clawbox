/**
 * The rules of the webapp legacy-storage layer, shared by the server (the
 * one-shot migration in webapp-legacy-storage-migration.ts, the runtime in
 * webapp-legacy-storage.ts) and the desktop (the browser import in
 * webapp-legacy-browser-import.ts). Pure and dependency-free, so both sides
 * answer every question the same way.
 *
 * WHY THIS EXISTS. Until v4.0 the desktop framed a webapp WITH
 * `allow-same-origin`: the app ran on the ClawBox origin with the owner's
 * session, and the storage guide told it to `fetch('/setup-api/kv')` with keys
 * "namespaced with your app id" — which the agent spelled however it liked
 * (`todo:items` for an app whose id is `todo-list`, a bare `settings`), or it
 * used the origin's `localStorage`. v4.0 (c5aa17d2) boxed every webapp into an
 * opaque origin, which is right, and gave it a postMessage KV bridge that
 * serves only `<appId>:` keys — but moved nothing. Every such app then opened
 * on empty storage with no error: its data was still in data/kv.json (or the
 * browser's storage for the ClawBox origin), out of its reach.
 *
 * THE CANONICAL LOCATION of everything a webapp stores is its own KV
 * namespace, `<appId>:`. A legacy key keeps the name the app uses for it and is
 * stored under that namespace (`legacyKvStorageKey`); a key the app already
 * wrote as `<appId>:…` is left exactly where it is, so the common case moves
 * nothing at all. What the app kept in `localStorage` lives under
 * `<appId>:localStorage:` beside it.
 *
 * WHICH OLD DATA IS WHOSE is the one question the old layout cannot answer by
 * itself: every app shared one origin and one store. The answer used here is
 * the app's OWN CODE — a stored key belongs to an app when a string literal in
 * that app names it (`isAttributedKey`). Never a key ClawBox itself owns
 * (`isClawboxOwnedStorageKey`: the desktop's state, the OpenClaw Control UI's
 * gateway token, the device identity), and never another installed app's own
 * namespace. Old data is only ever COPIED: the original stays where it was.
 */

/** The route every pre-v4.0 webapp was told to store its data through. */
export const LEGACY_KV_PATH = "/setup-api/kv";

/** The v3.9 KV route's own key rule, and the size of one value — both unchanged since. */
export const LEGACY_KV_SAFE_KEY = /^[\w.:-]{1,256}$/;
export const LEGACY_KV_MAX_VALUE_BYTES = 256 * 1024;
export const LEGACY_KV_MAX_ENTRIES = 500;
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Whether a key is one the v3.9 route accepted. */
export function isValidLegacyKvKey(key: unknown): key is string {
  return typeof key === "string" && LEGACY_KV_SAFE_KEY.test(key) && !RESERVED_OBJECT_KEYS.has(key);
}

/** UTF-8 length, without Buffer (this module also runs in the browser). */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Which of the old storage APIs a document's code uses. Deliberately loose — a
 * mention is enough: all this decides is whether the compatibility layer is
 * put in front of the app, and that layer only ever reaches the app's own
 * namespace.
 */
export function detectLegacyStorageApis(code: string): { kv: boolean; localStorage: boolean } {
  return {
    kv: /\/setup-api\/kv(?![\w-])/.test(code),
    localStorage: /\b(?:localStorage|sessionStorage)\b/.test(code),
  };
}

/**
 * Keys that belong to ClawBox (or to a UI it serves on the same origin), never
 * to a webapp: the desktop's own state (`clawbox…`, `clawai_tier_seen`), the
 * owner-notice ring (`ui:`), the OpenClaw Control UI's settings — which carry
 * the gateway token — and Hermes'. Neither the migration nor the browser import
 * copies one into an app, whatever the app's code names.
 */
export function isClawboxOwnedStorageKey(key: string): boolean {
  return /^(?:clawbox|clawai|openclaw|hermes)/i.test(key) || key.startsWith("ui:") || RESERVED_OBJECT_KEYS.has(key);
}

/** The namespace a colon-separated key lives under, or null for a bare key. */
export function keyNamespace(key: string): string | null {
  const colon = key.indexOf(":");
  return colon > 0 ? key.slice(0, colon) : null;
}

/**
 * Whether a key sits in ANOTHER installed app's own namespace. The storage
 * guide's rule was "namespace every key with your app id", so `notes:…` is the
 * `notes` app's whatever a different app's code happens to mention.
 */
export function belongsToAnotherApp(key: string, appId: string, appIds: ReadonlySet<string>): boolean {
  const ns = keyNamespace(key);
  return ns !== null && ns !== appId && appIds.has(ns);
}

const MAX_TOKEN_LENGTH = 256;
/** How many distinct tokens one app's code may contribute. */
export const MAX_TOKENS = 20_000;
/** How far an unclosed template literal is followed before it is given up on. */
const MAX_TEMPLATE_SCAN = 64 * 1024;

/**
 * Every quoted run in `code`, in one linear pass. A regex cannot do this
 * safely: an unclosed quote in a long minified line sends a backtracking
 * pattern to the end of the line from every quote after it, and a pattern
 * bounded to stay fast mis-pairs every quote after the first long string.
 * `'` and `"` end at a line break when unclosed (so the scan resumes there);
 * a template literal may span lines and is followed at most MAX_TEMPLATE_SCAN.
 */
function* stringLiterals(code: string): Generator<{ quote: string; text: string; escaped: boolean }> {
  const n = code.length;
  let i = 0;
  while (i < n) {
    const quote = code[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      i++;
      continue;
    }
    const limit = quote === "`" ? Math.min(n, i + 1 + MAX_TEMPLATE_SCAN) : n;
    let j = i + 1;
    let escaped = false;
    let closed = false;
    while (j < limit) {
      const c = code[j];
      if (c === "\\") {
        escaped = true;
        j += 2;
        continue;
      }
      if (c === quote) {
        closed = true;
        break;
      }
      if (quote !== "`" && (c === "\n" || c === "\r")) break;
      j++;
    }
    if (closed) {
      yield { quote, text: code.slice(i + 1, j), escaped };
      i = j + 1;
    } else {
      i = quote === "`" ? i + 1 : Math.max(j, i + 1);
    }
  }
}

/**
 * The string literals in an app's code, as the tokens `isAttributedKey` matches
 * stored keys against: each literal's text; for a template literal, the static
 * text before its first `${`; and for a literal that is a URL with `key=` or
 * `prefix=` in its query, the value of each (so `'/setup-api/kv?key=todo:items'`
 * names `todo:items`). A literal with an escape in it is left out rather than
 * guessed at; so is one that could name nothing (one character, or longer than
 * a KV key can be).
 *
 * HTML attribute values and prose between two apostrophes come out as tokens
 * too. That is harmless: a token only matters when a stored key matches it.
 */
export function extractStringTokens(code: string, max = MAX_TOKENS): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    if (out.size >= max) return;
    if (raw.length < 2 || raw.length > MAX_TOKEN_LENGTH) return;
    out.add(raw);
  };
  for (const literal of stringLiterals(code)) {
    if (out.size >= max) break;
    if (literal.escaped) continue;
    let text = literal.text;
    if (literal.quote === "`") {
      const hole = text.indexOf("${");
      if (hole !== -1) text = text.slice(0, hole);
    }
    add(text);
    if (/[?&](?:key|prefix)=/.test(text)) {
      for (const part of text.split(/[?&]/)) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        const name = part.slice(0, eq);
        if (name !== "key" && name !== "prefix") continue;
        let value = part.slice(eq + 1);
        try {
          value = decodeURIComponent(value);
        } catch {
          // A malformed escape: the raw text is still the best guess.
        }
        add(value);
      }
    }
  }
  return [...out];
}

/** Characters that end a key PREFIX an app builds keys from (`'todo-' + id`). */
const PREFIX_SEPARATORS = ":-_./";

/**
 * Whether an app's code names this stored key, by one of three shapes:
 *
 *  - the whole key as a literal: `'todo:items'`, `'pomodoro-settings'`;
 *  - a literal PREFIX of it that ends in a separator, three characters or more:
 *    `'todo:'`, `` `todo-${id}` ``;
 *  - the key's colon namespace as a literal: `const NS = 'todo'` with keys
 *    built as `NS + ':items'` — the storage guide's own pattern.
 *
 * Anything a legacy app built without a literal (a key read from user input)
 * is not attributed, and stays exactly where it is.
 */
export function isAttributedKey(key: string, tokens: ReadonlySet<string>): boolean {
  if (key.length < 2) return false;
  if (tokens.has(key)) return true;
  for (let i = 2; i < key.length - 1; i++) {
    if (PREFIX_SEPARATORS.includes(key[i]) && tokens.has(key.slice(0, i + 1))) return true;
  }
  const colon = key.indexOf(":");
  return colon >= 2 && tokens.has(key.slice(0, colon));
}

/**
 * Where a key a legacy app names lives: under the app's own namespace. A key
 * the app already namespaced with its own id is taken as is — the same rule the
 * KV bridge applies (`webappKvKey`), so an app later rebuilt on
 * `window.clawboxKv` finds those keys under the same names — and any other key,
 * bare or carrying a different prefix, is nested under `<appId>:`.
 */
export function legacyKvStorageKey(appId: string, key: string): string {
  return key.startsWith(`${appId}:`) ? key : `${appId}:${key}`;
}

const LOCAL_STORAGE_NS = "localStorage";
const LOCAL_STORAGE_B64_NS = "localStorage64";
const LOCAL_STORAGE_PLAIN_KEY = /^[\w.:-]+$/;

/** Whether a stored key is one the localStorage layer keeps for this app. */
export function isLocalStorageKvKey(appId: string, storedKey: string): boolean {
  return storedKey.startsWith(`${appId}:${LOCAL_STORAGE_NS}:`) || storedKey.startsWith(`${appId}:${LOCAL_STORAGE_B64_NS}:`);
}

/**
 * The names a legacy app may know one of its stored keys by — the inverse of
 * `legacyKvStorageKey`, which is two-to-one: `<appId>:items` is where both
 * `items` and `<appId>:items` live. A listing answers each name that matches
 * the prefix asked for.
 */
export function legacyKvNames(appId: string, storedKey: string): string[] {
  const own = `${appId}:`;
  if (!storedKey.startsWith(own) || storedKey.length === own.length) return [];
  return [storedKey, storedKey.slice(own.length)];
}

/**
 * What a legacy app's `GET /setup-api/kv?prefix=` (or with no prefix) answers,
 * built from the app's own namespace only. The localStorage layer's keys are
 * not the app's KV data and are left out.
 */
export function legacyKvListing(appId: string, data: Readonly<Record<string, string>>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [storedKey, value] of Object.entries(data)) {
    if (isLocalStorageKvKey(appId, storedKey)) continue;
    for (const name of legacyKvNames(appId, storedKey)) {
      if (name.startsWith(prefix)) out[name] = value;
    }
  }
  return out;
}

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string | null {
  try {
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The KV key a legacy app's `localStorage` key is kept under, or null when it
 * cannot be one (the KV store's keys are at most 256 characters). A key the KV
 * alphabet can spell is kept readable; anything else — a space, a slash,
 * non-ASCII — is base64url-encoded under a sibling namespace, so the two can
 * never collide.
 */
export function localStorageKvKey(appId: string, key: string): string | null {
  if (key.length === 0) return null;
  const stored = LOCAL_STORAGE_PLAIN_KEY.test(key)
    ? `${appId}:${LOCAL_STORAGE_NS}:${key}`
    : `${appId}:${LOCAL_STORAGE_B64_NS}:${toBase64Url(key)}`;
  return LEGACY_KV_SAFE_KEY.test(stored) ? stored : null;
}

/** The `localStorage` key a stored key holds, or null when it is not one of this app's. */
export function localStorageKeyFromKv(appId: string, storedKey: string): string | null {
  const plain = `${appId}:${LOCAL_STORAGE_NS}:`;
  if (storedKey.startsWith(plain)) return storedKey.slice(plain.length) || null;
  const encoded = `${appId}:${LOCAL_STORAGE_B64_NS}:`;
  if (storedKey.startsWith(encoded)) return fromBase64Url(storedKey.slice(encoded.length));
  return null;
}
