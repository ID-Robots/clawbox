// ClawBox users other than the owner — TASK-1256 (multi-user ClawBox OS).
//
// Every ClawBox user is a real Linux account. The owner is the install user
// (`getSystemUsername()`), is never stored here and is never removable; every
// OTHER user is one entry in data/config.json's `clawbox_users` (the shape and
// the cookie rule live in src/lib/session-identity.ts) AND one account in the
// `clawbox-users` group that install.sh's `user_add` step created.
//
// The privileged halves go through root-owned code the web server cannot
// rewrite, never through a shell, and never with the caller's input on a
// command line:
//
//   create   → the `user_add` root step (the existing launcher →
//              clawbox-root-update@user_add.service → install.sh), fed one
//              `user:password` record through a 0600 file, exactly as
//              `chpasswd` is. It runs `useradd` and then `chpasswd`.
//   remove   → the `user_remove` root step, fed the username the same way.
//   sign in  → `sudo -n clawbox-user-helper.sh verify`, fed the username and
//              password on STDIN; the helper runs unix_chkpwd as root, which
//              the web server cannot do for any account but its own. It
//              answers only for members of `clawbox-users`, so it is not an
//              oracle for root's or the owner's password.
//
// On an x64 PC both steps are the root dispatcher's own
// (scripts/x64-migration/clawbox-x64-root-step.sh, behind its launcher's
// WEB_ROOT_STEPS), and the helper and its grant come from
// `install-x64.sh --step root_step_contract`. A failure says WHY — the
// launcher's refusal with its repair command, or the step's own "Error:" line
// — and never only "could not be created".

import { execFile as execFileCb, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs/promises";
import { promisify } from "util";
import path from "@/lib/runtime-path";
import { DATA_DIR, get, set } from "@/lib/config-store";
import { getSystemUsername, isSafePasswordChars } from "@/lib/auth";
import { DISPATCH_VERDICT_LINE, rootStepJournalArgs } from "@/lib/root-step-journal";
import { rootStepRepairCommand, startRootStep } from "@/lib/root-step-runner";
import { createSerialLock } from "@/lib/serial-lock";
import { USERS_CONFIG_KEY, parseUserRegistry, type ClawboxUserRecord } from "@/lib/session-identity";
import { checkUsername, USER_PASSWORD_MAX, USER_PASSWORD_MIN } from "@/lib/username-rules";
import { removeDesktopState } from "@/lib/desktop-state-store";

const execFile = promisify(execFileCb);

/** Installed by install.sh::install_root_libexec, root:root 0755, granted in config/clawbox-sudoers. */
export const USER_HELPER = "/usr/local/libexec/clawbox/clawbox-user-helper.sh";
/** Root steps behind Settings → Users. Keep aligned with install.sh step_user_add / step_user_remove. */
export const USER_ADD_STEP = "user_add";
export const USER_REMOVE_STEP = "user_remove";
/** Where each step reads its one record. install.sh names the same two paths. */
export const USER_ADD_INPUT_PATH = path.join(DATA_DIR, ".user-add-input");
export const USER_REMOVE_INPUT_PATH = path.join(DATA_DIR, ".user-remove-input");

const GETENT_BIN = "/usr/bin/getent";
/** getent(1): 0 = found, 2 = no such key. Anything else means the lookup itself failed. */
const GETENT_NOT_FOUND = 2;
/** unix_chkpwd / the helper: 0 = the password is right, 7 (PAM_AUTH_ERR) = it is not. */
const HELPER_OK = 0;
const HELPER_AUTH_ERR = 7;

export type UserAdminErrorCode =
  | "invalid_username"
  | "reserved_username"
  | "user_exists"
  | "account_check_failed"
  | "invalid_password"
  | "password_rejected"
  | "root_step_unavailable"
  | "create_timeout"
  | "create_failed"
  | "not_found"
  | "cannot_remove_owner"
  | "cannot_remove_self"
  | "remove_timeout"
  | "remove_failed";

const STATUS: Record<UserAdminErrorCode, number> = {
  invalid_username: 400,
  reserved_username: 400,
  user_exists: 409,
  account_check_failed: 503,
  invalid_password: 400,
  password_rejected: 400,
  root_step_unavailable: 503,
  create_timeout: 504,
  create_failed: 500,
  not_found: 404,
  cannot_remove_owner: 400,
  cannot_remove_self: 400,
  remove_timeout: 504,
  remove_failed: 500,
};

export class UserAdminError extends Error {
  readonly code: UserAdminErrorCode;
  readonly status: number;
  /** What the box itself said (the root step's "Error:" line), never a secret. */
  readonly detail?: string;
  /** The one Terminal command that repairs the box's root side, for `root_step_unavailable`. */
  readonly repairCommand?: string;
  constructor(code: UserAdminErrorCode, message: string, extra: { detail?: string; repairCommand?: string } = {}) {
    super(message);
    this.name = "UserAdminError";
    this.code = code;
    this.status = STATUS[code];
    if (extra.detail) this.detail = extra.detail;
    if (extra.repairCommand) this.repairCommand = extra.repairCommand;
  }
}

/** How much of the step's journal is read for its reason: the step prints one "Error:" line and exits. */
const STEP_JOURNAL_LINES = 80;
/** A reason longer than this is cut: it is one line under a form, not a log viewer. */
const DETAIL_MAX = 300;

/**
 * The root step's own reason for failing, out of THIS run's journal — the
 * last "Error: …" line user_add / user_remove printed (install.sh on the
 * appliance, scripts/x64-migration/clawbox-x64-root-step.sh on an x64 PC).
 * `null` when the journal says nothing usable or cannot be read (the web
 * server's account is not in a journal-reading group).
 */
export async function rootStepReason(step: string, sinceMs: number): Promise<string | null> {
  let out: string;
  try {
    ({ stdout: out } = await execFile(
      "/usr/bin/journalctl",
      rootStepJournalArgs(step, { sinceMs, lines: STEP_JOURNAL_LINES }),
      { timeout: 5_000, maxBuffer: 256 * 1024 },
    ));
  } catch {
    return null;
  }
  const lines = String(out).split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (DISPATCH_VERDICT_LINE.test(line)) continue;
    if (/^Error:/.test(line) || /^clawbox-root-step:/.test(line) || /^Unknown step:/.test(line)) return line;
  }
  return null;
}

