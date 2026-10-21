/**
 * Turn navigator: a slim rail on the right edge of the conversation.
 *
 * One short mark per conversation turn. Moving the pointer down the rail walks
 * the marks and reveals a preview card to the left of the rail; clicking a mark
 * scrolls the conversation to that turn. The rail is a *navigator*, not a
 * timeline: it carries no elapsed time, no ledger, and no per-record detail.
 *
 * Ported from the DSH TurnNavigator interaction model, but wired to IDBots'
 * own surfaces: the rail anchors to the detail root (so it sits above the
 * composer), turn grouping comes from the existing `buildConversationTurns()`,
 * the host resolves jump targets and owns scrolling, and styling uses the
 * shared `claude-*` Tailwind tokens rather than DSH's design variables.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { ConversationTurn } from './CoworkSessionDetail';

/** Fixed pitch between neighbouring marks; the rail scrolls when it overflows. */
const TURN_SPACING_PX = 14;
/** Padding above the first mark and below the last one, per end. */
const RAIL_INSET_PX = 6;
/** Fade band reserved at a scrollable end. */
const FADE_PX = 24;
/** The rail hides entirely below this width — it would crowd the transcript. */
const RAIL_MIN_VIEWPORT_PX = 900;
/** Longest visible run of a mark's glyph, in px. */
const MARK_WIDTH_PX = 20;
/** Tallest the rail frame may grow, in px. */
const RAIL_MAX_HEIGHT_PX = 420;

export interface TurnNavigatorItem {
  /** 1-based turn number as shown to the reader. */
  turn: number;
  /** The user's message for this turn — the preview card's first line. */
  prompt: string;
  /** The assistant's reply for this turn — the preview card's body. */
  response: string;
  /** DOM id of the element to scroll to when this mark is clicked. */
  anchorId: string | null;
  /** False when this turn has no reachable element to scroll to. */
  navigable: boolean;
}

/**
 * Collapse one conversation turn into its rail item.
 *
 * `anchorId` is the user message's own id. The host resolves it against the
 * rendered transcript at click time and owns the scroll; the rail only says
 * which turn was picked. A turn with no user message (an orphan assistant run)
 * is skipped — see the loop below.
 */
export const buildTurnNavigatorItems = (
  turns: ConversationTurn[],
  getText: (content: string | null | undefined) => string,
): TurnNavigatorItem[] => {
  const items: TurnNavigatorItem[] = [];

  for (const turn of turns) {
    // Skip orphan turns. buildConversationTurns() synthesizes a userMessage:null
    // turn for content that arrived without a user message (a resumed answer,
    // leftover system/tool rows). Those have no element to scroll to, so a mark
    // for them would be a dead target: clicking it can only fall through, which
    // reads as "the rail does not work" — and on a cold start they can outnumber
    // the real turns. The rail is a navigator, so it lists what can be navigated.
    if (!turn.userMessage) continue;

    const promptMessage = turn.userMessage;
    const firstAssistant = turn.assistantItems.find((item) => item.type === 'assistant');
    const prompt = getText(promptMessage.content);
    const response =
      firstAssistant && firstAssistant.type === 'assistant'
        ? getText(firstAssistant.message.content)
        : '';

    items.push({
      turn: items.length + 1,
      prompt,
      response,
      anchorId: promptMessage.id,
      navigable: true,
    });
  }

  return items;
};

interface TurnNavigatorProps {
  /** One entry per turn, oldest first. */
  items: TurnNavigatorItem[];
  /** Anchor currently at the reading position, or null before it is known. */
  activeAnchorId: string | null;
  /** True while the session is producing output. */
  sessionRunning: boolean;
  /**
   * True when older history exists but is not loaded. The renderer only knows
   * this as a boolean — it has no per-turn outline — so the rail marks the
   * region as "there is more above" and offers to load it, instead of drawing
   * individually labelled marks it cannot substantiate.
   */
  hasMoreBefore: boolean;
  /** Load one older page of history. */
  onLoadEarlier: () => void;
  /** Scroll container the rail navigates within. */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Scroll one turn into view. */
  onNavigate: (item: TurnNavigatorItem) => void;
}

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Track the reduced-motion preference as reactive state.
 *
 * Read once at module scope it would go stale the moment the reader flips the
 * OS setting; the rail animates on every hover, so it has to follow.
 */
const useReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = () => setReduced(query.matches);
    handleChange();
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);
  return reduced;
};

const TurnNavigator: React.FC<TurnNavigatorProps> = ({
  items,
  activeAnchorId,
  sessionRunning,
  hasMoreBefore,
  onLoadEarlier,
  scrollContainerRef,
  onNavigate,
}) => {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useReducedMotion();

  // Pointer inside the rail suspends auto-follow so the rail cannot slide under
  // the reader's hand mid-gesture.
  const pointerInsideRef = useRef(false);

  const activeIndex = useMemo(() => {
    if (activeAnchorId === null) return -1;
    return items.findIndex((item) => item.anchorId === activeAnchorId);
  }, [items, activeAnchorId]);

  // The rail is only meaningful with a real scroll surface and at least two
  // turns; a single turn has nowhere to navigate to.
  const scrollElement = scrollContainerRef.current;
  const [railBandHeight, setRailBandHeight] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(
    typeof window === 'undefined' ? RAIL_MIN_VIEWPORT_PX : window.innerWidth,
  );

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // The rail lives in the band above the composer: measure that band from the
  // scroll element's own box so the last mark stays reachable.
  useLayoutEffect(() => {
    const element = scrollContainerRef.current;
    if (!element) return;
    const measure = () => setRailBandHeight(element.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollContainerRef, scrollElement]);

  const hidden =
    viewportWidth <= RAIL_MIN_VIEWPORT_PX ||
    items.length < 2 ||
    scrollElement === null;

  const totalHeight = items.length * TURN_SPACING_PX;
  const frameMaxHeight = Math.min(
    Math.max(0, railBandHeight - 64),
    RAIL_MAX_HEIGHT_PX,
  );
  const frameHeight = Math.min(totalHeight, frameMaxHeight);
  const overflows = totalHeight > frameHeight;

  // Keep the active mark centred as the conversation advances. Suspended while
  // the pointer is inside the rail.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || hidden || pointerInsideRef.current) return;
    if (activeIndex < 0) return;
    const center = activeIndex * TURN_SPACING_PX + TURN_SPACING_PX / 2;
    const max = Math.max(0, totalHeight - scroller.clientHeight);
    const target = Math.max(0, Math.min(max, center - scroller.clientHeight / 2));
    scroller.scrollTo({
      top: target,
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  }, [activeIndex, hidden, totalHeight, reducedMotion]);

  // Escape dismisses the preview without moving focus — the reader can keep
  // arrow-keying the rail afterwards.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (previewIndex === null) return;
      event.stopPropagation();
      setPreviewIndex(null);
    };
    rail.addEventListener('keydown', handleKeyDown);
    return () => rail.removeEventListener('keydown', handleKeyDown);
  }, [previewIndex]);

  const handlePointerEnter = useCallback(() => {
    pointerInsideRef.current = true;
  }, []);

  const handlePointerLeave = useCallback(() => {
    pointerInsideRef.current = false;
    setPreviewIndex(null);
  }, []);

  const previewItem = previewIndex === null ? null : items[previewIndex];

  if (hidden) return null;

  // The last turn is the one still being written while the session runs; only
  // it can be busy. That is what `sessionRunning` is for — no per-turn stream
  // flag is plumbed to this component, so we do not pretend to know more.
  const busyIndex = sessionRunning ? items.length - 1 : -1;

  return (
    <div
      ref={railRef}
      // The host slot is pointer-events-none so the rail never blocks the
      // transcript; this is the matching re-enable. WITHOUT IT the rail
      // receives no pointer events at all — no hover preview, no clicks.
      className="pointer-events-auto relative w-8 flex-shrink-0 self-center"
      style={{ height: frameHeight > 0 ? frameHeight : undefined }}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <div
        ref={scrollerRef}
        role="navigation"
        aria-label={i18nService.t('coworkTurnNavigatorLabel')}
        className="h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{
          paddingTop: RAIL_INSET_PX,
          paddingBottom: RAIL_INSET_PX,
          maskImage: overflows
            ? `linear-gradient(to bottom, transparent 0, #000 ${FADE_PX}px calc(100% - ${FADE_PX}px), transparent 100%)`
            : undefined,
          WebkitMaskImage: overflows
            ? `linear-gradient(to bottom, transparent 0, #000 ${FADE_PX}px calc(100% - ${FADE_PX}px), transparent 100%)`
            : undefined,
        }}
      >
        <div className="relative" style={{ height: totalHeight }}>
          {/* Older history that is not loaded yet. The renderer only exposes a
              boolean, so this is a region marker — no invented turn numbers.
              Clicking it pulls one older page, the same call the transcript's
              own "load earlier" control makes. */}
          {hasMoreBefore && (
            <button
              type="button"
              aria-label={i18nService.t('coworkTurnNavigatorLoadEarlier')}
              onClick={onLoadEarlier}
              className="absolute left-0 right-0 flex h-3.5 items-center justify-end border-0 bg-transparent p-0"
              style={{ top: -TURN_SPACING_PX }}
            >
              <span
                aria-hidden
                className="block h-[3px] rounded-sm bg-claude-border opacity-60 dark:bg-claude-darkBorder"
                style={{ width: MARK_WIDTH_PX, transform: 'scaleX(0.4)', transformOrigin: '100%' }}
              />
            </button>
          )}
          {items.map((item, index) => {
            const active = index === activeIndex;
            const preview = index === previewIndex;
            const busy = index === busyIndex;
            const scale = active ? 1 : preview ? 0.9 : item.navigable ? 0.6 : 0.4;
            return (
              <button
                key={item.anchorId ?? `turn-${item.turn}`}
                type="button"
                disabled={!item.navigable}
                aria-label={
                  item.navigable
                    ? i18nService.t('coworkTurnNavigatorJump').replace('{turn}', String(item.turn))
                    : i18nService.t('coworkTurnNavigatorTurn').replace('{turn}', String(item.turn))
                }
                aria-current={active ? 'true' : undefined}
                aria-busy={busy ? 'true' : undefined}
                onPointerMove={() => setPreviewIndex(index)}
                onFocus={() => setPreviewIndex(index)}
                onBlur={() => setPreviewIndex(null)}
                onClick={() => {
                  if (item.navigable) onNavigate(item);
                }}
                className="absolute left-0 right-0 flex h-3.5 items-center justify-end border-0 bg-transparent p-0 disabled:cursor-default"
                style={{ top: index * TURN_SPACING_PX }}
              >
                <span
                  aria-hidden
                  className={`block h-[3px] rounded-sm ${
                    reducedMotion ? '' : 'transition-transform duration-150'
                  } ${busy && !reducedMotion ? 'animate-pulse' : ''} ${
                    active
                      ? 'bg-claude-accent'
                      : preview
                        ? 'bg-claude-textSecondary dark:bg-claude-darkTextSecondary'
                        : 'bg-claude-border dark:bg-claude-darkBorder'
                  } ${!item.navigable ? 'opacity-60' : ''}`}
                  style={{ width: MARK_WIDTH_PX, transform: `scaleX(${scale})`, transformOrigin: '100%' }}
                />
              </button>
            );
          })}
        </div>
      </div>

      {/* Preview card: sits to the LEFT of the rail, one line of prompt over the
          first lines of the reply. Display-only — it never intercepts pointer. */}
      {previewItem && (previewItem.prompt || previewItem.response) && (
        <div
          role="tooltip"
          className="pointer-events-none absolute right-full mr-2.5 w-[min(300px,40vw)] overflow-hidden rounded-lg border border-claude-border bg-claude-surface p-2.5 shadow-lg dark:border-claude-darkBorder dark:bg-claude-darkSurface"
          style={{
            top: Math.max(
              0,
              Math.min(
                (previewIndex ?? 0) * TURN_SPACING_PX + RAIL_INSET_PX - 40,
                Math.max(0, frameHeight - 88),
              ),
            ),
          }}
        >
          {previewItem.prompt && (
            <div className="line-clamp-1 text-[13px] font-semibold text-claude-text dark:text-claude-darkText">
              {previewItem.prompt}
            </div>
          )}
          {previewItem.response && (
            <div className="mt-1 line-clamp-3 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {previewItem.response}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default React.memo(TurnNavigator);
