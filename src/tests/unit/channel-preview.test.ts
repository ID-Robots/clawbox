import { describe, expect, it } from "vitest";
import { enabledPreviewChannels, isPreviewChannelEnabled, PREVIEW_CHANNELS_ENV } from "@/lib/channel-preview";

// Preview channels are OFF unless the box's environment names them.

describe("preview channel flag", () => {
  it("is off with no variable, an empty one, or unknown names", () => {
    expect(enabledPreviewChannels({})).toEqual([]);
    expect(enabledPreviewChannels({ [PREVIEW_CHANNELS_ENV]: "" })).toEqual([]);
    expect(enabledPreviewChannels({ [PREVIEW_CHANNELS_ENV]: "whatsapp, imessage" })).toEqual([]);
    expect(isPreviewChannelEnabled("signal", {})).toBe(false);
  });

  it("switches on the channels it names, tolerating case and spaces", () => {
    expect(enabledPreviewChannels({ [PREVIEW_CHANNELS_ENV]: " Signal ,," })).toEqual(["signal"]);
    expect(isPreviewChannelEnabled("signal", { [PREVIEW_CHANNELS_ENV]: "signal" })).toBe(true);
  });
});
