import { createSerialLock, type SerialLock } from "@/lib/serial-lock";

// Next can load separate module graphs for link and settings routes. Both
// transitions must see the same lock before reading the provider/marker.
const key = Symbol.for("clawbox.hermes.voice-transition");
const shared = globalThis as typeof globalThis & Partial<Record<symbol, SerialLock>>;
export const withHermesVoiceTransition = shared[key] ??= createSerialLock();
