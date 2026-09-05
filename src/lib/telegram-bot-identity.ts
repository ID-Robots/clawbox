// Which Telegram bot does THIS box poll?
//
// One question, and on BOTH editions the answer belongs to the harness. ClawBox's
// own `telegram_bot_token` is a MIRROR that /setup-api/telegram/configure happens
// to write beside the real thing — never the authority:
//
//   * OpenClaw — `setTelegramToken()` writes `channels.telegram.botToken` into
//     ~/.openclaw/openclaw.json, and the gateway long-polls from there.
//   * Hermes — `hermes config set TELEGRAM_BOT_TOKEN` writes ~/.hermes/.env (the
//     path `hermes config env-path` prints), and the gateway resolves it through
//     its own env bridge: .env first, then ~/.hermes/config.yaml's top-level
//     scalars for keys .env does not define. See readHermesTelegramToken.
//
// So a box configured through the harness's own CLI — or restored with the
// harness's home intact but a fresh ClawBox data/config.json — has a working bot
// and no mirror at all. Asking the mirror then answered "this box has no bot",
// which made the email-approval same-bot guard fail OPEN, told the setup wizard
// to re-offer a step for a bot that already works, and let a bot change slip past
// the pairing reset.
//
// HARNESS GAP, stated rather than worked around: neither harness has a bot-
// IDENTITY command. Hermes' `hermes send --list telegram --json` answers the
// approved CHAT ids, not the bot; OpenClaw's channel block is the config itself.
// The credential is therefore the only native answer, and the bot id is read off
// Telegram's own `<bot id>:<secret>` token shape.
//
// Both answers are TRI-STATE. "This box has no bot" and "we could not find out"
// are different facts: a panel may render the first, and only the second is
// allowed to make a save gate refuse.

import { get as configGet } from "@/lib/config-store";
import { getActiveHarness, getEdition, getEditionSource, type Harness } from "@/lib/harness";
import { readHermesTelegramToken } from "@/lib/hermes-telegram";
import { readConfigStrict, type OpenClawConfig } from "@/lib/openclaw-config";

/**
 * Telegram tokens are `<bot id>:<secret>`. The id is the BOT; the secret is one
 * credential for it, and /revoke issues another. Two tokens that differ only in
 * the secret address the same `getUpdates` stream, so identity comparisons have
 * to be made on the id — comparing whole tokens reports a rotated credential as
 * a different bot and lets two pollers collide.
 */
const BOT_TOKEN_RE = /^(\d{1,20}):[A-Za-z0-9_-]{1,200}$/;

/** The bot id inside a token, or null when the value is not one. */
export function telegramBotId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const matched = BOT_TOKEN_RE.exec(raw.trim());
  return matched ? matched[1] : null;
}

/**
 * A stored value, accepted only if it could address a bot.
 *
 * Both harness stores hold more than ClawBox put there: ~/.hermes/.env is
 * generated from Hermes' own ~25 KB template of key hints, and openclaw.json is
 * equally open to `openclaw config set` and a text editor. A placeholder or a
 * half-pasted token cannot reach Telegram, so reporting it as a configured bot
 * would end the setup wizard over nothing — and it is this function that keeps
 * every token leaving this module safe to interpolate into an api.telegram.org
 * path.
 *
 * ClawBox's own mirror goes through it too. The configure route validates the
 * shape on the way IN, but data/config.json is owned and writable by the
 * clawbox user — SSH, the in-UI terminal, the agent's run_command, a partial
 * restore — so "our writer validates it" is not a property of the file. It also
 * has to: the guard already filtered the mirror and the panels did not, which is
 * two answers to the one question this module exists to make one.
 */
function botTokenOrNull(raw: unknown): string | null {
  return typeof raw === "string" && telegramBotId(raw) !== null ? raw.trim() : null;
}

/** One store's answer: the bot it holds, and whether it could be read at all. */
interface StoredBot {
  token: string | null;
  known: boolean;
}

export type ActiveTelegramBot = StoredBot;

/**
 * ClawBox's own mirror of the token. Never the authority; often the only copy.
 *
 * `snapshot` is for a caller that has ALREADY read ClawBox's config store in
 * this request — `/setup-api/setup/status` holds a `getAll()` on a 3 s poll —
 * so the answer comes out of the copy it is already rendering from rather than
 * out of a second synchronous read of the same file, which could also disagree
 * with it.
 */
