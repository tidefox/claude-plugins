import { expect, test } from 'claude-code/testing'

import type { Activity } from '../types'
import {
  autoTop,
  buildHunk,
  cellWidth,
  clip,
  codeLayout,
  diffRows,
  expandTabs,
  grepFiles,
  isScratchPath,
  lineOf,
  namedPaths,
  oneLine,
  parseShell,
  shellDir,
  shortenPath,
  splitLines,
  thumb,
  trim,
  wrapCells,
  wrapRows,
} from './register'

test('finds the line an edit lands on', async () => {
  const text = 'a\nb\nc\nneedle\ne\n'
  expect(lineOf(text, text.indexOf('needle'))).toBe(4)
  expect(lineOf(text, 0)).toBe(1)
  expect(splitLines(text)).toEqual(['a', 'b', 'c', 'needle', 'e'])
})

test('builds a hunk whose header counts what it draws', async () => {
  const before = ['1', '2', '3', '4', '5', '6', '7', '8']
  const after = ['1', '2', '3', '4', 'five', 'FIVE', '6', '7', '8']
  const h = buildHunk(before, after)
  expect(h?.line).toBe(5)
  expect([h?.added, h?.removed]).toEqual([2, 1])
  expect(h?.hunk).toBe(['@@ -2,7 +2,8 @@', ' 2', ' 3', ' 4', '-5', '+five', '+FIVE', ' 6', ' 7', ' 8'].join('\n'))
  expect(buildHunk(before, before)).toBe(null)
})

test('counts a pure insertion and a pure deletion right', async () => {
  expect(buildHunk(['a', 'b'], ['a', 'x', 'b'], 0)?.hunk).toBe('@@ -1,0 +2,1 @@\n+x')
  expect(buildHunk(['a', 'x', 'b'], ['a', 'b'], 0)?.hunk).toBe('@@ -2,1 +1,0 @@\n-x')
  expect(buildHunk([], ['new'])?.hunk).toBe('@@ -0,0 +1,1 @@\n+new')
})

test('cuts a long change and says so', async () => {
  const before = Array.from({ length: 100 }, (_, i) => `old ${i}`)
  const after = Array.from({ length: 100 }, (_, i) => `new ${i}`)
  const h = buildHunk(before, after, 3, 10)
  expect(h?.isCut).toBe(true)
  expect([h?.added, h?.removed]).toEqual([100, 100])
  expect(h?.hunk.split('\n')[0]).toBe('@@ -1,10 +0,0 @@')
  expect(h?.hunk.split('\n').length).toBe(11)
})

test('keeps unchanged lines between two changes as context, like git diff', async () => {
  const before = ['a', 'b', 'old 306', 'keep 307', 'keep 308', 'old 309', 'c', 'd']
  const after = ['a', 'b', 'new 306', 'added 307', 'keep 307', 'keep 308', 'new 309', 'c', 'd']
  const h = buildHunk(before, after)
  expect(h?.hunk).toBe(
    ['@@ -1,8 +1,9 @@', ' a', ' b', '-old 306', '+new 306', '+added 307', ' keep 307', ' keep 308', '-old 309', '+new 309', ' c', ' d'].join('\n'),
  )
  expect([h?.added, h?.removed, h?.line]).toEqual([3, 2, 3])
})

test('splits changes far apart into separate hunks', async () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
  const after = before.map(l => (l === 'line 5' || l === 'line 25' ? `${l} changed` : l))
  const h = buildHunk(before, after)
  const headers = h?.hunk.split('\n').filter(l => l.startsWith('@@'))
  expect(headers).toEqual(['@@ -2,7 +2,7 @@', '@@ -22,7 +22,7 @@'])
})

test('reads file access out of shell commands', async () => {
  expect(parseShell("sed -n '40,80p' src/app.ts")).toEqual({ kind: 'read', path: 'src/app.ts', from: 40, to: 80 })
  expect(parseShell('cat README.md')).toEqual({ kind: 'read', path: 'README.md' })
  expect(parseShell('head -n 20 a.txt')).toEqual({ kind: 'read', path: 'a.txt', from: 1, to: 20 })
  expect(parseShell('cd /x && cat "my file.md" | grep foo')).toEqual({ kind: 'read', path: 'my file.md', dir: '/x' })
  expect(parseShell("cat > /tmp/notes.md <<'EOF'\nhi\nEOF")).toEqual({ kind: 'write', path: '/tmp/notes.md' })
  expect(parseShell('echo hi | tee -a log.txt')).toEqual({ kind: 'write', path: 'log.txt' })
  expect(parseShell('npm test 2>/dev/null')).toBe(null)
  expect(parseShell('ls -la')).toBe(null)
  expect(parseShell("python3 -c 'print(1)' && test $a > b")).toBe(null)
  expect(parseShell('if [ x >= y ]; then :; fi')).toBe(null)
  expect(parseShell('echo hi > out.txt')).toEqual({ kind: 'write', path: 'out.txt' })
  expect(parseShell('pnpm test 2>&1 | head -40')).toBe(null)
  expect(parseShell('git log | tail -n 20')).toBe(null)
  expect(parseShell('grep -E "a>b|c" src/x.ts')).toBe(null)
  expect(parseShell(`git commit -qam "fix: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>"`)).toBe(null)
  expect(parseShell("git commit -F - <<'EOF'\nfix\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF")).toBe(null)
  expect(parseShell("cat <<'EOF' > out.md\nhi > there\nEOF")).toEqual({ kind: 'write', path: 'out.md' })
})

