import React from 'react';

/**
 * Three decreasing-length lines — the "filter & sort" glyph for the
 * session-list toolbar. Deliberately a custom icon: no heroicons glyph
 * matches this funnel-list shape (Bars3 is equal lines, QueueList is a
 * pill plus equal lines).
 */
const FilterLinesIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 6h16" />
    <path d="M4 12h11" />
    <path d="M4 18h6" />
  </svg>
);

export default FilterLinesIcon;
