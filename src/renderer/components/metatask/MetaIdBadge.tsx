import React from 'react';

/**
 * MetaTask identity display: avatar + name when known (local roster today;
 * external bots once MetaSo exposes a by-metaId identity endpoint), else a
 * short metaId with the full id on hover. Replaces bare truncated metaIds
 * everywhere (board cards, detail header, roster, node actors, votes, shares).
 */
const MetaIdBadge: React.FC<{
  metaId: string;
  identities?: Record<string, { name: string | null; avatar: string | null }>;
  compact?: boolean;
}> = ({ metaId, identities, compact }) => {
  const identity = identities?.[metaId];
  const name = identity?.name?.trim();
  const avatar = identity?.avatar;
  const short = metaId.length > 14 ? `${metaId.slice(0, 8)}…${metaId.slice(-4)}` : metaId;
  const size = compact ? 'h-4 w-4 text-[9px]' : 'h-5 w-5 text-[10px]';
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0" title={metaId}>
      {avatar ? (
        <img src={avatar} alt="" className={`${size} rounded-full object-cover shrink-0`} />
      ) : (
        <span
          className={`${size} rounded-full bg-brand/15 text-brand inline-flex items-center justify-center font-semibold shrink-0`}
        >
          {(name || metaId).slice(0, 1).toUpperCase()}
        </span>
      )}
      <span
        className={`truncate ${
          name
            ? 'dark:text-claude-darkText text-claude-text'
            : 'dark:text-claude-darkTextSecondary text-claude-textSecondary font-mono'
        }`}
      >
        {name || short}
      </span>
    </span>
  );
};

export default MetaIdBadge;
