import { useEffect, useState } from 'react';

/**
 * Render budget for a long session list.
 *
 * A real user's sidebar holds several hundred (here: ~900) sessions, and
 * mounting every row up front costs a five-figure number of DOM nodes, all of
 * them laid out by the browser on the first paint and re-committed with the
 * list. The first screenful is therefore rendered immediately — nothing a user
 * can actually see is delayed — and each approach to the end appends another
 * chunk, so the mounted rows stay proportional to what has been looked at
 * (40-ish rows instead of 900 on open).
 *
 * Deliberately a count of rows, not spacer-based windowing: the rows are not a
 * uniform grid. Pinned / timeline / project / Auto Tasks headers carry their own
 * heights, and the flat list spaces its rows with `space-y-1` while the grouped
 * branches deliberately do not — a spacer model would have to reproduce every
 * one of those heights and gaps out of Tailwind's cascade, and one wrong
 * constant would ship as blank or overlapping rows. A budget cannot get the
 * layout wrong: it renders a strict prefix of exactly the markup the list
 * rendered before, and reveals the rest as the user scrolls toward it. The one
 * thing it cannot preserve is the scrollbar's proportions — the scroll height
 * only covers what is rendered — so the thumb grows as rows are revealed.
 */
export const REVEAL_INITIAL_ROWS = 60;
export const REVEAL_CHUNK_ROWS = 40;
/** How close (px) to the end of the scroll area the next chunk is appended. */
export const REVEAL_THRESHOLD_PX = 400;

/** The scroll geometry the reveal decision is made from. */
export interface RevealGeometry {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

/** What one geometry probe says about the budget. */
export interface RevealStep {
  /** Append another chunk of rows now. */
  reveal: boolean;
  /** Whether the next approach to the end may reveal again. */
  armed: boolean;
}

/**
 * The reveal decision, pure so the boundary can be exercised without a DOM.
 *
 * One chunk per approach: the trigger re-arms only once the list has been
 * scrolled away from the end again. A level trigger would keep appending chunks
 * forever whenever the user parks at the end of a list whose content is already
 * fully rendered (react's update-depth guard would fire), and a hidden list
 * (collapsed sidebar, height 0) has no geometry to judge at all — it waits for
 * the next resize instead.
 */
export const decideRevealStep = (geometry: RevealGeometry, armed: boolean): RevealStep => {
  if (geometry.clientHeight <= 0) return { reveal: false, armed };
  const distanceToEnd = geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight;
  if (distanceToEnd > REVEAL_THRESHOLD_PX) return { reveal: false, armed: true };
  if (!armed) return { reveal: false, armed: false };
  return { reveal: true, armed: false };
};

/**
 * Nearest scrollable ancestor of the list — the element that owns the scroll
 * position the budget follows. The list is embedded in its host's scroll area
 * (the sidebar's records panel, the search modal's results panel), so the
 * element is discovered rather than passed in: no caller has to hand over a ref,
 * and any host that embeds the list in a scrollable panel gets the same
 * behavior. The lookup runs once per mount, after the list's own commit.
 */
export const findScrollContainer = (start: HTMLElement | null): HTMLElement | null => {
  let node = start?.parentElement ?? null;
  while (node) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node;
    node = node.parentElement;
  }
  return null;
};

/**
 * How many rows the list may mount right now; grows as the user scrolls toward
 * the end of what is rendered.
 *
 * Without a scroll container above the list nothing can be scrolled out of
 * sight, so the budget opens up completely and the list renders exactly what it
 * rendered before this existed.
 */
export const useProgressiveRowReveal = (rootRef: React.RefObject<HTMLElement>): number => {
  const [revealedRows, setRevealedRows] = useState(REVEAL_INITIAL_ROWS);
  useEffect(() => {
    const container = findScrollContainer(rootRef.current);
    if (!container) {
      setRevealedRows(Number.POSITIVE_INFINITY);
      return;
    }
    let armed = true;
    const probe = () => {
      const step = decideRevealStep(
        {
          clientHeight: container.clientHeight,
          scrollHeight: container.scrollHeight,
          scrollTop: container.scrollTop,
        },
        armed,
      );
      armed = step.armed;
      if (step.reveal) {
        setRevealedRows((previous) => previous + REVEAL_CHUNK_ROWS);
      }
    };
    probe();
    container.addEventListener('scroll', probe, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(probe);
    observer?.observe(container);
    return () => {
      container.removeEventListener('scroll', probe);
      observer?.disconnect();
    };
  }, [rootRef]);
  return revealedRows;
};
