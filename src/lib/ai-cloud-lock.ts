/**
 * The local-only AI lock, server side (TASK-2501). SERVER ONLY.
 *
 * The contract later work builds on:
 *
 *   - `isCloudAiLocked()` — the one question every cloud AI path asks first.
 *   - `assertCloudAiUnlocked()` / `CloudAiLockedError` — refuse with the
 *     `cloud_ai_locked` code; `cloudAiLockedResponse()` is the route form.
 *   - `resolveClawaiToken()` (src/lib/harness/credentials.ts) answers null
 *     for AI use under the lock; `resolveClawaiEntitlementToken()` keeps
 *     answering for what only proves the box is linked (the usage meter, the
 *     Store, sign-out, the edition swap).
 *   - `useCloudAiLock()` (src/lib/ai-cloud-lock-client.ts) for the browser.
 *
 * What the lock means, and the pure rules, are in ai-cloud-lock-shared.ts.
 */

import { NextResponse } from "next/server";
import { get, getKnown, getKnownSync, set } from "@/lib/config-store";
import {
  AI_CLOUD_LOCK_KEY,
  CLOUD_AI_LOCKED_CODE,
  CLOUD_AI_LOCKED_MESSAGE,
  cloudAiLockFrom,
  storedCloudAiLock,
  type CloudAiLockState,
} from "@/lib/ai-cloud-lock-shared";

export * from "@/lib/ai-cloud-lock-shared";

/**
 * The lock as stored, failing CLOSED. An absent store (no data/config.json
 * yet) is known and empty, so unlocked — the state every box ships in. A store
 * that is there and cannot be read (EACCES, a torn or corrupt file) is not
 * known to be unlocked: it reads as locked until it reads again, because on
 * OpenClaw the ClawBox credential lives in openclaw.json, which an unreadable
 * data/config.json does not take away. `getKnown` reports every read failure
 * itself; it throws only where the store module has no tri-state reader at
 * all, and that store is read the plain way.
 */
export async function readCloudAiLock(): Promise<CloudAiLockState> {
  let read: { value: unknown; known: boolean };
  try {
    read = await getKnown(AI_CLOUD_LOCK_KEY);
  } catch {
    try {
      return cloudAiLockFrom(await get(AI_CLOUD_LOCK_KEY));
    } catch {
      return cloudAiLockFrom(undefined);
    }
  }
  if (!read.known) return { locked: true, pinned: false };
  return cloudAiLockFrom(read.value);
}

/** Is cloud AI locked on this box? Read per call: the owner can flip it at any time. */
export async function isCloudAiLocked(): Promise<boolean> {
  return (await readCloudAiLock()).locked;
}

/**
 * The same question, answered synchronously and by the same rules, for a step
 * that cannot await — a coding run's exit handler deciding whether to start
 * its retry or its carry-on as a new cloud process.
 */
export function isCloudAiLockedSync(): boolean {
  let read: { value: unknown; known: boolean };
  try {
    read = getKnownSync(AI_CLOUD_LOCK_KEY);
  } catch {
    return false;
  }
  return read.known ? cloudAiLockFrom(read.value).locked : true;
}

/** Write the lock. Unlocked removes the key. */
export async function writeCloudAiLock(state: CloudAiLockState): Promise<void> {
  await set(AI_CLOUD_LOCK_KEY, storedCloudAiLock(state));
}

/** Thrown by a cloud AI path the lock refused. `code` is always `cloud_ai_locked`. */
export class CloudAiLockedError extends Error {
  readonly code = CLOUD_AI_LOCKED_CODE;
  constructor(message: string = CLOUD_AI_LOCKED_MESSAGE) {
    super(message);
    this.name = "CloudAiLockedError";
  }
}

export function isCloudAiLockedError(err: unknown): err is CloudAiLockedError {
  return err instanceof CloudAiLockedError
    || (typeof err === "object" && err !== null && (err as { code?: unknown }).code === CLOUD_AI_LOCKED_CODE);
}

/** Throw `CloudAiLockedError` when the lock is on. The first line of every cloud AI call. */
export async function assertCloudAiUnlocked(message?: string): Promise<void> {
  if (await isCloudAiLocked()) throw new CloudAiLockedError(message);
}

/** The JSON body a route answers a locked cloud AI request with. */
export function cloudAiLockedBody(message: string = CLOUD_AI_LOCKED_MESSAGE): { error: string; code: typeof CLOUD_AI_LOCKED_CODE } {
  return { error: message, code: CLOUD_AI_LOCKED_CODE };
}

/** 409 `cloud_ai_locked`: the request is fine, the box's policy refuses where it would go. */
export function cloudAiLockedResponse(message?: string): NextResponse {
  return NextResponse.json(cloudAiLockedBody(message), { status: 409, headers: { "Cache-Control": "no-store" } });
}
