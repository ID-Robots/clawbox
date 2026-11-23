/**
 * One failure line that would otherwise be printed on every poll.
 *
 * The desktop's Telegram pairing poll reaches several readers every 3 s while a
 * bot is configured, and a file that stays unreadable printed the same line on
 * every pass — about 29 000 a day per open desktop, in the journal `logs_tail`
 * hands the agent, burying the one line that matters. The rule is the one
 * `openclaw-state-store.ts` keeps for the pairing store's own reads: a failure
 * is logged when it first appears or its text changes, and a success wipes the
 * slate so a relapse is logged again. A changed failure is never hidden.
 *
 * No imports: `config-store.ts` uses it, and `mcp/` imports that module.
 */
export interface FailureLog {
  /** True when `message` is to be logged: the first failure since a success, or a different one. */
  isNew(message: string): boolean;
  /** A success: the next failure, the same one included, is logged again. */
  clear(): void;
}

export function failureLog(): FailureLog {
  let last: string | null = null;
  return {
    isNew(message) {
      if (message === last) return false;
      last = message;
      return true;
    },
    clear() {
      last = null;
    },
  };
}
