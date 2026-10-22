import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Light mobile Markdown renderer for assistant messages (REQ-E-12): GFM via
 * remark-gfm, plain code blocks, theme colors through the CSS variables.
 * Deliberately NOT the desktop MarkdownContent — that one drags in the full
 * desktop service stack (too heavy for the mobile chat chunk).
 */
export function MarkdownView(props: { text: string }): JSX.Element {
  return (
    <div className="text-[15px] leading-relaxed text-[var(--text-primary)]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="mb-0.5">{children}</li>,
          h1: ({ children }) => <h1 className="mb-2 text-lg font-bold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 text-base font-bold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1.5 text-[15px] font-semibold">{children}</h3>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-sky-600 underline">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-[var(--border-color)] pl-3 text-[var(--text-secondary)] last:mb-0">
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => {
            const inline = !className;
            return inline ? (
              <code className="rounded bg-[var(--bg-main)] px-1 py-0.5 text-[13px]">{children}</code>
            ) : (
              <code className="text-[13px]">{children}</code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-2 overflow-x-auto rounded-lg bg-[var(--bg-main)] p-3 last:mb-0">{children}</pre>
          ),
          table: ({ children }) => (
            <table className="mb-2 w-full border-collapse text-sm last:mb-0">{children}</table>
          ),
          th: ({ children }) => (
            <th className="border border-[var(--border-color)] bg-[var(--bg-main)] px-2 py-1 text-left">{children}</th>
          ),
          td: ({ children }) => <td className="border border-[var(--border-color)] px-2 py-1">{children}</td>,
        }}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  );
}
