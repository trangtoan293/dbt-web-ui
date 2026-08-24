/**
 * Whether a markdown `code` node is a block rather than an inline span.
 *
 * react-markdown gives a fenced block a `language-*` class, but a fence with no
 * language carries none - only its newlines say what it is. Getting this wrong
 * renders a SQL model as one unreadable inline run.
 */
export function isBlockCode(className: string | undefined, text: string): boolean {
  return className?.startsWith("language-") === true || text.includes("\n")
}
