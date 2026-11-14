// Agent fill commands waiting for the paired extension. The extension holds a
// long-poll; a command is handed out once, its secret can be released once,
// and the agent's request waits for the status the extension reports back.
// Card commands also wait for the human: the extension shows a confirmation,
// and the card's secret is released only after the human confirmed it.
import { randomUUID } from "node:crypto";
import type { FillCommand, FillResult, FillStatus } from "../shared/types";

interface Inflight {
  cmd: FillCommand;
  resolve: (r: FillResult) => void;
  timer: ReturnType<typeof setTimeout>;
  delivered: boolean;
  secretReleased: boolean;
  /** Card fills: a human decision is needed before the secret is released. */
  needsConfirm: boolean;
  confirmed: boolean;
  timeoutMs: number;
}

export interface SubmitOptions {
  /** How long the fill may take once it may run (default: the queue timeout). */
  timeoutMs?: number;
  /** Card fills: how long the human has to confirm. */
  confirmMs?: number;
}

export interface FillQueueOptions {
  timeoutMs: number;
  /** An extension counts as connected this long after its last poll ended. */
  onlineWindowMs?: number;
  now?: () => number;
}

export class FillQueue {
  private queue: string[] = [];
  private inflight = new Map<string, Inflight>();
  private waiters: Array<(cmds: FillCommand[]) => void> = [];
  private activePolls = 0;
  private lastPollEnd = 0;
  private readonly now: () => number;
  private readonly onlineWindowMs: number;

  constructor(private readonly opts: FillQueueOptions) {
    this.now = opts.now ?? Date.now;
    this.onlineWindowMs = opts.onlineWindowMs ?? 40_000;
  }

  online(): boolean {
    return this.activePolls > 0 || this.now() - this.lastPollEnd < this.onlineWindowMs;
  }

  submit(input: Omit<FillCommand, "id" | "createdAt" | "confirmBy">, opts: SubmitOptions = {}): Promise<FillResult> {
    if (!this.online()) return Promise.resolve({ status: "extension_offline", name: input.name });
    const needsConfirm = input.kind === "card";
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs;
    const firstWait = needsConfirm ? (opts.confirmMs ?? timeoutMs) : timeoutMs;
    const cmd: FillCommand = {
      ...input,
      id: randomUUID(),
      createdAt: new Date(this.now()).toISOString(),
      ...(needsConfirm ? { confirmBy: new Date(this.now() + firstWait).toISOString() } : {}),
    };
    return new Promise<FillResult>((resolve) => {
      const timer = setTimeout(() => this.expire(cmd.id), firstWait);
      this.inflight.set(cmd.id, { cmd, resolve, timer, delivered: false, secretReleased: false, needsConfirm, confirmed: false, timeoutMs });
      this.queue.push(cmd.id);
      const waiter = this.waiters.shift();
      if (waiter) waiter(this.take());
    });
  }

  private take(): FillCommand[] {
    const out: FillCommand[] = [];
    for (const id of this.queue.splice(0)) {
      const item = this.inflight.get(id);
      if (!item) continue;
      item.delivered = true;
      out.push(item.cmd);
    }
    return out;
  }

  /** Long-poll: resolves with commands as soon as there are any, or [] after waitMs. */
  async poll(waitMs: number, signal?: AbortSignal): Promise<FillCommand[]> {
    this.activePolls++;
    try {
      if (this.queue.length) return this.take();
      return await new Promise<FillCommand[]>((resolve) => {
        const done = (cmds: FillCommand[]) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(cmds);
        };
        const onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== done);
          done([]);
        };
        const timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== done);
          done([]);
        }, waitMs);
        signal?.addEventListener("abort", onAbort);
        this.waiters.push(done);
      });
    } finally {
      this.activePolls--;
      this.lastPollEnd = this.now();
    }
  }

  private expire(id: string): void {
    const item = this.inflight.get(id);
    if (!item) return;
    if (!item.delivered) return this.finish(id, { status: "extension_offline", name: item.cmd.name });
    if (item.needsConfirm && !item.confirmed) {
      return this.finish(id, { status: "timeout", name: item.cmd.name, detail: "nobody confirmed the card fill in the browser" });
    }
    this.finish(id, { status: "timeout", name: item.cmd.name });
  }

  /**
   * The human's answer to a card fill confirmation, once per command. A
   * decline ends the command; a confirm starts the fill timeout.
   */
  decide(id: string, decision: "confirm" | "decline"): FillCommand | null {
    const item = this.inflight.get(id);
    if (!item || !item.delivered || !item.needsConfirm || item.confirmed) return null;
    if (decision === "decline") {
      const cmd = item.cmd;
      this.finish(id, { status: "declined", name: cmd.name, detail: "the human declined the card fill" });
      return cmd;
    }
    item.confirmed = true;
    clearTimeout(item.timer);
    item.timer = setTimeout(() => this.expire(id), item.timeoutMs);
    return item.cmd;
  }

  /** The command, once, if it was delivered (and confirmed, for card fills) and its secret not yet released. */
  releaseSecret(id: string, kind: "login" | "card" = "login"): FillCommand | null {
    const item = this.inflight.get(id);
    if (!item || !item.delivered || item.secretReleased) return null;
    if ((item.cmd.kind ?? "login") !== kind) return null;
    if (item.needsConfirm && !item.confirmed) return null;
    item.secretReleased = true;
    return item.cmd;
  }

  report(id: string, status: FillStatus, detail?: string): boolean {
    const item = this.inflight.get(id);
    if (!item || !item.delivered) return false;
    // A card fill cannot have run before the human confirmed it.
    if (item.needsConfirm && !item.confirmed && status === "filled") return false;
    this.finish(id, { status, name: item.cmd.name, ...(detail ? { detail } : {}) });
    return true;
  }

  /** Resolve every open command, e.g. when the extension is locked or unpaired. */
  cancelAll(status: FillStatus): void {
    for (const id of [...this.inflight.keys()]) this.finish(id, { status });
    this.queue = [];
  }

  /** Forget the connection, e.g. after unpairing. */
  disconnect(): void {
    this.lastPollEnd = 0;
    for (const w of this.waiters.splice(0)) w([]);
  }

  private finish(id: string, result: FillResult): void {
    const item = this.inflight.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    this.inflight.delete(id);
    this.queue = this.queue.filter((q) => q !== id);
    item.resolve({ ...result, name: result.name ?? item.cmd.name, ...(item.cmd.card ? { card: item.cmd.card } : {}) });
  }
}
