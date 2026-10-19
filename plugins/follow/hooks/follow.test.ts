import { expect, test } from 'claude-code/testing'

import { autoTop, buildHunk, codeLayout, diffRows, isScratchPath, lineOf, oneLine, parseShell, splitLines, thumb, windowDiff } from './register'

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
  expect(parseShell('cd /x && cat "my file.md" | grep foo')).toEqual({ kind: 'read', path: 'my file.md' })
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

test('knows a scratchpad path', async () => {
  expect(isScratchPath('/tmp/claude-501/x/scratchpad/plan.md')).toBe(true)
  expect(isScratchPath('/home/me/src/app.ts')).toBe(false)
})

test('windows a diff into hunks that still parse', async () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
  const after = before.map(l => (l === 'line 5' || l === 'line 25' ? `${l} changed` : l))
  const rows = diffRows(buildHunk(before, after)?.hunk ?? '')
  expect(rows.length).toBe(16)
  expect(windowDiff(rows, 0, 100)).toBe(buildHunk(before, after)?.hunk)
  // Rows 6..10 span the end of the first hunk and the start of the second.
  expect(windowDiff(rows, 6, 4)).toBe(['@@ -7,2 +7,2 @@', ' line 7', ' line 8', '@@ -22,2 +22,2 @@', ' line 22', ' line 23'].join('\n'))
  const insert = diffRows('@@ -1,0 +2,1 @@\n+x')
  expect(insert[0]).toMatchObject({ t: '+', old: 2, new: 2 })
  expect(windowDiff(insert, 0, 5)).toBe('@@ -1,0 +2,1 @@\n+x')
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