async function clawboxMirror(snapshot?: Record<string, unknown>): Promise<string | null> {
  return botTokenOrNull(snapshot ? snapshot.telegram_bot_token : await configGet("telegram_bot_token"));
}

type OpenClawChannel = NonNullable<OpenClawConfig["channels"]>[string];

/**
 * OpenClaw's own credential, out of the channel block its gateway polls from.
 *
 * `readConfigStrict` and not `readConfig`: the plain reader answers `{}` to a
 * missing file and to an EACCES alike, which is the fail-open that put this
 * whole class of bug in the tree. Strict lets only ENOENT mean "nothing is
 * configured" and raises everything else, so `known` can be honest.
 */
async function openclawStoredBot(): Promise<StoredBot> {
  let channel: OpenClawChannel | undefined;
  try {
    channel = (await readConfigStrict()).channels?.telegram;
  } catch (err) {
    // The MESSAGE, not the error. `OpenclawConfigUnreadableError` carries the
    // original on `cause`, and V8's JSON parse errors quote a window of the
    // INPUT — a corruption landing next to `"botToken":"…"` would print token
    // characters into the service log. The message alone already names what
    // happened, which is the whole of what support needs.
    console.error(
      "[telegram] openclaw.json could not be read; the bot it holds is unknown:",
      err instanceof Error ? err.message : err,
    );
    return { token: null, known: false };
  }
  const token = botTokenOrNull(channel?.botToken);
  if (token !== null) return { token, known: true };
  // A channel can carry its credential as an env REFERENCE instead of a literal
  // — `token: {source:"env", provider, id}`, the form Discord uses (see
  // envSecretRef in openclaw-config.ts) — and Telegram accepts the same shape
  // from `openclaw config set` or the control UI. Resolving it would mean
  // reading the gateway's process environment, which this module cannot do; but
  // "there is a bot here and we cannot name it" is exactly what the third state
  // is for, and it is the opposite of the confident "no bot" that let the guard
  // wave the harness's own bot through.
  if (channel?.token !== undefined) return { token: null, known: false };
  return { token: null, known: true };
}

/** Hermes' own credential, out of the env file the harness itself names. */
async function hermesStoredBot(): Promise<StoredBot> {
  const hermes = await readHermesTelegramToken();
  return { token: botTokenOrNull(hermes.token), known: hermes.known };
}

/** The store the given harness keeps its Telegram credential in. */
function storeFor(harness: Harness): () => Promise<StoredBot> {
  return harness === "hermes" ? hermesStoredBot : openclawStoredBot;
}

/**
 * Which harnesses does the edition lock say are INSTALLED — not which one is
 * selected. `dual` ships both, licensed switcher or not: the licence gates the
 * SWITCHER, not the install.
 *
 * Read per call, never cached: `readEdition()` keys its own memo on the lock
 * file's mtime, so this is not a capability probed once and believed for the
 * life of the process. This answer decides one thing only: whether an
 * UNREADABLE store is allowed to make the whole answer unknown. It never
 * decides which stores to read — see readTelegramBotsInUse.
 *
 * A DEFAULTED edition counts as both. `readEdition()` swallows every failure
 * reading /etc/clawbox/edition.env and, with no `CLAWBOX_EDITION` either, falls
 * through to "openclaw" — a default chosen for "which SKU is this", where the
 * non-premium guess is the safe way to be wrong, and exactly the wrong one
 * here. A Hermes box with a missing lock (a pre-3.x install, a partial image, a
 * provisioning step that has not run) would otherwise have had its own
 * unreadable ~/.hermes/.env discarded as "not installed" and the guard wave the
 * box's own bot through — the fail-open this module exists to close, one layer
 * below itself. A device that really IS OpenClaw has a lock, so the flagship
 * 503 hazard the gate protects against stays closed.
 */
function installedHarnesses(): Harness[] {
  const { edition, defaulted } = getEditionSource();
  if (defaulted || edition === "dual") return ["openclaw", "hermes"];
  return [edition];
}

