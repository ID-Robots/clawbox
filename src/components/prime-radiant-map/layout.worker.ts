/// <reference lib="webworker" />
/**
 * The Map's layout off the page's thread: the engine (layout-engine.ts) wired
 * to the worker's own messages. Started by layout-port.ts.
 */
import { createLayoutEngine, type ToEngine } from "./layout-engine";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const engine = createLayoutEngine((msg, transfer) => scope.postMessage(msg, transfer));
scope.onmessage = (event: MessageEvent<ToEngine>) => engine.handle(event.data);
