// Conversation-turn reuse for the cowork transcript.
//
// buildDisplayItems/buildConversationTurns rebuild every turn object on each
// store change, and a streamed answer changes the store on every frame (and on
// every buffered flush). A fresh `turn` object defeats AssistantTurnBlock's
// React.memo, so one live bubble used to re-render — and re-parse the Markdown
// of — the whole transcript up to 60 times a second.
//
// The turn model is a pure projection of its messages, so a turn whose messages
// are the same objects as last time is the same turn: it can be handed back by
// identity and React skips it. Kept framework-free (plain JS) so `node --test`
// imports it without a TS compile step — same contract as
// coworkSessionPresentation.js.

const assistantItemsAreStable = (previousItems, nextItems) => {
  if (previousItems === nextItems) return true;
  if (!previousItems || !nextItems || previousItems.length !== nextItems.length) return false;
  for (let index = 0; index < nextItems.length; index += 1) {
    const previous = previousItems[index];
    const next = nextItems[index];
    if (previous === next) continue;
    if (!previous || !next || previous.type !== next.type) return false;
    if (next.type === 'tool_group') {
      // The pairing lives on the group object, so both halves must match.
      if (previous.group.toolUse !== next.group.toolUse) return false;
      if (previous.group.toolResult !== next.group.toolResult) return false;
      continue;
    }
    if (previous.message !== next.message) return false;
  }
  return true;
};

/** Whether two freshly built turns would render identically. */
export const turnItemsAreStable = (previous, next) => {
  if (previous === next) return true;
  if (!previous || !next) return false;
  if (previous.id !== next.id) return false;
  if (previous.userMessage !== next.userMessage) return false;
  return assistantItemsAreStable(previous.assistantItems, next.assistantItems);
};

/**
 * Hand back the previous turn objects for every turn that did not change.
 * Index alignment is safe because only a same-id turn is ever reused; turns
 * that shifted (earlier history prepended, session switched) fail the id check
 * and keep their fresh objects.
 */
export const reuseStableTurns = (previous, next) => {
  if (!previous || previous.length === 0) return next;
  let reusedAny = false;
  const result = next.map((turn, index) => {
    const candidate = previous[index];
    if (!candidate || !turnItemsAreStable(candidate, turn)) return turn;
    reusedAny = true;
    return candidate;
  });
  return reusedAny ? result : next;
};
