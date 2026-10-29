import { twemojiUrlFor, TWEMOJI_CHARS } from './twemoji';

/**
 * remarkTwemoji — display-only remark plugin for chat markdown bubbles.
 *
 * Replaces bundled-catalog emoji inside mdast `text` nodes with inline
 * `image` nodes so MarkdownContent (emojiImages prop) renders Twemoji
 * artwork. Code spans and fenced code blocks are STRUCTURALLY immune:
 * their content lives on `inlineCode`/`code` nodes, which never carry
 * `text` children, so a message that talks about 🙂 keeps the literal
 * glyph. The markdown SOURCE string is never rewritten — this is a
 * render-tree transform only.
 *
 * Artwork: Twemoji 14.0.2 (CC-BY 4.0), bundled under ./assets/twemoji/.
 */

/** Minimal mdast shapes this plugin touches (no unified type dependency). */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  title?: string | null;
  children?: MdNode[];
}

// Longest-first alternation (multi-codepoint chars win over prefixes).
const EMOJI_SOURCE = [...TWEMOJI_CHARS]
  .sort((a, b) => b.length - a.length)
  .join('|');

const HAS_EMOJI_RE = () => new RegExp(EMOJI_SOURCE);
const SPLIT_RE = () => new RegExp(`(${EMOJI_SOURCE})`, 'g');

/** Split one text node into text/image children, or return null to keep it. */
const expandTextNode = (node: MdNode): MdNode[] | null => {
  const value = node.value;
  if (typeof value !== 'string' || !value || !HAS_EMOJI_RE().test(value)) return null;
  const next: MdNode[] = [];
  for (const part of value.split(SPLIT_RE())) {
    if (!part) continue;
    const url = twemojiUrlFor(part);
    if (url) {
      // Inline image inside the same paragraph/heading/cell — react-markdown
      // renders it through the shared img component; alt carries the
      // codepoint so tests and screen readers see the character.
      next.push({ type: 'image', url, alt: part, title: null });
    } else {
      next.push({ type: 'text', value: part });
    }
  }
  return next.length > 0 ? next : null;
};

const remarkTwemoji = (): ((tree: MdNode) => void) =>
  (tree: MdNode): void => {
    const walk = (node: MdNode): void => {
      if (!Array.isArray(node.children)) return;
      for (const child of node.children) walk(child);
      let touched = false;
      const next: MdNode[] = [];
      for (const child of node.children) {
        const expanded = child.type === 'text' ? expandTextNode(child) : null;
        if (expanded) {
          next.push(...expanded);
          touched = true;
        } else {
          next.push(child);
        }
      }
      if (touched) node.children = next;
    };
    walk(tree);
  };

export default remarkTwemoji;
