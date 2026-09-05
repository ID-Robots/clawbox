import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

// One walk through the desktop's Settings window, section by section, in the
// order the sidebar lists them today: Providers (where the window opens), Local
// AI, Channels, Voice, Network, Appearance, System, About — then the Coding
// Agent's own Settings page, which lives in that app rather than here.
//
// The AI Provider panel itself (the embedded AIModelsStep) is only mounted
// here, not driven — its inline sign-in forms belong in a focused spec — but
// visiting it still covers the `embedded` render branch of the wizard's
// biggest component.
//
// The assertions that matter most are the NEGATIVE ones on the Local AI tab:
// an engine the box does not have must read as absent and must not come with
// a control, because offering a switch that cannot work is the drift that tab
// was built to end. The helper's mocks describe ONE box, and every surface is
// asserted against the same facts: ClawBox AI is linked (so the cloud voice and
// cloud transcription exist and the on-device model is the fallback), Kokoro is
// installed and speaking, Whisper is absent. One fact is changed on the Voice
// tab and read back on Local AI, to prove the two surfaces are reading the same
// state rather than two copies of it. The unlinked box — where the cloud voice
// must read as unavailable — is the second test below.
test("settings covers providers, local AI, coding agent, channels, voice, network, appearance, system, and about flows", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      local_ai_configured: true,
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
      ai_model_configured: true,
      telegram_configured: false,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await page.getByTestId("shelf-app-settings").click();
  const settingsWindow = page.getByTestId("chrome-window-settings");
  await expect(settingsWindow).toBeVisible();

  // The sidebar. Each row's accessible name is the icon ligature, the label
  // and an sr-only status subtitle ("palette Appearance clawbox"), so rows are
  // found by their label inside the nav — never by exact name, and never by a
  // label that could also match a button inside the pane.
  const nav = settingsWindow.getByRole("navigation");
  const section = (label: RegExp) => nav.getByRole("button", { name: label });

  // ── Providers: the connection overview and the embedded provider panel.
  // Settings opens on Appearance (the page an owner comes here for), so the
  // row is clicked first — its status subtitle is only read once the section
  // is open. ClawBox AI is linked, so the sidebar names it.
  await section(/Providers/).click();
  await expect(section(/Providers/)).toContainText("ClawBox AI");
  await expect(settingsWindow.getByTestId("ai-provider-list")).toBeVisible();
  await expect(settingsWindow.getByRole("radiogroup", { name: "AI Provider" })).toBeVisible();
  await expect(settingsWindow.getByRole("radio", { name: /ClawBox AI/ })).toBeChecked();

  // ── Local AI: one grouped inventory, friendly names only, the actions
  // behind a per-row menu. No radiogroup lives here at all any more — neither
  // the provider picker this panel replaced nor the Ollama library, whose
  // search-and-pull card has gone back to being a Terminal job.
  await section(/Local AI/).click();
  const localAi = settingsWindow.getByTestId("local-ai-panel");
  await expect(localAi).toBeVisible();
  await expect(localAi).toContainText("AI that runs on this box, and what each part is doing right now.");
  await expect(localAi.getByRole("radiogroup", { name: "AI Provider" })).toHaveCount(0);
  await expect(localAi.getByTestId("local-ai-ollama")).toHaveCount(0);
  await expect(localAi.getByText("gemma4-e2b-it-q4_0")).toHaveCount(0);

  await expect(localAi.getByTestId("local-ai-group-llm").getByRole("heading", { name: "AI agent model" })).toBeVisible();
  const gemmaRow = localAi.getByTestId("local-model-llamacpp");
  await expect(gemmaRow).toContainText("Gemma 4");
  await expect(gemmaRow.getByText("On", { exact: true })).toBeVisible();
  // ClawBox AI answers first, so the on-device model is the fallback.
  await expect(gemmaRow.getByTestId("local-model-role-llamacpp")).toHaveText("Fallback");
  // Local-only mode is offered once the box has a local model to route to.
  await expect(localAi.getByTestId("local-ai-local-only")).toHaveAttribute("aria-checked", "false");

  // The Ollama row is gone: the memory embedder runs on llama.cpp, and Ollama
  // was retired from the provider picker before that.
  await expect(localAi.getByTestId("local-model-ollama")).toHaveCount(0);

  // Memory search is the embedder's own row: Qwen 3 on this box's llama.cpp,
  // woken by the proxy on the first search and asleep in between. It carries
  // no role and no switch — Memory Shard owns it — only the pointer there.
  const memoryRow = localAi.getByTestId("local-model-embeddings");
  await expect(memoryRow.getByText("Qwen 3 via llama.cpp")).toBeVisible();
  await expect(memoryRow.getByText(/Disk 609 MB/)).toBeVisible();
  await expect(memoryRow.getByTestId("local-model-role-embeddings")).toHaveCount(0);
  await expect(memoryRow.getByTestId("local-model-menu-embeddings")).toHaveCount(0);
  await expect(memoryRow.getByTestId("local-model-manage-embeddings")).toBeVisible();

  await expect(localAi.getByTestId("local-ai-group-tts").getByRole("heading", { name: "Voice (text to speech)" })).toBeVisible();
  const kokoroRow = localAi.getByTestId("local-model-kokoro");
  await expect(kokoroRow.getByText("On", { exact: true })).toBeVisible();
  // Cloud-first is the standing voice order, so the voice on the box is the
  // fallback. The Voice tab below flips that, and this row is read again.
  await expect(kokoroRow.getByTestId("local-model-role-kokoro")).toHaveText("Fallback");

  // NEGATIVE: Whisper is not on this box. It must read as absent, carry no
  // role, and offer no control of any kind — no switch, no menu.
  await expect(localAi.getByTestId("local-ai-group-stt").getByRole("heading", { name: "Speech to text" })).toBeVisible();
  const whisperRow = localAi.getByTestId("local-model-whisper");
  await expect(whisperRow.getByText("Not installed", { exact: true })).toBeVisible();
  await expect(whisperRow.getByText("Not installed. Speech is transcribed in the cloud.")).toBeVisible();
  await expect(whisperRow.getByRole("switch")).toHaveCount(0);
  await expect(whisperRow.getByRole("button")).toHaveCount(0);
  await expect(whisperRow.getByTestId("local-model-role-whisper")).toHaveCount(0);

  // ── Channels: a hub row per channel; Telegram is configured inside it.
  await section(/Channels/).click();
  await expect(settingsWindow.getByTestId("settings-channels-list")).toBeVisible();
  await settingsWindow.getByTestId("settings-channel-telegram").click();
  await settingsWindow.locator("#settings-tg-token").fill("123456789:ABCdefGHI");
  await settingsWindow.getByRole("button", { name: /Connect$/ }).click();
  await expect(settingsWindow.getByText("Bot Connected").last()).toBeVisible();
  await settingsWindow.getByTestId("settings-channels-back").click();
  await expect(settingsWindow.getByTestId("settings-channel-telegram")).toContainText("Bot Connected");

  // ── Voice: three selects and a sentence to hear. Both engines are real on
  // this box — Kokoro is installed and the linked ClawBox AI account brings
  // the cloud voice — so neither option is greyed out; the cloud goes first
  // until the owner picks the box, and the voice list follows the engine.
  await section(/Voice/).click();
  const voice = settingsWindow.getByTestId("voice-panel");
  const source = voice.getByTestId("voice-source");
  await expect(source).toHaveValue("cloud");
  await expect(source.locator("option[value=cloud]")).toHaveJSProperty("disabled", false);
  await expect(source.locator("option[value=local]")).toHaveJSProperty("disabled", false);
  // The privacy notice the panel used to draw under a cloud-first source is
  // gone (src/tests/components/voice-output-panel.test.tsx pins its absence);
  // the box still sends the fact, the settings page just no longer nags.
  await expect(voice.getByTestId("voice-cloud-warning")).toHaveCount(0);
  await expect(voice.getByTestId("voice-voice")).toHaveValue("alloy");
  await expect(voice.getByTestId("voice-language")).toHaveValue("en");

  await source.selectOption("local");
  await expect(source).toHaveValue("local");
  await expect(voice.getByTestId("voice-cloud-warning")).toHaveCount(0);
  await expect(voice.getByTestId("voice-voice")).toHaveValue("af_heart");
  await voice.getByTestId("voice-voice").selectOption("bm_george");
  await expect(voice.getByTestId("voice-voice")).toHaveValue("bm_george");

  // The sample sentence follows the language, and the box's own voice says
  // so when it cannot speak that language.
  await voice.getByTestId("voice-language").selectOption("de");
  await expect(voice.getByTestId("voice-sample-text")).toHaveValue(/^Hallo! Ich bin dein ClawBox-Assistent/);
  await expect(voice.getByTestId("voice-local-english-only")).toBeVisible();

  // Play speaks THAT text with THAT engine and THAT voice — one engine, not
  // the fall-through chain — and hands the clip to a player. The request is
  // the first assertion: it must carry exactly what the three controls show.
  const sampleRequest = page.waitForRequest((req) => req.url().includes("/setup-api/tts/sample") && req.method() === "POST");
  await voice.getByTestId("voice-play").click();
  const sampleBody = (await sampleRequest).postDataJSON() as { engine: string; voice: string; text: string };
  expect(sampleBody.engine).toBe("local");
  expect(sampleBody.voice).toBe("bm_george");
  expect(sampleBody.text).toMatch(/^Hallo! Ich bin dein ClawBox-Assistent/);

  // The second assertion is that the clip then PLAYS. The mock answers a real
  // WAV, and the panel hands it to the player as a blob: URL, which the page's
  // Content-Security-Policy must allow: media falls back to `default-src
  // 'self'` unless `media-src` names blob:, and a policy without it refuses
  // the load in every browser ("Media load rejected by URL safety check") —
  // the player's onError alert fires for real users, not just here. So the
  // spec waits for the element to settle one way or the other and demands the
  // decoded way: no error on the element, no alert in the panel.
  const audio = voice.getByTestId("voice-sample-audio");
  await expect(audio).toBeAttached();
  await expect
    .poll(() => audio.evaluate((element) => {
      const player = element as HTMLAudioElement;
      if (player.error) return `error ${player.error.code}: ${player.error.message}`;
      return player.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? "decoded" : "loading";
    }), { message: "the sample clip should decode in the browser (needs media-src 'self' blob: in the CSP)" })
    .toBe("decoded");
  await expect(voice.getByRole("alert")).toHaveCount(0);

  // The order chosen on the Voice tab is the role Local AI reports: one
  // state, read from two places.
  await section(/Local AI/).click();
  await expect(settingsWindow.getByTestId("local-model-role-kokoro")).toHaveText("Primary");

  // ── Network
  await section(/Network/).click();
  await settingsWindow.getByRole("button", { name: "Available Networks" }).click();
  await settingsWindow.getByRole("button", { name: "Guest Network" }).click();
  await settingsWindow.getByPlaceholder("Enter WiFi password").fill("guest-pass");
  await settingsWindow.getByRole("button", { name: /Connect$/ }).last().click();
  await expect(settingsWindow.getByText("Guest Network").first()).toBeVisible();

  // ── Appearance
  await section(/Appearance/).click();
  await settingsWindow.getByRole("button", { name: "Deep Space" }).click();
  await settingsWindow.getByRole("button", { name: "Fit" }).click();
  await settingsWindow.locator('input[type="range"]').evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "72";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settingsWindow.getByRole("button", { name: /English/ }).first().click();
  await expect(settingsWindow.getByRole("button", { name: "Deutsch" })).toBeVisible();
  await settingsWindow.getByRole("button", { name: /English/ }).first().click();

  // ── System
  // "System" and not "System Update": the name also carries the icon glyph and a subtitle.
  await section(/\bSystem\b(?! Update)/).click();
  await expect(settingsWindow.getByText("clawbox", { exact: true })).toBeVisible();
  await expect(settingsWindow.getByText("Ubuntu 24.04")).toBeVisible();

  // ── About
  await section(/About/).click();
  await expect(settingsWindow.getByText("Documentation")).toBeVisible();
  await expect(settingsWindow.getByText("Discord Community")).toBeVisible();

  // ── Coding Agent: its settings live in the Coding Agent app now, behind
  // its own Settings button — not in this window's sidebar. The switch is
  // not optimistic: the panel renders whatever the route answers.
  await page.getByTestId("shelf-app-coding").click();
  const codingWindow = page.getByTestId("chrome-window-coding");
  await expect(codingWindow).toBeVisible();
  // A wide window carries Settings in its rail and draws no header row (no
  // state chip either); a narrow one has the row with both. Whichever this
  // window has — the switch inside the panel is the fact under test.
  // The rail is measured, not a breakpoint: the first paint is the narrow
  // row and the rail replaces it a tick later, so wait for the layout to
  // settle before deciding which shape this window has.
  const rail = codingWindow.getByTestId("coding-agent-sidebar");
  const stateChip = codingWindow.getByTestId("coding-agent-state");
  // Presence, not visibility, is the discriminator: the row is drawn iff
  // there is no rail. Give the observer a moment to report the width.
  await expect(codingWindow.getByTestId("coding-agent-sidebar-settings").or(codingWindow.getByTestId("coding-agent-open-settings")).first()).toBeAttached();
  await page.waitForTimeout(1500);
  const hasRail = (await rail.count()) > 0;
  if (!hasRail) await expect(stateChip).toContainText("Off");
  await (hasRail ? codingWindow.getByTestId("coding-agent-sidebar-settings") : codingWindow.getByTestId("coding-agent-open-settings")).click();
  const codingAgent = codingWindow.getByTestId("coding-agent-settings-panel");
  const agentSwitch = codingAgent.getByRole("switch", { name: "Let the assistant delegate coding work" });
  await expect(agentSwitch).toHaveAttribute("aria-checked", "false");
  await expect(codingAgent.getByTestId("coding-agent-folder")).toHaveValue("/home/clawbox/projects");
  await expect(codingAgent.getByTestId("coding-agent-effort-max")).toBeVisible();
  await agentSwitch.click();
  await expect(agentSwitch).toHaveAttribute("aria-checked", "true");
  // The header's state chip (a narrow window only) reads the status the panel just published.
  if (!hasRail) await expect(stateChip).toContainText("On");
});