/** The reason as the UI may show it: one line, bounded, and never carrying the password it was handed. */
function safeDetail(line: string | null, secret?: string): string | undefined {
  if (!line) return undefined;
  let text = line.replace(/^Error:\s*/, "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (secret && text.includes(secret)) text = text.split(secret).join("•••");
  if (text.length > DETAIL_MAX) text = `${text.slice(0, DETAIL_MAX - 1)}…`;
  return text || undefined;
}

/** The root side of this box is older than the step (an x64 PC before its one-time repair, or an update cut short). */
const ROOT_SIDE_TOO_OLD =
  /has no implementation on the x64 install|is not supported by this desktop integration|^Unknown step:|^clawbox-root-step: \S+ not found$|no valid install user is recorded/;

/**
 * Turn a failed user_add / user_remove into the refusal the owner reads:
 * WHY it failed, never the bare "could not be created" that hid a launcher
 * the x64 install had never been given these steps on.
 */
async function explainStepFailure(
  step: string,
  err: unknown,
  sinceMs: number,
  kind: "create" | "remove",
  secret?: string,
): Promise<UserAdminError> {
  // Duck-typed (several suites mock the runner whole): the launcher could not
  // even be asked — not installed, not granted, or too old for the step.
  const unavailable = err as { rootStepUnavailable?: unknown; repairCommand?: unknown } | null;
  if (unavailable && unavailable.rootStepUnavailable === true) {
    const repairCommand = typeof unavailable.repairCommand === "string" ? unavailable.repairCommand : rootStepRepairCommand();
    return new UserAdminError(
      "root_step_unavailable",
      `This box's system permissions are older than this build, so it cannot ${kind === "create" ? "create" : "remove"} accounts yet. Open the Terminal and run: ${repairCommand} — then try again.`,
      { repairCommand },
    );
  }
  if ((err as { killed?: unknown } | null)?.killed === true) {
    return kind === "create"
      ? new UserAdminError("create_timeout", "Creating the account took too long and was stopped. Try again.")
      : new UserAdminError("remove_timeout", "Removing the account took too long and was stopped. Try again.");
  }

  const reason = await rootStepReason(step, sinceMs);
  const detail = safeDetail(reason, secret);
  if (reason && ROOT_SIDE_TOO_OLD.test(reason)) {
    const repairCommand = rootStepRepairCommand();
    return new UserAdminError(
      "root_step_unavailable",
      `This box's root helper does not know how to ${kind === "create" ? "create" : "remove"} accounts yet. Open the Terminal and run: ${repairCommand} — then try again.`,
      { repairCommand, detail },
    );
  }
  if (kind === "create") {
    if (reason && /already exists/.test(reason)) {
      return new UserAdminError("user_exists", "An account or group with that name already exists on this box.", { detail });
    }
    if (reason && /could not set the password/.test(reason)) {
      return new UserAdminError("password_rejected", "The box refused that password, so the account was not kept. Choose a different password.", { detail });
    }
    return new UserAdminError("create_failed", detail ? `The account could not be created: ${detail}` : "The account could not be created on this box.", { detail });
  }
  return new UserAdminError("remove_failed", detail ? `The account could not be removed: ${detail}` : "The account could not be removed from this box.", { detail });
}

// One user change at a time: each is a read-modify-write of the registry
// around a root step, and two overlapping creates of the same name must not
// both pass the "does it exist" check.
const withUsersLock = createSerialLock();

/** The non-owner users, as stored. An absent or damaged key is "no other users" — the pre-multi-user box. */
export async function listUsers(): Promise<ClawboxUserRecord[]> {
  return parseUserRegistry(await get(USERS_CONFIG_KEY), getSystemUsername());
}

export async function findUser(username: string): Promise<ClawboxUserRecord | null> {
  return (await listUsers()).find((u) => u.username === username) ?? null;
}

async function writeRegistry(records: ClawboxUserRecord[]): Promise<void> {
  await set(USERS_CONFIG_KEY, records);
}

function newSessionVersion(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Does a Linux account OR group of this name exist? `useradd --user-group`
 * creates a same-named group, so a free login name over a taken group name
 * would fail halfway. `null` when getent itself could not answer — the caller
 * fails closed on that.
 */
export async function linuxNameTaken(name: string): Promise<boolean | null> {
  for (const db of ["passwd", "group"] as const) {
    try {
      await execFile(GETENT_BIN, [db, name], { timeout: 5_000 });
      return true;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === GETENT_NOT_FOUND) continue;
      return null;
    }
  }
  return false;
}

const USERNAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789_-";

/**
 * A username REBUILT from the alphabet, character by character, or `null` if
 * it breaks the rule — the `safeAppId` idiom (src/lib/webapp-icon.ts): what
 * reaches the root step's input file is this module's own string, never the
 * caller's that a `.test()` would merely have vouched for.
 */
export function rebuildUsername(name: unknown): string | null {
  if (checkUsername(name) !== "ok") return null;
  let safe = "";
  for (const ch of name as string) {
    const at = USERNAME_ALPHABET.indexOf(ch);
    if (at < 0) return null;
    safe += USERNAME_ALPHABET[at];
  }
  return safe;
}

/**
 * The record `user_add` reads: `user:password\n`, refusing anything that could
 * forge a second one. The password is the one value that has to reach root as
 * typed — `chpasswd` sets it — so it travels exactly as the owner's own does
 * (src/lib/chpasswd.ts): one 0600 file under data/ that step_user_add reads
 * once, validates and deletes.
 */
export function userAddRecord(username: string, password: string): string {
  const safe = rebuildUsername(username);
  if (safe === null) {
    throw new Error(`Unsafe username for user_add record: ${JSON.stringify(username)}`);
  }
  if (/[\r\n\0]/.test(password)) {
    throw new Error("Unsafe password for user_add record (control characters)");
  }
  return `${safe}:${password}\n`;
}

/** Judge a create request by everything that does not need the OS; throws the refusal. */
export function assertCreatable(username: unknown, password: unknown, owner: string, existing: readonly ClawboxUserRecord[]): asserts username is string {
  const verdict = checkUsername(username);
  if (verdict === "invalid") {
    throw new UserAdminError(
      "invalid_username",
      "Usernames use lower-case letters, digits, '-' and '_', start with a letter or '_', and are at most 32 characters.",
    );
  }
  if (verdict === "reserved") {
    throw new UserAdminError("reserved_username", "That name is reserved for the system.");
  }
  const name = username as string;
  if (name === owner || existing.some((u) => u.username === name)) {
    throw new UserAdminError("user_exists", "A user with that name already exists.");
  }
  if (
    typeof password !== "string"
    || password.length < USER_PASSWORD_MIN
    || password.length > USER_PASSWORD_MAX
    || !isSafePasswordChars(password)
  ) {
    throw new UserAdminError(
      "invalid_password",
      `Passwords must be ${USER_PASSWORD_MIN}–${USER_PASSWORD_MAX} characters with no control characters.`,
    );
  }
}

/** Create the Linux account and register it as a ClawBox user. */
export async function createUser(username: unknown, password: unknown): Promise<ClawboxUserRecord> {
  return withUsersLock(async () => {
    const existing = await listUsers();
    assertCreatable(username, password, getSystemUsername(), existing);
    const name = username;

    const taken = await linuxNameTaken(name);
    if (taken === null) {
      throw new UserAdminError("account_check_failed", "Could not check the box's existing accounts. Try again.");
    }
    if (taken) {
      throw new UserAdminError("user_exists", "An account or group with that name already exists on this box.");
    }

    try {
      await fs.mkdir(path.dirname(USER_ADD_INPUT_PATH), { recursive: true });
      await fs.writeFile(USER_ADD_INPUT_PATH, userAddRecord(name, password as string), { mode: 0o600 });
    } catch (err) {
      const why = (err as { code?: unknown }).code;
      console.error("[clawbox-users] could not write the user_add record:", err instanceof Error ? err.message : err);
      throw new UserAdminError(
        "create_failed",
        "The account could not be created: the request for the system could not be saved.",
        { detail: `could not write the request file under data/${typeof why === "string" ? ` (${why})` : ""}` },
      );
    }
    const sinceMs = Date.now();
    try {
      await startRootStep(USER_ADD_STEP, { timeoutMs: 60_000 });
    } catch (err) {
      await fs.unlink(USER_ADD_INPUT_PATH).catch(() => {});
      const refusal = await explainStepFailure(USER_ADD_STEP, err, sinceMs, "create", password as string);
      console.error(`[clawbox-users] user_add failed (${refusal.code}):`, err instanceof Error ? err.message : err);
      throw refusal;
    }

    const record: ClawboxUserRecord = { username: name, createdAt: new Date().toISOString(), sv: newSessionVersion() };
    await writeRegistry([...(await listUsers()).filter((u) => u.username !== name), record]);
    return record;
  });
}

/**
 * Remove a ClawBox user: their sessions end at once, then their Linux account
 * and home folder go. Never the owner, never the person asking.
 */
export async function removeUser(username: string, opts: { currentUser: string }): Promise<void> {
  return withUsersLock(async () => {
    if (username === getSystemUsername()) {
      throw new UserAdminError("cannot_remove_owner", "The box owner cannot be removed.");
    }
    if (username === opts.currentUser) {
      throw new UserAdminError("cannot_remove_self", "You cannot remove the user you are signed in as.");
    }
    const users = await listUsers();
    const record = users.find((u) => u.username === username);
    if (!record) {
      throw new UserAdminError("not_found", "No such user.");
    }

    // The name root is handed is the REGISTRY's copy (data/config.json, written
    // by createUser), rebuilt from the alphabet — never the request's string,
    // which only selected the entry.
    const removable = rebuildUsername(record.username);
    if (removable === null) {
      throw new UserAdminError("not_found", "No such user.");
    }

    // Registry FIRST: dropping the entry is what revokes the user's cookies in
    // middleware, route-auth and the WebSocket proxy, so they are signed out
    // before their account is touched rather than after.
    await writeRegistry(users.filter((u) => u.username !== username));

    const sinceMs = Date.now();
    try {
      await fs.mkdir(path.dirname(USER_REMOVE_INPUT_PATH), { recursive: true });
      await fs.writeFile(USER_REMOVE_INPUT_PATH, `${removable}\n`, { mode: 0o600 });
      await startRootStep(USER_REMOVE_STEP, { timeoutMs: 60_000 });
    } catch (err) {
      await fs.unlink(USER_REMOVE_INPUT_PATH).catch(() => {});
      const refusal = await explainStepFailure(USER_REMOVE_STEP, err, sinceMs, "remove");
      console.error(`[clawbox-users] user_remove failed (${refusal.code}):`, err instanceof Error ? err.message : err);
      // The account is still there, so the owner must still see it and be able
      // to retry — but under a NEW session version, so the sessions revoked
      // above stay revoked.
      const now = await listUsers();
      if (!now.some((u) => u.username === username)) {
        await writeRegistry([...now, { ...record, sv: newSessionVersion() }]);
      }
      throw refusal;
    }
    // Their saved windows (TASK-1306) go with the account: a user created
    // later under the same name starts on an empty desktop, never this one's.
    await removeDesktopState(removable).catch((err) => {
      console.error("[clawbox-users] could not remove the desktop state:", err instanceof Error ? err.message : err);
    });
    // And their chat (src/lib/user-chats.ts): the same name later starts with
    // an empty conversation, never this one's. Loaded here: it reaches the
    // harness's stores, which nothing else in this module needs.
    await (await import("@/lib/user-chats")).forgetUserChats(removable).catch((err: unknown) => {
      console.error("[clawbox-users] could not forget the user's chat:", err instanceof Error ? err.message : err);
    });
  });
}

/**
 * What the root-owned helper said about a non-owner's Linux password:
 * `ok`, `wrong` (PAM_AUTH_ERR — a wrong password, or an account outside
 * `clawbox-users`), or `unavailable` — the helper could not be asked at all:
 * not installed, not granted (an x64 PC before its one-time repair), or it
 * died. Never throws.
 */
export type UserPasswordVerdict = "ok" | "wrong" | "unavailable";

export async function checkUserPassword(username: string, password: string): Promise<UserPasswordVerdict> {
  if (checkUsername(username) !== "ok" || !isSafePasswordChars(password)) return "wrong";
  return new Promise((resolve) => {
    try {
      // `sudo -n`: a box without the grant fails in milliseconds instead of
      // hanging on a prompt. SIGKILL: unix_chkpwd ignores SIGTERM.
      const child = spawn("/usr/bin/sudo", ["-n", "/usr/local/libexec/clawbox/clawbox-user-helper.sh", "verify"], {
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      child.on("error", () => resolve("unavailable"));
      // The helper answers 0 or 7 and nothing else for a well-formed request;
      // any other code is sudo's own (1: no grant, no such command) or a kill.
      child.on("close", (code) => resolve(code === HELPER_OK ? "ok" : code === HELPER_AUTH_ERR ? "wrong" : "unavailable"));
      child.stdin?.on("error", () => {});
      child.stdin?.end(`${username}\n${password}\n`);
    } catch {
      resolve("unavailable");
    }
  });
}

/**
 * Can this box check a second user's password at all? Asks the helper about
 * NOBODY — an empty request, which it refuses with PAM_AUTH_ERR before
 * unix_chkpwd runs — so no password is involved. Anything but that refusal is
 * a helper sudo would not start: Settings → Users shows the repair for it.
 */
export async function userHelperAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn("/usr/bin/sudo", ["-n", "/usr/local/libexec/clawbox/clawbox-user-helper.sh", "verify"], {
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === HELPER_AUTH_ERR));
      child.stdin?.on("error", () => {});
      child.stdin?.end("\n\n");
    } catch {
      resolve(false);
    }
  });
}

/** {@link checkUserPassword} as a yes/no: true only for a password the helper confirmed. */
export async function verifyUserPassword(username: string, password: string): Promise<boolean> {
  return (await checkUserPassword(username, password)) === "ok";
}
