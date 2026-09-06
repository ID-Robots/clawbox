import { afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import plugin, { onReplyPayloadSending } from "../../../scripts/openclaw-plugins/clawbox-email-directives/index.mjs";
import { onBeforeDispatch } from "../../../scripts/openclaw-plugins/clawbox-email-directives/email-approvals.mjs";

// The OpenClaw half of TASK-697: the `reply_payload_sending` plugin that takes
// `EMAIL:<uid>` card directives out of a reply on its way to a channel.
//
// The contract being pinned comes from the pinned 2026.8.1 core on the OpenClaw
// box (`dist/hook-runner-global-*.js`, `dist/hook-types-*.d.ts`):
//
//   runReplyPayloadSending      `if (!handlerResult) continue` — a falsy return
//                               means unchanged
//   toPluginReplyPayload        the event payload is a structuredClone, so a
//                               mutation in place is written to a throwaway
//   PluginHookReplyPayloadSendingResult
//                               `{ payload }` — the whole payload, not
//                               `{ content }` and not `{ text }`
//   deliver-prepare             a payload with no visible content left is
//                               suppressed as
//                               `empty_after_reply_payload_sending_hook`
//   PluginHookMessageContext    `channelId` is a required lowercase string;
//                               there is no clientId, version or mode
//
// The last one is why webchat KEEPS the directive: ClawBox's two chats and the
// gateway's own Control UI are all `channelId: "webchat"` and nothing in the
// hook's context tells them apart (TASK-700).

const PLUGIN_DIR = path.resolve(__dirname, "../../../scripts/openclaw-plugins/clawbox-email-directives");

const REPLY = "Here are your last two emails.\nEMAIL:10960\nEMAIL:10959";
const STRIPPED = "Here are your last two emails.";

/** The shape the dispatcher hands a handler, with only the fields under test. */
function event(payload: Record<string, unknown>, channel = "telegram") {
  return { payload, kind: "final" as const, channel };
}

function ctx(channelId: string) {
  return { channelId };
}

describe("OpenClaw reply_payload_sending plugin — EMAIL: directives", () => {
  it("strips the directives on every channel the box can reach", () => {
    for (const channel of ["telegram", "whatsapp", "discord", "slack", "signal"]) {
      const result = onReplyPayloadSending(event({ text: REPLY }, channel), ctx(channel));
      expect(result, channel).toEqual({ payload: { text: STRIPPED } });
    }
  });

  it("strips on a channel nobody has installed yet", () => {
    // A channel plugin added tomorrow arrives with an id nothing here knows,
    // and must strip by default — which is why the rule is a keep-list.
    const result = onReplyPayloadSending(event({ text: REPLY }, "irc"), ctx("irc"));
    expect(result).toEqual({ payload: { text: STRIPPED } });
  });

  it("KEEPS the directives on webchat, where ClawBox renders the card", () => {
    expect(onReplyPayloadSending(event({ text: REPLY }, "webchat"), ctx("webchat"))).toBeUndefined();
  });

  it("KEEPS them when the delivery path could not name its channel", () => {
    expect(onReplyPayloadSending(event({ text: REPLY }, ""), ctx(""))).toBeUndefined();
    expect(onReplyPayloadSending({ payload: { text: REPLY }, kind: "final" }, {})).toBeUndefined();
  });

  // ── The two signals, as the pinned core actually fills them ───────────────
  //
  // Read off the 2026.8.1 core installed on the OpenClaw box, read-only:
  //   event.channel  = Surface ?? Provider                (deliver-prepare:125)
  //   ctx.channelId  = OriginatingChannel ?? Surface ?? Provider
  //                                              (message-hook-mappers:50)
  //
  // These cases are the VALUES the box produces, not values a test invented, so
  // a core that changes what either field means fails here rather than in the
  // owner's chat. If one of them ever starts disagreeing on a real delivery,
  // this block is the thing to re-derive from the box.
  it("KEEPS the line when both signals say webchat — the dashboard chat", () => {
    // chat-send-handler:2367-2371 sets Provider AND Surface to
    // INTERNAL_MESSAGE_CHANNEL ("webchat", message-channel-constants:3), and
    // resolveChatSendOriginatingRoute (:355/365/382) makes OriginatingChannel
    // the same for every send that is not an explicit deliver route.
    expect(onReplyPayloadSending(event({ text: REPLY }, "webchat"), ctx("webchat"))).toBeUndefined();
  });

  it("STRIPS when both signals say a channel — a reply arriving from Telegram", () => {
    // channel-inbound:153-162 sets all three to the channel id.
    expect(onReplyPayloadSending(event({ text: REPLY }, "telegram"), ctx("telegram"))).toEqual({
      payload: { text: STRIPPED },
    });
  });

  it("STRIPS when the ctx names a channel and the event still says webchat", () => {
    // THE ONE THAT MATTERS. A `chat.send` with `deliver: true` and an explicit
    // route leaves Surface/Provider pinned to "webchat" while
    // OriginatingChannel becomes the destination
    // (chat-send-handler:346-392) — so `event.channel` says "webchat" for a
    // reply headed to Telegram. Believing the event first would print the id in
    // Telegram, which is the whole bug.
    expect(onReplyPayloadSending(event({ text: REPLY }, "webchat"), ctx("telegram"))).toEqual({
      payload: { text: STRIPPED },
    });
  });

  it("STRIPS when the event names a channel and the ctx says webchat", () => {
    // The mirror. No path was found on the box that produces this pair, but a
    // reply whose delivery surface is a channel must not carry the id whatever
    // the session started as.
    expect(onReplyPayloadSending(event({ text: REPLY }, "telegram"), ctx("webchat"))).toEqual({
      payload: { text: STRIPPED },
    });
  });

  it("an empty signal is not a vote — it can never force a strip on its own", () => {
    // `channelId` is a required string the core sets to "" when it knows
    // nothing, so "" means UNKNOWN and the other signal decides. A delivery
    // this plugin cannot place at all keeps the line, because the cost of
    // guessing wrong is the card gone from the chat the owner uses daily.
    expect(onReplyPayloadSending(event({ text: REPLY }, ""), ctx("webchat"))).toBeUndefined();
    expect(onReplyPayloadSending(event({ text: REPLY }, "webchat"), ctx(""))).toBeUndefined();
    expect(onReplyPayloadSending(event({ text: REPLY }, ""), ctx("telegram"))).toEqual({
      payload: { text: STRIPPED },
    });
    expect(onReplyPayloadSending({ payload: { text: REPLY }, kind: "final" }, ctx("telegram"))).toEqual({
      payload: { text: STRIPPED },
    });
  });

  it("returns undefined when there was no directive to remove", () => {
    // Not `{ payload }` with the same text: a returned payload makes the
    // dispatcher clone and re-accept it for nothing.
    expect(onReplyPayloadSending(event({ text: "Your ClawBox is ready." }), ctx("telegram"))).toBeUndefined();
  });

  it("leaves a directive whose payload is not a usable id as text", () => {
    const text = "I could not find it.\nEMAIL:not-a-number";
    expect(onReplyPayloadSending(event({ text }), ctx("telegram"))).toBeUndefined();
  });

  it("does not mutate the payload it was given", () => {
    // The event payload is a structuredClone the dispatcher throws away, so a
    // mutation would look like it worked and change nothing.
    const payload = { text: REPLY };
    onReplyPayloadSending(event(payload), ctx("telegram"));
    expect(payload.text).toBe(REPLY);
  });

  it("carries every other payload field through untouched", () => {
    const payload = {
      text: REPLY,
      mediaUrls: ["file:///tmp/a.png"],
      replyToId: "42",
      audioAsVoice: true,
      presentation: "card",
      channelData: { thread: 7 },
    };
    const result = onReplyPayloadSending(event(payload), ctx("telegram")) as { payload: Record<string, unknown> };
    expect(result.payload).toEqual({ ...payload, text: STRIPPED });
  });

  it("strips the fallback text and the spoken transcript too", () => {
    const payload = {
      text: REPLY,
      fallbackText: { text: REPLY, replacesPayloadIndex: 0 },
      spokenText: REPLY,
      ttsSupplement: { spokenText: REPLY, visibleTextAlreadyDelivered: true },
    };
    const result = onReplyPayloadSending(event(payload), ctx("telegram")) as { payload: Record<string, unknown> };
    expect(result.payload).toEqual({
      text: STRIPPED,
      fallbackText: { text: STRIPPED, replacesPayloadIndex: 0 },
      spokenText: STRIPPED,
      ttsSupplement: { spokenText: STRIPPED, visibleTextAlreadyDelivered: true },
    });
  });

  it("acts on a payload that carries only a spoken transcript", () => {
    // The audio-only TTS shape: no visible text, the directive hiding in the
    // transcript the core exposes to hooks.
    const result = onReplyPayloadSending(event({ spokenText: REPLY }), ctx("telegram"));
    expect(result).toEqual({ payload: { spokenText: STRIPPED } });
  });

  it("empties the text of an all-directives reply so the core suppresses it", () => {
    // `hasOutboundReplyContent` is false for a payload with nothing visible, and
    // the core drops it as `empty_after_reply_payload_sending_hook` — the right
    // outcome, and the reason this returns "" rather than inventing prose.
    const result = onReplyPayloadSending(event({ text: "EMAIL:4471" }), ctx("telegram"));
    expect(result).toEqual({ payload: { text: "" } });
  });

  it("leaves a media reply's attachments alone when the caption empties", () => {
    const result = onReplyPayloadSending(
      event({ text: "EMAIL:4471", mediaUrls: ["file:///tmp/a.png"] }),
      ctx("telegram"),
    ) as { payload: Record<string, unknown> };
    expect(result.payload).toEqual({ text: "", mediaUrls: ["file:///tmp/a.png"] });
  });

  it("returns undefined for a payload that is not an object", () => {
    expect(onReplyPayloadSending({ payload: undefined, kind: "final" }, ctx("telegram"))).toBeUndefined();
    expect(onReplyPayloadSending({ payload: "text", kind: "final" }, ctx("telegram"))).toBeUndefined();
  });

  it("registers reply_payload_sending under the id its manifest declares", () => {
    const registered: string[] = [];
    plugin.register({ on: (name: string) => registered.push(name) });
    // BOTH, and in this order: the outbound strip this plugin was built for,
    // and the inbound approval claim that now rides on it.
    expect(registered).toEqual(["reply_payload_sending", "before_dispatch"]);

    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "openclaw.plugin.json"), "utf-8"));
    expect(manifest.id).toBe(plugin.id);
    // A hook-only plugin has no tool, provider or channel to be constructed
    // for, so without an explicit startup intent the core never loads it.
    expect(manifest.activation.onStartup).toBe(true);
    // "Every plugin must ship a JSON Schema, even if it accepts no config."
    expect(manifest.configSchema).toBeTruthy();
  });

  it("names its entry point where the core looks for it", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "package.json"), "utf-8"));
    expect(pkg.type).toBe("module");
    expect(pkg.openclaw.extensions).toEqual(["./index.mjs"]);
    for (const file of pkg.openclaw.extensions) {
      expect(fs.existsSync(path.join(PLUGIN_DIR, file))).toBe(true);
    }
  });

  it("imports nothing it cannot resolve from ~/.openclaw/extensions", () => {
    // The plugin is COPIED into the gateway's extension root, where there is no
    // node_modules of its own — so a bare specifier (`openclaw/plugin-sdk/...`,
    // any npm package) would fail to resolve at load time and the plugin would
    // silently not be there. Only relative imports are allowed.
    for (const file of ["index.mjs", "email-directives.mjs"]) {
      const source = fs.readFileSync(path.join(PLUGIN_DIR, file), "utf-8");
      const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
      for (const specifier of specifiers) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.{1,2}\//);
      }
    }
  });
});

