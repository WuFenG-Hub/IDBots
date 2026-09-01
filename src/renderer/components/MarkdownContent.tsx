import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
// @ts-ignore
import remarkGfm from 'remark-gfm';
// @ts-ignore
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
// @ts-ignore
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ClipboardDocumentIcon, CheckIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../services/i18n';
import LocalFileLink from './ui/LocalFileLink';

const CODE_BLOCK_LINE_LIMIT = 200;
const CODE_BLOCK_CHAR_LIMIT = 20000;
// Align with DSH WebUI markdown code blocks: 11px/19px mono, 16px padding.
const SYNTAX_HIGHLIGHTER_STYLE = {
  margin: 0,
  borderRadius: 0,
  background: '#282c34',
  padding: '16px',
  fontSize: '11px',
  lineHeight: '19px',
};
const SAFE_URL_PROTOCOLS = new Set(['http', 'https', 'mailto', 'tel', 'file', 'metaid', 'metaapp', 'map', 'metafile', 'pin', 'preview-metaapp']);

const BOT_BROWSER_URI_PROTOCOL_RE = /^(metaid|metaapp|map|metafile|pin|preview-metaapp):/i;

/** Whether an href points into the Bot Browser (metaid://, metaapp://, …) rather than the external browser. */
export const isBotBrowserUri = (href: string): boolean => BOT_BROWSER_URI_PROTOCOL_RE.test(href.trim());

const AGENT_INTERNET_URI_RE = /\b(?:metaid|metaapp|map|metafile|pin|preview-metaapp):\/\/[A-Za-z0-9][A-Za-z0-9._~%/@-]*/gi;
const AGENT_INTERNET_URI_HINT_RE = /(?:metaid|metaapp|map|metafile|pin|preview-metaapp):\/\//i;
const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;
const TRAILING_URI_PUNCTUATION_RE = /[.,;:!?]+$/;
/**
 * R3: a bare on-chain pin id (64 hex + the MetaID "i0" suffix) written without a
 * scheme. Bots paste these constantly; recognise them as pin:// links so they
 * are clickable + openable in the Bot Browser. The lookbehind excludes ids that
 * are already part of a scheme:// URI (e.g. the tail of metaapp://…i0).
 */
const BARE_PINID_RE = /(?<![/:=\w])([0-9a-f]{64}i0)(?![0-9a-f])/gi;
/**
 * Web2 pin-viewer URLs bots were trained to emit (metaid.io/pin/…,
 * openagentinternet.org/browser/…). Rewritten to the matching MetaWeb URI so
 * the link opens in the built-in Bot Browser instead of leaving the app.
 * buzz/pin viewers both map to the universal pin:// scheme. A trailing
 * ?query/#fragment is viewer chrome — consumed and dropped so no residue
 * leaks into the rewritten URI (markdown ')' / ']' never count as part of
 * it, keeping link destinations intact).
 */
