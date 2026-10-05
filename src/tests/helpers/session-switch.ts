/**
 * Several browser tabs, inside one jsdom window — for the session-switch tests
 * (TASK-1247, src/lib/session-switch.ts).
 *
 * jsdom has one document, so "another tab" is what that tab would do to this
 * one: post on the BroadcastChannel (a bus shared by every channel object, the
 * sender's own excluded, delivered on a later task as browsers do), write the
 * shared localStorage record, and — the browser's part — fire `storage` here.
 */
import { vi } from "vitest";
import {
  SESSION_SWITCH_CHANNEL,
  SESSION_SWITCH_STORAGE_KEY,
  type SessionSwitch,
  type SessionSwitchKind,
} from "@/lib/session-switch";

type Listener = ((event: MessageEvent) => void) | null;

export class FakeBroadcastChannel {
  static open: FakeBroadcastChannel[] = [];
  /** Everything posted, in order — what the other tabs were told. */
  static posted: Array<{ name: string; data: unknown }> = [];
  onmessage: Listener = null;
  closed = false;

  constructor(public readonly name: string) {
    FakeBroadcastChannel.open.push(this);
  }

  postMessage(data: unknown) {
    if (this.closed) throw new Error("InvalidStateError: channel is closed");
    const copy = JSON.parse(JSON.stringify(data)) as unknown;
    FakeBroadcastChannel.posted.push({ name: this.name, data: copy });
    const receivers = FakeBroadcastChannel.open.filter((c) => c !== this && c.name === this.name && !c.closed);
    setTimeout(() => {
      for (const receiver of receivers) {
        if (!receiver.closed) receiver.onmessage?.({ data: copy } as MessageEvent);
      }
    }, 0);
  }

  close() {
    this.closed = true;
    FakeBroadcastChannel.open = FakeBroadcastChannel.open.filter((c) => c !== this);
  }

  addEventListener() {}
  removeEventListener() {}

  static reset() {
    FakeBroadcastChannel.open = [];
    FakeBroadcastChannel.posted = [];
  }

  /** Channels a page is still listening on. */
  static listening(): number {
    return FakeBroadcastChannel.open.filter((c) => c.name === SESSION_SWITCH_CHANNEL && c.onmessage).length;
  }
}

export function installFakeBroadcastChannel() {
  FakeBroadcastChannel.reset();
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
}

let otherTabSwitches = 0;

/**
 * What another tab's `announceSessionSwitch` does to this one. `via` picks the
 * carrier: the channel alone (the storage event is lost — a frozen tab), the
 * storage event alone (a browser without BroadcastChannel), or both, which is
 * what a current browser delivers.
 */
export function announceFromAnotherTab(
  kind: SessionSwitchKind,
  via: "both" | "channel" | "storage" | "none" = "both",
): SessionSwitch {
  otherTabSwitches += 1;
  const change: SessionSwitch = { id: `other-tab-${otherTabSwitches}`, kind, at: Date.now() };
  const raw = JSON.stringify(change);
  window.localStorage.setItem(SESSION_SWITCH_STORAGE_KEY, raw);
  if (via === "both" || via === "channel") {
    const tab = new FakeBroadcastChannel(SESSION_SWITCH_CHANNEL);
    tab.postMessage(change);
    tab.close();
  }
  if (via === "both" || via === "storage") {
    window.dispatchEvent(new StorageEvent("storage", { key: SESSION_SWITCH_STORAGE_KEY, newValue: raw }));
  }
  return change;
}

export interface StubbedLocation {
  replace: ReturnType<typeof vi.fn>;
  assign: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  restore: () => void;
}

/**
 * Put the page at `path` with `location.replace` and friends as spies. The
 * setter on `href` is recorded as an `assign`, so a test can tell a navigation
 * that keeps the page in history from one that replaces it.
 */
export function stubLocation(path: string, origin = "http://clawbox.local"): StubbedLocation {
  const saved = Object.getOwnPropertyDescriptor(window, "location");
  const url = new URL(path, origin);
  const replace = vi.fn();
  const assign = vi.fn();
  const reload = vi.fn();
  const value = {
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    get href() { return url.href; },
    set href(next: string) { assign(next); },
    assign,
    reload,
    replace,
    toString: () => url.href,
  };
  Object.defineProperty(window, "location", { configurable: true, value });
  return {
    replace,
    assign,
    reload,
    restore: () => {
      if (saved) Object.defineProperty(window, "location", saved);
    },
  };
}

/** A back-forward-cache restore (`persisted: true`), or an ordinary load's pageshow. */
export function firePageShow(persisted: boolean) {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

/** The tab coming to the front again (or going to the back). */
export function fireVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Let the channel's delivery task run. */
export const channelTick = () => new Promise((resolve) => setTimeout(resolve, 5));
