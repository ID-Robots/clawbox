// Concurrency gate for the skills store's `hermes` CLI calls.
//
// WHY: the store fires one CLI call per not-installed skill the user opens
// (`skills inspect`) and one per browse page on a device without an index. The
// browser aborts the FETCH when the user navigates away, but that never touched
// the child process — clicking through a dozen cards in twenty seconds left a
// dozen Python processes resident on a Jetson with ~270 MB free.
//
// Two rules fix that:
//   1. the caller's AbortSignal is forwarded, so an abandoned request kills its
//      child (or is dropped before it ever spawns, while still queued);
//   2. at most MAX_CONCURRENT children exist at a time — the rest wait instead
//      of forking, which also keeps the event loop free for /setup-api.

import { type HermesCliResult, runHermesCli } from '@/lib/hermes-cli';

const MAX_CONCURRENT = 2;

let active = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) {
    next(); // hand the slot straight over — `active` stays at the cap
    return;
  }
  active--;
}

export class SkillsCliAborted extends Error {
  constructor() {
    super('Request cancelled');
    this.name = 'SkillsCliAborted';
  }
}

export async function runSkillsCli(
  args: string[],
  opts: {
    timeoutMs?: number;
    input?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<HermesCliResult> {
  if (opts.signal?.aborted) throw new SkillsCliAborted();
  await acquire();
  try {
    // The client may have given up while we were queued — never spawn then.
    if (opts.signal?.aborted) throw new SkillsCliAborted();
    return await runHermesCli(args, opts);
  } finally {
    release();
  }
}
