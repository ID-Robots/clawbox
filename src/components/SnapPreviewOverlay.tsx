"use client";

import { getSnapRect, type SnapZone } from "@/lib/window-snap";

/** The translucent plate that shows where a dragged surface would land. */
export default function SnapPreviewOverlay(
  { zone, rightInset = 0 }: { zone: SnapZone; rightInset?: number },
) {
  const rect = getSnapRect(zone, rightInset);
  if (!rect) return null;
  return (
    <div
      data-testid="snap-preview"
      style={{
        position: "fixed",
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        background: "rgba(59, 130, 246, 0.15)",
        border: "2px solid rgba(59, 130, 246, 0.5)",
        borderRadius: 8,
        zIndex: 99999,
        pointerEvents: "none",
        transition: "all 0.15s ease-out",
      }}
    />
  );
}