test('reads a relative path against a leading cd', async () => {
  expect(parseShell('cd /repo/types && sed -n 10,20p api.d.ts')).toEqual({ kind: 'read', path: 'api.d.ts', from: 10, to: 20, dir: '/repo/types' })
  expect(parseShell('cd sub; echo hi > out.txt')).toEqual({ kind: 'write', path: 'out.txt', dir: 'sub' })
  expect(parseShell('cd "my dir" && cat a.md')).toEqual({ kind: 'read', path: 'a.md', dir: 'my dir' })
  // After a cd that cannot be followed, a relative path is somewhere unknown; an absolute one is not.
  expect(parseShell('cd $HOME && cat a.md')).toBe(null)
  expect(parseShell('cd ~/src && cat a.md')).toBe(null)
  expect(parseShell('cd - && cat a.md')).toBe(null)
  expect(parseShell('ls && cd /x && cat a.md')).toBe(null)
  expect(parseShell('cd /x && cd y && cat a.md')).toBe(null)
  expect(parseShell('cd $HOME && cat /etc/hosts')).toEqual({ kind: 'read', path: '/etc/hosts' })
})

test('reads several files and a home path', async () => {
  expect(parseShell('cat hooks/hooks.json types/index.d.ts')).toEqual({ kind: 'read', path: 'hooks/hooks.json' })
  expect(parseShell('tail -n 20 log.txt')).toEqual({ kind: 'read', path: 'log.txt' })
  expect(parseShell('cat ~/.claude/settings.json | jq .')).toEqual({ kind: 'read', path: '~/.claude/settings.json' })
})

test('names the files a script may change', async () => {
  const script = "cd /repo/hooks && python3 - <<'EOF'\np='register.tsx'\ns=open(p).read()\nif e.tool == 'x': pass\nopen('../README.md','w')\nEOF"
  expect(shellDir(script)).toBe('/repo/hooks')
  const paths = namedPaths(script)
  expect(paths.slice(0, 2)).toEqual(['register.tsx', '../README.md'])
  expect(namedPaths('curl https://example.com/a.json && sed -i s/a/b/ src/x.ts v1.2.3')).toEqual(['src/x.ts'])
  expect(namedPaths('git status')).toEqual([])
})

test('keeps the pinned activity when the trail outgrows it', async () => {
  const row = (i: number): Activity => ({
    id: `t${i}`, agentId: null, tool: 'Read', kind: 'read', isScratch: false, path: `/f${i}`, line: 1, endLine: 1,
    label: `f${i}`, added: null, removed: null, phase: 'done', at: i, view: null,
  })
  const list = Array.from({ length: 81 }, (_, i) => row(i))
  expect(trim(list, null).map(a => a.id)).not.toContain('t80')
  expect(trim(list, 't80').map(a => a.id)).toContain('t80')
  expect(trim(list, 't80')).toHaveLength(81)
})

test('knows a scratchpad path', async () => {
  expect(isScratchPath('/tmp/claude-501/x/scratchpad/plan.md')).toBe(true)
  expect(isScratchPath('/home/me/src/app.ts')).toBe(false)
})

test('numbers a diff on both sides', async () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
  const after = before.map(l => (l === 'line 5' || l === 'line 25' ? `${l} changed` : l))
  const rows = diffRows(buildHunk(before, after)?.hunk ?? '')
  expect(rows.length).toBe(16)
  expect(rows.find(r => r.t === '-')).toMatchObject({ text: 'line 5', old: 5 })
  expect(rows.find(r => r.t === '+')).toMatchObject({ text: 'line 5 changed', new: 5 })
  const insert = diffRows('@@ -1,0 +2,1 @@\n+x')
  expect(insert[0]).toMatchObject({ t: '+', old: 2, new: 2 })
  // Where one hunk ends and the next begins, a gap row says the lines between are left out.
  const drawn = wrapRows(rows, 80)
  const gap = drawn.findIndex(r => r.isGap)
  expect(drawn.filter(r => r.isGap)).toHaveLength(1)
  expect([drawn[gap - 1]?.old, drawn[gap + 1]?.old]).toEqual([8, 22])
})

