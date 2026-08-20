"use client"

import dynamic from "next/dynamic"
import { useCallback, useRef } from "react"
import type { editor, languages } from "monaco-editor"

const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false })

let completionProviderRegistered = false

const DBT_JINJA_KEYWORDS = [
  { label: "ref", insertText: "ref('${1:model_name}')", documentation: "Reference another model" },
  { label: "source", insertText: "source('${1:source_name}', '${2:table_name}')", documentation: "Reference a source table" },
  { label: "config", insertText: "config(\n  materialized='${1|table,view,incremental,ephemeral|}',\n  ${2}\n)", documentation: "Model configuration" },
  { label: "var", insertText: "var('${1:variable_name}')", documentation: "Access a variable" },
  { label: "env_var", insertText: "env_var('${1:ENV_VAR_NAME}')", documentation: "Access environment variable" },
  { label: "if", insertText: "{% if ${1:condition} %}\n  ${2}\n{% endif %}", documentation: "Jinja if statement" },
  { label: "for", insertText: "{% for ${1:item} in ${2:items} %}\n  ${3}\n{% endfor %}", documentation: "Jinja for loop" },
  { label: "set", insertText: "{% set ${1:variable} = ${2:value} %}", documentation: "Set a variable" },
  { label: "macro", insertText: "{% macro ${1:name}(${2:args}) %}\n  ${3}\n{% endmacro %}", documentation: "Define a macro" },
  { label: "dbt_utils.star", insertText: "{{ dbt_utils.star(ref('${1:model}')) }}", documentation: "Select all columns" },
  { label: "dbt_utils.surrogate_key", insertText: "{{ dbt_utils.surrogate_key(['${1:column1}', '${2:column2}']) }}", documentation: "Generate surrogate key" },
  { label: "dbt_utils.pivot", insertText: "{{ dbt_utils.pivot('${1:column}', ${2:values}) }}", documentation: "Pivot values" },
  { label: "dbt_utils.unpivot", insertText: "{{ dbt_utils.unpivot(ref('${1:model}'), ${2:columns}) }}", documentation: "Unpivot columns" },
  { label: "is_incremental", insertText: "{% if is_incremental() %}\n  ${1:-- incremental logic}\n{% endif %}", documentation: "Check if incremental run" },
  { label: "this", insertText: "{{ this }}", documentation: "Reference current model" },
]

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "OUTER JOIN",
  "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "UNION", "UNION ALL",
  "INSERT INTO", "UPDATE", "DELETE FROM", "CREATE TABLE", "ALTER TABLE", "DROP TABLE",
  "WITH", "AS", "DISTINCT", "COUNT", "SUM", "AVG", "MIN", "MAX",
  "CASE", "WHEN", "THEN", "ELSE", "END", "AND", "OR", "NOT", "IN", "BETWEEN",
  "IS NULL", "IS NOT NULL", "LIKE", "ILIKE", "COALESCE", "NULLIF", "CAST",
  "DATE", "TIMESTAMP", "INTERVAL", "EXTRACT", "DATE_TRUNC",
  "ROW_NUMBER", "RANK", "DENSE_RANK", "LAG", "LEAD", "OVER", "PARTITION BY",
]

interface CodeEditorProps {
  value: string
  onChange: (value: string | undefined) => void
  language?: string
  readOnly?: boolean
  height?: string
  theme?: "light" | "dark"
  onSave?: () => void
  onPreview?: () => void
  onRun?: () => void
  fileName?: string
}

export default function CodeEditor({
  value,
  onChange,
  language = "sql",
  readOnly = false,
  height = "100%",
  theme = "light",
  onSave,
  onPreview,
  onRun,
  fileName: _fileName,
}: CodeEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null)

  const onSaveRef = useRef(onSave)
  const onPreviewRef = useRef(onPreview)
  const onRunRef = useRef(onRun)
  onSaveRef.current = onSave
  onPreviewRef.current = onPreview
  onRunRef.current = onRun

  const getLanguage = (lang: string) => {
    const mapping: Record<string, string> = {
      sql: "sql", yml: "yaml", yaml: "yaml", md: "markdown",
      json: "json", py: "python", csv: "plaintext",
      shell: "shell", sh: "shell", bash: "shell",
    }
    return mapping[lang] || "sql"
  }

  const handleEditorDidMount = useCallback(
    (editor: editor.IStandaloneCodeEditor, monaco: typeof import("monaco-editor")) => {
      editorRef.current = editor
      monacoRef.current = monaco

      if (!completionProviderRegistered) {
        completionProviderRegistered = true
        monaco.languages.registerCompletionItemProvider("sql", {
          provideCompletionItems: (model, position) => {
            const word = model.getWordUntilPosition(position)
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            }
            const suggestions: languages.CompletionItem[] = []

            for (const item of DBT_JINJA_KEYWORDS) {
              suggestions.push({
                label: item.label,
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: item.insertText,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: item.documentation,
                range,
              })
            }
            for (const keyword of SQL_KEYWORDS) {
              suggestions.push({
                label: keyword,
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: keyword,
                range,
              })
            }
            return { suggestions }
          },
          triggerCharacters: ["{", ".", "(", " "],
        })
      }

      editor.addAction({
        id: "save-file",
        label: "Save File",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => onSaveRef.current?.(),
      })
      editor.addAction({
        id: "preview-model",
        label: "Preview Model",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
        run: () => onPreviewRef.current?.(),
      })
      editor.addAction({
        id: "run-model",
        label: "Run Model",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
        run: () => onRunRef.current?.(),
      })
    },
    []
  )

  return (
    <Editor
      height={height}
      defaultLanguage={getLanguage(language)}
      language={getLanguage(language)}
      value={value}
      onChange={onChange}
      theme={theme === "dark" ? "vs-dark" : "vs-light"}
      onMount={handleEditorDidMount}
      options={{
        readOnly,
        minimap: { enabled: true, maxColumn: 80 },
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
        fontLigatures: true,
        lineNumbers: readOnly ? "off" : "on",
        scrollBeyondLastLine: false,
        wordWrap: "on",
        automaticLayout: true,
        tabSize: 2,
        insertSpaces: true,
        padding: { top: 8, bottom: 8 },
        renderLineHighlight: readOnly ? "none" : "all",
        folding: !readOnly,
        foldingStrategy: "indentation",
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true, indentation: true },
        suggestOnTriggerCharacters: true,
        quickSuggestions: { other: true, comments: false, strings: true },
        acceptSuggestionOnEnter: "on",
        tabCompletion: "on",
        snippetSuggestions: "top",
        formatOnPaste: false,
        formatOnType: false,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        smoothScrolling: true,
        mouseWheelZoom: true,
        renderWhitespace: "selection",
        renderControlCharacters: true,
        wordBasedSuggestions: "currentDocument",
      }}
    />
  )
}
