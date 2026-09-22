import React from 'react';
import type { LongTermParticipant } from '../../types/longTermTask';

/**
 * Participant bot avatar stack (card + detail page). Every bot that touched
 * the task — the Twin driving it, delegated workers, group-task members — as
 * small overlapping avatars, name in the tooltip.
 */
const ParticipantAvatars: React.FC<{
  participants: LongTermParticipant[];
  size?: 'sm' | 'md';
  maxVisible?: number;
  showNames?: boolean;
}> = ({ participants, size = 'sm', maxVisible = 4, showNames = false }) => {
  if (participants.length === 0) return null;
  const dim = size === 'sm' ? 'h-5 w-5 text-[9px]' : 'h-7 w-7 text-[11px]';
  const visible = participants.slice(0, maxVisible);
  const overflow = participants.length - visible.length;
  return (
    <span className="inline-flex items-center">
      <span className="flex -space-x-1.5">
        {visible.map((bot) => (
          <span key={bot.id} title={bot.name} className="relative inline-block">
            {bot.avatar ? (
              <img
                src={bot.avatar}
                alt={bot.name}
                className={`${dim} rounded-full border dark:border-claude-darkBorder border-claude-border object-cover bg-claude-surface dark:bg-claude-darkSurface`}
              />
            ) : (
              <span
                className={`${dim} inline-flex items-center justify-center rounded-full border dark:border-claude-darkBorder border-claude-border bg-sky-500/20 font-semibold text-sky-700 dark:text-sky-300`}
              >
                {bot.name.slice(0, 1)}
              </span>
            )}
          </span>
        ))}
        {overflow > 0 && (
          <span
            className={`${dim} inline-flex items-center justify-center rounded-full border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary`}
          >
            +{overflow}
          </span>
        )}
      </span>
      {showNames && (
        <span className="ml-2 truncate text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {participants.map((bot) => bot.name).join('、')}
        </span>
      )}
    </span>
  );
};

export default ParticipantAvatars;