test('measures and cuts in terminal cells', async () => {
  expect(cellWidth('Read')).toBe(4)
  expect(cellWidth('日本')).toBe(4)
  for (const emoji of ['🚀', '✅', '❌', '⚡', '⭐', '🦀', '🫠']) expect(cellWidth(emoji)).toBe(2)
  expect(cellWidth('→✓')).toBe(2)
  expect(cellWidth('é')).toBe(1)
  // A combining accent takes no cell of its own.
  expect(cellWidth(`e${String.fromCharCode(0x301)}`)).toBe(1)
  expect(expandTabs('\tx\ty')).toBe('    x   y')
  expect(clip('abcdef', 4)).toBe('abc…')
  expect(clip('日本語', 4)).toBe('日…')
  expect(clip('abc', 3)).toBe('abc')
  expect(clip('abc', 0)).toBe('')
})

test('wraps a long line by cells, never splitting a wide character', async () => {
  expect(wrapCells('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  expect(wrapCells('', 4)).toEqual([''])
  expect(wrapCells('ab日本', 3)).toEqual(['ab', '日', '本'])
  expect(wrapCells('ok 🚀 go', 4)).toEqual(['ok ', '🚀 g', 'o'])
  const rows = wrapRows(
    [
      { text: 'short', t: ' ', old: 9, new: 9 },
      { text: 'x'.repeat(10), t: ' ', old: 10, new: 10 },
    ],
    4,
  )
  expect(rows.map(r => [r.new, r.part, r.text])).toEqual([
    [9, 0, 'shor'],
    [9, 1, 't'],
    [10, 0, 'xxxx'],
    [10, 1, 'xxxx'],
    [10, 2, 'xx'],
  ])
})

test('shortens a path from the middle, keeping its file name', async () => {
  const path = 'plugins/follow/hooks/deep/register.tsx'
  expect(shortenPath(path, 80)).toBe(path)
  expect(shortenPath(path, 30)).toBe('plugins/…/deep/register.tsx')
  expect(shortenPath(path, 24)).toBe('plugins/…/register.tsx')
  expect(shortenPath(path, 16)).toBe('…/register.tsx')
  // Its line range is part of the name, so it stays.
  expect(shortenPath('src/main.ts:10-14', 15)).toBe('…/main.ts:10-14')
  // A name too long for the room keeps its end.
  expect(shortenPath('src/main.ts:10-14', 14)).toBe('…main.ts:10-14')
  expect(shortenPath('a-very-long-file-name.ts', 10)).toBe('…e-name.ts')
  for (const room of [1, 5, 12, 20]) expect(cellWidth(shortenPath(path, room))).toBeLessThanOrEqual(room)
})

test('keeps the layout fixed and centres the focus a third down', async () => {
  expect(codeLayout(40, 5, 6)).toEqual({ codeTop: 4, codeRows: 20 })
  expect(codeLayout(16, 3, 3).codeRows).toBe(4)
  expect(autoTop(50, 300, 30)).toBe(40)
  expect(autoTop(2, 300, 30)).toBe(0)
  expect(autoTop(295, 300, 30)).toBe(270)
})

test('folds a label onto one line', async () => {
  expect(oneLine("cd /x/y && python3 - <<'EOF'\np = 1\nEOF")).toBe("python3 - <<'EOF' p = 1 EOF")
  expect(oneLine('cd /x; sed -n 1,5p a.ts')).toBe('sed -n 1,5p a.ts')
})

test('sizes and places the scrollbar thumb', async () => {
  expect(thumb(0, 10, 20)).toEqual({ from: 0, size: 20 })
  expect(thumb(0, 100, 20)).toEqual({ from: 0, size: 4 })
  expect(thumb(80, 100, 20)).toEqual({ from: 16, size: 4 })
  expect(thumb(40, 100, 20)).toEqual({ from: 8, size: 4 })
})

test('reads the files a Grep matched, with the first matching line', () => {
  expect(grepFiles('src/a.ts:12:const x\nsrc/a.ts:30:const y\nsrc/b.ts-9-ctx\nsrc/c.ts:4:z')).toEqual([
    { path: 'src/a.ts', line: 12 },
    { path: 'src/c.ts', line: 4 },
  ])
  expect(grepFiles('Found 2 files\nsrc/a.ts\n/abs/b.ts')).toEqual([
    { path: 'src/a.ts', line: null },
    { path: '/abs/b.ts', line: null },
  ])
  expect(grepFiles('src/a.ts:3')).toEqual([{ path: 'src/a.ts', line: null }])
})
