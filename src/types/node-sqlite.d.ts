/**
 * Minimal ambient surface for node:sqlite, which ships (experimental) with
 * the Node 22 the box runs but is not yet described by the repo's @types/node.
 * Only what src/lib/openclaw-session-store.ts uses is declared; widen it here
 * when more of the module is needed.
 */
declare module "node:sqlite" {
  interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    iterate(...params: unknown[]): IterableIterator<unknown>;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
  export { DatabaseSync, StatementSync };
}
