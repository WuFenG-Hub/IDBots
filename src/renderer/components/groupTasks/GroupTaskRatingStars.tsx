import React, { useState } from 'react';
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid';
import { StarIcon as StarIconOutline } from '@heroicons/react/24/outline';

interface GroupTaskRatingStarsProps {
  /** Current rating (1-5); null means "not rated yet" (interactive mode only). */
  value: number | null;
  /** When provided the stars become an interactive picker; otherwise read-only. */
  onChange?: (value: number) => void;
  sizeClass?: string;
}

/**
 * 1-5 star rating display / picker for group task acceptance.
 * Read-only when `onChange` is absent; interactive with hover preview otherwise.
 */
const GroupTaskRatingStars: React.FC<GroupTaskRatingStarsProps> = ({
  value,
  onChange,
  sizeClass = 'h-5 w-5',
}) => {
  const [hoverValue, setHoverValue] = useState<number | null>(null);
  const interactive = Boolean(onChange);
  const shown = hoverValue ?? value ?? 0;

  return (
    <div
      className="inline-flex items-center gap-0.5"
      onMouseLeave={interactive ? () => setHoverValue(null) : undefined}
    >
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = shown >= star;
        const Icon = filled ? StarIconSolid : StarIconOutline;
        const icon = (
          <Icon
            className={`${sizeClass} ${
              filled
                ? 'text-amber-400'
                : 'dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50'
            }`}
          />
        );
        return interactive ? (
          <button
            key={star}
            type="button"
            aria-label={`${star}`}
            onClick={() => onChange?.(star)}
            onMouseEnter={() => setHoverValue(star)}
            className="p-0.5 rounded transition-transform hover:scale-110 focus:outline-none focus:ring-1 focus:ring-claude-accent/60"
          >
            {icon}
          </button>
        ) : (
          <span key={star} className="p-0.5">
            {icon}
          </span>
        );
      })}
    </div>
  );
};

export default GroupTaskRatingStars;
