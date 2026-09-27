// Assistant-turn presentation decisions shared by CoworkSessionDetail and
// the tests. Kept framework-free (plain JS) so `node --test` imports it
// without a TS compile step — same contract as coworkSessionPresentation.js.

/**
 * Whether an assistant turn's "process" (thinking rows, tool groups,
 * intermediate notes) may collapse behind the "Worked for" header.
 *
 * Completeness must NOT be inferred from streaming flags alone: between the
 * tool rounds of a still-running turn every message is settled (nothing
 * carries isStreaming) — tool execution plus the next model roundtrip spans
 * whole seconds. On narration-fold routes that gap is harmless (no
 * non-thinking assistant text exists mid-turn, so there is no delivery
 * candidate to arm the header), but GLM keeps tool-ride text visible by
 * design (foldsToolRideTextIntoThinking), so its mid-turn narration IS a
 * delivery candidate: the gap collapsed the entire transcript behind the
 * header, and the next round's first reasoning chunk re-expanded it — the
 * repeated fold/unfold jumping reported on glm-5.3 (2026-09-27). A live
 * session's active turn is therefore complete only once the session stops
 * running; earlier turns keep the streaming-flag scan (a settled turn that
 * still carries a stuck isStreaming flag must not collapse either).
 */
export const isAssistantTurnComplete = ({ sessionLive, isActiveTurn, hasStreamingItem }) => {
  if (!sessionLive) return true;
  if (isActiveTurn) return false;
  return !hasStreamingItem;
};
