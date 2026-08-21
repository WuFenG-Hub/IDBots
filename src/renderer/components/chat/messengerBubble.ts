/**
 * Shared messenger-bubble tokens for A2A private chat and group-task
 * transcripts. Keep both surfaces on the same row rhythm, bubble geometry,
 * type scale, and markdown inherit rules so they read as one chat family.
 */

export const messengerRowClassName = (isOutgoing: boolean): string => (
  `flex items-end gap-2 px-4 py-1 ${isOutgoing ? 'flex-row-reverse' : 'flex-row'}`
);

export const messengerColumnClassName = (isOutgoing: boolean): string => (
  `flex flex-col max-w-[70%] ${isOutgoing ? 'items-end' : 'items-start'}`
);

export const messengerNameClassName =
  'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-0.5 px-1';

export const messengerBubbleClassName = (isOutgoing: boolean): string => (
  `rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${
    isOutgoing
      ? 'bg-blue-500 text-white rounded-br-sm'
      : 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text rounded-bl-sm'
  }`
);

export const messengerMetaClassName =
  'text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5 px-1';

export const messengerTxidRowClassName = (isOutgoing: boolean): string => (
  `mt-0.5 inline-flex max-w-full items-center gap-1 px-1 text-[10px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary opacity-70 ${
    isOutgoing ? 'justify-end' : 'justify-start'
  }`
);

export const messengerMarkdownClassName = (isOutgoing: boolean): string => (
  isOutgoing
    ? 'max-w-none whitespace-normal break-words text-white [&_a]:text-inherit [&_a]:underline [&_h1]:my-0 [&_h1]:text-inherit [&_h2]:my-0 [&_h2]:text-inherit [&_h3]:my-0 [&_h3]:text-inherit [&_h4]:my-0 [&_h4]:text-inherit [&_h5]:my-0 [&_h5]:text-inherit [&_h6]:my-0 [&_h6]:text-inherit [&_p]:my-0 [&_p]:text-inherit [&_ul]:my-1 [&_ul]:text-inherit [&_ol]:my-1 [&_ol]:text-inherit [&_li]:text-inherit [&_strong]:text-inherit [&_em]:text-inherit [&_pre]:my-2 [&_blockquote]:my-1 [&_blockquote]:text-inherit'
    : 'max-w-none whitespace-normal break-words dark:text-claude-darkText text-claude-text [&_a]:text-inherit [&_a]:underline [&_h1]:my-0 [&_h1]:text-inherit [&_h2]:my-0 [&_h2]:text-inherit [&_h3]:my-0 [&_h3]:text-inherit [&_h4]:my-0 [&_h4]:text-inherit [&_h5]:my-0 [&_h5]:text-inherit [&_h6]:my-0 [&_h6]:text-inherit [&_p]:my-0 [&_p]:text-inherit [&_ul]:my-1 [&_ul]:text-inherit [&_ol]:my-1 [&_ol]:text-inherit [&_li]:text-inherit [&_strong]:text-inherit [&_em]:text-inherit [&_pre]:my-2 [&_blockquote]:my-1 [&_blockquote]:text-inherit'
);
