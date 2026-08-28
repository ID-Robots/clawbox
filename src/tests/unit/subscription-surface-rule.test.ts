import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_SURFACE,
  isModelUsableOnSubscription,
  subscriptionSurfaceLabel,
} from "@/lib/provider-models";

/**
 * The greying-out rule, as a rule rather than as a line inside one component.
 *
 * It used to live only in AIModelsStep, so the chat header — which the wizard
 * itself points the customer at ("switch between the curated models from the
 * chat window anytime") — offered every API-key-only model as pickable. One
 * fact, one home, two consumers.
 */
describe("isModelUsableOnSubscription", () => {
  it("keeps every model usable when the device is NOT on subscription auth", () => {
    expect(isModelUsableOnSubscription({ availableOnSubscription: false }, false)).toBe(true);
    expect(isModelUsableOnSubscription({ availableOnSubscription: true }, false)).toBe(true);
    expect(isModelUsableOnSubscription({}, false)).toBe(true);
  });

  it("blocks a model the subscription surface does not carry", () => {
    expect(isModelUsableOnSubscription({ availableOnSubscription: false }, true)).toBe(false);
  });

  it("allows a model the subscription surface does carry", () => {
    expect(isModelUsableOnSubscription({ availableOnSubscription: true }, true)).toBe(true);
  });

  it("treats UNKNOWN as usable — the box could not enumerate the surface", () => {
    // `undefined` is not "no". Marking it would invent a restriction the
    // device never verified, and strike out the whole list on a cold cache.
    expect(isModelUsableOnSubscription({}, true)).toBe(true);
    expect(isModelUsableOnSubscription({ availableOnSubscription: undefined }, true)).toBe(true);
  });
});

describe("subscriptionSurfaceLabel", () => {
  it("names nothing for a provider whose subscription routes NATIVELY", () => {
    // Since PR #532 anthropic is that provider: its subscription runs on its
    // own plugin, so its surface is its own catalogue. "not on the anthropic
    // surface (anthropic)" names nothing a customer can act on, so the
    // refusal wording drops the parenthetical instead. The id to ENUMERATE
    // still exists — see subscriptionSurfaceProvider — the gate is narrowed,
    // not removed.
    expect(subscriptionSurfaceLabel("anthropic")).toBeNull();
    expect(SUBSCRIPTION_SURFACE.anthropic.surfaceProvider).toBeUndefined();
  });

  it("is null for a provider whose subscription does not narrow the set", () => {
    // OpenAI's subscription swaps the whole catalogue (catalogProvider) rather
    // than narrowing this one, so there is no surface to name here.
    expect(subscriptionSurfaceLabel("google")).toBeNull();
    expect(subscriptionSurfaceLabel("openai")).toBeNull();
  });
});
