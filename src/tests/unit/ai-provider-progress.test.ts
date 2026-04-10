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
        detail: "Preparing llama.cpp for gemma4-e2b-it-q4_0...",
        progressPercent: null,
      });

      expect(
        getLlamaCppOverlayProgress("[llamacpp] Downloading gguf-org/gemma-4-e2b-it-gguf/file.gguf", 5),
      ).toEqual({
        phase: 1,
        detail: "[llamacpp] Downloading gguf-org/gemma-4-e2b-it-gguf/file.gguf",
        progressPercent: null,
      });

      expect(
        getLlamaCppOverlayProgress("[llamacpp] Starting llama-server with /models/gemma.gguf", 5),
      ).toEqual({
        phase: 2,
        detail: "[llamacpp] Starting llama-server with /models/gemma.gguf",
        progressPercent: null,
      });

      expect(
        getLlamaCppOverlayProgress("llama.cpp is ready. Applying ClawBox configuration...", 5),
      ).toEqual({
        phase: 3,
        detail: "llama.cpp is ready. Applying ClawBox configuration...",
        progressPercent: null,
      });
    });
  });
});
