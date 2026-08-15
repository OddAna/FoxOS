import React, { Children, isValidElement, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, Download, ExternalLink, FileCode2 } from 'lucide-react';
import { localFileDetails, localFileDownloadUrl } from '../utils/fileDownloads';
import { useI18n } from '../contexts/LocaleContext';

const textFromChildren = (children) => Children.toArray(children)
  .map((child) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return isValidElement(child) ? textFromChildren(child.props.children) : '';
  })
  .join('');

const CodeBlock = ({ children, language }) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const code = textFromChildren(children).replace(/\n$/, '');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="codex-code-block">
      <div className="codex-code-header">
        <span>{language || t('codexApp.code')}</span>
        <button type="button" onClick={copy} aria-label={t('codexApp.copyCode')}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {t(copied ? 'codexApp.copied' : 'codexApp.copy')}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
};

const safeUrl = (url) => defaultUrlTransform(url);

const CodexMarkdown = ({ children, onOpenLocalFile }) => {
  const { t } = useI18n();
  return <div className="codex-markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={safeUrl}
      components={{
        a: ({ node, href = '', children: linkChildren, ...props }) => {
          void node;
          const localFile = href.startsWith('/');
          const external = /^https?:\/\//i.test(href);
          const downloadHref = localFile ? localFileDownloadUrl(href) : '';
          const fileName = localFile ? localFileDetails(href).name : '';
          return (
            <span className={localFile ? 'codex-local-file-actions' : undefined}>
              <a
                {...props}
                href={href}
                target={external ? '_blank' : undefined}
                rel={external ? 'noopener noreferrer' : undefined}
                onClick={localFile && onOpenLocalFile
                  ? (event) => {
                    event.preventDefault();
                    onOpenLocalFile(href);
                  }
                  : undefined}
              >
                {linkChildren}
                {localFile ? <FileCode2 size={12} aria-hidden="true" /> : external ? <ExternalLink size={11} aria-hidden="true" /> : null}
              </a>
              {downloadHref && (
                <a
                  className="codex-local-file-download"
                  href={downloadHref}
                  download={fileName}
                  aria-label={t('codexApp.downloadFileLabel', { name: fileName })}
                  title={t('codexApp.downloadFile')}
                >
                  <Download size={11} aria-hidden="true" />
                  {t('codexApp.download')}
                </a>
              )}
            </span>
          );
        },
        pre: ({ node, children: preChildren }) => {
          void node;
          const child = Children.toArray(preChildren)[0];
          const className = isValidElement(child) ? child.props.className || '' : '';
          const language = className.match(/language-([^\s]+)/)?.[1] || '';
          const codeChildren = isValidElement(child) ? child.props.children : preChildren;
          return <CodeBlock language={language}>{codeChildren}</CodeBlock>;
        },
        code: ({ node, className, children: codeChildren, ...props }) => {
          void node;
          return <code {...props} className={className}>{codeChildren}</code>;
        }
      }}
    >
      {String(children || '')}
    </ReactMarkdown>
  </div>;
};

export default CodexMarkdown;
