// The extension's service token. Every write and every removal goes through one
// queue, so "drop it if it is still the token that got the 401" can never
// interleave with a pairing that is storing a new one: the drop reads and
// removes inside its turn, and the pairing's write waits for it (or the other
// way round). Reads need no turn.

export interface TokenStorage {
  get(key: "token"): Promise<{ token?: unknown }>;
  set(items: { token: string }): Promise<void>;
  remove(key: "token"): Promise<void>;
}

export class TokenStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: TokenStorage) {}

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op, op);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async get(): Promise<string | null> {
    const { token } = await this.storage.get("token");
    return typeof token === "string" ? token : null;
  }

  set(token: string): Promise<void> {
    return this.serial(() => this.storage.set({ token }));
  }

  clear(): Promise<void> {
    return this.serial(() => this.storage.remove("token"));
  }

  /** Remove the token only if it is still `used`. True when it did. */
  dropIfCurrent(used: string): Promise<boolean> {
    return this.serial(async () => {
      if ((await this.get()) !== used) return false;
      await this.storage.remove("token");
      return true;
    });
  }
}
