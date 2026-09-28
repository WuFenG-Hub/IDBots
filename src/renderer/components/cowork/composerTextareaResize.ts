/**
 * Height bookkeeping for the composer's auto-growing textarea.
 *
 * Measuring the textarea means reading `scrollHeight`, which forces a
 * synchronous layout of the whole document; while a long transcript is mounted
 * that costs tens of milliseconds, so the composer must not do it on every
 * keystroke. These helpers keep the read off the keystroke path by deciding,
 * from plain values only, whether a fresh measurement can change anything:
 *
 * - `charsPerRowBound` bounds how much text certainly fits into one visual row.
 * - `mayChangeRowCount` proves when two values render the same number of rows,
 *   which is what makes a cached height reusable.
 * - `shouldRemeasureComposerHeight` combines that proof with the two other
 *   inputs a height depends on: the min/max clamps and the content width.
 *
 * Every decision here fails towards measuring: an unknown width, a changed
 * line count, or a line long enough to maybe wrap all ask for a measurement.
 */

/**
 * What the last applied height was measured for. The height depends on the
 * value's rows, the box width and the clamp, and the record captures all three
 * at the moment of the measurement, so a change to any of them retires it.
 */
export interface ComposerHeightMeasurement {
  /** Textarea value the height was measured for. */
  value: string;
  /** Content-box width (px) the height was measured at. */
  contentWidth: number;
  /** Width (px) of one glyph: font size plus letter spacing. */
  glyphWidth: number;
  /** Clamp the height was written with. */
  minHeight: number;
  maxHeight: number;
}

/**
 * Slack allowed between the measured content width (`clientWidth` minus
 * padding, rounded to whole pixels) and a ResizeObserver's fractional content
 * width, so the two never disagree about a box that did not actually resize.
 * A real resize is always wider than this.
 */
const WIDTH_TOLERANCE_PX = 1;

/**
 * Height (px) applied for a measured content height: never below the floor,
 * never above the ceiling, so an overlong draft scrolls inside the capped box
 * and an emptied composer returns to its floor.
 */
export const composerTextareaHeight = (contentHeight: number, minHeight: number, maxHeight: number): number =>
  Math.min(Math.max(contentHeight, minHeight), maxHeight);

/** Line count and longest logical line of a textarea value. */
const scanLines = (value: string): { lines: number; longest: number } => {
  let lines = 1;
  let longest = 0;
  let lineStart = 0;
  for (;;) {
    const lineBreak = value.indexOf('\n', lineStart);
    const length = (lineBreak === -1 ? value.length : lineBreak) - lineStart;
    if (length > longest) longest = length;
    if (lineBreak === -1) return { lines, longest };
    lines += 1;
    lineStart = lineBreak + 1;
  }
};

/**
 * Lower bound of the characters that certainly fit on one visual row: no glyph
 * is wider than the font size (CJK glyphs are exactly one em, Latin glyphs are
 * narrower) plus any letter spacing, so a line at most this long cannot wrap.
 * `0` means the bound is unusable (hidden element or unreadable metrics) and
 * every measurement must be taken.
 */
export const charsPerRowBound = (contentWidth: number, glyphWidth: number): number => {
  if (!(contentWidth > 0) || !(glyphWidth > 0)) return 0;
  return Math.max(1, Math.floor(contentWidth / glyphWidth));
};

/**
 * Whether two values can render a different number of rows, i.e. whether the
 * height has to be measured again.
 *
 * Same line count plus every line short enough to be sure it does not wrap
 * means both values render exactly `lines` rows, so the cached height still
 * fits. Everything else is reported as possibly changed.
 */
export const mayChangeRowCount = (previous: string, next: string, charsPerRow: number): boolean => {
  if (previous === next) return false;
  const before = scanLines(previous);
  const after = scanLines(next);
  if (before.lines !== after.lines) return true;
  if (charsPerRow <= 0) return true;
  return before.longest > charsPerRow || after.longest > charsPerRow;
};

/**
 * Whether the measured height can still be reused for `next`.
 *
 * `currentWidth` is the content width the textarea has now, as reported by a
 * ResizeObserver (so it costs no layout read), or `null` when that is unknown.
 * A resized box invalidates the height in both directions: narrower can wrap a
 * line that used to fit, wider can unwrap one.
 */
export const shouldRemeasureComposerHeight = (
  measurement: ComposerHeightMeasurement | null,
  next: {
    value: string;
    currentWidth: number | null;
    minHeight: number;
    maxHeight: number;
  },
): boolean => {
  if (!measurement) return true;
  if (measurement.minHeight !== next.minHeight || measurement.maxHeight !== next.maxHeight) return true;
  if (
    next.currentWidth !== null
    && Math.abs(next.currentWidth - measurement.contentWidth) > WIDTH_TOLERANCE_PX
  ) {
    return true;
  }
  return mayChangeRowCount(
    measurement.value,
    next.value,
    charsPerRowBound(measurement.contentWidth, measurement.glyphWidth),
  );
};
