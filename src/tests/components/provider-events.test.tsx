import { describe, expect, it, vi } from "vitest";
import {
  CHAT_MODEL_STATE_EVENT,
  HERMES_MODEL_STATE_EVENT,
  PROVIDERS_CHANGED_EVENT,
  notifyHermesModelState,
  notifyProvidersChanged,
  onProvidersChanged,
} from "@/lib/ui-events";

/**
 * The contract feature 1 rests on: one signal every auth-success path can emit,
 * one subscriber every stale-able view can use, and a debounce so a single save
 * costs one refetch rather than one per write it made.
 *
 * A jsdom test rather than a unit one because the whole mechanism IS `window`.
 */

/** Run the pending debounce timers. */
async function settle(ms = 200) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("the providers-changed signal", () => {
  it("pins the event names, so a rename cannot silently deafen a listener", () => {
    expect(PROVIDERS_CHANGED_EVENT).toBe("clawbox:providers-changed");
    expect(HERMES_MODEL_STATE_EVENT).toBe("clawbox:hermes-model-state-changed");
    expect(CHAT_MODEL_STATE_EVENT).toBe("clawbox:chat-model-state-changed");
  });

  it("wakes a listener whichever of the three names was emitted", async () => {
    vi.useFakeTimers();
    try {
      for (const emit of [
        () => notifyProvidersChanged(),
        () => notifyHermesModelState(),
        () => window.dispatchEvent(new Event(CHAT_MODEL_STATE_EVENT)),
      ]) {
        const listener = vi.fn();
        const stop = onProvidersChanged(listener);
        emit();
        await settle();
        expect(listener).toHaveBeenCalledTimes(1);
        stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a burst into ONE call", async () => {
    // Saving a key emits twice — once for the credential, once for the pairing.
    // Undebounced, every listener paid for both, and on Hermes each payment is
    // a CLI spawn.
    vi.useFakeTimers();
    try {
      const listener = vi.fn();
      const stop = onProvidersChanged(listener);
      notifyProvidersChanged();
      notifyHermesModelState();
      notifyProvidersChanged();
      await settle();
      expect(listener).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fires again for a genuinely separate later change", async () => {
    vi.useFakeTimers();
    try {
      const listener = vi.fn();
      const stop = onProvidersChanged(listener);
      notifyProvidersChanged();
      await settle();
      notifyProvidersChanged();
      await settle();
      expect(listener).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a debounce that is already pending when it unsubscribes", async () => {
    // Otherwise the trailing call lands after the component is gone, which is a
    // setState on an unmounted tree.
    vi.useFakeTimers();
    try {
      const listener = vi.fn();
      const stop = onProvidersChanged(listener);
      notifyProvidersChanged();
      stop();
      await settle();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
