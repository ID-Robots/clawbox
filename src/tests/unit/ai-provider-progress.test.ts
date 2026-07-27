import { describe, expect, it } from "vitest";
import {
  getLlamaCppOverlayProgress,
  getOllamaOverlayProgress,
} from "@/lib/ai-provider-progress";

describe("ai-provider-progress", () => {
  describe("getOllamaOverlayProgress", () => {
    it("starts in a preparation step before download telemetry arrives", () => {
      expect(
        getOllamaOverlayProgress(
          { pulling: true, saving: false, pullProgress: null },
          4,
        ),
      ).toEqual({
        phase: 1,
        detail: "Downloading model files...",
        progressPercent: null,
      });
    });

    it("surfaces download percentage while pulling", () => {
      expect(
        getOllamaOverlayProgress(
          {
            pulling: true,
            saving: false,
            pullProgress: { status: "downloading", completed: 50, total: 100 },
          },
          4,
        ),
      ).toEqual({
        phase: 1,
        detail: "downloading",
        progressPercent: 50,
      });
    });

    it("moves to configuration once the model is downloaded", () => {
      expect(
        getOllamaOverlayProgress(
          { pulling: false, saving: true, pullProgress: null },
          4,
        ),
      ).toEqual({
        phase: 2,
        detail: "Applying ClawBox configuration...",
        progressPercent: null,
      });
    });
  });

  describe("getLlamaCppOverlayProgress", () => {
    it("recognizes download, startup, and configuration phases", () => {
      expect(
        getLlamaCppOverlayProgress("Preparing llama.cpp for gemma4-e2b-it-q4_0...", 5),
      ).toEqual({
        phase: 0,
        detail: null,
        progressPercent: null,
      });

      expect(
        getLlamaCppOverlayProgress("[llamacpp] Downloading gguf-org/gemma-4-e2b-it-gguf/file.gguf", 5),
      ).toEqual({
        phase: 1,
        detail: null,
        progressPercent: null,
      });

      expect(
        getLlamaCppOverlayProgress("[llamacpp] Starting llama-server with /models/gemma.gguf", 5),
      ).toEqual({
        phase: 2,
        detail: null,
        progressPercent: null,
      });

      expect(
        getLlamaCppOverlayProgress("llama.cpp is ready. Applying ClawBox configuration...", 5),
      ).toEqual({
        phase: 3,
        detail: null,
        progressPercent: null,
      });
    });

    // A cold box builds llama.cpp from source before Gemma can start. The
    // install route streams those journal lines tagged with a phase-stable
    // prefix; the raw lines (cmake, hf, apt) match no phase keyword, so
    // without the prefix the wizard would snap back to step 1 on every line
    // and the user would see a spinner with no explanation for ~an hour.
    it("keeps the provisioning phase pinned and surfaces the streamed line as detail", () => {
      expect(
        getLlamaCppOverlayProgress(
          "Installing Gemma 4 for offline use — Installing llama.cpp server (CUDA=ON)...",
          5,
        ),
      ).toEqual({
        phase: 1,
        detail: "Installing llama.cpp server (CUDA=ON)...",
        progressPercent: null,
      });

      expect(
        getLlamaCppOverlayProgress(
          "Installing Gemma 4 for offline use — Downloading Gemma 4 GGUF for offline use...",
          5,
        ),
      ).toEqual({
        phase: 1,
        detail: "Downloading Gemma 4 GGUF for offline use...",
        progressPercent: null,
      });
    });

    it("leaves detail null when there is no streamed line", () => {
      expect(getLlamaCppOverlayProgress("Installing Gemma 4 for offline use...", 5).detail).toBeNull();
    });
  });
});
