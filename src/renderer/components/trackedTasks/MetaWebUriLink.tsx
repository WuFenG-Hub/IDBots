import React from 'react';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';

/** 只放行 MetaWeb 的四个 scheme；其余串保持纯文本，不臆造链接。 */
const METAWEB_URI_PATTERN
  = '(?:pin|metaapp|metafile|metaid)://[A-Za-z0-9\\-._~:/?#[\\]@!$&\'()*+,;=%]+';

/**
 * 裸 pinId（64 位小写 hex + i0）。前后不能还是 hex，避免从更长的 hex 串中间误切；
 * scheme URI 由上面的备选先整体吃掉，尾巴不会被这里二次命中。
 */
const BARE_PINID_PATTERN = '(?<![0-9a-f])[0-9a-f]{64}i0(?![0-9a-f])';

/** URI 字符类只收 ASCII：CJK 全角标点天然截断，不会把括号、句号吞进候选串。 */
const TOKEN_SOURCE = `(${METAWEB_URI_PATTERN})|(${BARE_PINID_PATTERN})`;

/** 用户点击 → 走既有 botBrowser:openUri 通道（App.tsx 已监听），URI 全量透传不截断。 */
export function openMetaWebUri(uri: string): void {
  window.dispatchEvent(new CustomEvent('botBrowser:openUri', { detail: { uri, newTab: true } }));
}

interface MetaWebUriLinkProps {
  text: string;
}

/**
 * 把文本中的 MetaWeb URI（pin:// metaapp:// metafile:// metaid://）与裸 pinId
 * （拼成 pin://<pinId>）渲染为可点链接，其余内容原样保留为纯文本。
 * 链接继承容器的 font-mono / break-all，只叠 accent 色、hover 下划线与外链图标。
 */
const MetaWebUriLink: React.FC<MetaWebUriLinkProps> = ({ text }) => {
  const nodes: React.ReactNode[] = [];
  const tokenRe = new RegExp(TOKEN_SOURCE, 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const uri = token.includes('://') ? token : `pin://${token}`;
    nodes.push(
      <a
        key={`${match.index}-${token}`}
        href={uri}
        title={uri}
        onClick={(event) => {
          event.preventDefault();
          openMetaWebUri(uri);
        }}
        className="break-all text-claude-accent hover:underline"
      >
        {token}
        <ArrowTopRightOnSquareIcon className="ml-0.5 inline h-3 w-3" />
      </a>
    );
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  if (nodes.length === 0) return <>{text}</>;
  return <>{nodes}</>;
};

export default MetaWebUriLink;
