function compact(parts) {
  return parts.filter(Boolean).join(' ');
}

/**
 * Twin identity is scarce and sticky. Show the Twin switch when:
 * - this bot already is the Twin (so the user can turn that identity off), or
 * - this bot is a Worker and no other Twin exists yet.
 * The Welcome Bot never shows the switch and can never become Twin.
 */
export function canShowMetabotTwinSwitch({ metabotType, hasOtherTwin }) {
  if (metabotType === 'welcome') return false;
  if (metabotType === 'twin') return true;
  return !hasOtherTwin;
}

export function buildMetaBotToggleViewModel({ enabled, variant = 'enable', disabled = false }) {
  const trackClass = compact([
    'w-9 h-5',
    'rounded-full flex items-center transition-colors flex-shrink-0',
    disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
    enabled
      ? 'bg-claude-accent'
      : 'dark:bg-claude-darkBorder bg-claude-border',
  ]);

  const knobClass = compact([
    'w-3.5 h-3.5',
    'rounded-full bg-white shadow-md transform transition-transform',
    enabled
      ? 'translate-x-[18px]'
      : 'translate-x-[3px]',
  ]);

  return {
    trackClass,
    knobClass,
  };
}

export function formatGlobalMetaIdShort(globalMetaId) {
  const value = typeof globalMetaId === 'string' ? globalMetaId.trim() : '';
  if (!value) return '';
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}....${value.slice(-4)}`;
}

export async function copyGlobalMetaIdToClipboard(globalMetaId, clipboard) {
  const value = typeof globalMetaId === 'string' ? globalMetaId.trim() : '';
  if (!value || !clipboard?.writeText) return false;
  await clipboard.writeText(value);
  return true;
}
