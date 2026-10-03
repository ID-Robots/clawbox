/**
 * What the coding agent may publish on GitHub on its own (TASK-1366).
 *
 * When the box opens a run's pull request itself — the auto-PR switch — the
 * title, the body and the comments it posts are composed from the run's task
 * and its summary. A task is written FOR THE BOX, not for the world: it names
 * folders under the owner's home, the LAN address of a board, the owner's
 * e-mail, now and then a token they pasted. On a public repository every one
 * of those is published the moment `gh pr create` returns, and that happened on
 * ClawBox's own repository on 2026-10-02.
 *
 * So everything the box writes to GitHub by itself goes through
 * `redactForPublishing` on the way out. The RUN never does: its task, its
 * prompt and its record are untouched, and only the copy that leaves for
 * GitHub is rewritten.
 *
 * WHAT IS REPLACED, and with what:
 *   - CREDENTIALS BY SHAPE → `<redacted>`. The shapes are the shared inventory
 *     in ./incident-sanitize (`redactCredentialShapes`: `sk-…`, `ghp_…`,
 *     `github_pat_…`, `xox?-…`, `AKIA…`, JWTs, the value after `token=` or
 *     `password=`), plus what this surface adds: the value after a prefixed
 *     name (`…KEY=`, `…_TOKEN=`, `…_SECRET=`, `…_PASSWORD=`), the password in
 *     `scheme://user:password@host`, and a PEM private key.
 *   - PRIVATE ADDRESSES → `<private-ip>`: 10/8, 172.16/12, 192.168/16,
 *     100.64/10 (carrier-grade NAT, where Tailscale puts a box), fc00::/7 and
 *     fe80::/10. EXACT ranges, on purpose: a public address is nobody's secret,
 *     and `1.2.3.4` is far more often a version than a host.
 *   - HOME PATHS → `~`: `/home/<user>` and `/Users/<user>`, the box's own
 *     `/home/clawbox` included. The layout below the account is kept; the
 *     account name goes.
 *   - E-MAIL ADDRESSES → `<email>`.
 *   - HOST NAMES → `<host>`: the box's own name (passed in, see
 *     `PublishRedactionOptions.hostNames`) and any LAN name — `*.local` (mDNS),
 *     `*.lan`, `*.home.arpa`, `*.localdomain`. On most boxes the name is the
 *     owner's.
 *
 * WHAT IS KEPT is everything else, and that is the difference from the
 * incident sanitizer, which removes every address and every host: a pull
 * request names public services, versions and files as a matter of course, and
 * a body with a hole in every sentence is one nobody reviews.
 *
 * ORDER MATTERS. Credentials first, so no later rule rewrites half of a token
 * into something the token rule no longer recognises; home paths before host
 * names (`/home/<name>` is the account, and must come out as `~`, not as
 * `/home/<host>`) and before addresses (a URL's own path is not a home); e-mail
 * before host names, because an address contains one.
 *
 * Pure and free of I/O, like ./incident-sanitize, so it can be tested
 * exhaustively; the box's own names come from the caller (`redactForGitHub` in
 * ./coding-pr reads them).
 */
import { redactCredentialShapes } from "./incident-sanitize";

export const SECRET_PLACEHOLDER = "<redacted>";
export const PRIVATE_IP_PLACEHOLDER = "<private-ip>";
export const EMAIL_PLACEHOLDER = "<email>";
export const HOST_PLACEHOLDER = "<host>";

export interface PublishRedactionOptions {
  /**
   * The names this box answers to — `os.hostname()` and its first label.
   * Replaced wherever one stands as a whole word. A generic name (`clawbox`,
   * `ubuntu`, …) or one shorter than MIN_HOST_NAME_CHARS is skipped: it
   * identifies nobody, and rewriting it would punch holes in ordinary
   * sentences — "Opened by the ClawBox coding agent" on every box that kept
   * the factory name.
   */
  hostNames?: readonly string[];
}

/** A PEM private key, armour and all. One with no END line runs to the end of
 *  the text: half a key is still a key. */
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

/**
 * A long secret after a name that ends in `key`, `token` or `secret` — `key=`,
 * `SSH_KEY=`, `DEPLOY_TOKEN:`, `APP_SECRET=`. The shared inventory covers the
 * bare words (`token`, `secret`, `api_key`) on any value of six characters, but
 * only as whole words: `\btoken\b` never matches inside `DEPLOY_TOKEN`, which is
 * how a token is written in every `.env` a task quotes. These are this
 * surface's, held to a stricter value: sixteen or more characters of hex or
 * base64 with a letter AND a digit in them, so `key=codingAgent.autoPrLabel`,
 * `hotkey: Ctrl+Shift+K` and `max_token: 4096` stay the sentences they were.
 */
