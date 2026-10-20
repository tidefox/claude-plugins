import type { ToolCallResult } from 'claude-code'

// ── reading a tool call: shell commands, search results ───────────────────

export const isScratchPath = (path: string) => /\/scratchpad(\/|$)/.test(path) || /^\/tmp\/claude-/.test(path)

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2')

/**
 * The command with heredoc bodies dropped and each quoted string swapped for a
 * placeholder, so a `>` or `|` inside a message or a pattern is not read as shell.
 */
function mask(command: string): { masked: string; restore: (s: string) => string } {
  const quoted: string[] = []
  const masked = command
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2(?=\s|\)|$)/g, '$3')
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, q => `\u0001${quoted.push(q) - 1}\u0001`)
  return { masked, restore: s => unquote(s.replace(/\u0001(\d+)\u0001/g, (_, k: string) => quoted[Number(k)] ?? '')) }
}

type ShellAccess = { kind: 'read' | 'write'; path: string; from?: number; to?: number; dir?: string }

/**
 * What a shell command does to a file, for the common read and write spellings
 * (`cat`, `head`, `tail`, `sed -n A,Bp`, `nl`, `bat`; `>`, `>>`, `tee`). Null otherwise.
 * `dir` is a leading `cd <dir>`, which a relative path is read against.
 */
export function parseShell(command: string): ShellAccess | null {
  const found = matchShell(command)
  // A path held in a shell variable cannot be followed.
  if (!found || found.path === '' || /[$`*?\u0001]/.test(found.path)) return null
  if (/^~?\//.test(found.path)) return found
  const dir = shellDir(command)
  if (dir === null) return null
  return dir === undefined ? found : { ...found, dir }
}

/**
 * The directory a command's relative paths are read against: a leading `cd
 * <dir>`, undefined with no cd at all, null when a cd cannot be followed (a
 * variable, `~`, `-`, or one further on) and a relative path is somewhere unknown.
 */
export function shellDir(command: string): string | null | undefined {
  const { masked, restore } = mask(command)
  const cds = masked.match(/(?:^|[;&|(]\s*)cd\b/g)?.length ?? 0
  if (cds === 0) return undefined
  const cd = /^\s*cd\s+([^\s;&|<>()]+)\s*(?:&&|;)/.exec(masked)
  const dir = cd?.[1] ? restore(cd[1]) : ''
  return cds === 1 && dir !== '' && dir !== '-' && !/[$`*?~\u0001]/.test(dir) ? dir : null
}

/** Path-like words anywhere in a command, heredoc bodies and quoted strings included: what a script may change. */
export function namedPaths(command: string, limit = 12): string[] {
  const found = new Set<string>()
  const text = command.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, ' ')
  // A quoted word (`open('notes.md')`) or one with a slash is likelier a file than `e.tool`: those first.
  const rank = (path: string) => (/['"]$/.test(text.slice(0, text.indexOf(path))) || path.includes('/') ? 0 : 1)
  const words: string[] = []
  for (const m of text.matchAll(/(?<![\w$@{}.\/~-])(?:~\/|\.{1,2}\/|\/)?(?:[\w@+-][\w.@+-]*\/)*[\w@+-][\w@+-]*(?:\.[\w-]+)*\.[A-Za-z][\w-]{0,9}(?![\w\/(])/g)) {
    const path = m[0]
    if (/^\d|^-|\.(?:com|org|io|net)$/.test(path) || BINARY.test(path)) continue
    words.push(path)
  }
  for (const path of words.sort((a, b) => rank(a) - rank(b))) {
    found.add(path)
    if (found.size >= limit) break
  }
  return [...found]
}

function matchShell(command: string): ShellAccess | null {
  const { masked, restore } = mask(command)
  // A file operand: never an option, never a redirect.
  const file = `([^\\s<>|;&()-][^\\s<>|;&()]*)`

  // A redirect target that names a path (a `/` or a `.`): `a > b` in code is a comparison.
  const redirect = new RegExp(`(?:^|[^0-9&<>=-])>>?\\s*(?!=)${file}`).exec(masked)
  const target = redirect?.[1] ? restore(redirect[1]) : ''
  if (/[./]/.test(target) && !/^\/dev\//.test(target)) return { kind: 'write', path: target }
  const tee = new RegExp(`\\btee\\s+(?:-a\\s+)?${file}`).exec(masked)
  if (tee?.[1]) return { kind: 'write', path: restore(tee[1]) }

  for (const raw of masked.split(/\s*(?:&&|\|\||;|\||\n)\s*/)) {
    const seg = raw.trim().replace(/^cd\s+\S+\s*$/, '')
    const sed = new RegExp(`^sed\\s+-n\\s+\\u0001?(\\d+)(?:,(\\d+))?p\\u0001?\\s+${file}$`).exec(
      seg.replace(/\u0001(\d+)\u0001/g, (q, k: string) => {
        const text = restore(q)
        return /^\d+(,\d+)?p$/.test(text) ? `\u0001${text}\u0001` : `\u0001${k}\u0001`
      }),
    )
    if (sed?.[1] && sed[3]) {
      const from = Number(sed[1])
      return { kind: 'read', path: restore(sed[3]), from, to: sed[2] ? Number(sed[2]) : from }
    }
    const headCmd = new RegExp(`^head(?:\\s+-n)?(?:\\s+-?(\\d+))?\\s+${file}$`).exec(seg)
    if (headCmd?.[2]) return { kind: 'read', path: restore(headCmd[2]), from: 1, to: Number(headCmd[1] ?? 10) }
    const cat = new RegExp(`^(?:cat|bat|batcat|nl|tail|less|more)((?:\\s+[^\\s<>|;&()]+)+)$`).exec(seg)
    // Options and a count (`tail -n 20`) are no file; of several files, the first.
    const operand = cat?.[1]?.trim().split(/\s+/).find(w => !w.startsWith('-') && !/^\d+$/.test(w))
    if (operand) return { kind: 'read', path: restore(operand) }
  }

  return null
}

export const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tgz|xz|jar|wasm|so|dylib|exe|bin|woff2?|ttf|otf|mp[34]|mov|ipynb)$/i

/** The text a Grep result carries: a string, a `{ content | filenames }` object, or text blocks. */
export function resultText(ran: ToolCallResult): string {
  const r = ran.result as unknown
  if (typeof r === 'string') return r
  if (Array.isArray(r)) return r.map(b => (typeof b === 'string' ? b : String((b as { text?: string })?.text ?? ''))).join('\n')
  if (r && typeof r === 'object') {
    const o = r as { content?: unknown; filenames?: unknown }
    if (typeof o.content === 'string' && o.content) return o.content
    if (Array.isArray(o.filenames)) return o.filenames.join('\n')
  }
  return ''
}

/** The files a Grep matched, each with the first matching line (null where the result names only files). */
export function grepFiles(text: string): { path: string; line: number | null }[] {
  const hits = new Map<string, number | null>()
  for (const raw of text.split('\n')) {
    const row = raw.trimEnd()
    const withLine = /^(.+?):(\d+):/.exec(row)
    if (withLine) {
      if (!hits.has(withLine[1]!)) hits.set(withLine[1]!, Number(withLine[2]))
      continue
    }
    const counted = /^(.+):\d+$/.exec(row)
    const path = counted ? counted[1]! : row
    // A path, not a header (`Found 3 files`) or a context line.
    if (/^(?:\/|\.\/|[\w@.-]+\/)\S*$/.test(path) && !/-\d+-/.test(path) && !hits.has(path)) hits.set(path, null)
  }
  return [...hits].map(([path, line]) => ({ path, line }))
}
