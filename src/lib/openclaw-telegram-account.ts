// Which of OpenClaw's Telegram accounts is THE bot this box chats as — and who
// that account lets in.
//
// OpenClaw's Telegram channel comes in two shapes. Single-account keeps the
// credential at the channel root, `channels.telegram.botToken`, which is what
// ClawBox's own setTelegramToken() writes. Multi-account keeps one per account,
// `channels.telegram.accounts.<id>.botToken`, and `openclaw channels add` moves
// the root's values into that map the moment a second account is added — so on
// such a box the root holds no credential at all. A reader that only looked at
// the root answered "no bot" for a bot that works: the coding-agent notice was
// never sent, and the approvals guard waved the box's own bot through.
//
// Pure: nothing here reads a file. telegram-bot-identity.ts asks which account
// holds the bot and openclaw-config.ts asks whose approvals to read; both have
// to get their answer from the same rule, and this is it.

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

/** OpenClaw's id for a single-account channel, and the id its pairing store files that account under. */
export const DEFAULT_TELEGRAM_ACCOUNT = "default";

type Block = Record<string, unknown>;

function isBlock(value: unknown): value is Block {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Account ids the way OpenClaw keys them, and its pairing store with them (openclaw-state-store.ts). */
function accountId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return id || null;
}

/** `${VAR}` substitution, which OpenClaw resolves at load time; `$${VAR}` is its escape for a literal. */
const ENV_SUBSTITUTION_RE = /(?:^|[^$])\$\{[A-Z_][A-Z0-9_]*\}/;

/**
 * A credential that is there but is not a literal this side can read: a
 * SecretRef in `botToken` (`{source, provider, id}`, the shape OpenClaw's own
 * schema gives the key), a `${VAR}` substitution, or a reference under `token`.
 * Resolving any of them means the gateway's environment or secret store, which
 * the web server cannot see — so the honest answer is "a bot we cannot name".
 * `token: null` and `token: ""` are a CLEARED reference, which is what the
 * control UI writes (the installers read them the same way): no bot at all.
 */
export function holdsTelegramCredentialReference(block: unknown): boolean {
  if (!isBlock(block)) return false;
  const { botToken, token } = block;
  if (isBlock(botToken)) return true;
  if (typeof botToken === "string" && ENV_SUBSTITUTION_RE.test(botToken)) return true;
  return token !== undefined && token !== null && token !== "";
}

function holdsLiteralBot(block: Block): boolean {
  return telegramBotId(block.botToken) !== null;
}

export interface TelegramAccount {
  /** OpenClaw's account id, as its pairing store keys it. */
  id: string;
  /** The block that holds the account's credential and its own access settings. */
  block: Block;
}

/** Every `accounts.<id>` block, by normalised id, sorted — the order OpenClaw falls back through. */
function namedAccounts(root: Block): TelegramAccount[] {
  if (!isBlock(root.accounts)) return [];
  const accounts: TelegramAccount[] = [];
  for (const [key, block] of Object.entries(root.accounts)) {
    const id = accountId(key);
    if (id === null || !isBlock(block) || accounts.some((account) => account.id === id)) continue;
    accounts.push({ id, block });
  }
  return accounts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The account that is "this box's bot".
 *
 * The channel root's own credential, when it has one, is the default account's
 * — the single-account shape every ClawBox writer produces, answered exactly as
 * before. Only when the root holds none do the accounts decide, in OpenClaw's
 * own precedence: `defaultAccount` when it names a configured account, else the
 * account literally called `default`, else the first account (sorted) whose
 * token could reach Telegram. A box whose accounts hold only references gets the
 * first of those, so the caller can say "there is a bot we cannot name" instead
 * of "there is none"; a box with no credential anywhere gets OpenClaw's own
 * fallback, the first account.
 */
export function defaultTelegramAccount(channel: unknown): TelegramAccount {
  const root = isBlock(channel) ? channel : {};
  const accounts = namedAccounts(root);
  if (accounts.length === 0 || holdsLiteralBot(root) || holdsTelegramCredentialReference(root)) {
    return { id: DEFAULT_TELEGRAM_ACCOUNT, block: root };
  }
  const preferred = accountId(root.defaultAccount);
  return (
    accounts.find((account) => account.id === preferred) ??
    accounts.find((account) => account.id === DEFAULT_TELEGRAM_ACCOUNT) ??
    accounts.find((account) => holdsLiteralBot(account.block)) ??
    accounts.find((account) => holdsTelegramCredentialReference(account.block)) ??
    accounts[0]
  );
}

/**
 * Every block that could hold a bot OpenClaw polls: the root and each account.
 * The default account is one question; "which bots does this box hold" is
 * another, and a second account's bot is as much in use as the first's.
 */
export function telegramCredentialBlocks(channel: unknown): Block[] {
  const root = isBlock(channel) ? channel : {};
  return [root, ...namedAccounts(root).map((account) => account.block)];
}

/** Prefixes OpenClaw accepts on an `allowFrom` entry and strips. */
const SENDER_PREFIX_RE = /^(?:telegram|tg):/i;
/** A Telegram USER id — `allowFrom` holds people, never groups (negative ids) or `*`. */
const SENDER_ID_RE = /^\d{1,20}$/;

/**
 * The sender ids an account's config `allowFrom` lets in: the account's own
 * list when it sets one, else the channel root's, which is how OpenClaw
 * inherits it. Only numeric ids — `*`, usernames and every other shape name no
 * one a message could be addressed to.
 */
export function telegramAccountAllowFrom(channel: unknown, account: string): string[] {
  const root = isBlock(channel) ? channel : {};
  const id = accountId(account) ?? DEFAULT_TELEGRAM_ACCOUNT;
  const own = namedAccounts(root).find((candidate) => candidate.id === id)?.block.allowFrom;
  const list = Array.isArray(own) ? own : root.allowFrom;
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) {
    const raw =
      typeof entry === "number" && Number.isSafeInteger(entry)
        ? String(entry)
        : typeof entry === "string"
          ? entry.trim().replace(SENDER_PREFIX_RE, "")
          : "";
    if (SENDER_ID_RE.test(raw) && !ids.includes(raw)) ids.push(raw);
  }
  return ids;
}
