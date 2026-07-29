/**
 * Shared positioning helper for popovers that must float above an anchor button
 * regardless of their surrounding DOM (which is often wrapped in `relative` and
 * `overflow-hidden` containers in the sidebar).
 *
 * Returns a `position: fixed` style so the popover escapes all ancestor
 * overflow clipping, plus viewport-relative coordinates computed from the
 * anchor's `getBoundingClientRect()`.
 */

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
  const top = popoverSize.height
    ? bottomEdge - popoverSize.height
    : Math.max(bottomEdge - 200, MARGIN);

  return { top: Math.round(top), left: Math.round(left), width: Math.round(width) };
}
