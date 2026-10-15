/// <reference lib="webworker" />
/**
 * The Map's layout off the page's thread: the engine (layout-engine.ts) wired
 * to the worker's own messages. Started by layout-port.ts.
 */
import { createLayoutEngine, readToEngine } from "./layout-engine";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const engine = createLayoutEngine((msg, transfer) => scope.postMessage(msg, transfer));
scope.onmessage = (event: MessageEvent<unknown>) => {
  // A dedicated worker hears only the page that started it, whose messages carry
  // no origin; anything that names another origin is not that page.
  if (event.origin !== "" && event.origin !== scope.location.origin) return;
  const msg = readToEngine(event.data);
  if (msg) engine.handle(msg);
};
