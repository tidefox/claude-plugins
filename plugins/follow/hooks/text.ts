// ── text helpers ───────────────────────────────────────────────────────────

export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The 1-based line `index` falls on. */
export function lineOf(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

export const clean = (line: string) => line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

/** A label as one line: whitespace runs (a heredoc's newlines) folded, a leading `cd <dir> &&` dropped. */
export function oneLine(label: string): string {
  return label
    .replace(/\s+/g, ' ')
    .replace(/^cd\s+\S+\s*(?:&&|;)\s*/, '')
    .trim()
}
