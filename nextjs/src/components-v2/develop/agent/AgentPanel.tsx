"use client"

import { useEffect, useRef, useState } from "react"
import {
  Bot, Check, ChevronDown, ExternalLink, FileCode, ListChecks, MessageSquarePlus,
  Send, Square, X,
} from "lucide-react"
import {
  useAgentStream,
  type AgentMessage,
  type AgentToolCall,
} from "@/lib/hooks/useAgentStream"
import type { AgentHealth } from "@/lib/hooks/useAgentAvailability"
import { Button } from "@/components-v2/ui/button"
import Markdown from "./Markdown"

interface AgentPanelProps {
  projectId: string
  health: AgentHealth | null
  /** Whether the user has their own key; null while unknown. */
  userKeySet: boolean | null
  /** The file open in the editor, offered to the agent as context. */
  activeFilePath?: string | null
  /** Open a file the agent touched, in the IDE's own editor. */
  onOpenFile?: (path: string) => void
  onClose: () => void
}

const BUBBLE_STYLES: Record<AgentMessage["role"], string> = {
  user: "bg-[#F3F2F1] text-gray-900",
  assistant: "bg-white text-gray-900 border border-gray-200",
  reasoning: "bg-transparent text-gray-400 italic",
  tool: "",
  error: "bg-red-50 text-red-700 border border-red-200",
}

