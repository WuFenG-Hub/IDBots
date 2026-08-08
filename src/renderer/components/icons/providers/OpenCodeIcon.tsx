import React from 'react';

// Official OpenCode mark (opencode.ai/favicon.svg): a square ring with a
// bottom-right accent block, adapted to the app's monochrome 24x24 icon set.
const OpenCodeIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="currentColor" height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{ flex: '0 0 auto', lineHeight: 1 }}>
    <title>OpenCode</title>
    <path fillRule="evenodd" d="M6 4.5h12v15H6v-15zm3 3h6v9H9v-9z" />
    <path d="M15 10.5h3v6h-3z" opacity="0.45" />
  </svg>
);

export default OpenCodeIcon;