const WEB2_PIN_VIEWER_RE = /\bhttps?:\/\/(?:www\.)?(?:metaid\.io|openagentinternet\.org\/browser)\/(pin|buzz|metaapp|metafile)\/([0-9a-f]{64}i0)(?:[?#][^\s)\]]*)?(?![0-9a-f])/gi;
const WEB2_PIN_VIEWER_HINT_RE = /\bhttps?:\/\/(?:www\.)?(?:metaid\.io|openagentinternet\.org\/browser)\/(?:pin|buzz|metaapp|metafile)\/[0-9a-f]{64}i0/i;

const rewriteWeb2PinViewerUris = (segment: string): string => {
  if (!WEB2_PIN_VIEWER_HINT_RE.test(segment)) return segment;
  return segment.replace(WEB2_PIN_VIEWER_RE, (_m: string, kind: string, pinId: string) => {
    const scheme = kind === 'metaapp' || kind === 'metafile' ? kind : 'pin';
    return `${scheme}://${pinId}`;
  });
};

const linkifyPlainSegment = (segment: string): string => {
  // First rewrite Web2 pin-viewer URLs (bare or as markdown link
  // destinations) into MetaWeb URIs, then run the pin/scheme linkify passes.
  let out = rewriteWeb2PinViewerUris(segment);
  // R3: turn bare pin ids into pin:// links (before the scheme pass, so
  // the subsequent scheme matcher sees them as already-linkified destinations
  // and skips them via the ']' + '(' guard below).
  out = out.replace(BARE_PINID_RE, (m: string) => `[${m}](pin://${m})`);
  out = out.replace(AGENT_INTERNET_URI_RE, (rawMatch: string, offset: number, full: string) => {
    // Already a markdown link/image destination — leave it alone.
    if (full.slice(Math.max(0, offset - 2), offset) === '](') return rawMatch;
    // Already inside a <uri> autolink — leave it alone.
    if (full[offset - 1] === '<') return rawMatch;
    const match = rawMatch.replace(TRAILING_URI_PUNCTUATION_RE, '');
    if (!match) return rawMatch;
    return `[${match}](${match})${rawMatch.slice(match.length)}`;
  });
  return out;
};

/**
 * Turn bare Agent Internet URIs (metaid://, metaapp://, map://, metafile://,
 * pin://, preview-metaapp://) in markdown text into markdown links so they
 * render clickable everywhere (CoWork, A2A, Bot Browser panel), and rewrite
 * Web2 pin-viewer URLs (metaid.io/pin/…, openagentinternet.org/browser/…)
 * into the matching MetaWeb URIs. Existing markdown link syntax is left
 * alone (rewrites only replace the URL itself). Code BLOCKS (triple
 * backticks) stay verbatim; INLINE code spans are rewritten/linkified too,
 * because bots habitually wrap metaweb URIs in backticks and those must
 * remain clickable.
 */
export const linkifyAgentInternetUris = (content: string): string => {
  if (!content) return content;
  // Linkify when there is a scheme:// URI, a bare pin id, or a Web2 viewer URL.
  if (!AGENT_INTERNET_URI_HINT_RE.test(content) && !BARE_PINID_RE.test(content) && !WEB2_PIN_VIEWER_HINT_RE.test(content)) return content;
  BARE_PINID_RE.lastIndex = 0;
  return content
    .split(CODE_SEGMENT_RE)
    .map((segment) => {
      if (!segment.startsWith('`')) return linkifyPlainSegment(segment);
      // R3: code BLOCKS (triple backtick) stay verbatim; inline code spans
      // (`…`) get linkified too, because bots habitually wrap metaweb URIs in
      // backticks and those must still be clickable.
      if (segment.startsWith('```')) return segment;
      const inner = segment.slice(1, -1);
      const linkified = linkifyPlainSegment(inner);
      return linkified !== inner ? linkified : segment;
    })
    .join('');
};

const encodeFileUrl = (url: string): string => {
  const encoded = encodeURI(url);
  return encoded.replace(/\(/g, '%28').replace(/\)/g, '%29');
};

const encodeFileUrlDestination = (dest: string): string => {
  const trimmed = dest.trim();
  if (!/^<?file:\/\//i.test(trimmed)) {
    return dest;
  }

  let core = trimmed;
  let prefix = '';
  let suffix = '';
  if (core.startsWith('<') && core.endsWith('>')) {
    prefix = '<';
    suffix = '>';
    core = core.slice(1, -1);
  }

  const encoded = encodeFileUrl(core);
  return dest.replace(trimmed, `${prefix}${encoded}${suffix}`);
};

const findMarkdownLinkEnd = (input: string, start: number): number => {
  let depth = 1;
  for (let i = start; i < input.length; i += 1) {
    const char = input[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
    if (char === '\n') {
      return -1;
    }
  }
  return -1;
};

const encodeFileUrlsInMarkdown = (content: string): string => {
  if (!content.includes('file://')) {
    return content;
  }

  let result = '';
  let cursor = 0;
  while (cursor < content.length) {
    const openIndex = content.indexOf('](', cursor);
    if (openIndex === -1) {
      result += content.slice(cursor);
      break;
    }

    result += content.slice(cursor, openIndex + 2);
    const destStart = openIndex + 2;
    const destEnd = findMarkdownLinkEnd(content, destStart);
    if (destEnd === -1) {
      result += content.slice(destStart);
      break;
    }

    const dest = content.slice(destStart, destEnd);
    result += encodeFileUrlDestination(dest);
    result += ')';
    cursor = destEnd + 1;
  }
  return result;
};

const safeUrlTransform = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;

  const match = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!match) {
    return trimmed;
  }

  const protocol = match[1].toLowerCase();
  if (SAFE_URL_PROTOCOLS.has(protocol)) {
    return trimmed;
  }

  return '';
};

const getHrefProtocol = (href: string): string | null => {
  const trimmed = href.trim();
  const match = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!match) return null;
  return match[1].toLowerCase();
};

