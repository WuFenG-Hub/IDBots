import React from 'react';
import { UserGroupIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

/**
 * Green "friend" chip for A2A surfaces (S5 friend/block task): rendered in
 * the CoworkSessionDetail session header next to the on-chain badge and
 * beside the peer's name in A2AMessageItem bubbles. Data source is the S4
 * metaso pair-state provider ('confirmed' = mutual /follow).
 */
const FriendBadge: React.FC<{ className?: string }> = ({ className = '' }) => (
  <span
    data-friend-badge="true"
    className={`shrink-0 whitespace-nowrap inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400 ${className}`}
  >
    <UserGroupIcon className="h-3 w-3" aria-hidden="true" />
    {i18nService.t('coworkFriendBadge')}
  </span>
);

export default FriendBadge;