/**
 * The bot the ACTIVE harness chats with — the question a status panel asks.
 *
 * The harness's own store wins; ClawBox's mirror is consulted only when that
 * store holds nothing or could not be read, so a panel degrades to the old
 * answer rather than reporting a working bot as gone. `known` still says which
 * of the two it was.
 *
 * `harness` is optional so a caller that has already resolved it does not pay
 * for a second lookup.
 */
export async function readActiveTelegramBot(
  harness?: Harness,
  clawboxConfig?: Record<string, unknown>,
): Promise<ActiveTelegramBot> {
  const active = harness ?? (await getActiveHarness());
  const stored = await storeFor(active)();
  if (stored.token) return stored;
  // The mirror is one value for the whole box, and on `dual` the configure
  // route writes it for whichever harness was active at the time — so after a
  // switch it names a bot the now-active harness does not hold, and answering
  // with it would report a working bot on a harness that has none. There is no
  // legacy box to protect on that SKU, which is where the fallback earns its
  // place: an OpenClaw box configured before the channel block existed.
  if (getEdition() === "dual") return stored;
  return { token: await clawboxMirror(clawboxConfig), known: stored.known };
}

/** Every bot this box could be long-polling, by bot id. */
export interface TelegramBotsInUse {
  ids: string[];
  /** False when a store that might hold a bot could not be read. */
  known: boolean;
}

/**
 * Which bots is ANY INSTALLED harness on this box polling — the question the
 * email-approval same-bot guard asks, and a different one from the panel's.
 *
 * Every installed harness's store is read, not just the active one's. On the
 * `dual` SKU both harnesses are installed and the active one is a runtime
 * toggle, so openclaw.json and ~/.hermes/.env can name DIFFERENT bots:
 * approving the inactive harness's bot as the approvals bot would be a
 * collision that arrives the moment the owner switches back.
 *
 * The edition lock decides only which of them may make the answer UNKNOWN, and
 * it has to: a root-owned or otherwise unreadable stray ~/.hermes/.env on an
 * OpenClaw box — from a dual base image, or a provisioning step run as root —
 * would otherwise make `known` false for good, and every approvals-bot save
 * answer 503 on the flagship SKU with no remedy the owner could reach. It does
 * NOT decide which stores to READ: the lock file can be missing (a pre-3.x
 * install, a partial image) and `readEdition()` then quietly answers
 * "openclaw", which would have skipped a real Hermes bot and reopened the very
 * fail-open this guard exists to close.
 *
 * ClawBox's mirror is included too. It is never the authority, but it costs one
 * read and it is the only trace left of a bot whose harness store this box
 * cannot currently read.
 *
 * THE COST OF INCLUDING IT, stated because nothing in the UI says it. The
 * mirror has exactly one writer — /setup-api/telegram/configure — and no
 * deleter: `DELETE /setup-api/email/chat-approval` clears the approval keys and
 * leaves it alone. So on a box whose harness has since been re-pointed out of
 * band, the mirror names a bot nothing polls any more and this set refuses that
 * bot as the approvals bot for good. The owner's only way out is to save a
 * different MAIN token first, which overwrites the mirror. That is the right
 * trade — the mirror is the only trace left of a bot whose harness store cannot
 * be read, and the cost of being wrong the other way is the household's own
 * Telegram chat going deaf — but it is a trade, not a free check.
 */
export async function readTelegramBotsInUse(): Promise<TelegramBotsInUse> {
  const [openclaw, hermes, mirror] = await Promise.all([
    openclawStoredBot(),
    hermesStoredBot(),
    clawboxMirror(),
  ]);
  const stores: Record<Harness, StoredBot> = { openclaw, hermes };
  const ids = new Set<string>();
  for (const token of [openclaw.token, hermes.token, mirror]) {
    const id = telegramBotId(token);
    if (id !== null) ids.add(id);
  }
  // Every store is READ, whatever the edition says, because a token sitting in
  // one is a bot this device holds and refusing it costs the owner nothing but
  // a second bot. Only `known` is gated: a store belonging to a harness the
  // lock says is not installed may not make the answer unknowable.
  return { ids: [...ids], known: installedHarnesses().every((harness) => stores[harness].known) };
}