const isExternalHref = (href: string): boolean => {
  const protocol = getHrefProtocol(href);
  if (!protocol) return false;
  return protocol !== 'file';
};

const openExternalViaDefaultBrowser = async (url: string): Promise<boolean> => {
  const openExternal = (window as any)?.electron?.shell?.openExternal;
  if (typeof openExternal !== 'function') {
    return false;
  }

  try {
    const result = await openExternal(url);
    return !!result?.success;
  } catch (error) {
    console.error('Failed to open external link with system browser:', url, error);
    return false;
  }
};

const openExternalViaAnchorFallback = (url: string): void => {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
};

const CodeBlock: React.FC<any> = ({ node, className, children, ...props }) => {
  const normalizedClassName = Array.isArray(className)
    ? className.join(' ')
    : className || '';
  const match = /language-([\w-]+)/.exec(normalizedClassName);
  const hasPosition = node?.position?.start?.line != null && node?.position?.end?.line != null;
  const isInline = typeof props.inline === 'boolean'
    ? props.inline
    : hasPosition
      ? node.position.start.line === node.position.end.line
      : !match;
  const codeText = Array.isArray(children) ? children.join('') : String(children);
  const trimmedCodeText = codeText.replace(/\n$/, '');
  const shouldHighlight = !isInline && match
    && trimmedCodeText.length <= CODE_BLOCK_CHAR_LIMIT
    && trimmedCodeText.split('\n').length <= CODE_BLOCK_LINE_LIMIT;
  const [isCopied, setIsCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimeoutRef.current != null) {
      window.clearTimeout(copyTimeoutRef.current);
    }
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(trimmedCodeText);
      setIsCopied(true);
      if (copyTimeoutRef.current != null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => setIsCopied(false), 1500);
    } catch (error) {
      console.error('Failed to copy code block: ', error);
    }
  }, [trimmedCodeText]);

  if (!isInline) {
    // Simple code block without language - minimal styling
    if (!match) {
      return (
        <div className="my-[16px] relative group">
          <div className="overflow-x-auto rounded-[12px] bg-[#282c34] text-[11px] leading-[19px]">
            <button
              type="button"
              onClick={handleCopy}
              className="absolute top-2 right-2 z-10 p-1.5 rounded-md bg-gray-700/80 text-gray-300 hover:bg-gray-600 transition-colors opacity-0 group-hover:opacity-100"
              title={i18nService.t('copyToClipboard')}
              aria-label={i18nService.t('copyToClipboard')}
            >
              {isCopied ? (
                <CheckIcon className="h-4 w-4 text-green-500" />
              ) : (
                <ClipboardDocumentIcon className="h-4 w-4" />
              )}
            </button>
            <code className="block p-[16px] font-mono text-slate-100 whitespace-pre">
              {trimmedCodeText}
            </code>
          </div>
        </div>
      );
    }

    // Code block with language - show header with language name
    return (
      <div className="my-[16px] rounded-[12px] overflow-hidden border dark:border-claude-darkBorder border-claude-border relative shadow-subtle">
        <div className="dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted px-[14px] py-[9px] text-[11px] leading-[18px] dark:text-claude-darkTextSecondary text-claude-textSecondary font-medium flex items-center justify-between">
          <span>{match[1]}</span>
          <button
            type="button"
            onClick={handleCopy}
            className="p-1.5 rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
            title={i18nService.t('copyToClipboard')}
            aria-label={i18nService.t('copyToClipboard')}
          >
            {isCopied ? (
              <CheckIcon className="h-4 w-4 text-green-500" />
            ) : (
              <ClipboardDocumentIcon className="h-4 w-4" />
            )}
          </button>
        </div>
        {shouldHighlight ? (
          <SyntaxHighlighter
            style={oneDark}
            language={match[1]}
            PreTag="div"
            customStyle={SYNTAX_HIGHLIGHTER_STYLE}
          >
            {trimmedCodeText}
          </SyntaxHighlighter>
        ) : (
          <div className="m-0 overflow-x-auto bg-[#282c34] text-[11px] leading-[19px]">
            <code className="block p-[16px] font-mono text-slate-100 whitespace-pre">
              {trimmedCodeText}
            </code>
          </div>
        )}
      </div>
    );
  }

  const inlineClassName = [
    'inline rounded-[6px] px-[5px] text-[0.875em] font-mono dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted dark:text-claude-darkText text-claude-text',
    normalizedClassName,
  ].filter(Boolean).join(' ');

  return (
    <code
      className={inlineClassName}
      {...props}
    >
      {children}
    </code>
  );
};

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const stripHashAndQuery = (value: string): string => value.split('#')[0].split('?')[0];

