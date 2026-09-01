// @vitest-environment jsdom
/**
 * The window-level events shared between page.tsx and the components, and
 * the prompts that ride on two of them.
 *
 * CHAT_MESSAGE_EVENT is what the Coding Agent's New wizard ends in: it must
 * carry the text under `detail.text`, the shape ChatPopup reads, and the
 * prompt it carries must be the one sentence the wizard promised — with the
 * template named the way code_project_init spells it.
 */
import { describe, expect, it } from "vitest";
import {
  buildFixErrorPrompt,
  buildNewAppPrompt,
  CHAT_MESSAGE_EVENT,
  CODING_AGENT_CHANGED_EVENT,
  dispatchChatMessage,
  dispatchFixError,
  FIX_ERROR_EVENT,
  handoffSettingsSection,
  notifyCodingAgentChanged,
  onCodingAgentChanged,
  onStandaloneAppPage,
  OPEN_APP_EVENT,
  OPEN_SETTINGS_SECTION_EVENT,
  standaloneSettingsHref,
  type ChatMessageDetail,
} from "@/lib/ui-events";

describe("dispatchChatMessage", () => {
  it("dispatches CHAT_MESSAGE_EVENT with the text under detail.text, as dispatchFixError does for its context", () => {
    const seen: ChatMessageDetail[] = [];
    const onMessage = (e: Event) => seen.push((e as CustomEvent<ChatMessageDetail>).detail);
    window.addEventListener(CHAT_MESSAGE_EVENT, onMessage);
    const fixes: unknown[] = [];
    const onFix = (e: Event) => fixes.push((e as CustomEvent).detail);
    window.addEventListener(FIX_ERROR_EVENT, onFix);
    try {
      dispatchChatMessage("Build me a timer.");
      dispatchFixError({ source: "Files", message: "EACCES" });
      expect(seen).toEqual([{ text: "Build me a timer." }]);
      expect(fixes).toEqual([{ source: "Files", message: "EACCES" }]);
      // Distinct names: a chat message is not an error report.
      expect(CHAT_MESSAGE_EVENT).not.toBe(FIX_ERROR_EVENT);
      expect(CHAT_MESSAGE_EVENT).toBe("clawbox:chat-message");
    } finally {
      window.removeEventListener(CHAT_MESSAGE_EVENT, onMessage);
      window.removeEventListener(FIX_ERROR_EVENT, onFix);
    }
  });
});

describe("buildNewAppPrompt", () => {
  it("composes the one message the wizard hands to the chat", () => {
    expect(buildNewAppPrompt({ name: "Pomodoro timer", description: "A 25/5 timer with a sound", template: "app" })).toBe(
      'Create a new ClawBox app called "Pomodoro timer": A 25/5 timer with a sound.\n'
      + 'Scaffold it as a small HTML/CSS/JS app in a new git folder under my project folder — not as a code project under ClawBox\'s own data directory — build it with the coding agent, verify it in the browser, and put it on my desktop with an icon.',
    );
  });

  it("asks for a folder under the project folder, and ends the description once", () => {
    const text = buildNewAppPrompt({ name: "  Notes ", description: "Keep short notes.  ", template: "blank" });
    expect(text).toContain('called "Notes": Keep short notes.\n');
    expect(text).not.toContain("notes..");
    // NOT a code project: those live at data/code-projects/<id>, inside
    // ClawBox's own checkout — so `git` there resolves to the PRODUCT's
    // repository, and the project page showed ClawBox's branch, its commit
    // count and its remote as if they belonged to the new app.
    expect(text).toContain("new git folder under my project folder");
    expect(text).not.toContain('from the "blank" template');
  });

  it("keeps every template out of ClawBox's own data directory", () => {
    for (const template of ["nextjs", "react", "app", "blank"] as const) {
      const text = buildNewAppPrompt({ name: "x", description: "y", template });
      expect(text, template).toContain("under my project folder");
    }
  });

  it("is a different prompt from a fix-error one — it asks for a build, not an investigation", () => {
    const fix = buildFixErrorPrompt({ source: "Files", message: "EACCES" });
    const build = buildNewAppPrompt({ name: "x", description: "y", template: "app" });
    expect(fix).toContain("logs_tail");
    expect(build).not.toContain("logs_tail");
    expect(build).toContain("coding agent");
  });
});

describe("the standalone Settings handoff", () => {
  it("hands the section over both ways without opening an app", () => {
    // The standalone page is already rendering Settings; the only thing it
    // has to say is which section. An open-app event there has no listener,
    // so the helper must not send one.
    const sections: string[] = [];
    const apps: string[] = [];
    const onSection = (e: Event) => sections.push((e as CustomEvent<{ section: string }>).detail.section);
    const onApp = () => apps.push("opened");
    window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, onSection);
    window.addEventListener(OPEN_APP_EVENT, onApp);
    try {
      handoffSettingsSection("codingAgent");
      expect(sections).toEqual(["codingAgent"]);
      expect(apps).toEqual([]);
      expect((window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection).toBe("codingAgent");
    } finally {
      window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, onSection);
      window.removeEventListener(OPEN_APP_EVENT, onApp);
      delete (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection;
    }
  });

  it("knows the /app/<id> page from the desktop, and spells the Settings address once", () => {
    expect(onStandaloneAppPage()).toBe(false);
    window.history.pushState({}, "", "/app/coding");
    try {
      expect(onStandaloneAppPage()).toBe(true);
    } finally {
      window.history.pushState({}, "", "/");
    }
    expect(standaloneSettingsHref("codingAgent")).toBe("/app/settings?section=codingAgent");
    // The query is URL-encoded, so a section id can never break the address.
    expect(standaloneSettingsHref("a b&c")).toBe("/app/settings?section=a%20b%26c");
  });
});

describe("the coding agent changed signal", () => {
  it("reaches a subscriber until it unsubscribes, and carries no data", () => {
    const seen: Event[] = [];
    const off = onCodingAgentChanged(() => { seen.push(new Event(CODING_AGENT_CHANGED_EVENT)); });
    notifyCodingAgentChanged();
    expect(seen).toHaveLength(1);
    off();
    notifyCodingAgentChanged();
    expect(seen).toHaveLength(1);
    expect(CODING_AGENT_CHANGED_EVENT).toBe("clawbox:coding-agent-changed");
  });
});
