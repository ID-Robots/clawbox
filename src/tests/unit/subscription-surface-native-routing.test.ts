import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_SURFACE,
  isModelUsableOnSubscription,
  routesSubscriptionNatively,
  subscriptionSurfaceLabel,
  subscriptionSurfaceProvider,
} from "@/lib/provider-models";

/**
 * Owner-reported on a live OpenClaw box signed in with a Claude Pro/Max
 * subscription: the chat header greys out Claude Fable 5, Claude Mythos 5 and
 * Claude Haiku 4.5 with "Not in the subscription - requires API key", while
 * the same sign-in runs claude-fable-5 on the Hermes edition.
 *
 * The greying was not careless. It was CORRECT when it was written: a
 * subscription anthropic save wrote a `models.providers.anthropic`
 * openai-compat override, every turn left as `POST /v1/chat/completions`, and
 * the only catalogue reachable that way was the plugin's `claude-cli` one —
 * which carries neither Fable nor Mythos nor Haiku.
 *
 * PR #532 moved the transport. A subscription anthropic save now hands the
 * provider to the NATIVE anthropic plugin (`POST /v1/messages` with
 * `anthropic-beta: oauth-2025-04-20`), which serves the provider's full
 * catalogue on a subscription credential — which is exactly why Hermes, which
 * routed natively all along, never had this restriction.
 *
 * So the rule went STALE rather than wrong, and the fix is to compute the
 * surface from the transport the box will actually use. These tests pin that
 * the two are read from ONE table, because they were two tables in two files
 * for exactly one release and that release shipped this bug.
 */
describe("SUBSCRIPTION_SURFACE — native routing after PR #532", () => {
  it("routes an anthropic SUBSCRIPTION through the provider's own plugin", () => {
    expect(routesSubscriptionNatively("anthropic", "subscription")).toBe(true);
  });

  it("leaves an anthropic API KEY on the openai-compat override", () => {
    // The native route is a property of the SUBSCRIPTION credential, not of
    // the provider. An API key still takes the override path it always took.
    expect(routesSubscriptionNatively("anthropic", "api_key")).toBe(false);
  });

  it("does not hand google's subscription to a native route no one has proven", () => {
    // google (Gemini Code Assist) has an OAuth flow too, and its native plugin
    // fails auth at call time on 2026.6.8. Widening this to "every provider
    // with OAuth" would repeat the bug #532 fixed, pointed the other way.
    expect(routesSubscriptionNatively("google", "subscription")).toBe(false);
  });

  it("makes the native provider's OWN catalogue the subscription surface", () => {
    // Not null. The gate still points at a real, enumerated list — an id in no
    // Anthropic catalogue must still be refused, because pinning
    // `agents.defaults.model.primary` to one fails silently and survives a
    // reboot. What changed is WHICH list, not whether there is one.
    expect(subscriptionSurfaceProvider("anthropic")).toBe("anthropic");
  });

  it("names no narrower surface for a natively-routed provider", () => {
    // A refusal that said "not on the anthropic surface (anthropic)" names
    // nothing the customer can act on, and recommending API-key mode would
    // send them after a fix that changes nothing.
    expect(subscriptionSurfaceLabel("anthropic")).toBeNull();
  });
});

describe("SUBSCRIPTION_SURFACE — the other columns are untouched", () => {
  it("still swaps OpenAI's whole namespace to codex on subscription", () => {
    expect(SUBSCRIPTION_SURFACE.openai.catalogProvider).toBe("codex");
  });

  it("does not give OpenAI a surface to narrow to, or a native route", () => {
    // OpenAI's subscription moves the namespace wholesale; there is no second
    // catalogue to enumerate and no native-route claim being made about it.
    expect(subscriptionSurfaceProvider("openai")).toBeNull();
    expect(routesSubscriptionNatively("openai", "subscription")).toBe(false);
  });

  it("says nothing at all about a provider the table does not list", () => {
    expect(subscriptionSurfaceProvider("google")).toBeNull();
    expect(subscriptionSurfaceLabel("google")).toBeNull();
  });
});

describe("the greying rule still treats UNKNOWN as usable", () => {
  it("keeps an unstamped model pickable on a subscription box", () => {
    // Unchanged by this fix and load-bearing for it: a box that could not
    // enumerate the surface must not invent a restriction it never verified.
    expect(isModelUsableOnSubscription({}, true)).toBe(true);
    expect(isModelUsableOnSubscription({ availableOnSubscription: undefined }, true)).toBe(true);
  });

  it("still greys a model an enumerated surface genuinely omits", () => {
    // The gate is narrowed, not removed. `false` still means no.
    expect(isModelUsableOnSubscription({ availableOnSubscription: false }, true)).toBe(false);
  });
});