/** The project-relative path a tool acted on, when it names one. */
function toolPath(tool: AgentToolCall): string | null {
  if (!tool.input) return null
  try {
    const parsed = JSON.parse(tool.input) as Record<string, unknown>
    const raw = parsed.file_path ?? parsed.path ?? parsed.pattern
    if (typeof raw !== "string") return null
    // Tools use absolute paths inside the agent container; the editor wants the
    // path relative to the project.
    return raw.replace(/^.*\/dbt-projects\/[^/]+\//, "")
  } catch {
    return null
  }
}

function ToolRow({ tool, onOpenFile }: { tool: AgentToolCall; onOpenFile?: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  const path = toolPath(tool)
  const state = tool.ok === undefined ? "…" : tool.ok ? "✓" : "✗"

  return (
    <div className="rounded-md border border-dashed border-gray-200 bg-white px-2 py-1.5 font-mono text-[11px] text-gray-500">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-gray-800"
        >
          <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
          <span className="shrink-0 font-semibold">{tool.name.replace(/^mcp__dbt__/, "dbt:")}</span>
          {path && <span className="truncate text-gray-400">{path}</span>}
        </button>
        {path && onOpenFile && (
          <button
            type="button"
            onClick={() => onOpenFile(path)}
            title={`Open ${path} in the editor`}
            className="shrink-0 text-gray-400 hover:text-[#0078D4]"
          >
            <FileCode className="h-3.5 w-3.5" />
          </button>
        )}
        <span className={tool.ok === false ? "text-red-600" : "text-gray-400"}>{state}</span>
      </div>
      {open && tool.input && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-[#FAFAFA] p-1.5 text-[10px] text-gray-600">
          {tool.input}
        </pre>
      )}
    </div>
  )
}

/**
 * The dbt assistant, docked on the right of the IDE.
 *
 * Carries what the harness's own UI shows and this wire can deliver: streamed
 * tokens, reasoning, tool calls with their arguments, the todo list, token
 * usage, and every earlier conversation in this project. What it cannot carry
 * is anything needing a request back to the harness - permission prompts, plan
 * approval, mode switching - because the SDK JSON-RPC wire has only
 * initialize/prompt/shutdown. The link in the header goes to the harness's own
 * UI for those.
 */
export default function AgentPanel({
  projectId, health, userKeySet, activeFilePath, onOpenFile, onClose,
}: AgentPanelProps) {
  const [draft, setDraft] = useState("")
  const [attachFile, setAttachFile] = useState(true)
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
  const {
    messages, isStreaming, sessionId, sessions, todos, usage, loadingHistory,
    send, stop, openSession, startNewSession,
  } = useAgentStream(projectId)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, todos])

  // A model credential is the one thing the service cannot provide itself.
  const needsCredential = userKeySet === false && health?.model_configured === false
  const harnessUrl = health?.web_url
  const current = sessions.find((item) => item.session_id === sessionId)

  const submit = () => {
    const text = draft
    setDraft("")
    void send(text, attachFile && activeFilePath ? activeFilePath : undefined)
  }

  return (
    <aside className="flex w-[400px] shrink-0 flex-col border-l border-gray-200 bg-[#FAFAFA]">
      <header className="border-b border-gray-200 bg-white">
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-gray-900">
            <Bot className="h-4 w-4 shrink-0 text-[#0078D4]" />
            Assistant
            {health?.model && (
              <span className="truncate text-[11px] font-normal text-gray-400">{health.model}</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={startNewSession}
              title="New conversation"
              className="rounded p-1 text-gray-400 hover:bg-[#F3F2F1] hover:text-[#0078D4]"
            >
              <MessageSquarePlus className="h-4 w-4" />
            </button>
            {harnessUrl && (
              <a
                href={harnessUrl}
                target="_blank"
                rel="noreferrer"
                title="Open the harness's own UI: permission prompts, plan mode, its own settings"
                className="rounded p-1 text-gray-400 hover:bg-[#F3F2F1] hover:text-[#0078D4]"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close the dbt assistant"
              className="rounded p-1 text-gray-400 hover:bg-[#F3F2F1] hover:text-gray-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {sessions.length > 0 && (
          <div className="relative border-t border-gray-100 px-2 py-1">
            <button
              type="button"
              onClick={() => setSessionMenuOpen((open) => !open)}
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-gray-500 hover:bg-[#F3F2F1]"
            >
              <ChevronDown className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {current?.title ?? (sessionId ? "Current conversation" : "New conversation")}
              </span>
              <span className="ml-auto shrink-0 text-gray-400">{sessions.length}</span>
            </button>
            {sessionMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setSessionMenuOpen(false)} />
                <div className="absolute left-2 right-2 top-full z-50 max-h-72 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg">
                  {sessions.map((item) => (
                    <button
                      key={item.session_id}
                      type="button"
                      onClick={() => {
                        setSessionMenuOpen(false)
                        void openSession(item.session_id)
                      }}
                      className={`flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left hover:bg-[#F3F2F1] ${item.session_id === sessionId ? "bg-[#F3F2F1]" : ""}`}
                    >
                      <span className="w-full truncate text-xs text-gray-800">{item.title}</span>
                      <span className="text-[10px] text-gray-400">
                        {new Date(item.updated_at).toLocaleString()} · {item.turns} turns
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-3">
        {loadingHistory && <p className="text-[11px] text-gray-400">Loading conversation…</p>}
        {!loadingHistory && messages.length === 0 && (
          <p className="text-xs leading-relaxed text-gray-500">
            Ask for a model, a fix, or an explanation. The assistant edits files in
            this project and runs dbt through the same runner the IDE uses, so runs
            appear in History like any other.
          </p>
        )}
        {messages.map((message, index) =>
          message.tool ? (
            <ToolRow key={index} tool={message.tool} onOpenFile={onOpenFile} />
          ) : (
            <div
              key={index}
              className={`overflow-hidden rounded-md px-3 py-2 text-xs leading-relaxed ${BUBBLE_STYLES[message.role]}`}
            >
              {message.role === "assistant" ? (
                <Markdown text={message.text} />
              ) : (
                // A prompt, a reasoning trace and an error are what the user or
                // the runtime wrote: show them verbatim.
                <span className="whitespace-pre-wrap">{message.text}</span>
              )}
              {message.streaming && (
                <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-gray-400 align-text-bottom" />
              )}
            </div>
          )
        )}
        {isStreaming && messages[messages.length - 1]?.streaming !== true && (
          <div className="px-1 text-[11px] text-gray-400">working…</div>
        )}
      </div>

      {todos.length > 0 && (
        <div className="border-t border-gray-200 bg-white px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-gray-500">
            <ListChecks className="h-3.5 w-3.5" /> Plan
          </div>
          <ul className="space-y-0.5">
            {todos.map((todo, index) => (
              <li key={index} className="flex items-start gap-1.5 text-[11px] text-gray-600">
                <span className={`mt-0.5 shrink-0 ${todo.status === "completed" ? "text-green-600" : "text-gray-300"}`}>
                  <Check className="h-3 w-3" />
                </span>
                <span className={todo.status === "completed" ? "line-through text-gray-400" : ""}>
                  {todo.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {needsCredential && (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
          No model API key yet.{" "}
          <a href="/settings" className="font-medium underline">
            Add yours in Settings
          </a>
          . Everything else is already running.
        </div>
      )}

      <div className="border-t border-gray-200 bg-white p-2">
        {activeFilePath && (
          <button
            type="button"
            onClick={() => setAttachFile((on) => !on)}
            title="Tell the assistant which file is open"
            className={`mb-1.5 flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${attachFile ? "border-[#0078D4]/40 bg-[#0078D4]/5 text-[#0078D4]" : "border-gray-200 text-gray-400"}`}
          >
            <FileCode className="h-3 w-3 shrink-0" />
            <span className="truncate">{activeFilePath}</span>
          </button>
        )}
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          rows={3}
          placeholder="Describe the change…"
          disabled={isStreaming || needsCredential}
          className="w-full resize-none rounded-md border border-gray-200 px-2 py-1.5 text-xs focus:border-[#0078D4] focus:outline-none disabled:bg-gray-50"
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="truncate text-[10px] text-gray-400">
            {usage
              ? `${usage.input_tokens ?? 0} in · ${usage.output_tokens ?? 0} out${usage.cached_tokens ? ` · ${usage.cached_tokens} cached` : ""}`
              : ""}
          </span>
          {isStreaming ? (
            <Button size="sm" variant="outline" onClick={() => void stop()}>
              <Square className="mr-1 h-3 w-3" />
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={submit} disabled={!draft.trim() || needsCredential}>
              <Send className="mr-1 h-3 w-3" />
              Send
            </Button>
          )}
        </div>
      </div>
    </aside>
  )
}