const KEY_VALUE_RE = /\b([A-Za-z0-9_-]*(?:key|token|secret))(\s*[=:]\s*)(["']?)([A-Za-z0-9+/_-]{16,}={0,2})\3(?![A-Za-z0-9+/_=-])/gi;

/**
 * A password after a name that ends in one — `DB_PASSWORD=`, `smtpPasswd:`,
 * `ADMIN_PWD=` — for the same whole-word reason as above. A password is not
 * long or hex, so the value is six or more characters with something other
 * than a letter in it: `dbPassword: string` is a type, not a secret. A
 * reference (`${DB_PASSWORD}`, `%PASS%`) is not one either. `pwd` only after a
 * separator: a bare `pwd:` is the shell's working directory.
 */
const PASSWORD_VALUE_RE = /\b([A-Za-z0-9_-]*(?:password|passwd|[_-]pwd))(\s*[=:]\s*)(["']?)([^\s"'`&,;)\]}<>]{6,})\3/gi;

/** The password half of `scheme://user:password@host`. The user name stays:
 *  `x-access-token` or `git` says what kind of URL it was. */
const URL_PASSWORD_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]+):([^\s/?#]+)@(?=[^\s@/?#]*(?:[\s/?#]|$))/gi;

/**
 * `/home/<user>` and `/Users/<user>`, as a path of their own — not inside a
 * URL (`https://example.com/home/…` is a route, and the character before its
 * slash is a word character) and not a folder called `home` somewhere below
 * `~`. The user name never ends in a dot, so a sentence's full stop survives.
 */
const HOME_PATH_RE = /(?<![\w.~-])\/(?:home|Users)\/[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?/g;

const EMAIL_RE = /(?<![\w.%+-])([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+([A-Za-z]{2,24}))(?![\w-])/g;

/**
 * Address-shaped strings that are not addresses. `logo@2x.png` is a retina
 * image, not a mailbox at the host `2x.png`; `git@github.com` is the user every
 * SSH remote of every forge logs in as, and names nobody.
 */
const IMAGE_TLDS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp", "tif", "tiff"]);

/**
 * Four dotted numbers standing on their own — not part of a longer dotted run
 * (`1.10.0.0.1`), not a version glued to a word (`v10.0.0.1`) or to a package
 * name (`libfoo-10.2.0.1`), not followed by a file extension
 * (`10.2.0.1.tar.gz`). A digit before a hyphen is still an address: that is
 * the second half of a range, `10.0.0.5-10.0.0.9`. The range decides the rest
 * — see isPrivateIpv4.
 */
const IPV4_RE = /(?<![\w.]|[A-Za-z]-)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\w|\.\w)/g;

/**
 * A LOOSE candidate for IPv6, judged by `isIpv6` and the range in the
 * replacer. A pattern tight enough to trust on its own is unreadable, and one
 * loose enough to stand alone matches `10:30:45` out of every timestamp. An
 * optional zone (`%eth0`) goes with the address.
 */
const IPV6_CANDIDATE_RE = /(?<![\w:])[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?:%[A-Za-z0-9_.-]+)?(?![\w:]|\.\d)/g;

/**
 * A LAN name: dotted labels ending in a suffix only a local network answers
 * for. Not when it is part of a file name — `.env.local`,
 * `settings.local.json`, `docker-compose.local.yml` — which is why neither a
 * dot before it nor a dot-and-word after it is allowed.
 */
const LAN_NAME_RE = /(?<![\w.@-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:localdomain|local|lan|home\.arpa)(?![\w-]|\.[\w-])/gi;

/** A host name shorter than this is a word, not a name worth hiding. */
const MIN_HOST_NAME_CHARS = 4;

/**
 * Names a box may carry that identify nobody: the factory name, the
 * distribution's and the board's defaults, and the placeholders' own words.
 */
const GENERIC_HOST_NAMES = new Set([
  "clawbox", "localhost", "localdomain", "ubuntu", "debian", "linux", "raspberrypi",
  "jetson", "nano", "orin", "nvidia", "desktop", "laptop", "server", "computer",
  "device", "host", "email", "redacted", "private",
]);

/** True for an IPv4 address in one of the private ranges this module hides. */
export function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return false;
  const [a, b, c, d] = parts.map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 10) return true;
  if (a === 172) return b >= 16 && b <= 31;
  if (a === 192) return b === 168;
  // 100.64.0.0/10, carrier-grade NAT: Tailscale's addresses are in it.
  if (a === 100) return b >= 64 && b <= 127;
  return false;
}

/**
 * Whether a candidate really is an IPv6 address: eight hex groups, or one `::`
 * with at most seven groups around it. `10:30:45` has three groups and no `::`,
 * so a clock survives; `aa:bb:cc:dd:ee:ff` likewise stays a MAC.
 */
function isIpv6(value: string): boolean {
  if (!/^[0-9A-Fa-f:]+$/.test(value)) return false;
  const group = /^[0-9A-Fa-f]{1,4}$/;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    return [...left, ...right].every((g) => group.test(g)) && left.length + right.length <= 7;
  }
  const groups = value.split(":");
  return groups.length === 8 && groups.every((g) => group.test(g));
}

/** True for an IPv6 address in fc00::/7 (unique local) or fe80::/10 (link-local). */
export function isPrivateIpv6(address: string): boolean {
  const bare = address.replace(/%[A-Za-z0-9_.-]+$/, "");
  if (!isIpv6(bare) || bare.startsWith("::")) return false;
  const first = parseInt(bare.split(":")[0], 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/** The replacer for one IPv6 candidate. A sentence's own colon after an
 *  address (`fe80::1: unreachable`) is given back rather than sinking it. */
function redactIpv6Candidate(match: string): string {
  if (isPrivateIpv6(match)) return PRIVATE_IP_PLACEHOLDER;
  if (match.endsWith(":") && !match.endsWith("::") && isPrivateIpv6(match.slice(0, -1))) {
    return `${PRIVATE_IP_PLACEHOLDER}:`;
  }
  return match;
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One pattern for the box's own names, longest first so a full name goes
 * before its first label. Null when none of them is worth hiding.
 */
function hostNamePattern(names: readonly string[] | undefined): RegExp | null {
  const kept = new Set<string>();
  for (const raw of names ?? []) {
    if (typeof raw !== "string") continue;
    const name = raw.trim().toLowerCase().replace(/\.$/, "");
    if (name.length < MIN_HOST_NAME_CHARS || GENERIC_HOST_NAMES.has(name)) continue;
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name)) continue;
    kept.add(name);
  }
  if (kept.size === 0) return null;
  const alternatives = [...kept].sort((a, b) => b.length - a.length).map(escapeLiteral).join("|");
  return new RegExp(`(?<![\\w.-])(?:${alternatives})(?![\\w-]|\\.[\\w-])`, "gi");
}

/**
 * Put one string through every rule. Safe on any input; never throws.
 * Idempotent: no placeholder matches a rule, so a text that has been through
 * here once comes back unchanged — which is what lets the composer and the
 * `gh` door both apply it.
 */
export function redactForPublishing(text: string, options: PublishRedactionOptions = {}): string {
  if (typeof text !== "string" || text === "") return "";
  let out = text;

  // 1. Credentials, before anything can rewrite part of one.
  out = out.replace(PRIVATE_KEY_RE, SECRET_PLACEHOLDER);
  out = redactCredentialShapes(out, SECRET_PLACEHOLDER);
  out = out.replace(KEY_VALUE_RE, (match, name: string, separator: string, quote: string, value: string) =>
    /\d/.test(value) && /[A-Za-z]/.test(value) ? `${name}${separator}${quote}${SECRET_PLACEHOLDER}${quote}` : match);
  out = out.replace(PASSWORD_VALUE_RE, (match, name: string, separator: string, quote: string, value: string) =>
    /[^A-Za-z]/.test(value) && !/^[${%]/.test(value) ? `${name}${separator}${quote}${SECRET_PLACEHOLDER}${quote}` : match);
  out = out.replace(URL_PASSWORD_RE, (match, prefix: string, password: string) =>
    password === SECRET_PLACEHOLDER ? match : `${prefix}:${SECRET_PLACEHOLDER}@`);

  // 2. Home paths: the account name is the owner.
  out = out.replace(HOME_PATH_RE, "~");

  // 3. E-mail, before host names: an address contains one.
  out = out.replace(EMAIL_RE, (match, local: string, _domain: string, tld: string) =>
    IMAGE_TLDS.has(tld.toLowerCase()) || local.toLowerCase() === "git" ? match : EMAIL_PLACEHOLDER);

  // 4. Private addresses, exact ranges only.
  out = out.replace(IPV6_CANDIDATE_RE, redactIpv6Candidate);
  out = out.replace(IPV4_RE, (match) => (isPrivateIpv4(match) ? PRIVATE_IP_PLACEHOLDER : match));

  // 5. LAN names, then the box's own.
  out = out.replace(LAN_NAME_RE, HOST_PLACEHOLDER);
  const own = hostNamePattern(options.hostNames);
  if (own) out = out.replace(own, HOST_PLACEHOLDER);

  return out;
}