const stripFileProtocol = (value: string): string => {
  let cleaned = value.replace(/^file:\/\//i, '');
  if (/^\/[A-Za-z]:/.test(cleaned)) {
    cleaned = cleaned.slice(1);
  }
  return cleaned;
};

const hasFileExtension = (value: string): boolean => /\.[A-Za-z0-9]{1,6}$/.test(value);

const looksLikeDirectory = (value: string): boolean => {
  if (!value) return false;
  if (value.endsWith('/') || value.endsWith('\\')) return true;
  return !hasFileExtension(value);
};

const isLikelyLocalFilePath = (href: string): boolean => {
  if (!href) return false;
  if (/^file:\/\//i.test(href)) return true;
  if (/^[A-Za-z]:[\\/]/.test(href)) return true;
  if (href.startsWith('/') || href.startsWith('./') || href.startsWith('../')) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;

  const base = stripHashAndQuery(href);
  if (base.includes('/') || base.includes('\\')) return true;

  const extMatch = base.match(/\.([A-Za-z0-9]{1,6})$/);
  if (!extMatch) return false;
  const ext = extMatch[1].toLowerCase();
  const commonTlds = new Set(['com', 'net', 'org', 'io', 'cn', 'co', 'ai', 'app', 'dev', 'gov', 'edu']);
  return !commonTlds.has(ext);
};

const toFileHref = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(filePath)) {
    return `file:///${normalized}`;
  }
  if (normalized.startsWith('/')) {
    return `file://${normalized}`;
  }
  return `file://${normalized}`;
};

const getLocalPathFromLink = (
  href: string | null,
  text: string,
  resolveLocalFilePath?: (href: string, text: string) => string | null
): string | null => {
  if (!href) return null;
  const resolved = resolveLocalFilePath ? resolveLocalFilePath(href, text) : null;
  if (resolved) return resolved;
  if (!isLikelyLocalFilePath(href)) return null;
  const rawPath = stripFileProtocol(stripHashAndQuery(href));
  const decoded = safeDecodeURIComponent(rawPath);
  return decoded || rawPath || null;
};

const findFallbackPathFromContext = (
  anchor: HTMLAnchorElement | null,
  fileName: string,
  resolveLocalFilePath?: (href: string, text: string) => string | null
): string | null => {
  const trimmedName = fileName.trim();
  if (!trimmedName || trimmedName.includes('/') || trimmedName.includes('\\')) {
    return null;
  }

  if (!anchor || typeof anchor.closest !== 'function') return null;
  const container = anchor.closest('.markdown-content');
  if (!container) return null;

  const anchors = Array.from(container.querySelectorAll('a'));
  const index = anchors.indexOf(anchor);
  if (index <= 0) return null;

  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = anchors[i] as HTMLAnchorElement;
    const candidateHref = candidate.getAttribute('href');
    const candidateText = candidate.textContent ?? '';
    const basePath = getLocalPathFromLink(candidateHref, candidateText, resolveLocalFilePath);
    if (!basePath || !looksLikeDirectory(basePath)) {
      continue;
    }

    const normalizedBase = basePath.replace(/[\\/]+$/, '');
    return `${normalizedBase}/${trimmedName}`;
  }

  return null;
};

