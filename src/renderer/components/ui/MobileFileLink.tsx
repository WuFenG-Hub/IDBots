import React, { useMemo } from 'react';
import { DocumentIcon } from '@heroicons/react/24/outline';
import { useLocalFileUrl } from '../../hooks/useLocalFileUrl';

/**
 * Mobile chat link for a tenant-side file path (F-11): renders a real
 * same-origin `<a href="/files/{token}" download>` instead of the desktop
 * `file://` href + `shell.openPath` interception.
 *
 * Why a plain anchor: the desktop click path (`preventDefault` →
 * `shell:openPath` → sign over WS → `window.open`) is dead on phones twice
 * over — `window.open` after an `await` is popup-blocked, and the signed
 * tenant route `/gateway/v1/files/…` is not routable from the PWA origin.
 * A native anchor to the same-origin `/files/{token}` route (cookie auth,
 * Content-Disposition attachment, `download` attribute for the filename)
 * downloads/opens through the browser's own machinery — no popups, no
 * synthetic clicks, works in PWA standalone.
 *
 * Directories never link (nothing to open on a phone); sign failures render
 * the display name as plain text with the error in `title`.
 */

interface MobileFileLinkProps {
  /** Absolute tenant-side path, e.g. /data/workspace/report.docx. */
  filePath: string;
  /** Link text (the markdown link label). */
  children: React.ReactNode;
  isDirectory?: boolean;
  className?: string;
  onOpen?: (filePath: string, event: React.MouseEvent) => boolean | void;
}

const MobileFileLink: React.FC<MobileFileLinkProps> = ({
  filePath,
  children,
  isDirectory = false,
  className = '',
  onOpen,
}) => {
  const { url, error } = useLocalFileUrl(
    isDirectory ? null : filePath,
    { disposition: 'attachment' },
  );
  const downloadName = useMemo(() => {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || 'file';
  }, [filePath]);

  if (isDirectory) {
    return (
      <span className={`text-[var(--text-secondary)] ${className}`} title={filePath}>
        {children}
      </span>
    );
  }

  if (error || !url) {
    // Unresolved (first sign in flight) or failed: never emit a file:// href.
    return (
      <span
        className={`text-[var(--text-secondary)] ${error ? 'line-through decoration-[var(--border-color)]' : ''} ${className}`}
        title={error ? error.message : filePath}
      >
        {children}
      </span>
    );
  }

  return (
    <a
      href={url}
      download={downloadName}
      onClick={(event) => {
        if (onOpen?.(filePath, event) === true) event.preventDefault();
      }}
      className={`text-claude-accent underline decoration-claude-accent/50 cursor-pointer break-all inline-flex items-center gap-1 ${className}`}
    >
      <DocumentIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {children}
    </a>
  );
};

export default MobileFileLink;
