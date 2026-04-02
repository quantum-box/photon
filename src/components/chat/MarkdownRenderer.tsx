import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { Components } from 'react-markdown'
import { useTheme } from '../../contexts/ThemeContext'

function useMarkdownComponents(): Components {
  const { resolved } = useTheme()
  const syntaxTheme = resolved === 'dark' ? oneDark : oneLight

  return {
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || '')
      const codeString = String(children).replace(/\n$/, '')

      if (match) {
        return (
          <div className="my-2 rounded-lg overflow-hidden" style={{ background: 'var(--bg-code)' }}>
            <div
              className="flex items-center justify-between px-3 py-1.5 text-xs"
              style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
            >
              <span>{match[1]}</span>
              <button
                onClick={() => navigator.clipboard.writeText(codeString)}
                className="hover:opacity-80 transition-opacity cursor-pointer"
                style={{ color: 'var(--text-secondary)' }}
              >
                Copy
              </button>
            </div>
            <SyntaxHighlighter
              style={syntaxTheme}
              language={match[1]}
              PreTag="div"
              customStyle={{
                margin: 0,
                padding: '12px 16px',
                background: 'var(--bg-code)',
                fontSize: '13px',
              }}
            >
              {codeString}
            </SyntaxHighlighter>
          </div>
        )
      }

      return (
        <code
          className="px-1.5 py-0.5 rounded text-sm"
          style={{ background: 'var(--bg-hover)', color: 'var(--text-code)' }}
          {...props}
        >
          {children}
        </code>
      )
    },
  p({ children }) {
    return <p className="mb-3 leading-relaxed last:mb-0">{children}</p>
  },
  ul({ children }) {
    return <ul className="mb-3 ml-5 list-disc space-y-1">{children}</ul>
  },
  ol({ children }) {
    return <ol className="mb-3 ml-5 list-decimal space-y-1">{children}</ol>
  },
  li({ children }) {
    return <li className="leading-relaxed">{children}</li>
  },
  h1({ children }) {
    return <h1 className="text-xl font-bold mb-3 mt-4">{children}</h1>
  },
  h2({ children }) {
    return <h2 className="text-lg font-bold mb-2 mt-3">{children}</h2>
  },
  h3({ children }) {
    return <h3 className="text-base font-semibold mb-2 mt-3">{children}</h3>
  },
  blockquote({ children }) {
    return (
      <blockquote
        className="my-3 pl-4 border-l-2 italic"
        style={{ borderColor: 'var(--accent)', color: 'var(--text-secondary)' }}
      >
        {children}
      </blockquote>
    )
  },
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto rounded-lg" style={{ border: '1px solid var(--border-color)' }}>
        <table className="w-full text-sm">{children}</table>
      </div>
    )
  },
  th({ children }) {
    return (
      <th
        className="px-3 py-2 text-left text-xs font-semibold"
        style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}
      >
        {children}
      </th>
    )
  },
  td({ children }) {
    return (
      <td
        className="px-3 py-2"
        style={{ borderBottom: '1px solid var(--border-color)' }}
      >
        {children}
      </td>
    )
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:opacity-80 transition-opacity"
        style={{ color: 'var(--accent)' }}
      >
        {children}
      </a>
    )
  },
    hr() {
      return <hr className="my-4" style={{ borderColor: 'var(--border-color)' }} />
    },
  }
}

export function MarkdownRenderer({ content }: { content: string }) {
  const components = useMarkdownComponents()
  return (
    <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
