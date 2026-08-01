/**
 * Mnemonic Word Grid
 * Ordered 12/24-word grid shared by the create-backup step, the logout
 * reveal panel, and the backup-mnemonic modal.
 */

import React from 'react';

const MnemonicWordGrid: React.FC<{ words: string[] }> = ({ words }) => (
  <ol className="grid grid-cols-2 sm:grid-cols-3 gap-2">
    {words.map((word, index) => (
      <li
        key={`${index}-${word}`}
        className="rounded-md border dark:border-claude-darkBorder border-claude-border px-2 py-1.5 text-sm dark:text-claude-darkText text-claude-text font-mono"
      >
        <span className="opacity-60 mr-1.5">{index + 1}.</span>
        <span>{word}</span>
      </li>
    ))}
  </ol>
);

export default MnemonicWordGrid;
