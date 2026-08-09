import React from 'react';
import { i18nService } from '../../services/i18n';

interface TwinBadgeProps {
  /** Extra classes for scenario-specific sizing/spacing (e.g. compact surfaces). */
  className?: string;
}

/**
 * Prominent brand-yellow badge shown next to a Twin Bot's name.
 * Uses a translucent yellow fill (never an opaque one, which floods text in
 * dark mode) with an adaptive text color: readable gold on light, bright
 * brand yellow on dark.
 */
const TwinBadge: React.FC<TwinBadgeProps> = ({ className = '' }) => (
  <span
    data-slot="metabot-twin-badge"
    className={`inline-flex shrink-0 items-center rounded-full bg-[#FFDC51]/20 dark:bg-[#FFDC51]/25 border border-[#FFDC51]/40 dark:border-[#FFDC51]/50 px-1.5 py-0.5 text-[10px] font-semibold leading-3 text-[#A16207] dark:text-[#FFDC51] ${className}`}
  >
    {i18nService.t('metabotTwinBadge')}
  </span>
);

export default TwinBadge;
