"use client"

import { memo, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { Check, Copy } from "lucide-react"
import { isBlockCode } from "./markdown-code"

/**
 * Assistant text, rendered as the markdown the model actually writes.
 *
 * react-markdown builds React elements rather than HTML, so model output can
 * never inject markup. No `@tailwindcss/typography` here, so the element map
 * below carries the styling.
 */

function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="group relative my-1.5">
      <button
        type="button"
        onClick={copy}
        title="Copy"
        className="absolute right-1 top-1 rounded bg-white/80 p-1 text-gray-400 opacity-0 transition-opacity hover:text-[#0078D4] group-hover:opacity-100"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
      <pre className="max-h-80 overflow-auto rounded border border-gray-200 bg-[#FAFAFA] p-2 font-mono text-[11px] leading-relaxed text-gray-800">
        <code>{text}</code>
      </pre>
    </div>
  )
}

const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1 mt-2 text-xs font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-xs font-semibold first:mt-0">{children}</h3>,
  ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-4">{children}</ol>,
  li: ({ children }) => <li className="marker:text-gray-400">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-[#0078D4] underline">
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-gray-900">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-gray-200 pl-2 text-gray-500">{children}</blockquote>
  ),
  hr: () => <hr className="my-2 border-gray-200" />,
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-gray-200 bg-[#F3F2F1] px-1.5 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-gray-200 px-1.5 py-1 align-top">{children}</td>,
  // A fenced block arrives as <pre><code>; the <pre> wrapper is dropped so the
  // copy button can own the frame.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children).replace(/\n$/, "")
    if (isBlockCode(className, text)) return <CodeBlock text={text} />
    return (
      <code className="rounded bg-[#F3F2F1] px-1 py-0.5 font-mono text-[11px] text-gray-800">{children}</code>
    )
  },
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

// Streaming re-renders the whole list on every delta; only the last bubble changes.
export default memo(Markdown)
