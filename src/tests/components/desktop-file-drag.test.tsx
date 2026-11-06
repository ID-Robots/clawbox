/**
 * The desktop's own file drop ("Drop files to upload — saved to Downloads"):
 * its overlay is up only while a drag of files is over the desktop, and can
 * never stay up after the drag — also when an app's drop zone under the
 * pointer takes the drop and stops it, so the desktop never hears it.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_DRAG_IDLE_MS, useDesktopFileDrag } from "@/lib/use-desktop-file-drag";

/**
 * The desktop's shape: a root with the hook's handlers, and an app's drop zone
 * that takes its drops and stops them — but, like Prime Radiant's Add zone
 * did, lets its dragenter through to the desktop.
 */
function Desktop({ onAppDrop = () => undefined }: { onAppDrop?: () => void }) {
  const { dragOver, dropHandlers } = useDesktopFileDrag();
  return (
    <div data-testid="desktop" {...dropHandlers}>
      <div data-testid="wallpaper" />
      <section
        data-testid="app-zone"
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onAppDrop(); }}
      >
        <p data-testid="app-zone-child">Drop documents here</p>
      </section>
      {dragOver && <div data-testid="desktop-drop-overlay">Drop files to upload</div>}
    </div>
  );
}

const files = { types: ["Files"], files: [] };
const overlay = () => screen.queryByTestId("desktop-drop-overlay");

afterEach(() => {
  vi.useRealTimers();
});

describe("the desktop's file-drop overlay", () => {
  it("is up while a drag of files is over the desktop and comes down when it leaves", () => {
    render(<Desktop />);
    fireEvent.dragEnter(screen.getByTestId("wallpaper"), { dataTransfer: files });
    expect(overlay()).not.toBeNull();
    fireEvent.dragLeave(screen.getByTestId("wallpaper"), { dataTransfer: files });
    expect(overlay()).toBeNull();
  });

  it("never lights for a drag that carries no files", () => {
    render(<Desktop />);
    fireEvent.dragEnter(screen.getByTestId("wallpaper"), { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(overlay()).toBeNull();
  });

  it("comes down when an app's drop zone takes the drop and stops it", () => {
    const onAppDrop = vi.fn();
    render(<Desktop onAppDrop={onAppDrop} />);
    // Over the wallpaper, then onto the app's zone: the zone's own dragenter
    // reaches the desktop, the wallpaper's dragleave too — one still counted.
    fireEvent.dragEnter(screen.getByTestId("wallpaper"), { dataTransfer: files });
    fireEvent.dragEnter(screen.getByTestId("app-zone-child"), { dataTransfer: files });
    fireEvent.dragLeave(screen.getByTestId("wallpaper"), { dataTransfer: files });
    fireEvent.dragOver(screen.getByTestId("app-zone-child"), { dataTransfer: files });
    expect(overlay()).not.toBeNull();
    // The drop the app takes never reaches the desktop's handlers…
    fireEvent.drop(screen.getByTestId("app-zone-child"), { dataTransfer: files });
    expect(onAppDrop).toHaveBeenCalledTimes(1);
    // …and the overlay is gone all the same, at once.
    expect(overlay()).toBeNull();
  });

  it("comes down on a dragend in the page", () => {
    render(<Desktop />);
    fireEvent.dragEnter(screen.getByTestId("wallpaper"), { dataTransfer: files });
    expect(overlay()).not.toBeNull();
    fireEvent.dragEnd(screen.getByTestId("wallpaper"), { dataTransfer: files });
    expect(overlay()).toBeNull();
  });

  it("comes down once no dragover was heard for a while, and stays while they come", () => {
    vi.useFakeTimers();
    render(<Desktop />);
    fireEvent.dragEnter(screen.getByTestId("wallpaper"), { dataTransfer: files });
    expect(overlay()).not.toBeNull();
    // A drag still over the page keeps sending dragover — also over an app's
    // zone that stops it: the overlay stays.
    for (let i = 0; i < 5; i++) {
      act(() => { vi.advanceTimersByTime(DESKTOP_DRAG_IDLE_MS / 2); });
      fireEvent.dragOver(screen.getByTestId("app-zone-child"), { dataTransfer: files });
    }
    expect(overlay()).not.toBeNull();
    // The drag ended where the page could not hear it: down after the idle time.
    act(() => { vi.advanceTimersByTime(DESKTOP_DRAG_IDLE_MS - 1); });
    expect(overlay()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(overlay()).toBeNull();
  });

  it("lights again for the next drag after one an app took", () => {
    render(<Desktop />);
    fireEvent.dragEnter(screen.getByTestId("app-zone-child"), { dataTransfer: files });
    fireEvent.drop(screen.getByTestId("app-zone-child"), { dataTransfer: files });
    expect(overlay()).toBeNull();
    // The count started from zero again: one enter and one leave is a whole drag.
    fireEvent.dragEnter(screen.getByTestId("wallpaper"), { dataTransfer: files });
    expect(overlay()).not.toBeNull();
    fireEvent.dragLeave(screen.getByTestId("wallpaper"), { dataTransfer: files });
    expect(overlay()).toBeNull();
  });
});