// The other half of the Voice tab's contract: a cloud voice this box cannot
// call must read as unavailable, not as a choice that would fail on use. The
// helper derives the cloud voice from the same setup fact as every other
// surface, so an unlinked box is asserted end to end — Providers says nothing
// is connected, the on-device model answers first, and the cloud option is
// greyed out with no privacy notice, because no words can leave this box.
test("settings reads an unlinked box's cloud voice as unavailable", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      local_ai_configured: true,
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
      ai_model_configured: false,
      telegram_configured: false,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  await page.getByTestId("shelf-app-settings").click();
  const settingsWindow = page.getByTestId("chrome-window-settings");
  await expect(settingsWindow).toBeVisible();
  const nav = settingsWindow.getByRole("navigation");
  const section = (label: RegExp) => nav.getByRole("button", { name: label });

  await section(/Providers/).click();
  await expect(section(/Providers/)).toContainText("Not configured");

  await section(/Local AI/).click();
  const localAi = settingsWindow.getByTestId("local-ai-panel");
  await expect(localAi.getByTestId("local-model-role-llamacpp")).toHaveText("Primary");

  await section(/Voice/).click();
  const voice = settingsWindow.getByTestId("voice-panel");
  const source = voice.getByTestId("voice-source");
  const cloudOption = source.locator("option[value=cloud]");
  await expect(cloudOption).toHaveJSProperty("disabled", true);
  await expect(cloudOption).toHaveText(/not available/);
  await expect(source.locator("option[value=local]")).toHaveJSProperty("disabled", false);
  await expect(voice.getByTestId("voice-cloud-warning")).toHaveCount(0);

  // The greyed-out option is why no click can send this request, so the mock's
  // answer is asked for directly: the real route refuses a cloud voice this box
  // cannot call with a 409, and a mock that said 200 instead would let a future
  // control that skipped the greying pass against a box it would fail on.
  const refused = await page.evaluate(async () => {
    const res = await fetch("/setup-api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "select", choice: "cloud" }),
    });
    return { status: res.status, body: await res.json() as { error?: string } };
  });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe("That voice is not available on this box.");
  await expect(source).toHaveValue("local");
});

// The local row on Providers is whichever engine the box runs, not a fixed
// Gemma 4: the setup mocks can leave Ollama as the local provider, and the
// real route names it "Ollama Local" under the id `ollama`. Unlinked, so that
// row is the default and the hero has to say its name.
test("settings names the local engine the box actually runs", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      local_ai_configured: true,
      local_ai_provider: "ollama",
      local_ai_model: "ollama/llama3.2:3b",
      ai_model_configured: false,
      telegram_configured: false,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  await page.getByTestId("shelf-app-settings").click();
  const settingsWindow = page.getByTestId("chrome-window-settings");
  await expect(settingsWindow).toBeVisible();
  await settingsWindow.getByRole("navigation").getByRole("button", { name: /Providers/ }).click();

  const hero = settingsWindow.getByTestId("provider-default-hero");
  await expect(hero).toContainText("Ollama Local");
  await expect(hero).not.toContainText("Gemma 4");
});