const createMarkdownComponents = (
  resolveLocalFilePath?: (href: string, text: string) => string | null,
  onOpenBotBrowserUri?: (uri: string) => void,
  onOpenLocalFile?: (filePath: string, event: React.MouseEvent) => boolean | void
) => ({
  p: ({ node, className, children, ...props }: any) => (
    <p className="my-[16px] first:mt-0 last:mb-0 leading-[24px] dark:text-claude-darkText text-claude-text" {...props}>
      {children}
    </p>
  ),
  strong: ({ node, className, children, ...props }: any) => (
    <strong className="font-semibold dark:text-claude-darkText text-claude-text" {...props}>
      {children}
    </strong>
  ),
  h1: ({ node, className, children, ...props }: any) => (
    <h1 className="text-[21px] leading-[30px] font-bold mt-[32px] mb-[16px] first:mt-0 dark:text-claude-darkText text-claude-text" {...props}>
      {children}
    </h1>
  ),
  h2: ({ node, className, children, ...props }: any) => (
    <h2 className="text-[19px] leading-[28px] font-bold mt-[32px] mb-[16px] first:mt-0 dark:text-claude-darkText text-claude-text" {...props}>
      {children}
    </h2>
  ),
  h3: ({ node, className, children, ...props }: any) => (
    <h3 className="text-[18px] leading-[26px] font-bold mt-[32px] mb-[16px] first:mt-0 dark:text-claude-darkText text-claude-text" {...props}>
      {children}
    </h3>
  ),
  ul: ({ node, className, children, ...props }: any) => (
    <ul className="list-disc pl-[18px] my-[16px] dark:text-claude-darkText text-claude-text" {...props}>
      {children}
    </ul>
  ),
  ol: ({ node, className, children, ...props }: any) => (
    <ol className="list-decimal pl-[18px] my-[16px] dark:text-claude-darkText text-claude-text" {...props}>
      {children}
    </ol>
  ),
  li: ({ node, className, children, ...props }: any) => (
    <li className="mt-[6px] first:mt-0 leading-[24px] [&>p]:my-[8px] dark:text-claude-darkText text-claude-text" {...props}>
      {children}
    </li>
  ),
  blockquote: ({ node, className, children, ...props }: any) => (
    <blockquote className="border-l-2 border-claude-accent pl-[14px] my-[16px] dark:bg-claude-darkSurface/30 bg-claude-surfaceHover/30 rounded-r-lg dark:text-claude-darkText text-claude-text" {...props}>
      {children}
    </blockquote>
  ),
  code: CodeBlock,
  table: ({ node, className, children, ...props }: any) => (
    <div className="my-4 overflow-x-auto rounded-xl border dark:border-claude-darkBorder border-claude-border">
      <table className="border-collapse w-full" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ node, className, children, ...props }: any) => (
    <thead className="dark:bg-claude-darkSurface bg-claude-surfaceHover" {...props}>
      {children}
    </thead>
  ),
  tbody: ({ node, className, children, ...props }: any) => (
    <tbody className="divide-y dark:divide-claude-darkBorder divide-claude-border" {...props}>
      {children}
    </tbody>
  ),
  tr: ({ node, className, children, ...props }: any) => (
    <tr className="divide-x dark:divide-claude-darkBorder divide-claude-border" {...props}>
      {children}
    </tr>
  ),
  th: ({ node, className, children, ...props }: any) => (
    <th className="px-[16px] py-[10px] text-left font-semibold dark:text-claude-darkText text-claude-text" {...props}>
      {children}
    </th>
  ),
  td: ({ node, className, children, ...props }: any) => (
    <td className="px-[16px] py-[10px] dark:text-claude-darkText text-claude-text" {...props}>
      {children}
    </td>
  ),
  img: ({ node, className, ...props }: any) => (
    <img className="max-w-full h-auto rounded-xl my-4" {...props} />
  ),
  hr: ({ node, ...props }: any) => (
    <hr className="my-[32px] dark:border-claude-darkBorder border-claude-border" {...props} />
  ),
  a: ({ node, href, className, children, ...props }: any) => {
    if (typeof href === 'string' && href.startsWith('#artifact-')) {
      return null;
    }

    const hrefValue = typeof href === 'string' ? href.trim() : '';

    // Agent Internet URIs (metaid://, metaapp://, map://, metafile://, …) open
    // inside the Bot Browser. Without an explicit opener, fall back to the
    // app-wide DOM event so this works in every markdown surface.
    if (hrefValue && isBotBrowserUri(hrefValue)) {
      const openUri = onOpenBotBrowserUri ?? ((uri: string) => {
        window.dispatchEvent(new CustomEvent('botBrowser:openUri', { detail: { uri } }));
      });
      const handleUriClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        openUri(hrefValue);
      };
      return (
        <a
          href={hrefValue}
          onClick={handleUriClick}
          className="text-claude-accent hover:text-claude-accentHover underline decoration-claude-accent/50 hover:decoration-claude-accent transition-colors cursor-pointer break-all"
          title={hrefValue}
          {...props}
        >
          {children}
        </a>
      );
    }

    const isExternalLink = !!hrefValue && isExternalHref(hrefValue);
    const linkText = Array.isArray(children) ? children.join('') : String(children ?? '');
    const resolvedPath = hrefValue && !isExternalLink && resolveLocalFilePath
      ? resolveLocalFilePath(hrefValue, linkText)
      : null;
    const isLocalFilePath = !!hrefValue && !isExternalLink && (resolvedPath || isLikelyLocalFilePath(hrefValue));

    if (isLocalFilePath) {
      const rawPath = resolvedPath
        ?? stripFileProtocol(stripHashAndQuery(hrefValue));
      const decodedPath = safeDecodeURIComponent(rawPath);
      const filePath = decodedPath || rawPath;

      const handleClick = async (e: React.MouseEvent) => {
        e.preventDefault();
        // Surfaces may intercept local file opens (e.g. the cowork markdown
        // viewer sidebar); a true return means the click was handled.
        if (onOpenLocalFile?.(filePath, e) === true) {
          return;
        }
        const anchor = e.currentTarget as HTMLAnchorElement;
        try {
          const result = await window.electron.shell.openPath(filePath);
          if (result?.success) {
            return;
          }

          const fallbackPath = findFallbackPathFromContext(
            anchor,
            linkText,
            resolveLocalFilePath
          );
          if (fallbackPath) {
            const fallbackResult = await window.electron.shell.openPath(fallbackPath);
            if (!fallbackResult?.success) {
              console.error('Failed to open file (fallback):', fallbackPath, fallbackResult?.error);
            }
          } else {
            console.error('Failed to open file:', filePath, result?.error);
          }
        } catch (error) {
          console.error('Failed to open file:', filePath, error);
        }
      };

      return (
        <LocalFileLink
          filePath={filePath}
          isDirectory={looksLikeDirectory(filePath)}
          className="text-claude-accent hover:text-claude-accentHover underline decoration-claude-accent/50 hover:decoration-claude-accent transition-colors cursor-pointer inline-flex items-center gap-1"
          title={filePath}
          href={toFileHref(filePath)}
          onOpen={(_path, event) => handleClick(event)}
        >
          {children}
        </LocalFileLink>
      );
    }

    if (isExternalLink) {
      const handleExternalClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
        const openExternal = (window as any)?.electron?.shell?.openExternal;
        if (typeof openExternal !== 'function') {
          return;
        }

        e.preventDefault();
        const opened = await openExternalViaDefaultBrowser(hrefValue);
        if (!opened) {
          openExternalViaAnchorFallback(hrefValue);
        }
      };

      return (
        <a
          href={hrefValue}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleExternalClick}
          className="text-claude-accent hover:text-claude-accentHover underline decoration-claude-accent/50 hover:decoration-claude-accent transition-colors"
          {...props}
        >
          {children}
        </a>
      );
    }

    return (
      <a
        href={hrefValue}
        target="_blank"
        rel="noopener noreferrer"
        className="text-claude-accent hover:text-claude-accentHover underline decoration-claude-accent/50 hover:decoration-claude-accent transition-colors"
        {...props}
      >
        {children}
      </a>
    );
  },
});