// ── The inbound half: what the hook actually asks ClawBox, and what it returns ─

describe("before_dispatch — the owner's approval reply", () => {
  const TOKEN = "t".repeat(32);

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CLAWBOX_MCP_TOKEN;
    delete process.env.CLAWBOX_API_BASE;
  });

  /** A fetch that records the one request and answers with `body`. */
  function stubClawbox(body: unknown, status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    return calls;
  }

  it("asks nothing at all about an ordinary message", async () => {
    process.env.CLAWBOX_MCP_TOKEN = TOKEN;
    const calls = stubClawbox({ handled: true, reply: "Sent." });
    // The hook runs on EVERY inbound message on every channel, so a message
    // that is not exactly a verb and a code must cost no I/O whatsoever.
    expect(
      await onBeforeDispatch({ content: "can you email Ivan?" }, { senderId: "6001", channelId: "telegram" }),
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("hands ClawBox the sender, the surface and the harness", async () => {
    process.env.CLAWBOX_MCP_TOKEN = TOKEN;
    process.env.CLAWBOX_API_BASE = "http://127.0.0.1:80";
    const calls = stubClawbox({ handled: true, reply: "Sent to 1 recipient(s)." });

    const result = await onBeforeDispatch({ content: "send AB2CD" }, { senderId: "6001", channelId: "telegram" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:80/setup-api/email/chat-reply");
    expect(calls[0].init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    // The surface and the harness travel with it: the allowlist ClawBox weighs
    // the sender against is Telegram's, and on a dual box it is THIS harness's.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      senderId: "6001",
      text: "send AB2CD",
      channel: "telegram",
      harness: "openclaw",
    });
    // The claim carries NO text even though this hook could: ClawBox posts the
    // verdict itself, and a second copy here would be two messages for one
    // approval — on the fast path only, which is worse than either.
    expect(result).toEqual({ handled: true });
  });

  it("refuses a token that is not token-shaped rather than putting it in a header", async () => {
    // The bearer is read off disk and interpolated into an Authorization
    // header, so a stray CR would be header injection.
    //
    // A FRESH MODULE, because the plugin caches the first token it reads for
    // the life of the gateway process — which is the behaviour, and which every
    // test above has already primed.
    process.env.CLAWBOX_MCP_TOKEN = `${"t".repeat(20)}\r\nX-Evil: 1`;
    const calls = stubClawbox({ handled: true });
    vi.resetModules();
    const fresh = (await import("../../../scripts/openclaw-plugins/clawbox-email-directives/email-approvals.mjs")) as {
      onBeforeDispatch: typeof onBeforeDispatch;
    };
    expect(
      await fresh.onBeforeDispatch({ content: "send AB2CD" }, { senderId: "6001", channelId: "telegram" }),
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("leaves the message to the agent on every not-ours answer", async () => {
    process.env.CLAWBOX_MCP_TOKEN = TOKEN;
    for (const [body, status] of [
      [{ handled: false }, 200],
      [{ handled: false }, 403],
      [{}, 200],
    ] as [unknown, number][]) {
      stubClawbox(body, status);
      expect(
        await onBeforeDispatch({ content: "send AB2CD" }, { senderId: "6001", channelId: "telegram" }),
      ).toBeUndefined();
    }
  });

  it("fails OPEN when ClawBox cannot be reached at all", async () => {
    // A box mid-rebuild must not swallow the owner's message. This is the one
    // failure mode a hook can turn into "the box has stopped listening".
    process.env.CLAWBOX_MCP_TOKEN = TOKEN;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(
      await onBeforeDispatch({ content: "send AB2CD" }, { senderId: "6001", channelId: "telegram" }),
    ).toBeUndefined();
  });

  it("CLAIMS on a timeout, because the mail may already have gone", () => {
    // ClawBox answers only once the whole send has finished. Failing open here
    // would hand the model a "send <code>" it can only answer by queueing the
    // same mail a second time; ClawBox posts the verdict itself.
    process.env.CLAWBOX_MCP_TOKEN = TOKEN;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    }));
    return expect(
      onBeforeDispatch({ content: "send AB2CD" }, { senderId: "6001", channelId: "telegram" }),
    ).resolves.toEqual({ handled: true });
  });

  it("does not offer a message it cannot place on a surface", async () => {
    process.env.CLAWBOX_MCP_TOKEN = TOKEN;
    const calls = stubClawbox({ handled: true });
    expect(await onBeforeDispatch({ content: "send AB2CD" }, { senderId: "6001" })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("does not invent a sender, and does not ask without one", async () => {
    process.env.CLAWBOX_MCP_TOKEN = TOKEN;
    const calls = stubClawbox({ handled: true, reply: "Sent." });
    expect(await onBeforeDispatch({ content: "send AB2CD" }, { channelId: "telegram" })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
