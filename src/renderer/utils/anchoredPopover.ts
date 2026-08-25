/**
 * Shared positioning helper for popovers that must float above an anchor button
 * regardless of their surrounding DOM (which is often wrapped in `relative` and
 * `overflow-hidden` containers in the sidebar).
 *
 * Returns a `position: fixed` style so the popover escapes all ancestor
 * overflow clipping, plus viewport-relative coordinates computed from the
 * anchor's `getBoundingClientRect()`.
 */

import React from 'react';

export type PopoverPlacement = {
  top: number;
  left: number;
  /** Width to apply so the popover never overflows the viewport. */
  width?: number;
};

const MARGIN = 8;

/**
 * Compute a placement for an "above the anchor" popover.
 *
 * Horizontal behaviour (the rule requested for these toolbars):
 *  - grow to the LEFT by default (right edge aligned to the anchor's right edge);
 *  - if there isn't enough room on the left, grow to the RIGHT instead
 *    (left edge aligned to the anchor's left edge).
 *
 * This single rule keeps the skills button (left-ish in cowork, right-ish in the
 * bot browser) and the folder button (rightmost in both) correctly placed in
 * every context.
 *
 * @param anchorRect  The anchor element's rect (e.g. from getBoundingClientRect).
 * @param popoverSize Measured size of the rendered popover. Pass `{ width, height }`
 *                    after the popover has been laid out. Until measured, `height`
 *                    may be omitted and the popover is placed relative to the
 *                    anchor's top edge.
 * @param desiredWidth The popover's intrinsic width (e.g. 288 for `w-72`).
 */
export function placePopoverAbove(
  anchorRect: DOMRect | null,
  popoverSize: { width: number; height?: number },
  desiredWidth: number,
): PopoverPlacement {
  const viewportWidth = window.innerWidth;
  const anchorRight = anchorRect ? anchorRect.right : viewportWidth;
  const anchorLeft = anchorRect ? anchorRect.left : 0;
  const anchorTop = anchorRect ? anchorRect.top : 0;

  // Clamp width to whatever the viewport can comfortably hold.
  const maxWidth = Math.max(0, viewportWidth - MARGIN * 2);
  const width = Math.min(desiredWidth, maxWidth);

  // Decide horizontal direction based on available space.
  const spaceOnLeft = anchorRight - MARGIN; // room if growing left
  const spaceOnRight = viewportWidth - anchorLeft - MARGIN; // room if growing right
  const growLeft = spaceOnLeft >= width || spaceOnLeft >= spaceOnRight;

  let left: number;
  if (growLeft) {
    // Right edge aligned to anchor's right edge, clamped to the viewport.
    left = Math.min(
      Math.max(anchorRight - width, MARGIN),
      viewportWidth - width - MARGIN,
    );
  } else {
    // Left edge aligned to anchor's left edge, clamped to the viewport.
    left = Math.min(
      Math.max(anchorLeft, MARGIN),
      viewportWidth - width - MARGIN,
    );
  }

  // Vertically: sit above the anchor. We don't strictly need the measured
  // height; anchoring the bottom edge to the anchor's top works well and avoids
  // a layout-measurement dependency. A small gap mirrors the previous `mb-2`.
  const gap = 8;
  const bottomEdge = anchorTop - gap;
  // top = bottomEdge - height. If we don't have a height yet, fall back to
  // placing the bottom edge near the anchor (browsers will lay out downward).
  const unclampedTop = popoverSize.height
    ? bottomEdge - popoverSize.height
    : bottomEdge - 200;
  // In a short viewport the computed top can be negative; keep the popover's
  // top edge inside the window (it may then overlap the anchor, which is
  // still readable — being pushed out of the window is not).
  const top = Math.max(MARGIN, unclampedTop);

  return { top: Math.round(top), left: Math.round(left), width: Math.round(width) };
}

/**
 * Keep an anchored popover glued to its anchor while the anchor MOVES. Resize
 * and scroll listeners only catch window-level changes; they miss layout
 * shifts inside the sidebar (sidebar width drag, the composer textarea
 * auto-growing and pushing the toolbar up). A ResizeObserver on the anchor
 * cannot catch those either — the anchor's own box does not change, only its
 * position does. So while the popover is open we watch the anchor's rect on
 * every animation frame and re-place when it actually moved.
 */
export function useAnchorMoveWatcher(
  anchorRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  onMove: () => void,
): void {
  React.useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    let last: { left: number; top: number; width: number; height: number } | null = null;
    const tick = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) {
        const snapshot = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        if (last && (
          Math.abs(snapshot.left - last.left) > 0.5
          || Math.abs(snapshot.top - last.top) > 0.5
          || Math.abs(snapshot.width - last.width) > 0.5
          || Math.abs(snapshot.height - last.height) > 0.5
        )) {
          onMove();
          last = snapshot;
        } else if (!last) {
          last = snapshot;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // onMove is expected to be a stable callback (from useCallback).
  }, [enabled, anchorRef, onMove]);
}
