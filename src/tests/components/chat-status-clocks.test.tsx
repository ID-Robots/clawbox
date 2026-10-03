// The mascot chat's ticking counters, each on an interval of its own.
//
// They used to be state in ChatPopup, so every tick re-rendered the whole
// popup: once a second for every turn (even with the chat closed), once a
// second while a reply was being spoken, five times a second while the
// microphone recorded. These pin that each one still reads exactly as the
// popup's own counter read, and that a tick is the clock's render alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { act, cleanup, render, screen } from "@/tests/helpers/test-utils";
import { RecordingClock, SpeakingReplyLabel, TurnClock } from "@/components/ChatStatusClocks";

const T0 = new Date("2026-10-02T12:00:00Z").getTime();
const t = (key: string, params?: Record<string, string | number>) =>
  `${key}:${params?.seconds}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TurnClock", () => {
  it("counts the turn in seconds, then minutes and seconds", () => {
    const { container } = render(<TurnClock startedAt={T0} />);
    expect(container.textContent).toBe("· 0s");

    act(() => { vi.advanceTimersByTime(1000); });
    expect(container.textContent).toBe("· 1s");

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(container.textContent).toBe("· 1m 1s");
  });

  it("is kept out of the live region's announcement", () => {
    const { container } = render(<TurnClock startedAt={T0} />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("starts again from 0 for a new turn", () => {
    const { container, rerender } = render(<TurnClock startedAt={T0} />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(container.textContent).toBe("· 5s");

    rerender(<TurnClock startedAt={T0 + 5000} />);
    expect(container.textContent).toBe("· 0s");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(container.textContent).toBe("· 1s");
  });
});

describe("SpeakingReplyLabel", () => {
  it("counts whole seconds since the box started on the sound", () => {
    render(<SpeakingReplyLabel since={T0} t={t} />);
    expect(screen.getByText("chat.speakingReply:0")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText("chat.speakingReply:1")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(12_000); });
    expect(screen.getByText("chat.speakingReply:13")).toBeTruthy();
  });

  it("counts the next reply from 0, even when it starts the moment the last one ended", () => {
    const { rerender } = render(<SpeakingReplyLabel since={T0} t={t} />);
    act(() => { vi.advanceTimersByTime(7000); });
    expect(screen.getByText("chat.speakingReply:7")).toBeTruthy();

    rerender(<SpeakingReplyLabel since={T0 + 7000} t={t} />);
    expect(screen.getByText("chat.speakingReply:0")).toBeTruthy();
  });
});

describe("RecordingClock", () => {
  it("reads m:ss from the moment the recording started", () => {
    render(<RecordingClock />);
    const clock = screen.getByTestId("voice-clock");
    expect(clock.textContent).toBe("0:00");
    expect(clock.getAttribute("aria-hidden")).toBe("true");

    act(() => { vi.advanceTimersByTime(1000); });
    expect(clock.textContent).toBe("0:01");

    act(() => { vi.advanceTimersByTime(64_000); });
    expect(clock.textContent).toBe("1:05");
  });

  it("turns the second over within a fifth of a second, and renders only when it does", () => {
    const commits = vi.fn();
    render(<Profiler id="clock" onRender={commits}><RecordingClock /></Profiler>);
    const mounted = commits.mock.calls.length;

    // Four looks in five see the same second: none of them is a render.
    act(() => { vi.advanceTimersByTime(800); });
    expect(screen.getByTestId("voice-clock").textContent).toBe("0:00");
    expect(commits.mock.calls.length).toBe(mounted);

    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByTestId("voice-clock").textContent).toBe("0:01");
    expect(commits.mock.calls.length).toBe(mounted + 1);
  });
});
