/**
 * Where the Map's layout runs: a Web Worker when the browser can start one,
 * else the same engine on the page in slices (loaded only then). A worker
 * that fails to load (a blocked script, an old browser) falls back the same
 * way and is handed its last `start` again. When the engine cannot load on
 * the page either (a missing chunk after an update), `onFail` says so once.
 */
import type { FromEngine, LayoutEngine, ToEngine } from "./layout-engine";

export interface LayoutPort {
  post(msg: ToEngine, transfer?: Transferable[]): void;
  close(): void;
}

export function openLayoutPort(onMessage: (msg: FromEngine) => void, onFail: (err: unknown) => void): LayoutPort {
  let closed = false;
  let lastStart: ToEngine | null = null;
  let worker: Worker | null = null;
  let engine: LayoutEngine | null = null;
  let queue: ToEngine[] | null = null;

  const inThread = () => {
    queue = lastStart ? [lastStart] : [];
    import("./layout-engine")
      .then(({ createLayoutEngine }) => {
        if (closed) return;
        engine = createLayoutEngine((msg) => onMessage(msg));
        for (const msg of queue ?? []) engine.handle(msg);
        queue = null;
      })
      .catch((err: unknown) => {
        queue = null;
        engine = null;
        if (!closed) onFail(err);
      });
  };

  if (typeof Worker !== "undefined") {
    try {
      worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<FromEngine>) => onMessage(event.data);
      worker.onerror = (event) => {
        event.preventDefault?.();
        worker?.terminate();
        worker = null;
        if (!closed) inThread();
      };
    } catch {
      worker = null;
    }
  }
  if (!worker) inThread();

  return {
    post(msg, transfer = []) {
      if (closed) return;
      if (msg.type === "start") lastStart = msg;
      if (worker) {
        // A start keeps its arrays here too, in case the worker fails and the page must replay it.
        worker.postMessage(msg, msg.type === "start" ? [] : transfer);
      } else if (engine) engine.handle(msg);
      else queue?.push(msg);
    },
    close() {
      closed = true;
      worker?.terminate();
      engine?.stop();
      worker = null;
      engine = null;
    },
  };
}