interface MarkdownContentProps {
  content: string;
  className?: string;
  /** Compact typography for narrow surfaces (e.g. the Bot Browser side panel). */
  compact?: boolean;
  /** When set, metaid:// metaapp:// map:// metafile:// preview-metaapp:// links call this instead of navigating. */
  onOpenBotBrowserUri?: (uri: string) => void;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  /** Intercept local file link clicks; return true to suppress the default shell.openPath. */
  onOpenLocalFile?: (filePath: string, event: React.MouseEvent) => boolean | void;
}

const MarkdownContent: React.FC<MarkdownContentProps> = ({
  content,
  className = '',
  compact = false,
  onOpenBotBrowserUri,
  resolveLocalFilePath,
  onOpenLocalFile,
}) => {
  const components = useMemo(
    () => createMarkdownComponents(resolveLocalFilePath, onOpenBotBrowserUri, onOpenLocalFile),
    [resolveLocalFilePath, onOpenBotBrowserUri, onOpenLocalFile]
  );
  const normalizedContent = useMemo(
    () => encodeFileUrlsInMarkdown(linkifyAgentInternetUris(content)),
    [content]
  );
  return (
    <div className={`markdown-content ${compact ? 'text-[13px] leading-5' : 'text-[14px] leading-[24px]'} ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrlTransform}
        components={components}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownContent;
